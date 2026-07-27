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
 *   | any raw record (written verbatim as one JSONL line)
 *
 * Steps for one command are consumed in order; the last one repeats.
 */

import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { LineSplitter, parseLine } from "../../src/util/jsonl.ts";

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
type EmitEntry = EmitDelay | EmitPartial | EmitExit | Record<string, unknown>;

interface Step {
  on: string;
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
function stepFor(command: string): Step | undefined {
  const matching = scenario.steps.filter((s) => s.on === command);
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
// Main loop
// ---------------------------------------------------------------------------

// A startup warning on stderr, faithfully modelling Pi's unresolved-model
// warnings: the supervisor MUST drain this pipe or the worker wedges (§3.4).
process.stderr.write(`fake-pi: scenario '${scenario.scenario}' loaded; model id is scripted\n`);

const splitter = new LineSplitter();
for await (const chunk of Bun.stdin.stream()) {
  for (const line of splitter.push(chunk as Uint8Array)) {
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
