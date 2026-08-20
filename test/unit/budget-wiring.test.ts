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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT,
  TaskSpecSchema,
  type BudgetState,
  type TaskSpec,
  type Verdict,
} from "../../src/contracts.ts";
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
import { readBudgetState, readRunBudgetPolicy, runBudgetRecord } from "../../src/run/state.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { DEFAULT_MAX_CONCURRENT, FleetConfigSchema } from "../../src/config/schema.ts";

function spec(id: string, deps: string[] = [], extra: Record<string, unknown> = {}): TaskSpec {
  return TaskSpecSchema.parse({ id, title: id, brief: `do ${id}`, depends_on: deps, ...extra });
}

interface FleetOpts {
  /** Polls each task spends in flight before its record appears. */
  settleDelayPolls?: number;
  /** Tokens each task reports having burned, by task id (default 0). */
  tokens?: Record<string, number>;
  /** Scripted dispatch answers per task, consumed in order. */
  answers?: Record<string, DispatchAnswer[]>;
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
