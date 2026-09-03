/**
 * The activity ladder (D9, ISC-480, ISC-481): one worker's on-disk facts in,
 * one member of `Activity` out.
 *
 * ## Why this is a pure function over facts rather than a reader
 *
 * `model.ts`'s header makes ISC-491 a file layout rather than a discipline, and
 * this module is the other half of that bargain: it takes a `WorkerFacts`
 * literal and reads no file, no clock and no socket, so every fixture in
 * `test/unit/monitor-activity.test.ts` runs with no terminal, no container and
 * no fleet. `now` is a parameter for the same reason `Region.readAt` is a stored
 * value — a derivation that calls `Date.now()` itself cannot be asked what it
 * would have said a minute ago, and the "nine hours of silence" fixture is
 * exactly that question.
 *
 * The I/O this deliberately does not do belongs to the readers under
 * `src/monitor/read/`. Splitting it here is what lets the ladder be pinned by
 * fixtures while the readers are pinned by directories.
 *
 * ## The discriminator is MEASURED, and one field is not enough
 *
 * SRD §9 Q1(a) is settled by counting the operator's own runs root: 6 live
 * attended workers and 21 non-adopted ones separate cleanly on
 * `presentation.adopted_terminal`, an `attended.json` holding `mode: "tui"`,
 * and `state.json`'s `session_present`. **None of those three is in
 * `state.json`**, which is the whole reason `pifleet status` cannot make this
 * call and why reading the run tree directly (D6) pays for itself.
 *
 * **A worker exists on disk RIGHT NOW with `attended.json` present and
 * `mode: "tui"` but `adopted_terminal` ABSENT.** So a reader that checks only
 * `adopted_terminal` is already wrong on real data, and a reader that checks
 * only `attended.json` is wrong on the mirror case. `isAttended` therefore ORs
 * them, and the OR is the point rather than defensive breadth.
 *
 * ## What this module refuses to decide
 *
 * **Q1(b) is NOT settled: `no-transcript` means "has never spoken". It does NOT
 * mean "is stuck", and there is no state here that does.** Nothing on disk
 * distinguishes a worker that has never spoken from one that is wedged — every
 * row of §3.1's ladder detects an ABSENCE — so a sixth state named `wedged`
 * would be a claim the data cannot support, and an elapsed-time threshold that
 * promoted `no-transcript` into it would be that same claim wearing a number.
 * The four live workers this state describes had been silent for nine hours and
 * were fine. **This paragraph exists because the next person to read this file
 * will want to add that state**, and the argument against it is not obvious from
 * the enum.
 */

import type { PaneMode } from "../contracts.ts";
import type { Activity } from "./model.ts";

/**
 * The transcript counters as `state.json` carries them
 * (`contracts.ts:380-387`), restated structurally rather than imported as a zod
 * inference so that a fixture is an object literal and not a parse.
 *
 * `null` for the whole field is NOT MEASURED — an `rpc` worker, or a `tui`
 * worker before its first poll. `null` for `last_growth_at` alone is measured
 * and still: the poll has seen the file and never seen it grow. The two are
 * different facts and this module keeps them apart.
 */
export interface TranscriptCounters {
  readonly entries: number;
  readonly last_growth_at: string | null;
}

/**
 * Everything the ladder needs, and deliberately nothing else.
 *
 * Each field names the file it came from, because the value of reading the run
 * tree directly is entirely in WHICH file answered — three of these are
 * invisible to `pifleet status` and they are the three that carry Q1(a).
 */
export interface WorkerFacts {
  /**
   * `presentation.json`'s `adopted_terminal`. `null` when the file is absent or
   * predates the field — which is NOT the same as `false`, though both mean
   * "not adopted" here. The distinction is kept because the reader can honestly
   * report only what it saw, and collapsing it at the boundary would make this
   * module the place the information was lost.
   */
  readonly adoptedTerminal: boolean | null;
  /**
   * `attended.json`'s `mode`, or `null` when there is no such file.
   *
   * `"viewer"` is a real value on disk and not a synonym for absent: `steer`
   * writes a record with `mode: "viewer"` because a human reached into the run
   * without a pane ever being handed over, and `leaveTui` REWRITES the record to
   * `"viewer"` on hand-back (`mode.ts:471`), keeping the file rather than
   * deleting it. A discriminator that tested for the record's PRESENCE would
   * therefore call every steered worker attended forever.
   */
  readonly attendedMode: PaneMode | null;
  /** `state.json`'s `session_present`. */
  readonly sessionPresent: boolean;
  readonly transcriptActivity: TranscriptCounters | null;
  /** `state.json`'s `phase`, verbatim and NOT reinterpreted (`model.ts:128-134`). */
  readonly phase: string;
  /**
   * Whether `docker ps` listed this worker's container on the last slow tick.
   *
   * **`null` means the slow clock has never completed**, which is `Region`'s
   * `never` status arriving here as an absence of fact rather than as a
   * negative. Treating it as `false` would put `container-gone` — the most
   * actionable finding this monitor has — on every worker at startup.
   */
  readonly containerPresent: boolean | null;
}

/**
 * How recently the transcript must have grown for a worker to read `active`.
 *
 * **This is the one number in this file that is a POLICY rather than a
 * measurement, and it is exported so that tests state it instead of inheriting
 * it.** Two bounds constrain it and neither fixes it: it must be comfortably
 * above `TUI_POLL_MS` (500 ms, `supervisor/tui.ts:237`) or a worker writing
 * steadily would flicker between `active` and `quiet` on the sampling interval,
 * and it must be above the pause a model takes between tool calls or a working
 * agent reads `quiet` mid-turn. 30 s clears both. It is not derived from a
 * measurement of real turn gaps, and when someone makes that measurement this
 * constant is what it should replace.
 */
export const DEFAULT_GROWTH_WINDOW_MS = 30_000;

/**
 * Whether a person's terminal drives this worker's turns, rather than the
 * control socket.
 *
 * **Both fields, ORed, and the OR is load-bearing** — see the module header for
 * the worker on disk that defeats each field taken alone.
 *
 * `mode === "tui"` rather than "a record exists" is the same predicate
 * `leaveTui` guards itself with (`mode.ts:459`), and for the same reason: the
 * record describes what occurred, and a worker whose pane was handed back or
 * that was merely steered has a record whose mode says so.
 *
 * `left_at` is deliberately not consulted. It decides §6.2's ATTENDED column —
 * "a person is typing here now" versus "a person typed here" — and reusing it
 * here would conflate the run's history with the worker's present route.
 */
export function isAttended(facts: Pick<WorkerFacts, "adoptedTerminal" | "attendedMode">): boolean {
  return facts.adoptedTerminal === true || facts.attendedMode === "tui";
}

/**
 * Has this worker ever spoken?
 *
 * `session_present` is the stronger witness and is checked first: the session
 * file is created lazily on the FIRST ASSISTANT MESSAGE (`contracts.ts:338-341`),
 * so its existence proves speech even in the window before the poll has written
 * any counters. Deriving `no-transcript` from missing counters alone would state
 * the one thing the file's existence disproves, and that window is real —
 * `discoverSessionPath` records the path and the counters arrive on a later poll
 * (`supervisor/index.ts:1982-2020`).
 */
function hasEverSpoken(facts: WorkerFacts): boolean {
  return facts.sessionPresent || facts.transcriptActivity !== null;
}

/**
 * Did the transcript grow inside the window?
 *
 * Three non-growth cases collapse to `false` here, and each is a decision:
 * counters absent (nothing measured yet), `last_growth_at` null (measured and
 * never grew — `transcriptNote`'s "no writes yet"), and a stamp that will not
 * parse. **The unparseable case is the one worth naming**: `Date.parse` yields
 * `NaN`, every comparison against `NaN` is false, so an unguarded expression
 * reaches `quiet` by accident. The explicit `Number.isFinite` makes it reach
 * `quiet` by decision, which is what keeps a hand-edited state file from
 * silently reading as a healthy still worker.
 *
 * The comparison is signed on purpose. A supervisor whose host clock runs ahead
 * writes a stamp in the future, `now - t` goes negative, and negative is inside
 * any window — so a future stamp reads `active`. That agrees with `ago`
 * (`status.ts`), which clamps the same skew to `0s` rather than printing `-3s`:
 * a stamp from the future is "just now", and reporting a worker mid-turn as
 * `quiet` would be the worse of the two available wrongs.
 */
function grewWithin(counters: TranscriptCounters | null, now: number, windowMs: number): boolean {
  if (counters === null || counters.last_growth_at === null) return false;
  const grewAt = Date.parse(counters.last_growth_at);
  if (!Number.isFinite(grewAt)) return false;
  return now - grewAt <= windowMs;
}

/**
 * The ladder, in strict precedence order.
 *
 * The order is the design. Each rung answers a question the rungs below it have
 * no standing to answer, so the first match wins and the rest are not consulted.
 *
 * 1. **`container-gone` outranks everything**, including a transcript that was
 *    growing a second ago. It is a CONTRADICTION between two sources — the
 *    supervisor's `phase` says live, `docker ps` says absent — and a worker that
 *    wrote its transcript three seconds before its container vanished must not
 *    render `active`, which is a liveness claim about a process that is not
 *    running. `phase: "dead"` withdraws the contradiction: both sources then
 *    agree, there is nothing to report, and the phase column carries it.
 * 2. **`rpc`** — not a person's terminal, so the transcript ladder does not
 *    apply and `phase` is already the honest answer for this worker.
 * 3. **`no-transcript`** — attended and has never spoken. Finding A, and the
 *    state that four live workers on the operator's own fleet sat in for nine
 *    hours while rendering as silence indistinguishable from an `rpc` worker's.
 * 4. **`active` / `quiet`** — attended, has spoken, and the only remaining
 *    question is whether it spoke recently.
 */
export function deriveActivity(
  facts: WorkerFacts,
  now: number,
  growthWindowMs: number = DEFAULT_GROWTH_WINDOW_MS,
): Activity {
  if (facts.containerPresent === false && facts.phase !== "dead") return "container-gone";
  if (!isAttended(facts)) return "rpc";
  if (!hasEverSpoken(facts)) return "no-transcript";
  return grewWithin(facts.transcriptActivity, now, growthWindowMs) ? "active" : "quiet";
}
