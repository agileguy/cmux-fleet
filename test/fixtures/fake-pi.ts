#!/usr/bin/env bun
/**
 * `pifleet-fake-pi` — the Pi test double (SRD §15).
 *
 * Speaks the identical JSONL RPC framing on stdin/stdout and replays a
 * scripted event sequence from a fixture file. It exists because roughly a
 * dozen acceptance criteria demand deterministic control of the event stream —
 * emit `agent_end{willRetry:true}` then continue, settle on an aborted turn,
 * ack a prompt then fail it late — and no real LLM can be made to do these on
 * demand.
 *
 * The double is deliberately HOSTILE-capable, not merely happy: scenarios can
 * emit duplicate terminal events, inject uncorrelated responses, delay a
 * response past a client timeout, disconnect mid-JSON-line, and race a
 * `queue_update` between two `get_state` reads. A suite that only replays
 * sequences we already believe in verifies nothing.
 *
 * Faithful-to-Pi behaviours this double preserves:
 * - `prompt` acks immediately; events stream afterwards on the same pipe.
 * - stdin EOF → clean shutdown → exit 0 (Pi exits 0 in every case, SRD §3.4).
 * - The session transcript is created LAZILY on the first assistant message,
 *   at a timestamp-prefixed path unknowable in advance (SRD §4.2); `get_state`
 *   reports that path verbatim in `sessionFile`.
 * - A startup warning goes to stderr — an unread stderr pipe wedging the
 *   worker is a real failure mode the supervisor must drain (§3.4 rule 2).
 *
 * One worker-side hardening beyond real Pi: if a `prompt` carries an `epoch`,
 * the double rejects any epoch at or below the highest it has accepted. The
 * fence must be enforced at the resource, not just bookkept by the allocator —
 * a detached supervisor plus a CLI relaunch is two allocators.
 *
 * Scenario file shape:
 *   { "scenario": "name", "steps": [ Step, ... ] }
 * Step:
 *   { "on": "<command>",
 *     "sessions": ["eng-1", ...]                  — restrict this step to those
 *                                                   `--session-id` values
 *     "ack": {"success": false, "error": "..."}   — override the immediate ack
 *     "respond": {...}                            — response `data` payload
 *     "respond_delay_ms": 300                     — delay before responding
 *     "emit": [EmitEntry, ...]                    — events streamed after ack
 *     "emit_after_respond": [EmitEntry, ...]      — events streamed after the
 *                                                   response (queue-race)
 *     "late": {"delay_ms": 150, "success": false, "error": "..."}
 *                                                 — a SECOND response, same id
 *     "cancel_active": true }                     — stop the active emission
 * EmitEntry:
 *   {"delay_ms": 200} | {"partial": "raw text, no newline"} | {"exit": 1}
 *   | {"noise": {"stream": "stderr", "lines": 2000, "bytes": 400}}
 *   | {"type": "extension_ui_request", "id": "...", "method": "editor",
 *      "params": {...}, "await_response": true, "self_resolve_ms": 8000}
 *   | any raw record (written verbatim as one JSONL line)
 *
 * Steps for one command are consumed in order; the last one repeats.
 *
 * BLOCKING DIALOGS — `await_response` and `self_resolve_ms` (ISC-111/112).
 *
 * SRD §4.2 splits the nine `extension_ui_request` methods into two classes and
 * the split is entirely about who is waiting. The five FIRE-AND-FORGET methods
 * (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) announce
 * something and the agent carries on; the four DIALOG methods (`select`,
 * `confirm`, `input`, `editor`) HOLD THE TURN until someone answers. A double
 * that emitted a dialog and then finished the turn anyway would model the first
 * class under the name of the second, and every test written against it would
 * be green for a reason unrelated to the criterion — ISA.md's ISC-112 note says
 * it outright: "a scenario that emits an `editor` request and then finishes
 * anyway would produce a green test proving only that the double does not
 * block. Until the blocking-step form exists, any pass here is a false one."
 *
 * `await_response: true` is that form. The record is written to stdout with the
 * two scenario directives STRIPPED (real Pi never sends them), and the emission
 * sequence then stops dead — no `turn_end`, no `agent_end`, nothing that
 * follows in `emit` — until one of three things happens:
 *
 *   1. a frame arrives on stdin that MENTIONS this request's `id` anywhere in
 *      its values, at any depth (`unblocked_by: "response"`);
 *   2. `self_resolve_ms` elapses, if the scenario set one
 *      (`unblocked_by: "self_resolve"`);
 *   3. the active emission is cancelled by an `abort` (`unblocked_by:
 *      "cancelled"`).
 *
 * THE CORRELATION RULE IS DELIBERATELY SHAPE-BLIND. The exact wire frame of a
 * UI response is Pi's, not ours, and it is not written down in the SRD — so a
 * double that demanded `{"type":"extension_ui_response","request_id":...}`
 * would be asserting a guess, and would hang forever the day the real answer
 * turned out to carry the id under a different key. Matching on "this frame
 * mentions the id" is the widest rule that is still a correlation: an answer
 * addressed to a DIFFERENT dialog does not unblock this one, and an answer
 * addressed to nothing unblocks nothing at all. A frame that resolves a dialog
 * is CONSUMED — it is not a command, and passing it to the command dispatcher
 * would have the double reply to it.
 *
 * `self_resolve_ms` exists because SRD §4.2 says `select`/`confirm`/`input`
 * carry an optional timeout and self-resolve, while **`editor` has no timeout
 * and hangs forever unanswered**. It is not a safety valve: a scenario that
 * sets it is claiming its dialogs are the self-resolving kind, and because the
 * outcome is recorded, a test can tell a real answer from a self-resolve and
 * fail on the difference. Setting it on an `editor` request would model the one
 * thing `editor` provably does not do, which is why the `editor` scenario does
 * not set it and must not.
 *
 * SO AN UNANSWERED `editor` DIALOG HANGS THIS PROCESS INDEFINITELY, BY DESIGN.
 * That is the property that lets ISC-112's probe fail; a double that could not
 * hang could not produce evidence. `test/integration/ui-requests.test.ts`
 * proves the hang directly against this executable, with no supervisor
 * involved, so the claim is measured rather than asserted in a comment.
 *
 * Blocking happens inside the emission sequence, which is deliberately NOT
 * awaited by the command dispatcher (`void runEmissions(...)`). A dialog that
 * blocked `handle()` would stop this process reading its own stdin, and the
 * answer that unblocks it arrives on stdin — the double would model a wedged
 * agent that can never be woken, which is a different failure with the same
 * shape. `export_html`'s `respond_delay_ms` branch above makes the same point
 * for the same reason.
 *
 * `sessions` exists because one `PIFLEET_PI_COMMAND` serves an ENTIRE fleet —
 * every worker's double is launched from the same string with the same
 * `--scenario`, and only `--session-id` distinguishes them. Making a fleet
 * heterogeneous (fifteen quiet workers and one that floods its pipes, ISC-158)
 * is therefore impossible from the launch side and has to be expressible in the
 * scenario itself. A session-specific step wins OUTRIGHT over the unrestricted
 * fallback rather than merging with it, so a scenario reads as "these workers
 * do this, everyone else does that" instead of an ordering puzzle.
 */

import { dirname, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { LineSplitter, parseLine } from "../../src/util/jsonl.ts";
import { stepsForSession } from "./scenario-steps.ts";
import { EXPORT_MARKER } from "./export-marker.ts";

// ---------------------------------------------------------------------------
// Argument parsing — tolerant of real Pi flags it does not implement.
// ---------------------------------------------------------------------------

interface Args {
  scenario: string;
  sessionDir: string;
  sessionId: string;
  /**
   * Output tokens to stamp on every assistant transcript entry's `usage`
   * (A4), or 0 for none.
   *
   * OPT-IN, and the default of 0 is the point: with this absent no `usage`
   * key is written at all, so every scenario that existed before this flag
   * produces byte-identical transcripts. Real Pi always carries usage;
   * emitting it unconditionally here would change the fixture every
   * transcript test in the repo already asserts against, to serve one test
   * that needs a ceiling to trip.
   *
   * Tokens are what a budget can actually watch locally — `cost` stays 0
   * because local models have no price table (SRD §5.9), which is the
   * inversion ISC-115 pins.
   */
  tokensPerMessage: number;
}

function parseArgs(argv: string[]): Args {
  let scenario = process.env["PIFLEET_FAKE_SCENARIO"] ?? "";
  let sessionDir = ".";
  let sessionId = "fake";
  let tokensPerMessage = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--scenario") scenario = argv[++i] ?? "";
    else if (a === "--session-dir") sessionDir = argv[++i] ?? ".";
    else if (a === "--session-id") sessionId = argv[++i] ?? "fake";
    else if (a === "--tokens-per-message") tokensPerMessage = Number(argv[++i] ?? 0);
    else if (a === "--mode" || a === "--provider" || a === "--model") i++; // real-Pi flags, ignored
  }
  if (scenario === "") {
    process.stderr.write("fake-pi: --scenario <file> is required\n");
    process.exit(2);
  }
  return { scenario, sessionDir, sessionId, tokensPerMessage };
}

interface EmitDelay {
  delay_ms: number;
}
interface EmitPartial {
  partial: string;
}
interface EmitExit {
  exit: number;
}
/**
 * A deliberate flood of one pipe (ISC-158).
 *
 * `bytes` is the filler width of each line, `lines` how many, and
 * `chunk_pause_ms` how long to yield every `NOISE_CHUNK_LINES` lines — a real
 * agent streams output while staying able to answer `get_state`, and a double
 * that monopolised its own event loop would model a hang rather than a flood.
 */
interface EmitNoise {
  noise: {
    stream: "stdout" | "stderr";
    lines: number;
    bytes: number;
    chunk_pause_ms?: number;
  };
}
/**
 * An `extension_ui_request` the double BLOCKS on (ISC-111/112).
 *
 * `await_response` and `self_resolve_ms` are SCENARIO DIRECTIVES, not wire
 * fields: they are stripped before the record reaches stdout, because real Pi
 * sends neither and a supervisor that started keying on them would be reading a
 * fixture artifact. The rest of the record — `type`, `id`, `method`, `params`
 * and anything else the scenario wrote — goes out verbatim, so the wire shape
 * of a blocking dialog is byte-identical to a non-blocking one and nothing
 * downstream can tell which kind the scenario asked for.
 */
interface EmitAwaitedDialog {
  type: "extension_ui_request";
  /** What an answer has to mention to unblock this dialog; required. */
  id: string;
  method: string;
  params?: Record<string, unknown>;
  await_response?: boolean;
  /** Unblock after this long unanswered — the §4.2 optional timeout. */
  self_resolve_ms?: number;
}

type EmitEntry =
  | EmitDelay
  | EmitPartial
  | EmitExit
  | EmitNoise
  | EmitAwaitedDialog
  | Record<string, unknown>;

interface Step {
  on: string;
  /** `--session-id` values this step applies to; absent means "any". */
  sessions?: string[];
  ack?: { success?: boolean; error?: string };
  respond?: Record<string, unknown>;
  respond_delay_ms?: number;
  emit?: EmitEntry[];
  /**
   * Events streamed BEFORE this step's ack, awaited so they really do land
   * ahead of it in the stream (ISC-141).
   *
   * `emit` and `emit_after_respond` both run after the ack, so neither can
   * place a record at a seq BELOW `ack_seq` — and that is the only region in
   * which `EpochManager.attribute` can answer `prior` for a live epoch. Without
   * this field the pre-ack window is unreachable from a scenario, which is why
   * no test drove it before.
   *
   * A real worker produces this shape whenever a previous turn's events are
   * still draining as the next prompt arrives: the drain and the ack share one
   * pipe, and the drain got there first.
   */
  emit_before_ack?: EmitEntry[];
  emit_after_respond?: EmitEntry[];
  late?: { delay_ms: number; success: boolean; error?: string };
  cancel_active?: boolean;
}

interface Scenario {
  scenario: string;
  steps: Step[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const scenario: Scenario = JSON.parse(await Bun.file(args.scenario).text()) as Scenario;

/** Per-command step cursors; the last matching step repeats when exhausted. */
const cursors = new Map<string, number>();

/**
 * The steps this process runs for `command`.
 *
 * A step naming this session in `sessions` wins OUTRIGHT: if any exist, the
 * unrestricted steps are not considered at all. Merging the two lists instead
 * would make a scenario's meaning depend on document order across two
 * different intents, and the cursor below would then walk a noisy worker off
 * its own script and onto the fallback on its second dispatch.
 *
 * The partition is FIXED for the life of the process — `--session-id` never
 * changes — so the cursor can stay keyed on the command alone.
 *
 * The rule itself lives in `scenario-steps.ts` so it can be exercised without
 * starting this executable, and so a scenario that leaves a session with no
 * applicable step says so on stderr instead of hanging that worker silently.
 */
function stepsFor(command: string): Step[] {
  return stepsForSession(scenario.steps, command, args.sessionId, (message) =>
    process.stderr.write(`fake-pi: ${message}\n`),
  );
}

function stepFor(command: string): Step | undefined {
  const matching = stepsFor(command);
  if (matching.length === 0) return undefined;
  const i = cursors.get(command) ?? 0;
  cursors.set(command, i + 1);
  return matching[Math.min(i, matching.length - 1)];
}

/** Whether an agent turn is conceptually in flight, for auto `get_state`. */
let streaming = false;
/** Monotonic across the whole process — the ABA defence reads this twice. */
let turnsStarted = 0;
/** Worker-side epoch fence: reject anything at or below the high-water-mark. */
let lastAcceptedEpoch = 0;
/** Cancel flag for the active emission sequence. */
let activeCancel = { cancelled: false };
let lastAssistantText = "";

// ---------------------------------------------------------------------------
// Session transcript — lazy creation, timestamp-prefixed path (SRD §4.2).
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const sessionPath = join(args.sessionDir, `${stamp}_${args.sessionId}.jsonl`);
/** Entries buffered until the first ASSISTANT message creates the file. */
const pendingEntries: Record<string, unknown>[] = [];
let sessionCreated = false;
let entrySeq = 0;

function transcriptEntry(role: "user" | "assistant", text: string, kind = "message"): void {
  const id = `e${++entrySeq}`;
  const message: Record<string, unknown> = { role, content: [{ type: "text", text }] };
  if (role === "assistant" && args.tokensPerMessage > 0) {
    // The A4 shape `usageFromAssistantMessage` parses: input/output counts and
    // an unpriced cost. Split so the total is exactly `tokensPerMessage`,
    // which is what lets a test name a ceiling in whole messages.
    const output = Math.ceil(args.tokensPerMessage / 2);
    message["usage"] = {
      input: args.tokensPerMessage - output,
      output,
      cost: { total: 0 },
    };
  }
  const entry = {
    type: kind,
    id,
    parentId: entrySeq > 1 ? `e${entrySeq - 1}` : null,
    timestamp: new Date().toISOString(),
    message,
  };
  if (role === "assistant") lastAssistantText = text;
  if (!sessionCreated) {
    pendingEntries.push(entry);
    if (role === "assistant") {
      // First assistant message: NOW the file exists (never earlier).
      mkdirSync(args.sessionDir, { recursive: true });
      const header = {
        type: "session",
        version: 3,
        id: args.sessionId,
        timestamp: new Date().toISOString(),
      };
      writeFileSync(
        sessionPath,
        [header, ...pendingEntries].map((e) => `${JSON.stringify(e)}\n`).join(""),
      );
      pendingEntries.length = 0;
      sessionCreated = true;
    }
    return;
  }
  appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeRecord(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(
  id: string | undefined,
  command: string,
  success: boolean,
  data?: unknown,
  error?: string,
): void {
  const r: Record<string, unknown> = { type: "response", command, success };
  if (id !== undefined) r["id"] = id;
  if (data !== undefined) r["data"] = data;
  if (error !== undefined) r["error"] = error;
  writeRecord(r);
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** How many noise lines are written before the double yields its event loop. */
const NOISE_CHUNK_LINES = 50;

/**
 * Flood one pipe (ISC-158).
 *
 * stderr takes raw filler, which is the point: an unread stderr pipe fills at
 * ~64KB and the child blocks on `write(2)`, so a supervisor that stopped
 * draining (SRD §3.4 rule 2) wedges a worker that looks alive.
 *
 * stdout takes VALID JSONL records, and must. `RpcClient` treats one
 * unparseable line as fatal and kills the child, so raw filler there would
 * measure the protocol kill path rather than throughput. `message_update` is
 * the honest choice: it is what a streaming agent's output actually is, and
 * `completion.ts` counts it as an activity event, so the flood also exerts the
 * real backpressure on the completion detector instead of a decorative one.
 */
/**
 * A `noise` payload, validated rather than asserted.
 *
 * The cast this replaces was load-bearing in the worst way: a malformed spec
 * (`lines` misspelled, `bytes` a string) produced `undefined` bounds, the
 * emission loop ran zero times, and the flood silently did not happen. The
 * suite would then be asserting an ordering between one worker that emitted
 * nothing and fourteen others — green, and describing nothing. A scenario
 * mistake has to be louder than the property it breaks.
 */
function parseNoiseSpec(raw: unknown): EmitNoise["noise"] | null {
  const s = raw as Partial<EmitNoise["noise"]> | null;
  if (s === null || typeof s !== "object") return null;
  const problems: string[] = [];
  if (s.stream !== "stdout" && s.stream !== "stderr") {
    problems.push(`stream must be "stdout" or "stderr", got ${JSON.stringify(s.stream)}`);
  }
  if (typeof s.lines !== "number" || !Number.isFinite(s.lines) || s.lines <= 0) {
    problems.push(`lines must be a positive number, got ${JSON.stringify(s.lines)}`);
  }
  if (typeof s.bytes !== "number" || !Number.isFinite(s.bytes) || s.bytes <= 0) {
    problems.push(`bytes must be a positive number, got ${JSON.stringify(s.bytes)}`);
  }
  if (s.chunk_pause_ms !== undefined && typeof s.chunk_pause_ms !== "number") {
    problems.push(`chunk_pause_ms must be a number when present`);
  }
  if (problems.length > 0) {
    process.stderr.write(`fake-pi: ignoring malformed 'noise' entry — ${problems.join("; ")}\n`);
    return null;
  }
  return s as EmitNoise["noise"];
}

async function emitNoise(spec: EmitNoise["noise"], cancel: { cancelled: boolean }): Promise<void> {
  const filler = "x".repeat(Math.max(1, spec.bytes));
  const pause = spec.chunk_pause_ms ?? 0;
  for (let i = 0; i < spec.lines; i++) {
    if (cancel.cancelled) return;
    if (spec.stream === "stderr") process.stderr.write(`noise ${i} ${filler}\n`);
    else writeRecord({ type: "message_update", text: `${i} ${filler}` });
    // `sleep(0)` still yields a macrotask, so stdin stays serviceable even
    // with no configured pause.
    if ((i + 1) % NOISE_CHUNK_LINES === 0) await sleep(pause);
  }
}

/** Stream an emission sequence, honouring delays, partials, exits and cancel. */
async function runEmissions(entries: EmitEntry[], cancel: { cancelled: boolean }): Promise<void> {
  for (const entry of entries) {
    if (cancel.cancelled) return;
    if ("delay_ms" in entry && typeof entry.delay_ms === "number") {
      await sleep(entry.delay_ms);
      continue;
    }
    if ("partial" in entry && typeof entry.partial === "string") {
      // Hostile: a record that never completes. No newline, by design.
      process.stdout.write(entry.partial);
      continue;
    }
    if ("noise" in entry) {
      const spec = parseNoiseSpec(entry.noise);
      if (spec !== null) await emitNoise(spec, cancel);
      continue;
    }
    if ("exit" in entry && typeof entry.exit === "number") {
      process.exit(entry.exit);
    }
    if (cancel.cancelled) return;
    // A dialog HOLDS the sequence: everything after it in `emit` — including
    // this turn's `turn_end` and `agent_end` — waits until it is answered.
    if (isAwaitedDialog(entry)) {
      await emitAwaitedDialog(entry as Record<string, unknown>, cancel);
      continue;
    }
    const event = entry as Record<string, unknown>;
    trackEvent(event);
    writeRecord(event);
  }
}

/** Keep the auto `get_state` honest about what has been emitted so far. */
function trackEvent(event: Record<string, unknown>): void {
  switch (event["type"]) {
    case "agent_start":
      streaming = true;
      turnsStarted++;
      break;
    case "agent_end":
      // willRetry:true means the agent itself continues — still streaming.
      streaming = event["willRetry"] === true;
      if (event["willRetry"] === false) {
        transcriptEntry("assistant", `turn ${turnsStarted} complete`);
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Blocking dialogs — the only way a scenario can model a request that HOLDS
// the turn (ISC-111/112)
// ---------------------------------------------------------------------------

/**
 * Where the double records the life of each awaited dialog, when
 * `PIFLEET_FAKE_DIALOG_LOG` names a path.
 *
 * A SECOND file rather than more lines in `PIFLEET_FAKE_REQUEST_LOG`, and the
 * separation is load-bearing. That log is documented as, and asserted as, the
 * RAW lines the supervisor wrote to this process's stdin: `ui-requests.test.ts`
 * parses every line and requires its `type` to be one of the supervisor's own
 * six commands. Interleaving the double's own observations there would make
 * that allowlist fail against the double instead of against the supervisor,
 * which is the assertion ISC-113 exists for.
 *
 * It carries the two facts the wire cannot. ELAPSED: the request log has no
 * timestamps, so a test reading only that could time a dialog no better than
 * its own polling interval, and ISC-111's bound ("elapsed < `ui_request_timeout`")
 * deserves better than a 50 ms quantum. The double knows to the millisecond
 * when it wrote the request and when the answer landed, and it is the only
 * party that does. OUTCOME: "the turn continued" is true whether a supervisor
 * answered or the dialog timed itself out, and a test that could not tell those
 * apart would credit the supervisor for `self_resolve_ms`. `unblocked_by`
 * discriminates them, which is what keeps ISC-111 from passing on the fixture's
 * own timer.
 *
 * Off unless the variable is set, exactly like the request log, so no existing
 * scenario changes behaviour by a byte.
 */
const DIALOG_LOG = process.env["PIFLEET_FAKE_DIALOG_LOG"] ?? "";

/** How a blocked dialog stopped being blocked. */
type DialogOutcome =
  | { by: "response"; response: Record<string, unknown> }
  | { by: "self_resolve" }
  | { by: "cancelled" };

interface PendingDialog {
  method: string;
  settle: (outcome: DialogOutcome) => void;
}

/** Dialogs written to stdout and not yet answered, keyed by request id. */
const pendingDialogs = new Map<string, PendingDialog>();

/** How often a blocked dialog notices its emission sequence was cancelled. */
const DIALOG_CANCEL_POLL_MS = 25;

function logDialog(record: Record<string, unknown>): void {
  if (DIALOG_LOG === "") return;
  try {
    appendFileSync(DIALOG_LOG, `${JSON.stringify(record)}\n`);
  } catch {
    // Same rule as `logRequest`: a log that cannot be written must not change
    // what the double does. The test asserting against it fails on the missing
    // file, which is a better error than a double that behaved differently
    // because of its own instrumentation.
  }
}

function isAwaitedDialog(entry: EmitEntry): boolean {
  const e = entry as Record<string, unknown>;
  if (e["type"] !== "extension_ui_request") return false;
  return e["await_response"] === true || typeof e["self_resolve_ms"] === "number";
}

/**
 * Whether `value` mentions `id` anywhere in its values, at any depth.
 *
 * The correlation rule, and it is wide ON PURPOSE — see the header. Pi's UI
 * response frame is not specified in the SRD, so the double must recognise an
 * answer without knowing which key carries the id: `{"id":...}`,
 * `{"request_id":...}`, `{"params":{"id":...}}` and a bare echo inside a nested
 * payload all read the same way here.
 *
 * KEYS ARE NOT SEARCHED, only values. A frame with a key literally named after
 * the request id would be a coincidence, not an address, and matching it would
 * let a dialog unblock on a message that never meant to answer it.
 */
function mentionsRequestId(value: unknown, id: string): boolean {
  if (typeof value === "string") return value === id;
  if (Array.isArray(value)) return value.some((v) => mentionsRequestId(v, id));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => mentionsRequestId(v, id));
  }
  return false;
}

/**
 * Unblock the dialog this inbound frame answers, if it answers one.
 *
 * Returns whether the frame was CONSUMED. A UI response is not a command, and
 * handing it to `handle()` would fall through to the default branch and have
 * the double emit a `response` record for it — inventing traffic on the very
 * wire the negative half of ISC-113 asserts about.
 */
function resolveDialog(msg: Record<string, unknown>): boolean {
  for (const [id, pending] of pendingDialogs) {
    if (!mentionsRequestId(msg, id)) continue;
    pendingDialogs.delete(id);
    pending.settle({ by: "response", response: msg });
    return true;
  }
  return false;
}

/**
 * Write a dialog request, then hold the emission sequence until it is answered.
 *
 * A dialog with no usable `id` is emitted WITHOUT blocking, loudly. It could
 * never be addressed, so blocking on it would hang the scenario forever with no
 * explanation — the `parseNoiseSpec` lesson in the other direction: a scenario
 * mistake has to be louder than the property it breaks, and "hangs until the
 * test's budget expires" is the quietest failure this file can produce.
 */
async function emitAwaitedDialog(
  entry: Record<string, unknown>,
  cancel: { cancelled: boolean },
): Promise<void> {
  const { await_response: _await, self_resolve_ms: selfResolveRaw, ...wire } = entry;
  const id = typeof entry["id"] === "string" ? entry["id"] : "";
  const method = typeof entry["method"] === "string" ? entry["method"] : "";
  const selfResolveMs =
    typeof selfResolveRaw === "number" && Number.isFinite(selfResolveRaw) && selfResolveRaw > 0
      ? selfResolveRaw
      : null;

  const refuse = (why: string): void => {
    process.stderr.write(`fake-pi: emitting '${method || "extension_ui_request"}' WITHOUT blocking — ${why}\n`);
    trackEvent(wire);
    writeRecord(wire);
  };
  if (id === "") {
    refuse("'await_response' needs a non-empty string 'id' for an answer to be addressed to");
    return;
  }
  if (pendingDialogs.has(id)) {
    refuse(`request id '${id}' is already blocked; one answer cannot address two dialogs`);
    return;
  }

  let settle!: (outcome: DialogOutcome) => void;
  const unblocked = new Promise<DialogOutcome>((resolve) => {
    settle = resolve;
  });
  // Registered BEFORE the write: the answer can be on the wire before the next
  // line of this function runs, and a race there would drop it.
  pendingDialogs.set(id, { method, settle });

  const startedAt = performance.now();
  trackEvent(wire);
  writeRecord(wire);
  logDialog({ event: "dialog_emitted", id, method, at_ms: Date.now() });

  // `abort` cancels the active emission by flipping a flag rather than by
  // rejecting anything, so a blocked dialog has to watch for it. Without this
  // the double would keep holding a turn the supervisor already gave up on and
  // exit only on stdin EOF.
  const poll = setInterval(() => {
    if (cancel.cancelled) settle({ by: "cancelled" });
  }, DIALOG_CANCEL_POLL_MS);
  const selfTimer =
    selfResolveMs === null ? null : setTimeout(() => settle({ by: "self_resolve" }), selfResolveMs);

  const outcome = await unblocked;
  clearInterval(poll);
  if (selfTimer !== null) clearTimeout(selfTimer);
  pendingDialogs.delete(id);

  logDialog({
    event: "dialog_unblocked",
    id,
    method,
    at_ms: Date.now(),
    elapsed_ms: Math.round(performance.now() - startedAt),
    unblocked_by: outcome.by,
    // Verbatim, unparsed and uninterpreted. The double has no opinion about
    // what a correct answer looks like — asserting `{cancelled:true}` is the
    // test's job, and a double that filtered on payload shape would decide the
    // question ISC-111 is asking.
    response: outcome.by === "response" ? outcome.response : null,
  });
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function handle(msg: Record<string, unknown>): Promise<void> {
  const command = typeof msg["type"] === "string" ? (msg["type"] as string) : "";
  const id = typeof msg["id"] === "string" ? (msg["id"] as string) : undefined;
  const step = stepFor(command);

  switch (command) {
    case "prompt": {
      // Worker-side epoch fence: the double, like a hardened worker, refuses
      // an epoch at or below its own high-water-mark regardless of what any
      // allocator believes.
      const epoch = msg["epoch"];
      if (typeof epoch === "number") {
        if (epoch <= lastAcceptedEpoch) {
          respond(id, command, false, undefined, `stale_epoch: ${epoch} <= ${lastAcceptedEpoch}`);
          return;
        }
        lastAcceptedEpoch = epoch;
      }
      const ack = step?.ack;
      if (ack !== undefined && ack.success === false) {
        respond(id, command, false, undefined, ack.error ?? "rejected by scenario");
        return;
      }
      /**
       * Pre-ack emissions, AWAITED (ISC-141). The await is the whole point: a
       * `void` here would race the `respond` below and the events could land
       * on either side of the ack, which is the one thing this field exists to
       * pin. `cancelled: false` because these belong to the epoch that is
       * still draining, not to the one being acked.
       */
      if (step?.emit_before_ack !== undefined) {
        await runEmissions(step.emit_before_ack, { cancelled: false });
      }
      // Ack IMMEDIATELY — accepted, not started (SRD §7.5).
      respond(id, command, true, {});
      if (typeof msg["message"] === "string") transcriptEntry("user", msg["message"]);

      activeCancel = { cancelled: false };
      if (step?.emit !== undefined) void runEmissions(step.emit, activeCancel);
      if (step?.late !== undefined) {
        const late = step.late;
        void sleep(late.delay_ms).then(() => {
          // The second response with the SAME id — the ISC-86 hazard.
          respond(id, command, late.success, undefined, late.error);
        });
      }
      return;
    }

    case "steer": {
      respond(id, command, true, {});
      if (typeof msg["message"] === "string") {
        transcriptEntry("user", msg["message"], "steering");
      }
      if (step?.emit !== undefined) void runEmissions(step.emit, { cancelled: false });
      return;
    }

    case "abort": {
      respond(id, command, true, {});
      // Default abort semantics mirror real Pi: the turn ends. A scenario can
      // override with `cancel_active:false, emit:[]` to model an abort that
      // never lands (the §7.5 interleaving).
      const cancelActive = step?.cancel_active ?? true;
      if (cancelActive) activeCancel.cancelled = true;
      const emissions =
        step?.emit ??
        ([
          { type: "agent_end", messages: [], willRetry: false },
          { type: "queue_update", steering: [], followUp: [] },
        ] as EmitEntry[]);
      void runEmissions(emissions, { cancelled: false });
      return;
    }

    case "get_state": {
      if (step?.respond_delay_ms !== undefined) await sleep(step.respond_delay_ms);
      const data: Record<string, unknown> = {
        isStreaming: streaming,
        pendingMessageCount: 0,
        sessionFile: sessionPath,
        turnsStarted,
        ...(step?.respond ?? {}),
      };
      respond(id, command, true, data);
      if (step?.emit_after_respond !== undefined) {
        void runEmissions(step.emit_after_respond, { cancelled: false });
      }
      return;
    }

    /**
     * Real Pi renders its own session to a standalone file (ISC-234). The
     * double writes a MARKER document rather than a plausible transcript,
     * because the whole point of the live path is that it is distinguishable
     * from the CLI's local re-render — the two agree on exit code and on
     * "a file exists at the path", and differ only in who wrote the bytes. A
     * test that could not tell them apart would pass with the live path
     * deleted.
     */
    case "export_html": {
      const target = typeof msg["path"] === "string" ? msg["path"] : "";
      if (step?.ack?.success === false) {
        respond(id, command, false, undefined, step.ack.error ?? "export refused by scenario");
        return;
      }
      if (target === "") {
        respond(id, command, false, undefined, "export_html requires a path");
        return;
      }
      const writeAndRespond = (): void => {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          "<!doctype html>\n<html><head><meta charset=\"utf-8\">" +
            `<title>fake-pi export ${args.sessionId}</title></head>` +
            `<body><p id="${EXPORT_MARKER}">rendered by the agent, not by the CLI</p></body></html>\n`,
        );
        respond(id, command, true, { path: target });
      };
      // `respond_delay_ms` here models the render that outruns the supervisor's
      // budget — the case ISC-234's 8s-under-10s ordering exists for, and the
      // one this case could not express at all: `prompt`, `get_state` and
      // `get_session_stats` all honoured a delay and `export_html` did not, so
      // the ordering could be inverted with the whole suite still green.
      //
      // Deliberately NOT awaited, unlike the other delay branches. `handle()`
      // is awaited by the stdin loop, so an awaited sleep stops this process
      // reading its own input — which models a WEDGED agent, not a slow
      // export. Real Pi keeps answering while a render is in flight, and the
      // difference decides whether the supervisor's late `rename` finds the
      // file or the supervisor concludes the child is gone. It also means the
      // write lands after the supervisor gave up, which is the whole point:
      // that late write is the one that used to clobber the operator's file.
      if (step?.respond_delay_ms !== undefined) {
        void sleep(step.respond_delay_ms).then(writeAndRespond);
        return;
      }
      writeAndRespond();
      return;
    }

    case "get_session_stats": {
      if (step?.respond_delay_ms !== undefined) await sleep(step.respond_delay_ms);
      respond(
        id,
        command,
        true,
        step?.respond ?? { tokens: { input: 1024, output: 256 }, cost: 0 },
      );
      return;
    }

    case "get_last_assistant_text": {
      respond(id, command, true, step?.respond ?? { text: lastAssistantText });
      return;
    }

    default: {
      if (step !== undefined) {
        if (step.respond_delay_ms !== undefined) await sleep(step.respond_delay_ms);
        respond(id, command, step.ack?.success ?? true, step.respond ?? {}, step.ack?.error);
        if (step.emit !== undefined) void runEmissions(step.emit, { cancelled: false });
        return;
      }
      respond(id, command, true, {});
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound request log — the only way to assert a NEGATIVE about the supervisor
// ---------------------------------------------------------------------------

/**
 * Every line the supervisor writes to this process's stdin, appended verbatim
 * when `PIFLEET_FAKE_REQUEST_LOG` names a path.
 *
 * It exists for the assertions no other artifact can carry: "the supervisor did
 * NOT send anything for that request". `events.jsonl` records what the
 * supervisor RECEIVED, and a message it never sent leaves no trace anywhere on
 * the run directory — so a test asserting silence has to observe the wire from
 * the far end. That is what ISC-113's fire-and-forget half needs, and asserting
 * it from the supervisor side would only prove that the code we already read
 * does what we already read.
 *
 * Off unless the variable is set, and raw lines rather than a parse, so a
 * malformed write is evidence rather than a swallowed exception. No existing
 * scenario changes behaviour: the double writes nothing extra and reads
 * nothing extra when the variable is absent.
 */
const REQUEST_LOG = process.env["PIFLEET_FAKE_REQUEST_LOG"] ?? "";

function logRequest(line: string): void {
  if (REQUEST_LOG === "") return;
  try {
    appendFileSync(REQUEST_LOG, `${line}\n`);
  } catch {
    // A log that cannot be written must not change what the double does; the
    // test asserting against it fails on the missing file instead.
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// A startup warning on stderr, faithfully modelling Pi's unresolved-model
// warnings: the supervisor MUST drain this pipe or the worker wedges (§3.4).
process.stderr.write(`fake-pi: scenario '${scenario.scenario}' loaded; model id is scripted\n`);

const splitter = new LineSplitter();
for await (const chunk of Bun.stdin.stream()) {
  for (const line of splitter.push(chunk as Uint8Array)) {
    logRequest(line);
    let msg: Record<string, unknown> | undefined;
    try {
      msg = parseLine<Record<string, unknown>>(line);
    } catch {
      process.stderr.write(`fake-pi: unparseable request: ${line.slice(0, 120)}\n`);
      continue;
    }
    // An answer to a blocked dialog is consumed here and goes no further: it
    // is a response, not a command, and the dispatcher would reply to it.
    if (msg !== undefined && resolveDialog(msg)) continue;
    if (msg !== undefined) await handle(msg);
  }
}

// stdin EOF → shutdown → exit 0, exactly like real Pi (SRD §3.4 rule 1).
if (existsSync(sessionPath)) {
  // Leave the transcript as-is; a partial trailing line would be a lie.
}
process.exit(0);
