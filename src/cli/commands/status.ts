import type { Command } from "commander";
import { readdir } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, type WorkerState } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readWorkerState } from "../../run/state.ts";
import { identityAlive, processStartTime, readRegistry } from "../../run/registry.ts";

/**
 * Register `pifleet status` (SRD §10): a fleet snapshot read entirely from
 * durable files — which is what makes re-attaching after a killed CLI work
 * (ISC-76): the supervisors never noticed the CLI die, and their state files
 * are the interface.
 */
export function register(program: Command): void {
  program
    .command("status")
    .description("Print a fleet snapshot")
    .option("--run <id>", "run id")
    .option("--watch", "refresh until interrupted")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; watch?: boolean; json?: boolean }) => {
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
      const run = runPaths(runId, root);

      const emit = async (): Promise<void> => {
        const registry = await readRegistry(run);
        let workerIds: string[];
        try {
          workerIds = (await readdir(run.workersDir)).filter((w) => !w.startsWith("."));
        } catch {
          workerIds = [];
        }

        const workers: Array<{ state: WorkerState | null; id: string; alive: boolean }> = [];
        for (const id of workerIds.sort()) {
          const state = await readWorkerState(workerPaths(run, id));
          let alive = false;
          if (state !== null) {
            const registered = registry?.workers[id];
            // (pid, start-time) identity, never pid alone: a recycled pid must
            // not resurrect a dead supervisor in the snapshot.
            alive =
              registered !== undefined
                ? await identityAlive({ pid: registered.pid, started: registered.started })
                : (await processStartTime(state.pid)) !== null;
          }
          workers.push({ id, state, alive });
        }

        if (opts.json === true) {
          process.stdout.write(
            `${JSON.stringify({
              run_id: runId,
              workers: workers.map((w) => ({
                id: w.id,
                alive: w.alive,
                phase: w.state?.phase ?? null,
                task_id: w.state?.task_id ?? null,
                epoch: w.state?.epoch ?? null,
                completed_epochs: w.state?.completed_epochs ?? [],
                pid: w.state?.pid ?? null,
                pgid: w.state?.pgid ?? null,
                session_path: w.state?.session_path ?? null,
                session_present: w.state?.session_present ?? false,
                heartbeat_at: w.state?.heartbeat_at ?? null,
              })),
            })}\n`,
          );
        } else {
          process.stdout.write(`run ${runId}\n`);
          for (const w of workers) {
            const phase = w.state?.phase ?? "unknown";
            const task = w.state?.task_id === null || w.state === null ? "-" : w.state.task_id;
            const live = w.alive ? "up" : "gone";
            process.stdout.write(`  ${w.id}: ${phase} task=${task} supervisor=${live}\n`);
          }
        }
      };

      if (opts.watch === true) {
        // Refresh until interrupted; SIGINT is the exit path.
        for (;;) {
          await emit();
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      await emit();
    });
}
