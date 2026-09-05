/**
 * Recreate-then-dispatch, and the rule that it must never recreate over work.
 *
 * The ordering assertions carry the weight here. A recreate destroys the
 * worker's container, supervisor and worktree, so "did it wait?" and "did it
 * stop anything before refusing?" are not style questions — they are the
 * difference between a fresh session and a deleted task. Every refusal test
 * below therefore also asserts that `down` and `restartPane` were never
 * called, because a refusal that has already torn something down is not a
 * refusal.
 *
 * The staged case is the one that motivated the module. Measured 2026-09-04,
 * `tst-1` sat with `phase: "idle"`, `task_id: null` and a `staged_task_id` —
 * an envelope it had accepted and not yet run. Anything reading only `phase`
 * or only `task_id` calls that worker free and recreates over a task the
 * operator had already handed it.
 */
import { describe, expect, test } from "bun:test";

import {
  busyRefusal,
  recreateThenDispatch,
  settledEnough,
  workerActivity,
  type FreshDispatchDeps,
} from "../../src/run/fresh-dispatch.ts";

interface WorkerRow {
  id: string;
  alive?: boolean;
  phase?: string;
  task_id?: string | null;
  staged_task_id?: string | null;
}

const status = (runs: Array<{ run_id: string; workers: WorkerRow[] }>): string =>
  JSON.stringify({
    runs: runs.map((r) => ({
      run_id: r.run_id,
      workers: r.workers.map((w) => ({
        alive: true,
        phase: "idle",
        task_id: null,
        staged_task_id: null,
        ...w,
      })),
    })),
  });

const IDLE = status([{ run_id: "run-old", workers: [{ id: "tst-1" }] }]);
const FRESH = status([{ run_id: "run-new", workers: [{ id: "tst-1" }] }]);

interface Harness {
  deps: FreshDispatchDeps;
  calls: string[];
}

/** `reads` is consumed one entry per `status()` call; the last one repeats. */
function harness(reads: string[]): Harness {
  const calls: string[] = [];
  let i = 0;
  let clock = 0;
  return {
    calls,
    deps: {
      status: async () => {
        const r = reads[Math.min(i, reads.length - 1)] ?? IDLE;
        i += 1;
        calls.push("status");
        return r;
      },
      down: async (runId) => {
        calls.push(`down:${runId}`);
      },
      restartPane: async () => {
        calls.push("restartPane");
      },
      dispatch: async (runId) => {
        calls.push(`dispatch:${runId}`);
        return `accepted into ${runId}`;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
  };
}

describe("reading one worker's activity out of a fleet status", () => {
  test("a worker in no run has no activity", () => {
    expect(workerActivity(status([]), "tst-1")).toEqual([]);
  });

  test("a worker present in two runs yields both", () => {
    const a = workerActivity(
      status([
        { run_id: "r1", workers: [{ id: "tst-1" }] },
        { run_id: "r2", workers: [{ id: "tst-1", task_id: "T-9" }] },
      ]),
      "tst-1",
    );
    // Collapsing to the first entry would miss the task running in the second.
    expect(a.map((x) => x.runId)).toEqual(["r1", "r2"]);
  });

  test("unreadable status throws rather than reporting 'not busy'", () => {
    // The safe direction here is the opposite of `runsHoldingAny`'s: no
    // evidence must not green-light a teardown.
    expect(() => workerActivity("not json", "tst-1")).toThrow(/state is unknown/);
  });

  test("status with no runs array throws", () => {
    expect(() => workerActivity(JSON.stringify({}), "tst-1")).toThrow(/no runs array/);
  });
});

describe("what counts as settled", () => {
  const at = (o: Partial<ReturnType<typeof workerActivity>[number]>) => ({
    runId: "r",
    phase: "idle",
    taskId: null,
    stagedTaskId: null,
    alive: true,
    ...o,
  });

  test("idle with nothing held is settled", () => {
    expect(settledEnough(at({}))).toBe(true);
  });

  test("a running task is not settled", () => {
    expect(settledEnough(at({ taskId: "T-1", phase: "busy" }))).toBe(false);
  });

  test("a STAGED task is not settled, even though the phase reads idle", () => {
    // The measured shape. `phase` and `task_id` both say free; the worker is
    // holding an envelope it has accepted.
    expect(settledEnough(at({ phase: "idle", taskId: null, stagedTaskId: "T-3" }))).toBe(false);
  });

  test("an unrecognised phase is treated as busy, not as free", () => {
    expect(settledEnough(at({ phase: "unknown" }))).toBe(false);
  });
});

describe("a busy worker is waited for, and never recreated over", () => {
  test("it waits for a running task to finish, then recreates", async () => {
    const busy = status([{ run_id: "run-old", workers: [{ id: "tst-1", phase: "busy", task_id: "T-1" }] }]);
    const h = harness([busy, busy, IDLE, FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 1000 });

    expect(r.runId).toBe("run-new");
    expect(r.settleWaitMs).toBe(2000);
    // Nothing was torn down until after the task cleared.
    const firstDown = h.calls.indexOf("down:run-old");
    const lastBusyRead = 2; // two busy status reads precede the idle one
    expect(firstDown).toBeGreaterThan(lastBusyRead);
  });

  test("it waits for a STAGED task too, and the wait is observable", async () => {
    /*
     * The elapsed assertion is what makes this test discriminating. Written
     * only as "down was called, dispatch was called" it passed with the staged
     * check REMOVED — proceeding immediately reaches the same two calls. A
     * recreate that did not wait is the defect, so the wait itself is what
     * gets asserted.
     */
    const staged = status([{ run_id: "run-old", workers: [{ id: "tst-1", staged_task_id: "T-3" }] }]);
    const h = harness([staged, staged, IDLE, FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 500 });
    expect(r.settleWaitMs).toBe(1000);
    expect(h.calls).toContain("down:run-old");
    expect(h.calls).toContain("dispatch:run-new");
  });

  test("a staged task that never clears REFUSES, having stopped nothing", async () => {
    const staged = status([{ run_id: "run-old", workers: [{ id: "tst-1", staged_task_id: "T-3" }] }]);
    const h = harness([staged]);
    await expect(
      recreateThenDispatch(h.deps, { worker: "tst-1", settleTimeoutMs: 4_000, pollMs: 1000 }),
    ).rejects.toThrow(/staged T-3/);
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
    expect(h.calls).not.toContain("restartPane");
  });

  test("a task that never finishes REFUSES, having stopped nothing", async () => {
    const busy = status([{ run_id: "run-old", workers: [{ id: "tst-1", phase: "busy", task_id: "T-1" }] }]);
    const h = harness([busy]);
    await expect(
      recreateThenDispatch(h.deps, { worker: "tst-1", settleTimeoutMs: 5_000, pollMs: 1000 }),
    ).rejects.toThrow(/still holds work/);

    // The whole point: a refusal that already tore something down is not one.
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
    expect(h.calls).not.toContain("restartPane");
    expect(h.calls.filter((c) => c.startsWith("dispatch:"))).toEqual([]);
  });

  test("the refusal names the task and how to end it", () => {
    const msg = busyRefusal("tst-1", [
      { runId: "r1", phase: "busy", taskId: "T-1", stagedTaskId: null, alive: true },
    ]);
    expect(msg).toContain("T-1");
    expect(msg).toContain("Nothing has been stopped");
    expect(msg).toContain("pifleet abort");
  });

  test("a refusal on unreadable status stops nothing either", async () => {
    const h = harness(["not json"]);
    await expect(recreateThenDispatch(h.deps, { worker: "tst-1" })).rejects.toThrow(
      /state is unknown/,
    );
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
  });
});

describe("the order of a clean recreate", () => {
  test("status, down, respawn, then dispatch — in that order", async () => {
    const h = harness([IDLE, FRESH]);
    await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 100 });
    const seq = h.calls.filter((c) => c !== "status");
    expect(seq).toEqual(["down:run-old", "restartPane", "dispatch:run-new"]);
  });

  test("the dispatch goes to the NEW run, never the stopped one", async () => {
    const h = harness([IDLE, FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 100 });
    expect(r.stopped).toEqual(["run-old"]);
    expect(h.calls).toContain("dispatch:run-new");
    expect(h.calls).not.toContain("dispatch:run-old");
  });

  test("a run id that reappears unchanged is not accepted as the fresh one", async () => {
    // The stopped run's directory outlives its supervisor, so a status read
    // that still lists it must not be mistaken for the replacement.
    const h = harness([IDLE, IDLE, IDLE]);
    await expect(
      recreateThenDispatch(h.deps, { worker: "tst-1", readyTimeoutMs: 3_000, pollMs: 1000 }),
    ).rejects.toThrow(/did not come back/);
    expect(h.calls.filter((c) => c.startsWith("dispatch:"))).toEqual([]);
  });

  test("a worker that registers but is not alive yet is waited for", async () => {
    const notYet = status([{ run_id: "run-new", workers: [{ id: "tst-1", alive: false }] }]);
    const h = harness([IDLE, notYet, notYet, FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 1000 });
    expect(r.runId).toBe("run-new");
  });

  test("a worker with no run at all needs no teardown and still dispatches", async () => {
    // rev-1's shape after a failed recreate: no run, no container, nothing to
    // wait for and nothing to stop.
    const h = harness([status([]), FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 100 });
    expect(r.stopped).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
    expect(r.runId).toBe("run-new");
  });
});
