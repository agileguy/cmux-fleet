import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CliError } from "../index.ts";
import {
  EXIT,
  VerdictSchema,
  TaskEnvelopeSchema,
  type BudgetState,
  type ScheduledTask,
  type TaskEnvelope,
  type TaskSpec,
  type Verdict,
} from "../../contracts.ts";
import {
  inboxTaskPath,
  latestRunId,
  runPaths,
  runsRoot,
  taskRecordPath,
  workerBranch,
  workerPaths,
  type RunPaths,
} from "../../run/paths.ts";
import { BudgetCeilingError, BudgetManager, resumeBudget } from "../../safety/budget.ts";
import { readTranscript, reconstruct } from "../../harvest/transcript.ts";
import { combineUsage, tokensTotal, ZERO_USAGE, type UsageTotals } from "../../harvest/usage.ts";
import { DEFAULT_BRANCH_PREFIX } from "../../config/schema.ts";
import { assertEpochWellFormed } from "../../rpc/epoch.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { writeJsonAtomic } from "../../util/jsonl.ts";
import { composeBrief } from "../../roles/index.ts";
import { controlCall } from "../../supervisor/launch.ts";
import {
  readBudgetState,
  readRunBudgetPolicy,
  readRunWorktrees,
  readTaskRecord,
  readWorkerState,
} from "../../run/state.ts";
import { processStartTime, SocketRequestError } from "../../run/registry.ts";
import { loadTaskList } from "../../orchestrate/tasklist.ts";
import { runSchedule, type DispatchAnswer, type SchedulerIO } from "../../orchestrate/scheduler.ts";

/**
 * Read the envelope's `epoch` as a re-dispatch REQUEST, or `null` to allocate.
 *
 * `epoch` is mandatory in `TaskEnvelopeSchema` and 0 is the documented
 * placeholder the supervisor replaces. Allocated epochs start at 1, so 0 can
 * never name a real epoch — but treating any number as a request rejected every
 * hand-written envelope with `stale_epoch`, for supplying the one value the
 * schema forces its author to supply.
 *
 * A negative or fractional `epoch` is neither a request nor the placeholder: it
 * is malformed. `raw > 0` used to normalize `-1` into `null` — "allocate a fresh
 * epoch" — so a mistyped re-dispatch RAN the task rather than being refused. It
 * is a named error now (ISC-217). The TYPE check still falls through to
 * "allocate", because an absent `epoch` is not a malformed one.
 *
 * Exported solely so the regression test can exercise THIS expression. It was
 * previously inline, and the test that guards it re-declared an identical
 * predicate of its own — so reverting the fix in this file left the suite green.
 * A test that copies the code under test asserts only that the copy is
 * self-consistent.
 *
 * @throws {MalformedEpochError} on a negative or fractional `epoch`.
 */
export function requestedEpochFrom(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  assertEpochWellFormed(raw);
  return raw > 0 ? raw : null;
}

/**
 * One worker's observed spend, and whether observing it actually worked.
 *
 * `degraded` carries the REASON rather than a boolean because it ends up in a
 * ledger row and on stderr, and "the budget was floored" is unactionable
 * without which worker and which of the four ways it failed.
 */
export interface WorkerObservation {
  tokens: number;
  /** Null when the observation succeeded; the failure otherwise. */
  degraded: string | null;
}

/**
 * The run's opening balance — `resumeBudget` rule 1's failure mode, handled.
 *
 * Exported and pure so the decision can be mutation-tested directly rather
 * than through a fleet. The rule it implements: a CLEAN observation is
 * authoritative even when it is lower than the last published snapshot (that
 * is rotation, and re-observing is the entire point of rule 1), but a
 * DEGRADED one may not lower the balance below what the run last published
 * about itself. Zero is what every degradation observes, and zero from a
 * failed read is a refund of real spend.
 *
 * The floor is the run TOTAL, not per-worker, because `BudgetState` carries no
 * per-worker breakdown to floor against — see the residual recorded on
 * ISC-235. It is therefore a lower bound and not a reconstruction: a run where
 * one worker degraded and another genuinely spent more since the snapshot gets
 * `max(sum, persisted)`, which under-counts the healthy worker's growth. Under
 * -counting toward the CEILING is the safe direction here only because the
 * alternative — believing the zero — is unbounded.
 */
export function openingBalance(args: {
  observations: ReadonlyMap<string, WorkerObservation>;
  persisted: BudgetState | null;
}): { openingTokens: number; floored: boolean; degradations: string[] } {
  const degradations: string[] = [];
  let sum = 0;
  for (const [worker, obs] of args.observations) {
    sum += obs.tokens;
    if (obs.degraded !== null) degradations.push(`${worker}: ${obs.degraded}`);
  }
  const published = args.persisted?.tokens_spent ?? 0;
  if (degradations.length > 0 && published > sum) {
    return { openingTokens: published, floored: true, degradations };
  }
  return { openingTokens: sum, floored: false, degradations };
}

/** The supervisor's answer to one dispatch, before any exit-code policy. */
export interface SendOutcome {
  accepted: boolean;
  epoch: number | null;
  replayed: boolean;
  /** Rejection reason (`already_completed`, `prompt_rejected`, …) or null. */
  reason: string | null;
  /** Recorded verdict, present on `already_completed`. */
  verdict: string | null;
  error: string | null;
}

/** The control socket did not answer — a fact about the worker, not the task. */
export class WorkerUnreachableError extends Error {
  readonly exitCode = EXIT.WORKER_DIED;
  /**
   * True only when the dispatch provably never reached the supervisor.
   *
   * A connect failure means the socket was never opened and nothing saw the
   * envelope, so the task is untouched and another worker may take it. A
   * TIMEOUT means no such thing: the supervisor may have accepted the
   * dispatch, persisted its fence and started the agent, and merely replied
   * late — a GC pause, a slow container start, a loaded host. Retrying that
   * elsewhere runs two agents on the same brief and the same branch.
   */
  readonly neverDelivered: boolean;
  constructor(worker: string, cause: unknown) {
    super(`worker ${worker} is unreachable: ${String(cause)}`);
    this.name = "WorkerUnreachableError";
    this.neverDelivered = cause instanceof SocketRequestError && cause.neverDelivered;
  }
}

/**
 * Build the envelope from a partial task record and send it to one worker.
 *
 * This is THE dispatch path — the single-task command and the `--auto`
 * scheduler both come through here, so envelope defaults, the inbox record
 * and the ledger row cannot drift between them (a schedule whose envelopes
 * differ from hand-dispatched ones is undebuggable: the same task file
 * behaves differently depending on who sent it).
 *
 * The fields an author cannot know — `epoch`, `attempt`, `worker`,
 * `dispatched_at`, `run_id` and a 40-char `base_ref` — are filled here or by
 * the supervisor (the sole epoch allocator, SRD §7.5). `accepted:true` means
 * ACCEPTED, not started: the prompt ack is immediate and a late failure can
 * still fail the epoch afterwards (ISC-86).
 */
export async function sendTaskEnvelope(args: {
  run: RunPaths;
  worker: string;
  taskId: string;
  partial: Record<string, unknown>;
  attemptId: string;
  requestedEpoch: number | null;
  ledger: LedgerWriter;
}): Promise<SendOutcome> {
  const { run, worker, taskId, partial, attemptId, requestedEpoch } = args;

  /**
   * The worker's real checkout, as `up` recorded it (SRD §7.1/§9.1).
   *
   * `host_workdir` was the literal string `"unset"` and `branch` was a
   * hard-coded `fleet/${runId}/${worker}` that ignored `run.branch_prefix`
   * entirely — so the two fields that tell a worker WHERE it works and WHAT it
   * commits on were fiction, and an operator who set `branch_prefix: exp` got
   * envelopes naming a branch no checkout had. Both now come from the record
   * `run/worktree.ts` wrote when it created the clone, which is also the only
   * source that can be right: the branch git actually checked out and the
   * branch the envelope names are the same string or the worker's diff is
   * graded against a ref that does not exist.
   *
   * Read HERE rather than in either caller because this is THE dispatch path:
   * `--auto` and single-task `dispatch` both come through it, and a second
   * lookup in one of them is how the two modes start describing the same
   * worker differently.
   *
   * An explicit value in the task file still wins — a hand-written envelope
   * naming its own workdir is a debugging affordance, not a mistake to
   * override.
   */
  const recorded = await readRunWorktrees(run);
  if (recorded.note !== null) {
    await args.ledger.append("worktree_record_degraded", {
      worker,
      task_id: taskId,
      detail: { note: recorded.note },
    });
  }
  const perWorkerNote = recorded.perWorkerNotes.find((n) => n.startsWith(`${worker}:`));
  if (perWorkerNote !== undefined) {
    // This worker's own record failed to parse, even though the run overall
    // has a readable worktrees list — a narrower degradation than `note`
    // (which fires only when the WHOLE record is unreadable), and worth its
    // own ledger row for the same reason: a fallback envelope naming a
    // branch nothing actually checked out is a debugging trail a human will
    // want later.
    await args.ledger.append("worktree_record_degraded", {
      worker,
      task_id: taskId,
      detail: { note: perWorkerNote },
    });
  }
  const wt = recorded.byWorker.get(worker);

  // Fill the envelope; epoch 0 is a placeholder the supervisor replaces
  // with its allocation before anything durable records it.
  let envelope: TaskEnvelope;
  try {
    envelope = TaskEnvelopeSchema.parse({
      schema: "pifleet.task/v1",
      task_id: taskId,
      run_id: run.runId,
      epoch: requestedEpoch ?? 0,
      attempt: typeof partial["attempt"] === "number" ? partial["attempt"] : 1,
      worker,
      dispatched_at: new Date().toISOString(),
      title: partial["title"] ?? taskId,
      brief: partial["brief"] ?? "",
      repo: partial["repo"] ?? recorded.repo ?? "unset",
      host_workdir: partial["host_workdir"] ?? wt?.path ?? "unset",
      container_workdir: partial["container_workdir"] ?? "/workspace",
      // With no record (a `shared-ro` fleet, a hand-assembled run dir, a run
      // created before checkouts were wired) the name still has to be
      // DERIVED, not restated: `workerBranch` reproduces the string a real
      // checkout would have used. `recorded.branchPrefix` — THIS RUN's
      // actual `run.branch_prefix`, persisted at `up` time — is preferred
      // over the schema's global default: without it, an operator who set
      // `branch_prefix: experiment` still got `fleet/<run>/<worker>` for
      // every worker with no checkout of its own to read a branch off
      // (`shared-ro`, `none`), because the fallback re-derived the DEFAULT
      // rather than reading what the run was actually launched with — the
      // exact dead-config-field shape this whole fix set out to close, one
      // branch of this same `??` chain over.
      branch:
        partial["branch"] ??
        wt?.branch ??
        workerBranch(recorded.branchPrefix ?? DEFAULT_BRANCH_PREFIX, run.runId, worker),
      base_ref: partial["base_ref"] ?? wt?.baseSha ?? "0".repeat(40),
      inputs: partial["inputs"] ?? [],
      acceptance: partial["acceptance"] ?? [],
      constraints: partial["constraints"] ?? [],
      outbox: partial["outbox"] ?? `/outbox/${taskId}`,
      cloud_allow: partial["cloud_allow"] ?? [],
      deadline_s: partial["deadline_s"] ?? 1500,
      depends_on: partial["depends_on"] ?? [],
    });
  } catch (err) {
    throw new CliError(`invalid task envelope: ${String(err)}`, EXIT.USAGE);
  }

  let reply: Record<string, unknown>;
  try {
    reply = await controlCall(run, worker, {
      cmd: "dispatch",
      envelope,
      attempt_id: attemptId,
      requested_epoch: requestedEpoch,
    });
  } catch (err) {
    throw new WorkerUnreachableError(worker, err);
  }

  if (reply["accepted"] === true) {
    const epoch = reply["epoch"] as number;
    // The durable dispatch record (SRD §7.1), with the ASSIGNED epoch.
    await writeJsonAtomic(inboxTaskPath(run, taskId), { ...envelope, epoch });
    await args.ledger.append("dispatched", { worker, task_id: taskId, epoch });
    return {
      accepted: true,
      epoch,
      replayed: reply["replayed"] === true,
      reason: null,
      verdict: null,
      error: null,
    };
  }
  return {
    accepted: false,
    epoch: typeof reply["epoch"] === "number" ? reply["epoch"] : null,
    replayed: false,
    reason: String(reply["reason"] ?? "rejected"),
    verdict: typeof reply["verdict"] === "string" ? reply["verdict"] : null,
    error: typeof reply["error"] === "string" ? reply["error"] : null,
  };
}

/**
 * Register `pifleet dispatch` (SRD §10, §7.1, §9.3).
 *
 * Two modes, one envelope path. `--worker/--task` sends a single envelope;
 * `--auto --tasks` runs a whole list across the fleet's idle workers,
 * respecting `depends_on`, and exits when every task is terminal.
 *
 * The supervisor — not this command — is the sole epoch allocator (SRD §7.5):
 * dispatch carries `(task_id, requested_epoch|null)` plus an attempt id and
 * the supervisor returns the assignment or a rejection.
 *
 * The attempt id makes retries idempotent: a re-send of the same task file
 * (which may carry its own `attempt_id`) replays the original answer instead
 * of guessing between "someone else did it" and "I did it and lost the ack".
 */
export function register(program: Command): void {
  program
    .command("dispatch")
    .description("Send task envelopes to workers")
    .option("-w, --worker <id>", "worker id")
    .option("-t, --task <path>", "task envelope file, or - for stdin")
    .option("--run <id>", "run id")
    .option("--auto", "dispatch automatically across idle workers")
    .option("--tasks <path>", "task list for --auto")
    .option("--json", "emit machine-readable output")
    .action(
      async (opts: {
        worker?: string;
        task?: string;
        run?: string;
        auto?: boolean;
        tasks?: string;
        json?: boolean;
      }) => {
        if (opts.auto === true) {
          await dispatchAuto(opts);
          return;
        }
        if (opts.tasks !== undefined) {
          throw new CliError("--tasks requires --auto", EXIT.USAGE);
        }
        if (opts.worker === undefined || opts.task === undefined) {
          throw new CliError("dispatch requires --worker and --task", EXIT.USAGE);
        }
        const run = await resolveRun(opts.run);

        const raw =
          opts.task === "-"
            ? await new Response(Bun.stdin.stream()).text()
            : await Bun.file(opts.task).text();
        let partial: Record<string, unknown>;
        try {
          partial = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          throw new CliError(`task file is not valid JSON: ${String(err)}`, EXIT.USAGE);
        }

        const taskId = typeof partial["task_id"] === "string" ? partial["task_id"] : "";
        if (taskId === "") throw new CliError("task file needs a task_id", EXIT.USAGE);
        const attemptId =
          typeof partial["attempt_id"] === "string" ? partial["attempt_id"] : randomUUID();

        const ledger = new LedgerWriter(run, `cli-dispatch-${process.pid}`);
        const outcome = await sendTaskEnvelope({
          run,
          worker: opts.worker,
          taskId,
          partial,
          attemptId,
          requestedEpoch: requestedEpochFrom(partial["epoch"]),
          ledger,
        });

        const emit = (payload: Record<string, unknown>): void => {
          if (opts.json === true) process.stdout.write(`${JSON.stringify(payload)}\n`);
          else process.stdout.write(`${String(payload["summary"] ?? "")}\n`);
        };

        if (outcome.accepted) {
          emit({
            accepted: true,
            task_id: taskId,
            worker: opts.worker,
            epoch: outcome.epoch,
            attempt_id: attemptId,
            replayed: outcome.replayed,
            summary: `dispatched ${taskId} to ${opts.worker} (epoch ${outcome.epoch})`,
          });
          return;
        }

        if (outcome.reason === "already_completed") {
          // ISC-85: a completed (worker, task_id, epoch) re-dispatch is a
          // NO-OP, not an error — exit 0 with the recorded verdict.
          emit({
            accepted: false,
            reason: outcome.reason,
            task_id: taskId,
            epoch: outcome.epoch,
            verdict: outcome.verdict,
            summary: `${taskId} already completed (verdict ${String(outcome.verdict)})`,
          });
          return;
        }
        if (outcome.reason === "prompt_rejected") {
          emit({
            accepted: false,
            reason: outcome.reason,
            error: outcome.error,
            summary: `${taskId} rejected by worker`,
          });
          throw new CliError(`worker rejected the prompt for ${taskId}`, EXIT.PARTIAL);
        }
        emit({
          accepted: false,
          reason: outcome.reason,
          summary: `${taskId} not dispatched: ${outcome.reason}`,
        });
        throw new CliError(`dispatch rejected: ${outcome.reason}`, EXIT.USAGE);
      },
    );
}

/** Resolve `--run` (or the latest run) to paths, refusing a name that names nothing. */
async function resolveRun(runOpt: string | undefined): Promise<RunPaths> {
  const root = runsRoot();
  const runId = runOpt ?? (await latestRunId(root));
  if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
  const run = runPaths(runId, root);
  // Same predicate as `wait`: the run DIRECTORY, not run.json — a supervisor
  // can be launched against a run dir that `up` did not build, and a typo'd
  // --run reported as "zero workers" would send the operator to debug a
  // healthy fleet.
  if (!existsSync(run.root)) {
    throw new CliError(`no such run: ${runId} (looked in ${root})`, EXIT.USAGE);
  }
  return run;
}

/**
 * `dispatch --auto --tasks <path>` (SRD §9.3, §14.2).
 *
 * Validation happens BEFORE anything is dispatched: a cycle or an unknown
 * dependency is exit 2 with nothing running (loadTaskList), and a pin to a
 * worker outside the fleet refuses the same way (runSchedule). The loop then
 * drives every task to a terminal state and the exit code is the §10 ladder
 * over all of them.
 */
async function dispatchAuto(opts: { run?: string; tasks?: string; worker?: string; task?: string; json?: boolean }): Promise<void> {
  if (opts.tasks === undefined) {
    throw new CliError("dispatch --auto requires --tasks <path>", EXIT.USAGE);
  }
  if (opts.worker !== undefined || opts.task !== undefined) {
    throw new CliError("--auto schedules the whole list; --worker/--task do not apply", EXIT.USAGE);
  }
  const list = await loadTaskList(opts.tasks);
  const run = await resolveRun(opts.run);
  const ledger = new LedgerWriter(run, `cli-dispatch-${process.pid}`);

  /**
   * What each worker has spent so far, as last OBSERVED — the baseline the
   * budget books deltas against.
   *
   * There is no per-task usage anywhere in the system to read: `state.usage`
   * (the supervisor's `get_session_stats` numbers) and the transcript's
   * per-message usage are both cumulative for the SESSION, and A6 merges them
   * element-wise max because either can under-count (harvest/usage.ts). So
   * the task that just settled is charged the DIFFERENCE since the last look,
   * which makes the run's total exact even though no single task's share is
   * independently knowable.
   *
   * The merge is the same one `harvest --reconstruct` performs, deliberately:
   * a second way to total a worker's tokens is a second answer to how much a
   * run cost, and the ceiling and the report would drift apart.
   */
  const observed = new Map<string, number>();
  /** `worker:reason` pairs already reported, so a poll loop cannot spam. */
  const reportedDegradations = new Set<string>();
  /**
   * One worker's cumulative spend, WITH whether the observation actually
   * succeeded.
   *
   * The `degraded` half is the whole point and it is not decoration. Every
   * failure below used to return a bare `0`, which is indistinguishable from a
   * worker that genuinely burned nothing — and the other input to the merge is
   * inert, because NOTHING in `src/supervisor/` ever writes `state.usage`
   * (established in this same review round; `grep -rn get_session_stats
   * src/supervisor/` is empty). So `combineUsage(state.usage, ZERO)` is 0, and
   * a failed observation and an idle worker produced the same number.
   *
   * That is a REFUND. At resume time the sum of these becomes the run's
   * opening balance, so a run at 95% of its ceiling that crashes and cannot
   * re-read its transcripts resumes at 0 with a fresh full ceiling — n
   * restarts, n × `tokens_ceiling`. `session_path` is recorded verbatim from
   * Pi's `get_state`, so a different machine, a different mount layout, or a
   * session switch reaches this routinely rather than exotically.
   *
   * Degrading still SCHEDULES — refusing to run because a session file is
   * malformed converts a reporting problem into an outage. What changes is
   * that the caller is told, and `openingBalance` refuses to let a failed
   * observation lower the run's opening balance.
   */
  const cumulativeTokens = async (worker: string): Promise<WorkerObservation> => {
    const state = await readWorkerState(workerPaths(run, worker)).catch(() => null);
    if (state === null) {
      return { tokens: 0, degraded: "worker state is missing or unreadable" };
    }
    const path = state.session_path;
    if (path !== null && existsSync(path)) {
      try {
        const transcript = reconstruct(await readTranscript(path)).usage;
        return { tokens: tokensTotal(combineUsage(state.usage, transcript)), degraded: null };
      } catch (err) {
        return {
          tokens: 0,
          degraded: `session transcript will not parse (${err instanceof Error ? err.message : String(err)})`,
        };
      }
    }
    /**
     * No readable transcript. It is NOT knowable here whether that is a worker
     * which never spoke or a transcript that vanished.
     *
     * `session_present` looks like the answer — `run/state.ts` and
     * `classifySession` both document it as the ISC-96 discriminator between
     * `never_created` and `missing_after_present` — AND IT LAGS.
     *
     * `recordSessionPath` sets it from `existsSync` at the instant `get_state`
     * first reports the path, which is BEFORE the file is created lazily, so
     * it starts `false`. The correction is made by the heartbeat in
     * `supervisor/index.ts` (`HEARTBEAT_MS = 250`), which also flushes state —
     * so the flag trails the transcript's appearance by up to one tick.
     *
     * MEASURED, because the mechanism matters more than the guess: at the
     * instant `dispatch --auto` exits, a worker that ran a task to completion
     * and whose transcript holds 400 tokens still reads `session_present:
     * false` on disk; it flips true ~400 ms later. Any consumer reading state
     * inside that window — a resumed `dispatch --auto` started straight after
     * the previous one, exactly the case this function serves — sees `false`
     * for a worker that has genuinely spent. A classifier resting on it calls
     * a real degradation innocent, which is this finding arriving by a new
     * door. (An earlier draft of this comment blamed a "5s heartbeat"; the
     * heartbeat is 250 ms and does flush. The lag is the defect, not the
     * period.)
     *
     * The classification is therefore left AMBIGUOUS on purpose and the
     * ambiguity is resolved where the information actually exists: the caller
     * knows whether this run has spend to lose. See `openingBalance` for the
     * opening decision and `taskTokens` for the mid-run one. An ambiguous
     * signal reported as certain is worse than one reported as ambiguous.
     */
    return {
      tokens: 0,
      degraded:
        path === null
          ? "no session_path recorded"
          : // The headline case, indistinguishable here from a lazy file that
            // was never created: the path is recorded verbatim from Pi's
            // `get_state`, so a resume on a different machine or mount layout
            // finds a well-formed state file naming a transcript that is gone.
            `session transcript is absent at ${path}`,
    };
  };

  const io: SchedulerIO = {
    async listWorkers(): Promise<string[]> {
      try {
        return (await readdir(run.workersDir)).filter((w) => !w.startsWith("."));
      } catch {
        return [];
      }
    },

    async workerHealth(worker: string): Promise<"idle" | "busy" | "dead"> {
      // No state file means no supervisor ever wrote one — indistinguishable
      // from dead for scheduling purposes, and dispatching to it would only
      // convert that into a socket error one step later.
      const state = await readWorkerState(workerPaths(run, worker)).catch(() => null);
      if (state === null || state.phase === "dead") return "dead";
      if ((await processStartTime(state.pid)) === null) return "dead";
      return state.phase === "idle" ? "idle" : "busy";
    },

    async dispatch(spec: TaskSpec, worker: string, taskId: string): Promise<DispatchAnswer> {
      let outcome: SendOutcome;
      try {
        outcome = await sendTaskEnvelope({
          run,
          worker,
          taskId,
          partial: specToPartial(spec),
          // Deterministic per (run, task): a re-run of the same list against
          // the same run replays completed answers via the supervisor's
          // attempt dedup instead of re-executing work (ISC-85).
          attemptId: `auto:${spec.id}`,
          requestedEpoch: null,
          ledger,
        });
      } catch (err) {
        if (err instanceof WorkerUnreachableError) {
          // Only a provable non-delivery may be retried on another worker.
          // Anything else is in doubt, and the fence that would stop a double
          // run lives in the SUPERVISOR — it is per-worker, so a second
          // worker has never heard of this attempt and would accept it.
          return err.neverDelivered
            ? { kind: "unreachable", detail: err.message }
            : { kind: "in_doubt", detail: err.message };
        }
        throw err;
      }
      if (outcome.accepted) return { kind: "accepted", epoch: outcome.epoch ?? 0 };
      if (outcome.reason === "already_completed") {
        const parsed = VerdictSchema.safeParse(outcome.verdict);
        return { kind: "already_completed", verdict: parsed.success ? parsed.data : "unknown" };
      }
      return { kind: "rejected", reason: outcome.reason ?? "rejected" };
    },

    async readSettled(
      worker: string,
      taskId: string,
    ): Promise<{ verdict: Verdict; reason: string } | null> {
      const record = await readTaskRecord(taskRecordPath(workerPaths(run, worker), taskId));
      return record === null ? null : { verdict: record.verdict, reason: record.reason };
    },

    /**
     * Milliseconds since `worker` last appended to `events.jsonl`.
     *
     * MTIME rather than a parsed last record, deliberately. The file is
     * append-only and every append moves its mtime, so the mtime IS the last
     * event's arrival time — and reading it is one `stat` per worker per poll
     * rather than a tail-and-parse of a file that grows for the whole run.
     * What the parse would buy is the event's own `ts` field, which is stamped
     * by the supervisor and would have to be trusted across a clock the
     * scheduler does not share.
     *
     * `null` when the file does not exist: the worker has emitted nothing at
     * all since launch, so there is no last event to measure from. Reporting a
     * large silence here would kill workers that are merely still starting,
     * which inverts the criterion.
     *
     * Both readings are taken in THIS function's clock, and only their
     * difference leaves it — see `SchedulerIO.eventSilenceMs` for why the
     * scheduler must never subtract an mtime from `io.now()`.
     */
    async eventSilenceMs(worker: string): Promise<number | null> {
      try {
        const st = await stat(workerPaths(run, worker).eventsJsonl);
        return Math.max(0, Date.now() - st.mtimeMs);
      } catch {
        return null;
      }
    },

    /**
     * End a wedged worker (ISC-117).
     *
     * The ADVISORY rung only: an `abort` RPC to the supervisor, which is alive
     * and answering by construction — that is what makes this case different
     * from the reaper's. Signalling is deliberately NOT done here. The
     * identity-anchored ladder in `down` is the one place that decides a
     * process may be signalled, and duplicating any part of that decision on
     * the scheduler's path is how the two would come to disagree.
     *
     * Best-effort: the scheduler settles the task and marks the worker dead
     * whether or not this resolves, because the classification — not this
     * call's success — is the finding.
     */
    async killWedged(worker: string, taskId: string): Promise<void> {
      await ledger.append("worker_stall_kill", {
        detail: { worker, task_id: taskId, reason: "event_stall_kill" },
      });
      await controlCall(run, worker, { cmd: "abort" }, { timeoutMs: 10_000 }).catch(() => {
        // A wedged agent may have no working RPC; that is consistent with the
        // diagnosis rather than evidence against it.
      });
    },

    async taskTokens(worker: string): Promise<number> {
      /**
       * A HIGH-WATER MARK, with both sides of the trade stated.
       *
       * The benefit: a transcript that shrank (a session switch, a rotation,
       * or any of the four degradations `cumulativeTokens` names) books 0
       * rather than a negative, so it can never REFUND spend that really
       * happened or lift a ceiling the run had already crossed.
       *
       * The COST, which this comment used to omit: after a mid-run session
       * switch the ceiling is BLIND until the new transcript grows past the
       * old mark. Everything the new session burns below that line books 0, so
       * the run under-counts — the exact direction `combineUsage`'s
       * element-wise max exists to prevent, arriving by the other door. It is
       * accepted rather than fixed because the alternative is unbounded in the
       * dangerous direction: an under-count delays a halt, a refund abolishes
       * it. Per-worker per-session baselines would close it; see the residual
       * on ISC-235.
       *
       * A degradation mid-run is reported once per worker per kind — bounded,
       * and the only evidence that the ceiling went blind rather than the
       * fleet going quiet.
       */
      const obs = await cumulativeTokens(worker);
      /**
       * Same gate as the opening balance, on the same reasoning: a worker this
       * run has NEVER observed tokens from is simply quiet — the transcript is
       * created lazily, so "absent" is its ordinary state. A worker we HAVE
       * read tokens from and can no longer read is an unambiguous regression
       * in observability, and it is the mid-run session-switch case that
       * leaves the ceiling blind behind the high-water mark.
       */
      if (obs.degraded !== null && (observed.get(worker) ?? 0) > 0) {
        const key = `${worker}:${obs.degraded}`;
        if (!reportedDegradations.has(key)) {
          reportedDegradations.add(key);
          await ledger.append("budget_observation_degraded", {
            worker,
            detail: { note: obs.degraded, phase: "mid_run" },
          });
          process.stderr.write(
            `pifleet: warning: budget observation degraded — ${worker}: ${obs.degraded}\n`,
          );
        }
      }
      const now = obs.tokens;
      const seen = observed.get(worker) ?? 0;
      if (now <= seen) return 0;
      observed.set(worker, now);
      return now - seen;
    },

    sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    },

    now(): number {
      return performance.now();
    },
  };

  /**
   * THE run's budget — one manager, constructed here because this is the one
   * place that owns both the run directory and the loop that dispatches
   * (ISC-235).
   *
   * The policy travels with the RUN (`run.json`), not with today's cwd, for
   * the reason `readRunBudgetPolicy` states: a run outlives the config that
   * produced it, and a ceiling re-resolved from `./fleet.yaml` would admit a
   * task today and refuse it tomorrow with nothing about the run having
   * changed.
   *
   * The opening balance is OBSERVED, not restored. `resumeBudget` holds the
   * whole restart decision and the reasoning for it; what this loop has to
   * supply is the observation both halves of that decision are built on — the
   * same per-worker totals `observed` will book deltas against, taken at the
   * same instant as the total they sum to. Seeding the baselines from a
   * different look than the total came from is the one arrangement that
   * either double-counts a resumed worker or loses the spend since the last
   * snapshot.
   */
  const policy = await readRunBudgetPolicy(run);
  if (policy.note !== null) {
    // A degraded policy still schedules, but it must leave a trail: a run
    // capped at the default because `run.json` was unreadable is a fact a
    // human debugging its throughput will want.
    await ledger.append("budget_policy_degraded", { detail: { note: policy.note } });
    // …and the trail cannot be ONLY in the ledger. An operator whose ceiling
    // silently stopped applying gets a log line they have no reason to go
    // read; the run is degraded, so it says so where they are looking.
    process.stderr.write(`pifleet: warning: ${policy.note}\n`);
  }
  const observations = new Map<string, WorkerObservation>();
  for (const worker of await io.listWorkers()) {
    const obs = await cumulativeTokens(worker);
    observations.set(worker, obs);
    observed.set(worker, obs.tokens);
  }
  const persisted = await readBudgetState(run);
  const opening = openingBalance({ observations, persisted });
  /**
   * Report a degraded observation only when there is SPEND AT RISK.
   *
   * `cumulativeTokens` cannot tell a vanished transcript from one that was
   * never created, so on a fresh fleet every idle worker observes as
   * "degraded" — the file is created lazily on the first assistant message.
   * Warning about all of them would fire on every run of every fleet, and the
   * six-worker ISC-109 test asserts empty stderr precisely because that noise
   * is a defect in itself: a warning nobody can act on buries the one that
   * matters.
   *
   * A run with nothing published has nothing a degraded observation could
   * refund, so the ambiguity is genuinely harmless there. Once `budget.json`
   * records spend, the same ambiguity is exactly the hole — so that is when it
   * is worth saying. The FLOOR is applied on the same terms by
   * `openingBalance`, which needs `published > sum` before it can bite.
   */
  const spendAtRisk = (persisted?.tokens_spent ?? 0) > 0;
  if (spendAtRisk) {
    for (const note of opening.degradations) {
      await ledger.append("budget_observation_degraded", {
        detail: { note, floored: opening.floored },
      });
      process.stderr.write(`pifleet: warning: budget observation degraded — ${note}\n`);
    }
  }
  if (opening.floored) {
    /**
     * The refund that did not happen, said out loud.
     *
     * This is the ONE place a human can learn that the run's opening balance
     * is a floor rather than a measurement, and it matters for the next
     * decision they make: the ceiling is now being enforced against the last
     * number the run published, so spend between that snapshot and the crash
     * is unaccounted and the true balance is at least this.
     */
    const note =
      `opening balance floored at the last published tokens_spent ` +
      `(${opening.openingTokens}) because ${opening.degradations.length} worker ` +
      `observation(s) degraded; spend since that snapshot is unaccounted`;
    await ledger.append("budget_opening_floored", {
      detail: { opening_tokens: opening.openingTokens, degradations: opening.degradations },
    });
    process.stderr.write(`pifleet: warning: ${note}\n`);
  }
  const budget = new BudgetManager(
    resumeBudget({
      runId: run.runId,
      tokensCeiling: policy.tokensCeiling,
      openingTokens: opening.openingTokens,
      persisted,
    }),
  );

  const { schedule, exit, budgetRefusal } = await runSchedule(list.tasks, io, {
    budget: {
      manager: budget,
      maxConcurrent: policy.maxConcurrent,
      reserveTokens: policy.perTaskReserveTokens,
      // Atomic for the same reason the schedule record is: `wait` and
      // `report` can read this file WHILE the scheduler writes it, and a torn
      // read must yield the previous snapshot rather than half of this one.
      onChange: (snapshot) => writeJsonAtomic(run.budgetJson, snapshot),
      /**
       * A failed budget write is REPORTED, never thrown (see `ScheduleBudget`).
       *
       * Best-effort is the right call — the run's own record of what ran must
       * outrank the durability of its accounting — but best-effort in silence
       * is the defect this whole audit exists to remove. The ledger append is
       * itself a write to the same filesystem and may well fail for the same
       * reason, so stderr is the primary channel and the row is the bonus.
       */
      onPersistError: (err) => {
        process.stderr.write(
          `pifleet: warning: could not persist ${run.budgetJson}: ${String(err)}; ` +
            `the run continues and its accounting stays live in memory\n`,
        );
        void ledger
          .append("budget_persist_failed", { detail: { path: run.budgetJson, error: String(err) } })
          .catch(() => {
            // Same filesystem, same likely failure. stderr already carried it.
          });
      },
    },
    /**
     * The per-worker stall window, as `up` recorded it in `run.json`.
     *
     * `null` when the run predates the field or `run.json` records a half
     * window — in which case the policy does not engage and the fleet-wide
     * `stallTimeoutMs` remains the only stall guard, which is where every run
     * was before this landed.
     */
    ...(policy.stall === null ? {} : { stall: policy.stall }),
    onStallWarn: async (worker, taskId, silentMs) => {
      // The warn rung is a REPORT, not an action (SRD §9.3): a worker this
      // quiet may simply be thinking, and the only thing warranted before
      // `event_stall_kill` is that somebody can see it.
      await ledger.append("worker_stall_warn", {
        detail: { worker, task_id: taskId, silent_ms: silentMs },
      });
      process.stderr.write(
        `pifleet: warning: worker ${worker} has emitted no events for ` +
          `${Math.round(silentMs / 1000)}s while holding a slot on ${taskId}\n`,
      );
    },
    // The durable schedule record (run/paths.ts): `report` reads this file
    // to describe what the scheduler decided, and it is updated on every
    // state transition — atomically, because the reporter can run WHILE the
    // schedule does, and a torn read must yield the previous snapshot, not
    // half of this one. Verdicts in it are the scheduler's bookkeeping;
    // authoritative verdicts stay with harvest (SRD §7.2).
    onChange: (snapshot) => writeJsonAtomic(run.scheduleJson, snapshot),
  });

  if (opts.json === true) {
    // The shared seam, verbatim: `ScheduledTask[]` (contracts.ts), the same
    // shape `report` embeds — a consumer parses one schema, not two.
    process.stdout.write(`${JSON.stringify(schedule)}\n`);
  } else {
    process.stdout.write(renderScheduleTable(schedule));
  }
  /**
   * The ceiling is raised as a diagnosis AFTER the record is complete.
   *
   * Everything durable has already been written by this point — every task
   * record read, the schedule snapshot on disk, the budget snapshot beside
   * it, and the whole seam emitted on stdout — so the throw cannot cost the
   * run a single artifact (ISC-114's "with artifacts still harvested"). That
   * ordering is the reason `settle` never throws on the trip and this does:
   * accounting has to keep working through a halt, and only the CLI, at the
   * end, turns the halt into an exit code.
   *
   * `exit` from the scheduler is already `EXIT.BUDGET` here — the fold at the
   * end of `runSchedule` put it there. The named error is what makes the
   * message say which ceiling and how far past it, instead of "non-success
   * terminal states" for a run whose tasks all succeeded.
   */
  const spent = budget.snapshot();
  if (spent.halted_at !== null) {
    throw new BudgetCeilingError(spent.halted_reason ?? "ceiling crossed");
  }
  /**
   * The budget ended the run WITHOUT crossing the ceiling.
   *
   * `would_exceed`: admission refused because spend plus the outstanding holds
   * plus this task's reserve would overrun, so nothing ever crossed anything
   * and `halted_at` is null. With `fleet.example.yaml` as shipped this is the
   * ordinary ending rather than an edge — the final `per_task_reserve_tokens`
   * worth of every budget is unreachable by construction — and it used to
   * report the generic ladder message at 7 for a run whose every task
   * succeeded.
   *
   * The CODE comes from the scheduler's fold, deliberately: `exit` is already
   * `EXIT.BUDGET` here and this line only supplies the sentence. That keeps
   * the fold load-bearing on this path, which matters because the HALTED path
   * cannot pin it — `BudgetCeilingError` above throws before `exit` is ever
   * consulted, so deleting the fold leaves the halted tests green.
   *
   * `ceiling crossed` is deliberately NOT the wording. Nothing was crossed;
   * saying so would send an operator looking for spend that does not exist.
   */
  if (budgetRefusal !== null) {
    throw new CliError(
      `budget refused admission: ${budgetRefusal}; ` +
        `${schedule.filter((t) => t.state === "ready").length} task(s) were never dispatched ` +
        `(spent ${spent.tokens_spent} of ${spent.tokens_ceiling ?? "unbounded"} tokens)`,
      exit,
    );
  }
  if (exit !== EXIT.SUCCESS) {
    throw new CliError("dispatch --auto finished with non-success terminal states", exit);
  }
}

/**
 * A `TaskSpec` as the shared envelope path's partial-record input.
 *
 * Only authorable fields cross here — the whole point of the spec/envelope
 * split (contracts.ts): everything else is filled by `sendTaskEnvelope` and
 * the supervisor at dispatch time.
 *
 * `role` is APPLIED here rather than carried. There is no envelope field for
 * it and there should not be: a role is a standing frame the task is read
 * inside, so it composes into the brief the worker actually receives. Left
 * merely carried, `TaskSpec.role` type-checked, round-tripped through the
 * schedule snapshot and reached no worker at all — `report` would show a task
 * running as `verifier` while the container ran a generic one, which is the
 * failure §14.2 exists to prevent: an independent verifier that is only
 * nominally independent.
 */
function specToPartial(spec: TaskSpec): Record<string, unknown> {
  return {
    title: spec.title,
    brief: composeBrief(spec.role, spec.brief),
    inputs: spec.inputs,
    acceptance: spec.acceptance,
    constraints: spec.constraints,
    cloud_allow: spec.cloud_allow,
    deadline_s: spec.deadline_s,
    depends_on: spec.depends_on,
  };
}

/** Human-readable schedule, aligned by the widest cell per column. */
export function renderScheduleTable(schedule: readonly ScheduledTask[]): string {
  const rows = [
    ["TASK", "STATE", "WORKER", "VERDICT", "BLOCKED BY"],
    ...schedule.map((t) => [
      t.id,
      t.state,
      t.worker ?? "-",
      t.verdict ?? "-",
      t.blocked_by ?? "-",
    ]),
  ];
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)));
  return `${rows
    .map((r) => r.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd())
    .join("\n")}\n`;
}
