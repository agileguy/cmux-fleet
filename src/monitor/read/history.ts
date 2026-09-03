/**
 * View 3's rows: every run under the root, newest first
 * (SRD-FLEET-MONITOR §6.2 View 3, D8, Finding C).
 *
 * ## THE ENUMERATION IS `runIdsAscending`, AND MTIME IS REFUSED
 *
 * `runIdsAscending` (`run/paths.ts:937`) is Finding C's *"only correct
 * enumeration"*, and it is correct for two separate reasons that a replacement
 * would have to satisfy both of:
 *
 * 1. **It stats `run.json` in every entry and drops the ones without.**
 *    Measured on this host: 34 of 114 directories under the runs root hold no
 *    `run.json`, so a bare `readdir` shows 42% more "runs" than exist. The
 *    filter's own comment records the failure it prevents — *"a stray name that
 *    sorts after every timestamp would otherwise become 'the latest run'"* —
 *    which the e2e suite found rather than a reviewer.
 * 2. **It sorts LEXICALLY, and the id format makes that chronological**
 *    (`paths.ts:98-108`). The order therefore comes from the run's own identity
 *    and from nothing else.
 *
 * **The rejected alternative is an mtime sort, and it is rejected because it
 * silently produces a WRONG ORDER rather than a failure.** A run directory's
 * mtime moves whenever anything under it is written — a harvest, a later
 * `report`, a `down --prune` touching a sibling, an editor opening a file, a
 * backup tool. So the first time anyone touches an old run it jumps to the top
 * of "newest first" and stays there, and nothing on screen says so: the list is
 * still a list of real runs, still in a plausible order, and still completely
 * wrong about which one just happened. That is the §4.3 shape — a viewer that
 * lies is worse than one that admits it cannot see — and it is why the test for
 * this module touches an old run and asserts it does not move.
 *
 * ## `ageMs` IS WALL CLOCK, and it is the one clock in this file
 *
 * The run id is a UTC timestamp written by `newRunId` in a DIFFERENT PROCESS at
 * a different time, so its only possible other operand is `Date.now()`. That is
 * the same exemption `status.ts:39-45` claims for `ago` and `read/worker.ts`
 * claims for `transcriptAgeMs`. `Region.readAt` in this file is monotonic, as
 * everywhere; the two never meet, and `model.ts`'s two-clocks note says what
 * happens if they do — a monotonic minus an epoch clamps to 0, and every run
 * renders as though it started this instant.
 *
 * ## Why this is on NO CLOCK
 *
 * D8: live is the view and history is a mode you enter. This function is the
 * expensive half of that decision — `liveRunIds` alone measured 331 ms at 80
 * runs and 1777 ms at 500 (§9 Q5), and the per-run directory listings below sit
 * on top of it. §6.3 gives it no clock and `compose.ts` hands back `never()`
 * until the operator asks, which is the difference between a monitor that pays
 * Q5's cost on every tick and one that pays it on a keystroke.
 */

import { readdir } from "node:fs/promises";
import { monotonicMs } from "../../util/clock.ts";
import { failed, ok, type Region, type RunHistoryRow } from "../model.ts";
import { runIdsAscending, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { liveRunIds } from "../../run/registry.ts";

export interface ReadHistoryOptions {
  /** The runs root. Defaults to `runsRoot()`, as every reader here does. */
  readonly root?: string;
  /** MONOTONIC, for `readAt`. Defaults to `monotonicMs`. */
  readonly now?: () => number;
  /**
   * WALL CLOCK, for `ageMs` ONLY. Defaults to `Date.now`.
   *
   * Separate from {@link now} and never defaulted from it, on
   * `read/worker.ts`'s reasoning: a test that sets one and forgets the other
   * should get an obviously wrong number rather than a quietly wrong one.
   */
  readonly wallNow?: () => number;
}

/**
 * Every run under the root, newest first.
 *
 * ## The failure model, and why only ONE thing fails the region
 *
 * Enumeration is all-or-nothing: if `runIdsAscending` or `liveRunIds` throws
 * there is no list, and an empty list would render as "this fleet has no
 * history", which is a confident answer to a question the reader could not
 * answer. That is a `failed` region.
 *
 * Everything BELOW the enumeration degrades per row instead. A run whose
 * `workers/` directory has gone counts zero workers rather than taking the
 * whole view down — `RunHistoryRow` has no representation for "unknown", so a
 * missing directory and an empty one both count 0, and the honest reading of
 * both is the same: nothing is there now. Contrast `read/worker.ts`, where the
 * absence of `state.json` is `never` because `PartialWorkerRow` has no empty
 * inhabitant. The line is whether the value type can represent nothing.
 *
 * ## `live` is `registry.ts`'s answer, not a second one
 *
 * `liveRunIds` already handles the case this module would get wrong: a
 * RECYCLED PID. It checks `(pid, start-time)` identity rather than the pid
 * alone, because *"the number outlives the process and the kernel hands it out
 * again"*, and it treats an unreadable worker as an absence of evidence rather
 * than as evidence of death (ISC-494). Deriving liveness here from `phase` or
 * from a bare `kill(pid, 0)` would be a second definition of the fleet's most
 * load-bearing predicate — ISC-231 and ISC-345's shape — and it would disagree
 * with view 1 about which runs are up, in the one view whose job is to compare
 * them.
 */
export async function readHistory(
  opts?: ReadHistoryOptions,
): Promise<Region<readonly RunHistoryRow[]>> {
  const root = opts?.root ?? runsRoot();
  const now = opts?.now ?? monotonicMs;
  const wallNow = opts?.wallNow ?? Date.now;

  let ascending: readonly string[];
  let live: ReadonlySet<string>;
  try {
    ascending = await runIdsAscending(root);
    live = new Set(await liveRunIds(root));
  } catch (err) {
    return failed(`unreadable run tree under ${root}: ${firstLine(err)}`, now());
  }

  /*
   * ONE reading of the wall clock for the whole list, not one per row.
   * `compose.ts:104-107` states the rule for the fleet view and it holds here:
   * a loop calling `Date.now()` per run would give the first and last rows of a
   * 500-run list different presents, so two runs started in the same second
   * would render different ages for no reason a reader could discover.
   */
  const nowEpochMs = wallNow();

  const rows: RunHistoryRow[] = [];
  // REVERSED, not re-sorted. The order is `runIdsAscending`'s and this is the
  // only expression in the module that touches it — a `.sort()` here would be a
  // second ordering rule and the mtime hazard would have somewhere to live.
  for (let i = ascending.length - 1; i >= 0; i--) {
    const runId = ascending[i]!;
    const run = runPaths(runId, root);
    const workers = await documentsIn(run.workersDir, null);
    let settledCount = 0;
    for (const worker of workers) {
      settledCount += (await documentsIn(workerPaths(run, worker).tasksDir, ".json")).length;
    }
    rows.push({
      runId,
      ageMs: runAgeMs(runId, nowEpochMs),
      workerCount: workers.length,
      live: live.has(runId),
      taskCount: (await documentsIn(run.inboxDir, ".json")).length,
      settledCount,
    });
  }

  return ok(rows, now());
}

/**
 * Entries in a directory, filtered the way this repository already filters
 * them, or `[]` when the directory is not there.
 *
 * `suffix === null` is the worker-directory case: those are directories rather
 * than documents, and the dotfile filter is `registry.ts:1046`'s, kept
 * identical for the reason `read/runs.ts` gives — a monitor that counted
 * workers differently from the enumerator would disagree with view 1 about the
 * same run.
 *
 * `suffix === ".json"` is `collect.ts:492`'s exact predicate, and matching it
 * is what makes `taskCount` the same number `report` counts. A monitor that
 * counted every entry would include a `.tmp` from an interrupted atomic write
 * and report a task that does not exist.
 */
async function documentsIn(dir: string, suffix: string | null): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.startsWith("."))
    .filter((e) => suffix === null || e.endsWith(suffix))
    .sort();
}

/**
 * The run id's own timestamp, as an age in wall-clock millis.
 *
 * `newRunId` (`paths.ts:101-109`) builds the id as an ISO stamp with `:` and
 * `.` replaced by `-` and the milliseconds dropped, plus a random suffix. This
 * inverts exactly that transformation and nothing more: the date part is
 * already ISO, and the three time fields are put back behind colons.
 *
 * Clamped at zero on `regionAgeMs`'s reasoning (`model.ts:103`) — a stamp from
 * the future is a clock skew, and a negative age renders as a run that starts
 * later today.
 *
 * ## An id that is not a timestamp, and the field that cannot say so
 *
 * `runIdsAscending` admits any directory holding a `run.json`, so a run id that
 * is not a timestamp is reachable — this repository's own unit fixtures use
 * `r1` and `run-77`. **`RunHistoryRow.ageMs` is `number` and not
 * `number | null`, so there is no way to report "unknown" in the field**, which
 * is an inconsistency with `transcriptAgeMs` and `regionAgeMs`, both of which
 * are nullable for precisely this case. The contract is frozen, so this is
 * worked around rather than fixed, and the workaround is chosen for its
 * DIRECTION:
 *
 * - `0` is refused. It renders as "started just now" and would put an
 *   undatable run at the top of a newest-first list looking like the freshest
 *   thing on the fleet. That is the most reassuring possible frame and it is
 *   false, which is the exact failure `model.ts`'s two-clocks note is about.
 * - The origin falls back to the UNIX epoch, so the age becomes "as old as
 *   timekeeping". It is the same expression with no evidence in it, it sorts
 *   and reads as ancient rather than as current, and it is unmistakable: no
 *   real run on this fleet is fifty-six years old. The row still carries
 *   `runId` itself, so a reader who wants to know why has the evidence in hand.
 */
function runAgeMs(runId: string, nowEpochMs: number): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(runId);
  const started = m === null ? 0 : Date.parse(`${m[1]!}T${m[2]!}:${m[3]!}:${m[4]!}Z`);
  return Math.max(0, nowEpochMs - (Number.isNaN(started) ? 0 : started));
}

/** One line of diagnosis — a region reason is one cell (`read/worker.ts`). */
function firstLine(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}
