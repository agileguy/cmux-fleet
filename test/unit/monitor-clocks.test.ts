/**
 * The three clocks and the staleness model (ISC-476..ISC-479, ISC-491).
 *
 * ## Not one real timer, not one real wait
 *
 * Every test here drives `tick()` by hand against an injected `now`. That is
 * ISC-491 expressed as a harness rather than as an intention: a suite that
 * asserted a 30 s period by waiting 30 s would take longer than the rest of
 * this repository's unit tests combined, and — worse — would be the kind of
 * timing test that gets retried until it passes, which is the same as deleting
 * it (`test/unit/clock.test.ts:3-7` records exactly that reasoning for
 * `util/clock.ts`). The virtual clock also makes the ISC-477 defect
 * REPRESENTABLE: a read that advances time while it runs is one line here and
 * is otherwise unobservable.
 *
 * ## What each block is actually trying to falsify
 *
 * - **ISC-476** — that the 1777 ms walk sits on a 500 ms clock. Both halves of
 *   the probe are here: a call-count ratio over a simulated 60 s, and a
 *   construction-time refusal, because a ratio test only fails if someone
 *   wrote the bad placement into a fixture and the refusal fails no matter who
 *   writes it.
 * - **ISC-477** — that an age is taken at paint time. The killer test is the
 *   one where the read itself advances the clock: a scheduler stamping at
 *   dispatch and a scheduler stamping at completion are otherwise identical.
 * - **ISC-478** — that a failed refresh leaves the previous value on screen.
 *   Asserted structurally (the failed region has no `value` key) as well as
 *   behaviourally, because "the renderer happens not to read it" is not the
 *   same guarantee as "it is not there".
 * - **ISC-479** — that `never` and `ok([])` collapse. Three fixtures, not two:
 *   the third is a source that failed before it ever succeeded, which is the
 *   state a two-fixture test silently assumes away.
 *
 * ## Two mutants this suite does NOT kill, named rather than left to be found
 *
 * Mutation-verified across 38 mutants in two rounds; the first round killed
 * everything, which is the signature of a battery written to match the tests,
 * so a second round was written to attack the places most likely unwatched.
 * Two survivors are accepted deliberately:
 *
 * - **`idle()`'s drain loop degraded to a single drain survives.** The loop
 *   only matters when a caller interleaves `idle()` with `tick()`, and a test
 *   for that has to release two gated reads in an order that deadlocks the
 *   CORRECT implementation while passing the mutant. A test that fragile is
 *   worth less than this sentence. `idle()` is a diagnostic helper; nothing in
 *   the pane's own path calls it.
 * - **Corrupting an unused entry of `MEASURED_MS` survives.** `LIVE_RUN_IDS_80`
 *   is a recorded measurement no code branches on. The only test that could
 *   kill it would assert a literal against the same literal, which is the
 *   tautology this repository's criteria call out elsewhere. The measurement's
 *   real check is §9 Q5, not this file.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { regionAgeMs, type Region } from "../../src/monitor/model.ts";
import {
  admissibleClocks,
  ClockBudgetError,
  CLOCK_PERIOD_MS,
  containerNameSet,
  driveClocks,
  dutyCycle,
  FAST_PERIOD_MS,
  FleetClocks,
  fleetSources,
  MAX_DUTY_CYCLE,
  MEASURED_MS,
  MEDIUM_PERIOD_MS,
  nameSetChanged,
  nowDefault,
  realTimers,
  SLOW_PERIOD_MS,
  unwrapRegion,
  type ClockName,
  type IntervalTimers,
  type Source,
} from "../../src/monitor/clocks.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A clock a test moves by hand. Nothing in this file reads real time. */
function virtualClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

/**
 * A source with a call counter, which is ISC-476's probe verbatim:
 * "instrument the readers with a counter and assert the ratio".
 */
function counting<T>(
  clock: ClockName,
  measuredCostMs: number,
  produce: (call: number) => T | Promise<T>,
): { source: Source<T>; calls: () => number } {
  let calls = 0;
  return {
    source: {
      clock,
      measuredCostMs,
      read: async () => {
        calls += 1;
        return produce(calls);
      },
    },
    calls: () => calls,
  };
}

/** A cheap no-op source, for tests that only care about clock edges. */
function trivial(clock: ClockName) {
  return counting(clock, 1, () => "v");
}

/**
 * Drain the microtask queue.
 *
 * Needed where a test inspects state produced by promises it deliberately does
 * not await — a hanging reader's siblings, or a rejection routed to `onError`.
 * A bounded loop of `await Promise.resolve()` and NOT a `setTimeout`: every
 * chain here is a fixed handful of microtask hops, so this is deterministic,
 * whereas a zero-millisecond timer would make the assertion depend on the
 * event loop's mood. Twenty is an order of magnitude more hops than any chain
 * in this file needs.
 */
async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// ISC-476 — the three periods, and the expensive walk on none but the slow one
// ---------------------------------------------------------------------------

describe("ISC-476: three clocks fire at their own periods", () => {
  /**
   * The ratio half of the probe, over a simulated 60 s driven at the fast
   * period. The expected counts are arithmetic on the stated periods rather
   * than recorded output: 60 s / 500 ms inclusive of both edges is 121 fast
   * ticks, and 500 divides 5000 divides 30000, so every medium and slow edge
   * lands on a fast one.
   */
  test("fires 121 / 13 / 3 times over a simulated 60 s", async () => {
    const clock = virtualClock(0);
    const fast = counting("fast", 5, () => "f");
    const medium = counting("medium", MEASURED_MS.RUN_IDS_ASCENDING_500, () => "m");
    const slow = counting("slow", MEASURED_MS.LIVE_RUN_IDS_500, () => "s");

    const clocks = new FleetClocks(
      { fast: fast.source, medium: medium.source, slow: slow.source },
      { now: clock.now },
    );

    for (let t = 0; t <= 60_000; t += FAST_PERIOD_MS) {
      clock.set(t);
      await clocks.tick();
    }

    expect(fast.calls()).toBe(121);
    expect(medium.calls()).toBe(13);
    expect(slow.calls()).toBe(3);

    // The clock counters and the reader counters must agree; a clock that
    // fires without dispatching is the same defect from the other side.
    expect(clocks.fired("fast")).toBe(121);
    expect(clocks.fired("medium")).toBe(13);
    expect(clocks.fired("slow")).toBe(3);
  });

  test("a clock does not fire one millisecond early", async () => {
    const clock = virtualClock(0);
    const medium = trivial("medium");
    const clocks = new FleetClocks({ medium: medium.source }, { now: clock.now });

    await clocks.tick(); // t=0, first tick always fires
    clock.set(MEDIUM_PERIOD_MS - 1);
    await clocks.tick();
    expect(medium.calls()).toBe(1);

    clock.set(MEDIUM_PERIOD_MS);
    await clocks.tick();
    expect(medium.calls()).toBe(2);
  });

  /**
   * The construction half. This is the assertion that does not depend on
   * anyone writing the bad placement into a fixture: the measured cost of the
   * walk cannot be admitted by the fast or medium clock at all.
   */
  test("liveRunIds on the fast clock is refused at construction", () => {
    const build = (clock: ClockName) =>
      new FleetClocks({
        runs: {
          clock,
          measuredCostMs: MEASURED_MS.LIVE_RUN_IDS_500,
          read: async () => [],
        },
      });

    expect(() => build("fast")).toThrow(ClockBudgetError);
    expect(() => build("medium")).toThrow(ClockBudgetError);
    expect(() => build("slow")).not.toThrow();
  });

  test("the refusal names the source, the duty cycle and the clock that would take it", () => {
    let caught: unknown;
    try {
      new FleetClocks({
        runs: { clock: "fast", measuredCostMs: MEASURED_MS.LIVE_RUN_IDS_500, read: async () => [] },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClockBudgetError);
    const msg = (caught as Error).message;
    expect(msg).toContain("runs");
    expect(msg).toContain("1777");
    expect(msg).toContain("fast");
    expect(msg).toContain("355.4%");
    expect(msg).toContain("admissible clocks: slow");
  });

  /** The measured basis, asserted so the periods and the numbers cannot drift apart. */
  test("the duty cycle arithmetic admits only the slow clock for the walk", () => {
    expect(dutyCycle(MEASURED_MS.LIVE_RUN_IDS_500, "slow")).toBeCloseTo(0.0592, 4);
    expect(dutyCycle(MEASURED_MS.LIVE_RUN_IDS_500, "medium")).toBeCloseTo(0.3554, 4);
    expect(admissibleClocks(MEASURED_MS.LIVE_RUN_IDS_500)).toEqual(["slow"]);
    expect(admissibleClocks(MEASURED_MS.RUN_IDS_ASCENDING_500)).toEqual([
      "fast",
      "medium",
      "slow",
    ]);
    expect(MAX_DUTY_CYCLE).toBeGreaterThan(dutyCycle(MEASURED_MS.LIVE_RUN_IDS_500, "slow"));
    expect(MAX_DUTY_CYCLE).toBeLessThan(dutyCycle(MEASURED_MS.LIVE_RUN_IDS_500, "medium"));
  });

  /**
   * The shipped wiring, not a fixture. Without this the criterion is satisfied
   * by a scheduler that refuses bad placements while the real one is placed
   * badly somewhere else.
   */
  test("fleetSources puts the walk and docker on slow, the name-set on medium", () => {
    const sources = fleetSources({ root: "/nonexistent-root-for-declaration-check" });
    expect(sources.runs.clock).toBe("slow");
    expect(sources.runs.measuredCostMs).toBe(MEASURED_MS.LIVE_RUN_IDS_500);
    expect(sources.containers.clock).toBe("slow");
    expect(sources.runNames.clock).toBe("medium");
    expect(sources.runNames.promote.clock).toBe("slow");
  });

  /**
   * The honest half of the guard's claim. `docker ps` at 37 ms would pass on
   * the FAST clock, so nothing in the arithmetic holds it on the slow one —
   * only D7, the literal in `fleetSources`, and the assertion above. This test
   * exists so that the module header's disclaimer is falsifiable rather than
   * decorative: if someone tightens the budget until docker is arithmetically
   * pinned, this fails and the header has to be rewritten.
   */
  test("the budget alone does NOT pin docker ps to the slow clock", () => {
    expect(admissibleClocks(MEASURED_MS.DOCKER_PS)).toContain("fast");
    expect(dutyCycle(MEASURED_MS.DOCKER_PS, "fast")).toBeCloseTo(0.074, 3);
  });

  /**
   * The overrun latch. A read still running when its clock comes round is
   * skipped, never queued — otherwise a saturated host accumulates dispatches
   * and the pane's memory grows with its lateness.
   */
  test("a slow read still in flight is skipped rather than re-dispatched", async () => {
    const clock = virtualClock(0);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const clocks = new FleetClocks(
      {
        slow: {
          clock: "slow" as const,
          measuredCostMs: MEASURED_MS.LIVE_RUN_IDS_500,
          read: async () => {
            calls += 1;
            await gate;
            return "walked";
          },
        },
      },
      { now: clock.now },
    );

    const first = clocks.tick(); // deliberately not awaited: it holds the gated read
    await Promise.resolve();
    expect(calls).toBe(1);

    clock.set(SLOW_PERIOD_MS);
    const second = await clocks.tick();
    expect(second.fired).toContain("slow");
    expect(second.skippedInFlight).toEqual(["slow"]);
    expect(calls).toBe(1);

    release?.();
    await first;
    await clocks.idle();
    expect(calls).toBe(1);
  });

  /**
   * The property that makes three clocks worth having: the fast clock keeps
   * ticking while the expensive walk is still running. A `tick` that awaited
   * every in-flight read would collapse all three into the slowest one, and
   * would do it without failing any per-clock period test.
   */
  test("the fast clock is not blocked behind an in-flight slow read", async () => {
    const clock = virtualClock(0);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fast = counting("fast", 5, () => "f");
    const clocks = new FleetClocks(
      {
        fast: fast.source,
        slow: {
          clock: "slow" as const,
          measuredCostMs: MEASURED_MS.LIVE_RUN_IDS_500,
          read: async () => {
            await gate;
            return "walked";
          },
        },
      },
      { now: clock.now },
    );

    const first = clocks.tick();
    await Promise.resolve();

    for (const t of [500, 1000, 1500]) {
      clock.set(t);
      await clocks.tick();
    }
    expect(fast.calls()).toBe(4);
    expect(clocks.pending()).toEqual(["slow"]);
    expect(clocks.snapshot().slow.status).toBe("never");

    release?.();
    await first;
    await clocks.idle();
    expect(clocks.snapshot().slow.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// §6.3's mitigation — appearance is a 5 s event, the walk stays on 30 s
// ---------------------------------------------------------------------------

describe("promotion: a cheap medium read advances the expensive slow one", () => {
  function rig(names: string[][]) {
    const clock = virtualClock(0);
    const slow = counting("slow", MEASURED_MS.LIVE_RUN_IDS_500, () => "walked");
    let call = 0;
    const clocks = new FleetClocks(
      {
        runNames: {
          clock: "medium" as const,
          measuredCostMs: MEASURED_MS.RUN_IDS_ASCENDING_500,
          read: async () => names[Math.min(call++, names.length - 1)] ?? [],
          promote: { clock: "slow" as const, changed: nameSetChanged },
        },
        slow: slow.source,
      },
      { now: clock.now },
    );
    return { clock, clocks, slow };
  }

  test("a changed name set fires the slow clock inside the medium tick", async () => {
    const { clock, clocks, slow } = rig([["r1"], ["r1", "r2"]]);
    await clocks.tick(); // t=0: everything fires naturally
    expect(slow.calls()).toBe(1);

    clock.set(MEDIUM_PERIOD_MS);
    const report = await clocks.tick();
    // The fast clock fires too — it has no source in this rig, and a clock
    // firing with nothing on it is reported honestly rather than hidden.
    expect(report.fired).toEqual(["fast", "medium"]);
    expect(report.promoted).toEqual(["slow"]);
    expect(slow.calls()).toBe(2);
  });

  test("an unchanged name set does not fire it", async () => {
    const { clock, clocks, slow } = rig([["r1"], ["r1"]]);
    await clocks.tick();
    clock.set(MEDIUM_PERIOD_MS);
    const report = await clocks.tick();
    expect(report.promoted).toEqual([]);
    expect(slow.calls()).toBe(1);
  });

  /**
   * The same fixture with reference equality instead of set equality would
   * promote here, because `read` returns a fresh array every call. That is the
   * always-fires default the `changed` comparator is mandatory to prevent, and
   * this is the test that would catch it.
   */
  test("a fresh array with the same members is not an appearance", async () => {
    const { clock, clocks, slow } = rig([["r1", "r2"], ["r2", "r1"]]);
    await clocks.tick();
    clock.set(MEDIUM_PERIOD_MS);
    await clocks.tick();
    expect(slow.calls()).toBe(1);
  });

  /**
   * Promotion ADVANCES the slow clock rather than adding a tick beside it. If
   * it did not reset the period, the natural edge at t=30 s would repeat a
   * walk finished 25 seconds earlier — 1777 ms of work for a fact already on
   * screen.
   */
  test("promotion resets the slow period rather than adding a tick", async () => {
    const { clock, clocks, slow } = rig([["r1"], ["r1", "r2"]]);
    await clocks.tick();
    clock.set(MEDIUM_PERIOD_MS);
    await clocks.tick();
    expect(slow.calls()).toBe(2);

    clock.set(SLOW_PERIOD_MS);
    await clocks.tick();
    expect(slow.calls()).toBe(2);

    clock.set(MEDIUM_PERIOD_MS + SLOW_PERIOD_MS);
    await clocks.tick();
    expect(slow.calls()).toBe(3);
  });

  test("no promotion without an ok baseline to compare against", async () => {
    const clock = virtualClock(0);
    const slow = counting("slow", MEASURED_MS.LIVE_RUN_IDS_500, () => "walked");
    let call = 0;
    const clocks = new FleetClocks(
      {
        runNames: {
          clock: "medium" as const,
          measuredCostMs: MEASURED_MS.RUN_IDS_ASCENDING_500,
          read: async () => {
            call += 1;
            if (call === 1) throw new Error("readdir refused");
            return ["r1"];
          },
          promote: { clock: "slow" as const, changed: nameSetChanged },
        },
        slow: slow.source,
      },
      { now: clock.now },
    );

    await clocks.tick(); // medium fails; slow fires naturally
    expect(clocks.snapshot().runNames.status).toBe("failed");
    expect(slow.calls()).toBe(1);

    clock.set(MEDIUM_PERIOD_MS);
    const report = await clocks.tick(); // medium recovers, but has no baseline
    expect(clocks.snapshot().runNames.status).toBe("ok");
    expect(report.promoted).toEqual([]);
    expect(slow.calls()).toBe(1);
  });

  /**
   * **A promotion for a clock that already fired on its own edge this tick is
   * dropped.** Without the filter, a tick on which the slow clock fires
   * naturally AND the name-set changes runs the 1777 ms walk twice, the second
   * time for a fact the first already has.
   *
   * A test for the *other* half of the no-cascade rule — a promoted source
   * whose own promotion chains further — is deliberately absent, because it
   * would be vacuous: 500 divides 5000 divides 30000, so any clock a promoted
   * round could name is already due on the tick that promoted it, and this
   * same filter empties. The rule is enforced by discarding the promoted
   * round's return value, and that is stated in the source rather than
   * asserted by a test that cannot fail.
   */
  test("a promotion does not double-fire a clock already due this tick", async () => {
    const clock = virtualClock(0);
    const slow = counting("slow", MEASURED_MS.LIVE_RUN_IDS_500, () => "walked");
    let call = 0;
    const names = [["r1"], ["r1", "r2"]];
    const clocks = new FleetClocks(
      {
        runNames: {
          clock: "medium" as const,
          measuredCostMs: MEASURED_MS.RUN_IDS_ASCENDING_500,
          read: async () => names[Math.min(call++, names.length - 1)] ?? [],
          promote: { clock: "slow" as const, changed: nameSetChanged },
        },
        slow: slow.source,
      },
      { now: clock.now },
    );

    await clocks.tick(); // t=0: everything fires; no baseline, so no promotion
    expect(slow.calls()).toBe(1);

    // t=30s: the slow clock is due on its OWN edge, and the name set has also
    // changed. One walk, not two.
    clock.set(SLOW_PERIOD_MS);
    const report = await clocks.tick();
    expect(report.fired).toContain("slow");
    expect(report.promoted).toEqual([]);
    expect(slow.calls()).toBe(2);
  });
});

describe("nameSetChanged", () => {
  test("is set equality, not reference or order equality", () => {
    expect(nameSetChanged(["a"], ["a"])).toBe(false);
    expect(nameSetChanged(["a", "b"], ["b", "a"])).toBe(false);
    expect(nameSetChanged(["a"], ["a", "b"])).toBe(true);
    expect(nameSetChanged(["a", "b"], ["a"])).toBe(true);
    expect(nameSetChanged(["a"], ["b"])).toBe(true);
    expect(nameSetChanged([], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISC-477 — the age is the read's success time, never the paint time
// ---------------------------------------------------------------------------

describe("ISC-477: age derives from when the read succeeded", () => {
  /**
   * The probe as written: freeze one source, let three frames pass, assert the
   * frozen region's age grows while the others do not. "Frozen" here is the
   * production case rather than a contrivance — a source on the slow clock is
   * exactly a source that does not refresh between fast frames.
   */
  test("a frozen region ages while a refreshing one does not", async () => {
    const clock = virtualClock(0);
    const clocks = new FleetClocks(
      { fast: trivial("fast").source, slow: trivial("slow").source },
      { now: clock.now },
    );

    await clocks.tick(); // t=0: both read
    for (const t of [500, 1000, 1500]) {
      clock.set(t);
      await clocks.tick();
      const snap = clocks.snapshot();
      expect(regionAgeMs(snap.fast, t)).toBe(0);
      expect(regionAgeMs(snap.slow, t)).toBe(t);
    }
  });

  /**
   * **The test that kills the dispatch-time implementation.** The read moves
   * the clock forward while it runs, exactly as the 1777 ms walk does. A
   * scheduler stamping `readAt` at dispatch reports 0 and therefore an age of
   * 1200 ms the instant the value lands; one stamping at completion reports
   * 1200 and an age of 0. Nothing else distinguishes the two.
   */
  test("readAt is taken after the read settles, not at dispatch", async () => {
    const clock = virtualClock(0);
    const clocks = new FleetClocks(
      {
        walk: {
          clock: "slow" as const,
          measuredCostMs: MEASURED_MS.LIVE_RUN_IDS_500,
          read: async () => {
            clock.advance(1200);
            return "walked";
          },
        },
      },
      { now: clock.now },
    );

    await clocks.tick();
    const region = clocks.snapshot().walk;
    expect(region.status).toBe("ok");
    if (region.status !== "ok") throw new Error("unreachable");
    expect(region.readAt).toBe(1200);
    expect(regionAgeMs(region, clock.now())).toBe(0);
  });

  /** A failed region carries the age of its FAILURE, since that is what is shown. */
  test("a failed region is stamped at the failure, not at the last success", async () => {
    const clock = virtualClock(0);
    let call = 0;
    const clocks = new FleetClocks(
      {
        s: {
          clock: "fast" as const,
          measuredCostMs: 1,
          read: async () => {
            call += 1;
            if (call === 1) return "good";
            clock.advance(40);
            throw new Error("state file truncated");
          },
        },
      },
      { now: clock.now },
    );

    await clocks.tick(); // ok at t=0
    clock.set(500);
    await clocks.tick(); // throws; the clock moves to 540 inside the read
    const region = clocks.snapshot().s;
    expect(region.status).toBe("failed");
    if (region.status !== "failed") throw new Error("unreachable");
    expect(region.readAt).toBe(540);
    expect(regionAgeMs(region, 1000)).toBe(460);
  });

  /** Age is a property of the model, not of a repaint: no tick, older region. */
  test("age grows with the clock without any frame being rendered", async () => {
    const clock = virtualClock(0);
    const clocks = new FleetClocks({ s: trivial("fast").source }, { now: clock.now });
    await clocks.tick();
    const region = clocks.snapshot().s;
    expect(regionAgeMs(region, 0)).toBe(0);
    expect(regionAgeMs(region, 7_000)).toBe(7_000);
    expect(regionAgeMs(region, 60_000)).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// ISC-478 — a failed refresh replaces the content, never sits beside it
// ---------------------------------------------------------------------------

describe("ISC-478: a failed refresh shows the reason in place of the content", () => {
  async function failAfterOneSuccess() {
    const clock = virtualClock(0);
    let call = 0;
    const clocks = new FleetClocks(
      {
        runs: {
          clock: "fast" as const,
          measuredCostMs: 1,
          read: async () => {
            call += 1;
            if (call === 1) return ["run-alpha", "run-beta"];
            throw new Error("unreadable run tree under /runs: state file truncated\nline two");
          },
        },
      },
      { now: clock.now },
    );
    await clocks.tick();
    const good = clocks.snapshot().runs;
    clock.set(500);
    await clocks.tick();
    return { clocks, good, bad: clocks.snapshot().runs };
  }

  test("the region becomes failed and carries the reason", async () => {
    const { good, bad } = await failAfterOneSuccess();
    expect(good.status).toBe("ok");
    expect(bad.status).toBe("failed");
    if (bad.status !== "failed") throw new Error("unreachable");
    expect(bad.reason).toContain("unreadable run tree");
    expect(bad.reason).toContain("state file truncated");
    // First line only — a region reason is one cell on a strip.
    expect(bad.reason).not.toContain("line two");
  });

  /**
   * The structural half. "The renderer happens not to read the stale value" is
   * a different guarantee from "the stale value is not there", and only the
   * second one survives a renderer written by someone else next week.
   */
  test("the stale value is not reachable through the failed region", async () => {
    const { bad } = await failAfterOneSuccess();
    expect(Object.keys(bad).sort()).toEqual(["readAt", "reason", "status"]);
    expect(JSON.stringify(bad)).not.toContain("run-alpha");
  });

  /**
   * And not reachable through the scheduler either. A `lastGood` accessor
   * added later would satisfy every behavioural assertion above while
   * reintroducing exactly the shape the criterion forbids.
   */
  test("the scheduler exposes no last-good accessor", async () => {
    const { clocks } = await failAfterOneSuccess();
    const names = [
      ...Object.getOwnPropertyNames(clocks),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(clocks)),
    ];
    const offenders = names.filter((n) => /last(?!Fired)|prev|stale|cache|retain/i.test(n));
    expect(offenders).toEqual([]);
  });

  test("a later success republishes ok with a fresh stamp", async () => {
    const clock = virtualClock(0);
    let call = 0;
    const clocks = new FleetClocks(
      {
        s: {
          clock: "fast" as const,
          measuredCostMs: 1,
          read: async () => {
            call += 1;
            if (call === 2) throw new Error("transient");
            return `v${call}`;
          },
        },
      },
      { now: clock.now },
    );
    await clocks.tick();
    clock.set(500);
    await clocks.tick();
    expect(clocks.snapshot().s.status).toBe("failed");
    clock.set(1000);
    await clocks.tick();
    const region = clocks.snapshot().s;
    expect(region.status).toBe("ok");
    if (region.status !== "ok") throw new Error("unreachable");
    expect(region.value).toBe("v3");
    expect(region.readAt).toBe(1000);
  });

  /**
   * A tick that propagated a reader's throw would take down the frame that was
   * supposed to display it — the monitor failing in exactly the way it exists
   * to report on.
   */
  test("tick never rejects, even when every source throws", async () => {
    const clock = virtualClock(0);
    const clocks = new FleetClocks(
      {
        a: {
          clock: "fast" as const,
          measuredCostMs: 1,
          read: async () => {
            throw new Error("boom");
          },
        },
        b: {
          clock: "medium" as const,
          measuredCostMs: 1,
          read: async () => {
            throw "a bare string, not an Error";
          },
        },
      },
      { now: clock.now },
    );
    const report = await clocks.tick();
    expect(report.fired).toEqual(["fast", "medium", "slow"]);
    const snap = clocks.snapshot();
    expect(snap.a.status).toBe("failed");
    expect(snap.b.status).toBe("failed");
    if (snap.b.status !== "failed") throw new Error("unreachable");
    expect(snap.b.reason).toContain("bare string");
  });

  test("one source failing does not disturb another's region", async () => {
    const clock = virtualClock(0);
    const clocks = new FleetClocks(
      {
        good: trivial("fast").source,
        bad: {
          clock: "fast" as const,
          measuredCostMs: 1,
          read: async () => {
            throw new Error("nope");
          },
        },
      },
      { now: clock.now },
    );
    await clocks.tick();
    const snap = clocks.snapshot();
    expect(snap.good.status).toBe("ok");
    expect(snap.bad.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// ISC-479 — never-succeeded is not the same as succeeded-and-empty
// ---------------------------------------------------------------------------

describe("ISC-479: never-read is distinct from read-and-empty", () => {
  /**
   * Three fixtures rather than the two the probe asks for. The third — a
   * source that failed before it ever succeeded — is the state a two-fixture
   * test assumes away, and it is the one that would otherwise be rendered as
   * `no data` and read as "nothing is running" rather than "the reader is
   * broken".
   */
  test("never / ok-empty / failed-first are three distinct regions", async () => {
    const clock = virtualClock(0);
    /**
     * `neverRead` HANGS rather than merely being un-ticked, because the
     * uninteresting way to reach `never` is "nobody called it yet" and the
     * interesting way is "it was called and has not come back". Only the
     * second one occurs on a running monitor, and only the second one is
     * simultaneous with its siblings' regions — which is what makes the three
     * outcomes comparable in a single snapshot rather than across fixtures.
     */
    const clocks = new FleetClocks(
      {
        neverRead: {
          clock: "fast" as const,
          measuredCostMs: 1,
          read: () => new Promise<string>(() => {}),
        },
        empty: counting("fast", 1, () => [] as string[]).source,
        brokenFromTheStart: {
          clock: "fast" as const,
          measuredCostMs: 1,
          read: async (): Promise<string[]> => {
            throw new Error("docker unavailable: Cannot connect to the Docker daemon");
          },
        },
      },
      { now: clock.now },
    );

    expect(clocks.snapshot().neverRead.status).toBe("never");

    clock.set(500);
    // Deliberately not awaited: this tick holds the hanging read forever.
    void clocks.tick();
    await flush();
    const snap = clocks.snapshot();

    expect(clocks.pending()).toEqual(["neverRead"]);
    expect(snap.neverRead.status).toBe("never");
    expect(snap.empty.status).toBe("ok");
    expect(snap.brokenFromTheStart.status).toBe("failed");

    const statuses = [snap.neverRead.status, snap.empty.status, snap.brokenFromTheStart.status];
    expect(new Set(statuses).size).toBe(3);

    // "I looked and found nothing" carries an age; "I could not look" does not.
    expect(regionAgeMs(snap.neverRead, 500)).toBeNull();
    expect(regionAgeMs(snap.empty, 500)).toBe(0);
    expect(regionAgeMs(snap.brokenFromTheStart, 500)).toBe(0);

    if (snap.empty.status !== "ok") throw new Error("unreachable");
    expect(snap.empty.value).toEqual([]);
  });

  test("a source is never until its own clock has fired, not until any clock has", async () => {
    const clock = virtualClock(0);
    const clocks = new FleetClocks(
      { fast: trivial("fast").source, slow: trivial("slow").source },
      { now: clock.now },
    );
    // Nothing has ticked: both never.
    expect(clocks.snapshot().fast.status).toBe("never");
    expect(clocks.snapshot().slow.status).toBe("never");
  });
});

// ---------------------------------------------------------------------------
// unwrapRegion — the adapter for readers that already speak Region
// ---------------------------------------------------------------------------

describe("unwrapRegion", () => {
  test("ok yields the value", async () => {
    await expect(unwrapRegion(Promise.resolve({ status: "ok", value: [1], readAt: 5 } as Region<number[]>))).resolves.toEqual([1]);
  });

  test("failed becomes a throw carrying the reason", async () => {
    const region: Region<number[]> = { status: "failed", reason: "docker unavailable: x", readAt: 5 };
    await expect(unwrapRegion(Promise.resolve(region))).rejects.toThrow("docker unavailable: x");
  });

  /** A reader returning `never` from a call that just looked has no honest region. */
  test("never becomes a throw rather than a silent ok", async () => {
    const region: Region<number[]> = { status: "never" };
    await expect(unwrapRegion(Promise.resolve(region))).rejects.toThrow("no result");
  });
});

// ---------------------------------------------------------------------------
// containerNameSet — the join that ISC-482 turns on
// ---------------------------------------------------------------------------

describe("containerNameSet", () => {
  test("an empty set and an unanswered question are different", () => {
    const answered = containerNameSet({ status: "ok", value: [], readAt: 1 });
    const unanswered = containerNameSet({ status: "failed", reason: "docker unavailable", readAt: 1 });
    const neverAsked = containerNameSet({ status: "never" });

    expect(answered).toBeInstanceOf(Set);
    expect(answered?.size).toBe(0);
    expect(unanswered).toBeNull();
    expect(neverAsked).toBeNull();
  });

  test("ok carries the names", () => {
    const set = containerNameSet({ status: "ok", value: ["a", "b"], readAt: 1 });
    expect(set?.has("a")).toBe(true);
    expect(set?.has("z")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The driver — a real timer seam, exercised with no real time (ISC-491)
// ---------------------------------------------------------------------------

describe("driveClocks", () => {
  function fakeTimers() {
    const registered: { fn: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];
    const timers: IntervalTimers = {
      setInterval: (fn, ms) => {
        registered.push({ fn, ms });
        return registered.length - 1;
      },
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    };
    return { timers, registered, cleared };
  }

  test("registers one timer at the fast period and ticks on each edge", async () => {
    const { timers, registered, cleared } = fakeTimers();
    let ticks = 0;
    const driver = driveClocks(
      {
        tick: async () => {
          ticks += 1;
          return { at: 0, fired: [], promoted: [], skippedInFlight: [] };
        },
      },
      { timers },
    );

    expect(registered).toHaveLength(1);
    expect(registered[0]?.ms).toBe(FAST_PERIOD_MS);

    registered[0]?.fn();
    registered[0]?.fn();
    await Promise.resolve();
    expect(ticks).toBe(2);

    driver.stop();
    expect(cleared).toEqual([0]);
  });

  /**
   * `tick` is documented not to reject; this covers the case that
   * documentation is wrong. An unhandled rejection from a timer callback kills
   * the process, and the process is a pane an operator is watching — it would
   * vanish at exactly the moment it had something to say.
   */
  test("a rejecting tick reaches onError instead of the process", async () => {
    const { timers, registered } = fakeTimers();
    const seen: unknown[] = [];
    driveClocks(
      { tick: async () => Promise.reject(new Error("scheduler bug")) },
      { timers, onError: (err) => seen.push(err) },
    );
    registered[0]?.fn();
    await flush();
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("scheduler bug");
  });
});

// ---------------------------------------------------------------------------
// The real readers on the real scheduler, with no fleet (ISC-491)
// ---------------------------------------------------------------------------

describe("fleetSources against a fixture root", () => {
  /**
   * No terminal, no container, no live fleet: an empty `mkdtemp` directory and
   * an injected `docker ps` spawn. This is the integration ISC-476's
   * declaration test cannot give — it proves the shipped sources actually run
   * on the scheduler rather than merely declaring plausible clocks.
   *
   * It also demonstrates ISC-479 against REAL readers: an empty runs root
   * yields `ok([])` — "I looked and there was nothing" — and never `never`.
   */
  test("one tick fills every region from an empty runs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "monitor-clocks-"));
    try {
      const clock = virtualClock(0);
      const sources = fleetSources({
        root,
        dockerRun: async () => ({
          code: 0,
          stdout: "pifleet-run1-w1\tUp 9 hours\npifleet-run1-w2\tUp 2 minutes\n",
          stderr: "",
        }),
      });
      const clocks = new FleetClocks(sources, { now: clock.now });

      const report = await clocks.tick();
      expect(report.fired).toEqual(["fast", "medium", "slow"]);

      const snap = clocks.snapshot();
      expect(snap.runs.status).toBe("ok");
      expect(snap.runNames.status).toBe("ok");
      expect(snap.containers.status).toBe("ok");

      if (snap.runs.status !== "ok") throw new Error("unreachable");
      expect(snap.runs.value).toEqual([]);
      if (snap.runNames.status !== "ok") throw new Error("unreachable");
      expect(snap.runNames.value).toEqual([]);
      if (snap.containers.status !== "ok") throw new Error("unreachable");
      expect([...snap.containers.value]).toEqual(["pifleet-run1-w1", "pifleet-run1-w2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** An unreachable daemon is a failed region, not an empty container set. */
  test("an unreachable docker daemon fails its region alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "monitor-clocks-"));
    try {
      const clock = virtualClock(0);
      const clocks = new FleetClocks(
        fleetSources({
          root,
          dockerRun: async () => ({
            code: 1,
            stdout: "",
            stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nIs the docker daemon running?",
          }),
        }),
        { now: clock.now },
      );
      await clocks.tick();
      const snap = clocks.snapshot();
      expect(snap.containers.status).toBe("failed");
      if (snap.containers.status !== "failed") throw new Error("unreachable");
      expect(snap.containers.reason).toContain("docker unavailable");
      expect(snap.runs.status).toBe("ok");
      expect(containerNameSet(snap.containers)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** The periods are the SRD's, not this test's. */
  test("the published periods are 500 / 5000 / 30000", () => {
    expect(CLOCK_PERIOD_MS).toEqual({ fast: 500, medium: 5_000, slow: 30_000 });
    expect(FAST_PERIOD_MS).toBe(500);
    expect(MEDIUM_PERIOD_MS).toBe(5_000);
    expect(SLOW_PERIOD_MS).toBe(30_000);
  });

  /**
   * The `containers` getter is a seam nothing else in this file exercises, and
   * a seam no test calls is a seam that quietly stops being called. This is
   * the wiring assertion only — that the join input reaches `readRuns` on
   * every tick rather than being sampled once — and NOT an assertion about
   * what `readRuns` does with it, which needs a worker fixture on disk and
   * belongs with `read/worker.ts`'s own suite.
   */
  test("the container cross-feed is read on every tick, not sampled once", async () => {
    const root = await mkdtemp(join(tmpdir(), "monitor-clocks-"));
    try {
      const clock = virtualClock(0);
      let reads = 0;
      const clocks = new FleetClocks(
        fleetSources({
          root,
          containers: () => {
            reads += 1;
            return new Set(["pifleet-run1-w1"]);
          },
          dockerRun: async () => ({ code: 0, stdout: "", stderr: "" }),
        }),
        { now: clock.now },
      );
      await clocks.tick();
      expect(reads).toBe(1);
      clock.set(SLOW_PERIOD_MS);
      await clocks.tick();
      expect(reads).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Properties the module's own comments claim, which would otherwise go untested
// ---------------------------------------------------------------------------

describe("claims the source text makes", () => {
  /**
   * `CLOCK_NAMES` is documented as ordered fast-to-slow because the dispatch
   * loop walks it: when all three come due on the same instant — every 60 s,
   * since the periods divide — the cheap reads are issued before the 1777 ms
   * one rather than behind it. A documented property with no test is the
   * comment this repo's style exists to avoid.
   */
  test("a coincident tick issues the cheap reads before the expensive one", async () => {
    const clock = virtualClock(0);
    const order: string[] = [];
    const mk = (clockName: ClockName, cost: number): Source<string> => ({
      clock: clockName,
      measuredCostMs: cost,
      read: async () => {
        order.push(clockName);
        return clockName;
      },
    });
    const clocks = new FleetClocks(
      {
        slow: mk("slow", MEASURED_MS.LIVE_RUN_IDS_500),
        fast: mk("fast", 5),
        medium: mk("medium", MEASURED_MS.RUN_IDS_ASCENDING_500),
      },
      { now: clock.now },
    );

    await clocks.tick();
    expect(order).toEqual(["fast", "medium", "slow"]);
  });

  /**
   * The budget is "may not EXCEED", so a source sitting exactly on it is
   * admitted. Both boundary comparisons are pinned, because a `>` silently
   * becoming a `>=` refuses a placement the header says is legal and the
   * failure appears at construction on someone else's fleet.
   */
  test("a source at exactly the budget is admitted, not refused", () => {
    const exactly = MAX_DUTY_CYCLE * FAST_PERIOD_MS; // 50 ms on the fast clock
    expect(() => {
      new FleetClocks({
        s: { clock: "fast" as const, measuredCostMs: exactly, read: async () => "v" },
      });
    }).not.toThrow();
    expect(admissibleClocks(exactly)).toContain("fast");
    expect(admissibleClocks(exactly + 1)).not.toContain("fast");
  });

  /**
   * A promotion that arrives while the walk it wants is ALREADY running must
   * not queue a second one, and must say that it did not. This is the overrun
   * latch on the promoted round rather than on a natural edge — the same
   * mechanism, reached by the other path — and it is the case a real fleet
   * produces: on a saturated host the 1777 ms walk is still going when the
   * 5 s name-set watcher notices a new run.
   */
  test("a promotion onto an in-flight walk is skipped and reported", async () => {
    const clock = virtualClock(0);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slowCalls = 0;
    let call = 0;
    const names = [["r1"], ["r1", "r2"]];
    const clocks = new FleetClocks(
      {
        runNames: {
          clock: "medium" as const,
          measuredCostMs: MEASURED_MS.RUN_IDS_ASCENDING_500,
          read: async () => names[Math.min(call++, names.length - 1)] ?? [],
          promote: { clock: "slow" as const, changed: nameSetChanged },
        },
        slow: {
          clock: "slow" as const,
          measuredCostMs: MEASURED_MS.LIVE_RUN_IDS_500,
          read: async () => {
            slowCalls += 1;
            await gate;
            return "walked";
          },
        },
      },
      { now: clock.now },
    );

    const first = clocks.tick(); // t=0: the walk starts and does not finish
    await flush();
    expect(slowCalls).toBe(1);

    clock.set(MEDIUM_PERIOD_MS);
    const report = await clocks.tick();
    expect(report.promoted).toEqual(["slow"]);
    expect(report.skippedInFlight).toEqual(["slow"]);
    expect(slowCalls).toBe(1);

    release?.();
    await first;
    await clocks.idle();
    expect(slowCalls).toBe(1);
  });

  /** Insertion order is not sort order; `pending()` promises the second. */
  test("pending() is sorted, so an assertion on it is deterministic", async () => {
    const clock = virtualClock(0);
    const hang = (): Source<string> => ({
      clock: "fast",
      measuredCostMs: 1,
      read: () => new Promise<string>(() => {}),
    });
    const clocks = new FleetClocks({ zeta: hang(), alpha: hang() }, { now: clock.now });
    void clocks.tick();
    await flush();
    expect(clocks.pending()).toEqual(["alpha", "zeta"]);
  });

  /** A snapshot a caller can edit is a model two frames can disagree about. */
  test("a snapshot is frozen", async () => {
    const clocks = new FleetClocks({ s: trivial("fast").source }, { now: virtualClock(0).now });
    await clocks.tick();
    const snap = clocks.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      (snap as unknown as Record<string, unknown>).injected = 1;
    }).toThrow();
  });

  /**
   * **The units decision, pinned.** `model.ts:44` publishes `readAt` as epoch
   * millis, so the default clock must be wall clock and not `monotonicMs` —
   * a monotonic default here would be subtracted from whatever wall-clock
   * `FleetModel.now` the renderer supplies, and two clocks in one subtraction
   * is a worse bug than the NTP-step one it would fix. This asserts the
   * decision rather than the preference: `performance.now()` on a fresh
   * process is a few thousand, six orders below an epoch.
   */
  test("nowDefault is wall clock, matching the published readAt units", () => {
    expect(nowDefault()).toBeGreaterThan(1_600_000_000_000);
    expect(Math.abs(nowDefault() - Date.now())).toBeLessThan(1_000);
  });

  /**
   * The production timer wiring, exercised without waiting on it: a real
   * interval is registered and immediately cleared. Bun's `setInterval`
   * returns a `Timer` object, so a stub returning a number is caught here
   * rather than by a pane that silently never repaints.
   */
  test("realTimers actually registers and clears an interval", () => {
    const handle = realTimers.setInterval(() => {}, 3_600_000);
    expect(handle).not.toBeNull();
    expect(typeof handle).toBe("object");
    realTimers.clearInterval(handle);
  });
});

describe("the `after` ordering edge", () => {
  /**
   * Added after the shipped wiring was run for the first time. `runs` and
   * `containers` are both slow sources and were dispatched concurrently, so the
   * 1777 ms run walk read the container set through its getter at the moment it
   * STARTED — the previous tick's answer, and on the first tick no answer at
   * all. Every worker rendered `container not checked` for the first thirty
   * seconds of a session, and thereafter carried a `containerPresent` up to a
   * full slow period older than the row it was on.
   *
   * The fixtures below all pin ORDER rather than timing, because a test that
   * asserted "containers finished within N ms of runs starting" would pass on a
   * fast machine with the edge removed.
   */
  test("a dependent source does not start until its dependency has finished", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const clocks = new FleetClocks(
      {
        first: {
          clock: "slow" as const,
          measuredCostMs: 1,
          read: async () => {
            order.push("first:start");
            await gate;
            order.push("first:end");
            return 1;
          },
        },
        second: {
          clock: "slow" as const,
          measuredCostMs: 1,
          after: "first",
          read: async () => {
            order.push("second:start");
            return 2;
          },
        },
      },
      { now: () => 0 },
    );

    const tick = clocks.tick();
    // Let every microtask that CAN run, run. Without the edge `second:start`
    // lands here; with it, nothing can until the gate opens.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await tick;
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  /**
   * The edge must not serialise the WHOLE pass. A chained source that blocked
   * dispatch would put the git strip behind the run walk for no reason, which
   * is the opposite of what three clocks are for.
   */
  test("an unchained source on the same clock still starts immediately", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const clocks = new FleetClocks(
      {
        blocker: {
          clock: "slow" as const,
          measuredCostMs: 1,
          read: async () => {
            order.push("blocker");
            await gate;
            return 1;
          },
        },
        chained: {
          clock: "slow" as const,
          measuredCostMs: 1,
          after: "blocker",
          read: async () => {
            order.push("chained");
            return 2;
          },
        },
        independent: {
          clock: "slow" as const,
          measuredCostMs: 1,
          read: async () => {
            order.push("independent");
            return 3;
          },
        },
      },
      { now: () => 0 },
    );

    const tick = clocks.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["blocker", "independent"]);
    release();
    await tick;
    expect(order).toContain("chained");
  });

  /**
   * THE THREE SILENT FAILURES, each made loud. All three produce the identical
   * symptom if left to no-op at dispatch — the edge is not honoured, the read
   * gets stale data, and nothing anywhere reports it. That is the same class of
   * defect the edge was added to fix.
   */
  test("an after naming a source that does not exist is refused at construction", () => {
    expect(
      () =>
        new FleetClocks({
          a: { clock: "slow" as const, measuredCostMs: 1, after: "nope", read: async () => 1 },
        }),
    ).toThrow(/not a source/);
  });

  test("an after naming a source on a different clock is refused", () => {
    expect(
      () =>
        new FleetClocks({
          m: { clock: "medium" as const, measuredCostMs: 1, read: async () => 1 },
          s: { clock: "slow" as const, measuredCostMs: 1, after: "m", read: async () => 2 },
        }),
    ).toThrow(/only holds within one clock/);
  });

  /**
   * The one that actually happened. `runs` was declared BEFORE `containers`, so
   * the dispatch pass reached `runs` with nothing yet started under the name it
   * was waiting for, and the edge quietly did nothing.
   */
  test("a FORWARD after — naming a source declared later — is refused", () => {
    expect(
      () =>
        new FleetClocks({
          early: { clock: "slow" as const, measuredCostMs: 1, after: "late", read: async () => 1 },
          late: { clock: "slow" as const, measuredCostMs: 1, read: async () => 2 },
        }),
    ).toThrow(/declared LATER/);
  });

  /**
   * The production fact, not a fixture fact. `fleetSources` must declare
   * `containers` before `runs` AND carry the edge; either alone is insufficient
   * and the pair is what makes `containerPresent` same-tick.
   */
  test("fleetSources orders containers ahead of the run walk", () => {
    const sources = fleetSources({ root: "/nonexistent-root-for-declaration-check" });
    expect(sources.runs.after).toBe("containers");
    expect(Object.keys(sources).indexOf("containers")).toBeLessThan(
      Object.keys(sources).indexOf("runs"),
    );
    // And it constructs, which is the constructor validation agreeing.
    expect(() => new FleetClocks(sources)).not.toThrow();
  });
});
