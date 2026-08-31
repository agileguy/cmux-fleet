import type { Command } from "commander";
import { readdir } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, type WorkerState } from "../../contracts.ts";
import { latestRunId, runIdsAscending, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
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
      const runId = opts.run ?? (await latestLiveRunId(root)) ?? (await latestRunId(root));
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

/**
 * The newest run that still has a LIVE supervisor, or null when none does.
 *
 * ## The question `status` is actually asked
 *
 * `latestRunId` answers "which run directory sorts last", and for `report` and
 * `harvest` that is right — they grade a finished run and a dead one is their
 * subject. `status` answers "what is my fleet doing", and there the newest
 * DIRECTORY is the wrong run whenever the newest run is over and an older one
 * is still up.
 *
 * MEASURED on the operations console 2026-08-30, twice. First it showed
 * `run 2026-08-24T17-18-05Z-7f40 / eng-1: dead supervisor=gone` — a run six
 * days old — while nothing else was running. Then, with a healthy fleet up
 * under `2026-08-31T05-31-17Z-8058`, a `down` of a NEWER run left the pane
 * reporting `dead / supervisor=gone` for the run that had just ended, with the
 * live one invisible. A standing pane whose job is to say whether the fleet is
 * up, saying "gone" while it is up, is worse than no pane.
 *
 * Newest-first with an early return, so the common case — the newest run IS
 * the live one — costs a single run's worth of checks rather than a scan of
 * every run ever created.
 *
 * FALLS BACK, and the fallback is not a detail: with no live run at all this
 * returns null and the caller uses `latestRunId`, so a post-mortem `status`
 * after everything has settled behaves exactly as it always did. This narrows
 * WHICH run is chosen when several exist; it never makes `status` refuse one.
 */
export async function latestLiveRunId(root: string): Promise<string | null> {
  const runs = await runIdsAscending(root);
  for (let i = runs.length - 1; i >= 0; i--) {
    const runId = runs[i]!;
    const run = runPaths(runId, root);
    const registry = await readRegistry(run);
    let workerIds: string[];
    try {
      workerIds = (await readdir(run.workersDir)).filter((w) => !w.startsWith("."));
    } catch {
      continue;
    }
    for (const id of workerIds) {
      const state = await readWorkerState(workerPaths(run, id));
      if (state === null) continue;
      // The SAME (pid, start-time) identity the snapshot below uses, not a
      // second liveness rule: a run this selector called live and the table
      // then called `gone` would be the defect wearing a different mask.
      const registered = registry?.workers[id];
      const alive =
        registered !== undefined
          ? await identityAlive({ pid: registered.pid, started: registered.started })
          : (await processStartTime(state.pid)) !== null;
      if (alive) return runId;
    }
  }
  return null;
}
