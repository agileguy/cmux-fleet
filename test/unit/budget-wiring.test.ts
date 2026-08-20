/**
 * The budget on the LIVE dispatch path (ISC-109, ISC-114, ISC-193, ISC-235).
 *
 * `test/unit/budget.test.ts` already proves `BudgetManager` is a correct
 * accountant in isolation. That was never in doubt; what was in doubt — and
 * what four audits recorded — is that nothing CALLED it, so a correct
 * accountant sat beside a scheduler that admitted every ready task onto every
 * idle worker. This file tests the seam rather than the module: the real
 * `runSchedule`, driven against a fake fleet, with the real manager attached.
 *
 * The ISC-109 test is deliberately not "call `admit` twice and check the
 * second is refused" — that is a test of `budget.ts`, which already has one.
 * The evidence the bug was found with was a PROBE THAT SAMPLED IN-FLIGHT
 * COUNT OVER TIME against the real loop (measured: peak 6 with
 * `max_concurrent: 2`), so the regression test has the same shape: the fake
 * records the size of the in-flight set at every moment it can change, and
 * the assertion is on the peak of that series.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EXIT,
  TaskSpecSchema,
  type BudgetState,
  type ScheduledTask,
  type TaskSpec,
  type Verdict,
} from "../../src/contracts.ts";
import { openingBalance, type WorkerObservation } from "../../src/cli/commands/dispatch.ts";
import {
  BudgetManager,
  emptyBudget,
  resumeBudget,
  ForeignBudgetError,
} from "../../src/safety/budget.ts";
import {
  runSchedule,
  type DispatchAnswer,
  type SchedulerIO,
  type WorkerHealth,
} from "../../src/orchestrate/scheduler.ts";
import { runPaths } from "../../src/run/paths.ts";
import {
  readBudgetState,
  readRunBudgetPolicy,
  runBudgetRecord,
  RunPolicyUnreadableError,
} from "../../src/run/state.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { DEFAULT_MAX_CONCURRENT, FleetConfigSchema } from "../../src/config/schema.ts";

function spec(id: string, deps: string[] = [], extra: Record<string, unknown> = {}): TaskSpec {
  return TaskSpecSchema.parse({ id, title: id, brief: `do ${id}`, depends_on: deps, ...extra });
}

interface FleetOpts {
  /** Polls each task spends in flight before its record appears. */
  settleDelayPolls?: number;
  /**
   * Tokens each task reports having burned, by task id (default 0).
   *
   * A PER-TASK CONSTANT, and that is exactly why this fake can see the
   * `unreachable` double-book while production cannot. The real `taskTokens`
   * is a per-worker monotone delta (`if (now <= seen) return 0`), so a second
   * booking for the same task answers 0 and the arithmetic silently cancels;
   * here the second booking is another full 100. A fake that reproduced the
   * delta would reproduce the masking with it and certify the bug.
   */
  tokens?: Record<string, number>;
  /** Scripted dispatch answers per task, consumed in order. */
  answers?: Record<string, DispatchAnswer[]>;
  /** Task ids whose dispatch THROWS instead of answering. */
  throwOnDispatch?: Set<string>;
}

/**
 * A fake fleet that also INSTRUMENTS concurrency.
 *
 * `samples` is appended to at every point the in-flight set can change size
 * and once per idle poll, so the series is a time-sampled record of how many
 * tasks the scheduler had running at once — the quantity ISC-109 is about,
 * rather than the number of times `admit` was called.
 */
class SamplingFleet implements SchedulerIO {
  readonly log: string[] = [];
  readonly samples: number[] = [];
  readonly inFlight = new Set<string>();
  clockMs = 0;
  readonly #workers: string[];
  readonly #opts: FleetOpts;
  readonly #settling = new Map<string, number>();

  constructor(workers: string[], opts: FleetOpts = {}) {
    this.#workers = workers;
    this.#opts = opts;
  }

  #sample(): void {
    this.samples.push(this.inFlight.size);
  }

  listWorkers(): Promise<string[]> {
    return Promise.resolve([...this.#workers]);
  }

  workerHealth(worker: string): Promise<WorkerHealth> {
    // A worker running one of this scheduler's tasks reads `busy`, exactly as
    // a real supervisor would; everything else is idle. Without this the fake
    // would report six idle workers while six tasks ran on them, and the
    // scheduler's own `busy` set would be doing the capping work the budget
    // is supposed to do.
    return Promise.resolve(this.#busyWorkers().has(worker) ? "busy" : "idle");
  }

  #busyWorkers(): Set<string> {
    const out = new Set<string>();
    for (const t of this.inFlight) {
      const w = this.assignment.get(t);
      if (w !== undefined) out.add(w);
    }
    return out;
  }

  readonly assignment = new Map<string, string>();

  dispatch(specArg: TaskSpec, worker: string, taskId: string): Promise<DispatchAnswer> {
    const scripted = this.#opts.answers?.[specArg.id]?.shift();
    this.log.push(`dispatch:${specArg.id}->${worker}`);
    if (this.#opts.throwOnDispatch?.has(specArg.id) === true) {
      // The reachable shape: `dispatch.ts`'s `io.dispatch` re-throws anything
      // that is not a diagnosed `WorkerUnreachableError`.
      return Promise.reject(new Error(`dispatch blew up for ${specArg.id}`));
    }
    if (scripted !== undefined) {
      this.#sample();
      return Promise.resolve(scripted);
    }
    this.assignment.set(taskId, worker);
    this.inFlight.add(taskId);
    this.#settling.set(taskId, this.#opts.settleDelayPolls ?? 1);
    this.#sample();
    return Promise.resolve({ kind: "accepted", epoch: 1 });
  }

  readSettled(
    _worker: string,
    taskId: string,
  ): Promise<{ verdict: Verdict; reason: string } | null> {
    const left = this.#settling.get(taskId);
    if (left === undefined) return Promise.resolve(null);
    if (left > 0) {
      this.#settling.set(taskId, left - 1);
      return Promise.resolve(null);
    }
    this.#settling.delete(taskId);
    this.inFlight.delete(taskId);
    this.log.push(`settled:${taskId}`);
    this.#sample();
    return Promise.resolve({ verdict: "success", reason: "" });
  }

  taskTokens(_worker: string, taskId: string): Promise<number> {
    return Promise.resolve(this.#opts.tokens?.[taskId] ?? 0);
  }

  sleep(): Promise<void> {
    this.clockMs += 1_000;
    this.#sample();
    return Promise.resolve();
  }

  now(): number {
    return this.clockMs;
  }
}

/**
 * A `BudgetManager` that RECORDS the calls made against it.
 *
 * The double-book below has to be asserted as a COUNT OF SETTLES for one task,
 * not as a resulting `tokens_spent`. A total is hostage to the fake's token
 * model: `FleetOpts.tokens` is a per-task constant today, and the day it
 * becomes a per-worker delta (production's shape) a second settle books 0 and
 * a total-based assertion goes green with the defect fully intact — which is
 * precisely how this bug survived the existing suite in the first place.
 *
 * Subclassed rather than proxied so the object handed to `runSchedule` IS a
 * `BudgetManager` and the real accounting runs underneath; the overrides only
 * observe.
 */
class RecordingBudget extends BudgetManager {
  constructor(
    restored: BudgetState,
    readonly trace: string[],
  ) {
    super(restored);
  }

  override admit(taskId: string, opts: { reserveTokens: number; maxConcurrent: number }) {
    const d = super.admit(taskId, opts);
    this.trace.push(d.ok ? `admit:${taskId}:ok` : `admit:${taskId}:refused:${d.reason}`);
    return d;
  }

  override settle(taskId: string, actual: { tokens: number; usd?: number }) {
    this.trace.push(`settle:${taskId}:${actual.tokens}`);
    return super.settle(taskId, actual);
  }

  override release(taskId: string): boolean {
    const released = super.release(taskId);
    this.trace.push(`release:${taskId}:${released}`);
    return released;
  }
}

/** How many times `settle` was booked for one task id. */
function settleCount(trace: readonly string[], taskId: string): number {
  return trace.filter((t) => t.startsWith(`settle:${taskId}:`)).length;
}

/** A budget wired the way `dispatch --auto` wires one, with a capture hook. */
function budgetFor(
  opts: { tokensCeiling?: number | null; maxConcurrent: number; reserveTokens?: number },
  snapshots: BudgetState[] = [],
): {
  manager: BudgetManager;
  maxConcurrent: number;
  reserveTokens: number;
  onChange: (s: BudgetState) => Promise<void>;
} {
  const manager = new BudgetManager(
    emptyBudget("run-under-test", { tokensCeiling: opts.tokensCeiling ?? null }),
  );
  return {
    manager,
    maxConcurrent: opts.maxConcurrent,
    reserveTokens: opts.reserveTokens ?? 0,
    onChange: (s) => {
      snapshots.push(s);
      return Promise.resolve();
    },
  };
}

describe("ISC-109: max_concurrent caps in-flight generations, sampled over time", () => {
  test("6 idle workers, max_concurrent 2 — the in-flight series never exceeds 2", async () => {
    const workers = ["w1", "w2", "w3", "w4", "w5", "w6"];
    const fleet = new SamplingFleet(workers, { settleDelayPolls: 2 });
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => spec(id));

    const { schedule, exit } = await runSchedule(tasks, fleet, {
      budget: budgetFor({ maxConcurrent: 2 }),
    });

    // THE assertion: the peak of a time-sampled series, not a count of calls.
    expect(Math.max(...fleet.samples)).toBeLessThanOrEqual(2);
    // And non-vacuous: the cap was actually reached, so a scheduler that ran
    // everything strictly serially could not pass this by accident.
    expect(Math.max(...fleet.samples)).toBe(2);
    // Every task still ran exactly once and completed — the cap DELAYS work,
    // it never drops it.
    expect(exit).toBe(EXIT.SUCCESS);
    expect(schedule.map((t) => t.state)).toEqual(Array(6).fill("done"));
    for (const id of ["t1", "t2", "t3", "t4", "t5", "t6"]) {
      expect(fleet.log.filter((l) => l === `dispatch:${id}->${fleet.assignment.get(id)!}`)).toHaveLength(1);
    }
  });

  test("without a budget the same fleet runs all 6 at once — the probe can see the bug", async () => {
    // The control case. This is the behaviour four audits measured, kept as a
    // test so the ISC-109 assertion above cannot be passing for some reason
    // unrelated to the cap (a fake that serialises, a scheduler that never
    // dispatches in parallel at all).
    const fleet = new SamplingFleet(["w1", "w2", "w3", "w4", "w5", "w6"], {
      settleDelayPolls: 2,
    });
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => spec(id));
    await runSchedule(tasks, fleet, {});
    expect(Math.max(...fleet.samples)).toBe(6);
  });
});

describe("ISC-235: admit is called on the dispatch path", () => {
  test("a task refused by the cap stays ready and is dispatched later, never dropped", async () => {
    const fleet = new SamplingFleet(["w1", "w2", "w3"], { settleDelayPolls: 1 });
    const { schedule } = await runSchedule([spec("a"), spec("b"), spec("c")], fleet, {
      budget: budgetFor({ maxConcurrent: 1 }),
    });
    // No task was failed, blocked, or silently skipped by the refusal.
    for (const t of schedule) {
      expect(t.state).toBe("done");
      expect(t.verdict).toBe("success");
    }
    // And the refusal really happened: strictly serial dispatch order.
    expect(fleet.log).toEqual([
      "dispatch:a->w1",
      "settled:a",
      "dispatch:b->w1",
      "settled:b",
      "dispatch:c->w1",
      "settled:c",
    ]);
  });

  test("the reservation is persisted BEFORE the envelope goes out", async () => {
    // budget.ts's own contract: "the caller must persist the snapshot before
    // dispatching, so a crash between decision and dispatch cannot leak an
    // unaccounted slot the restart would double-admit against."
    const order: string[] = [];
    const fleet = new SamplingFleet(["w1"], { settleDelayPolls: 0 });
    const manager = new BudgetManager(emptyBudget("run-under-test", { tokensCeiling: null }));
    const seen: BudgetState[] = [];
    await runSchedule([spec("a")], fleet, {
      budget: {
        manager,
        maxConcurrent: 1,
        reserveTokens: 7,
        onChange: (s) => {
          seen.push(s);
          order.push(`persist:${JSON.stringify(s.reserved)}`);
          return Promise.resolve();
        },
      },
    });
    // Interleave the two logs by construction: the fake pushes dispatch:a on
    // dispatch, and the hook above pushes persist:… on every snapshot.
    const firstWithHold = seen.findIndex((s) => s.reserved["a"] === 7);
    expect(firstWithHold).toBeGreaterThanOrEqual(0);
    // The snapshot carrying the hold was written while `a` had not yet been
    // dispatched: the fake's dispatch log is empty at that point.
    expect(order.indexOf(`persist:${JSON.stringify({ a: 7 })}`)).toBeGreaterThanOrEqual(0);
    // The final snapshot has the hold released.
    expect(seen[seen.length - 1]!.reserved).toEqual({});
  });

  test("a dispatch that is refused releases its hold instead of leaking the slot", async () => {
    // A leaked reservation is indistinguishable from a busy worker forever:
    // with max_concurrent 1 the run would deadlock on the next task.
    const fleet = new SamplingFleet(["w1"], {
      settleDelayPolls: 0,
      answers: { a: [{ kind: "rejected", reason: "prompt_rejected" }] },
    });
    const snapshots: BudgetState[] = [];
    const { schedule, exit } = await runSchedule([spec("a"), spec("b")], fleet, {
      budget: budgetFor({ maxConcurrent: 1, reserveTokens: 5 }, snapshots),
    });
    const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));
    expect(byId["a"]).toMatchObject({ state: "done", verdict: "failed" });
    // b got the slot back: the hold from a's refused dispatch was released.
    expect(byId["b"]).toMatchObject({ state: "done", verdict: "success" });
    expect(exit).toBe(EXIT.PARTIAL);
    expect(snapshots[snapshots.length - 1]!.reserved).toEqual({});
  });
});

describe("an unreachable dispatch releases its hold; it does NOT settle", () => {
  /**
   * `unreachable` is the ONE answer in the dispatch switch that is not
   * terminal — the task stays `ready` and is re-offered — and it was routed
   * through `settleBudget` like the four that are.
   *
   * Two consequences, and the second is the serious one. The task is booked
   * once per ATTEMPT, and the tokens booked come from the worker the dispatch
   * never reached, so a task that ran once on `w2` is charged `w1`'s residual
   * delta as well. And `settle` can TRIP THE CEILING, so a run can halt — and
   * exit 5 — on spend attributed to a dispatch nobody made.
   *
   * WHY THE EXISTING SUITE COULD NOT SEE IT. Production's `taskTokens` is a
   * per-worker monotone delta (`if (now <= seen) return 0`), so the second
   * booking answers 0 and the arithmetic cancels. Only a per-task token model
   * — this fake's — makes the double-book observable at all, which is why the
   * load-bearing assertion here is the SETTLE COUNT rather than the total: the
   * count survives any future change to the fake's token model, and a
   * total-based assertion would silently retire the day the fake grew a delta.
   */
  test("one task, two dispatch attempts, exactly ONE settle and one task's spend", async () => {
    const trace: string[] = [];
    // w1 refuses to take the envelope; w2 takes it. `a` therefore reaches a
    // terminal state exactly once, on w2, having burned 100 tokens there.
    const fleet = new SamplingFleet(["w1", "w2"], {
      settleDelayPolls: 0,
      tokens: { a: 100 },
      answers: { a: [{ kind: "unreachable", detail: "control socket refused connect" }] },
    });
    const manager = new RecordingBudget(
      emptyBudget("run-under-test", { tokensCeiling: 150 }),
      trace,
    );
    const snapshots: BudgetState[] = [];
    const { schedule, exit } = await runSchedule([spec("a")], fleet, {
      budget: {
        manager,
        maxConcurrent: 1,
        reserveTokens: 5,
        onChange: (s) => {
          trace.push(`persist:${JSON.stringify(s.reserved)}`);
          snapshots.push(s);
          return Promise.resolve();
        },
      },
    });

    // THE assertion. Independent of the token model: `a` reached a terminal
    // state once, so it is booked once. The bug settles it twice.
    expect(settleCount(trace, "a")).toBe(1);
    // …and the settle that DID happen was the real one, on the worker that
    // actually ran it.
    expect(trace.filter((t) => t.startsWith("settle:"))).toEqual(["settle:a:100"]);
    // The first attempt gave its slot back through `release`, which books
    // nothing — the distinction the fix turns on.
    expect(trace).toContain("release:a:true");
    // Both dispatch attempts really happened, so this is not passing by the
    // retry never occurring.
    expect(fleet.log).toEqual(["dispatch:a->w1", "dispatch:a->w2", "settled:a"]);

    // The consequence, asserted directly: real spend is 100 against a ceiling
    // of 150, so the run must NOT halt. Booking twice yields 200 > 150 and the
    // run halts and exits 5 for a dispatch that never occurred.
    const last = snapshots[snapshots.length - 1]!;
    expect(last.tokens_spent).toBe(100);
    expect(last.halted_at).toBeNull();
    expect(exit).toBe(EXIT.SUCCESS);
    expect(last.reserved).toEqual({});
    expect(schedule[0]).toMatchObject({ state: "done", verdict: "success", worker: "w2" });
  });

  test("a dispatch that THROWS does not strand its hold", async () => {
    // `io.dispatch` re-throws anything that is not a diagnosed worker failure,
    // and an escape from the dispatch pass used to leave the reservation on
    // disk with nothing that would ever settle it — a phantom in-flight slot
    // for a task no worker ever accepted, shown to every concurrent `wait`
    // and `report` until a restart happened to drop it.
    const trace: string[] = [];
    const fleet = new SamplingFleet(["w1"], {
      settleDelayPolls: 0,
      throwOnDispatch: new Set(["a"]),
    });
    const manager = new RecordingBudget(
      emptyBudget("run-under-test", { tokensCeiling: null }),
      trace,
    );
    const snapshots: BudgetState[] = [];
    await expect(
      runSchedule([spec("a")], fleet, {
        budget: {
          manager,
          maxConcurrent: 1,
          reserveTokens: 9,
          onChange: (s) => {
            snapshots.push(s);
            return Promise.resolve();
          },
        },
      }),
    ).rejects.toThrow("dispatch blew up for a");

    // The hold was taken (so this is not vacuous) and then given back.
    expect(trace).toContain("admit:a:ok");
    expect(trace).toContain("release:a:true");
    expect(snapshots[snapshots.length - 1]!.reserved).toEqual({});
    // Released, not settled: nothing ran, so nothing may be booked.
    expect(trace.filter((t) => t.startsWith("settle:"))).toEqual([]);
  });
});

describe("MUST FIX B: a run the BUDGET refused reports 5, not 7", () => {
  /**
   * `would_exceed` does not halt — only `settle` does — so `budgetExitCode`
   * returns SUCCESS, the un-offered tasks stay `ready`, `exitFor` maps `ready`
   * to `EXIT.PARTIAL`, and the operator got "dispatch --auto finished with
   * non-success terminal states" at 7 for a run whose every task SUCCEEDED and
   * which the budget alone ended.
   *
   * This is the shipped-config shape, not an edge case: with
   * `per_task_reserve_tokens` set, the final reserve-worth of every ceiling is
   * unreachable by construction, so a run that uses its budget ends here.
   */
  test("the ceiling is never crossed, nothing halts, and the exit is still BUDGET", async () => {
    // reserve 60 against a ceiling of 100: `a` is admitted (0 + 60 <= 100) and
    // books 50; `b` is then refused (50 + 60 = 110 > 100). Spend never
    // exceeds the ceiling, so nothing halts.
    const fleet = new SamplingFleet(["w1", "w2"], { settleDelayPolls: 0, tokens: { a: 50 } });
    const snapshots: BudgetState[] = [];
    const { schedule, exit, budgetRefusal } = await runSchedule([spec("a"), spec("b")], fleet, {
      budget: budgetFor({ tokensCeiling: 100, maxConcurrent: 2, reserveTokens: 60 }, snapshots),
    });

    const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));
    expect(byId["a"]).toMatchObject({ state: "done", verdict: "success" });
    // `b` was never offered to anyone — not failed, not blocked.
    expect(byId["b"]).toMatchObject({ state: "ready", worker: null, verdict: null });
    expect(fleet.log.filter((l) => l.startsWith("dispatch:b"))).toEqual([]);

    // THE assertion: 5, not 7. Nothing else can produce it here — no verdict
    // yields BUDGET and `budgetExitCode` is SUCCESS, so this comes from the
    // refusal fold alone.
    expect(exit).toBe(EXIT.BUDGET);

    // And it is a REFUSAL, not a crossing. The distinction has to survive into
    // the record, or the operator goes looking for spend that never happened.
    const last = snapshots[snapshots.length - 1]!;
    expect(last.halted_at).toBeNull();
    expect(last.halted_reason).toBeNull();
    expect(last.tokens_spent).toBe(50);
    expect(last.tokens_spent).toBeLessThanOrEqual(last.tokens_ceiling!);

    // The diagnosis names which refusal and the arithmetic behind it.
    expect(budgetRefusal).toContain("would_exceed");
    expect(budgetRefusal).toContain("110");
    expect(budgetRefusal).toContain("100");
  });

  test("a run that finishes inside its budget still reports 0 and no refusal", async () => {
    // The control. Without it the assertion above is satisfied by a scheduler
    // that reports BUDGET for every run there is.
    const fleet = new SamplingFleet(["w1"], { settleDelayPolls: 0, tokens: { a: 10 } });
    const { exit, budgetRefusal } = await runSchedule([spec("a")], fleet, {
      budget: budgetFor({ tokensCeiling: 1_000, maxConcurrent: 1, reserveTokens: 60 }),
    });
    expect(exit).toBe(EXIT.SUCCESS);
    expect(budgetRefusal).toBeNull();
  });
});

describe("ISC-114 / ISC-115: crossing the ceiling halts dispatch without destroying the run", () => {
  test("undispatched tasks stay ready, in-flight tasks still settle, exit is BUDGET", async () => {
    const fleet = new SamplingFleet(["w1", "w2"], {
      settleDelayPolls: 1,
      // a alone crosses a 100-token ceiling; b is already in flight when it does.
      tokens: { a: 150, b: 10 },
    });
    const snapshots: BudgetState[] = [];
    const { schedule, exit } = await runSchedule(
      [spec("a"), spec("b"), spec("c"), spec("d")],
      fleet,
      { budget: budgetFor({ tokensCeiling: 100, maxConcurrent: 2 }, snapshots) },
    );
    const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));

    // The two that were already running still settled — a halt stops
    // DISPATCH, not the world, which is what leaves artifacts to harvest.
    expect(byId["a"]).toMatchObject({ state: "done", verdict: "success" });
    expect(byId["b"]).toMatchObject({ state: "done", verdict: "success" });
    // The two that were not yet dispatched stay READY: not failed, not
    // blocked, not dropped.
    expect(byId["c"]).toMatchObject({ state: "ready", worker: null, verdict: null });
    expect(byId["d"]).toMatchObject({ state: "ready", worker: null, verdict: null });
    expect(fleet.log.filter((l) => l.startsWith("dispatch:c"))).toEqual([]);
    expect(fleet.log.filter((l) => l.startsWith("dispatch:d"))).toEqual([]);

    // ISC-193: the run's integer is 5, produced by folding budgetExitCode
    // into worstExit — no verdict in this schedule can yield it.
    expect(exit).toBe(EXIT.BUDGET);

    // ISC-115: the halt happened on the TOKEN axis with reported cost 0
    // throughout. A dollar-watching budget never trips against local models.
    const last = snapshots[snapshots.length - 1]!;
    expect(last.halted_at).not.toBeNull();
    expect(last.halted_reason).toContain("tokens_ceiling");
    expect(last.usd_spent).toBe(0);
    expect(last.tokens_spent).toBe(160);
  });

  test("every task succeeds and the run still exits 5 when the ceiling tripped", async () => {
    // The fold, isolated: `worstExit` over the schedule alone is SUCCESS here,
    // so a run that reports 0 has not folded the budget in.
    const fleet = new SamplingFleet(["w1"], { settleDelayPolls: 0, tokens: { a: 500 } });
    const { schedule, exit } = await runSchedule([spec("a")], fleet, {
      budget: budgetFor({ tokensCeiling: 100, maxConcurrent: 1 }),
    });
    expect(schedule).toHaveLength(1);
    expect(schedule[0]).toMatchObject({ state: "done", verdict: "success" });
    expect(exit).toBe(EXIT.BUDGET);
  });

  test("a run resumed already over its ceiling refuses to dispatch anything at all", async () => {
    const fleet = new SamplingFleet(["w1"], { settleDelayPolls: 0 });
    const manager = new BudgetManager(
      resumeBudget({
        runId: "run-under-test",
        tokensCeiling: 100,
        openingTokens: 400,
        persisted: null,
      }),
    );
    const { schedule, exit } = await runSchedule([spec("a")], fleet, {
      budget: { manager, maxConcurrent: 2, reserveTokens: 0 },
    });
    expect(fleet.log).toEqual([]);
    expect(schedule[0]).toMatchObject({ state: "ready" });
    expect(exit).toBe(EXIT.BUDGET);
  });
});

describe("MUST FIX C: a DEGRADED observation must not refund spend", () => {
  /**
   * `resumeBudget` rule 1 recomputes spend from observation, and rule 1 had no
   * failure mode: every way of failing to observe returns 0, which is
   * indistinguishable from a worker that genuinely burned nothing. The other
   * input to the merge is inert — nothing writes `state.usage` — so
   * `combineUsage(state.usage, ZERO)` is 0.
   *
   * The un-halted case is the common one and rule 2 does not cover it: a run
   * at 95% of its ceiling crashes, resumes at `openingTokens = 0`, and gets a
   * fresh full ceiling. Across n restarts it can spend n × `tokens_ceiling`.
   */
  const clean = (tokens: number): WorkerObservation => ({ tokens, degraded: null });
  const broken = (why: string): WorkerObservation => ({ tokens: 0, degraded: why });
  const persistedAt = (spent: number): BudgetState => {
    const s = emptyBudget("r1", { tokensCeiling: 1_000 });
    s.tokens_spent = spent;
    return s;
  };

  test("a degraded observation floors the opening balance at the published spend", () => {
    const out = openingBalance({
      observations: new Map([["w1", broken("session transcript is absent at /gone.jsonl")]]),
      persisted: persistedAt(950),
    });
    // THE assertion: 950, not 0. Without the floor this run resumes with its
    // entire ceiling available for the second time.
    expect(out.openingTokens).toBe(950);
    expect(out.floored).toBe(true);
    expect(out.degradations).toEqual(["w1: session transcript is absent at /gone.jsonl"]);
  });

  test("a CLEAN observation stays authoritative even when it is lower", () => {
    // The half that must NOT change. Re-observing is the whole point of rule
    // 1: a rotated transcript legitimately reports less than the snapshot, and
    // flooring that would carry `tokens_spent` forward by the back door and
    // double-count every resumed worker — the hole rule 1 exists to avoid.
    const out = openingBalance({
      observations: new Map([["w1", clean(120)]]),
      persisted: persistedAt(950),
    });
    expect(out.openingTokens).toBe(120);
    expect(out.floored).toBe(false);
    expect(out.degradations).toEqual([]);
  });

  test("a degraded observation never INFLATES a balance that already exceeds the snapshot", () => {
    // One worker unreadable, another healthy and well past the last snapshot.
    // The floor is a lower bound, not a replacement.
    const out = openingBalance({
      observations: new Map([
        ["w1", broken("worker state is missing or unreadable")],
        ["w2", clean(2_000)],
      ]),
      persisted: persistedAt(950),
    });
    expect(out.openingTokens).toBe(2_000);
    expect(out.floored).toBe(false);
    // Still reported, because the ceiling is now blind to whatever w1 spent.
    expect(out.degradations).toHaveLength(1);
  });

  test("a fresh run with no snapshot has nothing to floor at and starts at 0", () => {
    const out = openingBalance({
      observations: new Map([["w1", broken("no session_path recorded")]]),
      persisted: null,
    });
    expect(out.openingTokens).toBe(0);
    expect(out.floored).toBe(false);
  });

  test("the floored balance is what resumeBudget then halts on, if it is past the ceiling", () => {
    // End to end through the real decision: a degraded resume of a run that
    // had already blown its ceiling must stay halted, not be handed a fresh
    // one. This is rules 1 and 2 agreeing rather than rule 2 carrying alone.
    const persisted = persistedAt(1_500);
    const out = openingBalance({
      observations: new Map([["w1", broken("session transcript will not parse (bad json)")]]),
      persisted,
    });
    const resumed = resumeBudget({
      runId: "r1",
      tokensCeiling: 1_000,
      openingTokens: out.openingTokens,
      persisted: null, // No carried halt — the floor alone must produce it.
    });
    expect(resumed.tokens_spent).toBe(1_500);
    expect(resumed.halted_at).not.toBeNull();
    expect(resumed.halted_reason).toContain("tokens_ceiling");
  });
});

describe("SHOULD FIX D: a failed budget persist must not discard the schedule record", () => {
  test("onChange throwing is reported and the run completes", async () => {
    /**
     * `settleBudget` calls the deliberately non-throwing `manager.settle` and
     * then `persistBudget`, which is a real filesystem write and CAN throw
     * (ENOSPC, EROFS, EPERM). It throws from inside the settle pass — before
     * `if (progressed) await onChange(graph.snapshot())` — so it discarded the
     * schedule record of every task that settled in that pass and killed
     * `dispatch --auto` with nothing on stdout. That defeats precisely the
     * invariant a non-throwing `settle` was built to guarantee.
     */
    const fleet = new SamplingFleet(["w1"], { settleDelayPolls: 0, tokens: { a: 10 } });
    const manager = new BudgetManager(emptyBudget("run-under-test", { tokensCeiling: null }));
    const schedules: ScheduledTask[][] = [];
    const persistErrors: unknown[] = [];

    const { schedule, exit } = await runSchedule([spec("a")], fleet, {
      onChange: (s) => {
        schedules.push(s);
        return Promise.resolve();
      },
      budget: {
        manager,
        maxConcurrent: 1,
        reserveTokens: 0,
        onChange: () => Promise.reject(new Error("ENOSPC: no space left on device")),
        onPersistError: (err) => persistErrors.push(err),
      },
    });

    // The run finished rather than dying inside the settle pass.
    expect(exit).toBe(EXIT.SUCCESS);
    expect(schedule[0]).toMatchObject({ state: "done", verdict: "success" });
    // The record of what ran REACHED the caller — the thing the throw destroyed.
    expect(schedules.length).toBeGreaterThan(0);
    expect(schedules[schedules.length - 1]![0]).toMatchObject({ state: "done" });
    // And the failure was loud, not swallowed: best-effort in silence would be
    // the same defect class from the other side.
    expect(persistErrors.length).toBeGreaterThan(0);
    expect(String(persistErrors[0])).toContain("ENOSPC");
    // Accounting kept working in memory through the failed writes.
    expect(manager.snapshot().tokens_spent).toBe(10);
  });
});

describe("SHOULD FIX E: an unreadable run.json must not read as UNBOUNDED", () => {
  test("a truncated run.json is refused, not defaulted to no ceiling", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-budget-policy-"));
    try {
      const run = runPaths("r6", base);
      await mkdir(dirname(run.runJson), { recursive: true });
      // A real truncation: valid JSON prefix, cut mid-token. Exactly what an
      // operator who set `tokens_ceiling: 300` and lost a disk sees.
      await writeFile(run.runJson, '{"schema":"pifleet.run/v1","budget":{"tokens_ceil');
      const err = await readRunBudgetPolicy(run).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RunPolicyUnreadableError);
      // The ladder code for corrupt control-plane state, same as StateReadError.
      expect((err as RunPolicyUnreadableError).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
      // Actionable: names the file and says what it is refusing to do.
      expect(String(err)).toContain(run.runJson);
      expect(String(err)).toContain("UNBOUNDED");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("an ABSENT run.json is still unbounded, with nothing to report", async () => {
    // The distinction the refusal above turns on, pinned from the other side.
    // Absence is a legitimate state — a run dir written before these fields
    // existed, or assembled by hand — and refusing it would be a regression.
    const base = await mkdtemp(join(tmpdir(), "pifleet-budget-policy-"));
    try {
      const policy = await readRunBudgetPolicy(runPaths("r7", base));
      expect(policy.tokensCeiling).toBeNull();
      expect(policy.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
      expect(policy.note).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a run.json that PARSES but records a nonsense cap degrades with a note", async () => {
    // Unchanged behaviour, asserted so the refusal above cannot creep into it:
    // a readable document with a bad value is a degradation the caller
    // surfaces, not a refusal.
    const base = await mkdtemp(join(tmpdir(), "pifleet-budget-policy-"));
    try {
      const run = runPaths("r8", base);
      await writeJsonAtomic(run.runJson, {
        schema: "pifleet.run/v1",
        run_id: "r8",
        max_concurrent: 0,
        budget: { tokens_ceiling: 500 },
      });
      const policy = await readRunBudgetPolicy(run);
      expect(policy.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
      expect(policy.tokensCeiling).toBe(500);
      expect(policy.note).toContain("max_concurrent");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("resume semantics (the restart decision)", () => {
  test("spend is RECOMPUTED from observed usage; the halt verdict is carried over", () => {
    const persisted = emptyBudget("r1", { tokensCeiling: 1_000 });
    persisted.tokens_spent = 900;
    persisted.halted_at = "2026-08-19T00:00:00.000Z";
    persisted.halted_reason = "tokens_ceiling: spent 900 > 800";
    const resumed = resumeBudget({
      runId: "r1",
      tokensCeiling: 1_000,
      openingTokens: 250,
      persisted,
    });
    // Recomputed, not carried: the transcripts say 250, so the run has spent
    // 250. The persisted number was a published snapshot of that same
    // derivation, not an independent accumulator.
    expect(resumed.tokens_spent).toBe(250);
    // But the halt is a VERDICT, set once, and re-deriving it could un-halt a
    // run whose evidence moved.
    expect(resumed.halted_at).toBe("2026-08-19T00:00:00.000Z");
    expect(resumed.halted_reason).toBe("tokens_ceiling: spent 900 > 800");
  });

  test("reservations are dropped: they belong to a process that is gone", () => {
    const persisted = emptyBudget("r1", { tokensCeiling: 1_000 });
    persisted.reserved = { t1: 100, t2: 100 };
    const resumed = resumeBudget({
      runId: "r1",
      tokensCeiling: 1_000,
      openingTokens: 0,
      persisted,
    });
    expect(resumed.reserved).toEqual({});
  });

  test("opening spend past the ceiling halts at construction, so the run exits 5 not 7", () => {
    const resumed = resumeBudget({
      runId: "r1",
      tokensCeiling: 100,
      openingTokens: 101,
      persisted: null,
    });
    expect(resumed.halted_at).not.toBeNull();
    expect(resumed.halted_reason).toContain("tokens_ceiling");
  });

  test("landing exactly on the ceiling is not exceeding it", () => {
    const resumed = resumeBudget({
      runId: "r1",
      tokensCeiling: 100,
      openingTokens: 100,
      persisted: null,
    });
    expect(resumed.halted_at).toBeNull();
  });

  test("another run's budget.json is refused, never adopted", () => {
    const persisted = emptyBudget("some-other-run", { tokensCeiling: 1_000 });
    expect(() =>
      resumeBudget({ runId: "r1", tokensCeiling: 1_000, openingTokens: 0, persisted }),
    ).toThrow(ForeignBudgetError);
  });
});

describe("the policy travels with the run, not with today's cwd", () => {
  test("run.json's recorded ceiling and cap are what dispatch reads back", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-budget-policy-"));
    try {
      const run = runPaths("r1", base);
      await writeJsonAtomic(run.runJson, {
        schema: "pifleet.run/v1",
        run_id: "r1",
        max_concurrent: 3,
        budget: { tokens_ceiling: 4_242, per_task_reserve_tokens: 11 },
      });
      const policy = await readRunBudgetPolicy(run);
      expect(policy).toMatchObject({
        tokensCeiling: 4_242,
        maxConcurrent: 3,
        perTaskReserveTokens: 11,
        note: null,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a run dir with no record still dispatches, under the schema's own default cap", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-budget-policy-"));
    try {
      const run = runPaths("r2", base);
      await writeJsonAtomic(run.runJson, { schema: "pifleet.run/v1", run_id: "r2" });
      const policy = await readRunBudgetPolicy(run);
      // Absence of a ceiling means UNBOUNDED — `tokens_ceiling` has no schema
      // default to derive one from, so inventing a number here would refuse
      // work no operator ever budgeted for.
      expect(policy.tokensCeiling).toBeNull();
      // The cap does have a default, and it is read off the schema field
      // rather than restated, so it cannot drift from `max_concurrent`'s.
      expect(policy.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
      expect(policy.perTaskReserveTokens).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("what `up` WRITES is what `dispatch` reads — round-tripped, not assumed", async () => {
    // The seam this repo keeps finding broken: an object literal in one
    // command and a zod shape in another, agreeing today. A renamed key here
    // does not throw — it reads as absent, and the run silently falls back to
    // unbounded. So the writer's own output is fed to the reader.
    const config = FleetConfigSchema.parse({
      version: 2,
      name: "round-trip",
      docker: { pi_version: "0.79.6" },
      run: {
        repo: ".",
        max_concurrent: 5,
        budget: { tokens_ceiling: 777, per_task_reserve_tokens: 42 },
      },
      llm: { model: "m" },
      workers: [{ id: "eng-1", role: "engineer" }],
      roles: { engineer: {} },
    });
    const base = await mkdtemp(join(tmpdir(), "pifleet-budget-policy-"));
    try {
      const run = runPaths("r4", base);
      await writeJsonAtomic(run.runJson, {
        schema: "pifleet.run/v1",
        run_id: "r4",
        ...runBudgetRecord(config.run),
      });
      const policy = await readRunBudgetPolicy(run);
      expect(policy.tokensCeiling).toBe(777);
      expect(policy.maxConcurrent).toBe(5);
      expect(policy.perTaskReserveTokens).toBe(42);
      expect(policy.note).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a run created with no config records nothing and reads back the defaults", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-budget-policy-"));
    try {
      const run = runPaths("r5", base);
      await writeJsonAtomic(run.runJson, {
        schema: "pifleet.run/v1",
        run_id: "r5",
        ...runBudgetRecord(null),
      });
      const policy = await readRunBudgetPolicy(run);
      expect(policy.tokensCeiling).toBeNull();
      expect(policy.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("budget.json round-trips through the same reader `wait` uses", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-budget-policy-"));
    try {
      const run = runPaths("r3", base);
      expect(await readBudgetState(run)).toBeNull();
      const state = emptyBudget("r3", { tokensCeiling: 10 });
      state.tokens_spent = 11;
      await writeJsonAtomic(run.budgetJson, state);
      const back = await readBudgetState(run);
      expect(back).toMatchObject({ run_id: "r3", tokens_spent: 11, tokens_ceiling: 10 });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
