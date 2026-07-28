/**
 * The scheduler loop (SRD §9.3, §14), against a scripted fake fleet.
 *
 * Every test records the ORDER of dispatches, because ordering is the
 * requirement under test: same list + same workers must produce the same
 * dispatch sequence, with ties broken by task-list position and worker
 * assignment by sorted worker id. The propagation tests assert the negative
 * — that a blocked task's dispatch NEVER appears in the log — since a
 * scheduler that dispatches everything and lets the verdicts sort it out
 * would pass any state-only assertion.
 */

import { describe, expect, test } from "bun:test";
import { EXIT, TaskSpecSchema, type TaskSpec, type Verdict } from "../../src/contracts.ts";
import {
  SchedulerError,
  runSchedule,
  type DispatchAnswer,
  type SchedulerIO,
  type WorkerHealth,
} from "../../src/orchestrate/scheduler.ts";

function spec(id: string, deps: string[] = [], extra: Record<string, unknown> = {}): TaskSpec {
  return TaskSpecSchema.parse({ id, title: id, brief: `do ${id}`, depends_on: deps, ...extra });
}

interface TaskScript {
  /** Verdict the task record reports once it settles. */
  verdict?: Verdict;
  reason?: string;
  /** readSettled calls that return null before the record appears. */
  settleDelayPolls?: number;
  /**
   * Scripted dispatch answers, consumed per attempt; once exhausted the
   * default accept-then-settle behaviour applies — so a retry after an
   * `unreachable` can proceed normally.
   */
  answers?: DispatchAnswer[];
  /** The worker dies mid-task: no record ever appears, health goes dead. */
  killsWorker?: boolean;
}

interface FleetOpts {
  /** Per-worker health sequences; consumed per probe, last value repeats. */
  health?: Record<string, WorkerHealth[]>;
  tasks?: Record<string, TaskScript>;
}

/**
 * A fleet that exists only as bookkeeping. Deliberately synchronous inside:
 * the determinism under test must come from the scheduler's own ordering,
 * not from a fake that serialises for it.
 */
class FakeFleet implements SchedulerIO {
  readonly log: string[] = [];
  readonly #health = new Map<string, WorkerHealth[]>();
  readonly #healthCursor = new Map<string, number>();
  readonly #tasks: Record<string, TaskScript>;
  /** taskId -> polls remaining until the record appears (null = never). */
  readonly #settling = new Map<string, number | null>();
  readonly #dead = new Set<string>();

  constructor(workers: string[], opts: FleetOpts = {}) {
    for (const w of workers) this.#health.set(w, opts.health?.[w] ?? ["idle"]);
    this.#tasks = opts.tasks ?? {};
  }

  listWorkers(): Promise<string[]> {
    return Promise.resolve([...this.#health.keys()]);
  }

  workerHealth(worker: string): Promise<WorkerHealth> {
    if (this.#dead.has(worker)) return Promise.resolve("dead");
    const seq = this.#health.get(worker) ?? ["dead"];
    const i = this.#healthCursor.get(worker) ?? 0;
    this.#healthCursor.set(worker, i + 1);
    return Promise.resolve(seq[Math.min(i, seq.length - 1)]!);
  }

  dispatch(specArg: TaskSpec, worker: string, taskId: string): Promise<DispatchAnswer> {
    this.log.push(`dispatch:${specArg.id}->${worker}`);
    const script = this.#tasks[specArg.id] ?? {};
    const scripted = script.answers?.shift();
    if (scripted !== undefined) return Promise.resolve(scripted);
    if (script.killsWorker === true) {
      this.#dead.add(worker);
      this.#settling.set(taskId, null);
    } else {
      this.#settling.set(taskId, script.settleDelayPolls ?? 0);
    }
    return Promise.resolve({ kind: "accepted", epoch: 1 });
  }

  readSettled(
    _worker: string,
    taskId: string,
  ): Promise<{ verdict: Verdict; reason: string } | null> {
    const left = this.#settling.get(taskId);
    if (left === undefined || left === null) return Promise.resolve(null);
    if (left > 0) {
      this.#settling.set(taskId, left - 1);
      return Promise.resolve(null);
    }
    this.#settling.delete(taskId);
    const script = this.#tasks[taskId] ?? {};
    this.log.push(`settled:${taskId}`);
    return Promise.resolve({ verdict: script.verdict ?? "success", reason: script.reason ?? "" });
  }

  sleep(): Promise<void> {
    // Resolve immediately: these tests exercise ordering, not wall clocks.
    // Every sleep advances the fake clock instead, so the stall timeout is
    // reachable in a test without waiting ten real minutes for it.
    this.clockMs += 1_000;
    return Promise.resolve();
  }

  /** Injected clock: no test may depend on how fast the machine ran it. */
  clockMs = 0;
  now(): number {
    return this.clockMs;
  }
}

describe("assignment order is deterministic (requirement 6)", () => {
  test("ties break on task-list order onto sorted workers, repeatably", async () => {
    const run = async () => {
      // Workers listed UNSORTED: if the scheduler trusted enumeration order,
      // t1 would land on w2 and this test is what catches it.
      const fleet = new FakeFleet(["w2", "w1"]);
      const out = await runSchedule([spec("t1"), spec("t2"), spec("t3")], fleet);
      return { fleet, out };
    };
    const a = await run();
    const b = await run();

    // First pass: t1 -> w1, t2 -> w2 (list order onto sorted idle workers);
    // t3 waits for a free worker, then takes the first idle one.
    expect(a.fleet.log.filter((l) => l.startsWith("dispatch:")).slice(0, 2)).toEqual([
      "dispatch:t1->w1",
      "dispatch:t2->w2",
    ]);
    expect(a.fleet.log).toEqual(b.fleet.log);
    expect(a.out.schedule).toEqual(b.out.schedule);
    expect(a.out.exit).toBe(EXIT.SUCCESS);
    for (const t of a.out.schedule) {
      expect(t.state).toBe("done");
      expect(t.verdict).toBe("success");
    }
  });
});

describe("dependencies gate dispatch (requirement 1)", () => {
  test("a dependent is not dispatched until its dependency settles", async () => {
    const fleet = new FakeFleet(["w1", "w2"], {
      tasks: { a: { settleDelayPolls: 2 } },
    });
    await runSchedule([spec("a"), spec("b", ["a"])], fleet);
    const aSettled = fleet.log.indexOf("settled:a");
    const bDispatched = fleet.log.indexOf("dispatch:b->w1");
    expect(aSettled).toBeGreaterThanOrEqual(0);
    expect(bDispatched).toBeGreaterThan(aSettled);
    // And never early: w2 was idle the whole time, so only readiness — not
    // worker scarcity — can explain the wait.
    expect(fleet.log.filter((l) => l.startsWith("dispatch:b"))).toHaveLength(1);
  });
});

describe("failure propagation (requirement 2)", () => {
  test("A fails -> B and C are never dispatched, each blocked by A", async () => {
    const fleet = new FakeFleet(["w1"], { tasks: { a: { verdict: "failed" } } });
    const { schedule, exit } = await runSchedule(
      [spec("a"), spec("b", ["a"]), spec("c", ["b"])],
      fleet,
    );
    // The negative is the test: a scheduler that dispatches blocked tasks
    // and lets their verdicts clean up would satisfy every state assertion.
    expect(fleet.log.filter((l) => l.startsWith("dispatch:"))).toEqual(["dispatch:a->w1"]);
    const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));
    expect(byId["b"]).toMatchObject({ state: "blocked", blocked_by: "a" });
    expect(byId["c"]).toMatchObject({ state: "blocked", blocked_by: "a" });
    expect(exit).toBe(EXIT.PARTIAL);
  });

  test("an independent sibling still runs to completion after a failure", async () => {
    const fleet = new FakeFleet(["w1"], { tasks: { a: { verdict: "failed" } } });
    const { schedule } = await runSchedule([spec("a"), spec("b", ["a"]), spec("d")], fleet);
    const d = schedule.find((t) => t.id === "d")!;
    expect(d.state).toBe("done");
    expect(d.verdict).toBe("success");
  });
});

describe("pinned workers (requirement 5)", () => {
  test("a pin waits for ITS worker even while another sits idle", async () => {
    const fleet = new FakeFleet(["w1", "w2"], {
      health: { w2: ["busy", "busy", "idle"] },
    });
    const { schedule } = await runSchedule(
      [spec("p", [], { worker: "w2" }), spec("free")],
      fleet,
    );
    const dispatches = fleet.log.filter((l) => l.startsWith("dispatch:"));
    // 'free' overtakes 'p' on w1; 'p' lands on w2 and nowhere else, ever.
    expect(dispatches).toContain("dispatch:free->w1");
    expect(dispatches).toContain("dispatch:p->w2");
    expect(dispatches).not.toContain("dispatch:p->w1");
    expect(schedule.find((t) => t.id === "p")!.worker).toBe("w2");
  });

  test("a pin to a worker outside the fleet refuses before ANY dispatch", async () => {
    const fleet = new FakeFleet(["w1"]);
    const err = await runSchedule([spec("ok"), spec("p", [], { worker: "ghost" })], fleet).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SchedulerError);
    expect((err as SchedulerError).exitCode).toBe(EXIT.USAGE);
    expect((err as SchedulerError).message).toContain("'p'");
    expect((err as SchedulerError).message).toContain("'ghost'");
    // Refused up front: 'ok' was ready and runnable, and running it before
    // noticing the bad pin is the half-dispatched-list failure mode.
    expect(fleet.log).toEqual([]);
  });

  test("a pin to a worker that died is a named WORKER_DIED refusal, not a hang", async () => {
    // 'a' kills w2; 'p' is independent and pinned to the corpse. Without the
    // refusal the scheduler would poll for w2 to come back forever — the
    // §9.3 hold-forever this diagnosis exists to prevent.
    const fleet = new FakeFleet(["w1", "w2"], {
      tasks: { a: { killsWorker: true } },
    });
    const err = await runSchedule(
      [spec("a", [], { worker: "w2" }), spec("p", [], { worker: "w2" })],
      fleet,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SchedulerError);
    expect((err as SchedulerError).exitCode).toBe(EXIT.WORKER_DIED);
    expect((err as SchedulerError).message).toContain("'p'");
    expect((err as SchedulerError).message).toContain("'w2'");
  });
});

describe("worker death mid-task", () => {
  test("no record + dead supervisor -> unknown/worker_died; the fleet shrinks and finishes", async () => {
    const fleet = new FakeFleet(["w1", "w2"], { tasks: { a: { killsWorker: true } } });
    const { schedule, exit } = await runSchedule(
      // 'a' takes w1 (first idle, list order); 'b' and 'c' outlive it on w2.
      [spec("a"), spec("b"), spec("c", ["b"]), spec("d", ["a"])],
      fleet,
    );
    const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));
    // `unknown`, never an invented failure: absence of the supervisor is the
    // only evidence there is (same rule as `wait`).
    expect(byId["a"]).toMatchObject({ state: "done", verdict: "unknown", worker: "w1" });
    // Dependents of the dead task block on it, naming it.
    expect(byId["d"]).toMatchObject({ state: "blocked", blocked_by: "a" });
    // Unrelated work re-routes to the survivor and completes.
    expect(byId["b"]).toMatchObject({ state: "done", verdict: "success", worker: "w2" });
    expect(byId["c"]).toMatchObject({ state: "done", verdict: "success", worker: "w2" });
    expect(fleet.log).not.toContain("dispatch:b->w1");
    // WORKER_DIED outranks PARTIAL on the §10 ladder.
    expect(exit).toBe(EXIT.WORKER_DIED);
  });

  test("every worker dead with tasks pending is a WORKER_DIED refusal, not a hang", async () => {
    const fleet = new FakeFleet(["w1"], { tasks: { a: { killsWorker: true } } });
    const err = await runSchedule([spec("a"), spec("b")], fleet).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SchedulerError);
    expect((err as SchedulerError).exitCode).toBe(EXIT.WORKER_DIED);
    expect((err as SchedulerError).message).toContain("b");
  });
});

describe("dispatch-time answers", () => {
  test("already_completed settles with the recorded verdict and unblocks dependents", async () => {
    const fleet = new FakeFleet(["w1"], {
      tasks: { a: { answers: [{ kind: "already_completed", verdict: "success" }] } },
    });
    const { schedule, exit } = await runSchedule([spec("a"), spec("b", ["a"])], fleet);
    const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));
    // The replay IS the settle: no task record is ever polled for 'a'.
    expect(fleet.log).not.toContain("settled:a");
    expect(byId["a"]).toMatchObject({ state: "done", verdict: "success", worker: "w1" });
    expect(byId["b"]).toMatchObject({ state: "done", verdict: "success" });
    expect(exit).toBe(EXIT.SUCCESS);
  });

  test("a rejected prompt fails the task at the door; dependents block on it", async () => {
    const fleet = new FakeFleet(["w1"], {
      tasks: { a: { answers: [{ kind: "rejected", reason: "prompt_rejected" }] } },
    });
    const { schedule, exit } = await runSchedule([spec("a"), spec("b", ["a"]), spec("c")], fleet);
    const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));
    expect(byId["a"]).toMatchObject({ state: "done", verdict: "failed" });
    expect(byId["b"]).toMatchObject({ state: "blocked", blocked_by: "a" });
    // The WORKER survived a rejection — 'c' still runs on it.
    expect(byId["c"]).toMatchObject({ state: "done", verdict: "success", worker: "w1" });
    expect(exit).toBe(EXIT.PARTIAL);
  });

  test("an unreachable worker loses the task to a survivor, not to oblivion", async () => {
    // One scripted refusal, then the default accept: the first dispatch (to
    // w1, the first sorted idle worker) hits the dead socket; the retry must
    // land on w2, and w1 must never be offered work again.
    const fleet = new FakeFleet(["w1", "w2"], {
      tasks: { a: { answers: [{ kind: "unreachable", detail: "socket gone" }] } },
    });
    const { schedule, exit } = await runSchedule([spec("a")], fleet);
    expect(fleet.log.filter((l) => l.startsWith("dispatch:a"))).toEqual([
      "dispatch:a->w1",
      "dispatch:a->w2",
    ]);
    expect(schedule[0]).toMatchObject({ state: "done", worker: "w2" });
    // No task was lost, so no task-level failure reaches the ladder.
    expect(exit).toBe(EXIT.SUCCESS);
  });
});

describe("onChange keeps a durable record current while the run is live", () => {
  test("fires before the first dispatch, after every transition batch, ending terminal", async () => {
    const fleet = new FakeFleet(["w1"], { tasks: { a: { verdict: "failed" } } });
    const snapshots: string[][] = [];
    await runSchedule([spec("a"), spec("b", ["a"])], fleet, {
      onChange: (s) => {
        snapshots.push(s.map((t) => `${t.id}:${t.state}`));
        return Promise.resolve();
      },
    });
    // The INITIAL states are on the record before anything runs: a reporter
    // reading mid-run must be able to tell "waiting on a dependency" from
    // "the scheduler never saw this task".
    expect(snapshots[0]).toEqual(["a:ready", "b:waiting"]);
    // A dispatch is a transition; so is a settle and the blocked propagation
    // it triggers. Both appear, in order.
    expect(snapshots).toContainEqual(["a:dispatched", "b:waiting"]);
    expect(snapshots.at(-1)).toEqual(["a:done", "b:blocked"]);
  });

  test("a no-op poll iteration writes nothing — the record changes only when state does", async () => {
    const fleet = new FakeFleet(["w1"], { tasks: { a: { settleDelayPolls: 5 } } });
    let calls = 0;
    await runSchedule([spec("a")], fleet, {
      onChange: () => {
        calls++;
        return Promise.resolve();
      },
    });
    // initial + dispatch + settle. Five empty polls happened in between; a
    // scheduler that rewrites the file every poll turns the durable record
    // into disk churn scaled by poll rate.
    expect(calls).toBe(3);
  });
});

describe("exit ladder over terminal states (SRD §10)", () => {
  test("timed_out maps to TIMEOUT and outranks the blocked dependents' PARTIAL", async () => {
    const fleet = new FakeFleet(["w1"], { tasks: { a: { verdict: "timed_out" } } });
    const { exit } = await runSchedule([spec("a"), spec("b", ["a"])], fleet);
    // Ladder order: 4 (timeout) outranks 7 (partial), per worstExit.
    expect(exit).toBe(EXIT.TIMEOUT);
  });

  test("an empty fleet is a usage refusal", async () => {
    const fleet = new FakeFleet([]);
    const err = await runSchedule([spec("a")], fleet).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SchedulerError);
    expect((err as SchedulerError).exitCode).toBe(EXIT.USAGE);
  });
});

/**
 * Two ways `dispatch --auto` failed to hold the line, both found by review
 * rather than by the suite, and both about doubt rather than about failure.
 */
describe("a dispatch whose outcome is unknown is never retried elsewhere", () => {
  /**
   * The control socket's default timeout is 5s and `sendTaskEnvelope` wrapped
   * every rejection — including a timeout — as "unreachable". The scheduler
   * read that as "the task is untouched" and offered it to the next idle
   * worker. But a timeout is not evidence of non-delivery: the supervisor may
   * have accepted the envelope, persisted its fence and started the agent,
   * and merely replied late. The dedup that should stop the second run is
   * per-supervisor, so a second worker has never seen the attempt and accepts
   * it — two agents on one brief and one branch.
   */
  test("an in-doubt dispatch settles unknown instead of moving to another worker", async () => {
    const fleet = new FakeFleet(["w1", "w2"], {
      tasks: { t1: { answers: [{ kind: "in_doubt", detail: "no response in 5000ms" }] } },
    });
    const out = await runSchedule([spec("t1")], fleet);
    const t1 = out.schedule.find((t) => t.id === "t1");
    expect(t1?.state).toBe("done");
    // `unknown`, never an invented failure and never a silent success.
    expect(t1?.verdict).toBe("unknown");
    // The assertion that matters: exactly ONE dispatch happened.
    expect(fleet.log.filter((l) => l.startsWith("dispatch:t1"))).toHaveLength(1);
  });

  /**
   * The positive control. A PROVABLE non-delivery — the socket never opened,
   * so nothing saw the envelope — must still be retried, or a single dead
   * worker would strand every task the fleet had left.
   */
  test("a provable non-delivery is still retried on a surviving worker", async () => {
    const fleet = new FakeFleet(["w1", "w2"], {
      tasks: { t1: { answers: [{ kind: "unreachable", detail: "connect failed: ENOENT" }] } },
    });
    const out = await runSchedule([spec("t1")], fleet);
    const t1 = out.schedule.find((t) => t.id === "t1");
    expect(t1?.state).toBe("done");
    expect(t1?.verdict).toBe("success");
    expect(fleet.log.filter((l) => l.startsWith("dispatch:t1")).length).toBeGreaterThan(1);
  });
});

describe("a stalled fleet is refused rather than polled forever", () => {
  /**
   * The deadlock guard only fired when EVERY worker was dead. A supervisor
   * whose process is alive but wedged reports `busy` for ever, nothing
   * settles, and there was no budget, no iteration cap and no output — the
   * §9.3 deadlock surviving in the one branch the guard did not cover.
   */
  test("no progress for the stall budget throws, naming what is stuck", async () => {
    // Settles never: the record never appears and the worker stays alive.
    const fleet = new FakeFleet(["w1"], { tasks: { t1: { settleDelayPolls: 1_000_000 } } });
    await expect(
      runSchedule([spec("t1")], fleet, { stallTimeoutMs: 5_000 }),
    ).rejects.toThrow(/no progress/);
  });

  test("the refusal names the in-flight task and its worker", async () => {
    const fleet = new FakeFleet(["w1"], { tasks: { t1: { settleDelayPolls: 1_000_000 } } });
    // A bare "timed out" would send the operator looking through every
    // worker; the point of the diagnosis is to say which one to look at.
    await expect(
      runSchedule([spec("t1")], fleet, { stallTimeoutMs: 5_000 }),
    ).rejects.toThrow(/t1 on w1/);
  });

  /**
   * The positive control: a run that is slow but progressing must not be cut
   * off. Without this, a stall timeout that fired on elapsed time rather than
   * on time-since-progress would pass both tests above and break every long
   * fleet.
   */
  test("a slow but progressing schedule is not cut off by the stall budget", async () => {
    const fleet = new FakeFleet(["w1"], {
      tasks: {
        t1: { settleDelayPolls: 4 },
        t2: { settleDelayPolls: 4 },
        t3: { settleDelayPolls: 4 },
      },
    });
    // Each task takes 4 polls (4s on the fake clock) — comfortably more than
    // the budget in TOTAL, but never that long without something changing.
    const out = await runSchedule([spec("t1"), spec("t2"), spec("t3")], fleet, {
      stallTimeoutMs: 5_000,
    });
    expect(out.schedule.every((t) => t.state === "done")).toBe(true);
  });
});
