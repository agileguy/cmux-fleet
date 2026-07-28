/**
 * Shared preflight for the control verbs (`steer`, `abort`, `exec`).
 *
 * The three verbs share one failure discipline: a worker nobody has heard of
 * is EXIT.USAGE with a message naming the worker AND the run, and a worker
 * whose supervisor is gone is EXIT.WORKER_DIED. The distinction has to be
 * made HERE, before any socket is touched, because a connect failure cannot
 * make it: the control socket for a worker that never existed and one whose
 * supervisor died look identical from `connect(2)` — both refuse — so a verb
 * that goes straight to the socket reports a typo'd `--worker` as a dead
 * worker, and the operator starts debugging a fleet that is fine.
 *
 * One module rather than three copies for the same reason paths.ts gives:
 * a predicate computed in three places will eventually be computed
 * differently in three places, and the verbs would then disagree about
 * which exit code a given corpse deserves.
 */

import { existsSync } from "node:fs";
import { CliError } from "./index.ts";
import { EXIT, type WorkerState } from "../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths, type RunPaths } from "../run/paths.ts";
import { readWorkerState } from "../run/state.ts";
import { processStartTime } from "../run/registry.ts";

/**
 * Resolve `--run` (or the latest run) to paths, refusing a name that names
 * nothing. Same predicate as `dispatch`: the run DIRECTORY, not `run.json` —
 * a supervisor can be launched against a run dir that `up` did not build,
 * and a typo'd `--run` reported as "no such worker" would misdirect the
 * operator one level down from where the typo actually is.
 */
export async function resolveRunPaths(runOpt: string | undefined): Promise<RunPaths> {
  const root = runsRoot();
  const runId = runOpt ?? (await latestRunId(root));
  if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
  const run = runPaths(runId, root);
  if (!existsSync(run.root)) {
    throw new CliError(`no such run: ${runId} (looked in ${root})`, EXIT.USAGE);
  }
  return run;
}

export type WorkerLiveness = "unknown" | "dead" | "alive";

/**
 * Pure classification, exported so the unit suite can pin the boundary
 * between the two exit codes without a filesystem.
 *
 * `phase === "dead"` and a vanished pid are BOTH dead: the supervisor
 * records `dead` on a clean child exit, but a SIGKILL'd supervisor writes
 * nothing — its last state says `busy` forever, and only the OS knows it is
 * gone. Same rule the `--auto` scheduler applies (`workerHealth`).
 */
export function classifyWorker(
  state: WorkerState | null,
  procStart: string | null,
): WorkerLiveness {
  if (state === null) return "unknown";
  if (state.phase === "dead" || procStart === null) return "dead";
  return "alive";
}

/**
 * The state of a worker the caller may talk to, or a diagnosed CliError.
 *
 * Messages name the worker and the run (never just "not found"): the operator
 * running these verbs is mid-intervention on a live fleet, and a bare error
 * costs them a round-trip through `status` to learn which half they typo'd.
 */
export async function requireLiveWorker(run: RunPaths, workerId: string): Promise<WorkerState> {
  const wp = workerPaths(run, workerId);
  const state = await readWorkerState(wp);
  const procStart = state === null ? null : await processStartTime(state.pid);
  switch (classifyWorker(state, procStart)) {
    case "unknown":
      throw new CliError(`no such worker ${workerId} in run ${run.runId}`, EXIT.USAGE);
    case "dead":
      throw new CliError(
        `worker ${workerId} in run ${run.runId} is dead` +
          (state?.phase === "dead"
            ? " (supervisor recorded a child exit)"
            : ` (supervisor pid ${state?.pid} is gone)`),
        EXIT.WORKER_DIED,
      );
    case "alive":
      return state!;
  }
}
