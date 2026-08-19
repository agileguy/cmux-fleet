import type { Command } from "commander";
import { readdir, unlink } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readPresentation, readRunWorktrees, readWorkerState } from "../../run/state.ts";
import { pruneWorkerWorktree, type PruneOutcome } from "../../run/worktree.ts";
import { loadBackend } from "../../backends/registry.ts";
import type { BackendKind } from "../../backends/types.ts";
import { processStartTime, registryCall } from "../../run/registry.ts";
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
 * `--prune` is the second phase, and only ever reached per worker whose
 * supervisor is CONFIRMED dead. `down` deleting a checkout a container is
 * still writing to is the corruption §9.3 names in as many words, and
 * "confirmed dead" here is the same `processStartTime(pid) === null` the kill
 * ladder above already computed — not a timeout, not an assumption that
 * SIGKILL worked.
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

      const report: Array<{ id: string; stopped: boolean; how: string }> = [];
      for (const id of workerIds.sort()) {
        const wp = workerPaths(run, id);
        const state = await readWorkerState(wp);
        if (state === null || (await processStartTime(state.pid)) === null) {
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
        if (!(await waitGone(state.pid, GRACEFUL_WAIT_MS))) {
          // Phase 2: SIGTERM the process GROUP; the supervisor leads it.
          how = "sigterm";
          trySignal(-state.pgid, "SIGTERM");
          if (!(await waitGone(state.pid, TERM_WAIT_MS))) {
            // Phase 3: SIGKILL — the group again, no survivors.
            how = "sigkill";
            trySignal(-state.pgid, "SIGKILL");
            await waitGone(state.pid, TERM_WAIT_MS);
          }
        }
        const stopped = (await processStartTime(state.pid)) === null;
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
        const pidFile = JSON.parse(await Bun.file(run.daemonPid).text()) as { pid: number };
        if (!(await waitGone(pidFile.pid, TERM_WAIT_MS))) {
          trySignal(pidFile.pid, "SIGTERM");
          await waitGone(pidFile.pid, TERM_WAIT_MS);
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
       * Three refusals, none of which is an error in the run:
       *
       *  - a supervisor not confirmed dead. §9.3's own words: pruning a
       *    checkout whose container is still writing would corrupt it. The
       *    kill ladder above already computed the answer as
       *    `processStartTime(pid) === null`, so this reuses that fact rather
       *    than asking a second, differently-shaped question.
       *  - a checkout that still holds work. `run/worktree.ts` defines what
       *    that means for a clone with no upstream — uncommitted paths, or
       *    commits past the recorded `baseSha`. `--force` overrides it.
       *  - no record. A run whose `run.json` never recorded checkouts has
       *    nothing to reap and says so, rather than guessing at paths.
       */
      const pruned: PruneOutcome[] = [];
      let pruneRefusals = 0;
      if (opts.prune === true) {
        const recorded = await readRunWorktrees(run);
        if (recorded.note !== null) {
          await ledger.append("prune_skipped", { detail: { reason: recorded.note } });
          if (opts.json !== true) process.stderr.write(`  cannot prune: ${recorded.note}\n`);
        }
        const stopped = new Map(report.map((r) => [r.id, r.stopped]));
        for (const [id, wt] of recorded.byWorker) {
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
          // Absent from the report means no `workers/<id>` directory existed,
          // so no supervisor was ever launched under that id in this run —
          // which is not the same as one that was launched and confirmed
          // dead, and must not be treated as it.
          if (stopped.get(id) !== true) {
            pruned.push({
              workerId: id,
              path: wt.path,
              pruned: false,
              reason:
                stopped.has(id)
                  ? "its supervisor survived the kill ladder; a live container writing here would be corrupted by a delete"
                  : "no supervisor state for this worker in the run dir, so it cannot be confirmed dead",
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

function trySignal(pidOrGroup: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pidOrGroup, signal);
  } catch {
    // Already exited between the check and the signal — the desired state.
  }
}

async function waitGone(pid: number, budgetMs: number): Promise<boolean> {
  const clock = new Stopwatch();
  for (;;) {
    if ((await processStartTime(pid)) === null) return true;
    if (clock.elapsedMs() > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}
