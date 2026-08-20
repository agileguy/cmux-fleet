/**
 * The per-worker stall policy ON THE SCHEDULER'S PATH (ISC-110, ISC-117).
 *
 * `test/unit/kill.test.ts` already covers `classifyStall` as a function, and
 * the ISA is explicit that this is not the same thing: "A unit test over a
 * callerless module proves the module, not the criterion." Every test here
 * drives the real `runSchedule`, so what it measures is whether a verdict
 * reaches a worker — which is the half that had no evidence.
 *
 * The clock is injected (`FakeFleet.now`/`sleep`), so `event_stall_kill` is
 * reachable without waiting twenty-five real minutes for it.
 */
import { describe, expect, test } from "bun:test";
import { TaskSpecSchema, type TaskSpec, type Verdict } from "../../src/contracts.ts";
import { BudgetManager, emptyBudget } from "../../src/safety/budget.ts";
import {
  runSchedule,
  type DispatchAnswer,
  type SchedulerIO,
  type WorkerHealth,
} from "../../src/orchestrate/scheduler.ts";

const spec = (id: string): TaskSpec =>
  TaskSpecSchema.parse({ id, title: id, brief: `do ${id}`, depends_on: [] });

const WARN_MS = 3 * 60_000;
const KILL_MS = 25 * 60_000;

/**
 * A fleet whose tasks NEVER settle and whose workers are never `dead`.
 *
 * That combination is the wedged agent exactly: the supervisor answers, its
 * heartbeat is fine, `readSettled` keeps returning null, and nothing about the
 * worker's health says anything is wrong. Before the stall policy was on this
 * path, such a run could only end by exhausting the fleet-wide
 * `stallTimeoutMs` and reporting a TIMEOUT naming the whole run.
 */
class WedgedFleet implements SchedulerIO {
  readonly killed: Array<{ worker: string; taskId: string }> = [];
  readonly warned: Array<{ worker: string; taskId: string }> = [];
  readonly dispatched: string[] = [];
  /** Highest number of tasks outstanding at once — the admission gate's mark. */
  peakInFlight = 0;
  #outstanding = 0;
  clockMs = 0;
  /** Silence grows with the clock: every worker went quiet at t=0. */
  #silenceMs = 0;

  constructor(private readonly workers: string[]) {}

  listWorkers(): Promise<string[]> {
    return Promise.resolve([...this.workers]);
  }

  workerHealth(worker: string): Promise<WorkerHealth> {
    // Never "dead" — the supervisor is alive and answering. This is what
    // separates ISC-117 from the reaper's ISC-118 case.
    return Promise.resolve(
      this.killed.some((k) => k.worker === worker) ? "dead" : "idle",
    );
  }

  dispatch(s: TaskSpec, worker: string, _taskId: string): Promise<DispatchAnswer> {
    this.dispatched.push(`${s.id}->${worker}`);
    this.#outstanding += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.#outstanding);
    return Promise.resolve({ kind: "accepted", epoch: 1 });
  }

  readSettled(): Promise<{ verdict: Verdict; reason: string } | null> {
    return Promise.resolve(null); // never settles
  }

  eventSilenceMs(_worker: string): Promise<number | null> {
    return Promise.resolve(this.#silenceMs);
  }

  killWedged(worker: string, taskId: string): Promise<void> {
    this.killed.push({ worker, taskId });
    this.#outstanding -= 1;
    return Promise.resolve();
  }

  sleep(): Promise<void> {
    this.clockMs += 60_000;
    this.#silenceMs += 60_000;
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

describe("ISC-117: a wedged agent is killed at event_stall_kill", () => {
  /**
   * The criterion's verb is *is killed*, and before this wiring nothing killed
   * one — `classifyStall` had no caller anywhere in `src/`.
   *
   * Fails if: the verdict is computed but not acted on, or the task is left in
   * flight after the kill (which would re-create the indefinite wait).
   */
  test("a slot-holding worker silent past the window is killed and its task settled", async () => {
    const fleet = new WedgedFleet(["w1"]);
    const { schedule } = await runSchedule([spec("t1")], fleet, {
      budget: budgetFor(1),
      stall: { warnMs: WARN_MS, killMs: KILL_MS },
      // Above `killMs` deliberately. The two timeouts race, and with the
      // SHIPPED defaults the fleet-wide one wins: `DEFAULT_STALL_TIMEOUT_MS`
      // is 10 minutes and `event_stall_kill` is 25, so a fleet that goes
      // silent ALL AT ONCE ends as a run-level TIMEOUT before any per-worker
      // verdict is reached. That ordering is correct for a whole fleet going
      // quiet — the run really has stopped — and it is not the case this
      // criterion is about, which is ONE agent wedging while the rest of the
      // fleet keeps settling and keeps resetting `lastProgressMs`. Raising it
      // here isolates the per-worker path instead of re-measuring the
      // fleet-wide one.
      stallTimeoutMs: 60 * 60_000,
      onStallWarn: (worker, taskId) => {
        fleet.warned.push({ worker, taskId });
        return Promise.resolve();
      },
    });

    expect(fleet.killed).toEqual([{ worker: "w1", taskId: "t1" }]);
    // The task does not stay in flight: it settles on the evidence that
    // exists, which is absence of a record — `unknown`, never an invented
    // failure.
    expect(schedule.find((t) => t.id === "t1")).toMatchObject({
      state: "done",
      verdict: "unknown",
    });
    // Warned before killed, exactly once — the warn band is crossed on the way.
    expect(fleet.warned).toEqual([{ worker: "w1", taskId: "t1" }]);
  });

  /**
   * The window is READ, not hard-coded. A run configured with no stall window
   * behaves as every run did before this seam existed.
   *
   * Fails if: the policy engages on a default when none was configured.
   */
  test("no configured window means no worker is ever killed", async () => {
    const fleet = new WedgedFleet(["w1"]);
    await runSchedule([spec("t1")], fleet, {
      budget: budgetFor(1),
      stallTimeoutMs: 5 * 60_000, // ends the run instead, the old way
    }).catch(() => undefined);
    expect(fleet.killed).toEqual([]);
  });
});

describe("ISC-110: a queued worker is not killed as wedged", () => {
  /**
   * The criterion the `holdsSlot` discriminator exists for, and the one that
   * could not be tested at all until admission was on the dispatch path:
   * before that, `max_concurrent` was enforced only inside a callerless
   * module, every worker ran at once, and no worker was ever "queued behind
   * others" in the first place.
   *
   * Six tasks, two slots. Four are never admitted, so their work is queued —
   * and queued work must not be killed however long the fleet stays silent.
   * Killing it would be executing a worker for standing in the line we put it
   * in.
   *
   * Fails if: the stall policy reaches tasks that were never dispatched, or if
   * admission stops gating and all six go in flight together.
   */
  test("with max_concurrent 2, only admitted work is ever killed", async () => {
    const fleet = new WedgedFleet(["w1", "w2", "w3", "w4", "w5", "w6"]);
    await runSchedule(
      [spec("t1"), spec("t2"), spec("t3"), spec("t4"), spec("t5"), spec("t6")],
      fleet,
      {
        budget: budgetFor(2),
        stall: { warnMs: WARN_MS, killMs: KILL_MS },
        stallTimeoutMs: 60 * 60_000, // see the note on the ISC-117 test above
      },
    );

    /**
     * The invariant, and it is NOT "at most two are killed in total".
     *
     * Killing a wedged holder releases its slot, so the queue drains into the
     * freed slots and those tasks wedge in their turn — all six are killed
     * eventually, two at a time, which is the policy working rather than
     * failing. What must never happen is a kill reaching work that was never
     * admitted.
     *
     * Peak concurrency is the measurement that says so: with `max_concurrent`
     * 2, no more than two tasks are ever outstanding, so at every instant the
     * other four are QUEUED and none of them is killed while it waits.
     */
    expect(fleet.peakInFlight).toBeLessThanOrEqual(2);
    // Every kill landed on work that had actually been dispatched — a queued
    // task has no worker to kill and must never acquire one this way.
    const dispatchedTasks = new Set(fleet.dispatched.map((d) => d.split("->")[0]!));
    for (const k of fleet.killed) {
      expect(dispatchedTasks.has(k.taskId)).toBe(true);
    }
    // And the queue was real: six tasks could not have run two-at-a-time
    // without something having waited.
    expect(fleet.killed.length).toBeGreaterThan(2);
  });
});
