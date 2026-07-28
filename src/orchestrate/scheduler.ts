/**
 * The SCHEDULER behind `dispatch --auto` (SRD §9.3, §14.2).
 *
 * Drives a validated task list to the state where EVERY task is terminal —
 * `done` or `blocked` — assigning ready tasks to idle workers and feeding
 * settle facts back into the graph. All I/O arrives through `SchedulerIO`, so
 * the whole loop is testable against fakes; the real bindings (worker state
 * files, task records, the control socket) live in the dispatch command.
 *
 * Determinism is a requirement, not a preference (SRD §14: the primary
 * consumer is an orchestrator, and an orchestrator debugging a run needs the
 * same list to schedule the same way twice). Order therefore comes from
 * exactly two places — task-list position and the sorted worker list — and
 * from nothing else: no Math.random, no object-key iteration, no racing
 * promises. Every await in the loop is sequential on purpose.
 */

import {
  EXIT,
  worstExit,
  type ExitCode,
  type ScheduledTask,
  type TaskSpec,
  type Verdict,
} from "../contracts.ts";
import { TaskGraph } from "./graph.ts";

/** What the scheduler can observe about one worker, reduced to what it needs. */
export type WorkerHealth = "idle" | "busy" | "dead";

/** One dispatch attempt's outcome, as the scheduler consumes it. */
export type DispatchAnswer =
  /** The supervisor accepted; a task record will appear when it settles. */
  | { kind: "accepted"; epoch: number }
  /**
   * The (worker, task, attempt) already completed — ISC-85's idempotent
   * replay. The recorded verdict is a fact; the task is settled without
   * running again.
   */
  | { kind: "already_completed"; verdict: Verdict }
  /** The worker refused the prompt. The task failed at the door; the worker lives. */
  | { kind: "rejected"; reason: string }
  /** The control socket is gone. A fact about the WORKER, not the task. */
  | { kind: "unreachable"; detail: string };

/** Everything the loop touches outside its own memory. */
export interface SchedulerIO {
  /** Worker ids in the fleet. Order is not trusted; the scheduler sorts. */
  listWorkers(): Promise<string[]>;
  workerHealth(worker: string): Promise<WorkerHealth>;
  /** Send `spec` to `worker` as `taskId` through the shared envelope path. */
  dispatch(spec: TaskSpec, worker: string, taskId: string): Promise<DispatchAnswer>;
  /** The terminal task record, or null while the task is still running. */
  readSettled(worker: string, taskId: string): Promise<{ verdict: Verdict; reason: string } | null>;
  sleep(ms: number): Promise<void>;
}

/**
 * A schedule that cannot proceed. Structural `ExitCoded` (contracts.ts), for
 * the same reason as `TaskListError`: this module signals ladder codes
 * without importing the CLI.
 */
export class SchedulerError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

export interface ScheduleOutcome {
  schedule: ScheduledTask[];
  /** §10 severity ladder over every task's terminal state. */
  exit: ExitCode;
}

const DEFAULT_POLL_MS = 100;

/**
 * Run the list to completion. `tasks` must already be validated
 * (tasklist.ts): unique ids, known dependencies, no cycles.
 */
export async function runSchedule(
  tasks: readonly TaskSpec[],
  io: SchedulerIO,
  opts: { pollMs?: number } = {},
): Promise<ScheduleOutcome> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const workers = [...(await io.listWorkers())].sort();

  // Refusals precede any dispatch, like tasklist validation does: a pin that
  // names no fleet member is an authoring error, and discovering it on task
  // four leaves three tasks running toward consumers that cannot exist.
  if (workers.length === 0) {
    throw new SchedulerError("no workers in this run; was it created by 'pifleet up'?", EXIT.USAGE);
  }
  for (const t of tasks) {
    if (t.worker !== null && !workers.includes(t.worker)) {
      throw new SchedulerError(
        `task '${t.id}' is pinned to worker '${t.worker}', which is not in this run ` +
          `(workers: ${workers.join(", ")})`,
        EXIT.USAGE,
      );
    }
  }

  const graph = new TaskGraph(tasks);
  /** Task id -> assigned worker, insertion-ordered — the settle-poll order. */
  const inflight = new Map<string, string>();
  /** Workers observed dead. Never dispatched to again; pins to them refuse. */
  const dead = new Set<string>();
  /** Task id -> settle reason, for the exit ladder (worker_died vs verdict). */
  const reasons = new Map<string, string>();

  while (!graph.allTerminal()) {
    let progressed = false;

    // -- Settle pass: harvest terminal facts for everything in flight. ------
    for (const [taskId, worker] of inflight) {
      const record = await io.readSettled(worker, taskId);
      if (record !== null) {
        graph.markSettled(taskId, record.verdict);
        reasons.set(taskId, record.reason);
        inflight.delete(taskId);
        progressed = true;
        continue;
      }
      // No record yet — is the supervisor even alive to write one? A SIGKILL
      // leaves no task record at all (same evidence rule as `wait`): absence
      // of the process is the fact, and `unknown` — never an invented
      // failure — is the verdict it supports.
      if ((await io.workerHealth(worker)) === "dead") {
        graph.markSettled(taskId, "unknown");
        reasons.set(taskId, "worker_died");
        inflight.delete(taskId);
        dead.add(worker);
        progressed = true;
      }
    }
    if (graph.allTerminal()) break;

    // -- Dispatch pass: ready tasks onto free idle workers. -----------------
    // Availability is probed once per iteration, in sorted order, so the
    // "first idle worker" a tied task gets does not depend on probe timing.
    const busy = new Set(inflight.values());
    const available: string[] = [];
    for (const w of workers) {
      if (dead.has(w) || busy.has(w)) continue;
      const health = await io.workerHealth(w);
      if (health === "dead") {
        dead.add(w);
        continue;
      }
      if (health === "idle") available.push(w);
    }

    for (const spec of graph.ready()) {
      // A pin names one worker or nothing runs; null takes the first free
      // idle worker in sorted order. Ties break on task-list position
      // because `ready()` returns list order.
      let target: string | null;
      if (spec.worker !== null) {
        if (dead.has(spec.worker)) {
          throw new SchedulerError(
            `task '${spec.id}' is pinned to worker '${spec.worker}', which died; ` +
              `the schedule cannot complete (in-flight tasks keep running on their workers)`,
            EXIT.WORKER_DIED,
          );
        }
        target = available.includes(spec.worker) ? spec.worker : null;
      } else {
        target = available[0] ?? null;
      }
      if (target === null) continue; // No free worker for THIS task yet; a later pin may still fit.

      // The task-list-local id doubles as the run's task_id: it is unique
      // within the list (tasklist.ts) and a stable name makes the attempt id
      // deterministic, which is what lets a re-run of the same list replay
      // completed tasks instead of re-executing them (ISC-85).
      const answer = await io.dispatch(spec, target, spec.id);
      progressed = true;
      switch (answer.kind) {
        case "accepted":
          graph.markDispatched(spec.id, target, spec.id);
          inflight.set(spec.id, target);
          available.splice(available.indexOf(target), 1);
          break;
        case "already_completed":
          // Settled without running — the recorded verdict is the fact.
          graph.markSettled(spec.id, answer.verdict, { worker: target, taskId: spec.id });
          reasons.set(spec.id, "already_completed");
          break;
        case "rejected":
          // The prompt never started, so nothing partial exists to grade:
          // this is a failure of THIS task, and its dependents block on it.
          graph.markSettled(spec.id, "failed", { worker: target, taskId: spec.id });
          reasons.set(spec.id, answer.reason);
          break;
        case "unreachable":
          // The worker is gone, the task is untouched: it stays `ready` and
          // the next iteration offers it to a surviving worker. Only a PIN
          // to the dead worker is fatal, and the top of the loop's dispatch
          // pass reports that with the named diagnosis.
          dead.add(target);
          available.splice(available.indexOf(target), 1);
          break;
      }
    }

    if (!graph.allTerminal() && inflight.size === 0 && !progressed) {
      // Nothing running, nothing dispatched, tasks remain. With a validated
      // acyclic list this means ready tasks exist and no worker can ever
      // serve them — every worker is dead. Polling here would hang forever,
      // which is the §9.3 deadlock this refusal exists to prevent.
      const alive = workers.filter((w) => !dead.has(w));
      if (alive.length === 0) {
        throw new SchedulerError(
          `every worker died with tasks still pending (${graph
            .ready()
            .map((t) => t.id)
            .join(", ")})`,
          EXIT.WORKER_DIED,
        );
      }
      // Workers are alive but busy with work this scheduler did not start
      // (or still settling) — that resolves on its own; keep polling.
    }

    if (!progressed) await io.sleep(pollMs);
  }

  const schedule = graph.snapshot();
  return { schedule, exit: worstExit(schedule.map((t) => exitFor(t, reasons.get(t.id) ?? ""))) };
}

/**
 * One task's contribution to the exit ladder — the same mapping `wait` uses,
 * so `dispatch --auto` and a dispatch-then-wait pipeline agree about what a
 * run's integer means (SRD §10).
 */
function exitFor(t: ScheduledTask, reason: string): ExitCode {
  if (t.state === "blocked") return EXIT.PARTIAL;
  if (reason === "worker_died") return EXIT.WORKER_DIED;
  switch (t.verdict) {
    case "success":
      return EXIT.SUCCESS;
    case "timed_out":
      return EXIT.TIMEOUT;
    default:
      // failed | blocked | partial | aborted | unknown — "not success", with
      // `unknown` deliberately NOT worker-death (see wait.ts: only the
      // diagnosed reason may claim the scarier, higher-ranked code).
      return EXIT.PARTIAL;
  }
}
