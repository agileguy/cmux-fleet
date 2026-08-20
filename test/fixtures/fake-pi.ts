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
 *   | any raw record (written verbatim as one JSONL line)
 *
 * Steps for one command are consumed in order; the last one repeats.
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
}

function parseArgs(argv: string[]): Args {
  let scenario = process.env["PIFLEET_FAKE_SCENARIO"] ?? "";
  let sessionDir = ".";
  let sessionId = "fake";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--scenario") scenario = argv[++i] ?? "";
    else if (a === "--session-dir") sessionDir = argv[++i] ?? ".";
    else if (a === "--session-id") sessionId = argv[++i] ?? "fake";
    else if (a === "--mode" || a === "--provider" || a === "--model") i++; // real-Pi flags, ignored
  }
  if (scenario === "") {
    process.stderr.write("fake-pi: --scenario <file> is required\n");
    process.exit(2);
  }
  return { scenario, sessionDir, sessionId };
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
type EmitEntry = EmitDelay | EmitPartial | EmitExit | EmitNoise | Record<string, unknown>;

interface Step {
  on: string;
  /** `--session-id` values this step applies to; absent means "any". */
  sessions?: string[];
  ack?: { success?: boolean; error?: string };
  respond?: Record<string, unknown>;
  respond_delay_ms?: number;
  emit?: EmitEntry[];
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
  const entry = {
    type: kind,
    id,
    parentId: entrySeq > 1 ? `e${entrySeq - 1}` : null,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }] },
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
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        "<!doctype html>\n<html><head><meta charset=\"utf-8\">" +
          `<title>fake-pi export ${args.sessionId}</title></head>` +
          `<body><p id="${EXPORT_MARKER}">rendered by the agent, not by the CLI</p></body></html>\n`,
      );
      respond(id, command, true, { path: target });
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
    if (msg !== undefined) await handle(msg);
  }
}

// stdin EOF → shutdown → exit 0, exactly like real Pi (SRD §3.4 rule 1).
if (existsSync(sessionPath)) {
  // Leave the transcript as-is; a partial trailing line would be a lie.
}
process.exit(0);
