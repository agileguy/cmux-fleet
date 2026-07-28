import type { Command } from "commander";
import { readdir, unlink } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readPresentation, readWorkerState } from "../../run/state.ts";
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
 * (ISC-72/73). Worktree pruning is Phase 2; nothing here deletes data.
 */
export function register(program: Command): void {
  program
    .command("down")
    .description("Quiesce the run, stop containers and optionally prune worktrees")
    .option("--run <id>", "run id")
    .option("--keep-panes", "leave panes open")
    .option("--prune", "remove worktrees and branches")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; json?: boolean; keepPanes?: boolean }) => {
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
        process.stdout.write(`${JSON.stringify({ run_id: runId, workers: report, clean: allStopped })}\n`);
      } else {
        process.stdout.write(`run ${runId} down\n`);
        for (const r of report) {
          process.stdout.write(`  ${r.id}: ${r.stopped ? "stopped" : "STILL RUNNING"} (${r.how})\n`);
        }
      }
      if (!allStopped) {
        throw new CliError("some supervisors survived the kill ladder", EXIT.WORKER_DIED);
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
