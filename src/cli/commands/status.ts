import type { Command } from "commander";
import { readdir, stat } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, type WorkerPhase, type WorkerState } from "../../contracts.ts";
import {
  latestRunId,
  runPaths,
  runsRoot,
  workerOutboxDir,
  workerPaths,
  type RunPaths,
} from "../../run/paths.ts";
import { readRunBudgetPolicy, readWorkerState } from "../../run/state.ts";
import {
  identityAlive,
  latestLiveRunId,
  liveRunIds,
  processStartTime,
  readRegistry,
} from "../../run/registry.ts";
import { dispatchRequestPath } from "../../run/dispatch-request.ts";
import { readJournalEntry } from "../../run/relay-journal.ts";
import { RELAY_SETTLE_DEADLINE_MS } from "../../run/relay.ts";

/**
 * How long ago, in the coarsest unit that still says something.
 *
 * Seconds under a minute, minutes under an hour, hours above it. An operator
 * glancing at a pane needs to tell `3s` from `40m`, and never needs to tell
 * `181s` from `184s`.
 *
 * WALL CLOCK, deliberately, and this is the one place in the tree that
 * subtracts two of them. `src/util/clock.ts` bans that for anything that
 * DECIDES — a deadline computed across a host suspend fires on the lid
 * opening. This decides nothing: the timestamp was written by a different
 * process, so there is no monotonic origin the two share, and the failure mode
 * of a clock step here is a status line that reads wrong until the next poll.
 * The alternative — printing the raw ISO stamp and making the reader subtract
 * — moves the same arithmetic into the reader's head and loses the glance.
 *
 * A stamp in the FUTURE clamps to `0s` rather than rendering a negative age:
 * a supervisor whose host clock is a few seconds ahead is a skew, and `-3s`
 * reads as a bug in pifleet.
 *
 * `null` for a stamp that will not parse — a truncated or hand-edited state
 * file. The caller says so in words; what must not happen is `NaNs ago`
 * reaching a pane, which reads as a crash rather than as a bad value.
 */
export function ago(iso: string, nowMs: number): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return coarseDuration(nowMs - then);
}

/**
 * `ago`'s unit rules, without the parsing — extracted so the wedge alarm below
 * can render a span it computed rather than a stamp it read.
 *
 * One implementation, deliberately. Two would drift, and the drift would be
 * invisible: `41m` from one and `41 minutes` from the other on the same status
 * line reads as two different measurements of two different things.
 */
function coarseDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1_000));
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3_600)}h`;
}

/**
 * What to say about a worker's transcript, or nothing at all.
 *
 * The three returns are three different facts and the point of the function is
 * that they never collapse into each other:
 *
 * - `null` — NOT MEASURED. An `rpc` worker, whose `phase` is already the
 *   honest answer, or a `tui` worker before its first poll. The caller prints
 *   nothing, because a worker that reports its state properly should not be
 *   annotated with a column about a mechanism it does not use.
 * - `no writes yet` — measured, and the file has not grown since this
 *   supervisor started watching it. Distinct from the above: something IS
 *   watching, and it has seen nothing.
 * - `3s ago` — measured, and moving.
 *
 * A fourth case exists and is a corruption rather than a state: a stamp that
 * will not parse. It is reported as unreadable rather than aged, because a
 * pane that prints an age is making a claim about when something happened.
 *
 * See `WorkerStateSchema.transcript_activity` for why this exists: for a pane
 * a person types into, `phase` is permanently `idle` and true, and this is the
 * only field that distinguishes a worker mid-turn from one sitting at a
 * prompt.
 */
export function transcriptNote(
  activity: WorkerState["transcript_activity"],
  nowMs: number,
): string | null {
  if (activity === null) return null;
  if (activity.last_growth_at === null) return "transcript no writes yet";
  const age = ago(activity.last_growth_at, nowMs);
  return age === null ? "transcript last write unreadable" : `transcript ${age} ago`;
}

// ---------------------------------------------------------------------------
// The wedged seat — busy, heartbeating, and nothing behind it
//
// A NOTE ON THE PROSE BELOW, in the style `reaper.ts` uses for the same reason:
// this file may now NAME the container runtime's CLI, and the docblocks below
// that say `run -d`, `ps -a` and `inspect` mean exactly those subcommands.
// That was not always safe, and the reason it is safe now is worth keeping.
// `monitor-density.test.ts` pins the claim that `status` never shells out by
// scanning this source for the name, and it used to scan RAW text: documenting
// why a container fact is absent here tripped a guard whose property was still
// true, so the file's working lesson became *avoid a word* rather than *avoid a
// call*, and the guard could equally have been satisfied by deleting the prose
// instead of the call. It now reads comment-stripped source
// (`test/support/source-structure.ts`), so it is satisfied only by code and
// broken only by code. Explain freely — the guard watches what its name says.
// ---------------------------------------------------------------------------

/**
 * The fleet's own opinion about how long silence is too long, in milliseconds.
 *
 * `stall.event_stall_warn` / `event_stall_kill` from `fleet.yaml`, carried into
 * `run.json` by `runBudgetRecord` and read back by `readRunBudgetPolicy`. It is
 * BORROWED and never defaulted here: a status line that invented a threshold
 * would be a second opinion about the same question, and the first thing an
 * operator does when the two disagree is stop believing both.
 */
export interface StallWindow {
  readonly warnMs: number;
  readonly killMs: number;
}

/** Every reason this rule can decline to answer. None of them is an alarm. */
export type SilenceUnknown =
  | "no_activity_record"
  | "no_growth_yet"
  | "no_window"
  | "unreadable_stamp";

/**
 * What `status` can say about a busy worker's silence.
 *
 * The five verdicts are five different facts and the point of the type is that
 * they never collapse into each other — the same discipline `transcriptNote`
 * keeps three facts apart with, and `ReapReport.container` keeps five:
 *
 * - `not_applicable` — nothing here claims to be running a task, or the
 *   supervisor is gone. There is no question to answer.
 * - `unknown` — there IS a question and this rule cannot answer it. `why` says
 *   which of the four ways, because "I have no threshold" and "this worker has
 *   never spoken" want different things done about them.
 * - `working` / `quiet` / `wedged` — answered, in the fleet's own bands.
 */
export type SilenceReading =
  | { readonly verdict: "not_applicable" }
  | { readonly verdict: "unknown"; readonly why: SilenceUnknown }
  | { readonly verdict: "working" | "quiet" | "wedged"; readonly silentMs: number };

export interface SilenceInput {
  /** `null` when `state.json` could not be read at all. */
  readonly phase: WorkerPhase | null;
  /** The `(pid, start-time)` identity check the snapshot already performs. */
  readonly supervisorAlive: boolean;
  readonly heartbeatAt: string | null;
  readonly activity: WorkerState["transcript_activity"];
  readonly window: StallWindow | null;
}

/**
 * Tell a worker that is BUSY AND WORKING from one that is BUSY AND WEDGED.
 *
 * ## The defect
 *
 * Aborting a task can leave a worker whose `state.json` says `phase: "busy"`,
 * whose `heartbeat_at` is rewritten every 250 ms, and whose container is gone
 * from the runtime entirely — absent even from a listing that includes stopped
 * ones. The seat reads as working. There is nothing in it, and until this
 * function existed no field on the status line said so; every one of them was
 * individually true.
 *
 * ## Why nothing upstream catches it
 *
 * `supervisor/index.ts:1109-1143` states the asymmetry that causes it. On the
 * `rpc` path `child` IS the worker, so a container that dies takes the child
 * with it and `onChildExit` writes `phase: "dead"`. On the `tui` path `child`
 * is a detached `run -d` CLIENT that returned a few hundred milliseconds after
 * launch, and the supervisor holds no handle on the container at all. That
 * docblock names an `inspect` on the recorded container name as the honest
 * probe, records that it is NOT built, and nominates the transcript going quiet
 * as the substitute.
 *
 * The substitute is measured and then DISCARDED, which is the hole this closes:
 * `settleFromTranscript` runs `classifyTuiTurn` first and returns early unless
 * the reading is `ended` (`supervisor/index.ts:2262-2265`), so `TUI_QUIET_MS`
 * is consulted only AFTER an end marker has been seen. A container killed
 * mid-turn writes no end marker, the quiet clock is never started, and `phase`
 * stays `busy` for as long as the supervisor lives.
 *
 * ## The discriminator, and why this subtraction is legal
 *
 * `heartbeat_at` and `transcript_activity.last_growth_at` are written by the
 * SAME process from the SAME wall clock. Their difference is how long that
 * supervisor has watched the transcript stand still, measured entirely inside
 * one clock. This is NOT the cross-clock subtraction `util/clock.ts` bans and
 * `reaper.ts` goes to such lengths to avoid — there is no second clock in it —
 * which is why the answer survives a host suspend, a reader whose clock is
 * skewed, and a `--json` consumer on another machine. It also means this
 * function takes no `now`, and a caller cannot accidentally give it one.
 *
 * ## The honest edge
 *
 * A worker genuinely thinking for a long time between tool calls has a stalled
 * transcript too. The bands are therefore the fleet's, not this file's: under
 * `warnMs` the operator's own config calls the silence healthy, between the two
 * it calls for a warning and explicitly not a kill, and at `killMs` it kills a
 * slot-holding worker outright. **This alarms exactly where the fleet would
 * already kill**, so it cannot be stricter than the opinion the operator wrote
 * down, and a reviewer thinking for ten minutes reaches `quiet` and stops.
 *
 * `phase === "busy"` is the analogue of `classifyStall`'s `holdsSlot`, on that
 * field's own reasoning: silence alone is never grounds for an alarm, because a
 * worker not claiming to run anything is silent by design.
 *
 * A DEAD supervisor is excluded rather than judged. Both stamps froze together
 * when it died, so their difference is whatever it happened to be at that
 * moment; the line already reads `supervisor=gone`, which is the actionable
 * fact, and that is the reaper's business (`safety/reaper.ts`) rather than
 * this one's.
 */
export function classifyWorkerSilence(input: SilenceInput): SilenceReading {
  if (input.phase !== "busy") return { verdict: "not_applicable" };
  if (!input.supervisorAlive) return { verdict: "not_applicable" };
  if (input.activity === null) return { verdict: "unknown", why: "no_activity_record" };
  /*
   * MEASURED-AND-NEVER-GREW makes no claim about being stuck, and nothing
   * derived from it may make one — `supervisor/index.ts:2007-2010` says so in
   * the branch that writes it. A worker nobody has typed at yet carries exactly
   * this value, and alarming about it would turn a fresh pane into a fault.
   */
  if (input.activity.last_growth_at === null) return { verdict: "unknown", why: "no_growth_yet" };
  if (input.window === null) return { verdict: "unknown", why: "no_window" };

  const beat = input.heartbeatAt === null ? Number.NaN : Date.parse(input.heartbeatAt);
  const grew = Date.parse(input.activity.last_growth_at);
  if (Number.isNaN(beat) || Number.isNaN(grew)) {
    return { verdict: "unknown", why: "unreadable_stamp" };
  }

  // Clamped, on `ago`'s reasoning: the transcript poll can land microseconds
  // after the heartbeat that shares its tick, and a negative span would read as
  // a worker that wrote in the future rather than as sub-tick ordering.
  const silentMs = Math.max(0, beat - grew);
  if (silentMs >= input.window.killMs) return { verdict: "wedged", silentMs };
  if (silentMs >= input.window.warnMs) return { verdict: "quiet", silentMs };
  return { verdict: "working", silentMs };
}

/**
 * What to put on the status line, or nothing at all.
 *
 * SPEAKS FOR TWO OF THE FIVE VERDICTS, and the silences are as deliberate as
 * the words:
 *
 * - `wedged` is the alarm, and it is the only thing on this line printed in
 *   capitals. It names the span so the reader can tell a seat that went five
 *   minutes past the threshold from one that has been dead an hour, and it
 *   names the likely cause because "check the container" is the action.
 * - `working` and `quiet` say nothing. The line already carries `transcript
 *   41m ago` from `transcriptNote`, so a second rendering of the same fact
 *   would be noise — and printing `quiet` on every worker more than three
 *   minutes into a model call is noise on most of a healthy fleet.
 * - `unknown/no_window` DOES speak, because it is the one unknown with no other
 *   trace on the line. Without it an operator cannot tell "no alarm because
 *   healthy" from "no alarm because I have no threshold to judge against",
 *   which is exactly the collapse the verdict type exists to prevent.
 * - the other three unknowns stay quiet: `transcriptNote` has already printed
 *   `transcript no writes yet`, `transcript last write unreadable`, or nothing
 *   at all for a worker with no record.
 */
export function silenceNote(reading: SilenceReading): string | null {
  if (reading.verdict === "wedged") {
    return (
      `WEDGED heartbeating but transcript silent ${coarseDuration(reading.silentMs)} ` +
      `(container may be gone)`
    );
  }
  if (reading.verdict === "unknown" && reading.why === "no_window") {
    return "silence-window unknown";
  }
  return null;
}

/**
 * The run's silence window, or `null` when it cannot be had.
 *
 * DEGRADES where `dispatch` REFUSES, and the asymmetry is deliberate.
 * `readRunBudgetPolicy` throws `RunPolicyUnreadableError` on a `run.json` that
 * is present and unparseable, because answering an unknown token ceiling with
 * "unbounded" spends money that cannot be refunded. Nothing here spends
 * anything: this is a read-only snapshot, and it is the operator's ONLY view of
 * a fleet precisely when things have gone wrong. Refusing to print it because
 * one field of one file would not parse would remove the view at the moment it
 * is most needed.
 *
 * The degradation is not silent. With no window every busy worker reads
 * `unknown/no_window`, `silenceNote` prints `silence-window unknown` beside it,
 * and `--json` carries a null `window_ms`.
 */
async function readSilenceWindow(run: RunPaths): Promise<StallWindow | null> {
  try {
    return (await readRunBudgetPolicy(run)).stall;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The unconsumed dispatch-request — a review that was asked for and never ran
//
// ## The defect, as measured
//
// A review console's collator ran its turn, wrote a well-formed
// `dispatch-request.json`, ended its turn and reported success. No relay actor
// was running for that console, so nothing read it and the review never
// happened. Every observable read healthy: the worker was `idle`, its result
// envelope was written, the outbox was populated.
//
//   ~/.pifleet/runs/2026-09-05T02-04-34Z-5f25/outbox/col-1/R-rally-async-6/
//     dispatch-request.json    3971 bytes, unconsumed for minutes
//
// Starting the relay made the fan-out fire instantly. This file could not say
// so: it named the relay zero times, and `readRelayStatus` is reachable only
// from `scripts/review` — so the documented way to ask what the fleet is doing
// was blind to a console with no actor.
//
// ## Why this reports the REQUEST and never the PROCESS
//
// `readRelayStatus` is strict — `isPinnedIdentity`, `unverifiable` — because it
// LICENSES signalling and replacing a process, and that strictness costs a `ps`
// through `processStartTime`. `status` licenses nothing and must spend nothing:
// it is the operator's only view precisely when things are broken. So it must
// not claim that certainty and must not become a second opinion about relay
// identity.
//
// Reporting the harm instead is also STRICTLY MORE GENERAL. A dead actor, an
// actor pointed at the wrong run, an actor that crashed mid-poll and an actor
// that is running and refuses all produce the same observable, and this column
// sees every one of them without knowing which. It is SELF-GATING for the same
// reason: only a collator writes a `dispatch-request.json`, so a fleet with no
// console prints exactly what it printed before this column existed.
// ---------------------------------------------------------------------------

/**
 * How long a request may sit unjournalled before it is an alarm.
 *
 * ## Against the value a reader reaches for first, which is the wrong one
 *
 * `DEFAULT_POLL_S = 2` (`cli/commands/relay.ts`) is the obvious borrow and it
 * bounds the wrong span. It says how long a request waits to be LOOKED AT. What
 * has to elapse before an alarm is honest is how long a request may legitimately
 * remain UNJOURNALLED — and the journal is written after the entire fan-out
 * (`relayPass`: `await opts.fanOut(...)`, then `recordDispatch`), which joins its
 * three children for up to `RELAY_SETTLE_DEADLINE_MS`. A threshold of a few poll
 * intervals would therefore raise this alarm on EVERY HEALTHY REVIEW, for the
 * whole time it ran. That is the false alarm the wedged-seat rule refuses to
 * produce, arriving through the threshold instead of through the bands.
 *
 * So the number borrowed is the one that actually bounds the window:
 * `RELAY_SETTLE_DEADLINE_MS`, the fleet's own longest legitimate wait for a
 * fan-out. Past it the join has given up ON ITS OWN CLOCK, so "a fan-out is
 * still running" can no longer explain the missing entry.
 *
 * **The `--poll` concern is answered as a corollary rather than with a margin.**
 * 1_800_000 ms is 900 default poll intervals, so an operator would have to poll
 * less than twice an hour before the interval alone could make this fire.
 * Inventing a multiplier on top would be exactly the second opinion a borrowed
 * threshold exists to avoid.
 *
 * **What this deliberately costs, said rather than buried.** The alarm is LATE:
 * the measured defect sat unconsumed for minutes and this says nothing for
 * thirty. Failing toward silence is the choice the wedged-seat rule already
 * made, and the escape hatch is the same one: `--json` carries `waiting_ms` and
 * `unconsumed_after_ms` on every request, so a dashboard with its own idea of
 * "too long" does its own arithmetic and does not have to reverse-engineer this
 * one. A residual remains at the far edge — a fan-out that times out AT the
 * deadline still has a harvest and a reply-publish to do before it journals, so
 * a request can be named while an actor is finishing with it. The message says
 * both causes rather than asserting one, which is what makes that overlap a
 * late-and-hedged line instead of a wrong accusation.
 */
export const UNCONSUMED_AFTER_MS = RELAY_SETTLE_DEADLINE_MS;

/**
 * What `status` can say about one `dispatch-request.json`.
 *
 * Four facts that never collapse into each other, on `SilenceReading`'s
 * discipline:
 *
 * - `consumed` — a journal entry exists and parses. Silent; the normal answer.
 * - `waiting` — no entry, and the request is young enough that an actor may
 *   simply not have reached it. Silent, and the false alarm avoided.
 * - `unconsumed` — no entry, past the window. **The defect.**
 * - `journal_unreadable` — an entry exists and cannot be trusted. Distinct from
 *   all three: `classifyRequest` fails CLOSED on it, so the relay refuses to
 *   dispatch and the review will never happen. Folding it into `consumed` would
 *   be a new lie introduced by this very column.
 */
export type DispatchReading =
  | { readonly taskId: string; readonly verdict: "consumed" }
  | { readonly taskId: string; readonly verdict: "waiting"; readonly waitingMs: number }
  | { readonly taskId: string; readonly verdict: "unconsumed"; readonly waitingMs: number }
  | { readonly taskId: string; readonly verdict: "journal_unreadable"; readonly reason: string };

export interface DispatchInput {
  readonly taskId: string;
  /**
   * `readJournalEntry`'s OWN three answers, carried rather than reduced to a
   * boolean. The reduction is where `journal_unreadable` would be lost, and it
   * is the one arm whose remedy differs.
   */
  readonly journal:
    | { readonly kind: "missing" }
    | { readonly kind: "ok" }
    | { readonly kind: "unreadable"; readonly reason: string };
  /** Since the request was last written, from the snapshot's single clock. */
  readonly waitingMs: number;
  /** The borrowed window. Passed in, never read from here — see `W2`'s reasoning. */
  readonly unconsumedAfterMs: number;
}

/**
 * Pure, and it takes no `now`: the age is computed once by the caller against
 * the snapshot's single clock reading, so two requests stamped in the same
 * second cannot render different spans because the loop took a moment to reach
 * the second one.
 *
 * There is deliberately NO gate on the worker's phase or on its supervisor's
 * liveness, and the asymmetry with `classifyWorkerSilence` is the point. That
 * rule reads two stamps a LIVE supervisor wrote, so a dead one makes its
 * subtraction meaningless. This one reads a file. The whole defect is that the
 * collator was `idle` with a written envelope — every worker-level observable
 * was healthy and true — so gating on any of them would gate the alarm out of
 * existence at exactly the moment it is needed.
 *
 * The cost of having no gate, stated: a torn-down console keeps its unconsumed
 * requests, so naming a dead run explicitly still reports them. `--all` and the
 * default resolve LIVE runs first, so that is reachable only by asking for it,
 * and a review that was asked for and never ran is a fact that stays true.
 */
export function classifyDispatchRequest(input: DispatchInput): DispatchReading {
  if (input.journal.kind === "unreadable") {
    return { taskId: input.taskId, verdict: "journal_unreadable", reason: input.journal.reason };
  }
  if (input.journal.kind === "ok") return { taskId: input.taskId, verdict: "consumed" };
  if (input.waitingMs >= input.unconsumedAfterMs) {
    return { taskId: input.taskId, verdict: "unconsumed", waitingMs: input.waitingMs };
  }
  return { taskId: input.taskId, verdict: "waiting", waitingMs: input.waitingMs };
}

/**
 * What to put on the status line, or nothing at all.
 *
 * SPEAKS FOR TWO OF THE FOUR VERDICTS, and the silences are as deliberate as the
 * words: `consumed` and `waiting` say nothing, so a healthy fleet's output is
 * byte-identical to what it was before this column existed.
 *
 * ## THE HONEST EDGE, which is why this message names two causes
 *
 * A REFUSED fan-out is deliberately never journalled. `relayPass` pushes
 * `fan_out_declined` and `continue`s, and `RelayFanOutResult` says why:
 * journalling it would mark a fan-out complete that never happened, and under D5
 * the collator has already settled and named three child ids, so nothing
 * downstream would notice. `readDispatchRequest`'s refusals (§6.4, D7, D11) are
 * the same shape one step earlier. Some refusals — `run_unresolved` — are
 * retried on the next tick; others are permanent.
 *
 * So a missing entry means EITHER nothing has read the request OR something read
 * it and declined, and **nothing durable in the run tree tells them apart**,
 * because not writing a record is precisely what a decline does. The reason is
 * printed by the relay and scrolls away; that is the persistence gap this column
 * closes, and it cannot close it by guessing which side of it happened.
 *
 * The message therefore states both and names the ONE command that settles it.
 * `relay --once` prints the refusal verbatim if there is one, and issues the
 * fan-out if there is not — which is the remedy as well as the diagnosis. If an
 * actor happened to be mid-fan-out, that command re-issues it, which is the
 * bounded duplicate `relay-journal.ts` already chose to accept over the silent
 * loss.
 *
 * `journal_unreadable` gets its own words because its remedy is different: one
 * file, named, removed by an operator. Reporting it as merely unconsumed would
 * send them to `relay --once`, which fails closed on it forever.
 */
export function dispatchNote(readings: readonly DispatchReading[], runId: string): string | null {
  const stuck = readings.filter(
    (r): r is Extract<DispatchReading, { verdict: "unconsumed" }> => r.verdict === "unconsumed",
  );
  const parts: string[] = [];
  if (stuck.length > 0) {
    // The OLDEST, and a count — not every id. The list is bounded by the host's
    // inbox rather than by anything a worker controls, but a status line that
    // printed twelve task ids would be a line the reader has to parse rather
    // than glance at, and the oldest is the one that has been failing longest.
    const oldest = stuck.reduce((a, b) => (b.waitingMs > a.waitingMs ? b : a));
    const many = stuck.length === 1 ? "" : `s x${stuck.length}, oldest`;
    parts.push(
      `UNCONSUMED dispatch-request${many} ${oldest.taskId} unjournalled ` +
        `${coarseDuration(oldest.waitingMs)} (nothing has read it, or something read it and ` +
        `DECLINED — a decline is never journalled; \`pifleet relay --once --run ${runId}\` ` +
        `says which)`,
    );
  }
  for (const r of readings) {
    if (r.verdict !== "journal_unreadable") continue;
    // The reader's OWN sentence, never a reconstruction of it: `readJournalEntry`
    // names the file and says what is wrong with it, and a paraphrase here would
    // be a second, staler account of the same fault.
    parts.push(`DISPATCH BLOCKED ${r.taskId} — ${r.reason}`);
  }
  return parts.length === 0 ? null : parts.join("; ");
}

/**
 * The task ids the HOST dispatched in this run — the id set every question below
 * is asked about.
 *
 * **Listing the outbox alone would be the wrong source, and `relay.ts` states
 * the reason:** `/outbox` is the directory the WORKER owns and can write to, so
 * its entries are attacker-chosen names. A column keyed on them lets a collator
 * manufacture a permanent alarm by making one directory — a task id the host
 * never dispatched is never read by the relay, so it can never be journalled,
 * so it would read `unconsumed` forever and no command an operator ran would
 * clear it.
 *
 * `<run>/inbox/<task-id>.json` is the same information from the side the host
 * wrote, and it is exactly the set `relayPass` iterates. An absent inbox is an
 * empty set rather than an error, and it is also the fast path: a run nobody has
 * dispatched into asks nothing further of the filesystem.
 */
async function hostDispatchedTaskIds(run: RunPaths): Promise<Set<string>> {
  try {
    const entries = await readdir(run.inboxDir);
    return new Set(
      entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -".json".length)),
    );
  } catch {
    return new Set();
  }
}

/**
 * One worker's requests, read from the two files the answer already lives in.
 *
 * Costs nothing on a fleet with no console: `dispatched` is empty and this
 * returns before it opens anything. On a console it is one `readdir` of the
 * worker's outbox, then a `stat` and one small `readFile` per request that
 * actually exists — bounded by the intersection with the host's inbox, which is
 * tiny.
 *
 * The request's OWN BYTES ARE NEVER PARSED. `dispatchRequestPath` resolves the
 * path once and `stat` answers both questions asked of it — is there a request,
 * and when was it last written. Reading it would mean re-running
 * `readDispatchRequest`'s policy on a worker-owned path, which is the
 * check-then-use split that module's header exists to close, and it would let
 * `status` disagree with the relay about who may dispatch whom.
 *
 * An id that cannot be spelled as a path segment is SKIPPED rather than
 * reported: `dispatchRequestPath` throws on it, `readDispatchRequest` would
 * refuse it, and there is no request here for anything to consume.
 */
async function readDispatchRequests(
  run: RunPaths,
  worker: string,
  dispatched: ReadonlySet<string>,
  nowMs: number,
): Promise<DispatchReading[]> {
  if (dispatched.size === 0) return [];
  let taskDirs: string[];
  try {
    taskDirs = await readdir(workerOutboxDir(run.root, worker));
  } catch {
    return [];
  }

  const out: DispatchReading[] = [];
  for (const taskId of taskDirs.sort()) {
    if (!dispatched.has(taskId)) continue;
    let file: string;
    try {
      file = dispatchRequestPath(run.root, worker, taskId);
    } catch {
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    const journal = await readJournalEntry(run.root, worker, taskId);
    out.push(
      classifyDispatchRequest({
        taskId,
        journal,
        // Clamped on `ago`'s reasoning: a stamp in the future is a skew — a
        // bind-mounted write from a VM whose clock runs ahead — and a negative
        // span reads as a bug in pifleet rather than as a clock.
        waitingMs: Math.max(0, nowMs - mtimeMs),
        unconsumedAfterMs: UNCONSUMED_AFTER_MS,
      }),
    );
  }
  return out;
}

/**
 * Register `pifleet status` (SRD §10): a fleet snapshot read entirely from
 * durable files — which is what makes re-attaching after a killed CLI work
 * (ISC-76): the supervisors never noticed the CLI die, and their state files
 * are the interface.
 */
export function register(program: Command): void {
  program
    .command("status")
    .description("Print a fleet snapshot")
    .option("--run <id>", "run id")
    .option("--all", "report on every run that still has a live worker")
    .option("--watch", "refresh until interrupted")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; all?: boolean; watch?: boolean; json?: boolean }) => {
      const root = runsRoot();

      /*
       * `--all` reports every LIVE run, not every run ever.
       *
       * The operations console stands up one run per attached pane, because
       * `--attach-here` hands over the terminal of the process that runs it and
       * one process has one terminal. A status pane that showed only the newest
       * would report half the console and look, to the operator, like the other
       * half had died.
       *
       * Resolved fresh inside `emit` rather than once, so `--watch --all`
       * notices a run appearing or ending instead of holding the set it saw at
       * start.
       */
      const resolveRunIds = async (): Promise<string[]> => {
        if (opts.run !== undefined) return [opts.run];
        if (opts.all === true) {
          const live = await liveRunIds(root);
          if (live.length > 0) return live;
        }
        const one = (await latestLiveRunId(root)) ?? (await latestRunId(root));
        return one === null ? [] : [one];
      };

      const emitOne = async (runId: string): Promise<Record<string, unknown>> => {
        const run = runPaths(runId, root);
        const registry = await readRegistry(run);
        let workerIds: string[];
        try {
          workerIds = (await readdir(run.workersDir)).filter((w) => !w.startsWith("."));
        } catch {
          workerIds = [];
        }

        /*
         * ONCE per run, hoisted out of the worker loop.
         *
         * The window is a property of the RUN, so re-reading `run.json` for
         * every worker would buy nothing and would let a fleet of 500 workers
         * open 500 file descriptors for 500 copies of the same two numbers —
         * the concern `monitor/read/worker.ts` already states for its own
         * sequential reads.
         */
        const window = await readSilenceWindow(run);

        /*
         * ONCE per run as well, and for the same reason: the host's inbox is a
         * property of the RUN, and re-listing it per worker would open the same
         * directory once for every seat to build the same set.
         */
        const dispatched = await hostDispatchedTaskIds(run);

        /*
         * HOISTED out of the text branch, so the `--json` payload and the
         * printed line date every request from the same instant. ONE reading for
         * every worker in the snapshot, so two panes whose transcripts last grew
         * — or whose requests were last written — in the same second cannot
         * print different ages because the loop took a moment to reach the
         * second one.
         */
        const nowMs = Date.now();

        const workers: Array<{
          state: WorkerState | null;
          id: string;
          alive: boolean;
          silence: SilenceReading;
          requests: DispatchReading[];
        }> = [];
        for (const id of workerIds.sort()) {
          const state = await readWorkerState(workerPaths(run, id));
          let alive = false;
          if (state !== null) {
            const registered = registry?.workers[id];
            // (pid, start-time) identity, never pid alone: a recycled pid must
            // not resurrect a dead supervisor in the snapshot.
            alive =
              registered !== undefined
                ? await identityAlive({ pid: registered.pid, started: registered.started })
                : (await processStartTime(state.pid)) !== null;
          }
          /*
           * Classified HERE and carried, not recomputed at each consumer. The
           * text line and `--json` must never be able to disagree about whether
           * a seat is wedged, and two call sites reading the same fields is how
           * they would come to.
           */
          const silence = classifyWorkerSilence({
            phase: state?.phase ?? null,
            supervisorAlive: alive,
            heartbeatAt: state?.heartbeat_at ?? null,
            activity: state?.transcript_activity ?? null,
            window,
          });
          /*
           * Read HERE and carried, on the same rule the silence verdict follows
           * one line up: the text line and `--json` must never be able to
           * disagree about whether a review is waiting, and two call sites
           * stat-ing the same files is how they would come to.
           */
          const requests = await readDispatchRequests(run, id, dispatched, nowMs);
          workers.push({ id, state, alive, silence, requests });
        }

        const snapshot = {
              run_id: runId,
              workers: workers.map((w) => ({
                id: w.id,
                alive: w.alive,
                phase: w.state?.phase ?? null,
                task_id: w.state?.task_id ?? null,
                // Carried into `--json` for the same reason
                // `transcript_activity` is, twelve lines down: the console
                // pane is one consumer, and a script asking "is anything
                // waiting on me" needs the same field the pane reads. Without
                // it a caller polling this JSON sees `phase: "idle"` and an
                // unfamiliar `task_id`, which is the console defect again in a
                // machine reader instead of a human one.
                staged_task_id: w.state?.staged_task_id ?? null,
                epoch: w.state?.epoch ?? null,
                completed_epochs: w.state?.completed_epochs ?? [],
                pid: w.state?.pid ?? null,
                pgid: w.state?.pgid ?? null,
                session_path: w.state?.session_path ?? null,
                session_present: w.state?.session_present ?? false,
                heartbeat_at: w.state?.heartbeat_at ?? null,
                // Carried into `--json` too, not only into the text line: the
                // console pane is one consumer, and a script asking "is the
                // fleet doing anything" needs the same field the pane reads.
                transcript_activity: w.state?.transcript_activity ?? null,
                /**
                 * The DERIVED verdict, beside the raw fields it was derived
                 * from rather than instead of them.
                 *
                 * Both are carried on purpose. A caller that disagrees with the
                 * bands — a dashboard with its own idea of "too long" — still
                 * has `heartbeat_at` and `transcript_activity` to do its own
                 * arithmetic on, and does not have to reverse-engineer this
                 * one. A caller that just wants to know whether to page someone
                 * reads `verdict` and stops.
                 *
                 * `why` and `silent_ms` are both present and both nullable
                 * rather than the field changing shape between verdicts: a JSON
                 * consumer that has to switch on a discriminator before it
                 * knows which keys exist is a consumer that will index the
                 * wrong one.
                 */
                silence: {
                  verdict: w.silence.verdict,
                  why: w.silence.verdict === "unknown" ? w.silence.why : null,
                  silent_ms:
                    w.silence.verdict === "working" ||
                    w.silence.verdict === "quiet" ||
                    w.silence.verdict === "wedged"
                      ? w.silence.silentMs
                      : null,
                  window_ms: window === null ? null : { warn: window.warnMs, kill: window.killMs },
                },
                /**
                 * The dispatch requests in this worker's outbox, ALL of them,
                 * beside the window they were judged against.
                 *
                 * Every request is carried and not only the alarming ones, on
                 * the rule `silence` already follows: a caller that disagrees
                 * with the band — a dashboard that wants to know at five minutes
                 * rather than at thirty — has `waiting_ms` and
                 * `unconsumed_after_ms` to do its own arithmetic on, and does
                 * not have to reverse-engineer this one. A caller that just
                 * wants to know whether a review is stranded reads `verdict`
                 * and stops.
                 *
                 * `waiting_ms` and `reason` are both present and both nullable
                 * rather than the object changing shape between verdicts: a JSON
                 * consumer that has to switch on a discriminator before it knows
                 * which keys exist is a consumer that will index the wrong one.
                 *
                 * An empty list for every worker that writes no requests, which
                 * is what makes the field free for a fleet with no console.
                 */
                dispatch_requests: {
                  unconsumed_after_ms: UNCONSUMED_AFTER_MS,
                  requests: w.requests.map((r) => ({
                    task_id: r.taskId,
                    verdict: r.verdict,
                    waiting_ms:
                      r.verdict === "waiting" || r.verdict === "unconsumed" ? r.waitingMs : null,
                    reason: r.verdict === "journal_unreadable" ? r.reason : null,
                  })),
                },
              })),
        };

        if (opts.json !== true) {
          process.stdout.write(`run ${runId}\n`);
          for (const w of workers) {
            const phase = w.state?.phase ?? "unknown";
            const task = w.state?.task_id === null || w.state === null ? "-" : w.state.task_id;
            const live = w.alive ? "up" : "gone";
            const note = transcriptNote(w.state?.transcript_activity ?? null, nowMs);
            const suffix = note === null ? "" : ` ${note}`;
            /**
             * The staged task, named on the line rather than left to `phase`.
             *
             * A staged worker prints `idle`, and that is correct — nothing has
             * started, because starting it takes a keypress at a terminal
             * (SRD-TUI-DISPATCH §6.5). But `idle` alone is the console defect
             * `transcript_activity` was added for, read from the other end: a
             * pane that said `idle` about a worker that was busy sent an
             * operator looking for a fleet that had stopped. A pane that says
             * `idle` about a worker holding a staged task sends them looking
             * for a worker that is free, and it is not — the epoch is live and
             * the next dispatch will be refused `busy` by an allocator whose
             * refusal names an epoch the status line never mentioned.
             *
             * So the id is printed with the WORD `staged`, not as a second
             * bare `task=`. Two task ids on one line, distinguished only by
             * position, is a line the reader has to know the format of; this
             * one says which of the two facts each id is.
             *
             * Omitted entirely when there is nothing staged, like
             * `transcriptNote`'s `null`: every non-`tui` worker in the fleet
             * would otherwise carry a permanently empty column about a
             * mechanism it does not use.
             */
            const stagedId = w.state?.staged_task_id ?? null;
            const staged = stagedId === null ? "" : ` staged=${stagedId}`;
            /**
             * LAST on the line, and loud.
             *
             * Last because everything before it is a FACT read off disk and
             * this is a JUDGEMENT made about them; a reader who distrusts the
             * judgement can still see every input to it on the same line.
             *
             * Loud because the whole defect was a line that looked fine. `busy
             * task=t-3 supervisor=up transcript 41m ago` is four true fields
             * describing a seat with nothing in it, and an operator scanning a
             * pane of ten workers reads the shape before the numbers.
             *
             * Empty when there is nothing to say, on `transcriptNote`'s rule:
             * a healthy fleet's status output must be byte-identical to what it
             * was before this column existed, or the column has cost every
             * reader something to gain the few who needed it.
             */
            const wedge = silenceNote(w.silence);
            const alarm = wedge === null ? "" : ` ${wedge}`;
            /**
             * AFTER the wedge, and last on the line.
             *
             * A wedged seat is a fact about the WORKER in front of the reader; a
             * stranded request is a fact about work that was handed off and
             * never picked up, and the two can be true at once. Ordering them
             * puts the seat's own condition first, where a reader scanning a
             * pane of ten workers is already looking.
             *
             * Empty when there is nothing to say, on `transcriptNote`'s rule: a
             * healthy fleet's output stays byte-identical to what it was before
             * this column existed, or the column has cost every reader something
             * to gain the few who needed it.
             */
            const stranded = dispatchNote(w.requests, runId);
            const waiting = stranded === null ? "" : ` ${stranded}`;
            process.stdout.write(
              `  ${w.id}: ${phase} task=${task}${staged} supervisor=${live}${suffix}${alarm}${waiting}\n`,
            );
          }
        }
        return snapshot;
      };

      const emit = async (): Promise<void> => {
        const runIds = await resolveRunIds();
        if (runIds.length === 0) throw new CliError("no runs found", EXIT.USAGE);
        const snapshots: Array<Record<string, unknown>> = [];
        for (const id of runIds) snapshots.push(await emitOne(id));
        if (opts.json === true) {
          // `--all` wraps, a single run does NOT. The unwrapped shape is what
          // every existing caller parses, and quietly changing it for them to
          // gain a flag they did not pass is how a JSON contract breaks.
          const payload = opts.all === true ? { runs: snapshots } : snapshots[0]!;
          process.stdout.write(`${JSON.stringify(payload)}\n`);
        }
      };

      if (opts.watch === true) {
        // Refresh until interrupted; SIGINT is the exit path.
        for (;;) {
          await emit();
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      await emit();
    });
}
