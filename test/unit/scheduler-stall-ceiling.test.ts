/**
 * The fleet-wide no-progress ceiling, DERIVED from the list it schedules
 * (ISC-293) and the operator-facing consequence of that (ISC-294).
 *
 * These exist because no test could have caught the defect they close, and
 * that is worth stating rather than assuming. The ceiling was a module
 * constant of 600 s and every scheduler test used the schema's tasks without
 * ever scheduling one whose `deadline_s` outran it, so the two numbers were
 * never in the same assertion. The first end-to-end run put them there: the
 * CLI abandoned with `EXIT.TIMEOUT` five minutes before the supervisor settled
 * the task correctly at its own 900 s deadline.
 *
 * The clock is injected, so a 2400 s ceiling is reachable without waiting
 * forty real minutes for it.
 */

import { describe, expect, test } from "bun:test";
import { EXIT, TaskSpecSchema, type TaskSpec, type Verdict } from "../../src/contracts.ts";
import { BudgetManager, emptyBudget } from "../../src/safety/budget.ts";
import {
  runSchedule,
  stallCeilingFor,
  type DispatchAnswer,
  type SchedulerIO,
  type WorkerHealth,
} from "../../src/orchestrate/scheduler.ts";

/** The grace the derivation adds on top of the longest deadline. */
const GRACE_MS = 600_000;

const spec = (id: string, deadline_s?: number): TaskSpec =>
  TaskSpecSchema.parse({
    id,
    title: id,
    brief: `do ${id}`,
    depends_on: [],
    ...(deadline_s === undefined ? {} : { deadline_s }),
  });

describe("stallCeilingFor derives the ceiling from the list (ISC-293)", () => {
  test("the schema's DEFAULT deadline already exceeded the old constant", () => {
    /**
     * The fact that makes this more than a tidy-up. `deadline_s` defaults to
     * 1800 s, so a task list that names no deadline at all was refused at
     * 600 s — twenty minutes early. The measured run used 900 s and therefore
     * UNDER-reported the defect.
     */
    expect(spec("t1").deadline_s).toBe(1800);
    expect(stallCeilingFor([spec("t1")])).toBe(1_800_000 + GRACE_MS);
  });

  test("the run's own numbers: a 900s deadline yields 1500s, not 600s", () => {
    expect(stallCeilingFor([spec("t1", 900)])).toBe(900_000 + GRACE_MS);
  });

  test("the LONGEST deadline governs, not the first or the last", () => {
    const tasks = [spec("a", 60), spec("b", 3600), spec("c", 120)];
    expect(stallCeilingFor(tasks)).toBe(3_600_000 + GRACE_MS);
  });

  test("an empty list falls back to the grace alone — the pre-ISC-293 behaviour", () => {
    // The one case where there is no deadline to be shorter than, so the
    // original constant was never wrong for it.
    expect(stallCeilingFor([])).toBe(GRACE_MS);
  });

  test.each([
    ["a non-finite deadline", Number.NaN],
    ["an infinite deadline", Number.POSITIVE_INFINITY],
    ["a zero deadline", 0],
    ["a negative deadline", -5],
  ])("%s is ignored rather than poisoning the maximum", (_label, bad) => {
    /**
     * `runSchedule` is also driven directly by tests and by callers that build
     * a TaskSpec by hand, bypassing the schema. A NaN reaching `Math.max`
     * would make the ceiling NaN, and `elapsed > NaN` is always false — which
     * disables the guard ENTIRELY and silently. That is a worse failure than
     * the one this whole change fixes, so it is pinned.
     */
    const hand = { ...spec("t1", 900), deadline_s: bad } as TaskSpec;
    expect(stallCeilingFor([hand, spec("t2", 900)])).toBe(900_000 + GRACE_MS);
    expect(Number.isFinite(stallCeilingFor([hand]))).toBe(true);
  });

  test.each([1, 30, 600, 900, 1800, 3600, 86_400])(
    "THE PROPERTY: with a %ss deadline the ceiling is strictly greater",
    (deadline) => {
      // ISC-293 stated as the criterion states it, over a range rather than at
      // one point. A backstop that is not strictly beyond what it backstops is
      // not a backstop; it is the tighter of two deadlines.
      expect(stallCeilingFor([spec("t1", deadline)])).toBeGreaterThan(deadline * 1000);
    },
  );
});

/**
 * A fleet that accepts work and then never settles anything, with every worker
 * permanently healthy — the wedged-agent shape, and the only one in which the
 * fleet-wide ceiling is the guard that ends the run.
 *
 * No stall policy is supplied anywhere in this file, deliberately: `stall`
 * would kill the worker on its own schedule and the run would end for that
 * reason instead, which would make these tests pass without the ceiling ever
 * being consulted.
 */
class NeverSettles implements SchedulerIO {
  clockMs = 0;
  #outstanding = 0;
  #ticks = 0;

  /**
   * A hard tick budget, and the reason for it is the sharpest thing this file
   * learned.
   *
   * Mutation-testing the ceiling revealed that its bad states do not FAIL a
   * run, they HANG it: `elapsed > Infinity` is never true, so `runSchedule`
   * polls forever. Worse, the poll loop awaits an already-resolved promise, so
   * it starves the macrotask queue and bun's own per-test timeout cannot fire
   * to rescue it. A suite that hangs is strictly worse than one that fails —
   * CI reports nothing and a developer waits.
   *
   * So the fake clock refuses to run forever. Every test here expects the
   * schedule to be refused within its own ceiling; this budget is generous
   * against the largest one used (1800 s + 600 s of grace at 30 s a tick = 80)
   * and turns "the ceiling never bites" into a named, immediate failure.
   */
  static readonly MAX_TICKS = 400;

  constructor(private readonly workers: string[]) {}

  listWorkers(): Promise<string[]> {
    return Promise.resolve([...this.workers]);
  }

  workerHealth(): Promise<WorkerHealth> {
    return Promise.resolve(this.#outstanding > 0 ? "busy" : "idle");
  }

  dispatch(): Promise<DispatchAnswer> {
    this.#outstanding += 1;
    return Promise.resolve({ kind: "accepted", epoch: 1 });
  }

  readSettled(): Promise<{ verdict: Verdict; reason: string } | null> {
    return Promise.resolve(null);
  }

  eventSilenceMs(): Promise<number | null> {
    return Promise.resolve(null);
  }

  killWedged(): Promise<void> {
    return Promise.resolve();
  }

  sleep(): Promise<void> {
    this.#ticks += 1;
    if (this.#ticks > NeverSettles.MAX_TICKS) {
      return Promise.reject(
        new Error(
          `the schedule was never refused: ${NeverSettles.MAX_TICKS} ticks ` +
            `(${this.clockMs / 1000}s of fake clock) elapsed with the run still polling. ` +
            `The fleet-wide ceiling is not biting — see stallCeilingFor.`,
        ),
      );
    }
    this.clockMs += 30_000;
    return Promise.resolve();
  }

  now(): number {
    return this.clockMs;
  }
}

const budget = () => ({
  manager: new BudgetManager(emptyBudget("r-1", { tokensCeiling: null })),
  maxConcurrent: 4,
  reserveTokens: 0,
});

describe("Anti: no EXIT.TIMEOUT while a task is inside its deadline (ISC-294)", () => {
  /**
   * Graded from the OPERATOR's vantage, because that is where the damage
   * landed. `rc=4` and "not settling" reads as a fleet that hangs; the run it
   * was reported on settled, harvested and adjudicated on its own five minutes
   * later. A CLI that reports failure for a run about to succeed is worse than
   * one that waits.
   */
  const runUntilRefused = async (deadlineS: number) => {
    const fleet = new NeverSettles(["w1"]);
    let thrown: unknown = null;
    try {
      await runSchedule([spec("t1", deadlineS)], fleet, { pollMs: 1, budget: budget() });
    } catch (err) {
      thrown = err;
    }
    return { fleet, thrown };
  };

  test("the run measured on 2026-08-23: a 900s task is not refused at 600s", async () => {
    const { fleet, thrown } = await runUntilRefused(900);
    expect(thrown).not.toBeNull();
    expect((thrown as { exitCode?: number }).exitCode).toBe(EXIT.TIMEOUT);
    // The whole criterion in one assertion: whatever the clock reads when the
    // refusal lands, it is past the deadline the task declared.
    expect(fleet.clockMs).toBeGreaterThan(900_000);
  });

  test("a default-shaped task (1800s) is not refused at 600s either", async () => {
    // The case no test would have surfaced, because it needs no unusual config
    // at all — just a task list that names no deadline.
    const { fleet, thrown } = await runUntilRefused(1800);
    expect(thrown).not.toBeNull();
    expect(fleet.clockMs).toBeGreaterThan(1_800_000);
  });

  test("it still REFUSES — the fix must not turn the backstop off", async () => {
    // The paired half. A ceiling raised to infinity would satisfy every
    // assertion above and re-create the §9.3 deadlock the guard exists to
    // prevent: a wedged fleet that polls until someone notices.
    const { fleet, thrown } = await runUntilRefused(60);
    expect(thrown).not.toBeNull();
    expect((thrown as { exitCode?: number }).exitCode).toBe(EXIT.TIMEOUT);
    expect(fleet.clockMs).toBeLessThan(60_000 + GRACE_MS + 60_000);
  });

  test.each([
    ["infinite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -1],
  ])("a %s ceiling from a caller is REFUSED, not silently obeyed", async (_label, bad) => {
    /**
     * Found by mutation, and kept because the failure mode is the bad kind: an
     * infinite ceiling does not merely mis-grade a run, it makes `runSchedule`
     * poll forever, since `elapsed > Infinity` is never true. A test that
     * asserted only the grade would HANG rather than fail here, which is why
     * this asserts against the guard directly instead of against a run.
     */
    const fleet = new NeverSettles(["w1"]);
    await expect(
      runSchedule([spec("t1", 60)], fleet, { pollMs: 1, budget: budget(), stallTimeoutMs: bad }),
    ).rejects.toThrow(/positive, finite number|poll forever/);
  });

  test("the refusal message names where its ceiling came from", async () => {
    // ISC-294 is about what the operator is TOLD. A number with no stated
    // derivation is what sent the last reader looking for a hang that was not
    // there, so the message carries the deadline it was computed from.
    const { thrown } = await runUntilRefused(900);
    const msg = String((thrown as Error).message);
    expect(msg).toContain("longest deadline_s (900s)");
    expect(msg).toContain("past its own deadline");
  });
});
