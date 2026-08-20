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
import { classifyStall } from "../safety/stall.ts";
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
  /**
   * Milliseconds since `worker` last appended an event, or `null` when that
   * cannot be known (no events file yet — the worker has emitted nothing at
   * all since launch).
   *
   * A DURATION rather than a timestamp, deliberately. `io.now()` is an
   * injected monotonic-ish reading and an events file's mtime is wall-clock;
   * subtracting one from the other mixes two clocks and silently produces
   * nonsense under an injected clock, which is every test in this file. The
   * adapter takes both readings in ITS OWN domain and hands back the
   * difference, so nothing here has to know which clock answered.
   *
   * Optional for the reason `taskTokens` is: a fleet that cannot report event
   * silence is not a fleet that should stop scheduling. Absent, no worker is
   * ever classified and the stall policy simply does not engage — the
   * position every run was in before this seam existed.
   */
  eventSilenceMs?(worker: string): Promise<number | null>;
  /**
   * Stop a worker whose agent is wedged (ISC-117), by whatever means the
   * caller's runtime has. The scheduler settles the task and marks the worker
   * dead whether or not this resolves: the point of the classification is that
   * the agent is not coming back, and a kill that cannot be confirmed must not
   * leave the run polling a task that will never settle.
   */
  killWedged?(worker: string, taskId: string): Promise<void>;
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
  /**
   * Why the BUDGET ended this run with tasks still un-offered, or null.
   *
   * Distinct from a halt, which lives in `BudgetState.halted_at` and is a
   * crossed ceiling. This is the un-halted refusal — `would_exceed`, the
   * shipped-config shape where `tokens_spent + per_task_reserve_tokens`
   * overruns the ceiling before any task has actually crossed it — and it
   * exists so the CLI can name WHICH refusal stopped the run instead of
   * reporting the generic non-success-terminal-states message for a run whose
   * every task succeeded.
   */
  budgetRefusal: string | null;
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
  /**
   * Report a failed `onChange`. Called instead of propagating it.
   *
   * `onChange` is a real filesystem write and can fail for reasons that have
   * nothing to do with the run — ENOSPC, EROFS, a revoked mount. Letting it
   * throw would defeat the invariant a non-throwing `settle` exists to
   * guarantee (see `budget.ts`): the settle pass calls `settle` and then
   * persists, so a throwing persist escapes BEFORE the schedule snapshot is
   * written, discarding the record of every task that settled in that pass and
   * killing `dispatch --auto` with nothing on stdout. Accounting durability
   * must not outrank the record of what ran.
   *
   * So the write is best-effort and the FAILURE is loud instead. Optional only
   * because `onChange` is; a caller that persists must also be told when the
   * persist did not happen, or this trades a crash for a silent one.
   */
  onPersistError?: (err: unknown) => void;
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
    /**
     * The per-worker event-silence window (`timers.event_stall_warn` /
     * `timers.event_stall_kill`), which is NOT the same thing as
     * `stallTimeoutMs` above and the two are worth telling apart.
     *
     * `stallTimeoutMs` is fleet-wide and asks "has this whole run stopped
     * making progress" — it refuses the run at EXIT.TIMEOUT and kills nobody.
     * This asks, per worker, "has this AGENT stopped emitting while holding
     * the slot" and ends that one worker (SRD §9.3, ISC-110/ISC-117). A run
     * whose workers take turns can be perfectly healthy on the first measure
     * while one of its agents is wedged on the second.
     *
     * Absent, the policy does not engage; see `SchedulerIO.eventSilenceMs`.
     */
    stall?: { warnMs: number; killMs: number };
    /** Called once per worker when its silence first crosses `warnMs`. */
    onStallWarn?: (worker: string, taskId: string, silentMs: number) => Promise<void>;
  } = {},
): Promise<ScheduleOutcome> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const onChange = opts.onChange ?? (() => Promise.resolve());
  const budget = opts.budget;
  /**
   * Persist the budget, LOG-AND-CONTINUE on failure (see `onPersistError`).
   *
   * The one thing this must never do is throw: it is called from inside the
   * settle pass, before `onChange(graph.snapshot())` has written the schedule
   * record for that pass, and an escape there costs the run the record of
   * every task that just settled.
   */
  const persistBudget = async (): Promise<void> => {
    if (budget?.onChange === undefined) return;
    try {
      await budget.onChange(budget.manager.snapshot());
    } catch (err) {
      budget.onPersistError?.(err);
    }
  };
  /**
   * Give a hold back for a dispatch that PROVABLY never happened.
   *
   * NOT `settleBudget`. See `BudgetManager.release`: settling books actuals
   * and can trip the ceiling, and the `unreachable` task is re-offered — so
   * routing it through settle booked the dead worker's residual delta against
   * a task that never ran on it, once per retry.
   */
  const releaseHold = async (taskId: string): Promise<void> => {
    if (budget === undefined) return;
    if (budget.manager.release(taskId)) await persistBudget();
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
  /** Workers already warned, so `onStallWarn` fires once per (worker, task). */
  const warned = new Set<string>();

  /**
   * The per-worker stall verdict, or `"healthy"` when the policy cannot or
   * should not engage.
   *
   * Three separate reasons to answer `"healthy"` without consulting the
   * policy, and they are NOT the same reason wearing three hats:
   *
   *  - No `stall` window configured, or no `eventSilenceMs` on the IO. The
   *    seam is optional; absent, this is the behaviour every run had before
   *    it existed.
   *  - `eventSilenceMs` answered `null` — the worker has emitted NOTHING since
   *    launch, so there is no last event to measure from. Treating "no events
   *    file" as "infinitely silent" would kill every worker that is still
   *    starting up, which is the opposite of the criterion.
   *  - No budget, so `holdsSlot` is unknowable. Without the slot discriminator
   *    the policy cannot tell a queued worker from a wedged one, and
   *    `classifyStall` would see `holdsSlot: false` and saturate at `warn`
   *    anyway. Not consulting it is the honest form of the same answer.
   */
  const classifyWorkerStall = async (
    worker: string,
    taskId: string,
  ): Promise<"healthy" | "warn" | "kill"> => {
    const window = opts.stall;
    if (window === undefined || io.eventSilenceMs === undefined) return "healthy";
    if (budget === undefined) return "healthy";
    const silentMs = await io.eventSilenceMs(worker);
    if (silentMs === null) return "healthy";
    const verdict = classifyStall({
      sinceLastEventMs: silentMs,
      holdsSlot: budget.manager.holdsSlot(taskId),
      warnMs: window.warnMs,
      killMs: window.killMs,
    });
    const key = `${worker}\u0000${taskId}`;
    if (verdict === "warn" && !warned.has(key)) {
      warned.add(key);
      await opts.onStallWarn?.(worker, taskId, silentMs);
    }
    return verdict;
  };

  const inflight = new Map<string, string>();
  /** Workers observed dead. Never dispatched to again; pins to them refuse. */
  const dead = new Set<string>();
  /** Task id -> settle reason, for the exit ladder (worker_died vs verdict). */
  const reasons = new Map<string, string>();
  /** Set when a budget refusal — not a task outcome — is what ended the loop. */
  let endedOnBudgetRefusal: string | null = null;

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
    /**
     * The last budget refusal of this pass (`reason: detail`), or null.
     *
     * A string rather than a flag because it is the run's DIAGNOSIS when the
     * refusal is what ends the schedule: "projected 5600001 tokens > ceiling
     * 6000000" is the sentence the operator needs, and reconstructing it after
     * the loop is impossible — the decision that produced it is gone.
     */
    let budgetRefused: string | null = null;

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
        continue;
      }

      /**
       * ALIVE, and not settling. The reaper cannot help here and that is the
       * whole point of this block: the reaper (ISC-118) acts on a stale
       * HEARTBEAT, and this supervisor's heartbeat is fine. What has stopped
       * is the AGENT inside it, which holds the oMLX slot while emitting
       * nothing — so without this the slot is held indefinitely and the run
       * waits out its fleet-wide `stallTimeoutMs` and reports a TIMEOUT that
       * names the whole run rather than the one worker that wedged.
       *
       * `holdsSlot` is the discriminator, and it is the reason this could not
       * be wired before the budget was: until admission was on the dispatch
       * path there was no queue, every worker ran at once, and "silent because
       * queued" was not a state any worker could be in. Now it is, and killing
       * one for it would be executing a worker for standing in the line we put
       * it in — so `classifyStall` saturates a non-holder at `warn` however
       * long it waits.
       */
      const stallVerdict = await classifyWorkerStall(worker, taskId);
      if (stallVerdict === "kill") {
        // Best-effort: the classification says this agent is not coming back,
        // so the task must not stay in flight even if the kill cannot be
        // confirmed. Leaving it would re-create the indefinite wait this
        // block exists to end.
        await io.killWedged?.(worker, taskId).catch(() => {});
        graph.markSettled(taskId, "unknown");
        reasons.set(taskId, "event_stall_kill");
        inflight.delete(taskId);
        dead.add(worker);
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
        budgetRefused = `${decision.reason}: ${decision.detail}`;
        continue;
      }
      if (decision !== undefined) {
        // Durable BEFORE the envelope, per `admit`'s docstring — for the
        // CONCURRENT READER, not for a restart. `resumeBudget` rule 3 drops
        // reservations, so a hold that never reached disk costs a restart
        // nothing; what it costs is `wait`/`report` reading this file during
        // the window where the run has committed a slot, which they cannot
        // learn from anywhere else.
        await persistBudget();
      }

      // The task-list-local id doubles as the run's task_id: it is unique
      // within the list (tasklist.ts) and a stable name makes the attempt id
      // deterministic, which is what lets a re-run of the same list replay
      // completed tasks instead of re-executing them (ISC-85).
      /**
       * A hold outlives the dispatch it authorised only if the dispatch
       * RETURNS. `io.dispatch` re-throws anything that is not a diagnosed
       * worker failure (see `dispatch.ts`), and an escape from here leaves the
       * reservation on disk with nothing that will ever settle it — `wait` and
       * `report` then show a phantom in-flight slot for a task that was never
       * accepted. A restart heals it (rule 3 drops reservations), but the
       * readers that run MEANWHILE are exactly who the snapshot is for.
       */
      let answer: DispatchAnswer;
      try {
        answer = await io.dispatch(spec, target, spec.id);
      } catch (err) {
        await releaseHold(spec.id);
        throw err;
      }
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
          // RELEASE, not settle — this is the one answer in this switch that
          // is NOT terminal, and it is the only one that must not book. The
          // task will be offered again, so settling here booked spend for it
          // once per attempt, off a worker it never ran on, against a ceiling
          // that could then halt the run for a dispatch nobody made.
          await releaseHold(spec.id);
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
     * THE TASKS STAY `ready`, AND `ready` IS NOT 5. This comment used to claim
     * "the fold at the bottom turns [them] into 5", and for `would_exceed`
     * that was false in three steps: `budgetExitCode` returns SUCCESS unless
     * `halted_at` is set, only `settle` halts, and `exitFor` on a `ready` task
     * has verdict `null` and falls to `EXIT.PARTIAL`. So the operator got the
     * generic "non-success terminal states" at 7 for a run the BUDGET ended —
     * and with `fleet.example.yaml` as shipped (`tokens_ceiling: 6000000`,
     * `per_task_reserve_tokens: 400000`) that is the NORMAL ending, since
     * admission fails on `would_exceed` from 5,600,001 spent onward and the
     * last reserve-worth of every budget is unreachable by construction.
     *
     * Recording the refusal is what makes the fold below honest: a run the
     * budget stopped reports 5 whether or not a ceiling was actually crossed,
     * because in both cases the budget — not a task outcome — is why the run
     * ended. The two remain distinguishable in the diagnosis and in
     * `budget.json`: a halt sets `halted_at`, a refusal does not.
     */
    if (budgetRefused !== null && !dispatchedAny && inflight.size === 0) {
      endedOnBudgetRefusal = budgetRefused;
      break;
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
  /**
   * The un-halted refusal's contribution — the other half of the same fold.
   *
   * `budgetExitCode` above covers a CROSSED ceiling. This covers the ceiling
   * that was never crossed because admission refused first, which is the
   * shipped-config shape and which `budgetExitCode` cannot see: `halted_at` is
   * null, every task that ran succeeded, and `worstExit` over the schedule
   * alone yields `EXIT.PARTIAL` from the `ready` tasks. `EXIT.BUDGET` outranks
   * `EXIT.PARTIAL` in `EXIT_SEVERITY`, so this is what the run reports — and,
   * unlike the halted path, NOTHING ELSE produces it. `dispatch --auto` raises
   * `BudgetCeilingError` for a halt before it ever consults `exit`, so on a
   * refusal this fold is the sole source of the run's integer.
   */
  if (endedOnBudgetRefusal !== null) codes.push(EXIT.BUDGET);
  return { schedule, exit: worstExit(codes), budgetRefusal: endedOnBudgetRefusal };
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
