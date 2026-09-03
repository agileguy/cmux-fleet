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

import { monotonicMs } from "../util/clock.ts";
import { deriveActivity } from "./activity.ts";
import { type FleetModel, type GitStrip, type Region, type RunRow, type ViewState, type WorkerRow, failed, never, ok } from "./model.ts";
import { readDockerContainers } from "./read/docker.ts";
import { readGit } from "./read/git.ts";
import { readHistory } from "./read/history.ts";
import { readRuns, type PartialRunRow } from "./read/runs.ts";
import { readWorkerDetail } from "./read/detail.ts";
import { readRunReport } from "./read/report.ts";
import { readWorkerRows } from "./read/worker.ts";
import { runPaths } from "../run/paths.ts";

export interface ComposeOptions {
  /** Runs root. Defaults to `PIFLEET_RUNS_DIR` via `runsRoot()`. */
  readonly root?: string;
  /** Repository the git strip watches. */
  readonly watchDir: string;
  readonly columns: number;
  /** MONOTONIC, for every `readAt` and for `FleetModel.now`. */
  readonly now?: () => number;
  /** WALL CLOCK, for transcript ages and the activity ladder only. */
  readonly wallNow?: () => number;
  /**
   * Container names from the last slow tick, or `null` when the slow clock has
   * not completed. Passing `undefined` makes this function run `docker ps`
   * itself, which is what a one-shot render wants and what a scheduler must not
   * do on the fast clock.
   */
  readonly containers?: Region<readonly string[]>;
  /**
   * Which of §6.2's four views to compose. Defaults to `{ kind: "fleet" }`,
   * which is ISC-483's requirement — the first frame answers §1.3's first two
   * questions with no input, so the view a caller does not name is the one
   * that needs no selection.
   */
  readonly view?: ViewState;
}

/**
 * Read the fleet once and return the model a view can paint.
 *
 * Never throws. Every region carries its own failure, which is the whole point
 * of `Region<T>`: a monitor whose Docker read takes the frame down is worse than
 * one with no container column.
 */
export async function composeFleet(opts: ComposeOptions): Promise<FleetModel> {
  const now = opts.now ?? monotonicMs;
  // The wall clock, for the transcript ages ONLY. See `model.ts`'s two-clocks
  // note; the two are never substituted for one another.
  const wallNow = opts.wallNow ?? Date.now;

  const containers = opts.containers ?? (await readDockerContainers({ now }));
  // `ok` -> a real set; anything else -> `null`, meaning NOT LOOKED AT. See the
  // header: the difference is `container-gone` on nothing versus on everything.
  const containerSet = containers.status === "ok" ? new Set(containers.value) : null;

  /*
   * The view's own payload is fetched ALONGSIDE the fleet, not after it.
   *
   * For `{ kind: "fleet" }` this costs nothing — `fetchForView`'s fleet arm is
   * a one-line `return empty` (ISC-502) — so the one-shot path has a single
   * shape rather than a branch, and a caller cannot enter a view and forget to
   * fill it. The three reads are independent, so they go in the same
   * `Promise.all`: a `--once --view report` should not pay the run walk and
   * then the report walk in series.
   */
  const view = opts.view ?? { kind: "fleet" };

  const [partial, git, payload] = await Promise.all([
    readRuns({ root: opts.root, containers: containerSet, now, wallNow }),
    readGit({ watchDir: opts.watchDir, now }),
    fetchForView(view, { root: opts.root, now, wallNow }),
  ]);

  return {
    runs: joinRuns(partial, wallNow()),
    containers,
    git,
    // Views 2-4 are ENTERED, never composed into a fleet tick (D8, §5.3).
    // On the fleet view all three of these are `never()` — not read, as
    // distinct from read-and-empty (`model.ts:57-65`) — and `fetchForView`
    // is what makes that a measured property rather than a literal here.
    view,
    ...payload,
    now: now(),
    columns: opts.columns,
  };
}

/**
 * The join, as a pure function of a region and a moment.
 *
 * Separated from {@link composeFleet} because the scheduler needs the SAME
 * join over a region it already holds — `FleetClocks` re-reads `runs` on its
 * own clock and hands back a snapshot, and a second copy of this loop written
 * against that snapshot is exactly the two-adjudicators shape D10 forbids. One
 * expression produces an `Activity` for a row and both callers go through it.
 *
 * `now` is a VALUE and not a getter here, deliberately. Every row in one frame
 * must be aged against one moment: a loop calling `Date.now()` per worker
 * would give the first and last rows of a 500-worker fleet different presents,
 * and two workers that grew their transcripts simultaneously would render
 * different ages for no reason a reader could discover.
 */
export function joinRuns(
  partial: Region<readonly PartialRunRow[]>,
  /**
   * WALL CLOCK epoch millis. It reaches only `deriveActivity`, whose sole
   * comparison is against a supervisor-written ISO stamp — see that function's
   * own note and `model.ts`'s. It is NOT `FleetModel.now`, which is monotonic,
   * and the two must never be passed to each other.
   */
  nowEpochMs: number,
): Region<readonly RunRow[]> {
  if (partial.status === "never") return never();
  if (partial.status === "failed") return failed(partial.reason, partial.readAt);

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
          nowEpochMs,
        ),
      });
    }
    built.push({ ...run, workers });
  }
  return ok(built, partial.readAt);
}

/**
 * The fast clock's rows when it has produced any, the walk's otherwise.
 *
 * ## Why `ok` is the only status that wins
 *
 * The fast source can only refresh workers a previous WALK found, so before the
 * first slow tick it has nothing and returns `never`. It can also fail on its
 * own. In both cases the walk's rows are the better answer — they are older but
 * they exist — and this is the one place in the design where a region is chosen
 * over another rather than rendered beside it.
 *
 * **The chosen region carries its own `readAt` with it**, which is what keeps
 * §6.4 honest: when the fast rows win, the fleet line ages from the fast tick
 * and says `as of 0s`; when the walk's rows win, it ages from the walk. The
 * marker never describes a different read from the one on screen.
 *
 * What it does NOT claim is that the run SET is that fresh. A run that appeared
 * since the last walk is absent from both regions until the medium `runNames`
 * scan promotes a walk, which is within one 5 s period of the change. Rows lag
 * by at most one fast period, enumeration by at most one medium period; the two
 * bounds are different and neither is hidden by preferring the fresher rows.
 */
function preferFresher(
  walked: Region<readonly PartialRunRow[]>,
  refreshed: Region<readonly PartialRunRow[]> | undefined,
): Region<readonly PartialRunRow[]> {
  return refreshed !== undefined && refreshed.status === "ok" ? refreshed : walked;
}

/**
 * A `FleetModel` from a scheduler snapshot (`clocks.ts:368`).
 *
 * **`now` comes from the caller and not from the snapshot**, because the
 * snapshot has no single moment: its four regions were read on three different
 * clocks and each carries its own `readAt`. That is the point — §6.4's
 * staleness marker is `now - readAt` per region, and a model that took its
 * present from any one region would report that region as permanently fresh.
 */
export function modelFrom(
  snapshot: {
    readonly runs: Region<readonly PartialRunRow[]>;
    /** The fast clock's per-worker refresh (§6.3). See {@link preferFresher}. */
    readonly workers?: Region<readonly PartialRunRow[]>;
    readonly containers: Region<readonly string[]>;
    readonly git: Region<GitStrip>;
  },
  opts: {
    readonly now: number;
    readonly nowEpochMs: number;
    readonly columns: number;
    readonly view?: ViewState;
    /**
     * Views 2-4's payload, fetched OFF the clocks and handed in.
     *
     * It is a parameter rather than something this function fetches because
     * `modelFrom` is synchronous and must stay so: it runs on every paint —
     * twice a second on the fast clock — and a paint that awaited a run walk
     * would put Q5's cost on the repaint path, which is the one place §6.3
     * forbids it. The caller owns when the payload is refreshed; this function
     * only decides what a frame is made of.
     */
    readonly payload?: Pick<FleetModel, "history" | "detail" | "report">;
  },
): FleetModel {
  return {
    // The WALL clock, for the ladder. `opts.now` is monotonic and feeds the
    // staleness markers; handing it to `joinRuns` would render every attended
    // worker `active`. See `model.ts`'s two-clocks note.
    runs: joinRuns(preferFresher(snapshot.runs, snapshot.workers), opts.nowEpochMs),
    view: opts.view ?? { kind: "fleet" },
    ...(opts.payload ?? { history: never(), detail: never(), report: never() }),
    containers: snapshot.containers,
    git: snapshot.git,
    now: opts.now,
    columns: opts.columns,
  };
}

/**
 * Fetch the ONE payload the entered view needs, and leave the other two
 * `never()` (§6.2, §6.3, §5.3, D8).
 *
 * ## What "costs nothing while unentered" has to mean to be checkable
 *
 * It cannot mean "is fast". It has to mean **no read happens at all**, because
 * §5.3 defers `collectRunReport` on any clock and §6.3 gives views 2-4 no clock
 * — and a payload that were merely cheap would still be paid for 120 times a
 * minute by a pane nobody has left. So this function is a `switch` in which
 * every arm calls exactly one reader, and the arms are mutually exclusive by
 * construction: `ViewState` is a discriminated union carrying its own
 * selection, so there is no state in which two payloads are wanted and none in
 * which a payload is wanted with nothing to point it at.
 *
 * **`fleet` reads nothing.** That is the default view (`model.ts:206`), so the
 * ordinary case of the ordinary session performs none of these reads ever —
 * which is what makes the criterion an absence a test can observe rather than
 * a latency it would have to measure.
 *
 * ## Why the entered payload REPLACES rather than accumulates
 *
 * Leaving view 3's rows in the model while the operator is in view 4 would put
 * a run list on screen aged from whenever it was last fetched, with no clock
 * behind it to refresh it and no marker distinguishing it from a live one.
 * §6.4 allows a stale region only when something is still trying: *"as of 47s —
 * refresh failed"* names a reader that ran. A payload from an abandoned view is
 * a reader that is not running at all, and there is no honest rendering of
 * that, so it goes back to `never` — "I could not look", which is exactly true
 * of a view nobody is in.
 *
 * ## Never throws
 *
 * Every reader below already returns a `Region`, so this function has no `try`
 * and no way to widen a blast radius it cannot see — the same structural
 * argument `readWorkerRows` makes about its own loop.
 */
export async function fetchForView(
  view: ViewState,
  opts: {
    readonly root?: string;
    /** MONOTONIC, for `readAt`. */
    readonly now?: () => number;
    /** WALL CLOCK, for `RunHistoryRow.ageMs` only (`read/history.ts`). */
    readonly wallNow?: () => number;
  } = {},
): Promise<Pick<FleetModel, "history" | "detail" | "report">> {
  /*
   * ANNOTATED rather than inferred. `never<T>()` has nothing to infer `T` from,
   * so an unannotated literal here is `Region<unknown>` in all three slots and
   * every spread below widens the payload instead of narrowing it — the shape
   * where a reader's real type quietly stops being checked at the joining site.
   */
  const empty: Pick<FleetModel, "history" | "detail" | "report"> = {
    history: never(),
    detail: never(),
    report: never(),
  };
  switch (view.kind) {
    case "fleet":
      return empty;
    case "history":
      return { ...empty, history: await readHistory(opts) };
    case "worker":
      return {
        ...empty,
        detail: await readWorkerDetail(runPaths(view.runId, opts.root), view.workerId, {
          now: opts.now,
        }),
      };
    case "report":
      return { ...empty, report: await readRunReport(view.runId, opts) };
  }
}

/**
 * A model with one view entered — {@link fetchForView}'s result folded onto a
 * frame that already has a fleet in it.
 *
 * Separated from the fetch so the fetch stays a pure function of a `ViewState`
 * and this stays a pure function of two values. The fleet regions are carried
 * through UNTOUCHED: entering view 4 must not re-walk the run tree, and a
 * function that rebuilt the model would be the obvious place for that to creep
 * in.
 */
export function withView(
  model: FleetModel,
  view: ViewState,
  payload: Pick<FleetModel, "history" | "detail" | "report">,
): FleetModel {
  return { ...model, view, ...payload };
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
