/**
 * The `tui` plane's answer to a seat that has stopped being able to STOP
 * (ISC-1126).
 *
 * ## The failure, and why every guard this fleet already owns is blind to it
 *
 * `stall-io.ts`'s `event_stall_kill` fires on the ABSENCE of events. A looping
 * seat is the PRESENCE of identical ones: it calls a tool, the tool succeeds,
 * it calls the same tool again, for as long as the deadline allows. Nothing is
 * quiet, nothing errors, the transcript grows the whole time, and the seat
 * looks maximally healthy while accomplishing nothing.
 *
 * `ProseTurnDetector` is the closest existing shape — consecutive turns that
 * fail some test, run-length counted, latched, per epoch — and it CANNOT be
 * extended to this, because it is fed from `RpcEvent`s and every triage seat
 * runs `pane_mode: tui`, which emits none. Building the sibling on the rpc
 * plane instead would repeat ISC-1104 exactly: a real measurement taken on a
 * plane the code does not use, which read as coverage for four phases. So this
 * one reads the TRANSCRIPT, which is the only stream a `tui` seat produces.
 *
 * ## The structural reason it must be checked where it is
 *
 * A looping seat's last assistant message is always mid-tool-call, so
 * `classifyTuiTurn` answers `in_flight` on every poll, for ever. The
 * supervisor's settle chain opens with `if (reading.phase !== "ended") return`.
 * **Everything below that line is unreachable for this failure.** A detector
 * wired after it would be complete, well-argued, unit-tested and dead — which
 * is why `test/integration/tui-transcript-activity.test.ts` drives a real
 * supervisor and waits for a real task record rather than calling this
 * function.
 *
 * ## What "identical" means, and the direction its error runs
 *
 * The tool NAME plus its `arguments` serialised with `JSON.stringify`. Not a
 * canonicalising comparison that sorts keys first: `arguments` is parsed from
 * the JSON string the model emitted, so one model emitting one call twice
 * produces the same key order twice, and the sort would be guarding a case that
 * cannot arise from the failure this detects. Where the serialised form and the
 * semantic one disagree, this reads two identical calls as DIFFERENT — it
 * under-counts, breaking the streak and declining to trip. Missing a loop is
 * the recoverable error (the deadline still ends the epoch, as it does today);
 * killing a working seat is not.
 *
 * ## CONSECUTIVE, not cumulative — and this is the whole discrimination
 *
 * Measured over every session transcript on this host, 2026-09-09:
 *
 * | max consecutive run | total calls | what it was                          |
 * |---------------------|-------------|--------------------------------------|
 * | 111                 | 141         | `T-sweep-15-slice1`, no artifact     |
 * | 108                 | 135         | `T-sweep-18-slice1`, no artifact     |
 * | 11                  | 62          | an `obs-t1` sweep that DID deliver   |
 * | 6, 6, 5, 4, 3       | 28..13      | ordinary sweeps                      |
 *
 * The two pathological runs are consecutive runs, not merely high totals: 111
 * of the 141 calls were the same `kubectl get pods … | grep alert-processor`,
 * back to back, each one SUCCEEDING. A cumulative count over the epoch would
 * also separate those two rows from the rest here, and would be the wrong rule
 * anyway — a seat that legitimately re-reads one file between twelve different
 * investigations has a high total and is working. The streak reaching the
 * threshold is a claim that the seat has stopped varying its behaviour AND HAS
 * NOT RESUMED, which is the thing being detected.
 *
 * A partial repeat therefore does not accumulate: `A A A B A A A` peaks at 3.
 * That is deliberate, and it is `ProseTurnDetector`'s rule for the same reason.
 */

import { isAssistantEntry, type TreeEntry } from "../harvest/transcript.ts";

/**
 * The settle reason ISC-1126 names, exported so the supervisor that writes it
 * and the tests that grade it cannot drift to two spellings — the same reason
 * `NO_TOOL_CALLS_REASON` is exported beside its detector.
 *
 * `transcript_` prefixed like every other reason this plane produces
 * (`transcript_quiesced`, `transcript_stop_error`,
 * `transcript_terminating_report`), because an operator triaging a `tui` settle
 * greps that prefix and a reason outside it would be invisible to them. The
 * prefix says where the evidence came from; the suffix says what it means.
 */
export const TOOL_LOOP_REASON = "transcript_tool_loop";

/**
 * Consecutive identical tool calls that trip the detector.
 *
 * **Read off the table in the header rather than chosen.** The highest streak
 * any DELIVERING sweep has produced on this fleet is 11; the smallest loop
 * measured is 108. Any value in 12..107 separates them, and 20 is picked to sit
 * with real headroom on both sides instead of hugging either edge — 9 above the
 * worst healthy run, 88 below the mildest pathological one.
 *
 * A constant and not a config field, deliberately. `prose_turns_before_fail` is
 * configurable because SRD §5.9 specifies it and because `0` is the documented
 * spelling of "off" that `llm.require_native_tool_calls: false` collapses to.
 * Neither applies here: there is no per-role reason to want a different bound,
 * and a knob nobody has a reason to turn is surface that has to be schema'd,
 * plumbed through `run.json`, documented and defended for ever. If a role is
 * ever found that legitimately repeats one call twenty times, THAT is the
 * evidence that earns the field.
 */
export const TOOL_LOOP_THRESHOLD = 20;

/** What a trip knows about itself, for the event record and the operator. */
export interface ToolLoopReading {
  /** The longest run of consecutive identical calls seen in this epoch. */
  readonly streak: number;
  /**
   * The repeated call, as `name` plus serialised arguments, truncated for the
   * event log. Null when nothing repeated at all.
   *
   * Recorded because the streak alone sends an operator back to the transcript
   * to find out WHAT looped, and the answer is the first thing they need: it is
   * what names the sub-goal the model could not close (ISC-1121's undeclared
   * workload, in both measured cases).
   */
  readonly call: string | null;
}

/** Every `toolCall` block in an assistant message, in emission order. */
function toolCalls(entry: TreeEntry): string[] {
  const content = (entry as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const calls: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; name?: unknown; arguments?: unknown };
    if (b.type !== "toolCall" || typeof b.name !== "string") continue;
    calls.push(`${b.name} ${JSON.stringify(b.arguments ?? null)}`);
  }
  return calls;
}

/**
 * The longest run of consecutive identical tool calls in the entries appended
 * SINCE this epoch was dispatched.
 *
 * Takes the same slice `classifyTuiTurn` takes, and for the same reason: a
 * `tui` session is long-lived, and folding over the whole file would count a
 * loop from a turn that predates the epoch — or, worse, join the tail of the
 * previous turn to the head of this one and manufacture a streak neither had.
 * The epoch is the unit this verdict is about, and the slice IS the epoch.
 *
 * Calls are flattened across assistant messages in emission order, so a model
 * that emits the same call three times in ONE batch and then again in the next
 * message has a streak of four. That is the right reading — the batching is the
 * model's formatting choice, and the seat repeated itself four times either way.
 */
export function readToolLoop(sinceDispatch: readonly TreeEntry[]): ToolLoopReading {
  let streak = 0;
  let best = 0;
  let bestCall: string | null = null;
  let prev: string | null = null;

  for (const entry of sinceDispatch) {
    if (!isAssistantEntry(entry)) continue;
    for (const call of toolCalls(entry)) {
      streak = call === prev ? streak + 1 : 1;
      prev = call;
      if (streak > best) {
        best = streak;
        bestCall = call;
      }
    }
  }

  // `best` is 1 when nothing repeated and 0 when nothing was called at all.
  // Reporting the single call as a "streak of 1" would be true and useless, so
  // the no-repeat case reports the number and no call.
  return { streak: best, call: best > 1 ? bestCall : null };
}

/**
 * Has this epoch looped?
 *
 * Separate from `readToolLoop` so the supervisor can log the streak on the poll
 * that trips WITHOUT the threshold comparison being spelled a second time at
 * the call site — two spellings of one bound is the shape that lets a detector
 * report one number and act on another.
 */
export function isToolLoop(reading: ToolLoopReading): boolean {
  return reading.streak >= TOOL_LOOP_THRESHOLD;
}
