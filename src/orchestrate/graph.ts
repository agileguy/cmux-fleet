/**
 * The dependency DAG behind `dispatch --auto` (SRD §9.3).
 *
 * Pure state, no I/O: the scheduler feeds settle facts in and reads readiness
 * out, so every transition here is testable without a worker. Two properties
 * are load-bearing and everything else serves them:
 *
 * 1. **Determinism.** Given the same list and the same facts, every method
 *    returns the same answer in the same order. Order comes from the task
 *    LIST, never from object-key or Map-insertion accidents — a schedule that
 *    reorders between runs turns every flaky downstream failure into a
 *    non-reproducible one.
 *
 * 2. **Cause, not cascade.** When a dependency fails, every transitive
 *    dependent is `blocked` — but `blocked_by` names the task that actually
 *    FAILED, traced to the root, not the blocked neighbour one hop up. An
 *    operator reading "C blocked_by B, B blocked_by A, A failed" has to walk
 *    the chain themselves; "C blocked_by A" is the answer (contracts.ts,
 *    `ScheduledTaskSchema`).
 */

import type { ScheduledTask, TaskSchedState, TaskSpec, Verdict } from "../contracts.ts";

/**
 * Whether a DONE dependency lets its dependents run.
 *
 * `success` and `partial` gate open: partial work is real work, and §9.3 names
 * only `failed`/`blocked` as propagating. Everything else gates closed —
 * `aborted` and `timed_out` left no complete work product to build on, and
 * `unknown` means no evidence a work product exists at all. Letting a
 * dependent run on top of any of those builds on ground nobody has seen; the
 * alternative bug — holding the dependent forever — is exactly the deadlock
 * §9.3 forbids, so the closed gate must propagate `blocked`, not wait.
 */
export function dependencySatisfied(verdict: Verdict): boolean {
  return verdict === "success" || verdict === "partial";
}

interface Node {
  spec: TaskSpec;
  state: TaskSchedState;
  worker: string | null;
  taskId: string | null;
  blockedBy: string | null;
  verdict: Verdict | null;
}

/** Mutable schedule state for one validated task list. */
export class TaskGraph {
  /** In task-list order — the tie-break for every ordered answer. */
  readonly #order: readonly string[];
  readonly #nodes = new Map<string, Node>();
  /** dependency id -> ids of tasks that name it in depends_on. */
  readonly #dependents = new Map<string, string[]>();

  /** The list must already be validated (tasklist.ts): ids unique, deps known, acyclic. */
  constructor(tasks: readonly TaskSpec[]) {
    this.#order = tasks.map((t) => t.id);
    for (const t of tasks) {
      this.#nodes.set(t.id, {
        spec: t,
        state: t.depends_on.length === 0 ? "ready" : "waiting",
        worker: null,
        taskId: null,
        blockedBy: null,
        verdict: null,
      });
      for (const dep of t.depends_on) {
        const list = this.#dependents.get(dep) ?? [];
        list.push(t.id);
        this.#dependents.set(dep, list);
      }
    }
  }

  /**
   * Topological order, ties broken by list position (Kahn's algorithm with an
   * ordered frontier). Not used for dispatch itself — readiness drives that —
   * but it is the stable order `report` and the human table print in, and the
   * proof the constructor's inputs really were acyclic.
   */
  topologicalOrder(): string[] {
    const indegree = new Map<string, number>();
    for (const id of this.#order) {
      indegree.set(id, this.#nodes.get(id)!.spec.depends_on.length);
    }
    const out: string[] = [];
    // The frontier is re-scanned from the list order each round rather than
    // kept as a heap: n is bounded by MAX_ITEMS and the list-order tie-break
    // falls out for free, instead of being a comparator someone later
    // "simplifies" into insertion order.
    const emitted = new Set<string>();
    while (out.length < this.#order.length) {
      let progressed = false;
      for (const id of this.#order) {
        if (emitted.has(id) || indegree.get(id)! > 0) continue;
        emitted.add(id);
        out.push(id);
        progressed = true;
        for (const dep of this.#dependents.get(id) ?? []) {
          indegree.set(dep, indegree.get(dep)! - 1);
        }
      }
      if (!progressed) {
        // Unreachable after tasklist.ts validation — but this class is also
        // constructed directly by tests and future callers, and an infinite
        // loop is the worst possible way to report a cycle.
        throw new Error("task graph contains a cycle; validate with tasklist.ts first");
      }
    }
    return out;
  }

  /** Ready tasks, in task-list order. */
  ready(): TaskSpec[] {
    const out: TaskSpec[] = [];
    for (const id of this.#order) {
      const n = this.#nodes.get(id)!;
      if (n.state === "ready") out.push(n.spec);
    }
    return out;
  }

  /** The scheduler handed this task to a worker. */
  markDispatched(id: string, worker: string, taskId: string): void {
    const n = this.#node(id);
    if (n.state !== "ready") {
      throw new Error(`task '${id}' dispatched while ${n.state}, not ready`);
    }
    n.state = "dispatched";
    n.worker = worker;
    n.taskId = taskId;
  }

  /**
   * A task reached a terminal verdict. Also accepted for a task that was
   * never dispatched (`already_completed` replays, scheduler-detected worker
   * death) — the verdict is a fact wherever it came from.
   *
   * A failing verdict re-sweeps the graph: dependents become `blocked`, each
   * naming the root cause. The sweep is idempotent and order-independent —
   * it recomputes from settled facts rather than incrementally patching — so
   * WHICH of two failing dependencies settled first cannot change any answer
   * that does not depend on it.
   */
  markSettled(id: string, verdict: Verdict, from?: { worker: string; taskId: string }): void {
    const n = this.#node(id);
    if (n.state === "done" || n.state === "blocked") {
      throw new Error(`task '${id}' settled twice`);
    }
    n.state = "done";
    n.verdict = verdict;
    if (from !== undefined) {
      // A task settled without a dispatch of ours (an `already_completed`
      // replay, a rejection at the door) still names where the fact came
      // from, or the schedule reads as done-by-nobody.
      n.worker = from.worker;
      n.taskId = from.taskId;
    }
    this.#sweep();
  }

  /** Every task is `done` or `blocked` — the loop's exit condition. */
  allTerminal(): boolean {
    for (const n of this.#nodes.values()) {
      if (n.state !== "done" && n.state !== "blocked") return false;
    }
    return true;
  }

  /** The schedule as the shared seam sees it, in task-list order. */
  snapshot(): ScheduledTask[] {
    return this.#order.map((id) => {
      const n = this.#nodes.get(id)!;
      return {
        id,
        state: n.state,
        worker: n.worker,
        task_id: n.taskId,
        depends_on: [...n.spec.depends_on],
        blocked_by: n.blockedBy,
        verdict: n.verdict,
      };
    });
  }

  #node(id: string): Node {
    const n = this.#nodes.get(id);
    if (n === undefined) throw new Error(`unknown task '${id}'`);
    return n;
  }

  /**
   * Recompute `waiting -> ready` promotions and blocked propagation from the
   * settled facts, in topological order — so by the time a task is examined,
   * every dependency's own `blocked_by` is already final and root-cause
   * tracing is one lookup, not a walk.
   */
  #sweep(): void {
    for (const id of this.topologicalOrder()) {
      const n = this.#nodes.get(id)!;
      if (n.state === "done" || n.state === "dispatched") continue;

      // First failing dependency in depends_on ORDER decides `blocked_by` —
      // never settle order. A task blocks eagerly (the moment any dependency
      // fails, so the operator sees it immediately), but the cause is
      // recomputed on every sweep until the last dependency lands: otherwise
      // two runs where different deps happened to fail first would emit
      // different causes for the same final facts.
      let blockedBy: string | null = null;
      let allSatisfied = true;
      for (const dep of n.spec.depends_on) {
        const d = this.#nodes.get(dep)!;
        if (d.state === "blocked") {
          // The dependency never ran — it did not fail, whatever blocked IT
          // did. Naming `dep` here is the cascade this class exists to avoid.
          if (blockedBy === null) blockedBy = d.blockedBy;
          allSatisfied = false;
        } else if (d.state === "done" && !dependencySatisfied(d.verdict!)) {
          if (blockedBy === null) blockedBy = dep;
          allSatisfied = false;
        } else if (d.state !== "done") {
          allSatisfied = false;
        }
      }

      if (blockedBy !== null) {
        n.state = "blocked";
        n.blockedBy = blockedBy;
      } else if (n.state !== "blocked" && allSatisfied) {
        n.state = "ready";
      }
    }
  }
}
