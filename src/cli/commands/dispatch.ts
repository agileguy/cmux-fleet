import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CliError } from "../index.ts";
import {
  EXIT,
  VerdictSchema,
  TaskEnvelopeSchema,
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
import { DEFAULT_BRANCH_PREFIX } from "../../config/schema.ts";
import { assertEpochWellFormed } from "../../rpc/epoch.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { writeJsonAtomic } from "../../util/jsonl.ts";
import { composeBrief } from "../../roles/index.ts";
import { controlCall } from "../../supervisor/launch.ts";
import { readRunWorktrees, readTaskRecord, readWorkerState } from "../../run/state.ts";
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

    sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    },

    now(): number {
      return performance.now();
    },
  };

  const { schedule, exit } = await runSchedule(list.tasks, io, {
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
