import type { Command } from "commander";
import { readdir, unlink } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, type ProcId } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readPresentation, readRunWorktrees, readWorkerState } from "../../run/state.ts";
import { pruneWorkerWorktree, type PruneOutcome } from "../../run/worktree.ts";
import { loadBackend } from "../../backends/registry.ts";
import type { BackendKind } from "../../backends/types.ts";
import {
  IDENTITY_FORMAT,
  isPinnedIdentity,
  processStartTime,
  readRegistry,
  registryCall,
} from "../../run/registry.ts";
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
 * identity is missing, unreadable, or disagrees with the OS.
 *
 * MIGRATION POLICY for the pinned identity rendering (ISC-192's territory,
 * decided here rather than discovered by an operator).
 *
 * `registry.ts` now pins `ps` to `TZ=UTC LC_ALL=C` and tags the result
 * `utc1 …`. That CHANGES THE BYTES of every `started` already on disk — not
 * only on a machine whose timezone differed, but on one that was already in
 * UTC, because `LC_ALL=C` also reorders the fields ("Thu Aug 20 …" against
 * "Thu 20 Aug …"). So on the first `down` after this upgrade, every identity
 * recorded by the previous build fails to compare.
 *
 * The policy is TAG, REFUSE, AND NAME THE HATCH:
 *
 *  - Values this build writes carry the `utc1 ` tag, so they are recognisable
 *    as comparable. No locale renders a weekday as `utc1`, so the tag cannot
 *    collide with a legacy value.
 *  - An UNTAGGED recorded value is reported `identity_legacy_format` — its
 *    own answer, distinct from `identity_mismatch`. Reporting it as a
 *    mismatch would assert something false about the world ("a stranger holds
 *    this pid") and would train an operator to reach for the override
 *    reflexively, which is precisely the reflex that must not be trained on
 *    the one flag that re-opens the fail-open.
 *  - `--force-identity` completes such a run using the pre-fix weak anchor.
 *
 * REJECTED: silently auto-upgrading a legacy value by rewriting it from the
 * pid as it reads NOW. That value is derived from the present, not from
 * launch, so it would launder an unverified anchor into a verified-LOOKING
 * one — the fail-open being removed, wearing the fix's clothes. Nothing on
 * disk can convert a legacy rendering into the pinned one, because the legacy
 * string does not record which timezone or locale produced it.
 *
 * REJECTED: accepting a match under either rendering. The legacy value was
 * rendered in the LAUNCHER's environment, and `down` can only re-render in
 * the OPERATOR's, so "try both" does not reconstruct the launcher's string —
 * it just re-admits the ambiguity the pin exists to remove.
 *
 * BLAST RADIUS: a run started before the upgrade and stopped after it. New
 * runs are unaffected; a run started and stopped on one build is unaffected.
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
    .option(
      "--force-identity",
      "signal a process whose recorded launch identity is missing, unreadable or disagrees",
    )
    .option("--json", "emit machine-readable output")
    .action(async (opts: {
      run?: string;
      json?: boolean;
      keepPanes?: boolean;
      prune?: boolean;
      force?: boolean;
      forceIdentity?: boolean;
    }) => {
      if (opts.force === true && opts.prune !== true) {
        throw new CliError("--force has no meaning without --prune", EXIT.USAGE);
      }
      /**
       * `--force-identity` is deliberately NOT gated on `--prune`, unlike
       * `--force`. It changes what gets SIGNALLED, not what gets deleted, so
       * it has a meaning on its own: an operator whose run predates the
       * pinned identity rendering needs it to stop the run at all.
       */
      const forceIdentity = opts.forceIdentity === true;
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

      const report: Array<{ id: string; stopped: boolean; how: string; forced_identity?: true }> = [];
      for (const id of workerIds.sort()) {
        const wp = workerPaths(run, id);
        const state = await readWorkerState(wp);
        if (state === null) {
          report.push({ id, stopped: true, how: "already_gone" });
          continue;
        }
        const recorded = registry?.workers[id];
        const anchor = await anchorIdentity(
          state.pid,
          // A registry entry for a DIFFERENT pid than `state.json` names is
          // not this supervisor's identity — supervisor relaunched, or one of
          // the two files is stale — so it is not offered as one. It reaches
          // `anchorIdentity` as `null` and refuses like any other unrecorded
          // worker rather than silently taking the weak anchor (ISC-272).
          recorded !== undefined && recorded.pid === state.pid ? recorded.started : null,
          { force: forceIdentity },
        );
        // Nothing holds that pid: genuinely gone, nothing to stop.
        if (anchor.kind === "gone") {
          report.push({ id, stopped: true, how: "already_gone" });
          continue;
        }
        /**
         * A REFUSAL, reported as one.
         *
         * `stopped: false` is the load-bearing half. It makes the refusal
         * visible in `--json`, non-zero at exit, and — the reason this is a
         * data-loss fix rather than a reporting nicety — it makes the prune
         * gate below refuse the checkout, because that gate acts only on
         * `stopped`. Reported as `stopped: true` (which is what
         * `already_gone` did), a live-but-unverifiable supervisor was classed
         * PRUNABLE and `--prune` deleted the checkout its container was still
         * writing to: the §9.3 corruption, measured end to end.
         */
        if (anchor.kind === "refused") {
          report.push({ id, stopped: false, how: anchor.how });
          await ledger.append("worker_down_refused", {
            worker: id,
            detail: { how: anchor.how, reason: anchor.detail, pid: state.pid },
          });
          if (opts.json !== true) {
            process.stderr.write(
              `  ${id}: refused to signal pid ${state.pid} — ${anchor.detail}; ` +
                `re-run with --force-identity to signal it anyway\n`,
            );
          }
          continue;
        }
        const target = anchor.target;

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
        report.push({ id, stopped, how, ...(anchor.forced ? { forced_identity: true } : {}) });
        await ledger.append("worker_down", {
          worker: id,
          detail: { how, stopped, forced_identity: anchor.forced },
        });
        try {
          await unlink(wp.controlSock);
        } catch {
          // Graceful shutdown already removed it.
        }
      }

      // The daemon last: it must outlive the workers it deregisters.
      await registryCall(run, { cmd: "shutdown" }, { optional: true });
      /**
       * The daemon rung, and the one place a BARE pid was still reachable.
       *
       * `daemon.pid` records BOTH halves of the identity — `{pid, started}`,
       * written in one call by `startRegistryDaemon`. This rung read the file,
       * took the pid and threw the start time away, so a run directory left
       * behind by a reboot signalled whatever now held the number. The
       * recorded half is right here; use it.
       *
       * This rung passes `pgid: null`, so `signalIfSame` addresses
       * `target.pid` directly. That makes the anchor the ONLY thing standing
       * between a stale `daemon.pid` and `kill(<some stranger's pid>)` — no
       * group indirection to raise ESRCH by luck, which is how the empty-string
       * hole stayed invisible while a group-addressed worker rung looked safe.
       *
       * A refusal here is recorded and printed but does NOT fail the command.
       * The daemon holds no checkout, so no `--prune` decision rests on it and
       * there is no data-loss path to close; a run whose registry daemon is
       * unidentifiable is a run whose workers were already reported on their
       * own terms above.
       */
      let daemonReport: { stopped: boolean; how: string } | null = null;
      try {
        const pidFile = JSON.parse(await Bun.file(run.daemonPid).text()) as {
          pid: number;
          started?: unknown;
        };
        const anchor = await anchorIdentity(
          pidFile.pid,
          typeof pidFile.started === "string" ? pidFile.started : null,
          { force: forceIdentity },
        );
        if (anchor.kind === "refused") {
          daemonReport = { stopped: false, how: anchor.how };
          await ledger.append("daemon_down_refused", {
            detail: { how: anchor.how, reason: anchor.detail, pid: pidFile.pid },
          });
          if (opts.json !== true) {
            process.stderr.write(
              `  daemon: refused to signal pid ${pidFile.pid} — ${anchor.detail}; ` +
                `re-run with --force-identity to signal it anyway\n`,
            );
          }
        } else if (anchor.kind === "gone") {
          daemonReport = { stopped: true, how: "already_gone" };
        } else {
          const target = anchor.target;
          let how = "graceful";
          if (!(await waitGone(target, TERM_WAIT_MS))) {
            how = "sigterm";
            await signalGuarded(target, "SIGTERM", null);
            await waitGone(target, TERM_WAIT_MS);
          }
          daemonReport = { stopped: !(await sameIdentity(target, realProcessOps)), how };
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
        const workerOutcome = new Map(report.map((r) => [r.id, r]));
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
          const row = workerOutcome.get(id);
          if (row !== undefined && !row.stopped) {
            pruned.push({
              workerId: id,
              path: wt.path,
              pruned: false,
              // An anchor refusal is a DIFFERENT refusal from surviving the
              // ladder, and saying "survived the kill ladder" for it would be
              // a plain falsehood — no ladder ran. Both refuse, for the same
              // §9.3 reason, but only one of them has a `--force-identity`
              // answer, and an operator cannot pick it if the message hides
              // which case they are in.
              reason: isAnchorRefusal(row.how)
                ? `its supervisor could not be identified (${row.how}), so 'down' refused to signal it ` +
                  `and cannot show it is not still writing here; a live container writing here would be ` +
                  `corrupted by a delete (--force-identity anchors on whatever holds the pid)`
                : "its supervisor survived the kill ladder; a live container writing here would be corrupted by a delete",
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
      const refused = report.filter((r) => isAnchorRefusal(r.how));
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            run_id: runId,
            workers: report,
            clean: allStopped,
            // Additive, and non-fatal by design — see the daemon rung above.
            // Present so `--json` carries the fact at all: a refusal there
            // used to be indistinguishable from a daemon that was never running.
            ...(daemonReport !== null ? { daemon: daemonReport } : {}),
            ...(opts.prune === true ? { pruned } : {}),
          })}\n`,
        );
      } else {
        process.stdout.write(`run ${runId} down\n`);
        for (const r of report) {
          // REFUSED reads differently from STILL RUNNING on purpose. "Still
          // running" says a ladder was climbed and lost; a refusal says no
          // signal was ever sent, which is a different thing to do next.
          const verdict = r.stopped ? "stopped" : isAnchorRefusal(r.how) ? "REFUSED" : "STILL RUNNING";
          process.stdout.write(`  ${r.id}: ${verdict} (${r.how})\n`);
        }
        if (daemonReport !== null && !daemonReport.stopped) {
          process.stdout.write(`  daemon: REFUSED (${daemonReport.how})\n`);
        }
        for (const p of pruned) {
          process.stdout.write(`  ${p.workerId}: ${p.pruned ? "pruned" : "KEPT"} — ${p.reason}\n`);
        }
      }
      /**
       * Not stopped is not stopped, whichever way it got there — but the two
       * ways need different words, because they need different next actions.
       * A survivor was signalled and outlived it; a refusal was never
       * signalled at all, and `--force-identity` is the answer to exactly one
       * of those. The old single sentence claimed a ladder had been climbed
       * for both.
       */
      if (!allStopped) {
        const survivors = report.filter((r) => !r.stopped && !isAnchorRefusal(r.how));
        const parts: string[] = [];
        if (survivors.length > 0) parts.push(`${survivors.length} supervisor(s) survived the kill ladder`);
        if (refused.length > 0) {
          parts.push(
            `${refused.length} were never signalled because their recorded launch identity ` +
              `could not be confirmed (${[...new Set(refused.map((r) => r.how))].sort().join(", ")}); ` +
              `--force-identity signals them anyway`,
          );
        }
        throw new CliError(parts.join("; "), EXIT.WORKER_DIED);
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
 * Why an anchor declined to hand out a target.
 *
 * Three DIFFERENT facts about the world, kept apart deliberately. They were
 * all reported as `already_gone, stopped: true` — the same words used for
 * "nothing holds this pid" — and that collapse is what let a LIVE supervisor
 * be reported as stopped, exit 0, and then have its checkout deleted by
 * `--prune`, because the prune gate refuses only when `stopped` is false.
 * Only "nothing holds this pid" is a success; the rest are refusals to act,
 * and an operator who is not told the difference cannot act on it either.
 */
export type AnchorRefusal = "identity_mismatch" | "identity_unrecorded" | "identity_legacy_format";

const ANCHOR_REFUSALS = new Set<string>([
  "identity_mismatch",
  "identity_unrecorded",
  "identity_legacy_format",
]);

/** True for a `how` produced by an anchor refusal rather than by a ladder. */
function isAnchorRefusal(how: string): boolean {
  return ANCHOR_REFUSALS.has(how);
}

type Anchor =
  | { kind: "gone" }
  | { kind: "target"; target: ProcId; forced: boolean }
  | { kind: "refused"; how: AnchorRefusal; detail: string };

/**
 * Resolve the `(pid, started)` pair this ladder is allowed to signal (ISC-191).
 *
 * A pid is not an identity — `safety/kill.ts`'s header argues the general
 * case. `down` is where it bites hardest, because `down` is the one kill path
 * an operator runs BY HAND, typically against a run directory whose
 * supervisors died some time ago. A bare `pifleet down` resolves the latest
 * run, and after a reboot the latest run is a stale one whose recorded pids
 * now belong to whatever the machine started since.
 *
 * FAIL-CLOSED, in all three refusal directions:
 *
 *  - `identity_mismatch` — a comparable launch-time identity exists and
 *    disagrees with the OS. The process we meant to kill is gone and this pid
 *    belongs to a stranger.
 *  - `identity_unrecorded` — nothing comparable was recorded. This covers
 *    `null` (no registry entry, or one whose pid disagrees with `state.json`)
 *    AND the empty string, which is NOT a neutral value: `""` is precisely
 *    what both writers persist when their own capture failed
 *    (`(await processStartTime(process.pid)) ?? ""` in `startRegistryDaemon`
 *    and in `supervisor/index.ts`), and `RegistryWorkerSchema.started` is a
 *    bare `z.string()` so a truncated or hand-edited file yields it too —
 *    and stale files of unknown provenance are the entire premise of `down`.
 *    Treating `""` as "no constraint" made a failed capture DOWNGRADE to the
 *    rung-0 self-anchor, which on the daemon rung means `signalGuarded(…,
 *    null)` and therefore `signalIfSame` addressing `target.pid`: a bare pid,
 *    the literal thing ISC-191 forbids. Measured before this change, with a
 *    live `sleep` recorded as `{"pid":N,"started":""}`: `down` exited 0 with
 *    `clean: true` and the process was dead afterwards. Identical result with
 *    the field absent entirely.
 *  - `identity_legacy_format` — something was recorded, but before the
 *    rendering was pinned (`registry.ts`'s `IDENTITY_FORMAT`), so it is not
 *    comparable to anything this build can read off the OS. See the migration
 *    note in `register` for why this is its own answer and not a mismatch.
 *
 * `force` is `--force-identity`: it restores the pre-fix weak anchor for the
 * cases above — whatever holds the pid NOW becomes the target, every LATER
 * rung is still identity-checked, but rung 0 cannot tell a supervisor from a
 * stranger. It exists so a refusal is never a dead end, and it is a flag
 * rather than a default because typing it is the operator asserting the run
 * directory is theirs.
 */
async function anchorIdentity(
  pid: number,
  recorded: string | null,
  opts: { force: boolean },
): Promise<Anchor> {
  const current = await processStartTime(pid);
  // Nothing holds the pid. The one genuine success among these answers, and
  // the only one that may report `stopped: true`.
  if (current === null) return { kind: "gone" };

  const have = recorded !== null && recorded !== "" ? recorded : null;
  let refusal: { how: AnchorRefusal; detail: string } | null = null;
  if (have === null) {
    refusal = {
      how: "identity_unrecorded",
      detail:
        `nothing recorded a launch-time identity for pid ${pid}, so whatever holds that pid now ` +
        `cannot be shown to be the process this run launched`,
    };
  } else if (!isPinnedIdentity(have)) {
    refusal = {
      how: "identity_legacy_format",
      detail:
        `the identity recorded for pid ${pid} predates the pinned '${IDENTITY_FORMAT}' rendering, ` +
        `so it was written in whatever timezone and locale the launcher happened to have and is ` +
        `not comparable to what this build reads from the OS`,
    };
  } else if (have !== current) {
    refusal = {
      how: "identity_mismatch",
      detail: `pid ${pid} is held by a different process than the one this run recorded`,
    };
  }

  if (refusal === null) return { kind: "target", target: { pid, started: current }, forced: false };
  if (opts.force) return { kind: "target", target: { pid, started: current }, forced: true };
  return { kind: "refused", ...refusal };
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
