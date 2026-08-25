/**
 * The per-worker stall window is bounded by the shortest deadline it could act
 * on (ISC-297).
 *
 * WHY THIS IS A SEPARATE FILE FROM `scheduler-stall.test.ts`. That file proves
 * the scheduler ACTS on a verdict — it drives `WedgedFleet` with a window it
 * hands in directly, so the rung it exercises is reachable by construction.
 * This file asks the question that one cannot: whether the rung is reachable
 * under the configuration the product SHIPS. Both were green while the answer
 * was no for every task deadline under twenty-five minutes, which is the RC-1
 * shape this ISA keeps re-learning — a correct mechanism beside a path nothing
 * takes.
 *
 * The measurement that produced the criterion: two live wedges both emitted
 * `worker_stall_warn` at exactly 180 000 ms and neither reached `kill`. They
 * carried `deadline_s: 900` against `event_stall_kill: 25m`, and settled
 * `timed_out` at 900 s with twelve minutes of the kill window unspent.
 */

import { describe, expect, test } from "bun:test";
import { TaskSpecSchema, type TaskSpec, type Verdict } from "../../src/contracts.ts";
import { BudgetManager, emptyBudget } from "../../src/safety/budget.ts";
import {
  runSchedule,
  stallWindowFor,
  type DispatchAnswer,
  type SchedulerIO,
  type WorkerHealth,
} from "../../src/orchestrate/scheduler.ts";

/** The shipped pairing, named rather than inlined: this is the case under test. */
const SHIPPED_WARN_MS = 3 * 60_000;
const SHIPPED_KILL_MS = 25 * 60_000;

const spec = (id: string, deadlineS?: number): TaskSpec =>
  TaskSpecSchema.parse({
    id,
    title: id,
    brief: `do ${id}`,
    depends_on: [],
    ...(deadlineS === undefined ? {} : { deadline_s: deadlineS }),
  });

/**
 * A worker that answers, never settles, and goes quiet at t=0 — the wedge.
 *
 * Deliberately a near-copy of `scheduler-stall.test.ts`'s fleet rather than a
 * shared import: that one advances 60 s per poll, and a probe about SHORT
 * deadlines needs a finer clock to distinguish a rung that fires at 150 s from
 * one that never fires at all.
 */
class WedgedFleet implements SchedulerIO {
  readonly killed: Array<{ worker: string; taskId: string }> = [];
  readonly warned: Array<{ worker: string; taskId: string }> = [];
  /** Silence at the moment of each kill — what the rung actually fired at. */
  readonly killedAtMs: number[] = [];
  clockMs = 0;
  #silenceMs = 0;

  constructor(
    private readonly workers: string[],
    private readonly tickMs = 10_000,
  ) {}

  listWorkers(): Promise<string[]> {
    return Promise.resolve([...this.workers]);
  }

  workerHealth(worker: string): Promise<WorkerHealth> {
    return Promise.resolve(this.killed.some((k) => k.worker === worker) ? "dead" : "idle");
  }

  dispatch(_s: TaskSpec, _worker: string, _taskId: string): Promise<DispatchAnswer> {
    return Promise.resolve({ kind: "accepted", epoch: 1 });
  }

  readSettled(): Promise<{ verdict: Verdict; reason: string } | null> {
    return Promise.resolve(null);
  }

  eventSilenceMs(_worker: string): Promise<number | null> {
    return Promise.resolve(this.#silenceMs);
  }

  killWedged(worker: string, taskId: string): Promise<void> {
    this.killed.push({ worker, taskId });
    this.killedAtMs.push(this.#silenceMs);
    return Promise.resolve();
  }

  sleep(): Promise<void> {
    this.clockMs += this.tickMs;
    this.#silenceMs += this.tickMs;
    return Promise.resolve();
  }

  now(): number {
    return this.clockMs;
  }
}

const budgetFor = (maxConcurrent: number) => ({
  manager: new BudgetManager(emptyBudget("r-1", { tokensCeiling: null })),
  maxConcurrent,
  reserveTokens: 0,
});

describe("ISC-297: the kill rung fires under the configuration the product ships", () => {
  /**
   * THE CRITERION'S BINARY PROBE, and the one that was red before the
   * derivation existed: a task whose deadline is SHORTER than the configured
   * `event_stall_kill`, wedged, must still be killed.
   *
   * Fails if: the window is taken from the configuration unbounded. At
   * `deadline_s: 900` against `event_stall_kill: 25m` the silence needed to
   * reach the rung is 1 500 000 ms, the fleet-wide ceiling
   * (`900 s + 600 s grace`) refuses the run at 1 500 000 ms first, and
   * `killWedged` is never called — which is exactly what the two live wedges
   * did.
   */
  test("a wedge on a 900 s task is killed, not left to its deadline", async () => {
    const fleet = new WedgedFleet(["w1"]);
    await runSchedule([spec("a", 900)], fleet, {
      pollMs: 0,
      budget: budgetFor(1),
      stall: { warnMs: SHIPPED_WARN_MS, killMs: SHIPPED_KILL_MS },
    });
    expect(fleet.killed).toHaveLength(1);
    expect(fleet.killed[0]!.worker).toBe("w1");
    // …and it fired INSIDE the task's own deadline, which is the criterion's
    // sentence. Asserting only "was killed" would pass a rung that fires one
    // millisecond before the fleet-wide ceiling gives up.
    expect(fleet.killedAtMs[0]!).toBeLessThan(900_000);
    // Specifically at the derived half-deadline, not at some incidental
    // boundary: 0.5 × 900 s = 450 s, reached on the 45th 10 s tick.
    expect(fleet.killedAtMs[0]!).toBeGreaterThanOrEqual(450_000);
    expect(fleet.killedAtMs[0]!).toBeLessThan(460_000);
  });

  /**
   * The same wedge with a SHORT deadline, where the configured warn rung is
   * itself past the deadline. Both rungs have to come down together or the
   * band inverts and `classifyStall` can only ever answer `warn`.
   */
  test("a wedge on a 120 s task is killed too, and the band does not invert", async () => {
    const fleet = new WedgedFleet(["w1"], 1_000);
    await runSchedule([spec("a", 120)], fleet, {
      pollMs: 0,
      budget: budgetFor(1),
      stall: { warnMs: SHIPPED_WARN_MS, killMs: SHIPPED_KILL_MS },
    });
    expect(fleet.killed).toHaveLength(1);
    expect(fleet.killedAtMs[0]!).toBeLessThan(120_000);
  });

  /**
   * THE CONTROL, and it is the reason the two above are not merely asserting
   * that something eventually kills everything.
   *
   * One field different — the worker keeps emitting — and the same run ends
   * the OTHER way: nobody is killed, and it is the fleet-wide no-progress
   * ceiling that refuses at EXIT.TIMEOUT. That the two mechanisms are
   * distinguishable is the point; ISC-297 tightens the per-worker rung and
   * must not have quietly turned it into a second copy of `stallTimeoutMs`.
   */
  test("a worker that keeps emitting is refused by the fleet ceiling, not killed", async () => {
    class TalkativeFleet extends WedgedFleet {
      override eventSilenceMs(): Promise<number | null> {
        return Promise.resolve(0);
      }
    }
    const fleet = new TalkativeFleet(["w1"]);
    const outcome = await runSchedule([spec("a", 900)], fleet, {
      pollMs: 0,
      budget: budgetFor(1),
      stall: { warnMs: SHIPPED_WARN_MS, killMs: SHIPPED_KILL_MS },
    }).then(
      () => ({ threw: null as Error | null }),
      (e: Error) => ({ threw: e }),
    );
    expect(fleet.killed).toHaveLength(0);
    expect(outcome.threw?.message).toContain("workers are alive but not settling");
  });
});

describe("ISC-297: the derivation itself", () => {
  const SHIPPED = { warnMs: SHIPPED_WARN_MS, killMs: SHIPPED_KILL_MS };

  /**
   * THE PROPERTY THE CRITERION STATES, over a range rather than at a point.
   * A single example would pass a derivation that happens to be right at 900 s
   * and wrong at 60 s.
   */
  test("kill is strictly less than the shortest deadline, at every scale", () => {
    for (const deadlineS of [10, 60, 120, 300, 900, 1800, 3600, 86_400]) {
      const w = stallWindowFor([spec("a", deadlineS)], SHIPPED);
      expect(w.killMs, `deadline ${deadlineS}s`).toBeLessThan(deadlineS * 1000);
      expect(w.warnMs, `deadline ${deadlineS}s`).toBeLessThan(w.killMs);
      expect(w.warnMs).toBeGreaterThan(0);
    }
  });

  test("the SHORTEST deadline binds, not the longest or the first", () => {
    const w = stallWindowFor([spec("a", 3600), spec("b", 120), spec("c", 1800)], SHIPPED);
    expect(w.killMs).toBe(60_000); // 0.5 × 120 s, not 0.5 × 3600 s
  });

  /**
   * Only ever TIGHTENS. This is what makes the derivation safe to apply
   * unconditionally: an operator who already chose aggressive timers keeps
   * them exactly, and no upgrade silently relaxes anybody's policy.
   */
  test("an operator's tighter window is never loosened", () => {
    const tight = { warnMs: 5_000, killMs: 10_000 };
    expect(stallWindowFor([spec("a", 86_400)], tight)).toEqual(tight);
  });

  /**
   * The shipped pairing, spelled out, because this is the case the criterion
   * was filed against and a reader should be able to check the arithmetic
   * without running anything.
   */
  test("the shipped example moves the kill rung and leaves the warn rung alone", () => {
    const w = stallWindowFor([spec("a")], SHIPPED); // deadline_s defaults to 1800
    expect(w.warnMs).toBe(SHIPPED_WARN_MS); // min(180s, 0.2 × 1800s = 360s)
    expect(w.killMs).toBe(900_000); // min(1500s, 0.5 × 1800s) — was unreachable
    expect(w.killMs).toBeLessThan(1_800_000);
  });

  /**
   * Nothing to be shorter than: the configured window is returned untouched,
   * byte-for-byte the behaviour before the derivation existed. Matches how
   * `stallCeilingFor` treats the same shape.
   */
  test("a list with no usable deadline returns the configuration unchanged", () => {
    const noDeadline = { id: "a", title: "a", brief: "a", depends_on: [] } as unknown as TaskSpec;
    expect(stallWindowFor([noDeadline], SHIPPED)).toEqual(SHIPPED);
    expect(stallWindowFor([], SHIPPED)).toEqual(SHIPPED);
  });

  /**
   * One absent or NaN deadline among real ones must not collapse the minimum
   * and tighten every rung to nothing — the defensive branch, asserted rather
   * than described.
   */
  test("a malformed deadline beside a real one does not collapse the window", () => {
    const bad = {
      id: "b",
      title: "b",
      brief: "b",
      depends_on: [],
      deadline_s: NaN,
    } as unknown as TaskSpec;
    expect(stallWindowFor([spec("a", 900), bad], SHIPPED).killMs).toBe(450_000);
  });
});
