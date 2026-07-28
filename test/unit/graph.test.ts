/**
 * The schedule DAG (SRD §9.3): readiness gating, deterministic order, and
 * blocked_by propagation that names the ROOT failed task.
 *
 * The propagation tests are the load-bearing ones. The cheap implementation —
 * name the immediate dependency — passes any test that only checks state, so
 * every chain test here asserts the blocked_by VALUE across at least two
 * hops. The determinism tests settle the same facts in different orders and
 * require identical snapshots, which fails any implementation that lets
 * settle order leak into the answer.
 */

import { describe, expect, test } from "bun:test";
import { ScheduledTaskSchema, TaskSpecSchema, type TaskSpec, type Verdict } from "../../src/contracts.ts";
import { TaskGraph, dependencySatisfied } from "../../src/orchestrate/graph.ts";

function spec(id: string, deps: string[] = [], extra: Record<string, unknown> = {}): TaskSpec {
  return TaskSpecSchema.parse({ id, title: id, brief: `do ${id}`, depends_on: deps, ...extra });
}

function states(g: TaskGraph): Record<string, string> {
  return Object.fromEntries(g.snapshot().map((t) => [t.id, t.state]));
}

describe("readiness gating", () => {
  test("tasks with no dependencies are ready immediately, in list order", () => {
    const g = new TaskGraph([spec("b"), spec("a")]);
    // List order, NOT lexical order: the author's ordering is the tie-break
    // everywhere, and 'b' before 'a' is what catches an accidental sort.
    expect(g.ready().map((t) => t.id)).toEqual(["b", "a"]);
  });

  test("a dependent becomes ready only when the dependency is DONE, not dispatched", () => {
    const g = new TaskGraph([spec("a"), spec("b", ["a"])]);
    expect(states(g)["b"]).toBe("waiting");
    g.markDispatched("a", "w1", "a");
    expect(states(g)["b"]).toBe("waiting");
    g.markSettled("a", "success");
    expect(g.ready().map((t) => t.id)).toEqual(["b"]);
  });

  test("partial satisfies a dependency; every other non-success verdict does not", () => {
    // partial work is real work (§9.3 propagates only on failure); aborted,
    // timed_out and unknown left nothing a dependent can safely build on.
    expect(dependencySatisfied("success")).toBe(true);
    expect(dependencySatisfied("partial")).toBe(true);
    for (const v of ["failed", "blocked", "aborted", "timed_out", "unknown"] as Verdict[]) {
      expect(dependencySatisfied(v)).toBe(false);
    }

    const g = new TaskGraph([spec("a"), spec("b", ["a"])]);
    g.markSettled("a", "partial");
    expect(states(g)["b"]).toBe("ready");
  });

  test("a task with two dependencies waits for both", () => {
    const g = new TaskGraph([spec("a"), spec("b"), spec("c", ["a", "b"])]);
    g.markSettled("a", "success");
    expect(states(g)["c"]).toBe("waiting");
    g.markSettled("b", "success");
    expect(states(g)["c"]).toBe("ready");
  });
});

describe("blocked_by names the root cause, not the neighbour (contracts.ts)", () => {
  test("A fails -> B blocked by A -> C blocked by A, not by B", () => {
    const g = new TaskGraph([spec("a"), spec("b", ["a"]), spec("c", ["b"])]);
    g.markSettled("a", "failed");
    const snap = Object.fromEntries(g.snapshot().map((t) => [t.id, t]));
    expect(snap["b"]!.state).toBe("blocked");
    expect(snap["b"]!.blocked_by).toBe("a");
    expect(snap["c"]!.state).toBe("blocked");
    // THE assertion. 'b' here is the cascade of identical lines the schema
    // comment forbids: b did not fail — it never ran.
    expect(snap["c"]!.blocked_by).toBe("a");
  });

  test("a diamond collapses to the one task that actually failed", () => {
    const g = new TaskGraph([spec("a"), spec("b", ["a"]), spec("c", ["a"]), spec("d", ["b", "c"])]);
    g.markSettled("a", "timed_out");
    const snap = Object.fromEntries(g.snapshot().map((t) => [t.id, t]));
    for (const id of ["b", "c", "d"]) {
      expect(snap[id]!.state).toBe("blocked");
      expect(snap[id]!.blocked_by).toBe("a");
    }
  });

  test("with one satisfied and one failed dependency, the failed one is named", () => {
    const g = new TaskGraph([spec("ok"), spec("bad"), spec("x", ["ok", "bad"])]);
    g.markSettled("ok", "success");
    g.markSettled("bad", "failed");
    const x = g.snapshot().find((t) => t.id === "x")!;
    expect(x.state).toBe("blocked");
    expect(x.blocked_by).toBe("bad");
  });

  test("blocking is terminal: a blocked task never becomes ready afterwards", () => {
    const g = new TaskGraph([spec("a"), spec("b"), spec("c", ["a", "b"])]);
    g.markSettled("a", "failed");
    expect(states(g)["c"]).toBe("blocked");
    g.markSettled("b", "success");
    expect(states(g)["c"]).toBe("blocked");
    expect(g.ready()).toEqual([]);
  });

  test("the final cause is settle-order independent: depends_on order decides", () => {
    // Same list, both deps fail, opposite settle orders. If settle order
    // decided blocked_by, these two runs would name different causes for
    // identical final facts — the nondeterminism requirement 6 forbids.
    const build = () => new TaskGraph([spec("d1"), spec("d2"), spec("x", ["d1", "d2"])]);

    const g1 = build();
    g1.markSettled("d1", "failed");
    g1.markSettled("d2", "failed");

    const g2 = build();
    g2.markSettled("d2", "failed");
    g2.markSettled("d1", "failed");

    const x1 = g1.snapshot().find((t) => t.id === "x")!;
    const x2 = g2.snapshot().find((t) => t.id === "x")!;
    expect(x1.blocked_by).toBe("d1");
    expect(x2.blocked_by).toBe("d1");
    expect(g1.snapshot()).toEqual(g2.snapshot());
  });
});

describe("topological order is deterministic with list-order ties", () => {
  test("independent tasks keep their list positions", () => {
    const g = new TaskGraph([spec("z"), spec("m"), spec("a")]);
    expect(g.topologicalOrder()).toEqual(["z", "m", "a"]);
  });

  test("dependencies come first; ties still break by list position", () => {
    const g = new TaskGraph([
      spec("d", ["b", "c"]),
      spec("c", ["a"]),
      spec("b", ["a"]),
      spec("a"),
    ]);
    // 'a' unlocks c and b; c precedes b because c appears earlier in the LIST.
    expect(g.topologicalOrder()).toEqual(["a", "c", "b", "d"]);
  });

  test("an unvalidated cycle throws instead of looping forever", () => {
    const g = new TaskGraph([spec("a", ["b"]), spec("b", ["a"])]);
    expect(() => g.topologicalOrder()).toThrow(/cycle/);
  });
});

describe("terminal accounting and the snapshot seam", () => {
  test("allTerminal only once every task is done or blocked", () => {
    const g = new TaskGraph([spec("a"), spec("b", ["a"]), spec("c")]);
    expect(g.allTerminal()).toBe(false);
    g.markSettled("c", "success");
    g.markSettled("a", "failed"); // blocks b -> terminal
    expect(g.allTerminal()).toBe(true);
  });

  test("snapshot validates against ScheduledTaskSchema, in list order", () => {
    const g = new TaskGraph([spec("a"), spec("b", ["a"], { worker: "eng-2" })]);
    g.markDispatched("a", "eng-1", "a");
    g.markSettled("a", "success");
    const snap = g.snapshot();
    // The seam, exactly: report and dispatch --auto both emit this shape, so
    // a drift here is two subsystems disagreeing about the same run.
    for (const t of snap) ScheduledTaskSchema.parse(t);
    expect(snap.map((t) => t.id)).toEqual(["a", "b"]);
    expect(snap[0]).toMatchObject({ state: "done", worker: "eng-1", task_id: "a", verdict: "success" });
    expect(snap[1]).toMatchObject({ state: "ready", worker: null, blocked_by: null });
  });

  test("a settle attributed from a replay records where the fact came from", () => {
    const g = new TaskGraph([spec("a")]);
    g.markSettled("a", "success", { worker: "eng-1", taskId: "a" });
    expect(g.snapshot()[0]).toMatchObject({ state: "done", worker: "eng-1", task_id: "a" });
  });

  test("illegal transitions throw: dispatch of a waiting task, double settle", () => {
    const g = new TaskGraph([spec("a"), spec("b", ["a"])]);
    expect(() => g.markDispatched("b", "w", "b")).toThrow(/not ready/);
    g.markSettled("a", "success");
    expect(() => g.markSettled("a", "success")).toThrow(/twice/);
  });
});
