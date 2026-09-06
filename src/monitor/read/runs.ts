/**
 * The live fleet: which runs are up, and which workers are under them
 * (SRD-FLEET-MONITOR §2.1, §6.3's slow clock, D6, D8).
 *
 * ## Every path comes from the path module (ISC-471)
 *
 * There is no `join()` in this file and no quoted filename. The run root
 * reaches `runPaths` (`run/paths.ts:193`), `runPaths` yields `workersDir`,
 * and every per-worker path is `workerPaths`' (`run/paths.ts:369`). That is
 * `run/paths.ts:1-18`'s first rule — "a path computed in two places will
 * eventually be computed differently in two places" — asserted rather than
 * trusted, and the assertion is in this module's own test against this
 * module's own source text.
 *
 * The rule earns its keep here specifically. ISC-188 and ISC-231 are both the
 * same recorded failure: `config/render.ts` built a run directory with its own
 * `join()` and described four mounts "at paths no run would ever contain". A
 * monitor making that mistake fails more quietly still — it would show an
 * empty fleet, and an empty fleet is a plausible reading of a quiet Tuesday.
 *
 * ## D8: live is the view
 *
 * `liveRunIds` (`run/registry.ts:1036`) and not `runIdsAscending`. §3.4
 * measured 80 runs on disk against 6 live; a default list of 80 rows of which
 * 74 are finished puts the six that matter above the fold only by accident of
 * sort order. `status.ts:99-111` already made this choice for this reason.
 *
 * ## The cost, and why this is a SLOW-clock reader
 *
 * §2.1 measured `liveRunIds` at **403 ms across 80 runs**, because it walks
 * every run on disk reading `registry.json` and every `state.json`, and spawns
 * a `ps` per worker until one answers alive. Cost is O(runs on disk), not
 * O(live runs). At the 500 ms fast clock that is most of a core, permanently,
 * to print six unchanging lines — so this function belongs on the 30 s clock
 * and the criterion in §10 that instruments the readers and asserts the ratio
 * is written against exactly this call.
 *
 * ## A blast radius this module CANNOT contain, stated rather than implied
 *
 * ISC-475 asks that an unreadable `state.json` degrade one row and no other,
 * and {@link readWorkerRows} delivers that for the worker TABLE. It does not
 * hold across the ENUMERATION step, and the reason is upstream:
 * `registry.ts:1043-1046` calls `readWorkerState` with no `try`, so the first
 * damaged state file it reaches throws out of `liveRunIds` itself — before any
 * row exists to degrade. Which worker it reaches first is `readdir` order,
 * which is filesystem-dependent, so the failure is not even deterministic.
 *
 * This file catches that throw and reports it as a `failed` runs region, which
 * is honest — with `liveRunIds` unable to finish, the monitor genuinely does
 * not know which runs are live, and `model.ts:47-56` exists so that fact can
 * be shown in place of a stale list. But it is a WIDER radius than ISC-475
 * asks for, and closing it means giving `registry.ts`'s worker loop the same
 * per-worker tolerance {@link readWorkerRow} has. That is a change to a module
 * the whole fleet's liveness depends on, so it is named here rather than
 * attempted from a viewer.
 */

import { monotonicMs } from "../../util/clock.ts";
import { ok, failed, type Region, type RunRow } from "../model.ts";
import { runPaths, runsRoot, type RunPaths } from "../../run/paths.ts";
import { liveRunIds } from "../../run/registry.ts";
import { readRunWorkerModels } from "../../run/state.ts";
import { readWorkerRows, type WorkerRead } from "./worker.ts";

/**
 * A `RunRow` whose workers are REGIONS rather than rows.
 *
 * `RunRow.workers` (`model.ts:146`) is a plain array because a rendered frame
 * has rows in it. A reader cannot promise that: one worker's `state.json` can
 * be damaged while its five siblings are fine, and ISC-475 says the five must
 * still render. A plain array offers exactly two ways to express the sixth —
 * drop it, or invent values for it — and both are the lie `model.ts:17-23`
 * wraps every reader in `Region` to prevent.
 *
 * `Omit<RunRow, "workers">` rather than a re-declared `runId`, for the reason
 * `PartialWorkerRow` uses `Omit`: the relationship to the contract stays a
 * compile-time fact.
 */
export interface PartialRunRow extends Omit<RunRow, "workers"> {
  readonly workers: readonly Region<WorkerRead>[];
}

export interface ReadRunsOptions {
  /**
   * The runs root. Defaults to `runsRoot()` (`run/paths.ts:54-56`), which
   * canonicalises `PIFLEET_RUNS_DIR` rather than returning it as authored —
   * so a test pointing this at a `mkdtemp` directory and production pointing
   * it at `~/.pifleet/runs` differ in one string and nothing else. That is
   * what makes ISC-491 reachable: no terminal, no container, no live fleet.
   */
  readonly root?: string;
  /** Container names from the last slow `docker ps`, or `null`. See `worker.ts`. */
  readonly containers?: ReadonlySet<string> | null;
  /** MONOTONIC, for every `readAt` in the tree. */
  readonly now?: () => number;
  /** WALL CLOCK, for `transcriptAgeMs` only (`read/worker.ts`). */
  readonly wallNow?: () => number;
}

/**
 * Every live run and the workers under it.
 *
 * ## The return type is `Region<readonly PartialRunRow[]>`, deliberately
 *
 * The target shape is `Region<readonly RunRow[]>` and this is not it. It
 * cannot be, and the reason is a contract fact rather than a preference:
 * `WorkerRow.activity` is required and non-nullable (`model.ts:127`), and
 * `model.ts:120-123` assigns its derivation to `src/monitor/activity.ts` —
 * "derived in exactly one place". A reader that returned `RunRow` would have
 * to fill that field, which means either deriving the ladder a second time or
 * inventing a value for it. `activity.ts` completes these regions into
 * `RunRow`s; until it runs, the field is ABSENT rather than wrong, and the
 * `Omit`s on {@link PartialRunRow} and `PartialWorkerRow` make the gap a
 * compile error at the joining site rather than a runtime surprise.
 *
 * `readAt` is stamped AFTER the walk finishes, not before it starts. On a
 * measured 403 ms walk the difference is not academic: stamping at entry would
 * report a reading as 400 ms fresher than it is, on the one clock slow enough
 * for that to matter. `model.ts:44` states the rule and ISC-477 is the
 * criterion; the version a reasonable person writes first is the wrong one,
 * because an age computed at paint time is always zero and always plausible.
 */
export async function readRuns(
  opts?: ReadRunsOptions,
): Promise<Region<readonly PartialRunRow[]>> {
  const root = opts?.root ?? runsRoot();
  const now = opts?.now ?? monotonicMs;

  let runIds: readonly string[];
  try {
    runIds = await liveRunIds(root);
  } catch (err) {
    // See the header: this is wider than ISC-475 wants and the reason is in
    // `registry.ts`, not here. Reported rather than swallowed, because a
    // monitor that cannot enumerate must say so instead of showing an empty
    // fleet — the one rendering an operator would read as "nothing is running".
    return failed(`unreadable run tree under ${root}: ${message(err)}`, now());
  }

  const rows: PartialRunRow[] = [];
  for (const runId of runIds) {
    const run = runPaths(runId, root);
    const workerIds = await workerIdsOf(run);
    if (workerIds === null) continue;
    const { models, modelsNote } = await recordedModels(run, workerIds);
    rows.push({
      runId,
      models,
      modelsNote,
      workers: await readWorkerRows(run, workerIds, {
        containers: opts?.containers ?? null,
        now,
        // Threaded rather than defaulted, so one caller controls both clocks.
        wallNow: opts?.wallNow,
      }),
    });
  }

  return ok(rows, now());
}

/**
 * What this run's workers were launched running, from the run's OWN record.
 *
 * `run.json`'s `worker_models` is `id -> "provider/model"`, written by `up`.
 * Read through `run/state.ts` and NOT with a local `JSON.parse`: ISC-472
 * forbids a module parsing a control-plane document itself, because doing so
 * discards `readValidated` and the `StateReadError` path. The first version of
 * this function did exactly that and the source-text guard caught it.
 *
 * **And the second version discarded that path anyway, one layer down.**
 * `readRunWorkerModels` used to swallow its own `StateReadError` and return
 * `{}`, so importing the compliant reader bought nothing: an unparseable
 * `run.json` reached this function as an empty map, indistinguishable from a
 * run predating the field. That reader's own docblock justified it with
 * "`runs.ts` has no region to degrade into for this", which was true when it
 * was written. There is a place now — {@link PartialRunRow.modelsNote} — so
 * the reader carries the diagnosis and this function carries it through.
 * **Neither failure was
 * visible to ISC-472's source-text guard**: it can see a `JSON.parse` that
 * should not be here, not a `catch` that throws information away in the module
 * it points at.
 *
 * Still never throws, and the note is still the ONLY thing a damaged
 * `run.json` costs: the run is listed, its workers are read, and the models
 * cell says why it is blank.
 *
 * De-duplicated in worker order: a four-seat run on one model should say that
 * model once, and the review console — four seats, three vendors — should say
 * all of them.
 */
async function recordedModels(
  run: RunPaths,
  workerIds: readonly string[],
): Promise<{ readonly models: readonly string[]; readonly modelsNote: string | null }> {
  const { models: byId, note } = await readRunWorkerModels(run);
  const out: string[] = [];
  for (const id of workerIds) {
    const m = byId[id];
    if (m === undefined || out.includes(m)) continue;
    out.push(m);
  }
  return { models: out, modelsNote: note };
}

/**
 * The worker ids under a run, or `null` when the directory is gone.
 *
 * `null` means SKIP the run, which is what `registry.ts:1046-1049` does with
 * the identical `readdir` — and matching it is the point rather than a
 * coincidence. `registry.ts:1084-1087` states the invariant directly: "a run
 * this selector called live and the table then called `gone` would be the
 * defect wearing a different mask." A run whose worker directory vanished
 * between the enumeration and this read is a run that ended mid-tick; listing
 * it with an empty worker table would assert a live run containing nothing,
 * which is a stronger claim than the data supports and reads on screen as a
 * fleet that has lost its workers.
 *
 * The dotfile filter is `registry.ts:1046`'s, kept identical for the same
 * reason. The SORT is this module's own addition and is a display property:
 * `readdir` order is filesystem-dependent — hash order on APFS, not creation
 * order — so an unsorted table would reshuffle its rows between ticks with no
 * state change behind it, which is unreadable on a standing pane and looks
 * exactly like activity.
 */
async function workerIdsOf(run: RunPaths): Promise<string[] | null> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(run.workersDir);
    return entries.filter((w) => !w.startsWith(".")).sort();
  } catch {
    return null;
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}
