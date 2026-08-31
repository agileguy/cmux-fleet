import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
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
  type WorkerLaunch,
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
import { abortWedged, eventSilenceMs } from "../../run/stall-io.ts";
import { BudgetCeilingError, BudgetManager, resumeBudget } from "../../safety/budget.ts";
import { readTranscript, reconstruct } from "../../harvest/transcript.ts";
import { combineUsage, tokensTotal, ZERO_USAGE, type UsageTotals } from "../../harvest/usage.ts";
import { DEFAULT_BRANCH_PREFIX } from "../../config/schema.ts";
import { assertEpochWellFormed } from "../../rpc/epoch.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { writeJsonAtomic } from "../../util/jsonl.ts";
import { composeBrief } from "../../roles/index.ts";
import { controlCall } from "../../supervisor/launch.ts";
import { renderPrompt } from "../../supervisor/index.ts";
import { launchPaneMode } from "../../container/interrupt.ts";
import { loadBackend } from "../../backends/registry.ts";
import { assertPaneTypeableLine } from "../../util/pane-text.ts";
import { nextAttendedRecord, readAttended } from "./steer.ts";
import {
  readBudgetState,
  readPresentation,
  readRunBudgetPolicy,
  readRunWorktrees,
  readTaskRecord,
  readWorkerLaunch,
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
  /**
   * WHICH operation happened — `abort.ts`'s precedent, for its reason.
   *
   * Both routes can answer `accepted: true`, and they are not making the same
   * claim: `rpc` means the supervisor allocated an epoch, wrote a durable fence
   * and Pi acked the prompt; `pane` means `cmux` exited 0 having typed bytes
   * into a pty. Reporting the second as the first would let an operator believe
   * a fence exists that could stop a double run. See `sendViaPane`.
   */
  via: "rpc" | "pane";
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

// ---------------------------------------------------------------------------
// The pane route (SRD §3.5, TUI spec item 10)
// ---------------------------------------------------------------------------

/**
 * Which control plane a dispatch to this worker must use.
 *
 * Same three-arm shape as `container/interrupt.ts`'s `InterruptPlan`, and for
 * the same reason: the third arm must not be folded into either other. A worker
 * whose launch record and rendered argv DISAGREE about its pane mode is not a
 * worker whose mode is in doubt — it is one that cannot work — and guessing
 * would either type a prompt into a pane that does not exist or send an RPC to
 * a socket nobody is listening on.
 *
 * ## `launch === null` is `rpc`, and that is a correction
 *
 * The absent record is the `PIFLEET_PI_COMMAND` double. `abort.ts` originally
 * read that absence as "no control plane at all", reasoning that a double has
 * no container to signal — a true premise with the wrong conclusion, because
 * the double also has a live supervisor holding a real RPC control socket. Two
 * ISC-81 integration tests went red on it and no unit test did, because the
 * unit test asserted the refusal and so pinned the defect in place. The
 * supervisor states the same answer from its own side (`supervisor/index.ts`:
 * *"`launch === null` … is `rpc` and cannot be anything else"*), and this
 * function agrees with it rather than re-deriving it.
 */
export type DispatchRoute =
  /** The control socket, unchanged — every `rpc` worker and the double. */
  | { kind: "rpc" }
  /** A `tui` worker: keystrokes into its pane. */
  | { kind: "pane" }
  /** Neither route is available, with the reason an operator can act on. */
  | { kind: "unavailable"; reason: string };

/**
 * Decide how one worker's prompt reaches it, from the launch record only.
 *
 * Read off what `up` ACTUALLY RAN, never off config: `up` resolved the mode in
 * a cwd and environment this process does not share. `launchPaneMode` is
 * imported rather than reproduced — it owns the field-plus-two-marks agreement
 * rule and the reasons for it, and a second copy here is how the CLI and the
 * abort path would start disagreeing about which plane a worker has.
 */
export function planDispatch(launch: WorkerLaunch | null): DispatchRoute {
  if (launch === null) return { kind: "rpc" };
  const mode = launchPaneMode(launch);
  if (mode === "rpc") return { kind: "rpc" };
  if (mode === "tui") return { kind: "pane" };
  return {
    kind: "unavailable",
    reason:
      "launch argv carries neither a consistent rpc nor a consistent tui shape " +
      "(--mode rpc and -t disagree) — refusing to guess which control plane this worker has",
  };
}

/** A prompt this route cannot type without changing what it says. */
export class UntypeablePromptError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(worker: string, line: number, why: string) {
    super(
      `worker ${worker} is pane_mode: tui, so its prompt is typed into a terminal, and ` +
        `line ${line} of the rendered prompt cannot be typed as written: ${why}. ` +
        `Nothing was sent — the pane is untouched.`,
    );
    this.name = "UntypeablePromptError";
  }
}

/** One step of the pane plan: literal text, or a key event. */
export type PaneKeystroke = { kind: "text"; text: string } | { kind: "key"; key: string };

/**
 * The complete keystroke plan for one prompt — built and VALIDATED in full
 * before its first byte is sent.
 *
 * ## Why a multi-line prompt is not one `cmux send`
 *
 * Measured 2026-08-31 against the real Pi TUI (v0.79.6, the shipped worker
 * image, a cmux pane running `docker attach`), one fresh container per arm:
 *
 *   send `ARMD text in the box`, no key   ->  text sits in Pi's prompt box
 *   then send-key `enter`                 ->  box CLEARS: submitted
 *   send `ARMB first line<LF>ARMB second` ->  box holds only `ARMB second`
 *   send `ARMC first line\nARMC second`   ->  box holds only `ARMC second`
 *
 * Rows 3 and 4 are the failure this function exists to prevent: the first line
 * was submitted as a turn of its own and the REST OF THE OPERATOR'S INTENT was
 * left sitting unsent in the box, with `cmux send` exiting 0. A dispatch that
 * looked successful would have delivered a fragment. Row 4 is the nastier of
 * the two because the text never contained a newline at all — cmux converts the
 * two-character sequence `\n` to Enter, and `assertCmuxSendText` refuses it for
 * that reason.
 *
 * ## What makes multi-line possible at all
 *
 *   send `ARME line one`, send-key `shift+enter`, send `ARME line two`
 *     ->  Pi's prompt box holds BOTH lines, unsubmitted
 *
 * So `shift+enter` inserts a newline in Pi's composer without submitting.
 * cmux emits it as `ESC [ 27;2;13 ~` (measured against a plain `read`, which
 * ignored it — it is an escape sequence, not a newline byte), and Pi binds it.
 * That is the whole mechanism: one `send` per line, `shift+enter` between them,
 * a single `enter` at the end, and exactly one turn results.
 *
 * ## Validate everything, THEN send anything
 *
 * The plan is built completely — every line through `assertCmuxSendText` —
 * before the caller executes any of it. A prompt with an untypeable line on
 * page three must not leave two pages of it half-typed in a person's pane: an
 * operator who then presses Enter submits a truncated brief that this command
 * has no record of. All-or-nothing is the only shape that makes the refusal
 * meaningful.
 *
 * An EMPTY line contributes only its `shift+enter`. `assertCmuxSendText`
 * refuses empty text (cmux answers `Error: send requires text`), and a blank
 * line in markdown is a paragraph break rather than something to type.
 *
 * **NOT CLAIMED:** that the plan's execution is atomic. Each step is a separate
 * `cmux` invocation with no ack, so a failure midway leaves a partial prompt in
 * the box. That is reported (the caller names the step that failed) but it
 * cannot be rolled back — nothing here can un-type a keystroke.
 */
export function paneKeystrokes(worker: string, prompt: string): PaneKeystroke[] {
  const lines = prompt.split("\n");
  const plan: PaneKeystroke[] = [];
  lines.forEach((line, i) => {
    if (i > 0) plan.push({ kind: "key", key: "shift+enter" });
    if (line === "") return;
    try {
      // The SAME predicate `sendArgv` enforces (`util/pane-text.ts`), applied
      // one layer up so the refusal happens before any byte is typed rather
      // than partway through. One definition, so the gate cannot become laxer
      // than the backstop.
      assertPaneTypeableLine("prompt line", line);
    } catch (err) {
      throw new UntypeablePromptError(worker, i + 1, err instanceof Error ? err.message : String(err));
    }
    plan.push({ kind: "text", text: line });
  });
  plan.push({ kind: "key", key: "enter" });
  return plan;
}

/**
 * Type one envelope's prompt into a `tui` worker's pane.
 *
 * ## What this records, and what it can no longer promise (question (a))
 *
 * SRD §3.5 voids `queue_update` and epoch fencing for this mode and calls
 * completion "transcript-derived, coarser". This is that sentence in code, and
 * the honest version of it is blunter than the SRD's:
 *
 *  - **There is no epoch.** The supervisor is the sole epoch allocator (SRD
 *    §7.5) and it allocates inside the RPC `dispatch` handler, which this
 *    worker does not have — `supervisor/index.ts` refuses that path outright
 *    with `pane_mode_tui_has_no_rpc_dispatch`. So the envelope keeps the schema
 *    placeholder 0, in the inbox record AND in the rendered prompt, and nothing
 *    will ever replace it.
 *
 *    That is CONSISTENT rather than merely absent, and the consistency is
 *    load-bearing: `harvest/outbox.ts` refuses a result whose envelope epoch
 *    differs from the inbox record's (`envelope epoch N is stale (expected M)`),
 *    so writing 0 in one place and rendering something else in the other would
 *    clamp a completed task to `verdict=unknown` — the exact live failure
 *    `test/unit/prompt-identity.test.ts` records. Both are 0 here, so the
 *    harvest correlates.
 *
 *    What is LOST is what the number was FOR. 0 cannot distinguish attempt 1
 *    from attempt 2, so a re-dispatch of the same task file types the prompt a
 *    second time, runs it a second time, and the harvest accepts whichever
 *    `result.json` lands last. On the rpc path `already_completed` and the
 *    attempt-id replay make that a no-op (ISC-85); here neither exists.
 *
 *  - **There is no ack.** `accepted: true` on the rpc path means the supervisor
 *    recorded a durable fence and Pi acked the prompt. Here it means `cmux`
 *    exited 0 on each of N invocations — bytes reached a pty. It does not prove
 *    Pi read them, that a turn started, or that the program on that terminal is
 *    Pi at all. The JSON says `via: "pane"` so the two claims are never
 *    confused for each other, and `epoch` is `null` rather than 0 so no reader
 *    can mistake the placeholder for a fence.
 *
 *  - **`prompt_rejected` cannot happen.** Pi has no way to refuse a keystroke,
 *    so the absence of that outcome here is not evidence that nothing refused.
 *
 *  - **Completion is transcript-derived.** `wait` and the harvest settle from
 *    the session file (`supervisor/tui.ts`'s `classifyTuiTurn`), which is
 *    coarser than the rpc path's double-correlated `get_state` probe.
 *
 * ## It writes an attended record
 *
 * A prompt typed into a terminal is a human's keystrokes arriving outside the
 * fenced control plane — the same act `steer` records, and `nextAttendedRecord`
 * is imported from there rather than copied so the two cannot drift. The
 * transcript now holds an operator-authored message no fence saw, and `report`
 * must be able to say so. Its `tui`-record case returns null and touches
 * nothing, which is what keeps a dispatch from stamping `left_at` on a pane a
 * person is still driving.
 *
 * **NOT CLAIMED:** that this closes the invariant for a `pane_mode: tui`
 * worker. Its pane runs `docker attach` from the moment `up` creates it, so a
 * person can type into it having run no pifleet command at all — and until they
 * do, the run still presents as unattended. Closing that needs the record
 * written at `up` time; see `cli/commands/tui.ts` for the same residual stated
 * from the other end.
 */
async function sendViaPane(args: {
  run: RunPaths;
  worker: string;
  envelope: TaskEnvelope;
  ledger: LedgerWriter;
}): Promise<SendOutcome> {
  const { run, worker, envelope } = args;
  const wp = workerPaths(run, worker);

  const presentation = await readPresentation(wp);
  if (presentation === null) {
    throw new CliError(
      `worker ${worker} is pane_mode: tui but has no presentation record in run ${run.runId}; ` +
        `there is no pane to type into`,
      EXIT.USAGE,
    );
  }
  if (presentation.backend === "headless" || presentation.surface_ref === null) {
    // The mode's own contradiction, named. `config/validate.ts` refuses
    // `pane_mode: tui` on a headless backend at config time, so reaching here
    // means the effective backend was chosen at `up` (the residual TUI-SPEC
    // Phase 1 records as necessarily partial until Phase 4).
    throw new CliError(
      `worker ${worker} is pane_mode: tui but its backend is ${presentation.backend} with no ` +
        `surface — a tui worker's prompt has nowhere to go`,
      EXIT.BACKEND_UNAVAILABLE,
    );
  }

  const backend = await loadBackend(presentation.backend);
  if (backend.sendText === undefined || backend.sendKey === undefined) {
    throw new CliError(
      `backend ${presentation.backend} cannot type into a pane (no sendText/sendKey), so it ` +
        `cannot dispatch to the pane_mode: tui worker ${worker}`,
      EXIT.BACKEND_UNAVAILABLE,
    );
  }
  const pane = { backend: presentation.backend, id: presentation.surface_ref };

  /**
   * The SAME document the rpc route delivers, from the SAME renderer.
   *
   * Not a pane-specific abbreviation: `sendTaskEnvelope`'s own docblock says a
   * task file must not behave differently depending on who sent it, and a
   * prompt that dropped the fenced identity block would leave the worker unable
   * to bind `<task-id>` and `<outbox>` — it would do the work and write it
   * nowhere the harvest looks.
   *
   * `epoch: envelope.epoch` and not a literal 0, so that if this route ever
   * does acquire an allocator the prompt follows it. Today it is 0 by the same
   * placeholder that reaches the inbox record, which is what makes the two
   * agree.
   */
  const prompt = renderPrompt({ ...envelope, epoch: envelope.epoch });
  const plan = paneKeystrokes(worker, prompt);

  for (const [i, step] of plan.entries()) {
    try {
      if (step.kind === "text") await backend.sendText(pane, step.text);
      else await backend.sendKey(pane, step.key);
    } catch (err) {
      /**
       * A partial prompt is now sitting in the pane, and saying so is the whole
       * point of this catch. There is no way to un-type it, and an operator who
       * does not know it is there will press Enter on a truncated brief.
       */
      throw new CliError(
        `worker ${worker}: pane dispatch failed at step ${i + 1} of ${plan.length} ` +
          `(${step.kind}): ${String(err)}. Part of the prompt is now in the pane and cannot be ` +
          `withdrawn — clear it before retrying`,
        EXIT.BACKEND_UNAVAILABLE,
      );
    }
  }

  // The durable dispatch record (SRD §7.1). Epoch 0 verbatim — see the
  // docblock: it is the placeholder nothing will replace, and it must be the
  // same 0 the prompt carried or the harvest calls the result stale.
  await writeJsonAtomic(inboxTaskPath(run, envelope.task_id), envelope);
  /**
   * `dispatched`, the same event name the rpc route appends, so every existing
   * reader still sees every dispatch — `abort_sent`'s precedent, for its
   * reason. `epoch` is OMITTED rather than set to 0: a reader that sees the
   * field expects a fence, and there is none.
   */
  await args.ledger.append("dispatched", {
    worker,
    task_id: envelope.task_id,
    detail: {
      via: "pane",
      backend: presentation.backend,
      surface: presentation.surface_ref,
      steps: plan.length,
      lines: plan.filter((s) => s.kind === "text").length,
    },
  });

  const record = nextAttendedRecord(
    await readAttended(wp.attendedJson),
    worker,
    new Date().toISOString(),
  );
  if (record !== null) await writeJsonAtomic(wp.attendedJson, record);

  return {
    accepted: true,
    // NOT 0. The placeholder is what the envelope and the prompt carry; `null`
    // here is this route saying it allocated nothing.
    epoch: null,
    replayed: false,
    reason: null,
    verdict: null,
    error: null,
    via: "pane",
  };
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

  /**
   * WHICH plane this prompt travels on, decided from the launch record.
   *
   * Placed here, in THE dispatch path, for the reason the worktree lookup above
   * gives: `--auto` and single-task `dispatch` both come through this function,
   * and a second resolution in one of them is how the two modes start
   * disagreeing about the same worker.
   *
   * A read failure is NOT silently an rpc worker. `readWorkerLaunch` throws on
   * a damaged record and returns null only for an absent one, and those two
   * mean different things: absent is the `PIFLEET_PI_COMMAND` double (rpc);
   * damaged is a worker whose plane is unknown, and this is the one place that
   * can still refuse before a prompt goes somewhere wrong.
   */
  const route = planDispatch(await readWorkerLaunch(workerPaths(run, worker)));
  if (route.kind === "unavailable") {
    throw new CliError(
      `worker ${worker} in run ${run.runId} cannot be dispatched to: ${route.reason}`,
      EXIT.USAGE,
    );
  }
  if (route.kind === "pane") {
    return sendViaPane({ run, worker, envelope, ledger: args.ledger });
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
      via: "rpc",
    };
  }
  return {
    accepted: false,
    epoch: typeof reply["epoch"] === "number" ? reply["epoch"] : null,
    replayed: false,
    reason: String(reply["reason"] ?? "rejected"),
    verdict: typeof reply["verdict"] === "string" ? reply["verdict"] : null,
    error: typeof reply["error"] === "string" ? reply["error"] : null,
    via: "rpc",
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
            // `via` distinguishes two different claims that share a field —
            // see `SendOutcome.via`.
            via: outcome.via,
            summary:
              outcome.via === "pane"
                ? // No epoch, and the sentence says why rather than printing
                  // `epoch null` and leaving an operator to wonder.
                  `typed ${taskId} into ${opts.worker}'s pane (no epoch — a tui worker has no ` +
                  `control socket and nothing allocated a fence)`
                : `dispatched ${taskId} to ${opts.worker} (epoch ${outcome.epoch})`,
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

    /**
     * The scheduler's window onto `pane_mode` (TUI spec item 13), so it can
     * refuse a `depends_on` edge onto a tui worker before dispatching anything.
     *
     * `planDispatch` and not a second reading of the launch record: it owns the
     * `launch === null` -> rpc answer and the field-leads-marks-veto rule, and
     * the whole reason `launchPaneMode` is imported rather than reproduced in
     * this file is that a second copy is how the CLI and the abort path would
     * start disagreeing about which plane a worker has. Two computations of one
     * fact are two things that can disagree after an edit.
     *
     * An UNREADABLE record answers `"unknown"` rather than throwing, and that
     * is not swallowing the error: `sendTaskEnvelope` still refuses it with the
     * reason at dispatch time, and the scheduler's own contract is that
     * `"unknown"` is not tui. Throwing here would convert a damaged record for
     * ONE worker into a refusal of the whole schedule, including the tasks that
     * never touch it.
     */
    async paneMode(worker: string): Promise<"rpc" | "tui" | "unknown"> {
      const route = planDispatch(
        await readWorkerLaunch(workerPaths(run, worker)).catch(() => null),
      );
      if (route.kind === "rpc") return "rpc";
      return route.kind === "pane" ? "tui" : "unknown";
    },

    async dispatch(spec: TaskSpec, worker: string, taskId: string): Promise<DispatchAnswer> {
      /**
       * `--auto` never types into a person's pane.
       *
       * Not squeamishness — the loop could not FINISH one. `runSchedule` drives
       * a dispatched task to a terminal state by polling `readSettled`, which
       * reads the task record the supervisor writes when it settles an epoch.
       * A pane-typed prompt never reaches the supervisor at all (it refuses the
       * RPC path with `pane_mode_tui_has_no_rpc_dispatch` and settles a tui
       * worker from its transcript, with no task id to file it under), so no
       * task record can ever appear and the task would sit in `running` until
       * the stall policy killed it. A rejection names the reason in one line;
       * a hang names nothing.
       *
       * THE ALTERNATIVE REJECTED: reporting a tui worker as `busy` from
       * `workerHealth`, so the scheduler never offers it work. That reads
       * tidier and is worse — a task PINNED to that worker (`spec.worker`)
       * would then wait for an idle it can never reach, converting this visible
       * rejection into the invisible hang it exists to avoid. Health is left
       * telling the truth about the process; routing is refused here, where the
       * refusal is attached to a task and can be reported.
       *
       * An unreadable launch record is left to `sendTaskEnvelope`, which
       * already refuses it with the reason. Only the pane route is decided
       * here, because only the pane route is a scheduling question.
       */
      const route = planDispatch(
        await readWorkerLaunch(workerPaths(run, worker)).catch(() => null),
      );
      if (route.kind === "pane") {
        const reason = "pane_mode_tui_is_not_auto_schedulable";
        await ledger.append("dispatch_rejected", {
          worker,
          task_id: taskId,
          detail: {
            reason,
            note:
              "a tui worker is prompted through its pane and settles from its transcript; " +
              "--auto cannot observe that task reaching a terminal state",
          },
        });
        return { kind: "rejected", reason };
      }

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
     * The two production halves of the stall policy (ISC-282).
     *
     * BINDING ONLY — the behaviour is `run/stall-io.ts`, and it lives there
     * rather than here because this object cannot be constructed outside a CLI
     * invocation, which left both functions untestable for as long as they sat
     * in it. Anything a reader wants to know about mtime-vs-parse, the `null`
     * answer for a worker that has emitted nothing, or why the abort rung is
     * advisory and never a signal, is documented on those two functions.
     */
    async eventSilenceMs(worker: string): Promise<number | null> {
      return eventSilenceMs(run, worker);
    },

    async killWedged(worker: string, taskId: string): Promise<void> {
      await abortWedged({ run, worker, taskId, ledger });
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
