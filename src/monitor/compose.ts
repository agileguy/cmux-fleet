/**
 * The joining site: readers + the ladder -> one `FleetModel` (SRD-FLEET-MONITOR
 * §6.1, D5, D10).
 *
 * ## Why this is a separate file and not the bottom of `read/runs.ts`
 *
 * `readRuns` returns `Region<readonly PartialRunRow[]>` on purpose — the `Omit`
 * on `PartialWorkerRow` makes the missing `activity` field a COMPILE error at
 * whichever site claims to have a `WorkerRow`, and that site is this one. Put
 * the join inside the reader and the reader has to derive the ladder, which is
 * the second adjudicator ISC-231 and D10 exist to prevent. Keeping it here means
 * there is exactly one expression in the repository that produces an `Activity`
 * for a row, and it is the call to `deriveActivity` below.
 *
 * ## The container set is threaded, never re-read
 *
 * `docker ps` is a 37 ms subprocess (Q2, measured) and belongs to the SLOW
 * clock. Its answer arrives here as a set and is passed DOWN into
 * `readWorkerRows`, because `containerPresent` has three states and only the
 * caller knows which one applies: a `docker` region that is `ok` yields a real
 * `true`/`false` per worker, and one that is `failed` or `never` must yield
 * `null` for every worker rather than `false`. Collapsing that here would put
 * `container-gone` — the most actionable row in the design — on the entire fleet
 * the first time Docker Desktop is not running.
 */

import { deriveActivity } from "./activity.ts";
import { type FleetModel, type Region, type RunRow, type WorkerRow, failed, never, ok } from "./model.ts";
import { readDockerContainers } from "./read/docker.ts";
import { readGit } from "./read/git.ts";
import { readRuns } from "./read/runs.ts";
import { readWorkerRows } from "./read/worker.ts";
import { runPaths } from "../run/paths.ts";

export interface ComposeOptions {
  /** Runs root. Defaults to `PIFLEET_RUNS_DIR` via `runsRoot()`. */
  readonly root?: string;
  /** Repository the git strip watches. */
  readonly watchDir: string;
  readonly columns: number;
  readonly now?: () => number;
  /**
   * Container names from the last slow tick, or `null` when the slow clock has
   * not completed. Passing `undefined` makes this function run `docker ps`
   * itself, which is what a one-shot render wants and what a scheduler must not
   * do on the fast clock.
   */
  readonly containers?: Region<readonly string[]>;
}

/**
 * Read the fleet once and return the model a view can paint.
 *
 * Never throws. Every region carries its own failure, which is the whole point
 * of `Region<T>`: a monitor whose Docker read takes the frame down is worse than
 * one with no container column.
 */
export async function composeFleet(opts: ComposeOptions): Promise<FleetModel> {
  const now = opts.now ?? Date.now;

  const containers = opts.containers ?? (await readDockerContainers({ now }));
  // `ok` -> a real set; anything else -> `null`, meaning NOT LOOKED AT. See the
  // header: the difference is `container-gone` on nothing versus on everything.
  const containerSet = containers.status === "ok" ? new Set(containers.value) : null;

  const [partial, git] = await Promise.all([
    readRuns({ root: opts.root, containers: containerSet, now }),
    readGit({ watchDir: opts.watchDir, now }),
  ]);

  let runs: Region<readonly RunRow[]>;
  if (partial.status !== "ok") {
    runs = partial.status === "failed" ? failed(partial.reason, partial.readAt) : never();
  } else {
    const built: RunRow[] = [];
    for (const run of partial.value) {
      const workers: WorkerRow[] = [];
      for (const region of run.workers) {
        // A worker whose own read failed is DROPPED from the row list rather
        // than rendered as a guess. `run.workers` keeps the region so a future
        // view can count the losses; inventing an `Activity` for a worker whose
        // `state.json` would not parse is the one thing the ladder must not do.
        if (region.status !== "ok") continue;
        const { row, evidence } = region.value;
        workers.push({
          ...row,
          activity: deriveActivity(
            {
              adoptedTerminal: evidence.presentation?.adopted_terminal ?? null,
              attendedMode: evidence.attended?.mode ?? null,
              sessionPresent: evidence.state.session_present,
              transcriptActivity: evidence.state.transcript_activity ?? null,
              phase: row.phase,
              containerPresent: row.containerPresent,
            },
            now(),
          ),
        });
      }
      built.push({ ...run, workers });
    }
    runs = ok(built, partial.readAt);
  }

  return { runs, containers, git, now: now(), columns: opts.columns };
}

/**
 * Re-read only the worker rows of one run. Exported for the fast clock, which
 * must not walk the run tree (§3.4, Q5: the walk measured 403 ms).
 */
export async function composeWorkers(
  runId: string,
  workerIds: readonly string[],
  opts: { readonly root?: string; readonly containers?: ReadonlySet<string> | null; readonly now?: () => number },
) {
  return readWorkerRows(runPaths(runId, opts.root), workerIds, {
    containers: opts.containers ?? null,
    now: opts.now,
  });
}
