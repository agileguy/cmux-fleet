/**
 * The third loop shape, and the only one that settles `success` (ISC-1144).
 *
 * ## Why a third guard, when this fleet already owns two loop detectors
 *
 * `ProseTurnDetector` counts turns that produced no tool call. `readToolLoop`
 * counts consecutive identical tool calls. Both were built for a seat that has
 * stopped being able to stop, and neither can see this one:
 *
 *  - `ProseTurnDetector` is fed `RpcEvent`s. Every console seat runs
 *    `pane_mode: tui`, which emits none. That is ISC-1104's wrong-plane gap and
 *    it is structural, not an oversight.
 *  - `readToolLoop` reads the transcript — the right plane — but counts
 *    `toolCall` blocks, and a seat in this state emits none for the whole
 *    episode. It also counts CONSECUTIVE runs, which is the sharper reason it
 *    is blind here. See the table below: the maximum consecutive run in every
 *    measured instance of this failure is **1**.
 *  - `eventSilenceMs`, the stall killer, fires on ABSENCE. This failure is
 *    absence at the transcript and presence at the model, which is the worst of
 *    both: nothing to count and nothing to time out on either, because
 *    `events.jsonl` keeps getting the supervisor's own poll records.
 *
 * ## What it actually is
 *
 * One assistant message, 160-280 KB of `thinking`, in which a single
 * self-addressed sentence appears hundreds of times, interleaved with varying
 * filler. Measured on 2026-09-09 across every session transcript on this host —
 * 2,724 assistant prose blocks:
 *
 * | repeats | max consecutive | block  | the repeated sentence                          |
 * |--------:|----------------:|-------:|------------------------------------------------|
 * |    1709 |               1 | 210 KB | `Wait, I will write the files now.`            |
 * |    1127 |               1 | 279 KB | `I'll search for it in the node_modules or …`  |
 * |     917 |               1 | 162 KB | `Actually, I'll do it.`                        |
 * |     838 |               1 | 269 KB | `Let me grep for "premise" in src.`            |
 * |     729 |               1 | 261 KB | `Let me do it now.`                            |
 * |  **48** |               — |  58 KB | `Actually, wait.` — the worst HEALTHY block    |
 * |      29 |               — |  38 KB | `Actually, wait.`                              |
 * |      21 |               — |  44 KB | ` ```typescript `                              |
 *
 * The gap between the worst healthy block and the mildest loop is a factor of
 * 15, with nothing in between — the same shape `readToolLoop` derived its bound
 * from (worst healthy 11, mildest loop 108).
 *
 * ## TOTAL occurrences, not the longest run — and this inverts `readToolLoop`
 *
 * `readToolLoop`'s whole discrimination is that a run is consecutive: a seat
 * that re-reads one file between twelve different investigations has a high
 * total and is working. That argument is correct for tool calls and WRONG for
 * prose, because a degenerate model does not repeat itself back to back. It
 * writes the sentence, writes something else, and comes back to it — 1709 times
 * out of 4111 units, never twice in a row. The `max consecutive` column is the
 * measurement, and it says 1 on all five: the consecutive rule does not merely
 * under-count this failure, it scores the floor on every instance of it.
 *
 * Two rules that disagree about the same word is a hazard, so it is written
 * down here rather than left to be rediscovered: **`streak` in `tool-loop.ts`
 * is a run length; `repeats` here is a population count.** They are different
 * numbers answering different questions and neither threshold transfers.
 *
 * ## Why not a RATIO of repeats to units, which is the obvious refinement
 *
 * Because it is measurably worse. Ranked by ratio, the same 2,724 blocks give:
 *
 * | ratio | repeats | units | what it was                     |
 * |------:|--------:|------:|----------------------------------|
 * | 0.416 |    1709 |  4111 | a loop                           |
 * | 0.307 |     917 |  2990 | a loop                           |
 * | 0.250 |       2 |     8 | **healthy** — a short note       |
 * | 0.249 |    1127 |  4518 | a loop                           |
 * | 0.231 |       3 |    13 | **healthy** — a rollout summary  |
 * | 0.116 |     729 |  6298 | a loop — the MILDEST             |
 *
 * A ratio bound low enough to catch the 0.116 loop fires on an eight-unit block
 * that says one thing twice, and the healthy blocks are interleaved with the
 * pathological ones rather than sitting below them. The absolute count has no
 * such overlap. A short block cannot reach a large count at all, which is the
 * property the ratio was supposed to add and the count already has.
 *
 * ## Per BLOCK, not across the epoch slice
 *
 * The failure lives inside one message, and folding the whole slice together
 * would add a second way to reach the bound that has nothing to do with it: a
 * seat writing a per-service line in twelve consecutive reports has repeated
 * one sentence twelve times legitimately, and a long sweep could stack those
 * into the hundreds. Counting within a block keeps the number a statement about
 * a single act of generation, which is what the diagnosis claims.
 *
 * ## Where it must be checked — a PRECEDENCE requirement, not a reachability one
 *
 * This is where the two loop guards stop being alike, and the difference was
 * established by moving the check and re-running the integration probe rather
 * than by argument:
 *
 * | placement                                    | probe |
 * |----------------------------------------------|-------|
 * | above `if (reading.phase !== "ended")`        | green |
 * | below that gate                              | green |
 * | immediately above the verdict chain          | green |
 * | below `await settle(verdict, reason)`        | RED   |
 *
 * ISC-1126's check is where it is because a tool-looping seat is mid-tool-call
 * for ever and NEVER REACHES the gate — a reachability problem, and one block
 * lower the code is dead. A prose-looping seat has the opposite property: the
 * message it finally commits carries no `toolCall`, so `classifyTuiTurn` reads
 * `ended` and the check below the gate runs perfectly well. What it must not be
 * below is `settle`, because the verdict chain immediately above it reads that
 * same `endTurn` and settles **`success`** — on a turn whose entire output was
 * one sentence written 1,709 times. That is the damage this exists to stop, and
 * it is worse than the tool loop's, which at least failed honestly at its
 * deadline.
 *
 * It is nevertheless placed beside `readToolLoop` and above the gate, because
 * that is where the other loop check lives and one of the two having a
 * different home is how a later reader concludes the difference is meaningful.
 * `test/unit/prose-loop.test.ts` pins the source order against the boundary the
 * table above measured — `await settle(verdict, reason)` — and not against the
 * gate, so the tripwire fails only when the placement actually breaks.
 */

import { isAssistantEntry, type TreeEntry } from "../harvest/transcript.ts";

/**
 * The settle reason ISC-1144 names, exported so the supervisor that writes it
 * and the tests that grade it cannot drift to two spellings — the same reason
 * `TOOL_LOOP_REASON` is exported beside its detector.
 *
 * `transcript_` prefixed for the same reason as its sibling: an operator
 * triaging a `tui` settle greps that prefix, and a reason outside it would be
 * invisible to them.
 */
export const PROSE_LOOP_REASON = "transcript_prose_loop";

/**
 * Occurrences of one unit within one block that call it a loop.
 *
 * **Derived, not chosen.** Twice the worst healthy block ever measured on this
 * host (48), which leaves 7.6x of headroom below the mildest measured loop
 * (729). Both edges are assertable and both are asserted, so moving this number
 * in either direction turns the suite red rather than quietly widening or
 * narrowing what the console will tolerate.
 *
 * Not configurable, on `TOOL_LOOP_THRESHOLD`'s argument: there is no per-role
 * reason to want a different bound, and a knob nobody has a reason to turn is
 * surface that has to be schema'd, plumbed, documented and defended for ever.
 * If a role is ever found that legitimately writes one sentence ninety-six
 * times in a single message, THAT is the evidence that earns the field.
 */
export const PROSE_LOOP_THRESHOLD = 96;

/**
 * The shortest string that may count as a unit.
 *
 * Short fragments are what an honest writer repeats: ` ```typescript `, `}`,
 * `- [ ]`, `Wait.`. The measured healthy ceiling is set by exactly such a
 * string (` ```typescript `, 21 occurrences, 13 characters — just over this
 * bound and still far under the threshold), and dropping the bound to zero
 * would put table pipes and closing braces into the population where they would
 * dominate every count and mean nothing.
 *
 * Twelve rather than something larger because the shortest MEASURED loop
 * sentence is `Let me do it now.` at 17 characters, and a bound set close under
 * it would be a bound tuned to five samples. The floor exists to exclude
 * punctuation and syntax, not to exclude short sentences.
 */
export const PROSE_UNIT_MIN_CHARS = 12;

/** What a trip knows about itself, for the event record and the operator. */
export interface ProseLoopReading {
  /**
   * Occurrences of the most-repeated unit in the worst single block of this
   * epoch. A population count, NOT a run length — see the header.
   */
  readonly repeats: number;
  /**
   * The repeated sentence, truncated for the event log. Null when nothing
   * repeated at all.
   *
   * Recorded for the reason `ToolLoopReading.call` is: the count alone sends an
   * operator back to a 200 KB transcript to find out what happened, and the
   * sentence IS the diagnosis. `Wait, I will write the files now.` names a
   * model that has lost the ability to act on its own intention, which is a
   * different repair from `Let me grep for "premise" in src.`, a model stuck on
   * one unreachable sub-goal.
   */
  readonly line: string | null;
}

/** How much of the repeated sentence reaches the event record. */
const LINE_MAX_CHARS = 120;

/**
 * Split prose into the units that get counted.
 *
 * Sentence terminators AND newlines, because the failure appears in both
 * shapes: a model looping in flowing prose repeats a sentence, and one looping
 * in a plan repeats a bullet. Splitting on only one of the two would see the
 * other as a single enormous unit that trivially never repeats.
 *
 * No lowercasing and no punctuation stripping. A canonicalising comparison
 * would be guarding a case that cannot arise from this failure — a degenerate
 * model emits the SAME token sequence, not a paraphrase — and where the literal
 * form and the semantic one disagree this reads two units as DIFFERENT, which
 * under-counts and declines to trip. Missing a loop is the recoverable error;
 * failing a working seat is not.
 */
function units(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?])\s+|\n+/)) {
    const unit = part.trim();
    if (unit.length >= PROSE_UNIT_MIN_CHARS) out.push(unit);
  }
  return out;
}

/** Every `text` and `thinking` block in an assistant message, in emission order. */
function proseBlocks(entry: TreeEntry): string[] {
  const content = (entry as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
    /*
     * `thinking` as well as `text`, and it is the one that matters: all five
     * measured loops are `thinking` blocks. A detector that read only the
     * user-visible half would have found nothing at all, five times over.
     */
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") out.push(b.thinking);
  }
  return out;
}

/**
 * The most-repeated prose unit in any single assistant block appended SINCE this
 * epoch was dispatched.
 *
 * Takes the same slice `classifyTuiTurn` and `readToolLoop` take, and for the
 * same reason: a `tui` session is long-lived, and folding over the whole file
 * would count a block from a turn that predates the epoch. The epoch is the
 * unit this verdict is about, and the slice IS the epoch.
 */
export function readProseLoop(sinceDispatch: readonly TreeEntry[]): ProseLoopReading {
  let best = 0;
  let bestLine: string | null = null;

  for (const entry of sinceDispatch) {
    if (!isAssistantEntry(entry)) continue;
    for (const text of proseBlocks(entry)) {
      const counts = new Map<string, number>();
      for (const unit of units(text)) {
        const n = (counts.get(unit) ?? 0) + 1;
        counts.set(unit, n);
        if (n > best) {
          best = n;
          bestLine = unit;
        }
      }
    }
  }

  // `best` is 1 when nothing repeated and 0 when there was no prose at all.
  // Reporting the single sentence as a "repeat count of 1" would be true and
  // useless, so the no-repeat case reports the number and no line.
  return {
    repeats: best,
    line: best > 1 && bestLine !== null ? bestLine.slice(0, LINE_MAX_CHARS) : null,
  };
}

/**
 * Has this epoch looped in prose?
 *
 * Separate from `readProseLoop` so the supervisor can log the count on the poll
 * that trips WITHOUT the threshold comparison being spelled a second time at the
 * call site — two spellings of one bound is the shape that lets a detector
 * report one number and act on another.
 */
export function isProseLoop(reading: ProseLoopReading): boolean {
  return reading.repeats >= PROSE_LOOP_THRESHOLD;
}
