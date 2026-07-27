import { describe, expect, test } from "bun:test";
import {
  LineSplitter,
  LineTooLongError,
  MAX_LINE_UNITS,
  parseLine,
  readJsonl,
  writeJsonAtomic,
  TailReader,
} from "../../src/util/jsonl.ts";
import { mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enc = new TextEncoder();

describe("LineSplitter", () => {
  test("splits on \\n and strips a trailing \\r", () => {
    const s = new LineSplitter();
    expect(s.push(enc.encode("a\r\nb\n"))).toEqual(["a", "b"]);
  });

  test("holds a partial line until its terminator arrives", () => {
    const s = new LineSplitter();
    expect(s.push(enc.encode('{"a":1'))).toEqual([]);
    expect(s.push(enc.encode("}\n"))).toEqual(['{"a":1}']);
  });

  // ISC-98: U+2028 is legal inside a JSON string. readline would split here.
  test("does not split on U+2028 or U+2029", () => {
    const payload = JSON.stringify({ text: "before after end" });
    const s = new LineSplitter();
    const lines = s.push(enc.encode(`${payload}\n`));
    expect(lines).toHaveLength(1);
    expect(parseLine<{ text: string }>(lines[0]!)!.text).toBe("before after end");
  });

  // ISC-99: a 4-byte codepoint split across a chunk boundary must not corrupt.
  test("reassembles a 4-byte codepoint split across chunks", () => {
    const bytes = enc.encode('{"e":"\u{1F600}"}\n');
    const cut = 8; // lands inside the emoji's UTF-8 sequence
    const s = new LineSplitter();
    expect(s.push(bytes.slice(0, cut))).toEqual([]);
    const lines = s.push(bytes.slice(cut));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("�");
    expect(parseLine<{ e: string }>(lines[0]!)!.e).toBe("\u{1F600}");
  });

  test("flush returns a trailing unterminated line exactly once", () => {
    const s = new LineSplitter();
    s.push(enc.encode("tail"));
    expect(s.flush()).toEqual(["tail"]);
    expect(s.flush()).toEqual([]);
  });
});

describe("parseLine", () => {
  test("returns undefined for blank and whitespace-only lines", () => {
    expect(parseLine("")).toBeUndefined();
    expect(parseLine("   ")).toBeUndefined();
  });

  test("throws on malformed JSON rather than dropping the record", () => {
    expect(() => parseLine("{not json")).toThrow();
  });
});

describe("readJsonl", () => {
  test("yields every record across arbitrary chunk boundaries", async () => {
    const src = '{"n":1}\n{"n":2}\n{"n":3}';
    async function* chunks() {
      const b = enc.encode(src);
      for (let i = 0; i < b.length; i += 3) yield b.slice(i, i + 3);
    }
    const got: { n: number }[] = [];
    for await (const r of readJsonl<{ n: number }>(chunks())) got.push(r);
    expect(got.map((r) => r.n)).toEqual([1, 2, 3]);
  });
});

describe("writeJsonAtomic", () => {
  test("writes valid JSON and leaves no tmp file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-"));
    try {
      const p = join(dir, "nested", "state.json");
      await writeJsonAtomic(p, { schema: "pifleet.state/v1", worker: "eng-1" });
      expect(JSON.parse(await readFile(p, "utf8")).worker).toBe("eng-1");
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(join(dir, "nested"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TailReader", () => {
  test("reads only what was appended since the previous poll", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-"));
    try {
      const p = join(dir, "session.jsonl");
      await writeFile(p, '{"n":1}\n');
      const r = new TailReader(p);
      expect(await r.pollRecords<{ n: number }>()).toEqual([{ n: 1 }]);
      expect(await r.pollRecords()).toEqual([]);
      await appendFile(p, '{"n":2}\n');
      expect(await r.pollRecords<{ n: number }>()).toEqual([{ n: 2 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ISC-97: a poll landing mid-write resumes on the next poll.
  test("resumes a record split across two polls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-"));
    try {
      const p = join(dir, "session.jsonl");
      await writeFile(p, '{"half":');
      const r = new TailReader(p);
      expect(await r.pollRecords()).toEqual([]);
      await appendFile(p, "true}\n");
      expect(await r.pollRecords<{ half: boolean }>()).toEqual([{ half: true }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ISC-100: a file that shrinks is re-read from offset 0.
  test("restarts from zero when the file shrinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-"));
    try {
      const p = join(dir, "session.jsonl");
      await writeFile(p, '{"n":1}\n{"n":2}\n');
      const r = new TailReader(p);
      expect(await r.pollRecords()).toHaveLength(2);
      await writeFile(p, '{"n":9}\n');
      expect(await r.pollRecords<{ n: number }>()).toEqual([{ n: 9 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns nothing for a file that does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-"));
    try {
      expect(await new TailReader(join(dir, "absent.jsonl")).poll()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Round-2 review: the oversized-line path was destroying good records.
 */
describe("LineTooLongError carries what was already complete", () => {
  test("an oversized line does not destroy the records before it", () => {
    const s = new LineSplitter();
    const huge = "x".repeat(MAX_LINE_UNITS + 10);
    const chunk = new TextEncoder().encode(`{"a":1}\n{"b":2}\n${huge}\n{"c":3}\n`);
    try {
      s.push(chunk);
      throw new Error("expected LineTooLongError");
    } catch (err) {
      expect(err).toBeInstanceOf(LineTooLongError);
      // Previously `[]` — every record before the huge one was silently lost.
      expect((err as LineTooLongError).completed).toEqual(['{"a":1}', '{"b":2}']);
    }
  });

  /**
   * The residue is an UNTERMINATED line, so the bytes that follow it are the
   * continuation of the record just rejected — not a new one.
   *
   * A first version simply cleared the buffer, which made the next "complete
   * line" a tail fragment of the oversized record, handed to the caller as if
   * valid. That is exactly the corruption the TailReader identity fix exists to
   * prevent, reintroduced one layer down. The splitter must resync to the next
   * newline, not to the next push.
   */
  test("after dropping an oversized residue, the continuation is discarded too", () => {
    const s = new LineSplitter();
    const enc = new TextEncoder();
    expect(() => s.push(enc.encode(`{"huge":"${"y".repeat(MAX_LINE_UNITS)}`))).toThrow(
      LineTooLongError,
    );
    // These bytes are the TAIL of the rejected record, then a real one.
    expect(s.push(enc.encode('rest-of-the-huge-record"}\n{"ok":1}\n'))).toEqual(['{"ok":1}']);
  });

  test("resync spanning several pushes never emits a fragment", () => {
    const s = new LineSplitter();
    const enc = new TextEncoder();
    expect(() => s.push(enc.encode("y".repeat(MAX_LINE_UNITS + 5)))).toThrow(LineTooLongError);
    expect(s.push(enc.encode("still-inside-the-rejected-record"))).toEqual([]);
    expect(s.push(enc.encode("and-still-inside"))).toEqual([]);
    expect(s.push(enc.encode('\n{"ok":1}\n'))).toEqual(['{"ok":1}']);
  });

  test("the splitter is usable again afterwards, not wedged", () => {
    const s = new LineSplitter();
    const enc = new TextEncoder();
    expect(() => s.push(enc.encode("y".repeat(MAX_LINE_UNITS + 5)))).toThrow(LineTooLongError);
    s.push(enc.encode("\n")); // close the rejected record
    expect(s.push(enc.encode('{"a":1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });
});
