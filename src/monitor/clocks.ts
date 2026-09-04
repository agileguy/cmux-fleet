/**
 * The monitor's three clocks, and the staleness model they produce
 * (SRD-FLEET-MONITOR §6.3, §6.4, D4, D5).
 *
 * ## Why three clocks rather than one interval
 *
 * The incumbent has one poll interval because it has one read. This pane has
 * sources whose costs differ by **three orders of magnitude**, measured on this
 * host on 2026-09-02 (§9 Q5):
 *
 * | Read | 80 runs | 500 runs |
 * |---|---|---|
 * | `liveRunIds` (`run/registry.ts:1036`) | 331 ms | **1777 ms** |
 * | `runIdsAscending` (`run/paths.ts:937`) | 3 ms | **9 ms** |
 * | `docker ps` (`read/docker.ts:208`) | — | **37 ms** |
 * | `docker stats --no-stream` | — | 2042 ms (refused, D7) |
 *
 * The dominant term in `liveRunIds` is the per-worker `ps` spawn inside
 * `processStartTime`, not directory enumeration — which is why the second row
 * is 0.5% of the first rather than a fraction of it. **That gap is the entire
 * justification for this file.** One interval forces a choice between a 500 ms
 * clock that never finishes a tick and a 30 s clock on which a keystroke-scale
 * fact ages half a minute. Three clocks refuse the choice.
 *
 * ## The guard, and why it is a duty cycle rather than a label
 *
 * A `cheap`/`expensive` flag on each source would be a comment with a type
 * annotation: nothing checks it, and the failure it guards — someone moving a
 * read to a faster clock — is exactly the edit that would also relabel it.
 * So every source declares its MEASURED cost and the constructor refuses any
 * placement whose duty cycle exceeds {@link MAX_DUTY_CYCLE}. Against the
 * numbers above that arithmetic decides the placement by itself:
 *
 * - `liveRunIds` at 1777 ms — fast **355%**, medium **35.5%**, slow **5.9%**.
 *   Only the slow clock is admissible, which is D4 derived rather than asserted.
 * - `runIdsAscending` at 9 ms — medium **0.18%**. Cheap appearance-detection on
 *   the 5 s clock is therefore measured-cheap, not hoped-cheap (§6.3).
 *
 * **10% is a choice and is argued rather than presented as measured.** Any
 * threshold between 5.9% and 35.5% separates slow from medium for the walk;
 * 10% is the round number in that interval, and it leaves ~1.7× headroom over
 * the measured slow-clock figure — so a fleet growing from 500 runs to roughly
 * 850 trips this guard *before* the clock saturates, rather than after.
 *
 * **What the guard does NOT do, stated so nobody trusts it further than it
 * goes.** `docker ps` at 37 ms would pass on the FAST clock at 7.4%. Its
 * placement on the slow clock is D7 — a decision about how often a container
 * set is worth re-reading — and no cost arithmetic can derive it. That pinning
 * is a literal in {@link fleetSources} and a test assertion, and nothing else.
 *
 * ## Overrun is a separate risk with a separate mechanism
 *
 * The duty-cycle guard plans for the MEASURED cost. It cannot plan for a
 * pathological one: `read/docker.ts:135` bounds a hung daemon at 5 s, which is
 * 16.7% of the slow period and would fail the same guard if declared as the
 * cost. Declaring a pathological bound as a period-planning input is how a
 * budget stops describing anything. So the two risks are separated: the guard
 * takes the measurement, and a per-source in-flight latch takes the overrun —
 * a source still reading when its clock comes round again is SKIPPED, never
 * queued. Without the latch a 1777 ms walk on a saturated host accumulates
 * dispatches and the pane's memory grows with its lateness.
 *
 * ## The one thing here that is easy to get wrong, and is therefore asserted
 *
 * `readAt` is stamped from `now()` read **after** the read settles. The
 * version a reasonable person writes first stamps it at dispatch, or lets the
 * renderer compute an age at paint time — and a paint-time age is always zero,
 * always plausible, and always a lie (`model.ts:44`, ISC-477). On the 1777 ms
 * walk the dispatch-time variant reports a reading as most of two seconds
 * fresher than it is, on the one clock slow enough for that to be the whole
 * error.
 *
 * ## A units hazard this module inherits and does NOT resolve
 *
 * `model.ts` specifies `readAt` as **monotonic millis** since the owner's
 * decision of 2026-09-02, so {@link nowDefault} is `monotonicMs`. Every
 * consumer of `readAt` subtracts it (`regionAgeMs`,
 * `model.ts:83`), and `util/clock.ts:1-18` argues that subtracting two wall
 * clock readings is a bug — NTP steps and laptop suspend are exactly the
 * events a standing monitor sits through, and each one makes every age on
 * screen wrong by the size of the step. The correct fix is `monotonicMs` on
 * both sides, which is a change to `model.ts`'s stated units and to whatever
 * sets `FleetModel.now`; making it from here unilaterally would give the
 * renderer a monotonic `readAt` to subtract from a wall-clock `now`, and two
 * clocks in one subtraction is a worse bug than the one it fixes. **So the
 * seam is injectable, the default matches the published contract, and the
 * defect is recorded rather than silently half-fixed.**
 */

import { monotonicMs } from "../util/clock.ts";
import { failed, never, ok, type Region } from "./model.ts";
import { readDockerContainers, type DockerPsRun } from "./read/docker.ts";
import { readRuns, type PartialRunRow } from "./read/runs.ts";
import { refreshWorkerRow, type WorkerRead } from "./read/worker.ts";
import { runIdsAscending, runPaths, runsRoot } from "../run/paths.ts";

// ---------------------------------------------------------------------------
// The periods
// ---------------------------------------------------------------------------

/**
 * 500 ms. Matches the supervisor's own transcript poll (`tui.ts:237`), so the
 * pane is never staler than the process it is watching about facts that
 * process already refreshes at that rate. Everything on this clock is a
 * handful of small per-worker reads for workers already known to be live.
 */
export const FAST_PERIOD_MS = 500;

/**
 * 5 s. The incumbent's interval, kept deliberately: nothing this pane replaces
 * may get SLOWER than what it replaces, and a regression against a pane an
 * operator already trusts is a harder sell than any new column is worth.
 */
export const MEDIUM_PERIOD_MS = 5_000;

/**
 * 30 s. The only period on which a 1777 ms O(runs-on-disk) walk is a 6% duty
 * cycle. §6.3 accepts the consequence explicitly — a run that ends is claimed
 * live for up to half a minute (§9 Q6 holds whether that matters) — while
 * making a run that APPEARS a 5 s event through the cheap name-set watcher
 * this module implements as {@link SourcePromotion}.
 */
export const SLOW_PERIOD_MS = 30_000;

export type ClockName = "fast" | "medium" | "slow";

/**
 * Ordered fast-to-slow. The order is load-bearing in exactly one place — the
 * tick dispatches in this order so that when all three come due on the same
 * instant (every 60 s, since 500 divides 5000 divides 30000) the cheap reads
 * are issued before the expensive one rather than behind it.
 */
export const CLOCK_NAMES: readonly ClockName[] = Object.freeze([
  "fast",
  "medium",
  "slow",
] as const);

export const CLOCK_PERIOD_MS: Readonly<Record<ClockName, number>> = Object.freeze({
  fast: FAST_PERIOD_MS,
  medium: MEDIUM_PERIOD_MS,
  slow: SLOW_PERIOD_MS,
});

/**
 * The measurements this file's whole structure rests on, in one place so that
 * a source declaring a cost cites the measurement rather than retyping a
 * number that then drifts from it (§9 Q5, §2.6, all 2026-09-02, this host).
 *
 * The 500-run figures are the ones sources should declare: a period has to
 * survive the fleet's worst measured size, not its convenient one.
 */
export const MEASURED_MS = Object.freeze({
  /** `liveRunIds` across 80 real run directories. */
  LIVE_RUN_IDS_80: 331,
  /** `liveRunIds` across 500 synthetic run directories. Linear, ~3.6-4.1 ms/run. */
  LIVE_RUN_IDS_500: 1777,
  /** `runIdsAscending` at 80 runs. */
  RUN_IDS_ASCENDING_80: 3,
  /** `runIdsAscending` at 500 runs — 0.5% of the walk above. */
  RUN_IDS_ASCENDING_500: 9,
  /** `docker ps` returning nine containers. */
  DOCKER_PS: 37,
  /** `docker stats --no-stream` — 55× `docker ps`, which is why D7 refuses it. */
  DOCKER_STATS_NO_STREAM: 2042,
  /**
   * `readGit` — both `status --short --branch` and `log --oneline -10` on this
   * repository, spawned concurrently. n=12, min 33 / median 36 / max 40.
   *
   * Measured on a WARM repository, and the number is honest only for one. A
   * `status` on a cold index, a tree on a network mount, or a repository
   * mid-`gc` is unbounded. That cost left this scheduler entirely on
   * 2026-09-04 with the git strip.
   * rather than trusting this figure to hold. The duty-cycle guard plans for
   * the measured cost; the timeout is what plans for its absence.
   */
  /**
   * `refreshWorkerRow` PER WORKER — `state.json` only, satellites carried.
   * n=30 over 6 live workers: 0.73 ms total, 0.122 ms each. The full
   * three-file `readWorkerRow` is 0.35 ms each, which is why the fast path
   * reads one file.
   *
   * **SUPERSEDED as the fast source's input by {@link REFRESH_WORKER_ROW}, and
   * kept because it is the baseline that number is a delta against.** The fast
   * refresh now also re-reads `fence.json`, which §6.3 puts on this clock and
   * which the row could not carry until `WorkerRow.fence` existed.
   */
  REFRESH_WORKER_STATE: 0.122,
  /**
   * `readWorkerLaunch` PER WORKER — the read `WorkerRow.via` added.
   *
   * Measured 2026-09-02 on the operator's own runs root: 101 worker
   * directories under 98 runs, median of 5 reps after a warm pass, 11.98 ms
   * total. Declared here rather than left in a docblock because the duty-cycle
   * guard is the thing that decides whether a read may sit on a clock, and a
   * number it cannot see is a number that stops constraining anything.
   *
   * It is NOT on any clock's critical path: the record is immutable after `up`,
   * so this cost is paid once per worker by the 30 s walk (0.119 ms x 101 =
   * 12 ms, 0.04% of the slow period) and never by the fast one.
   */
  READ_WORKER_LAUNCH: 0.119,
  /**
   * `fence.json` PER WORKER — one `stat`, then a read only when it exists.
   *
   * Measured the same way: 3.26 ms across 101 worker directories, of which 15
   * actually hold a fence. §2.3 predicted this shape from two live workers
   * ("neither has `fence.json`") and the whole disk agrees — 85% of the calls
   * are a `stat` that returns ENOENT and stop.
   */
  READ_WORKER_FENCE: 0.032,
  /**
   * `refreshWorkerRow` PER WORKER as it now stands — `state.json` + `fence.json`.
   *
   * 13.94 ms across 101 workers, i.e. {@link REFRESH_WORKER_STATE} plus
   * {@link READ_WORKER_FENCE} with the two measured together rather than
   * summed on paper. The full five-file `readWorkerRow` is 0.412 ms each, which
   * is still why the fast path does not run it.
   */
  REFRESH_WORKER_ROW: 0.138,
  /**
   * The fast source's declared cost, at an ASSUMED 100 live workers.
   *
   * **This is the one number in this table that is an assumption rather than a
   * measurement, and it is stated as one.** Everything else declares the cost
   * at the fleet's worst measured size, which for the run walk is 500. The same
   * rule applied to workers gives 69 ms — 13.8% of the fast clock, OVER budget
   * — so the guard would refuse the placement §6.3 asks for, and §6.3's fast
   * per-worker refresh would have no clock it fits on.
   *
   * 100 is defensible where 500 is not: every live worker is a CONTAINER, and
   * 500 containers on one laptop is a different design problem than a monitor's
   * refresh rate. The arithmetic ceiling is 362 workers (500 ms x 10% / 0.138),
   * above which `FleetClocks` refuses at construction with the duty cycle in
   * the message. That refusal is asserted, so the assumption fails loudly
   * rather than degrading into a clock that never finishes a tick.
   *
   * **REVISED from 12.2 when `fence.json` joined the fast read**, which is the
   * point of declaring the cost rather than labelling the source cheap: adding
   * a per-worker read moved a number in a table that the constructor checks,
   * instead of moving nothing at all.
   */
  REFRESH_WORKERS_100: 13.8,
});

/**
 * The fraction of a clock's period one source may consume. See the header for
 * why this is 10% and what range of values would do the same job.
 */
export const MAX_DUTY_CYCLE = 0.1;

export function dutyCycle(measuredCostMs: number, clock: ClockName): number {
  return measuredCostMs / CLOCK_PERIOD_MS[clock];
}

/** Every clock on which a read of this measured cost is admissible. */
export function admissibleClocks(measuredCostMs: number): readonly ClockName[] {
  return CLOCK_NAMES.filter((c) => dutyCycle(measuredCostMs, c) <= MAX_DUTY_CYCLE);
}

/**
 * Refused at CONSTRUCTION, not at the first tick.
 *
 * A misplaced read that fails on tick one has already shipped: the pane starts
 * in a tmux split an operator is not watching, and the first frame it does not
 * paint looks exactly like a fleet with nothing in it. Failing when the source
 * map is built puts the error in front of whoever wrote the placement.
 *
 * The message names the admissible clocks rather than only the violation,
 * on `paths.ts:755-791`'s reasoning: a refusal an operator can act on beats a
 * correct complaint they cannot.
 */
export class ClockBudgetError extends Error {
  constructor(
    readonly sourceName: string,
    readonly clock: ClockName,
    readonly measuredCostMs: number,
  ) {
    const pct = (dutyCycle(measuredCostMs, clock) * 100).toFixed(1);
    const room = admissibleClocks(measuredCostMs);
    const remedy =
      room.length > 0
        ? `admissible clocks: ${room.join(", ")}`
        : "no clock admits this cost; the read needs to move off every clock (§2.5)";
    super(
      `source "${sourceName}" declares ${measuredCostMs} ms on the ${clock} clock ` +
        `(${CLOCK_PERIOD_MS[clock]} ms) — ${pct}% duty cycle, over the ` +
        `${(MAX_DUTY_CYCLE * 100).toFixed(0)}% budget; ${remedy}`,
    );
    this.name = "ClockBudgetError";
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Promotion: how a cheap read on a fast clock advances an expensive one.
 *
 * §6.3's mitigation for the 30 s appearance latency. A name-set `readdir` at
 * 9 ms runs on the medium clock; when the set changes, the slow clock is made
 * due immediately instead of at its next natural edge. A run that appears is
 * therefore a 5 s event while the walk that costs 1777 ms stays on 30 s.
 *
 * **`changed` is REQUIRED rather than defaulted, and that is the point.** The
 * obvious default — reference inequality — fires on every tick for any reader
 * that returns a fresh array, which is every reader here. A promotion that
 * always fires is not a mitigation, it is the expensive walk back on the
 * medium clock wearing a different name, and it would pass every test that did
 * not specifically look for it. Making the comparator unskippable means the
 * mistake cannot be made by omission.
 */
export interface SourcePromotion<T> {
  /** The clock to make due when the value changes. */
  readonly clock: ClockName;
  /**
   * Method syntax, not a property. Under `strictFunctionTypes` a property-typed
   * comparator would make `Source<string[]>` unassignable to `Source<unknown>`
   * and the whole source map untypeable; method parameters stay bivariant. The
   * looseness is contained — {@link SourceValue} recovers the precise type at
   * every site a caller actually reads a value.
   */
  changed(previous: T, next: T): boolean;
}

export interface Source<T> {
  readonly clock: ClockName;
  /**
   * The MEASURED cost of this read at the fleet's worst measured size — not a
   * timeout, not a pathological bound, not an estimate. See the header: a
   * bound declared here stops the budget describing anything, and the overrun
   * latch is what handles the pathological case.
   */
  readonly measuredCostMs: number;
  /**
   * Throws to signal failure. `Region` is applied by the scheduler and never
   * by the source, so there is exactly one place that decides what a failed
   * read looks like on screen (`model.ts:47-56`, ISC-478). Readers that
   * already return a `Region` — `readRuns`, `readDockerContainers` — go
   * through {@link unwrapRegion}.
   */
  read(): Promise<T>;
  readonly promote?: SourcePromotion<T>;
  /**
   * Another source ON THE SAME CLOCK that must finish before this one starts.
   *
   * Added because running the shipped wiring found the defect it prevents.
   * `runs` and `containers` are both on the slow clock and were dispatched
   * concurrently, so the run walk read the container set through its getter at
   * dispatch time — which is the PREVIOUS tick's answer, and on the first tick
   * is no answer at all. The visible cost was every worker rendering `container
   * not checked` for the first thirty seconds of every session, and thereafter
   * a `containerPresent` fact up to a full slow period older than the row
   * carrying it.
   *
   * Deliberately NOT a general dependency graph. One edge, same clock, no
   * transitivity, and a cycle is impossible because the edge is only honoured
   * within a single `#dispatch` pass — a source whose `after` names something
   * not running in this pass simply starts. A scheduler that could express
   * arbitrary DAGs would need cycle detection and a topological sort to buy
   * nothing this fleet has asked for.
   *
   * The cost is real and small: it serialises a 37 ms read ahead of a 1777 ms
   * one, so the slow clock's duty cycle goes from 5.9% to 6.0%. The budget
   * guard still checks each source independently, which is the honest thing to
   * do — chains are not billed as a unit, and if one ever grows long enough to
   * matter the guard will not catch it. Stated so that is a known limit rather
   * than a surprise.
   */
  readonly after?: string;
}

/** The value type of a source, recovered structurally. */
export type SourceValue<S> = S extends { read(): Promise<infer T> } ? T : never;

export type SourceMap = Readonly<Record<string, Source<unknown>>>;

/** One `Region` per source, which is the whole staleness model (§6.4). */
export type Snapshot<S extends SourceMap> = {
  readonly [K in keyof S]: Region<SourceValue<S[K]>>;
};

/**
 * Adapt a reader that already returns a `Region` into a source that throws.
 *
 * `readRuns` and `readDockerContainers` deliberately return `failed` rather
 * than throwing, because their callers include ones with no scheduler. Here
 * that region is converted to a throw and immediately back — which looks
 * wasteful and is not. The inner `readAt` came from the reader's own `now`,
 * and this module's ages are differences against the scheduler's `now`
 * (`model.ts:83`). Carrying the inner stamp would put two clocks in one
 * subtraction, which is the ISC-155 shape `util/clock.ts:14-18` names. One
 * stamping site, one clock.
 *
 * A `never` region reaching here is a reader that returned "I have not looked"
 * from a call that just looked; there is no honest region to publish for it,
 * so it becomes a failure naming the reader rather than a silent `ok`.
 */
export async function unwrapRegion<T>(region: Promise<Region<T>>): Promise<T> {
  const r = await region;
  if (r.status === "ok") return r.value;
  if (r.status === "failed") throw new Error(r.reason);
  throw new Error("reader returned no result");
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/** What one tick did. Returned so a probe can assert behaviour, not timing. */
export interface TickReport {
  /** The `now()` this tick's due-ness was decided against. */
  readonly at: number;
  /** Clocks that fired on their own period. */
  readonly fired: readonly ClockName[];
  /** Clocks additionally fired because a cheap source's value changed. */
  readonly promoted: readonly ClockName[];
  /** Sources whose clock fired but which were still reading from earlier. */
  readonly skippedInFlight: readonly string[];
}

export interface FleetClocksOptions {
  /**
   * The single time source for BOTH due-ness and `readAt`. One seam rather
   * than two, so a test cannot accidentally advance one and not the other and
   * so the age arithmetic is a difference on one clock by construction.
   */
  readonly now?: () => number;
}

/**
 * MONOTONIC. Owner decision, 2026-09-02.
 *
 * This clock is the single source for BOTH due-ness and `readAt`, and both uses
 * are differences taken inside this process — which is exactly what
 * `util/clock.ts` reserves the monotonic clock for, and what it says wall clock
 * must not be used for (ISC-155). A standing monitor is the thing that sits
 * through an NTP step and a laptop suspend: with `Date.now` here, a lid closed
 * for two hours makes every region report a two-hour staleness on the first
 * frame after waking, and makes every clock fire on that frame because its
 * period appears to have elapsed many times over.
 *
 * The wall clock has not disappeared — it moved to where its other operand
 * lives. `transcriptAgeMs` and the activity ladder compare against ISO stamps
 * written by the SUPERVISOR, and those take `Date.now` through their own named
 * seam. See `model.ts`'s two-clocks note.
 */
export const nowDefault: () => number = monotonicMs;

/**
 * The three clocks and the regions they produce.
 *
 * Driven by {@link FleetClocks.tick}, which takes no time argument on purpose:
 * every reading of the clock inside a tick comes from the injected `now`, so
 * the stamp taken AFTER a read settles is genuinely a later reading and not
 * the tick's entry time under another name. A `tick(now: number)` signature
 * would make the ISC-477 defect unrepresentable in the test and perfectly
 * representable in production.
 *
 * There is no `setInterval` in this class. {@link driveClocks} owns the timer,
 * and it too takes its timer functions as parameters — so the entire block of
 * criteria is reachable with no real elapsed time anywhere (ISC-491).
 */
export class FleetClocks<S extends SourceMap> {
  readonly #sources: S;
  readonly #now: () => number;
  readonly #regions = new Map<string, Region<unknown>>();
  readonly #lastFiredAt = new Map<ClockName, number>();
  readonly #firedCount = new Map<ClockName, number>();
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(sources: S, opts?: FleetClocksOptions) {
    const seen: string[] = [];
    for (const [name, source] of Object.entries(sources)) {
      if (dutyCycle(source.measuredCostMs, source.clock) > MAX_DUTY_CYCLE) {
        throw new ClockBudgetError(name, source.clock, source.measuredCostMs);
      }
      /*
       * `after` is validated HERE rather than left to no-op at dispatch, and the
       * reason is that all three ways of getting it wrong fail silently and
       * identically: the edge is simply not honoured, the run walk reads a
       * stale container set, and every worker renders a `containerPresent` one
       * tick old with nothing anywhere reporting a problem. That is the same
       * class of defect as the dispatch bug the edge was added to fix, so it
       * would be a poor trade to fix one by introducing the other.
       *
       * DECLARATION ORDER is load-bearing — `#dispatch` can only wait on a job
       * it has already started — which is exactly the kind of implicit coupling
       * that should be a loud error and never a convention.
       */
      if (source.after !== undefined) {
        const target = sources[source.after];
        if (target === undefined) {
          throw new Error(`clock source "${name}" declares after: "${source.after}", which is not a source`);
        }
        if (target.clock !== source.clock) {
          throw new Error(
            `clock source "${name}" (${source.clock}) declares after: "${source.after}" ` +
              `(${target.clock}) — an ordering edge only holds within one clock's dispatch pass`,
          );
        }
        if (!seen.includes(source.after)) {
          throw new Error(
            `clock source "${name}" declares after: "${source.after}", which is declared LATER. ` +
              `The dispatch pass can only wait on a job it has already started, so a forward ` +
              `edge would silently not be honoured — reorder the declarations`,
          );
        }
      }
      seen.push(name);
    }
    this.#sources = sources;
    this.#now = opts?.now ?? nowDefault;
  }

  /**
   * Every source's region, as a fresh frozen object.
   *
   * A source that has never completed a read is `never` and NOT `ok` with an
   * empty value: "I could not look" and "I looked and there was nothing" are
   * different facts and only one of them names a broken monitor (`model.ts:58-66`,
   * ISC-479). The distinction survives here because absence from `#regions` is
   * the only representation of "never", and nothing seeds that map.
   */
  snapshot(): Snapshot<S> {
    const out: Record<string, Region<unknown>> = {};
    for (const name of Object.keys(this.#sources)) {
      out[name] = this.#regions.get(name) ?? never<unknown>();
    }
    return Object.freeze(out) as Snapshot<S>;
  }

  /** How many times a clock has fired, natural edges and promotions alike. */
  fired(clock: ClockName): number {
    return this.#firedCount.get(clock) ?? 0;
  }

  /** Sources currently reading. Non-zero here is what the overrun latch skips. */
  pending(): readonly string[] {
    return [...this.#inFlight.keys()].sort();
  }

  /** Resolves when every read now in flight has settled, including earlier ticks'. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight.values()]);
    }
  }

  /**
   * Fire whichever clocks are due and await the reads THIS tick dispatched.
   *
   * Reads dispatched by an earlier tick and still running are deliberately not
   * awaited: a 1777 ms walk must not stall the 500 ms clock behind it, which
   * is the failure that would make three clocks behave as one slow one. Use
   * {@link idle} when a test needs the earlier read's region.
   *
   * Never rejects. A throwing reader is the ordinary case this whole design is
   * built around (§6.4), and a tick that propagated it would take down the
   * frame that was supposed to display it.
   */
  async tick(): Promise<TickReport> {
    const at = this.#now();
    const due: ClockName[] = [];
    for (const clock of CLOCK_NAMES) {
      const last = this.#lastFiredAt.get(clock);
      if (last === undefined || at - last >= CLOCK_PERIOD_MS[clock]) due.push(clock);
    }
    const skipped: string[] = [];
    this.#markFired(due, at);
    const promoted = await this.#dispatch(due, skipped);

    /**
     * `filter` and not `promoted` itself. A clock already fired on its own
     * edge this tick must not be fired AGAIN because a cheap source also asked
     * for it — that is a second 1777 ms walk in one tick, for a fact the first
     * walk in the same tick already has. This is the falsifiable half of the
     * no-cascade rule and it has a test.
     *
     * **The unfalsifiable half is stated rather than tested, because a test
     * for it would be vacuous.** A promoted source that itself promotes cannot
     * chain here: 500 divides 5000 divides 30000, so any clock the promoted
     * round could name is already due on the tick that promoted it, and the
     * `filter` above empties. The structural guarantee is that this second
     * `#dispatch`'s return value is DISCARDED — one hop, by construction. A
     * flag saying the same thing would be a parameter no test could
     * distinguish, which is the dead-field shape `paths.ts:528-541` records.
     */
    const extra = promoted.filter((c) => !due.includes(c));
    if (extra.length > 0) {
      /**
       * A promotion ADVANCES the slow clock; it does not add a tick beside it.
       * Marking it fired resets its period, so a run appearing at t=5s moves
       * the next natural walk to t=35s rather than leaving one queued at t=30s
       * to repeat work finished 25 seconds earlier.
       */
      this.#markFired(extra, at);
      await this.#dispatch(extra, skipped);
    }

    return {
      at,
      fired: Object.freeze([...due]),
      promoted: Object.freeze([...extra]),
      skippedInFlight: Object.freeze([...skipped]),
    };
  }

  #markFired(clocks: readonly ClockName[], at: number): void {
    for (const clock of clocks) {
      /**
       * The DISPATCH time, not the completion time. Anchoring on completion
       * makes every period as long as its own read — a 30 s clock carrying a
       * 1777 ms walk would fire every 31.8 s and drift further as the fleet
       * grows, so the stated period would quietly stop being the period.
       */
      this.#lastFiredAt.set(clock, at);
      this.#firedCount.set(clock, (this.#firedCount.get(clock) ?? 0) + 1);
    }
  }

  async #dispatch(
    clocks: readonly ClockName[],
    skipped: string[],
  ): Promise<readonly ClockName[]> {
    const promotions: ClockName[] = [];
    const jobs: Promise<void>[] = [];
    /**
     * Jobs started in THIS pass, by name, so an `after` edge can wait on one.
     * Not `#inFlight`: that map also holds jobs from an earlier tick that
     * overran, and waiting on one of those would make a source's start depend
     * on a read the previous tick has not finished — which is the pile-up the
     * overrun latch exists to prevent, arriving through the back door.
     */
    const startedHere = new Map<string, Promise<void>>();

    for (const clock of CLOCK_NAMES) {
      if (!clocks.includes(clock)) continue;
      for (const [name, source] of Object.entries(this.#sources)) {
        if (source.clock !== clock) continue;
        if (this.#inFlight.has(name)) {
          // The overrun latch. See the header: skipped, never queued.
          skipped.push(name);
          continue;
        }
        const dependency = source.after === undefined ? undefined : startedHere.get(source.after);
        const job =
          dependency === undefined
            ? this.#readOne(name, source, promotions)
            : // `.then` and not `await`: the loop must keep dispatching, or a
              // chained source would serialise every source declared after it.
              dependency.then(() => this.#readOne(name, source, promotions));
        this.#inFlight.set(name, job);
        startedHere.set(name, job);
        jobs.push(job);
      }
    }

    await Promise.all(jobs);
    return promotions;
  }

  async #readOne(
    name: string,
    source: Source<unknown>,
    promotions: ClockName[],
  ): Promise<void> {
    const previous = this.#regions.get(name);
    try {
      const value = await source.read();
      /**
       * Read AFTER the await and not before it. This single line is ISC-477:
       * on the 1777 ms walk, stamping at dispatch reports a reading as most of
       * two seconds fresher than it is, and a renderer computing the age at
       * paint time reports every reading as current (`model.ts:44`).
       */
      this.#regions.set(name, ok(value, this.#now()));

      if (
        source.promote !== undefined &&
        previous !== undefined &&
        previous.status === "ok" &&
        source.promote.changed(previous.value, value)
      ) {
        promotions.push(source.promote.clock);
      }
    } catch (err) {
      /**
       * The failure REPLACES the region; the previous value is dropped here and
       * is unreachable from anywhere in this class (ISC-478). That is the
       * criterion and it is also the only interesting decision in this method:
       * retaining the last good value beside a marker is the design that
       * produces a confident wrong number on an operator's screen, and §4.3
       * holds that a viewer which lies is worse than one that admits it cannot
       * see. There is no `lastGood` field to add later without changing this
       * class's shape, which is deliberate.
       */
      this.#regions.set(name, failed(message(err), this.#now()));
    } finally {
      this.#inFlight.delete(name);
    }
  }
}

/**
 * Promotion only from an `ok` baseline, stated here because the alternative is
 * defensible and was rejected for a reason.
 *
 * Recovering from `failed` to `ok` means the watcher was blind for a while, so
 * there is no previous name set to compare against. Promoting anyway fires the
 * walk on every recovery whether or not anything appeared; not promoting means
 * an appearance during the blind window waits for the natural 30 s edge. The
 * second is chosen because the first makes a flapping reader into a load
 * generator against the most expensive read in the design, and the cost of the
 * second is bounded by the slow period that already governs disappearance.
 */

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * The timer functions, injected. Defaulted to the globals, so production wires
 * nothing, and overridden in tests, so no criterion in this file's block waits
 * on real elapsed time (ISC-491).
 */
export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: IntervalTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface ClockDriver {
  stop(): void;
}

/**
 * Drive the clocks from one timer at the fast period.
 *
 * One timer rather than three: 500 divides 5000 divides 30000, so a single
 * edge can decide all three, and three independent `setInterval`s would drift
 * apart and eventually interleave a medium tick between a slow tick's dispatch
 * and its completion for no benefit. The tick itself decides due-ness from
 * `now()`, so a missed or coalesced timer edge — which is what a laptop lid
 * produces — costs at most one late tick rather than a lost one.
 *
 * The tick is NOT awaited before the next edge is allowed to arrive. The
 * per-source in-flight latch is what prevents pile-up, and it prevents it per
 * source: a slow `docker ps` must not stop the fast clock re-reading a
 * `state.json`, which is the whole reason there are three clocks.
 */
export function driveClocks(
  clocks: { tick(): Promise<TickReport> },
  opts?: {
    readonly timers?: IntervalTimers;
    readonly periodMs?: number;
    readonly onError?: (err: unknown) => void;
  },
): ClockDriver {
  const timers = opts?.timers ?? realTimers;
  const period = opts?.periodMs ?? FAST_PERIOD_MS;
  const onError = opts?.onError;
  const handle = timers.setInterval(() => {
    /**
     * `tick` is documented not to reject, so this `catch` is for the case that
     * documentation is wrong. An unhandled rejection from a timer callback
     * takes the process down, and the process is a pane an operator is
     * watching — it would vanish at exactly the moment it had something to say.
     */
    void clocks.tick().catch((err: unknown) => onError?.(err));
  }, period);
  return {
    stop: () => timers.clearInterval(handle),
  };
}

// ---------------------------------------------------------------------------
// The fleet's actual sources
// ---------------------------------------------------------------------------

export interface FleetSourceOptions {
  /** Runs root. Defaults to `runsRoot()` so a fixture directory is one string. */
  readonly root?: string;
  /** The `docker ps` spawn seam (`read/docker.ts:200`). Injected in tests. */
  readonly dockerRun?: DockerPsRun;
  /**
   * The last slow container set, for the `containerPresent` join. A getter and
   * not a value: the container set comes from a REGION on the same scheduler,
   * so passing it by value would freeze the first tick's answer forever. The
   * caller closes over `snapshot()` — see {@link containerNameSet}.
   */
  readonly containers?: () => ReadonlySet<string> | null;
  /**
   * The last walk's runs, for the fast per-worker refresh. A getter, on
   * {@link FleetSourceOptions.containers}' reasoning — the fleet this reads is
   * the one the SLOW clock last found, and a value would freeze it.
   */
  readonly knownRuns?: () => readonly PartialRunRow[];
}

/**
 * The three readers that exist today, on the clocks D4 and D7 assign them.
 *
 * **This function is where ISC-476 is a production fact rather than a test
 * fixture one.** A scheduler test can only prove that the guard refuses a
 * badly-placed source; it takes this literal, asserted by name, to prove that
 * the expensive walk in the shipped wiring is on the slow clock.
 *
 * **The fast clock has no source here, and that is a gap rather than a
 * design.** §6.3 puts per-worker `state.json` and `fence.json` re-reads for
 * ALREADY-KNOWN live workers on the 500 ms clock. `readWorkerRows`
 * (`read/worker.ts:243`) is the reader for it, but it needs a `RunPaths` and a
 * worker id list — which today only come out of `readRuns`, i.e. out of the
 * slow walk. Wiring it means carrying the last known live set between ticks,
 * and inventing that here would put a second definition of "which workers are
 * live" beside `registry.ts`'s — the ISC-231/ISC-345 shape. Named, not built.
 */
export function fleetSources(opts?: FleetSourceOptions) {
  const root = opts?.root ?? runsRoot();
  const containers = opts?.containers ?? (() => null);
  const knownRuns = opts?.knownRuns ?? ((): readonly PartialRunRow[] => []);

  return {
    /**
     * `slow` is D7 and NOT arithmetic: at 37 ms this would pass the guard on
     * the fast clock at 7.4%. The only thing holding it here is this literal
     * and the test that asserts it, which is why both say so.
     */
    containers: {
      clock: "slow",
      measuredCostMs: MEASURED_MS.DOCKER_PS,
      read: (): Promise<readonly string[]> =>
        unwrapRegion(
          readDockerContainers(opts?.dockerRun ? { run: opts.dockerRun } : undefined),
        ),
    },

    /**
     * The 1777 ms walk. `slow` is forced by the duty-cycle guard — 35.5% on
     * medium — so this placement is checked arithmetic, not a convention.
     */
    runs: {
      clock: "slow",
      measuredCostMs: MEASURED_MS.LIVE_RUN_IDS_500,
      /*
       * `containers` first. The walk reads the container set through the getter
       * at the moment it STARTS, so without this edge it gets the previous slow
       * tick's answer — 30 s old — and on the first tick gets `null`, which
       * renders `container not checked` on every worker for the first half
       * minute of every session. 37 ms of serialisation buys a `containerPresent`
       * that is same-tick rather than a tick behind.
       */
      after: "containers",
      read: (): Promise<readonly PartialRunRow[]> =>
        unwrapRegion(readRuns({ root, containers: containers() })),
    },

    /**
     * §6.3's fast clock, and the gap the scheduler shipped without.
     *
     * It re-reads `state.json` for the workers THE LAST WALK FOUND — not a
     * second definition of which workers are live, which is what made this hard
     * to place. `registry.ts` owns that question, `readRuns` asks it, and this
     * source consumes the answer through a getter for the same reason
     * `containers` is a getter: passing a value would freeze the first tick's
     * fleet forever.
     *
     * A worker whose `state.json` has since vanished comes back `never` and the
     * row is dropped, so a fleet that shrank is correct within one fast tick.
     * A fleet that GREW is not visible here — that needs a walk, which the
     * medium `runNames` scan promotes within one 5 s period of any change. So
     * the enumeration lags by at most one medium period and the rows lag by at
     * most one fast period, which are different bounds and both stated.
     */
    workers: {
      clock: "fast",
      measuredCostMs: MEASURED_MS.REFRESH_WORKERS_100,
      read: (): Promise<readonly PartialRunRow[]> => refreshKnownWorkers(knownRuns(), {
        root,
        containers: containers(),
      }),
    },

    /**
     * §6.3's mitigation, and the reason it is affordable: 9 ms at 500 runs is
     * 0.5% of the walk it promotes. The name SET is compared, not the array —
     * `runIdsAscending` sorts, so an order change cannot occur today, and a
     * comparator that would call one an appearance if it ever did is a
     * comparator that fires the most expensive read in the design on a
     * `readdir` implementation detail.
     */
    runNames: {
      clock: "medium",
      measuredCostMs: MEASURED_MS.RUN_IDS_ASCENDING_500,
      read: (): Promise<readonly string[]> => runIdsAscending(root),
      promote: {
        clock: "slow",
        changed: nameSetChanged,
      },
    },
  } as const satisfies SourceMap;
}

/**
 * Re-read `state.json` for every worker in a known set (§6.3, the fast clock).
 *
 * Exported so the fast source has a testable subject, and written as a pure
 * function of the previous rows so it can be driven from a literal.
 *
 * A worker region that was not `ok` on the last walk is CARRIED FORWARD
 * UNCHANGED rather than retried. Retrying it here would make the fast clock's
 * cost depend on how many workers are broken — the failure mode where a fleet
 * with damaged state files becomes the one whose monitor polls hardest — and
 * the walk that produced the failure is the thing that should try again.
 */
export async function refreshKnownWorkers(
  previous: readonly PartialRunRow[],
  opts: { readonly root?: string; readonly containers: ReadonlySet<string> | null },
): Promise<readonly PartialRunRow[]> {
  const out: PartialRunRow[] = [];
  for (const run of previous) {
    const paths = runPaths(run.runId, opts.root);
    const workers: Region<WorkerRead>[] = [];
    for (const before of run.workers) {
      if (before.status !== "ok") {
        workers.push(before);
        continue;
      }
      const next = await refreshWorkerRow(paths, before.value.row.workerId, before.value.evidence, {
        containers: opts.containers,
      });
      // A worker that has gone is dropped, not carried: `never` here means the
      // directory is no longer there, and a stale row for a worker that ended
      // is the confident-stale-value failure `Region` exists to prevent.
      if (next.status === "never") continue;
      workers.push(next);
    }
    if (workers.length > 0) out.push({ ...run, workers });
  }
  return out;
}

/** Set inequality over two name lists. Order-insensitive, by the argument above. */
export function nameSetChanged(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length !== next.length) return true;
  const seen = new Set(previous);
  for (const name of next) if (!seen.has(name)) return true;
  return false;
}

/**
 * The container set for the `containerPresent` join, or `null`.
 *
 * `null` for every non-`ok` region, and the distinction is the one ISC-482
 * turns on: an empty SET means `docker ps` answered and listed nothing, so
 * every live worker's container really is gone; `null` means the question was
 * not answered. `read/docker.ts:230-245` refuses to return `ok([])` for an
 * unreachable daemon for exactly this reason, and collapsing the two here
 * would undo it one module downstream — the monitor inventing the single most
 * actionable finding in the design on no evidence.
 */
export function containerNameSet(region: Region<readonly string[]>): ReadonlySet<string> | null {
  return region.status === "ok" ? new Set(region.value) : null;
}

/** First line only. A region reason is one cell on a strip (`read/docker.ts:222-231`). */
function message(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}
