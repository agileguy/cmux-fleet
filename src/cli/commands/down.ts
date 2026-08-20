import type { Command } from "commander";
import { readdir, unlink } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, type ProcId } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readPresentation, readRunWorktrees, readWorkerState } from "../../run/state.ts";
import { pruneWorkerWorktree, type PruneOutcome } from "../../run/worktree.ts";
import { loadBackend } from "../../backends/registry.ts";
import type { BackendKind } from "../../backends/types.ts";
import { processStartTime, readRegistry, registryCall } from "../../run/registry.ts";
import { realProcessOps, sameIdentity, signalIfSame } from "../../safety/kill.ts";
import { controlCall } from "../../supervisor/launch.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { Stopwatch } from "../../rpc/client.ts";

const GRACEFUL_WAIT_MS = 5_000;
const TERM_WAIT_MS = 2_000;

/**
 * Register `pifleet down` (SRD §10, §9.3): quiesce, then stop, then verify.
 *
 * Order matters: graceful shutdown over the control socket first (abort →
 * settle → close stdin, §13 F3), the signal ladder only for supervisors that
 * stopped listening. Signals go to the process GROUP — the supervisor is its
 * group's leader, so `-pgid` takes the Pi child with it and leaves no orphan
 * (ISC-72/73).
 *
 * Every rung addresses a `(pid, started)` pair, never a bare pid (ISC-191).
 * This is the one kill path an operator runs BY HAND, which makes it the one
 * where the recorded pid is most likely to be stale: a bare `pifleet down`
 * resolves the LATEST run, and after a reboot the latest run is a dead one
 * whose pids the machine has long since handed out again. `anchorIdentity`
 * below is the gate, and it refuses rather than signalling when the recorded
 * identity and the OS disagree.
 *
 * `--prune` is the second phase, and only ever reached per worker whose
 * supervisor is CONFIRMED dead. `down` deleting a checkout a container is
 * still writing to is the corruption §9.3 names in as many words, and
 * "confirmed dead" here is the same identity comparison the kill ladder above
 * already computed — not a timeout, not an assumption that SIGKILL worked,
 * and not the bare liveness test it used to be, which called a checkout
 * unprunable because SOMETHING held the pid.
 *
 * The flag was DECLARED and unread for a whole phase, with a docstring on this
 * very function saying "Worktree pruning is Phase 2; nothing here deletes
 * data" — the second instance of the dead-flag pattern this file already
 * caught once with `--keep-panes` (see the teardown block below). A documented
 * flag that nothing reads is indistinguishable from a working one until an
 * operator relies on it.
 */
export function register(program: Command): void {
  program
    .command("down")
    .description("Quiesce the run, stop containers and optionally prune worktrees")
    .option("--run <id>", "run id")
    .option("--keep-panes", "leave panes open")
    .option("--prune", "remove worktrees and branches")
    .option("--force", "prune a checkout that still holds work")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; json?: boolean; keepPanes?: boolean; prune?: boolean; force?: boolean }) => {
      if (opts.force === true && opts.prune !== true) {
        throw new CliError("--force has no meaning without --prune", EXIT.USAGE);
      }
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
      const run = runPaths(runId, root);
      const ledger = new LedgerWriter(run, `cli-down-${process.pid}`);

      let workerIds: string[];
      try {
        workerIds = (await readdir(run.workersDir)).filter((w) => !w.startsWith("."));
      } catch {
        workerIds = [];
      }

      /**
       * The launch-time identities, for the rung-0 anchor below.
       *
       * `register_worker` records `(pid, pgid, started)` per supervisor — its
       * own comment says "identity is (pid, start-time) so pid reuse cannot
       * resurrect us later" — and `readRegistry` reads that off disk without
       * needing the daemon to still be listening, which is exactly the case
       * `down` runs in. A missing or unparseable registry is not an error
       * here: it degrades the anchor, and `anchorIdentity` says what that
       * costs.
       */
      const registry = await readRegistry(run).catch(() => null);

      const report: Array<{ id: string; stopped: boolean; how: string }> = [];
      for (const id of workerIds.sort()) {
        const wp = workerPaths(run, id);
        const state = await readWorkerState(wp);
        if (state === null) {
          report.push({ id, stopped: true, how: "already_gone" });
          continue;
        }
        const recorded = registry?.workers[id];
        const target = await anchorIdentity(
          state.pid,
          recorded !== undefined && recorded.pid === state.pid ? recorded.started : null,
        );
        // Nothing on that pid, or something that is NOT the supervisor we
        // recorded. Either way there is nothing here to stop, and signalling
        // is the one thing that must not happen (ISC-191).
        if (target === null) {
          report.push({ id, stopped: true, how: "already_gone" });
          continue;
        }

        // Phase 1: graceful, via the control socket.
        try {
          await controlCall(run, id, { cmd: "shutdown" }, { timeoutMs: 2_000 });
        } catch {
          // Socket dead but process alive — fall through to the ladder.
        }
        let how = "graceful";
        if (!(await waitGone(target, GRACEFUL_WAIT_MS))) {
          // Phase 2: SIGTERM the process GROUP; the supervisor leads it.
          how = "sigterm";
          await signalGuarded(target, "SIGTERM", state.pgid);
          if (!(await waitGone(target, TERM_WAIT_MS))) {
            // Phase 3: SIGKILL — the group again, no survivors.
            how = "sigkill";
            await signalGuarded(target, "SIGKILL", state.pgid);
            await waitGone(target, TERM_WAIT_MS);
          }
        }
        // Identity, not liveness: a pid that was recycled after the ladder
        // killed the supervisor would read as STILL RUNNING on a bare
        // `processStartTime`, and `down` would exit WORKER_DIED over a
        // stranger it never touched.
        const stopped = !(await sameIdentity(target, realProcessOps));
        report.push({ id, stopped, how });
        await ledger.append("worker_down", { worker: id, detail: { how, stopped } });
        try {
          await unlink(wp.controlSock);
        } catch {
          // Graceful shutdown already removed it.
        }
      }

      // The daemon last: it must outlive the workers it deregisters.
      await registryCall(run, { cmd: "shutdown" }, { optional: true });
      try {
        // `daemon.pid` records BOTH halves of the identity — `{pid, started}`,
        // written in one call by `startRegistryDaemon`. This rung read the
        // file, took the pid and threw the start time away, so a run
        // directory left behind by a reboot signalled whatever now held the
        // number. The recorded half is right here; use it.
        const pidFile = JSON.parse(await Bun.file(run.daemonPid).text()) as {
          pid: number;
          started?: unknown;
        };
        const target = await anchorIdentity(
          pidFile.pid,
          typeof pidFile.started === "string" ? pidFile.started : null,
        );
        if (target !== null && !(await waitGone(target, TERM_WAIT_MS))) {
          await signalGuarded(target, "SIGTERM", null);
          await waitGone(target, TERM_WAIT_MS);
        }
      } catch {
        // No daemon ever ran (integration setups) — nothing to stop.
      }
      try {
        await unlink(run.daemonSock);
      } catch {
        // Already gone.
      }

      /**
       * Phase 2: the checkouts (SRD §9.3).
       *
       * Before the view is torn down rather than after, for the reason the
       * teardown block below states about ordering: a pane is the surface a
       * failure is READ on, so anything that can fail loudly should fail while
       * one is still open.
       *
       * Refusals, none of which is an error in the run:
       *
       *  - a supervisor LAUNCHED and confirmed still alive. §9.3's own words:
       *    pruning a checkout whose container is still writing would corrupt
       *    it. The kill ladder above already computed the answer as
       *    `!sameIdentity(target)`, so this reuses that fact rather than
       *    asking a second, differently-shaped question. Identity and not
       *    liveness, deliberately: the bare `processStartTime(pid) === null`
       *    this used to read called a checkout unprunable whenever ANY
       *    process held the recorded number, so a reused pid could pin a
       *    checkout that nothing had been writing to for days. A worker id
       *    with NO supervisor state at all is NOT this case — nothing was
       *    ever writing into that checkout, so the corruption hazard this
       *    gate exists to enforce does not apply, and it falls through to the
       *    dirt check below like any other checkout (see the loop for why).
       *  - a checkout that still holds work. `run/worktree.ts` defines what
       *    that means for a clone with no upstream — uncommitted paths, or
       *    commits past the recorded `baseSha`. `--force` overrides it.
       *  - no record, or a record `readRunWorktrees` could not fully read. A
       *    run whose `run.json` never recorded checkouts has nothing to reap
       *    and says so. A run whose record COULD NOT BE READ is different and
       *    must NOT read as the same "nothing to reap" success: real clones
       *    and remotes may still be on disk with nothing left naming them,
       *    which is exactly the loop-reaper data loss `EXIT.PARTIAL` exists
       *    to prevent elsewhere in this function — silently exiting 0 here
       *    with `pruned: []` would tell a script reaping runs in a loop that
       *    this run left nothing behind, when the honest answer is "unknown".
       */
      const pruned: PruneOutcome[] = [];
      let pruneRefusals = 0;
      if (opts.prune === true) {
        const recorded = await readRunWorktrees(run);
        if (recorded.note !== null) {
          await ledger.append("prune_skipped", { detail: { reason: recorded.note } });
          if (opts.json !== true) process.stderr.write(`  cannot prune: ${recorded.note}\n`);
          pruneRefusals++;
        }
        for (const note of recorded.perWorkerNotes) {
          const workerId = note.split(":")[0] ?? "unknown";
          await ledger.append("prune_skipped", { worker: workerId, detail: { reason: note } });
          if (opts.json !== true) process.stderr.write(`  cannot prune ${workerId}: ${note}\n`);
          pruned.push({
            workerId,
            path: "(unreadable record)",
            pruned: false,
            reason: `run.json's checkout record for this worker could not be read (${note}); refusing to guess at a path to delete`,
          });
          pruneRefusals++;
        }
        const stopped = new Map(report.map((r) => [r.id, r.stopped]));
        const byWorkerSorted = [...recorded.byWorker.entries()].sort(([a], [b]) => a.localeCompare(b));
        for (const [id, wt] of byWorkerSorted) {
          if (recorded.repo === null) {
            pruned.push({
              workerId: id,
              path: wt.path,
              pruned: false,
              reason: "run.json does not record the parent repository; refusing to guess at one",
            });
            pruneRefusals++;
            continue;
          }
          // A supervisor confirmed to have SURVIVED the kill ladder blocks
          // its own prune — the §9.3 corruption hazard. Absent from the
          // report entirely (no `workers/<id>` state file — a supervisor
          // never launched under this id in this run, most likely because
          // `up` failed partway through: the clone succeeded and was
          // recorded, but daemon launch never reached this worker) is NOT
          // the same fact and must not be treated as it: nothing was ever
          // writing into the checkout, so it is exactly as prunable as one
          // whose supervisor exited cleanly, subject to the same dirt check.
          if (stopped.has(id) && stopped.get(id) !== true) {
            pruned.push({
              workerId: id,
              path: wt.path,
              pruned: false,
              reason: "its supervisor survived the kill ladder; a live container writing here would be corrupted by a delete",
            });
            pruneRefusals++;
            continue;
          }
          let outcome: PruneOutcome;
          try {
            outcome = await pruneWorkerWorktree({
              repo: recorded.repo,
              worktree: wt,
              force: opts.force === true,
            });
          } catch (err) {
            // A prune that throws must not take down a `down` that already
            // stopped every process it set out to stop — the same argument
            // the workspace-teardown block makes. Recorded, never swallowed.
            outcome = {
              workerId: id,
              path: wt.path,
              pruned: false,
              reason: `prune failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          pruned.push(outcome);
          if (!outcome.pruned) pruneRefusals++;
          await ledger.append(outcome.pruned ? "worktree_pruned" : "worktree_prune_refused", {
            worker: id,
            detail: { path: outcome.path, reason: outcome.reason },
          });
        }
      }

      /**
       * The view, last of all (ISC-129).
       *
       * `down` tore down every process and left the workspace standing: a
       * real `up --backend tmux` followed by `down` reported `clean: true`
       * while its tmux session and both panes were still alive, so every run
       * leaked a session that only `tmux kill-server` would ever reclaim.
       * `FleetBackend.destroy` existed and was tested the whole time and had
       * no production caller — the same dead-subsystem shape found twice
       * before in this project, and a green suite is exactly what makes it
       * look finished. `--keep-panes` was the tell: a documented flag that
       * nothing read, because the teardown it modifies was never wired.
       *
       * Panes are destroyed AFTER the processes are gone. A pane whose
       * process is still running would be killed out from under it, and the
       * SRD's ordering is quiesce, then stop, then verify — the view is the
       * last thing to go, so a failure anywhere above it is still readable
       * on screen.
       */
      const keepPanes = opts.keepPanes === true;
      const workspaces = new Map<string, { backend: BackendKind; id: string }>();
      for (const id of workerIds) {
        const p = await readPresentation(workerPaths(run, id));
        // headless has no view to destroy, and a null ref means the pane
        // never got created — `up` records the failure rather than aborting.
        if (p === null || p.backend === "headless" || p.workspace_ref === null) continue;
        workspaces.set(`${p.backend}:${p.workspace_ref}`, {
          backend: p.backend,
          id: p.workspace_ref,
        });
      }
      for (const w of workspaces.values()) {
        try {
          const backend = await loadBackend(w.backend);
          await backend.destroy({ backend: w.backend, id: w.id }, { keepPanes });
          await ledger.append("workspace_down", {
            detail: { backend: w.backend, workspace: w.id, kept: keepPanes },
          });
        } catch (err) {
          /**
           * Not fatal, and deliberately so: presentation is not the control
           * plane. A backend that has already died cannot make `down` report
           * that the workers it really did stop are still running. Recorded,
           * never swallowed.
           */
          await ledger.append("workspace_down_failed", {
            detail: {
              backend: w.backend,
              workspace: w.id,
              error: err instanceof Error ? err.message : String(err),
            },
          });
          if (opts.json !== true) {
            process.stderr.write(`  could not destroy ${w.backend} workspace ${w.id}: ${String(err)}\n`);
          }
        }
      }

      await ledger.append("run_down", {});

      const allStopped = report.every((r) => r.stopped);
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            run_id: runId,
            workers: report,
            clean: allStopped,
            ...(opts.prune === true ? { pruned } : {}),
          })}\n`,
        );
      } else {
        process.stdout.write(`run ${runId} down\n`);
        for (const r of report) {
          process.stdout.write(`  ${r.id}: ${r.stopped ? "stopped" : "STILL RUNNING"} (${r.how})\n`);
        }
        for (const p of pruned) {
          process.stdout.write(`  ${p.workerId}: ${p.pruned ? "pruned" : "KEPT"} — ${p.reason}\n`);
        }
      }
      if (!allStopped) {
        throw new CliError("some supervisors survived the kill ladder", EXIT.WORKER_DIED);
      }
      /**
       * A refused prune is a non-zero exit, and deliberately so.
       *
       * `--prune` is a request to leave nothing behind. A run that stopped
       * cleanly but kept three checkouts full of uncommitted work has NOT done
       * what was asked, and exiting 0 would let a script that reaps runs in a
       * loop delete the run directory while the work it points at stays on
       * disk with nothing left naming it. `PARTIAL` is the code for exactly
       * this — the operation did some of what it was asked — and the reasons
       * are already on stdout above.
       */
      if (pruneRefusals > 0) {
        throw new CliError(
          `${pruneRefusals} checkout(s) were kept rather than pruned; see the reasons above ` +
            `(--force prunes one that still holds work)`,
          EXIT.PARTIAL,
        );
      }
    });
}

/**
 * Resolve the `(pid, started)` pair this ladder is allowed to signal, or null
 * for "do not signal anything" (ISC-191).
 *
 * A pid is not an identity — `safety/kill.ts`'s header argues the general
 * case. `down` is where it bites hardest, because `down` is the one kill path
 * an operator runs BY HAND, typically against a run directory whose
 * supervisors died some time ago. A bare `pifleet down` resolves the latest
 * run, and after a reboot the latest run is a stale one whose recorded pids
 * now belong to whatever the machine started since.
 *
 * `recorded` is the start time captured when the process was LAUNCHED, if
 * anything captured one. When it is present and disagrees with the OS, the
 * process we meant to kill is gone and this pid belongs to a stranger, so the
 * answer is null and no rung ever runs.
 *
 * When `recorded` is null nothing recorded an identity at launch, and the
 * anchor falls back to whatever holds the pid NOW. That is strictly weaker:
 * it makes every LATER rung identity-checked — closing the window in which
 * the target dies inside a grace period and the kernel rehomes its pid before
 * the next signal — but it cannot tell a supervisor from a stranger at rung
 * 0, because there is nothing to compare against. `WorkerState` records
 * `started_at` as an ISO wall-clock string, which is not comparable to
 * `ps -o lstart=`, so the registry is the only launch-time source for a
 * worker and a worker missing from it gets the weaker anchor. ISC-270 tracks
 * closing that.
 */
async function anchorIdentity(pid: number, recorded: string | null): Promise<ProcId | null> {
  const current = await processStartTime(pid);
  if (current === null) return null;
  if (recorded !== null && recorded !== "" && recorded !== current) return null;
  return { pid, started: current };
}

/**
 * Signal a re-validated identity, never a bare pid.
 *
 * `signalIfSame` re-reads the pair and compares it before every signal, and
 * swallows the ESRCH of a target that died inside the check-then-signal
 * window. Anything else — EPERM, most plausibly — is swallowed HERE instead:
 * `down` must still stop the remaining workers, the daemon and the view, and
 * then report this worker as STILL RUNNING, which the identity read after the
 * ladder already does. Throwing out of the loop would skip all of that.
 */
async function signalGuarded(
  target: ProcId,
  signal: "SIGTERM" | "SIGKILL",
  pgid: number | null,
): Promise<void> {
  try {
    await signalIfSame(target, signal, { pgid });
  } catch {
    // Reported as `stopped: false` by the caller's identity read.
  }
}

/** True once the recorded identity is gone — dead, or replaced by a stranger. */
async function waitGone(target: ProcId, budgetMs: number): Promise<boolean> {
  const clock = new Stopwatch();
  for (;;) {
    if (!(await sameIdentity(target, realProcessOps))) return true;
    if (clock.elapsedMs() > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}
