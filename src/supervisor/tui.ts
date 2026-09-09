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
import { basename, join } from "node:path";
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
   * True when the chosen file is NOT named for this worker — an ADOPTED
   * session, which is what a `/new` leaves behind.
   *
   * `resetPaneSession` types `/new` at an idle pane to give the next task an
   * empty session (`SESSION_RESET_LINE`). Pi honours it by starting a fresh
   * session, and it names that one by its own generated id: the seat's second
   * transcript is `<stamp>_01a08415-44aa-….jsonl`, not `<stamp>_tri-1.jsonl`.
   * The `--session-id` the host passes at launch applies to the FIRST session
   * only, and Pi's `/session` command reports state rather than setting it, so
   * there is nothing to pass again.
   *
   * MEASURED before it was fixed, on 2026-09-08/09. `tri-1` completed sweep 5
   * in its worker-named session, was reset, ran sweep 6 in a UUID-named one —
   * and every host surface kept reading the first file. `status` showed the
   * seat frozen at the reset instant; the triage actor's join looked for a task
   * record "under tri-1", waited 780 s and failed the pass; the envelope landed
   * with `"worker": "01a08415-…"` where the previous one said `"tri-1"`. **The
   * work ran and delivered through `submit_report`; only the attribution was
   * lost.** The same pair of files is present in eight runs, including the one
   * that skipped 28 consecutive triage ticks over 7.7 hours — so the recurring
   * "stalled seat" on this fleet was one seat doing its job into a file nobody
   * was reading.
   *
   * This flag is what stops the repair from being silent: an adopted path is a
   * weaker claim than a matched one and the caller logs it as its own event.
   */
  adopted: boolean;
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
/**
 * Pi's own generated session id: the 8-4-4-4-12 hex of a v7 UUID.
 *
 * Named narrowly rather than "not a worker id", because the two conditions are
 * not the same and only this one is checkable. `SESSION_ID_RE` in
 * `contracts.ts` is Pi's session-id GRAMMAR and a worker id satisfies it by
 * design, so "is it a worker id" has no answer from a filename alone — it needs
 * the run's roster, which is exactly what a caller may not have.
 *
 * This is the second of the two conditions adoption requires, and it is the one
 * that keeps the containment property when the first is satisfied by accident.
 * A run whose roster says one worker can still hold a sibling's named
 * transcript — a relaunch, a repurposed directory, a roster read a moment too
 * early — and `_eng-2.jsonl` must never be adopted by `eng-1` on the strength
 * of "nobody claimed it". A generated id cannot be confused with a seat name in
 * any of those cases, because no worker in this fleet is called
 * `01a08415-44aa-7645-b3d1-e1ab590e5126`.
 */
const PI_GENERATED_SESSION_RE =
  /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

function isPiGeneratedSession(name: string): boolean {
  return PI_GENERATED_SESSION_RE.test(name);
}

export async function discoverSessionPath(
  sessionsDir: string,
  sessionId: string,
  runWorkerIds: readonly string[] = [],
): Promise<SessionDiscovery> {
  const suffix = sessionFileSuffix(sessionId);
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return { path: null, matches: 0, adopted: false };
  }
  const own = names.filter((n) => n.endsWith(suffix) && n.length > suffix.length);

  /*
   * WHEN AN UNCLAIMED FILE MAY BE ADOPTED — and this is the half that makes
   * adoption safe rather than merely convenient.
   *
   * A `/new` leaves a session named for Pi's own id, so the only way to
   * attribute it is by elimination: a transcript in this run's directory named
   * for NO worker in the run. That reasoning is sound only when this worker is
   * the run's ONLY one, and `runWorkerIds` is how the caller states that. It
   * holds for every console seat — `up` gives each pane its own run, and all
   * eight runs carrying an orphaned session are single-seat.
   *
   * **The empty default means UNKNOWN and therefore refuses to adopt**, which
   * is deliberate and is the direction this must fail. `sessionId` is a worker
   * id and this directory holds every worker's transcript, so a search that
   * adopted by default would hand one worker another's evidence the moment a
   * caller forgot the argument — the exact hazard ISC-95's never-glob rule
   * exists to prevent, and the reason the match below is a SUFFIX and not a
   * wildcard. A stale path is a bug; a mis-attributed transcript is a lie, and
   * the unchanged default keeps every existing caller on the old behaviour.
   *
   * With siblings present adoption is withheld for the same reason: two seats
   * in one run that both reset produce two unclaimed files and nothing in the
   * name says which is which.
   */
  const soleWorker = runWorkerIds.length === 1 && runWorkerIds[0] === sessionId;
  const unclaimed = soleWorker ? names.filter(isPiGeneratedSession) : [];

  const candidates = [...own, ...unclaimed];
  if (candidates.length === 0) return { path: null, matches: 0, adopted: false };

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
  /*
   * NEWEST WINS ACROSS BOTH SETS, which is the behaviour that actually repairs
   * the defect: after a reset the worker-named file stops growing and the
   * adopted one does not, so mtime is exactly the question "which of these is
   * the session the seat is speaking into now".
   *
   * `matches` still counts only the NAMED matches. It is the ambiguity
   * diagnostic the event log has always carried and it means "how many files
   * claimed to be this worker's", which an adopted file does not.
   */
  return {
    path: best,
    matches: own.length,
    adopted: best !== null && !own.includes(basename(best)),
  };
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

/**
 * How long the supervisor may go without re-running the session search.
 *
 * A `tui` seat's transcript can be REPLACED mid-run — `resetPaneSession` types
 * `/new` at an idle pane and Pi opens a session under its own generated id — so
 * a search that ran once and cached its answer reads a frozen file for the rest
 * of the run. That is not hypothetical: it cost a triage console 28 consecutive
 * skipped sweeps over 7.7 hours while the seat was working normally.
 *
 * Five seconds is ten polls. The event it exists to catch happens BETWEEN
 * tasks, at most once per dispatch, so a readdir on every 500 ms poll would be
 * two orders of magnitude more work than the question deserves. The lateness it
 * buys costs nothing: `TranscriptReader` reads a newly adopted path from the
 * top, so entries written during the window arrive with the swap rather than
 * being skipped.
 */
export const SESSION_REDISCOVER_MS = 5_000;

/**
 * How long the transcript must be quiet after an assistant message that
 * stopped on `error`, which is longer than `TUI_QUIET_MS` because an `error`
 * stop is a state Pi RETRIES OUT OF rather than a state it ends in.
 *
 * MEASURED, on run `2026-09-04T00-26-46Z-1002`. A tester was dispatched to run
 * this repository's unit suite. Its provider dropped three turns in a row —
 * assistant entries at 00:28:41.460, 00:28:46.197 and 00:28:49.670, each
 * carrying a `thinking` part and NOTHING else, no tool call and no text. Pi
 * retried through all three. The worker went on to run the suite, write its
 * result envelope at 00:28:58 and finish cleanly at 00:28:59.568 with
 * `stopReason: "stop"`.
 *
 * The supervisor settled it `failed` at 00:28:43.537.
 *
 * The gap between the first error entry and the next entry was 3.271s, so a
 * 2s window expired inside it and `verdictForStopReason("error")` was applied
 * to a worker that was still working. Everything downstream then read a run
 * that had not happened: harvest ran 15 seconds before the envelope existed
 * and reported "no result envelope; grading on derived facts alone" about a
 * file that was about to be written, and `wait` exited 7.
 *
 * This is the same defect shape as `wait`'s false `staged_untriggered` — a
 * terminal verdict declared from a state the worker is about to leave — and it
 * takes the same repair: not a better guess about the state, but enough time
 * for the state to disprove itself. Growth already resets the clock, so any
 * retry that produces a single entry clears the reading entirely.
 *
 * Thirty seconds because the observed retry storm spanned 8s and a provider
 * backing off exponentially can exceed that; the cost is paid ONLY by a task
 * that really did end on an error, where 28 extra seconds of latency is worth
 * less than one falsely-failed run. A turn that ends any other way is still
 * settled on the 2s window.
 */
export const TUI_ERROR_GRACE_MS = 30_000;

/**
 * How long THIS reading must stay quiet before it is believed.
 *
 * A function rather than a ternary at the call site so that the rule is
 * testable without standing a supervisor up, in the same way
 * `verdictForStopReason` is. The two are a pair and are meant to be read
 * together: this one decides WHEN a stop reason is believed, that one decides
 * what it MEANS once it is.
 */
export function quietWindowMsFor(stopReason: string | null): number {
  return stopReason === "error" ? TUI_ERROR_GRACE_MS : TUI_QUIET_MS;
}

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

/**
 * The layer-4 entry `submit_report` appends immediately before returning a
 * TERMINATING tool result (`docker/pi-extensions/report-tools.ts`).
 *
 * ## Why this module knows about it, when it knows about nothing else
 *
 * `toolUse` means "not over" because Pi always follows an outstanding tool call
 * with a result and then ANOTHER assistant message. `terminate: true` is the one
 * documented case where that second half never comes: `docs/extensions.md` calls
 * it a hint that *"the automatic follow-up LLM call should be skipped after the
 * current tool batch"*. So the transcript's last assistant message stays
 * `toolUse` forever, `classifyTuiTurn` reads `in_flight` on every poll, the quiet
 * clock is reset each time, and the epoch cannot settle by any route but its own
 * deadline — `timed_out`, on a task that succeeded.
 *
 * Measured on the first live Phase A run (ISC-1105): three seats delivered a
 * complete report through `submit_report`, all three settled `timed_out`, and
 * `relay.ts` publishes a reply only for a lens that SUCCEEDED — so two of three
 * reviews were discarded in silence and the collation reported one lens.
 *
 * **The ENTRY and not the tool name**, because the two differ exactly where it
 * matters: a REFUSED `submit_report` appends nothing and returns no `terminate`,
 * so Pi does make the follow-up call and the turn really is still in flight.
 * Keying on the name would settle a refusal as though it had delivered.
 *
 * This is layer 4 used for what §6.3 built it for — making the delivery legible
 * to a host reader — so the coupling is to a published contract rather than to
 * the extension's internals.
 */
const SUBMIT_ENTRY_TYPE = "pifleet.submit/v1";

/** Every `toolCall` id in an assistant message's content blocks. */
function toolCallIds(entry: TreeEntry): string[] {
  const content = (entry as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; id?: unknown };
    if (b.type === "toolCall" && typeof b.id === "string") ids.push(b.id);
  }
  return ids;
}

/**
 * Did a terminating `submit_report` end this batch?
 *
 * Both halves are required, and the second is not ceremony. `terminate` is
 * batch-conditional — effective *"only when every finalized tool result in that
 * batch is terminating"* — so a model that called `submit_report` ALONGSIDE a
 * slow tool still gets its follow-up call, and the turn is genuinely in flight
 * while that tool runs. Requiring every call in the batch to have been answered
 * is what keeps this from settling such a turn early: `TUI_QUIET_MS` is 2s, far
 * shorter than a long `bash`, so the quiet window alone would not have caught it.
 */
function terminatedBySubmit(sinceDispatch: readonly TreeEntry[], lastAssistant: TreeEntry): boolean {
  const after = sinceDispatch.slice(sinceDispatch.indexOf(lastAssistant) + 1);
  const delivered = after.some(
    (e) => e.type === "custom" && (e as { customType?: unknown }).customType === SUBMIT_ENTRY_TYPE,
  );
  if (!delivered) return false;
  const answered = new Set<string>();
  for (const e of after) {
    const m = (e as { message?: { role?: unknown; toolCallId?: unknown } }).message;
    if (m?.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
  }
  return toolCallIds(lastAssistant).every((id) => answered.has(id));
}

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
  /*
   * A USER message after the last assistant message means another agent cycle
   * is queued — Pi has been given something to answer and has not answered it.
   * Reading only the last ASSISTANT message misses that entirely, and layer 3's
   * nag is exactly such a message: it is delivered as a `followUp`, so it lands
   * here and starts a new turn.
   *
   * ISC-1107 measured what that cost. `col-1` stopped at 19:10:40, the nag
   * landed in the same second, and the epoch settled at 19:10:41.996 — a
   * 1.99-second runway, because growth restarts the quiet clock and the window
   * IS `TUI_QUIET_MS`. The model answered at 19:10:44 and `submit_report`
   * refused with `No task is live`: the nag could not be obeyed by any model
   * slower than the quiet window, which is all of them. Layer 3 was measured on
   * the `rpc` plane, where settle waits for `agent_end` and the runway was
   * 0.18-1.05s — the same wrong-plane gap as ISC-1105.
   *
   * A queued message nobody ever answers now runs to the DEADLINE rather than
   * settling `success`. That is the correct trade and not a new hazard: an
   * epoch with an unanswered prompt in it has not finished, and `timed_out` on
   * a stuck agent is what the deadline is for. It is also bounded, where the
   * `toolUse` reading this function used to give was not.
   */
  for (let i = sinceDispatch.length - 1; i >= 0; i--) {
    const e = sinceDispatch[i];
    if (e === last) break;
    const role = (e as { message?: { role?: unknown } }).message?.role;
    if (role === "user") return { phase: "in_flight", stopReason: null };
  }
  const message = (last as { message?: { stopReason?: unknown } }).message;
  const stopReason = typeof message?.stopReason === "string" ? message.stopReason : null;
  if (stopReason !== null && CONTINUING_STOP_REASONS.has(stopReason)) {
    // The one documented exception: a terminating tool result skips the
    // follow-up call, so this `toolUse` is the LAST assistant message this turn
    // will ever have. See `SUBMIT_ENTRY_TYPE`. The caller's quiet window still
    // arbitrates — this only stops `in_flight` from resetting it forever.
    if (terminatedBySubmit(sinceDispatch, last)) return { phase: "ended", stopReason };
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
    case "toolUse":
      // Reachable only through `terminatedBySubmit` — every other `toolUse` is
      // `in_flight` and never reaches a verdict. Named separately from
      // `transcript_quiesced` because the two are settled on different evidence:
      // this one ended because the worker DELIVERED, and an operator reading
      // `timed_out` on a Phase A seat needs to be able to tell the difference.
      return { verdict: "success", reason: "transcript_terminating_report" };
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
