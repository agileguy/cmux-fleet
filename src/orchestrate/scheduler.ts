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
  type BudgetState,
  type ExitCode,
  type ScheduledTask,
  type TaskSpec,
  type Verdict,
} from "../contracts.ts";
import { budgetExitCode, type BudgetManager } from "../safety/budget.ts";
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
  | { kind: "unreachable"; detail: string }
  /**
   * The dispatch may or may not have been acted on — a timeout, or a socket
   * closed mid-request. Distinct from `unreachable`, which is a PROVABLE
   * non-delivery, because the two demand opposite responses: one is safe to
   * retry elsewhere and the other must never be.
   */
  | { kind: "in_doubt"; detail: string };

/** Everything the loop touches outside its own memory. */
export interface SchedulerIO {
  /** Worker ids in the fleet. Order is not trusted; the scheduler sorts. */
  listWorkers(): Promise<string[]>;
  workerHealth(worker: string): Promise<WorkerHealth>;
  /** Send `spec` to `worker` as `taskId` through the shared envelope path. */
  dispatch(spec: TaskSpec, worker: string, taskId: string): Promise<DispatchAnswer>;
  /** The terminal task record, or null while the task is still running. */
  readSettled(worker: string, taskId: string): Promise<{ verdict: Verdict; reason: string } | null>;
  /**
   * Tokens to book against the budget for a task that just reached a terminal
   * state — NEW spend observed for `worker` since this method last answered
   * for it (A6: `state.usage` merged with the transcript's per-message usage).
   *
   * A delta rather than a per-task total because the seam that carries usage
   * is per SESSION, not per task: `state.usage` and the transcript are both
   * cumulative for the worker, and subtracting the last observation is the
   * only way to attribute the difference to the task that just finished.
   *
   * On `SchedulerIO` rather than in the budget options because it is a READ
   * of run state, exactly like `readSettled` beside it, and this module's
   * header rule is that all I/O arrives through this interface. Optional
   * because a fleet that cannot report usage is not a fleet that should stop
   * scheduling: absent, every task books 0 and the ceiling simply never
   * trips, which is the same position a run with no ceiling is in.
   */
  taskTokens?(worker: string, taskId: string): Promise<number>;
  sleep(ms: number): Promise<void>;
  /**
   * Monotonic-ish milliseconds, injected rather than read from the clock so
   * the stall timeout is testable without waiting for it in real time.
   */
  now(): number;
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

/**
 * The run's budget, attached to the loop that actually dispatches (ISC-235).
 *
 * ONE of these per run, constructed by the caller that owns the run directory
 * — not one per worker and not one per dispatch call. `max_concurrent` is a
 * property of the FLEET's throughput (SRD §5.9 / F40: bounded by oMLX, not by
 * pane count), so a per-worker manager would enforce a cap of `n * workers`
 * and a per-call one would enforce nothing at all.
 *
 * The manager is a pure state machine; durability is the caller's problem
 * (see `budget.ts`), so `onChange` is how a snapshot reaches disk — the same
 * arrangement, and for the same reason, as `onChange` for the schedule
 * record. It fires only when the state actually MOVED: a refused admission
 * mutates nothing and writing on it would put a file write on the polling
 * path. That bounds writes at roughly two per task plus one, which is
 * negligible beside a dispatch, and it means a crash is never more than one
 * in-flight task's spend behind — the window `per_task_reserve_tokens`
 * exists to cover.
 */
export interface ScheduleBudget {
  manager: BudgetManager;
  /** In-flight cap, from `run.max_concurrent`. */
  maxConcurrent: number;
  /** Up-front hold per admission, from `run.budget.per_task_reserve_tokens`. */
  reserveTokens: number;
  /** Persist a snapshot. Awaited BEFORE the envelope it authorises goes out. */
  onChange?: (snapshot: BudgetState) => Promise<void>;
}

/**
 * How often the scheduler re-examines readiness.
 *
 * Exported because it is not merely an implementation detail: it QUANTISES the
 * observable gap between two dependent dispatches. A correctly-gated task
 * cannot follow its dependency by less than one full tick, so a test asserting
 * "these were not dispatched in the same pass" has to be written against this
 * number rather than against a hand-picked one that happens to sit on it. See
 * `test/integration/dispatch-auto.test.ts`.
 */
export const DEFAULT_POLL_MS = 100;

/**
 * How long the schedule may sit with nothing changing before it is refused.
 *
 * Generous, because a legitimately slow task settles on its own `deadline_s`
 * and this is the backstop for a supervisor that has stopped honouring it —
 * not a second task deadline. Ten minutes of a fleet where nothing at all
 * moves is a wedge, not a long task.
 */
const DEFAULT_STALL_TIMEOUT_MS = 600_000;

/**
 * Run the list to completion. `tasks` must already be validated
 * (tasklist.ts): unique ids, known dependencies, no cycles.
 *
 * `onChange` fires with a fresh snapshot after every batch of state
 * transitions — initial states included — so a caller can keep a durable
 * schedule record current while the run is LIVE. `report` reads that record
 * (run.scheduleJson); a snapshot written only at exit would describe every
 * crashed or interrupted run as empty, which is precisely the run someone
 * asks `report` about.
 */
export async function runSchedule(
  tasks: readonly TaskSpec[],
  io: SchedulerIO,
  opts: {
    pollMs?: number;
    onChange?: (schedule: ScheduledTask[]) => Promise<void>;
    /**
     * How long the schedule may make NO progress before the run is refused.
     *
     * The deadlock guard below only fires when every worker is dead. A
     * supervisor whose process is alive but wedged mid-task reports `busy`
     * forever, `workerHealth` never says `dead`, nothing ever settles, and
     * `dispatch --auto` polls until someone notices — no budget, no
     * iteration cap, no output. That is the §9.3 deadlock the module claims
     * to prevent, surviving in the one branch the guard does not cover.
     *
     * Measured from the last time anything changed, not from the start, so a
     * long but healthy run is never cut off — only a stalled one.
     */
    stallTimeoutMs?: number;
    /**
     * The run's budget: admission control and spend accounting (ISC-235).
     *
     * Optional because this module is also driven directly by tests and by
     * callers with no run directory to persist into. Absent, the loop behaves
     * exactly as it did before one existed — which is the state four audits
     * measured and named: `max_concurrent` enforced nowhere, `admit` with no
     * caller, `EXIT.BUDGET` with no producer. `dispatch --auto` always
     * supplies one.
     */
    budget?: ScheduleBudget;
  } = {},
): Promise<ScheduleOutcome> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const onChange = opts.onChange ?? (() => Promise.resolve());
  const budget = opts.budget;
  const persistBudget = async (): Promise<void> => {
    if (budget?.onChange !== undefined) await budget.onChange(budget.manager.snapshot());
  };
  /**
   * Book a terminal task's spend and release its admission slot.
   *
   * Called on EVERY terminal transition, not just the ones with a task record:
   * a worker that died still burned whatever its transcript shows, and a
   * dispatch that was refused still has to give its slot back or the cap
   * degrades into a permanent block. `settle` handles both — it books actuals
   * and releases the hold in one step — so the only thing that varies is how
   * many tokens the caller can attribute, which is 0 for anything that never
   * ran.
   */
  const settleBudget = async (taskId: string, worker: string | null): Promise<void> => {
    if (budget === undefined) return;
    let tokens = 0;
    if (worker !== null && io.taskTokens !== undefined) {
      tokens = await io.taskTokens(worker, taskId);
    }
    budget.manager.settle(taskId, { tokens });
    await persistBudget();
  };
  let lastProgressMs = io.now();
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

  // The initial snapshot goes out before the first dispatch: a schedule
  // record that appears only once something ran cannot distinguish "waiting
  // on a dependency" from "the scheduler never saw this task".
  await onChange(graph.snapshot());
  // The budget's opening balance reaches disk on the same terms and for the
  // same reason: a run that halts before its first settle must still leave a
  // `budget.json` for `wait` and `report` to read.
  await persistBudget();

  while (!graph.allTerminal()) {
    let progressed = false;
    /** Ready tasks the budget refused this pass, for the drain check below. */
    let budgetRefused = false;

    // -- Settle pass: harvest terminal facts for everything in flight. ------
    for (const [taskId, worker] of inflight) {
      const record = await io.readSettled(worker, taskId);
      if (record !== null) {
        graph.markSettled(taskId, record.verdict);
        reasons.set(taskId, record.reason);
        inflight.delete(taskId);
        // Accounting FOLLOWS the evidence, never precedes it: the verdict and
        // its reason are in the graph before the ceiling can trip on this
        // task's spend, so a halt can never cost the run the record of what
        // the tokens actually bought (ISC-114's "artifacts still harvested").
        await settleBudget(taskId, worker);
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
        // A death is terminal too, and the tokens it burned before dying are
        // still spent — the transcript is the one artifact that survives a
        // SIGKILL. Dropping them here is how a ceiling gets overshot by a
        // whole worker's session, silently.
        await settleBudget(taskId, worker);
        progressed = true;
      }
    }
    // Settle facts (and the blocked propagation they trigger) reach the
    // durable record BEFORE the terminal-exit break and BEFORE any refusal
    // below can throw — the last written state is always the true one.
    if (progressed) await onChange(graph.snapshot());
    if (graph.allTerminal()) break;

    /**
     * A halted budget stops DISPATCH, not the world (budget.ts's header).
     *
     * While anything is still in flight the loop keeps draining: those tasks
     * are running on their workers whatever this process decides, their
     * records still reach the graph, and their spend still books. Only when
     * the last one has settled is there nothing left to wait for — the
     * remaining tasks stay `ready`, which is the honest state for work that
     * was never offered to anyone, and the run reports 5 through the fold at
     * the bottom of this function.
     *
     * The dispatch pass below still RUNS during the drain, and deliberately:
     * `admit` refusing every ready task with `budget_halted` is the halt
     * doing its job on the real path, and the alternative — a shortcut around
     * the admission check — is a second place that decides whether a task may
     * be dispatched.
     */
    if (budget?.manager.halted === true && inflight.size === 0) break;

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

    let dispatchedAny = false;
    for (const spec of graph.ready()) {
      // A pin names one worker or nothing runs; null takes the first free
      // idle worker in sorted order. Ties break on task-list position
      // because `ready()` returns list order.
      let target: string | null;
      if (spec.worker !== null) {
        if (dead.has(spec.worker)) {
          // Dispatches already made this pass reach the record before the
          // refusal aborts the loop — they are running whether or not this
          // error is ever read.
          if (dispatchedAny) await onChange(graph.snapshot());
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

      /**
       * ADMISSION (ISC-109, ISC-114, ISC-235). An idle worker is necessary
       * but not sufficient: `max_concurrent` is bounded by measured oMLX
       * throughput, not by how many panes happen to be free (SRD §5.9, F40),
       * and this loop used to treat "a worker is idle" as the whole test —
       * which is why a probe with six workers and `max_concurrent: 2`
       * observed six in-flight generations.
       *
       * A REFUSED TASK STAYS `ready`. Not failed, not blocked, not dropped:
       * nothing about it has been decided except that now is not its turn.
       * `continue` leaves the graph untouched, so a later pass — after an
       * in-flight task settles and releases its slot — offers it again. The
       * one refusal that is permanent is `budget_halted`, and the drain check
       * above turns that into an exit rather than a spin.
       */
      const decision = budget?.manager.admit(spec.id, {
        reserveTokens: budget.reserveTokens,
        maxConcurrent: budget.maxConcurrent,
      });
      if (decision !== undefined && !decision.ok) {
        budgetRefused = true;
        continue;
      }
      if (decision !== undefined) {
        // Durable BEFORE the envelope, per budget.ts: a crash between the
        // decision and the dispatch must not leak an unaccounted slot that a
        // restart would double-admit against.
        await persistBudget();
      }

      // The task-list-local id doubles as the run's task_id: it is unique
      // within the list (tasklist.ts) and a stable name makes the attempt id
      // deterministic, which is what lets a re-run of the same list replay
      // completed tasks instead of re-executing them (ISC-85).
      const answer = await io.dispatch(spec, target, spec.id);
      progressed = true;
      dispatchedAny = true;
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
          // Terminal, so the hold comes straight back. Every non-`accepted`
          // answer below does the same, and it is not optional bookkeeping:
          // a hold taken for a dispatch that never occupied a worker is a
          // slot nothing will ever settle, so `max_concurrent` would ratchet
          // down one refusal at a time until the run deadlocked.
          await settleBudget(spec.id, target);
          break;
        case "rejected":
          // The prompt never started, so nothing partial exists to grade:
          // this is a failure of THIS task, and its dependents block on it.
          graph.markSettled(spec.id, "failed", { worker: target, taskId: spec.id });
          reasons.set(spec.id, answer.reason);
          await settleBudget(spec.id, target);
          break;
        case "in_doubt":
          /**
           * Settle it `unknown` and never re-offer it.
           *
           * A timeout on the control socket used to be reported as
           * `unreachable`, which the scheduler read as "the task is
           * untouched" and handed to the next idle worker. That premise does
           * not hold: the supervisor may have accepted the envelope,
           * persisted its fence and started the agent before replying late.
           * The dedup that should have caught the second dispatch is
           * per-supervisor — `FenceSnapshot.attempts` lives in each worker's
           * own fence — so a second worker has never seen this attempt id and
           * accepts it. Two agents then run the same brief against the same
           * branch, and both writes to the inbox record land on one path
           * keyed by run and task, not by worker, so the second silently
           * overwrites the first's durable record.
           *
           * `unknown` is the honest verdict: we do not know whether it ran.
           * Dependents block rather than proceeding on an unverified result.
           */
          graph.markSettled(spec.id, "unknown", { worker: target, taskId: spec.id });
          reasons.set(spec.id, `dispatch outcome unknown: ${answer.detail}`);
          // The hold is released on the same honesty the verdict carries: an
          // agent that may be running right now could still be spending, and
          // this books only what its transcript already shows. Holding the
          // slot instead would trade an under-count for a deadlock.
          await settleBudget(spec.id, target);
          available.splice(available.indexOf(target), 1);
          break;
        case "unreachable":
          // The worker is gone, the task is untouched: it stays `ready` and
          // the next iteration offers it to a surviving worker. Only a PIN
          // to the dead worker is fatal, and the top of the loop's dispatch
          // pass reports that with the named diagnosis.
          dead.add(target);
          await settleBudget(spec.id, target);
          available.splice(available.indexOf(target), 1);
          break;
      }
    }
    if (dispatchedAny) await onChange(graph.snapshot());

    /**
     * The budget refused everything and there is nothing running to change
     * its mind.
     *
     * With no in-flight task there is no hold left to release and spend only
     * ever grows, so a `would_exceed` or `budget_halted` refusal on this pass
     * is the same refusal on every future one. Without this the loop would
     * poll a fleet of idle workers for the full stall timeout and then report
     * a TIMEOUT — a ceiling crossing misfiled as a wedge.
     *
     * The tasks stay `ready`, which is what the fold at the bottom turns into
     * 5 rather than into a fabricated failure for work nobody ever ran.
     */
    if (budgetRefused && !dispatchedAny && inflight.size === 0) break;

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

    if (progressed) {
      lastProgressMs = io.now();
    } else if (io.now() - lastProgressMs > stallTimeoutMs) {
      /**
       * Alive, busy, and going nowhere. Refusing beats polling forever: the
       * in-flight tasks keep running on their workers either way, and the
       * operator gets a named diagnosis instead of a CLI that never returns.
       */
      const stuck = [...inflight.entries()].map(([t, w]) => `${t} on ${w}`);
      if (dispatchedAny) await onChange(graph.snapshot());
      throw new SchedulerError(
        `no progress for ${Math.round(stallTimeoutMs / 1000)}s with ` +
          `${inflight.size} task(s) still in flight (${stuck.join(", ") || "none"}); ` +
          `workers are alive but not settling — the tasks keep running on their workers`,
        EXIT.TIMEOUT,
      );
    }
    if (!progressed) await io.sleep(pollMs);
  }

  const schedule = graph.snapshot();
  /**
   * The budget's contribution to the ladder, folded in AFTER every terminal
   * fact has been collected (ISC-193, ISC-235).
   *
   * `budgetExitCode` is `EXIT.SUCCESS` for a run that never halted, so this
   * is a no-op on the ordinary path — `worstExit` ignores it. On a halted run
   * it is `EXIT.BUDGET`, which no VERDICT can produce: `exitFor` ranges over
   * success/timed_out/everything-else and cannot reach 5 from any of them,
   * which is why the code sat in `EXIT_SEVERITY` with nothing anywhere able
   * to yield it. This is the fold that gives it a producer.
   *
   * Position matters as much as presence. It happens here, after the loop has
   * drained and `schedule` is final, not at the moment the ceiling trips —
   * so a budget halt cannot abandon in-flight work or truncate the record of
   * it. The tasks that were running when the ceiling crossed reach their
   * verdicts first and are harvestable afterwards; only then does the run
   * report 5 (ISC-114's "with artifacts still harvested").
   */
  const codes = schedule.map((t) => exitFor(t, reasons.get(t.id) ?? ""));
  if (budget !== undefined) codes.push(budgetExitCode(budget.manager.snapshot()));
  return { schedule, exit: worstExit(codes) };
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
