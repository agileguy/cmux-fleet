/**
 * A4 transcript harvest (SRD §8.3; ISC-95..100).
 *
 * Every test states the production change that would make it fail. Fixtures
 * are written to real files and read through the production reader — none of
 * these re-implement the splitting or walking they test.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptReader,
  activePath,
  classifySession,
  readTranscript,
  reconstruct,
} from "../../src/harvest/transcript.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pifleet-a4-"));
  dirs.push(d);
  return d;
}

// --- fixture builders ------------------------------------------------------

const TS = "2026-07-27T00:00:00.000Z";

function header(id = "sess-1"): object {
  return { type: "session", version: 3, id, timestamp: TS, cwd: "/workspace" };
}

function user(id: string, parentId: string | null, content: string): object {
  return { type: "message", id, parentId, timestamp: TS, message: { role: "user", content, timestamp: 0 } };
}

const FREE_USAGE = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  id: string,
  parentId: string | null,
  opts: {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
    input?: number;
    output?: number;
    toolCall?: string;
  } = {},
): object {
  const content: object[] = [{ type: "text", text: opts.text ?? "ok" }];
  if (opts.toolCall !== undefined) {
    content.push({ type: "toolCall", id: `c-${id}`, name: opts.toolCall, arguments: {} });
  }
  return {
    type: "message",
    id,
    parentId,
    timestamp: TS,
    message: {
      role: "assistant",
      content,
      api: "openai", provider: "omlx", model: "qwen3",
      usage: { ...FREE_USAGE, input: opts.input ?? 100, output: opts.output ?? 50, totalTokens: 150 },
      stopReason: opts.stopReason ?? "stop",
      ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
      timestamp: 0,
    },
  };
}

function toolResult(id: string, parentId: string | null, isError: boolean): object {
  return {
    type: "message", id, parentId, timestamp: TS,
    message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "out" }], isError, timestamp: 0 },
  };
}

function compaction(id: string, parentId: string, firstKeptEntryId: string): object {
  return { type: "compaction", id, parentId, timestamp: TS, summary: "earlier work summarized", firstKeptEntryId, tokensBefore: 50_000 };
}

function jsonl(...records: object[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

// --- ISC-98: U+2028 inside a JSON string -----------------------------------

describe("line splitting (via TailReader)", () => {
  test("a U+2028 inside a JSON string does not split or drop the record", async () => {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    const content = jsonl(header(), user("aaaa0001", null, "before\u2028after"));
    await writeFile(path, content, "utf8");

    // The fixture must PROVABLY contain the codepoint — a U+2028 test whose
    // fixture holds no U+2028 asserts nothing (the Phase 1 anti-pattern).
    // JSON.stringify emits U+2028 raw, as the UTF-8 bytes E2 80 A8.
    expect(Buffer.from(content, "utf8").includes(Buffer.from([0xe2, 0x80, 0xa8]))).toBe(true);

    // Fails if TranscriptReader stops delegating to TailReader and reads via
    // readline or a \s-class split: U+2028 becomes a line terminator, the
    // record becomes two invalid fragments, and the entry is dropped as
    // malformed instead of parsing whole.
    const reader = await readTranscript(path);
    expect(reader.malformed).toBe(0);
    expect(reader.entries).toHaveLength(1);
    const msg = (reader.entries[0] as unknown as { message: { content: string } }).message;
    expect(msg.content).toBe("before\u2028after");
  });

  // ISC-99
  test("a 4-byte codepoint split across a poll boundary decodes without U+FFFD", async () => {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    const full = Buffer.from(jsonl(header(), user("aaaa0001", null, "ok\u{1F680}done")), "utf8");
    const rocket = Buffer.from("\u{1F680}", "utf8"); // f0 9f 9a 80
    const at = full.indexOf(rocket);
    expect(at).toBeGreaterThan(0);

    // First write ends two bytes INTO the rocket, so the poll watermark lands
    // mid-codepoint — the exact condition ISC-99 names.
    await writeFile(path, full.subarray(0, at + 2));
    const reader = new TranscriptReader(path);
    await reader.poll();
    await appendFile(path, full.subarray(at + 2));
    await reader.poll();

    // Fails if the reader decodes each polled byte slab with its own
    // TextDecoder: both halves become U+FFFD, and the rejoined string STILL
    // parses as valid JSON — there is no error to catch, so only asserting
    // the decoded content catches it.
    expect(reader.entries).toHaveLength(1);
    const content = (reader.entries[0] as unknown as { message: { content: string } }).message
      .content;
    expect(content).toBe("ok\u{1F680}done");
    expect(content).not.toContain("�");
  });

  // ISC-97
  test("a poll landing mid-write returns complete lines and resumes cleanly", async () => {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    const second = JSON.stringify(user("aaaa0002", "aaaa0001", "later"));
    const cut = Math.floor(second.length / 2);
    await writeFile(path, jsonl(header(), user("aaaa0001", null, "first")) + second.slice(0, cut));

    const reader = new TranscriptReader(path);
    // Fails if the reader hands the unterminated tail to JSON.parse (it would
    // count as malformed here) or loses the complete line ahead of it.
    await reader.poll();
    expect(reader.entries).toHaveLength(1);
    expect(reader.malformed).toBe(0);

    await appendFile(path, `${second.slice(cut)}\n`);
    const appended = await reader.poll();
    // Fails if the splitter discarded the buffered half instead of holding
    // it: the record would arrive as an unparseable fragment or not at all.
    expect(appended).toHaveLength(1);
    expect(reader.entries).toHaveLength(2);
    expect(reader.malformed).toBe(0);
  });

  // ISC-100
  test("a wholesale rewrite is re-read from 0 and replaces the store", async () => {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      jsonl(header("sess-old"), user("aaaa0001", null, "old one"), assistant("aaaa0002", "aaaa0001", { text: "old two" })),
    );
    const reader = new TranscriptReader(path);
    await reader.poll();
    expect(reader.entries).toHaveLength(2);

    // Pi rewrites wholesale on load-time migration and session switch: same
    // path, new header, different entries, smaller file.
    await writeFile(path, jsonl(header("sess-new"), user("bbbb0001", null, "new")));
    await reader.poll();

    // Fails if the store appends the re-delivered records instead of
    // resetting on the second SessionHeader (duplicates), or if TailReader
    // resumed from the stale offset (the new entry never seen at all).
    expect(reader.header?.["id"]).toBe("sess-new");
    expect(reader.entries.map((e) => e.id)).toEqual(["bbbb0001"]);
  });

  test("a corrupt complete line is counted, not thrown, and not silently skipped", async () => {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      jsonl(header(), user("aaaa0001", null, "good")) + "{this is not json\n" + jsonl(assistant("aaaa0002", "aaaa0001", {})),
    );
    // Fails in one direction if the reader throws on the corrupt line (one
    // bad record destroys the harvest of every good one) and in the other if
    // it skips without counting (harvest_status could never degrade to
    // partial, and the dropped record would be invisible).
    const reader = await readTranscript(path);
    expect(reader.entries).toHaveLength(2);
    expect(reader.malformed).toBe(1);
  });
});

// --- ISC-95/96: presence classification ------------------------------------

describe("classifySession", () => {
  test("distinguishes died-before-first-message from wrong-path-recorded", async () => {
    const dir = await scratch();
    const present = join(dir, "present.jsonl");
    await writeFile(present, jsonl(header()));
    const absent = join(dir, "never-written.jsonl");

    // Fails if the classifier collapses the absent cases: session_present is
    // the supervisor's record of the absent→present transition, and it is the
    // ONLY thing separating a lazily-never-created file (legitimate) from a
    // file that vanished after being confirmed (a harvest bug) — ISC-96.
    expect(await classifySession({ session_path: present, session_present: true })).toBe("present");
    expect(await classifySession({ session_path: absent, session_present: false })).toBe("never_created");
    expect(await classifySession({ session_path: absent, session_present: true })).toBe("missing_after_present");
    expect(await classifySession({ session_path: null, session_present: false })).toBe("unrecorded");
  });
});

// --- active path and compaction (SRD §8.2) ---------------------------------

describe("activePath", () => {
  test("applies the compaction cut at firstKeptEntryId", async () => {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      jsonl(
        header(),
        user("000000aa", null, "one"),
        assistant("000000ab", "000000aa", {}),
        user("000000ac", "000000ab", "two"),
        assistant("000000ad", "000000ac", {}),
        compaction("000000ae", "000000ad", "000000ac"),
        user("000000af", "000000ae", "three"),
        assistant("000000b0", "000000af", {}),
      ),
    );
    const reader = await readTranscript(path);
    const p = activePath(reader);
    // Fails if the walk ignores firstKeptEntryId (aa/ab would appear — a
    // conversation Pi itself no longer considers part of the session) or
    // walks file order instead of parent links.
    expect(p.entries.map((e) => e.id)).toEqual(["000000ac", "000000ad", "000000ae", "000000af", "000000b0"]);
    expect(p.complete).toBe(true);
  });

  test("follows the newest branch and excludes the abandoned one", async () => {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      jsonl(
        header(),
        user("000000aa", null, "root"),
        assistant("000000ab", "000000aa", { input: 100, output: 50 }),
        // Branch: chains from the ROOT, abandoning ab.
        user("000000ac", "000000aa", "retry"),
        assistant("000000ad", "000000ac", { input: 200, output: 70 }),
      ),
    );
    const reader = await readTranscript(path);
    // Fails if the leaf is chosen as anything but the last entry in file
    // order — the abandoned branch (ab) would leak into the path.
    expect(activePath(reader).entries.map((e) => e.id)).toEqual(["000000aa", "000000ac", "000000ad"]);

    // Usage deliberately covers BOTH branches: tokens spent on an abandoned
    // branch were still spent, and a ceiling fed an active-path-only number
    // under-counts (the ISC-115 axis). Fails if the fold moves to the path.
    const rec = reconstruct(reader);
    expect(rec.usage.input_tokens).toBe(300);
    expect(rec.usage.output_tokens).toBe(120);
  });

  test("a missing parent link is reported, not presented as a whole chain", async () => {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    await writeFile(path, jsonl(header(), user("000000aa", "cafecafe", "orphan")));
    const reader = await readTranscript(path);
    // Fails if the walk silently treats a dangling parentId as the root:
    // a truncated transcript would masquerade as a complete one and
    // harvest_status could never degrade.
    expect(activePath(reader).complete).toBe(false);
  });
});

// --- verdict reconstruction (ISC-91) ---------------------------------------

describe("reconstruct", () => {
  async function readerFor(...records: object[]): Promise<TranscriptReader> {
    const dir = await scratch();
    const path = join(dir, "s.jsonl");
    await writeFile(path, jsonl(header(), ...records));
    return readTranscript(path);
  }

  test("an aborted final turn reconstructs as aborted", async () => {
    const r = await readerFor(
      user("000000aa", null, "go"),
      assistant("000000ab", "000000aa", { stopReason: "aborted" }),
    );
    // Fails if stopReason stops informing the verdict — the transcript is
    // the only artifact that records the abort when the supervisor died too.
    expect(reconstruct(r).verdict).toBe("aborted");
  });

  test("an errored final turn reconstructs as failed, carrying the message", async () => {
    const r = await readerFor(
      user("000000aa", null, "go"),
      assistant("000000ab", "000000aa", { stopReason: "error", errorMessage: "boom" }),
    );
    const rec = reconstruct(r);
    expect(rec.verdict).toBe("failed");
    // Fails if the errorMessage is dropped from the evidence trail.
    expect(rec.reasons.join(" ")).toContain("boom");
  });

  test("a clean stop reconstructs as unknown, never failed", async () => {
    const r = await readerFor(
      user("000000aa", null, "go"),
      assistant("000000ab", "000000aa", { stopReason: "stop", toolCall: "edit" }),
      toolResult("000000ac", "000000ab", false),
      assistant("000000ad", "000000ac", { stopReason: "stop", text: "done" }),
    );
    const rec = reconstruct(r);
    // Fails if a clean transcript ending maps to failed (inventing evidence)
    // or to success (the transcript cannot prove the TASK succeeded): unknown
    // is the lattice identity, so a clean diff plus green acceptance carries
    // the verdict and a missing envelope downgrades nothing (ISC-94).
    expect(rec.verdict).toBe("unknown");
    expect(rec.reasons.join(" ")).toContain("without_result_envelope");
    expect(rec.turns).toBe(2);
    expect(rec.tool_calls).toBe(1);
    expect(rec.last_assistant?.text_excerpt).toBe("done");
  });

  test("dying mid-tool-call is evidence, not silence", async () => {
    const r = await readerFor(
      user("000000aa", null, "go"),
      assistant("000000ab", "000000aa", { stopReason: "toolUse", toolCall: "bash" }),
    );
    const rec = reconstruct(r);
    expect(rec.verdict).toBe("unknown");
    // Fails if the trailing toolUse stop is folded into the generic clean
    // case — "died mid-turn" and "finished a turn" are different facts.
    expect(rec.reasons.join(" ")).toContain("ended_mid_tool_call");
  });

  test("a transcript with no assistant message says so", async () => {
    const r = await readerFor(user("000000aa", null, "go"));
    const rec = reconstruct(r);
    expect(rec.verdict).toBe("unknown");
    expect(rec.reasons.join(" ")).toContain("no_assistant_message");
    expect(rec.last_assistant).toBeNull();
  });

  test("tool errors on the active path are counted", async () => {
    const r = await readerFor(
      user("000000aa", null, "go"),
      assistant("000000ab", "000000aa", { stopReason: "toolUse", toolCall: "bash" }),
      toolResult("000000ac", "000000ab", true),
      assistant("000000ad", "000000ac", { stopReason: "stop" }),
    );
    // Fails if isError stops being read — the adjudicator uses the count as a
    // signal that a "clean" transcript spent its time failing.
    expect(reconstruct(r).tool_errors).toBe(1);
  });
});
