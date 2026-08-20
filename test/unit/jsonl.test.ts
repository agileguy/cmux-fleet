import { describe, expect, test } from "bun:test";
import {
  appendJsonl,
  fsyncDirBestEffort,
  LineSplitter,
  LineTooLongError,
  MAX_LINE_UNITS,
  parseLine,
  readJsonl,
  writeJsonAtomic,
  TailReader,
} from "../../src/util/jsonl.ts";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
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
      expect((await readdir(join(dir, "nested"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * ISC-218: the directory fsync runs AFTER the rename, so its failure must not
 * be reported as the write having failed.
 *
 * This was a live defect, not a hypothetical. Only `dh.sync()` was guarded;
 * `open(dir, "r")` was not, and that call needs READ permission on the
 * directory while writing and renaming inside it need only write+search. So a
 * `0o300` directory let every durable step succeed — tmp written, fsynced,
 * renamed into place — and then threw `EACCES: permission denied, open
 * '<dir>'` out of `writeJsonAtomic`, with the correct file sitting on disk.
 * Callers of a "failed" durable write retry it, mark a worker broken, or
 * unwind a state machine; every one of those is worse than losing the
 * directory entry's crash-durability, which is all that is actually at risk
 * once the rename has returned.
 */
describe("writeJsonAtomic reports a landed write as landed (ISC-218)", () => {
  /**
   * The `open` failure, isolated and reachable on any uid.
   *
   * A directory that does not exist cannot be opened by root either, so this
   * probe does not depend on the permission model the end-to-end case below
   * does. It fails the moment the helper stops swallowing — which is the whole
   * guarantee, stated as one call.
   */
  test("fsyncDirBestEffort resolves when the directory cannot be opened at all", async () => {
    const gone = join(tmpdir(), `pifleet-absent-${process.pid.toString(36)}-${Date.now().toString(36)}`);
    expect(await Bun.file(join(gone, "x")).exists()).toBe(false);
    // Resolving is the assertion. `.resolves` rather than a bare await so a
    // rejection is reported as this expectation failing, not as the test
    // throwing from an unrelated line.
    await expect(fsyncDirBestEffort(gone)).resolves.toBeUndefined();
  });

  /**
   * The end-to-end case, through the real code path a caller uses.
   *
   * Requires a non-root uid to be meaningful, and says so rather than skipping:
   * a `0o300` directory does not stop root from reading it, so under uid 0 the
   * precondition below fails loudly instead of the probe passing having proved
   * nothing. CI's `test` job runs as the unprivileged `runner` account.
   */
  test("an unreadable containing directory does not fail the write", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-nordir-"));
    const dir = join(base, "run");
    try {
      await mkdir(dir, { recursive: true });
      // write + search, deliberately NOT read: enough to create, fsync and
      // rename the temp file, not enough to open the directory itself.
      await chmod(dir, 0o300);
      await expect(readdir(dir)).rejects.toThrow(/EACCES/);

      const p = join(dir, "state.json");
      await expect(
        writeJsonAtomic(p, { schema: "pifleet.state/v1", worker: "eng-1" }),
      ).resolves.toBeUndefined();

      // And the write it reported as succeeding really did: the durable steps
      // all ran, which is why reporting failure was wrong in the first place.
      await chmod(dir, 0o700);
      expect(JSON.parse(await readFile(p, "utf8")).worker).toBe("eng-1");
      expect((await readdir(dir)).filter((f) => f.includes(".tmp-"))).toEqual([]);
    } finally {
      await chmod(dir, 0o700).catch(() => {});
      await rm(base, { recursive: true, force: true });
    }
  });
});

/**
 * ISC-156, one case per syscall boundary of the atomic-write path.
 *
 * `writeJsonAtomic` is five ordered steps — open, write, fsync, rename,
 * directory fsync — and the claim it makes is per-step: everything up to the
 * rename must leave the PREVIOUS value whole, everything from the rename on
 * must leave the NEW one whole, and no kill anywhere may leave a half of
 * either. One kill at an unnamed instant tests one of those five and cannot
 * say which; `test/fixtures/kill-at-boundary.ts` makes the process kill
 * ITSELF the moment a named step returns, and the trace it leaves proves
 * which step that was.
 *
 * The two values are deliberately different lengths, with the new one SHORTER.
 * An implementation that wrote in place — the failure this protocol exists to
 * prevent — would leave the previous value's tail behind the new one, and the
 * survivor would not be parseable JSON at all. Equal-length payloads would let
 * that pass.
 */
describe("writeJsonAtomic survives a SIGKILL at every syscall boundary (ISC-156)", () => {
  const FIXTURE = new URL("../fixtures/kill-at-boundary.ts", import.meta.url).pathname;
  const JSONL = new URL("../../src/util/jsonl.ts", import.meta.url).pathname;

  const PREVIOUS = {
    schema: "pifleet.state/v1",
    worker: "eng-1",
    generation: 1,
    // Padding so the previous value is much longer than the next one.
    note: "the version already on disk when the writer was killed".repeat(8),
  };
  const NEXT = { schema: "pifleet.state/v1", worker: "eng-1", generation: 2 };
  const THIRD = { schema: "pifleet.state/v1", worker: "eng-1", generation: 3 };

  /**
   * Every boundary, the trace it must produce, and which value must survive.
   *
   * The trace is exact, not a prefix match: a kill at `write` that actually
   * landed at `fsync` leaves an identical filesystem — previous value intact,
   * full temp file beside it — so only the step list distinguishes them.
   */
  interface BoundaryCase {
    boundary: string;
    survivor: object;
    steps: string[];
  }
  const CASES: BoundaryCase[] = [
    { boundary: "open", survivor: PREVIOUS, steps: ["open"] },
    { boundary: "write", survivor: PREVIOUS, steps: ["open", "write"] },
    { boundary: "fsync", survivor: PREVIOUS, steps: ["open", "write", "fsync"] },
    { boundary: "rename", survivor: NEXT, steps: ["open", "write", "fsync", "rename"] },
    {
      boundary: "dirfsync",
      survivor: NEXT,
      steps: ["open", "write", "fsync", "rename", "diropen", "dirfsync"],
    },
  ];

  for (const { boundary, survivor, steps } of CASES) {
    test(
      `killed at ${boundary}: the surviving state.json is whole and a later write still lands`,
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "pifleet-kill-"));
        try {
          const target = join(dir, "state.json");
          const trace = join(dir, "trace.tsv");
          await writeJsonAtomic(target, PREVIOUS);

          const writerCode = [
            `const { writeJsonAtomic } = await import(${JSON.stringify(JSONL)});`,
            `await writeJsonAtomic(${JSON.stringify(target)}, ${JSON.stringify(NEXT)});`,
            `console.log("SURVIVED");`,
          ].join("\n");
          const writer = Bun.spawn([process.execPath, "--preload", FIXTURE, "-e", writerCode], {
            env: {
              ...process.env,
              PIFLEET_TEST_KILL_AT: boundary,
              PIFLEET_TEST_KILL_PATH: target,
              PIFLEET_TEST_KILL_TRACE: trace,
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = await new Response(writer.stdout).text();
          // 128 + SIGKILL. A writer that reached the end of `writeJsonAtomic`
          // exits 0 and prints SURVIVED — which would mean the boundary was
          // never reached and every assertion below is about nothing.
          expect(await writer.exited).toBe(137);
          expect(stdout).not.toContain("SURVIVED");

          // The kill landed exactly here, and nowhere later.
          const traced = (await readFile(trace, "utf8"))
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => l.split("\t"));
          expect(traced.map((r) => r[0])).toEqual(steps);
          for (const row of traced) expect(row[1]).toBe(target);

          // THE claim: a complete version, never a mixture of the two.
          expect(JSON.parse(await readFile(target, "utf8"))).toEqual(survivor);

          // Before the rename the temp file is orphaned — SIGKILL runs no
          // cleanup, by construction — and after it there is nothing to orphan.
          const orphans = (await readdir(dir)).filter((f) => f.includes(".tmp-"));
          expect(orphans).toHaveLength(survivor === PREVIOUS ? 1 : 0);

          // And the orphan is inert. The temp name carries a per-call UUID, so
          // the next writer cannot collide with a dead one's leftovers — the
          // property that keeps a crash-loop from wedging the run directory.
          await writeJsonAtomic(target, THIRD);
          expect(JSON.parse(await readFile(target, "utf8"))).toEqual(THIRD);
          expect((await readdir(dir)).filter((f) => f.includes(".tmp-"))).toEqual(orphans);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      20_000,
    );
  }
});

/**
 * ISC-156's other half: "…and the ledger readable".
 *
 * The ledger does not go through `writeJsonAtomic` at all — `appendJsonl` opens
 * the file O_APPEND and writes one line — so none of the five boundaries above
 * touch it, and the criterion's second clause had no test behind it once the
 * old stochastic one was deleted. That test at least killed a process that was
 * appending; these kill AT an append, which is the same proof without the
 * coin flip.
 *
 * The claim is per-record, not per-file: a killed writer may lose the record it
 * was about to write, but must never leave a partial one, because half a JSONL
 * line is not a smaller ledger — it is an unreadable one, and `mergeLedger`
 * reports it as a corrupt shard for the whole run.
 */
describe("appendJsonl leaves the ledger readable across a SIGKILL (ISC-156)", () => {
  const FIXTURE = new URL("../fixtures/kill-at-boundary.ts", import.meta.url).pathname;
  const JSONL = new URL("../../src/util/jsonl.ts", import.meta.url).pathname;

  test(
    "a kill at an append boundary truncates at a record edge, never inside one",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pifleet-kill-"));
      try {
        const ledger = join(dir, "ledger", "eng-1.jsonl");
        const trace = join(dir, "trace.tsv");

        // Records of deliberately DIFFERENT lengths. Equal-length records would
        // let a writer that tore a line mid-record still produce a file that
        // happened to split cleanly on the newline it did write.
        const writerCode = [
          `const { appendJsonl } = await import(${JSON.stringify(JSONL)});`,
          `for (let i = 1; i <= 6; i++) {`,
          `  await appendJsonl(${JSON.stringify(ledger)}, { seq: i, pad: "x".repeat(i * 40) });`,
          `}`,
          `console.log("SURVIVED");`,
        ].join("\n");
        const writer = Bun.spawn([process.execPath, "--preload", FIXTURE, "-e", writerCode], {
          env: {
            ...process.env,
            PIFLEET_TEST_KILL_AT: "append",
            PIFLEET_TEST_KILL_PATH: ledger,
            PIFLEET_TEST_KILL_TRACE: trace,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(writer.stdout).text();
        expect(await writer.exited).toBe(137);
        expect(stdout).not.toContain("SURVIVED");

        // The fixture arms on the FIRST append to this path, so exactly one
        // record was written and the kill fired the instant it landed.
        const traced = (await readFile(trace, "utf8"))
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => l.split("\t"));
        expect(traced.map((r) => r[0])).toEqual(["append"]);
        expect(traced[0]?.[1]).toBe(ledger);

        // THE claim: every line the crash left behind parses. A torn record
        // would throw here — which is precisely how `mergeLedger` would report
        // it, one layer up.
        const text = await readFile(ledger, "utf8");
        const lines = text.split("\n").filter((l) => l !== "");
        const records = lines.map((l) => parseLine<{ seq: number; pad: string }>(l)!);
        expect(records.map((r) => r.seq)).toEqual([1]);
        // Whole, not merely parseable: a short write would still be valid JSON
        // if it cut inside `pad`'s quotes only by luck.
        expect(records[0]!.pad).toBe("x".repeat(40));
        // And the file ends ON the record boundary — no partial tail.
        expect(text.endsWith("\n")).toBe(true);

        // The ledger is still APPENDABLE, not merely readable. A crash must
        // not leave a shard that the next writer extends into garbage.
        await appendJsonl(ledger, { seq: 99, pad: "after-the-crash" });
        const after = (await readFile(ledger, "utf8")).split("\n").filter((l) => l !== "");
        expect(after.map((l) => parseLine<{ seq: number }>(l)!.seq)).toEqual([1, 99]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );
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
