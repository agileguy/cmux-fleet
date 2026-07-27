import type { Command } from "commander";
import { readdir, unlink } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readWorkerState } from "../../run/state.ts";
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
    .action(async (opts: { run?: string; json?: boolean }) => {
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
