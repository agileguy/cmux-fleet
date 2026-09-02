/**
 * The `pane_mode: tui` launch and completion plane (SRD §3.5, Phase 2).
 *
 * Everything in this file exists because of one sentence in SRD §162: *a TTY
 * has one owner*. In `rpc` mode the supervisor owns the container's stdio — it
 * writes JSONL requests into stdin and parses events out of stdout, which is
 * the whole control plane. In `tui` mode a PERSON owns that terminal, through
 * `docker attach`, and the supervisor owns none of the three streams. Three
 * consequences follow, and this module holds the pure part of each:
 *
 *   1. the container must be created DETACHED, or the launch does not happen
 *      at all (`detachedDockerArgv`);
 *   2. the session transcript's path cannot be asked for, so it has to be
 *      found (`discoverSessionPath`);
 *   3. the end of a turn cannot be awaited on the RPC stream, so it has to be
 *      read out of that transcript (`classifyTuiTurn`).
 *
 * The functions are pure — or, for the one that must touch the filesystem,
 * take the directory as an argument and return a value rather than mutating
 * supervisor state — so each is a probe target on its own. `supervisor/
 * index.ts` holds the wiring and nothing else.
 *
 * **WHAT THIS MODULE DOES NOT CLAIM.** None of it makes a `tui` worker
 * equivalent to an `rpc` one. SRD §3.5 lists five guarantees the mode gives
 * up, and `classifyTuiTurn` in particular is a COARSER signal than the
 * double-correlated `get_state` probe `CompletionTracker` runs — deliberately,
 * because the coarser signal is the only one available without a control
 * channel. Where a claim is weaker than the `rpc` path's, it is said so at the
 * point it is made rather than left to be inferred.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Verdict } from "../contracts.ts";
import { isAssistantEntry, type TreeEntry } from "../harvest/transcript.ts";
import { AUTO_TRIGGER_TEXT } from "../util/pane-text.ts";

// ---------------------------------------------------------------------------
// 1. The launch shape
// ---------------------------------------------------------------------------

/**
 * Turn a rendered `docker run` argv into the DETACHED form a `tui` worker
 * needs, by inserting `-d` immediately after the `run` subcommand.
 *
 * ## Why the supervisor does this and not `render.ts`
 *
 * `render.ts` emits the command a HUMAN could paste — that is what `pifleet
 * render -w <id>` is for, and in a human's terminal `docker run -i -t` in the
 * foreground is exactly right, because a human's stdin IS a terminal. `-d` is
 * required by the SUPERVISOR's stdio contract, not by the worker's: this
 * process spawns with `stdin: "pipe"`, and measured against docker 28.4.0 on
 * 2026-08-31,
 *
 *   docker run --rm -i -t <image> true </dev/null
 *     -> "the input device is not a TTY", exit 1
 *   docker run -d --rm -i -t <image> <cmd>
 *     -> starts; .Config.Tty=true, .Config.OpenStdin=true, .State.Running=true
 *
 * So `-d` belongs to the caller's situation, and it is applied where the
 * caller is. Keeping it out of `render.ts` also keeps Phase 1's byte-for-byte
 * argv pins meaningful: `render.test.ts` asserts the rendered array with
 * `toEqual`, and an `rpc` worker's argv must not move by one byte.
 *
 * ## Why insertion and not append
 *
 * `docker run` takes its own flags BEFORE the image name and passes everything
 * after it to the container. An appended `-d` would be an argument to the
 * worker's command line, not a flag to docker — which does not error, it
 * quietly runs the container in the foreground with a stray `-d` handed to
 * `pi`. That is the class of failure this repo keeps closing, so the position
 * is chosen rather than convenient.
 *
 * ## Why a mangled argv is a throw and not a best effort
 *
 * The shape is asserted (`argv[0] === "docker"`, `argv[1] === "run"`) because
 * every other outcome is worse. Searching for a `"run"` token anywhere would
 * match an image called `run` or a command `run`; silently returning the argv
 * unchanged would launch the container in the foreground and produce the
 * one-line `the input device is not a TTY` error that does not mention
 * `pane_mode`. A throw names the argv it refused, and the supervisor's caller
 * turns it into a dead worker with a reason on it.
 *
 * **DOES NOT CLAIM** that the resulting argv is a container the supervisor can
 * talk to. It cannot: `docker run -d` returns as soon as the container starts,
 * so the spawned process's stdout carries a container ID and then closes. That
 * is the whole point — see `classifyTuiTurn` for what replaces the stream.
 */
export function detachedDockerArgv(argv: readonly string[]): string[] {
  if (argv[0] !== "docker" || argv[1] !== "run") {
    throw new Error(
      `tui launch expects a "docker run …" argv; got ${JSON.stringify(argv.slice(0, 2))}`,
    );
  }
  if (argv.includes("-d") || argv.includes("--detach")) {
    // Not an error to be defensive about — an error because it means two
    // places decided the launch shape, and the next reader would have to work
    // out which one won. There is exactly one detacher and this is it.
    throw new Error("tui launch argv already carries -d; the supervisor is the only detacher");
  }
  return [argv[0], argv[1], "-d", ...argv.slice(2)];
}

// ---------------------------------------------------------------------------
// 2. Finding the transcript
// ---------------------------------------------------------------------------

/**
 * The suffix a Pi session file carries for a given `--session-id`.
 *
 * SRD §4.2: with `--session-dir D --session-id S` the file is
 * `D/<ISO-timestamp>_S.jsonl`, FLAT — no cwd-mangled subdirectory. The
 * timestamp is generated at creation and is not knowable in advance, which is
 * why the suffix is all that can be matched on.
 */
export function sessionFileSuffix(sessionId: string): string {
  return `_${sessionId}.jsonl`;
}

/** What `discoverSessionPath` found, and how confident it is entitled to be. */
export interface SessionDiscovery {
  /** The absolute path, or null when no file matches yet. */
  path: string | null;
  /**
   * How many files in the directory matched the suffix. `> 1` means the
   * answer is the newest of several and the caller should say so in its log —
   * see the ambiguity note on `discoverSessionPath`.
   */
  matches: number;
}

/**
 * Find a `tui` worker's session transcript by SUFFIX MATCH in the session dir.
 *
 * ## This deliberately breaks ISC-95's rule, and here is the whole argument
 *
 * ISC-95 and `harvest/transcript.ts`'s `classifySession` both state the rule
 * plainly: the session path is recorded VERBATIM from `get_state`, never
 * computed and never globbed, because "a glob that finds a file finds SOME
 * file, not necessarily this worker's". That rule is not being relaxed for the
 * `rpc` path, which still does exactly what it did.
 *
 * It cannot be kept for a `tui` worker, because the mechanism it depends on is
 * one of the things SRD §3.5 VOIDS. `get_state` is an RPC method; a `tui`
 * worker has no RPC channel to send it on. The choice is therefore not
 * "verbatim or glob", it is "glob or no transcript at all" — and no transcript
 * means the harvest that §3.5 promises is *identical* in both modes silently
 * produces nothing for half of them.
 *
 * So the risk the rule exists to prevent is bounded instead of ignored:
 *
 *   - The search is a SUFFIX match on `_<sessionId>.jsonl`, not a prefix or a
 *     wildcard. `sessionId` is the worker id, which is unique within a run,
 *     and `sessionsDir` is that run's own directory — so a file matching
 *     another worker's transcript does not match this one.
 *   - The directory is read NON-recursively, matching §4.2's "flat".
 *   - When more than one file matches — a worker relaunched into the same run
 *     directory, which is the case that actually produces two — the NEWEST by
 *     mtime wins and the count is returned so the caller can record the
 *     ambiguity rather than hide it.
 *
 * **WHAT THIS DOES NOT CLAIM.** It is not as strong as the recorded path. A
 * verbatim `sessionFile` is Pi's own statement about the file it is writing;
 * this is an inference from a filename, and if Pi ever changes the naming
 * convention in §4.2 this returns null where the `rpc` path would keep
 * working. `state.session_present` remains the honest signal for "a transcript
 * exists" and is set from `existsSync` on whatever this returned, exactly as
 * it is on the recorded path.
 *
 * Returns `{ path: null, matches: 0 }` for a missing or unreadable directory
 * as well as for an empty one. The three are not distinguished because the
 * caller's action is the same in all three — poll again — and because the file
 * is created LAZILY on the first assistant message (§4.2), so "not there yet"
 * is the expected answer for the first seconds of every worker's life.
 */
export async function discoverSessionPath(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionDiscovery> {
  const suffix = sessionFileSuffix(sessionId);
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return { path: null, matches: 0 };
  }
  const candidates = names.filter((n) => n.endsWith(suffix) && n.length > suffix.length);
  if (candidates.length === 0) return { path: null, matches: 0 };

  let best: string | null = null;
  let bestMtime = -Infinity;
  for (const name of candidates) {
    const full = join(sessionsDir, name);
    let mtime: number;
    try {
      mtime = (await stat(full)).mtimeMs;
    } catch {
      // Vanished between readdir and stat. Not a failure of the search — the
      // remaining candidates are still valid answers.
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = full;
    }
  }
  // `best` can still be null if every candidate vanished; `matches` reports
  // what was seen, not what survived, because the count is a diagnostic about
  // the directory and not about this call's success.
  return { path: best, matches: candidates.length };
}

// ---------------------------------------------------------------------------
// 3. Deciding a turn has ended
// ---------------------------------------------------------------------------

/**
 * How long the transcript must be QUIET, after an assistant message that ended
 * the turn, before the supervisor settles a `tui` epoch.
 *
 * The stop reason alone is nearly enough — a `toolUse` stop says more is
 * coming and anything else says the turn is over — but "nearly" is the reason
 * this constant exists. Pi appends the assistant entry and its follow-on
 * entries in separate writes, and a poll that lands between two of them sees a
 * finished-looking turn that is not finished. The quiet window is the same
 * shape of defence as `CompletionTracker`'s DOUBLE correlated `get_state`: ask
 * twice, separated in time, and believe the answer only if it did not move.
 *
 * Two seconds rather than the `rpc` path's ~50 ms reprobe because there is no
 * generation token here to correlate against, so the only thing separating a
 * real quiesce from a gap between writes IS the elapsed time. It is charged
 * once per task, at the end.
 */
export const TUI_QUIET_MS = 2_000;

/** How often a `tui` supervisor polls the transcript for new entries. */
export const TUI_POLL_MS = 500;

/**
 * Stop reasons that mean the turn is NOT over.
 *
 * `toolUse` is the only one: Pi ends an assistant message with it when a tool
 * call is outstanding, and the tool result and the next assistant message
 * follow. Every other value — `endTurn`, `aborted`, `error`, `length`, absent
 * — is a turn that stopped, whether or not it stopped WELL. What it stopped as
 * is `verdictForStopReason`'s question, not this one.
 */
const CONTINUING_STOP_REASONS = new Set(["toolUse"]);

/** The state of a `tui` epoch as read off its transcript. */
export type TuiTurnPhase =
  /** No assistant message has been appended since dispatch. */
  | "awaiting_start"
  /** An assistant message exists and the last one is mid-tool-call. */
  | "in_flight"
  /** The last assistant message ended the turn; the quiet window applies. */
  | "ended";

export interface TuiTurnReading {
  phase: TuiTurnPhase;
  /** The last assistant message's `stopReason`, or null when absent/none. */
  stopReason: string | null;
}

/**
 * Read a `tui` epoch's phase off the transcript entries appended SINCE it was
 * dispatched.
 *
 * The caller passes only the new entries — the supervisor snapshots the
 * transcript's length at dispatch and slices from there — and that slicing is
 * load-bearing rather than an optimisation. A `tui` session is long-lived and
 * a person may have driven several turns through the pane before a `dispatch`
 * ever arrived. Folding over the whole file would find a completed assistant
 * message from a turn that predates the epoch and settle it instantly, at
 * epoch 1, having observed nothing this epoch did.
 *
 * **DOES NOT CLAIM** to know that the agent stopped because it FINISHED. It
 * knows that Pi wrote an assistant message whose stop reason is not
 * `toolUse`, which is a statement about the message stream and not about the
 * work. SRD §3.5 says completion in this mode is "transcript-derived,
 * coarser", and this is the coarseness: an agent that answers "I'll get right
 * on that" and stops reads exactly like one that finished. The `rpc` path's
 * defences against that shape — the F39 prose detector, `CompletionTracker`'s
 * correlated probe — need the event stream this mode does not have.
 */
export function classifyTuiTurn(sinceDispatch: readonly TreeEntry[]): TuiTurnReading {
  let last: TreeEntry | null = null;
  for (const e of sinceDispatch) {
    if (isAssistantEntry(e)) last = e;
  }
  if (last === null) return { phase: "awaiting_start", stopReason: null };
  const message = (last as { message?: { stopReason?: unknown } }).message;
  const stopReason = typeof message?.stopReason === "string" ? message.stopReason : null;
  if (stopReason !== null && CONTINUING_STOP_REASONS.has(stopReason)) {
    return { phase: "in_flight", stopReason };
  }
  return { phase: "ended", stopReason };
}

/**
 * The verdict a settled `tui` epoch gets, from the stop reason that ended it.
 *
 * The mapping is deliberately the SAME one `harvest/transcript.ts`'s
 * `reconstruct` applies to the last assistant message, because both are
 * answering one question — what does this stop reason mean — and two spellings
 * of it would eventually disagree about a live worker and its own harvest.
 *
 * It is not literally shared code, and that is a decision rather than an
 * oversight: `reconstruct` returns `unknown` for a clean stop because ITS
 * subject is "did this worker produce a result envelope", which a transcript
 * cannot answer. Here the subject is "did the turn end badly", and a turn that
 * ended cleanly is a `success` whose envelope the harvest will judge
 * separately, on the same evidence, with its own stricter rule. Collapsing the
 * two would make every `tui` task settle `unknown` and defer every verdict to
 * harvest — which is not coarser completion, it is no completion.
 */
export function verdictForStopReason(stopReason: string | null): { verdict: Verdict; reason: string } {
  switch (stopReason) {
    case "aborted":
      return { verdict: "aborted", reason: "transcript_stop_aborted" };
    case "error":
      return { verdict: "failed", reason: "transcript_stop_error" };
    case "length":
      // Truncation is not a failure of the agent and not a success either. The
      // `rpc` path has no equivalent because a length stop there is followed
      // by an `agent_end` that says how the turn actually finished.
      return { verdict: "unknown", reason: "transcript_stop_length" };
    default:
      return { verdict: "success", reason: "transcript_quiesced" };
  }
}

/**
 * Did this growth come from the STAGED task, or from the operator? (§9 Q1)
 *
 * ## The question this answers, and why it was unanswerable until now
 *
 * `tui_stage_triggered` has always carried the word APPROXIMATE, and §9 Q1
 * states why: the only observable a supervisor has for "a turn started" is the
 * transcript growing, and growth after a stage may equally be the operator
 * typing something else into the same pane. Q1's own probe — *"stage a task, do
 * not trigger it, type something else, and see whether any available signal
 * separates the two"* — expected the answer to be no, and for the TYPED route
 * it still is: an operator who pastes the brief produces a user message that
 * looks like any other user message.
 *
 * **The auto-trigger route creates the signal Q1 went looking for.** The
 * message that starts the turn is not typed by anyone; it is sent by pifleet's
 * own extension, with text pifleet chose. So its presence in the new entries is
 * evidence the growth is this stage's turn and not a person's.
 *
 * ## What a `true` and a `false` each mean, which are not symmetric
 *
 * `true` is a positive identification and is worth the same as one. `false` is
 * the ABSENCE of evidence, not evidence of absence: it is what a typed-route
 * stage returns, what an auto-trigger worker returns if the operator got a
 * prompt in first, and what any worker returns whose extension did not load.
 * The caller must therefore treat `false` exactly as it treated every growth
 * before this function existed — as the upper bound §9 Q1 describes — and must
 * not turn it into a claim that the operator interrupted.
 *
 * The scan is over ALL new entries rather than just the first, because
 * `deliverAs: "followUp"` queues the message behind whatever the agent was
 * already doing: the trigger can legitimately arrive second.
 */
export function attributedToStage(sinceBaseline: readonly TreeEntry[]): boolean {
  for (const entry of sinceBaseline) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    if (message === undefined || message.role !== "user") continue;
    // The content shape is Pi's, not ours, and it is a string in some versions
    // and a content-block array in others. Stringifying covers both without
    // asserting which — a narrower reader that guessed wrong would return
    // `false` forever and silently reinstate the approximation this closes.
    if (JSON.stringify(message.content ?? "").includes(AUTO_TRIGGER_TEXT)) return true;
  }
  return false;
}
