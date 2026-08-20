/**
 * A4 — the session transcript (SRD §8.1, §8.3).
 *
 * The transcript is the artifact class that survives a worker which died
 * before writing an envelope, which makes it the evidence of last resort for
 * `harvest --reconstruct` (ISC-91). Everything here treats the file as what it
 * is: a live JSONL stream that Pi appends to mid-poll, rewrites wholesale on
 * load-time migration and session switch, and creates lazily on the first
 * assistant message.
 *
 * All byte-level reading is delegated to `TailReader` (src/util/jsonl.ts).
 * That module carries the `U+2028` splitting rule, the streaming decoder, and
 * replacement detection — each of which took multiple review rounds to get
 * right — so this module MUST NOT read the file any other way. A second reader
 * here would reintroduce the exact bugs the seam module exists to prevent
 * (ISC-98..100, ISC-138).
 *
 * Entry shapes are verified against the installed Pi 0.79.6 package
 * (`docs/session-format.md`), not against `~/repos/pi`, which is seventeen
 * minors stale (SRD §4.2). Notably: the SRD calls the compaction field
 * `retainedTail`; the installed format spells the same concept
 * `summary` + `firstKeptEntryId` — the summary replaces everything above
 * `firstKeptEntryId`, and the entries from `firstKeptEntryId` down to the
 * compaction are the retained tail.
 */

import type { Verdict, WorkerState } from "../contracts.ts";
import { LineTooLongError, TailReader, parseLine } from "../util/jsonl.ts";
import {
  ZERO_USAGE,
  combineUsage,
  usageFromAssistantMessage,
  type UsageTotals,
} from "./usage.ts";

// ---------------------------------------------------------------------------
// Entry shapes — structural and tolerant.
//
// These are interfaces plus guards rather than zod schemas on purpose: the
// file is authored by Pi, which adds fields and entry types across minors, and
// a strict schema would turn every Pi upgrade into a harvest outage. Guards
// check only the fields this module dereferences.
// ---------------------------------------------------------------------------

/** First line of the file. Not part of the tree — no `id`/`parentId`. */
export interface SessionHeader {
  type: "session";
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  [k: string]: unknown;
}

/** Every non-header entry: a tree node linked by `id`/`parentId`. */
export interface TreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [k: string]: unknown;
}

export interface AssistantMessage {
  role: "assistant";
  content: unknown;
  model?: string;
  usage?: unknown;
  stopReason?: string;
  errorMessage?: string;
  [k: string]: unknown;
}

export interface MessageEntry extends TreeEntry {
  type: "message";
  message: { role: string; [k: string]: unknown };
}

export interface CompactionEntry extends TreeEntry {
  type: "compaction";
  summary: string;
  /** Entries strictly ABOVE this id are represented only by `summary`. */
  firstKeptEntryId: string;
  tokensBefore?: number;
}

export function isSessionHeader(v: unknown): v is SessionHeader {
  return typeof v === "object" && v !== null && (v as SessionHeader).type === "session";
}

export function isTreeEntry(v: unknown): v is TreeEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as TreeEntry;
  return (
    typeof e.type === "string" &&
    e.type !== "session" &&
    typeof e.id === "string" &&
    (e.parentId === null || typeof e.parentId === "string")
  );
}

export function isMessageEntry(e: TreeEntry): e is MessageEntry {
  return (
    e.type === "message" &&
    typeof (e as MessageEntry).message === "object" &&
    (e as MessageEntry).message !== null &&
    typeof (e as MessageEntry).message.role === "string"
  );
}

export function isAssistantEntry(e: TreeEntry): e is MessageEntry & { message: AssistantMessage } {
  return isMessageEntry(e) && e.message.role === "assistant";
}

export function isCompactionEntry(e: TreeEntry): e is CompactionEntry {
  return (
    e.type === "compaction" &&
    typeof (e as CompactionEntry).summary === "string" &&
    typeof (e as CompactionEntry).firstKeptEntryId === "string"
  );
}

// ---------------------------------------------------------------------------
// Session presence (ISC-95, ISC-96)
// ---------------------------------------------------------------------------

/**
 * Why a transcript may not be readable — the four cases are NOT one case.
 *
 * - `present`: the file exists at the recorded path; harvest away.
 * - `never_created`: the worker died before its first assistant message. The
 *   file is created lazily (SRD §4.2), so its absence here is legitimate, and
 *   `session_present === false` proves the supervisor never saw it either.
 * - `missing_after_present`: `session_present === true` yet the file is gone.
 *   The supervisor once confirmed this exact path existed, so this is a wrong
 *   path recorded or a deleted file — a harvest bug, not a quiet worker.
 * - `unrecorded`: `get_state` never reported a path at all.
 *
 * Collapsing the middle two into "no transcript" is precisely the confusion
 * ISC-96 forbids.
 */
export type SessionPresence =
  | "present"
  | "never_created"
  | "missing_after_present"
  | "unrecorded";

export async function classifySession(
  state: Pick<WorkerState, "session_path" | "session_present">,
): Promise<SessionPresence> {
  // The path is used VERBATIM as `get_state` reported it and state.json
  // recorded it. No globbing, no prefix search: the timestamp prefix is
  // unknowable in advance, and a glob that "finds" a file finds SOME file,
  // not necessarily this worker's (ISC-95).
  if (state.session_path === null) return "unrecorded";
  if (await Bun.file(state.session_path).exists()) return "present";
  return state.session_present ? "missing_after_present" : "never_created";
}

// ---------------------------------------------------------------------------
// TranscriptReader — a resumable entry store over a live session file.
// ---------------------------------------------------------------------------

export class TranscriptReader {
  readonly #tail: TailReader;
  #header: SessionHeader | null = null;
  #entries: TreeEntry[] = [];
  #byId = new Map<string, TreeEntry>();
  /** Lines that were valid JSON but not a recognizable entry, or not JSON at all. */
  #malformed = 0;
  /** Oversized lines dropped by the splitter's cap — the SRD §8.3 truncation marker. */
  #truncated = 0;

  constructor(readonly path: string) {
    this.#tail = new TailReader(path);
  }

  get header(): SessionHeader | null {
    return this.#header;
  }

  /** Entries in file order. The last one is the effective leaf. */
  get entries(): readonly TreeEntry[] {
    return this.#entries;
  }

  get byId(): ReadonlyMap<string, TreeEntry> {
    return this.#byId;
  }

  get malformed(): number {
    return this.#malformed;
  }

  get truncated(): number {
    return this.#truncated;
  }

  /**
   * Read everything appended since the last poll; returns the new entries.
   *
   * A poll that lands mid-write returns only the complete lines and holds the
   * partial one until its terminator arrives (ISC-97) — that is `TailReader`'s
   * contract, not re-implemented here. A file that shrank or was replaced is
   * re-read from 0 by `TailReader` (ISC-100); this store notices the re-read
   * because the re-delivered stream begins with the `SessionHeader` line, and
   * resets rather than appending a second copy of every entry.
   */
  async poll(): Promise<TreeEntry[]> {
    let lines: string[];
    try {
      lines = await this.#tail.poll();
    } catch (err) {
      if (!(err instanceof LineTooLongError)) throw err;
      // The oversized record is gone, but the lines completed before it in
      // the same chunk are valid and must not be lost with it — that is the
      // exact failure LineTooLongError.completed exists to prevent. The
      // splitter has already entered resync, so the rejected record's
      // continuation will be discarded on later polls, not emitted.
      this.#truncated += 1;
      lines = [...err.completed];
    }

    const appended: TreeEntry[] = [];
    for (const line of lines) {
      let rec: unknown;
      try {
        rec = parseLine(line);
      } catch {
        // A malformed COMPLETE line is file corruption, not a torn write —
        // torn writes never reach here because the splitter holds partial
        // lines. Skipping it silently would hide a dropped record; throwing
        // would let one bad line destroy the harvest of every good one. So it
        // is counted, and the count degrades harvest_status to `partial`
        // downstream — loud in the payload, survivable in the read.
        this.#malformed += 1;
        continue;
      }
      if (rec === undefined) continue; // blank line
      if (isSessionHeader(rec)) {
        if (this.#header !== null || this.#entries.length > 0) {
          // A second header can only mean the file was replaced and re-read
          // from offset 0 — a well-formed session file has exactly one, on
          // its first line. Keeping the old entries would duplicate every
          // record the new file re-delivers (ISC-100).
          this.#entries = [];
          this.#byId = new Map();
        }
        this.#header = rec;
        continue;
      }
      if (!isTreeEntry(rec)) {
        this.#malformed += 1;
        continue;
      }
      // Re-delivery of a known id (rewrite without a header on the corrupt
      // path) replaces in place rather than appending a duplicate.
      const known = this.#byId.get(rec.id);
      if (known !== undefined) {
        const idx = this.#entries.indexOf(known);
        if (idx >= 0) this.#entries[idx] = rec;
        this.#byId.set(rec.id, rec);
        continue;
      }
      this.#entries.push(rec);
      this.#byId.set(rec.id, rec);
      appended.push(rec);
    }
    return appended;
  }
}

/** One-shot read of a whole transcript — the CLI's non-tailing path. */
export async function readTranscript(path: string): Promise<TranscriptReader> {
  const reader = new TranscriptReader(path);
  await reader.poll();
  return reader;
}

// ---------------------------------------------------------------------------
// The active path — leaf to root, honouring compaction (SRD §8.2).
// ---------------------------------------------------------------------------

export interface ActivePath {
  /** Root-first. The last element is the leaf. */
  entries: TreeEntry[];
  /**
   * False when a `parentId` named an entry that is not in the file — a
   * truncated or hand-damaged transcript. The walk still returns what it
   * reached; the flag is what stops a partial chain being presented as whole.
   */
  complete: boolean;
}

/**
 * Walk from the effective leaf to the root, then apply the compaction cut.
 *
 * The effective leaf is the last entry in file order: every append chains from
 * the current leaf, so the newest entry IS the current position. Entries on
 * abandoned branches are excluded from the path (they are not what the agent
 * was doing when it died) but deliberately still count toward usage — tokens
 * spent on a branch were still spent (see `reconstruct`).
 *
 * The compaction cut: on the compaction entry nearest the leaf, everything
 * strictly above `firstKeptEntryId` is dropped — those entries are represented
 * only by the compaction's `summary`, exactly as Pi's own
 * `buildSessionContext()` treats them. Ignoring the cut would hand the
 * reconstruction a conversation Pi itself no longer considers part of the
 * session (the SRD's "honouring CompactionEntry.retainedTail").
 */
export function activePath(reader: Pick<TranscriptReader, "entries" | "byId">): ActivePath {
  const all = reader.entries;
  const leaf = all[all.length - 1];
  if (leaf === undefined) return { entries: [], complete: true };

  // Leaf → root, cycle-guarded: a corrupt file with a parent loop must not
  // hang the harvester.
  const up: TreeEntry[] = [];
  const seen = new Set<string>();
  let cur: TreeEntry | undefined = leaf;
  let complete = true;
  while (cur !== undefined) {
    if (seen.has(cur.id)) {
      complete = false;
      break;
    }
    seen.add(cur.id);
    up.push(cur);
    if (cur.parentId === null) break;
    const parent = reader.byId.get(cur.parentId);
    if (parent === undefined) {
      complete = false;
      break;
    }
    cur = parent;
  }

  // Nearest-to-leaf compaction governs; an older compaction inside the kept
  // range simply remains on the path as an entry (its summary is content).
  const coIdx = up.findIndex(isCompactionEntry);
  if (coIdx >= 0) {
    const co = up[coIdx] as CompactionEntry;
    const keptIdx = up.findIndex((e) => e.id === co.firstKeptEntryId);
    if (keptIdx > coIdx) {
      // Drop everything strictly above firstKeptEntryId.
      up.length = keptIdx + 1;
    } else if (keptIdx === -1) {
      // firstKeptEntryId not on the chain: the file was cut under us. Keep
      // what we have, but say so.
      complete = false;
    }
  }

  up.reverse();
  return { entries: up, complete };
}

// ---------------------------------------------------------------------------
// Verdict reconstruction (ISC-91)
// ---------------------------------------------------------------------------

export interface LastAssistant {
  stop_reason: string | null;
  error_message: string | null;
  model: string | null;
  /** First 2000 chars of the message's text blocks — evidence, not payload. */
  text_excerpt: string;
}

export interface Reconstruction {
  verdict: Verdict;
  /** Ordered evidence trail — why the verdict is what it is. */
  reasons: string[];
  /** Assistant messages on the active path. */
  turns: number;
  /** toolCall blocks across assistant messages on the active path. */
  tool_calls: number;
  /** toolResult entries with isError on the active path. */
  tool_errors: number;
  /** Compaction entries in the whole file. */
  compactions: number;
  last_assistant: LastAssistant | null;
  /**
   * Whole-file aggregation, abandoned branches included: usage is spend, and
   * tokens burned on a branch the agent later abandoned were still burned.
   * The ceiling this feeds (ISC-114/115) must never under-count.
   */
  usage: UsageTotals;
  entries_total: number;
  path_complete: boolean;
}

const EXCERPT_CHARS = 2_000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

function toolCallsOf(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "toolCall",
  ).length;
}

/**
 * Rebuild a verdict from the transcript alone (SRD §8.2 path 2, ISC-91).
 *
 * The transcript is authoritative for ATTEMPTS: it can prove the agent was
 * aborted, errored, or died mid-turn, and it can prove a turn completed. It
 * cannot prove the TASK succeeded — that is the repository's to say. So the
 * terminal stop reasons map to terminal verdicts, and every clean-or-ambiguous
 * ending maps to `unknown`, which the adjudication lattice treats as identity:
 * a clean diff and green acceptance commands then carry the verdict, and a
 * missing envelope downgrades nothing (SRD §7.3, ISC-94). Returning `failed`
 * here for a clean stop would invent evidence the transcript does not hold.
 */
export function reconstruct(reader: Pick<TranscriptReader, "entries" | "byId">): Reconstruction {
  const path = activePath(reader);
  const reasons: string[] = [];

  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let last: (MessageEntry & { message: AssistantMessage }) | null = null;
  for (const e of path.entries) {
    if (isAssistantEntry(e)) {
      turns += 1;
      toolCalls += toolCallsOf(e.message.content);
      last = e;
    } else if (isMessageEntry(e) && e.message.role === "toolResult") {
      if ((e.message as { isError?: unknown }).isError === true) toolErrors += 1;
    }
  }

  // Usage folds over EVERY entry in the file, not just the active path.
  let usage: UsageTotals = ZERO_USAGE;
  let compactions = 0;
  for (const e of reader.entries) {
    if (isAssistantEntry(e)) usage = combineUsageAdd(usage, e.message.usage);
    if (isCompactionEntry(e)) compactions += 1;
  }

  if (!path.complete) reasons.push("active_path_incomplete: a parent link is missing or cyclic");

  let verdict: Verdict;
  let lastAssistant: LastAssistant | null = null;
  if (last === null) {
    verdict = "unknown";
    reasons.push("no_assistant_message_on_active_path");
  } else {
    const stop = typeof last.message.stopReason === "string" ? last.message.stopReason : null;
    lastAssistant = {
      stop_reason: stop,
      error_message:
        typeof last.message.errorMessage === "string" ? last.message.errorMessage : null,
      model: typeof last.message.model === "string" ? last.message.model : null,
      text_excerpt: textOf(last.message.content).slice(0, EXCERPT_CHARS),
    };
    switch (stop) {
      case "aborted":
        // Terminal and supervisor-set in the lattice; the transcript is the
        // one artifact that records it when the supervisor died too.
        verdict = "aborted";
        reasons.push("last_assistant_message_aborted");
        break;
      case "error":
        verdict = "failed";
        reasons.push(
          `last_assistant_message_errored: ${lastAssistant.error_message ?? "no message"}`,
        );
        break;
      case "toolUse":
        verdict = "unknown";
        reasons.push("ended_mid_tool_call: a tool was called and no turn followed");
        break;
      case "length":
        verdict = "unknown";
        reasons.push("last_assistant_message_truncated_by_length");
        break;
      default:
        verdict = "unknown";
        reasons.push("turn_completed_without_result_envelope");
        break;
    }
  }

  return {
    verdict,
    reasons,
    turns,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    compactions,
    last_assistant: lastAssistant,
    usage,
    entries_total: reader.entries.length,
    path_complete: path.complete,
  };
}

/** Add one assistant message's usage onto a running total. */
function combineUsageAdd(total: UsageTotals, usage: unknown): UsageTotals {
  const one = usageFromAssistantMessage(usage);
  if (one === null) return total;
  return {
    input_tokens: total.input_tokens + one.input_tokens,
    output_tokens: total.output_tokens + one.output_tokens,
    usd: total.usd + one.usd,
    priced: total.priced || one.priced,
  };
}

// combineUsage is re-exported for callers that merge this module's totals with
// the supervisor's `get_session_stats` numbers (A6) — see harvest/usage.ts for
// why the merge is element-wise max, and for why those numbers do not yet
// exist. Nothing imports it from HERE either: the one caller
// (cli/commands/harvest.ts) takes it straight from harvest/usage.ts, so this
// re-export is currently a convenience with no user.
export { combineUsage };
