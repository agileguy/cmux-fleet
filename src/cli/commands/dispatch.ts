import type { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CliError } from "../index.ts";
import {
  EXIT,
  VerdictSchema,
  TaskEnvelopeSchema,
  type BudgetState,
  type Presentation,
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
  type WorkerPaths,
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
import {
  assertHostAuthoredPaneLine,
  assertPaneKey,
  assertPaneTypeableLine,
  SESSION_RESET_LINE,
  STAGED_TRIGGER_LINE,
} from "../../util/pane-text.ts";
import { writeTaskPolicy } from "../../run/task-policy.ts";
import {
  DISPATCH_POLICY_MOUNT,
  writeDispatchPolicy,
} from "../../run/dispatch-policy.ts";
import { terminalRefusal, terminalRefusalMessage } from "../../attended/adopt.ts";
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
/**
 * The attempt id a STAGED dispatch carries (SRD-TUI-DISPATCH §9 Q9).
 *
 * ## What an attempt id is for, which decides how this must be derived
 *
 * `EpochManager` dedups on `(task_id, attempt_id)`: a second allocate under a
 * known pair returns the ORIGINAL epoch and runs nothing. On the staged route
 * that replay IS the fence — §6.3 makes it the mechanism by which a staged
 * dispatch is deduplicated at all, and ISC-440 requires that staging the same
 * task file twice replays rather than allocating.
 *
 * A random id can never match a stored one, so a staged dispatch that minted
 * one would get no replay: the second stage of an unchanged file would find the
 * first epoch still live and be refused `busy`. Item 4 of §1.3 would stay open
 * while looking closed.
 *
 * ## Scoped to the STAGED route, and the scoping was corrected rather than
 * ## chosen
 *
 * This was briefly the fallback for `pifleet dispatch <file>` on every route,
 * on the argument that an id depending on which control plane a worker had
 * would make the same file dedup differently two ways. That argument was built
 * on a false premise — that the rpc route's `randomUUID()` let a re-dispatch
 * RUN THE TASK TWICE. It does not: a settled task is refused
 * `already_completed` off `completed`, and a live one is refused `busy`, both
 * keyed on `task_id` alone. What a random id actually costs there is narrower:
 * a caller who loses an ack mid-flight re-sends and gets `busy` instead of its
 * original answer.
 *
 * **The cost of widening it was concrete and was caught by an existing
 * criterion.** With a content id, re-dispatching a completed task becomes the
 * SAME attempt, so `allocate` replays it — and `test/e2e/lifecycle.test.ts`
 * pins ISC-85's Phase-1 exit shape as `accepted: false`, `already_completed`.
 * Both behaviours are the no-op ISC-85 asks for; only the wire shape differs.
 * Redefining a graded Phase-1 criterion is not this document's to do, and §9 Q9
 * asks about a staged dispatch and nothing else.
 *
 * ## The content, and what "content" means here
 *
 * The task file as PARSED and re-serialized, not its raw bytes: reformatting a
 * file is not a new task, and `JSON.stringify` over the object `JSON.parse`
 * produced preserves the operator's key order while dropping whitespace. An
 * edited brief is a different task and gets a different id, which is the
 * property ISC-458 asserts in both directions.
 *
 * 16 hex characters of SHA-256, prefixed so it is never mistaken for `auto:`
 * or for an id an operator wrote by hand — and an explicit `attempt_id` in the
 * file still wins over this, on every route.
 */
export function attemptIdFor(taskContent: string): string {
  return `file:${createHash("sha256").update(taskContent).digest("hex").slice(0, 16)}`;
}

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
   *
   * `staged` is a THIRD claim and is not a weaker `pane`. It means the identity
   * — task id, epoch, outbox and the whole brief — was written into the
   * worker's read-only policy plane, and that a short trigger was typed at the
   * surface (or, when there is no addressable surface, printed for the operator
   * to type). What reached the terminal on this route is one line; what reached
   * the worker is a file it cannot write. See `stageForAdoptedTerminal`.
   */
  via: "rpc" | "pane" | "staged";
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
/**
 * The two keys a pane dispatch uses, named rather than spelled inline.
 *
 * `shift+enter` inserts a newline in Pi's composer without submitting; `enter`
 * submits. Both are cmux's vocabulary, which `util/pane-text.ts` records as the
 * fleet's canonical one and `backends/tmux/argv.ts` translates.
 */
export const SEPARATOR_KEY = "shift+enter";
export const SUBMIT_KEY = "enter";

export function paneKeystrokes(worker: string, prompt: string): PaneKeystroke[] {
  const lines = prompt.split("\n");
  const plan: PaneKeystroke[] = [];
  lines.forEach((line, i) => {
    if (i > 0) plan.push({ kind: "key", key: SEPARATOR_KEY });
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
  plan.push({ kind: "key", key: SUBMIT_KEY });

  /**
   * THE KEYS ARE GATED TOO, and originally they were not.
   *
   * The text lines above go through `assertPaneTypeableLine` here, one layer
   * above the backend, precisely so a prompt that cannot be typed is refused
   * before any byte of it is. The key steps had no such gate, and a backend
   * that refuses a key refuses it mid-plan: measured live on 2026-08-31,
   * `cmux` rejected `shift+enter` at STEP 2 OF 29 with two lines of the
   * operator's prompt already in the pane and unwithdrawable.
   *
   * Validating the WHOLE plan restores the property the docblock above claims:
   * either nothing is typed, or the plan is one every step of which the
   * backend will accept. Half a gate is not a gate — it just moves which kind
   * of step strands the prompt.
   *
   * **THIS LOOP CANNOT FIRE TODAY, and that is stated rather than implied.**
   * The only keys it inspects are `SEPARATOR_KEY` and `SUBMIT_KEY`, both
   * constants, both members of `PANE_KEYS`. A mutation deleting this loop
   * leaves the unit suite green, which was checked — so it is not carrying the
   * weight the paragraph above might suggest. What actually holds the property
   * is the probe pinning those two constants against `PANE_KEYS`.
   *
   * It stays because the thing it guards is a FUTURE edit: the first key that
   * comes from a task, a config or a role rather than from a constant here.
   * Then it becomes reachable and this is where it must already be. Kept as a
   * declared, unreachable backstop rather than removed and re-derived later —
   * and labelled, so nobody reads it as the live gate.
   */
  for (const step of plan) {
    if (step.kind !== "key") continue;
    try {
      assertPaneKey("prompt key", step.key);
    } catch (err) {
      throw new UntypeablePromptError(worker, 0, err instanceof Error ? err.message : String(err));
    }
  }
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
  /**
   * Carried through unused by the pane route and REQUIRED by the staged one.
   *
   * The two routes fork below, and only one of them has an allocator to dedup
   * against — the backend-managed pane route has no epoch at all, which is
   * ISC-84's row. Threading it to the fork rather than into `sendViaPane`'s own
   * body is what stops the staged route re-deriving it; see `attemptId` on
   * `stageForAdoptedTerminal`.
   */
  attemptId: string;
  /** The staged route's dedup key; see `sendTaskEnvelope`. */
  stagedAttemptId: string;
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
  /**
   * THE STAGED ROUTE — the fork SRD-TUI-DISPATCH D1 adds, taken before the
   * headless/no-surface refusal below because an adopted terminal satisfies
   * that condition's letter and not its meaning.
   *
   * `adopted_terminal` and not `backend === "headless"`: the run's presentation
   * backend is headless for this worker, correctly (the fleet opens no windows
   * of its own), and that used to be read as "there is no pane". There is one —
   * a person is looking at it.
   */
  if (presentation.adopted_terminal) {
    return stageForAdoptedTerminal({ ...args, attemptId: args.stagedAttemptId, wp, presentation });
  }

  if (presentation.backend === "headless" || presentation.surface_ref === null) {
    // The mode's own contradiction, named. `config/validate.ts` refuses
    // `pane_mode: tui` on a headless backend at config time, so reaching here
    // means the effective backend was chosen at `up` (the residual TUI-SPEC
    // Phase 1 records as necessarily partial until Phase 4).
    /*
     * An ADOPTED pane is a different sentence, and the difference matters to
     * whoever is reading it. "Nowhere to go" is right for a headless run with
     * no pane at all. When `up --attach-here` handed a terminal to this
     * worker there IS a pane — a person is looking at it — and what they need
     * to be told is that they are the dispatcher, not that something is
     * missing. Same refusal, same exit code; only the diagnosis changes.
     */
    /*
     * The ADOPTED case no longer reaches here — it forks above into the staged
     * route — so this is once again the single sentence it was written as: a
     * headless run with no pane at all, where a tui worker's prompt genuinely
     * has nowhere to go. That case is untouched by D1 and keeps its original
     * wording, which is `ISC-454`.
     */
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

  /**
   * Provenance BEFORE the first byte — the same write, in the same order, that
   * `supervisor/index.ts` performs on the rpc route, and it was missing here.
   *
   * ## What its absence did
   *
   * `writeTaskPolicy` had three call sites and two of them reset the file to
   * `(<none>, 0)`: `materialize.ts` when the worker directory is built, and the
   * supervisor when a task settles. The only real write was inside the RPC
   * `dispatch` handler — a handler this route deliberately never reaches. So a
   * worker dispatched through its pane ran its WHOLE LIFE with `/policy/task`
   * reading `<none>` and `0`, and every gated cloud verb it executed was
   * ledgered against no task at all. That is ISC-360's original finding
   * recurring on a route built after it: the audit trail records THAT a
   * destructive verb was attempted and loses WHICH task attempted it.
   *
   * Confirmed live 2026-09-02 by reading the file out of a running
   * adopted-terminal container: `-r--r--r-- 1 pi pi 9 /policy/task`, contents
   * `<none>\n0\n`, while the worker was mid-task. The mount was correct, the
   * mode was correct, and nothing had ever written a value into it.
   *
   * ## Why here and not earlier
   *
   * AFTER `paneKeystrokes`, which is the last thing that can refuse: an
   * untypeable prompt throws there, and a dispatch that never types must not
   * leave this worker's provenance pointing at a task no pane ever received.
   * BEFORE the send loop, because the instant the first line lands the worker
   * can start a turn and run a gated verb, and a verb classified before this
   * write is attributed to the PREVIOUS task — which is worse than `<none>`,
   * being wrong rather than merely absent.
   *
   * `envelope.epoch` verbatim, which on this route is the placeholder 0. The
   * same 0 the prompt carries and the same 0 the inbox record carries, for the
   * reason the docblock above gives at length: consistency across the three is
   * what keeps the harvest correlating rather than clamping. When this route
   * acquires a real allocator the value follows the envelope without this line
   * being touched.
   */
  await writeTaskPolicy(wp.taskPolicy, envelope.task_id, envelope.epoch);

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
    /**
     * THE STAGED ROUTE'S OWN ATTEMPT ID, derived here rather than inherited.
     *
     * The caller's `attemptId` is `randomUUID()` for a single-task dispatch,
     * which the rpc route wants (ISC-85's Phase-1 shape rests on a fresh
     * attempt reaching `already_completed`). The staged route needs the
     * opposite: a re-stage of an unchanged file must REPLAY, which only
     * happens if the pair is recognised. See `attemptIdFor`.
     *
     * An explicit `attempt_id` in the task file still wins, on both routes.
     */
    const stagedAttemptId =
      typeof args.partial["attempt_id"] === "string"
        ? args.partial["attempt_id"]
        : attemptIdFor(JSON.stringify(args.partial));
    return sendViaPane({
      run,
      worker,
      envelope,
      attemptId,
      stagedAttemptId,
      ledger: args.ledger,
    });
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

/**
 * Stage a task for a worker whose pane is a terminal a person handed over, then
 * type the one line that starts it.
 *
 * ## The split this route is built on
 *
 * A dispatch is two things: an IDENTITY — task id, epoch, outbox path, the
 * brief — and a TRIGGER, the byte that starts a turn. Only the trigger needs a
 * terminal. So the identity goes through the read-only policy plane, where the
 * worker can read it and cannot write it, and the terminal receives one short
 * line. `SRD-TUI-DISPATCH` §0.1.
 *
 * That split is what makes typing at this surface tolerable at all.
 * `docker attach --detach-keys=ctrl-]` means detach is one keypress pifleet
 * cannot observe, and after it the surface hosts the operator's own SHELL. D2
 * recommended never typing here for that reason; the owner reversed it on
 * 2026-09-02, and this shape is why the reversal is defensible: what could
 * land in a shell is `STAGED_TRIGGER_LINE`, which begins `#` and cannot
 * execute, rather than a markdown brief delivered line by line.
 *
 * ## The order of the writes is the correctness argument
 *
 * Borrowed verbatim from the RPC route (`supervisor/index.ts`), and the reasons
 * transfer with one change of scale: there, the gap between writing the fence
 * and acting under it is milliseconds. Here it is however long the worker takes
 * to read its drop — which makes the ordering easier to get right and much more
 * expensive to get wrong.
 *
 *  1. Refuse if the terminal is gone (D9). Before anything is allocated, so a
 *     refusal burns no epoch.
 *  2. Allocate, through the supervisor's `stage` verb. A second stage while one
 *     is pending is refused `busy` BY THE ALLOCATOR — this route adds no check
 *     of its own, because a second spelling of a fact the allocator owns is two
 *     rules.
 *  3. The fence, the provenance and `state` are persisted by `stage` itself,
 *     inside the supervisor, in that order.
 *  4. Write the drop. AFTER the epoch exists, because the drop carries it and a
 *     drop whose epoch disagrees with the inbox record's makes the harvest
 *     refuse a correct result.
 *  5. Write the inbox record, with the REAL epoch, so `dispatchedTaskIds` sees
 *     the id and the harvest correlates. This is the whole of what makes a
 *     staged task harvestable, and it needs no harvest change at all.
 *  6. Append `dispatched` with `via: "staged"`.
 *  7. Trigger.
 *
 * ## Why the trigger is last, and why its failure is not fatal
 *
 * Everything above is durable. If the send fails, the task is STAGED — recorded,
 * reportable, and triggerable by hand — which is a strictly better state than
 * the refusal this route replaced. So a failed send degrades to the printed
 * instruction rather than throwing away six durable writes, and says so.
 */
async function stageForAdoptedTerminal(args: {
  run: RunPaths;
  worker: string;
  envelope: TaskEnvelope;
  /**
   * The CALLER's attempt id, threaded rather than re-derived (ISC-458).
   *
   * This route used to send `String(envelope.attempt)`, which is `1` for every
   * fresh dispatch because `attempt` DEFAULTS to 1 a few hundred lines up. Two
   * different task files sharing a `task_id` therefore shared an attempt key,
   * and the second one REPLAYED the first: same epoch, no rewrite of the drop,
   * `replayed: true` reported as success. The operator edits the brief, stages
   * it, is told it worked, and the worker is still holding the old one.
   *
   * That is the exact hazard §9 Q9 was answered to prevent, and it was
   * reintroduced one line below the answer by re-deriving a value that was
   * already in scope. Re-derivation is the defect; the parameter is the fix.
   */
  attemptId: string;
  ledger: LedgerWriter;
  wp: WorkerPaths;
  presentation: Presentation;
}): Promise<SendOutcome> {
  const { run, worker, envelope, attemptId, wp, presentation } = args;

  /*
   * STEP 1. The terminal, before the epoch.
   *
   * `processStartTime` is the caller's read and `terminalRefusal` is pure, so
   * the decision is testable without a process to kill. A staged task whose
   * terminal has gone is a task nobody can trigger, reported as accepted —
   * which is the `<none>` shape this repository keeps closing.
   */
  const attach = presentation.attach_process;
  const observed = attach === null ? null : await processStartTime(attach.pid).catch(() => null);
  const gone = terminalRefusal(attach, observed);
  if (gone !== null) {
    throw new CliError(terminalRefusalMessage(worker, gone), EXIT.BACKEND_UNAVAILABLE);
  }

  // STEP 2. The supervisor allocates; it does not send, and cannot.
  const staged = (await controlCall(run, worker, {
    cmd: "stage",
    envelope,
    attempt_id: attemptId,
    requested_epoch: null,
  })) as { accepted: boolean; epoch?: number; replayed?: boolean; reason?: string; error?: string };

  if (!staged.accepted) {
    throw new CliError(
      staged.error ??
        `worker ${worker} refused to stage ${envelope.task_id}: ${staged.reason ?? "unknown"}`,
      EXIT.USAGE,
    );
  }
  const epoch = staged.epoch ?? 0;

  /*
   * A REPLAY is a no-op, and stopping here is the point of ISC-440.
   *
   * The same task file staged twice must not rewrite the drop, re-record the
   * inbox entry or re-trigger a turn — it must return the original answer. The
   * allocator has already decided this; all this branch does is decline to
   * repeat the side effects it decided against.
   */
  if (staged.replayed === true) {
    return {
      accepted: true,
      epoch,
      replayed: true,
      reason: null,
      verdict: null,
      error: null,
      via: "staged",
    };
  }

  // STEP 4. The drop, carrying the epoch the supervisor just allocated — NOT
  // `envelope.epoch`, which is the caller's schema default of 0. The 2026-08-30
  // regression `supervisor/index.ts` records is exactly this line getting it
  // wrong on the other route.
  const prompt = renderPrompt({ ...envelope, epoch });
  await writeDispatchPolicy(
    wp.dispatchPolicy,
    {
      task_id: envelope.task_id,
      run_id: run.runId,
      worker,
      epoch,
      attempt: envelope.attempt,
      outbox: envelope.outbox,
      dispatched_at: envelope.dispatched_at,
    },
    prompt,
  );

  // STEP 5. The durable dispatch record, with the real epoch on BOTH sides of
  // `harvest/outbox.ts`'s correlation — which on the pane route agrees only by
  // both being 0.
  await writeJsonAtomic(inboxTaskPath(run, envelope.task_id), { ...envelope, epoch });

  // STEP 6.
  await args.ledger.append("dispatched", {
    worker,
    task_id: envelope.task_id,
    epoch,
    detail: {
      via: "staged",
      surface_backend: presentation.surface_backend,
      surface: presentation.surface_ref,
      drop: DISPATCH_POLICY_MOUNT,
    },
  });

  // STEP 7. The trigger, and nothing else, reaches the terminal — and on a
  // worker that triggers itself, not even that. See `sendStagedTrigger`.
  const trigger = await sendStagedTrigger(
    worker,
    presentation,
    await readWorkerLaunch(wp).catch(() => null),
  );
  if (trigger.delegated) {
    await args.ledger.append("stage_trigger_delegated", {
      worker,
      task_id: envelope.task_id,
      epoch,
      detail: {
        reason: "auto_trigger",
        detail:
          `${worker} was launched with the dispatch-trigger extension mounted, which fires on ` +
          `the drop within ${DISPATCH_TRIGGER_POLL_BUDGET_MS}ms. Typing the line as well would ` +
          `start the turn TWICE for one allocation.`,
      },
    });
  }
  if (!trigger.sent) {
    await args.ledger.append("stage_trigger_deferred", {
      worker,
      task_id: envelope.task_id,
      epoch,
      detail: { reason: trigger.reason },
    });
  }

  const record = nextAttendedRecord(
    await readAttended(wp.attendedJson),
    worker,
    new Date().toISOString(),
  );
  if (record !== null) await writeJsonAtomic(wp.attendedJson, record);

  return {
    accepted: true,
    epoch,
    replayed: false,
    reason: null,
    verdict: null,
    error: trigger.sent ? null : trigger.reason,
    via: "staged",
  };
}

/**
 * What became of the trigger, in the three shapes that are NOT the same fact.
 *
 * `sent: false` is the one the relay turns into a `stage_trigger_deferred`
 * rejection (`run/relay.ts`), and it means *nobody* is going to start this turn
 * — a human must type the line. `delegated: true` is the opposite claim wearing
 * a similar shape: pifleet typed nothing ON PURPOSE because the worker's own
 * dispatch-trigger extension is mounted and will fire within a second. Both
 * "pifleet did not type" — and conflating them would either stall a healthy
 * dispatch or report a wedged one as fine.
 */
type StagedTriggerOutcome =
  | { sent: true; delegated: boolean; reason: null }
  | { sent: false; delegated: false; reason: string };

/**
 * The window inside which a mounted dispatch-trigger extension fires, quoted in
 * the ledger so a reader can tell a delegated trigger from a lost one.
 *
 * `docker/pi-extensions/dispatch-trigger.ts` polls the drop every 500ms and
 * requires TWO IDENTICAL consecutive reads before firing — its guard against a
 * torn read of a file the host rewrites in place. So the worst case is a tick
 * that lands mid-write plus the two it then needs: three intervals. This is a
 * number for a human reading a ledger line, not a timeout anything enforces;
 * `wait`'s `PIFLEET_STAGE_TRIGGER_GRACE_MS` is the enforced one.
 */
const DISPATCH_TRIGGER_POLL_BUDGET_MS = 1_500;

/**
 * Type `STAGED_TRIGGER_LINE` at the surface the operator handed over.
 *
 * ## One line, and the whole reason it is only one line
 *
 * `paneKeystrokes` exists to turn a rendered prompt into a plan of N text sends
 * and N key presses, and it is the right machine for the backend-managed route.
 * It is the WRONG machine here, and deliberately not used: a plan that types a
 * brief into a surface that may have become a shell is what D2 refused, and the
 * staged design's entire claim is that the brief never goes near a terminal.
 * One send and one `enter`. `assertPaneTypeableLine` still gates the line, so
 * the trigger is held to the same standard as any other text this fleet types.
 *
 * ## `surface_backend`, never `backend`
 *
 * `presentation.backend` is the RUN's presentation backend, which for an
 * adopted terminal is `headless` — the fleet opens no windows of its own — and
 * loading a backend by that name would give something with no `sendText` at
 * all. `surface_backend` is the field that answers "who owns this surface", and
 * it exists precisely because those two questions had one field between them.
 *
 * ## IT DOES NOT TYPE AT A WORKER THAT TRIGGERS ITSELF, and that is the fix
 *
 * `docker/pi-extensions/dispatch-trigger.ts` opens with "The keystroke, removed
 * — a staged task starts its own turn". It was written to REPLACE this send,
 * and this send was never removed. Both survived because they could not both
 * land: `sendStagedTrigger` threw `CmuxParseError: could not parse composed pane
 * id` on every adopted surface, so the extension was in practice the only
 * trigger and the arrangement looked correct for two days. Widening the pane id
 * (`test/unit/staged-trigger.test.ts`) armed the second sender, and from
 * 2026-09-04T02:50Z every `tui` session in `~/.pifleet/runs` carries TWO
 * triggers per allocation.
 *
 * The second one is not discarded, which is what makes it expensive. The
 * extension sends `{ deliverAs: "followUp" }` — correct in isolation, since
 * `steer` would interrupt a running turn — so the message QUEUES behind the
 * turn this line just started and is delivered the moment that turn ends. The
 * drop still holds the same task, so the worker reads back a task it has
 * already filed. `rev-arch-1` said so itself in run `2026-09-04T22-10-12Z-b851`
 * (transcript entry 109): *"This is the same task I already completed. The
 * dispatch is identical (same task_id, epoch, worker, outbox)."* That session
 * reached 3,480,664 cumulative input tokens, 455,266 of them spent after the
 * re-delivery, on a `tui` session that keeps its context across dispatches.
 *
 * Nothing downstream could catch it. The relay's `already_done` ledger keys on
 * `(sender, taskId)` and correctly stages nothing on a repeat pass — there IS no
 * repeat dispatch. `EpochManager` is not consulted, because the epoch was
 * allocated once, at stage time, and both triggers point at it. `already_done`
 * and `already_completed` are answers to a second DISPATCH, and this is one
 * dispatch with two doorbells.
 *
 * So the sender that is kept is the extension, on three grounds beyond its
 * being first in the design: it never touches a terminal that may have become a
 * shell (§4.3's hazard is absent rather than mitigated), `supervisor/tui.ts`'s
 * `attributedToStage` recognises only `AUTO_TRIGGER_TEXT` — so with this line
 * suppressed a staged turn is attributed exactly instead of falling back to §9
 * Q1's "APPROXIMATE" growth heuristic, which is what every run tree logged —
 * and `wait` already knows how to sit out an armed stage and how to name one
 * that never fires (`staged_trigger_stalled`).
 *
 * ## The launch record, and why `delegated` is not `sent: false`
 *
 * `auto_trigger` is `up`'s recorded answer to "was the extension mounted"
 * (`contracts.ts`), written from the same predicate `config/render.ts` mounts
 * on, and `wait.ts` already reads it here for the same question. It defaults
 * FALSE for an absent or legacy record, so a `PIFLEET_PI_COMMAND` double run —
 * which has no launch record at all — keeps being typed at exactly as before.
 *
 * The suppressed case must NOT return `sent: false`. `run/relay.ts` reads a
 * non-null `error` out of `stageForAdoptedTerminal` as a
 * `stage_trigger_deferred` rejection and DROPS the lens rather than waiting out
 * its deadline for a keystroke — which is right for a trigger nobody will send,
 * and would be a discarded review here. Hence a third shape.
 *
 * ## Not sending is a REPORTED outcome, not a failure
 *
 * There is no cmux surface when the operator adopted a Terminal.app window, an
 * ssh session or a tmux pane, and that is the ordinary case for this mode
 * outside the operations console. The task is already staged and durable at
 * this point, so the honest answer is to hand the operator the line and say why
 * — never to throw away six writes because one convenience was unavailable.
 */
/**
 * Clear a pane worker's session AFTER its task has settled.
 *
 * ## The moment is the whole design, and it is not the one tried first
 *
 * The obvious placement is before the next dispatch — clear, then trigger. That
 * is unavailable and for a good reason: when `auto_trigger` is set the host
 * deliberately types NOTHING ({@link sendStagedTrigger}'s early return), because
 * the extension starting the turn *"never touches a terminal that may have become
 * a shell"* and because `supervisor/tui.ts`'s `attributedToStage` recognises only
 * `AUTO_TRIGGER_TEXT` — a line typed ahead of it would put an unattributable turn
 * in the transcript and drop every staged turn back to the approximate growth
 * heuristic. Clearing before the trigger fights all of that.
 *
 * Clearing AFTER settle fights none of it:
 *
 *  - it is not a trigger, so the delegation contract is untouched — the extension
 *    still starts every turn and the host still types nothing on that path;
 *  - it precedes no staged turn, so there is nothing for `attributedToStage` to
 *    mis-attribute;
 *  - `wait` has already returned, so it cannot be confused with a stage waiting
 *    on a keypress;
 *  - and the worker is IDLE, which is the one moment typing at its surface cannot
 *    interrupt a turn.
 *
 * The freshness is identical. A session cleared after task N is a session that
 * starts empty for task N+1; only the instant differs, and this instant is the
 * one with no contract on it.
 *
 * ## What it does NOT do
 *
 * It does not reach `rpc` workers, which have no surface — those are handled by
 * §6.6's recycle, which works for exactly the seats this does not. It is
 * best-effort by construction: a failure is REPORTED and never thrown, because
 * the task has already settled and its result is already durable. Throwing here
 * would turn a cosmetic failure into a lost outcome.
 */
export async function resetPaneSession(
  worker: string,
  presentation: Presentation,
  loadBackendFn: typeof loadBackend = loadBackend,
): Promise<{ readonly reset: boolean; readonly reason: string | null }> {
  const kind = presentation.surface_backend;
  const surface = presentation.surface_ref;
  if (kind === null || surface === null) {
    return { reset: false, reason: `no addressable surface for ${worker}` };
  }
  try {
    assertHostAuthoredPaneLine("session reset", SESSION_RESET_LINE);
    const backend = await loadBackendFn(kind);
    if (backend.sendText === undefined || backend.sendKey === undefined) {
      return { reset: false, reason: `backend ${kind} cannot type into a pane` };
    }
    const pane = { backend: kind, id: surface };
    await backend.sendText(pane, SESSION_RESET_LINE);
    await backend.sendKey(pane, SUBMIT_KEY);
    return { reset: true, reason: null };
  } catch (err) {
    return { reset: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendStagedTrigger(
  worker: string,
  presentation: Presentation,
  launch: WorkerLaunch | null,
  loadBackendFn: typeof loadBackend = loadBackend,
): Promise<StagedTriggerOutcome> {
  /*
   * Checked BEFORE the surface, because it is not a fallback for a send that
   * could not happen — it is a decision not to send. Reversing the order would
   * report a delegated trigger as "no addressable surface" on exactly the
   * Terminal.app / ssh seats where that sentence is already the confusing one.
   */
  if (launch?.auto_trigger === true) {
    return { sent: true, delegated: true, reason: null };
  }
  const kind = presentation.surface_backend;
  const surface = presentation.surface_ref;
  if (kind === null || surface === null) {
    return {
      sent: false,
      delegated: false,
      reason:
        `no addressable surface for ${worker} — the adopted terminal announced no pane id, ` +
        `which is what a Terminal.app window, an ssh session or a bare tmux pane does. The ` +
        `task is staged and durable; type this at that terminal to start it:\n` +
        `  ${STAGED_TRIGGER_LINE}`,
    };
  }
  try {
    assertHostAuthoredPaneLine("staged trigger", STAGED_TRIGGER_LINE);
    const backend = await loadBackendFn(kind);
    if (backend.sendText === undefined || backend.sendKey === undefined) {
      return {
        sent: false,
        delegated: false,
        reason: `backend ${kind} cannot type into a pane; type this at ${worker}'s terminal:\n  ${STAGED_TRIGGER_LINE}`,
      };
    }
    const pane = { backend: kind, id: surface };
    await backend.sendText(pane, STAGED_TRIGGER_LINE);
    await backend.sendKey(pane, SUBMIT_KEY);
    return { sent: true, delegated: false, reason: null };
  } catch (err) {
    return {
      sent: false,
      delegated: false,
      reason:
        `could not type the trigger at ${worker}'s surface (${String(err)}). The task is ` +
        `staged and durable; type this at that terminal to start it:\n  ${STAGED_TRIGGER_LINE}`,
    };
  }
}
