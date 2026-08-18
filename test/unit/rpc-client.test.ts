/**
 * RPC client framing, correlation and stream sequencing — plus the static
 * anti-criteria (ISC-137/138) and hostile-input tests for the shared
 * primitives the client is built on.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RpcClient,
  RpcClosedError,
  RpcProtocolError,
  RpcTimeoutError,
  Stopwatch,
  type SentResponse,
} from "../../src/rpc/client.ts";
import type { RpcEvent, RpcResponse } from "../../src/contracts.ts";
import { LineSplitter, LineTooLongError, MAX_LINE_UNITS, TailReader } from "../../src/util/jsonl.ts";

interface Harness {
  client: RpcClient;
  written: string[];
  events: Array<{ event: RpcEvent; seq: number }>;
  strays: Array<{ response: RpcResponse; seq: number; kind: "late" | "unknown" }>;
  protocolErrors: RpcProtocolError[];
}

function harness(opts: { defaultTimeoutMs?: number } = {}): Harness {
  const written: string[] = [];
  const events: Harness["events"] = [];
  const strays: Harness["strays"] = [];
  const protocolErrors: RpcProtocolError[] = [];
  const client = new RpcClient(
    { write: (s) => written.push(s) },
    {
      onEvent: (event, seq) => events.push({ event, seq }),
      onStray: (response, seq, kind) => strays.push({ response, seq, kind }),
      onProtocolError: (err) => protocolErrors.push(err),
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 1_000,
    },
  );
  return { client, written, events, strays, protocolErrors };
}

const enc = new TextEncoder();

describe("RpcClient — framing", () => {
  test("events and responses share one monotonic stream seq", async () => {
    const h = harness();
    h.client.feedText('{"type":"agent_start"}\n');
    const p = h.client.send("get_state");
    h.client.feedText('{"type":"turn_start"}\n');
    h.client.feedText(
      '{"id":"rpc-1","type":"response","command":"get_state","success":true,"data":{}}\n',
    );
    const sent = await p;

    expect(h.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(sent.seq).toBe(3); // the response occupies a stream position too
    expect(h.client.lastSeq).toBe(3);
  });

  test("U+2028 inside a JSON string survives framing intact", () => {
    // The reason `readline` is banned (SRD §8.3): it splits on U+2028/U+2029,
    // which are legal inside JSON strings, silently dropping the record.
    const h = harness();
    const text = `before after`;
    h.client.feed(enc.encode(`{"type":"note","text":${JSON.stringify(text)}}\n`));
    expect(h.events).toHaveLength(1);
    expect((h.events[0]!.event as { text?: string }).text).toBe(text);
  });

  test("a 4-byte codepoint split at EVERY chunk offset decodes without U+FFFD", () => {
    // The rejoined mojibake would still parse as valid JSON — there is no
    // error to catch downstream, so the framing layer must never produce it.
    const payload = `{"type":"note","text":"ab\u{1F600}cd"}\n`;
    const bytes = enc.encode(payload);
    for (let cut = 1; cut < bytes.length; cut++) {
      const h = harness();
      h.client.feed(bytes.slice(0, cut));
      h.client.feed(bytes.slice(cut));
      expect(h.events).toHaveLength(1);
      const text = (h.events[0]!.event as { text?: string }).text;
      expect(text).toBe("ab\u{1F600}cd");
      expect(text).not.toContain("�");
    }
  });

  test("blank lines are not records and consume no seq", () => {
    const h = harness();
    h.client.feedText('\n\n{"type":"agent_start"}\n\n');
    expect(h.events).toEqual([{ event: { type: "agent_start" }, seq: 1 }]);
  });
});

describe("RpcClient — correlation", () => {
  test("a response resolves its pending request, success:false included", async () => {
    // success:false must RESOLVE, not reject: the caller inspects it, and a
    // rejected promise would lose the response body and its seq.
    const h = harness();
    const p = h.client.send("prompt", { message: "go" });
    const req = JSON.parse(h.written[0]!) as { id: string; type: string; message: string };
    expect(req.type).toBe("prompt");
    expect(req.message).toBe("go");

    h.client.feedText(
      `{"id":${JSON.stringify(req.id)},"type":"response","command":"prompt","success":false,"error":"nope"}\n`,
    );
    const sent: SentResponse = await p;
    expect(sent.response.success).toBe(false);
    expect(sent.response.error).toBe("nope");
  });

  test("a second response with the same id is delivered as a LATE stray (ISC-86)", async () => {
    // `prompt` acks immediately and can fail later with the SAME id. Dropping
    // that second response would leave a doomed epoch reporting accepted.
    const h = harness();
    const p = h.client.send("prompt", { message: "go" });
    const req = JSON.parse(h.written[0]!) as { id: string };
    h.client.feedText(
      `{"id":${JSON.stringify(req.id)},"type":"response","command":"prompt","success":true,"data":{}}\n`,
    );
    await p;
    h.client.feedText(
      `{"id":${JSON.stringify(req.id)},"type":"response","command":"prompt","success":false,"error":"model exploded"}\n`,
    );
    expect(h.strays).toHaveLength(1);
    expect(h.strays[0]!.kind).toBe("late");
    expect(h.strays[0]!.response.success).toBe(false);
  });

  test("a response arriving after the client-side timeout is a LATE stray", async () => {
    // scenarios/late-response.json in miniature: timeout fires, then the
    // answer shows up. It must be attributable, not mistaken for hostile.
    const h = harness({ defaultTimeoutMs: 10 });
    const p = h.client.send("get_state");
    expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
    await p.catch(() => {});
    h.client.feedText(
      '{"id":"rpc-1","type":"response","command":"get_state","success":true,"data":{}}\n',
    );
    expect(h.strays).toHaveLength(1);
    expect(h.strays[0]!.kind).toBe("late");
  });

  test("a response with an id that was never ours is an UNKNOWN stray", () => {
    // scenarios/bad-correlation.json in miniature.
    const h = harness();
    h.client.feedText(
      '{"id":"who-9","type":"response","command":"prompt","success":true,"data":{}}\n',
    );
    expect(h.strays).toHaveLength(1);
    expect(h.strays[0]!.kind).toBe("unknown");
  });
});

describe("RpcClient — stream death", () => {
  test("EOF mid-line: the partial line is NOT a record and pendings reject", async () => {
    // scenarios/truncated.json in miniature: the stream dies mid-JSON-line. A
    // live transcript's trailing partial line is an incomplete write, never a
    // message — flushing it into one would fabricate an event.
    const h = harness();
    const p = h.client.send("get_state");
    h.client.feedText('{"type":"agent_end","willRe'); // no terminator
    h.client.feedEof();
    expect(h.events).toHaveLength(0);
    expect(p).rejects.toBeInstanceOf(RpcClosedError);
    await p.catch(() => {});
  });

  test("one malformed record kills the stream — pinned, not accidental", async () => {
    // A skipped record in a control stream is indistinguishable from an event
    // that never happened; better a dead worker than a false settle.
    const h = harness();
    const p = h.client.send("get_state");
    h.client.feedText("{this is not json}\n");
    expect(h.protocolErrors).toHaveLength(1);
    expect(p).rejects.toBeInstanceOf(RpcClosedError);
    await p.catch(() => {});
    // And the client stays closed: further sends reject immediately.
    expect(h.client.send("get_state")).rejects.toBeInstanceOf(RpcClosedError);
  });

  test("send after close rejects without writing", async () => {
    const h = harness();
    h.client.close("test");
    await expect(h.client.send("abort")).rejects.toBeInstanceOf(RpcClosedError);
    expect(h.written).toHaveLength(0);
  });

  /**
   * ISC-214. "One malformed record kills the stream" held only until the next
   * newline in the SAME write. `#fatal()` closes the client, but the chunk's
   * lines had already been taken off the splitter, and the loop kept handing
   * them to `#handleLine` — so a stream this client had declared dead went on
   * dispatching events, advancing the stream seq the epoch fence is built on.
   *
   * Both entry points are driven: `feed()` is the production path and
   * `feedText()` is the one every test uses, and the guard has to sit on the
   * loop they share or one of them regresses alone.
   */
  test("a fatal error stops the rest of the SAME chunk (ISC-214)", () => {
    const chunk = '{"type":"a"}\n{this is not json}\n{"type":"c"}\n{"type":"d"}\n';
    for (const entry of ["feed", "feedText"] as const) {
      const h = harness();
      if (entry === "feed") h.client.feed(enc.encode(chunk));
      else h.client.feedText(chunk);

      expect(h.protocolErrors, entry).toHaveLength(1);
      // Line 1 was dispatched before the fatal; lines 3 and 4 never are.
      expect(h.events.map((e) => (e.event as { type: string }).type), entry).toEqual(["a"]);
      // And they consume no seq either: a record dispatched after the close
      // would move the fence post every epoch attribution is measured against.
      expect(h.client.lastSeq, entry).toBe(1);
    }
  });
});

/**
 * ISC-215. The EPIPE path emptied the pending map and returned an
 * `RpcClosedError` while leaving `#closed` null — an error asserting a state
 * the object was not in. The client went on accepting feeds and went on
 * writing to a pipe that had already thrown, so every later `send()` paid
 * another EPIPE instead of failing fast on a fact already established.
 */
describe("RpcClient — a failed write closes the client (ISC-215)", () => {
  function brokenPipe(afterWrites: number): {
    sink: { write(data: string): void };
    attempts: () => number;
  } {
    let attempts = 0;
    return {
      sink: {
        write(): void {
          attempts++;
          if (attempts > afterWrites) {
            throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
          }
        },
      },
      attempts: () => attempts,
    };
  }

  test("the client reports itself closed after an EPIPE", async () => {
    const events: Array<{ event: RpcEvent; seq: number }> = [];
    const pipe = brokenPipe(0);
    const client = new RpcClient(pipe.sink, { onEvent: (event, seq) => events.push({ event, seq }) });

    await expect(client.send("prompt", { message: "go" })).rejects.toBeInstanceOf(RpcClosedError);
    expect(pipe.attempts()).toBe(1);

    // Closed: the next send fails fast rather than re-throwing off the dead pipe.
    await expect(client.send("abort")).rejects.toBeInstanceOf(RpcClosedError);
    expect(pipe.attempts()).toBe(1);

    // Closed on the read side too — the same fact governs both directions.
    client.feedText('{"type":"agent_start"}\n');
    expect(events).toHaveLength(0);
    expect(client.lastSeq).toBe(0);
  });

  test("requests already in flight reject; none are left pending", async () => {
    // The pipe breaks between two sends. The first one's response can never
    // arrive, so leaving it pending would hold a timer — and a rejection
    // nobody is waiting on yet — against a stream that is gone.
    const pipe = brokenPipe(1);
    const client = new RpcClient(pipe.sink, { onEvent: () => {} });

    const inFlight = client.send("get_state");
    await expect(client.send("prompt", { message: "go" })).rejects.toBeInstanceOf(RpcClosedError);
    await expect(inFlight).rejects.toBeInstanceOf(RpcClosedError);
    expect(client.pendingCount).toBe(0);
  });
});

describe("Stopwatch — monotonic time only", () => {
  test("elapsed time follows the injected monotonic clock, never wall time", () => {
    // Deadlines must survive host sleep and NTP steps: Date.now() can jump
    // hours in either direction; the monotonic clock cannot.
    let mono = 1_000;
    const sw = new Stopwatch(() => mono);
    expect(sw.elapsedMs()).toBe(0);
    mono += 250; // 250ms of real time passes...
    // ...while the wall clock jumps a day (irrelevant — we never read it).
    expect(sw.elapsedMs()).toBe(250);
    sw.restart();
    expect(sw.elapsedMs()).toBe(0);
    mono += 10;
    expect(sw.elapsedMs()).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Shared-primitive hostile-input tests (the primitives live in util/jsonl.ts;
// the RPC transport is their most demanding consumer).
// ---------------------------------------------------------------------------

describe("LineSplitter — hostile input", () => {
  test("a stream using lone \\r as terminator hits the length guard, not OOM", () => {
    // We split on \n only (correct per SRD §8.3), so a CR-terminated log
    // becomes one ever-growing line. The guard must convert that into a
    // typed error while the buffer is still bounded.
    const splitter = new LineSplitter();
    const chunk = "x".repeat(1024 * 1024) + "\r";
    let threw: unknown = null;
    try {
      // 9 MiB of CR-terminated data > MAX_LINE_UNITS (8 MiB).
      for (let i = 0; i < 9; i++) splitter.pushText(chunk);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(LineTooLongError);
    expect((threw as LineTooLongError).units).toBeLessThan(MAX_LINE_UNITS * 2);
  });

  test("invalid UTF-8 bytes decode to U+FFFD and the record is rejected, not mangled", () => {
    // Pinned policy: a line containing undecodable bytes must not survive as a
    // silently-corrupted record. U+FFFD inside what should be JSON structure
    // fails the parse, and the client layer treats that as fatal (tested
    // above); here we pin the primitive-level behaviour.
    const splitter = new LineSplitter();
    const bad = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d, 0x0a]); // {"<bad>":1}\n
    const lines = splitter.push(bad);
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toContain("�");
  });
});

describe("TailReader — rotation identity", () => {
  test("shrink is detected by size and the reader restarts from zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-tail-"));
    try {
      const p = join(dir, "t.jsonl");
      const reader = new TailReader(p);
      await writeFile(p, '{"a":1}\n{"a":2}\n');
      expect(await reader.poll()).toEqual(['{"a":1}', '{"a":2}']);
      await writeFile(p, '{"b":1}\n'); // truncate-and-replace, smaller
      expect(await reader.poll()).toEqual(['{"b":1}']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * ISC-173. The fix shipped identity tracking, but the test that would prove
   * it stayed `test.todo` and the comment above it still described the bug as
   * open — so reverting `util/jsonl.ts` wholesale left the suite green.
   *
   * This is the case size alone cannot see: replaced and regrown PAST the old
   * offset within one poll interval, which is byte-for-byte indistinguishable
   * from an append unless the reader tracks file identity.
   */
  test("replace-and-regrow past the old offset within one poll is re-read from 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-tail-"));
    try {
      const p = join(dir, "t.jsonl");
      const reader = new TailReader(p);
      await writeFile(p, '{"a":1}\n');
      expect(await reader.poll()).toEqual(['{"a":1}']);
      await writeFile(p, '{"replaced":true}\n{"replaced":2}\n'); // larger than before
      expect(await reader.poll()).toEqual(['{"replaced":true}', '{"replaced":2}']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Static anti-criteria (ISC-137, ISC-138)
// ---------------------------------------------------------------------------

describe("static anti-criteria over src/", () => {
  const FORBIDDEN_SPLIT = ["split(/\\r?\\n", "split(/\\n"];
  // Usage forms, not prose: jsonl.ts's own doc comment legitimately WARNS
  // against readline; what ISC-138 bans is a code path that imports or calls it.
  const READLINE_USAGE = [
    /from\s+["'](?:node:)?readline/,
    /require\s*\(\s*["'](?:node:)?readline/,
    /import\s*\(\s*["'](?:node:)?readline/,
    /createInterface\s*\(/,
  ];

  async function srcFiles(): Promise<string[]> {
    const glob = new Bun.Glob("src/**/*.ts");
    const files: string[] = [];
    for await (const f of glob.scan({ cwd: new URL("../../", import.meta.url).pathname })) {
      files.push(f);
    }
    return files.sort();
  }

  test("no code under src/ uses readline or regex line-splitting (ISC-138)", async () => {
    const root = new URL("../../", import.meta.url).pathname;
    for (const rel of await srcFiles()) {
      const text = await Bun.file(join(root, rel)).text();
      for (const re of READLINE_USAGE) {
        expect(re.test(text), `${rel} uses readline (${re})`).toBe(false);
      }
      for (const pat of FORBIDDEN_SPLIT) {
        expect(text.includes(pat), `${rel} contains ${pat}`).toBe(false);
      }
    }
  });

  /**
   * The delimiter set includes backticks, and that is the whole point.
   *
   * The original pattern required a quote after `import(`, so a
   * template-literal specifier walked straight through: adding
   * ``await import(`../../backends/cmux/index.ts`)`` to `up.ts` left this
   * suite green at 18/18, while the same import in quotes turned it red.
   * That is the highest-probability regression form precisely because
   * `src/backends/registry.ts` establishes the backtick template import as
   * THE sanctioned way to reach cmux — a developer copying the sanctioned
   * idiom one file over gets a green suite and a broken seam.
   */
  test("no file outside src/backends/cmux/ imports a cmux symbol (ISC-137)", async () => {
    const root = new URL("../../", import.meta.url).pathname;
    const CMUX_IMPORT = /from\s+["'`][^"'`]*cmux[^"'`]*["'`]|import\s*\(\s*["'`][^"'`]*cmux/;
    for (const rel of await srcFiles()) {
      if (rel.startsWith("src/backends/cmux/")) continue;
      const text = await Bun.file(join(root, rel)).text();
      expect(CMUX_IMPORT.test(text), `${rel} imports a cmux module`).toBe(false);
    }
  });

  /**
   * The guard above is a regex over source text, so it needs its own proof
   * that it still matches what it claims to. Three shapes, each of which has
   * either shipped or nearly shipped: a quoted static import, a backtick
   * dynamic import, and the registry's own interpolated specifier.
   */
  test("the ISC-137 pattern catches every import shape, including backticks", () => {
    const CMUX_IMPORT = /from\s+["'`][^"'`]*cmux[^"'`]*["'`]|import\s*\(\s*["'`][^"'`]*cmux/;
    const violations = [
      'import { assertCmuxValue } from "../../backends/cmux/client.ts";',
      "import { assertCmuxValue } from '../../backends/cmux/client.ts';",
      "import { assertCmuxValue } from `../../backends/cmux/client.ts`;",
      'const m = await import("./cmux/index.ts");',
      "const m = await import(`../../backends/cmux/index.ts`);",
    ];
    for (const v of violations) {
      expect(CMUX_IMPORT.test(v), `missed: ${v}`).toBe(true);
    }

    const allowed = [
      // The registry's keyed load: the kind is a variable, so no literal
      // "cmux" appears in the specifier and the seam stays intact.
      "const mod = await import(`./${kind}/index.ts`);",
      'import type { BackendKind } from "./types.ts";',
      // Prose mentioning cmux must not trip a source-text guard.
      "// cmux is reached through the registry, never imported directly.",
    ];
    for (const a of allowed) {
      expect(CMUX_IMPORT.test(a), `false positive: ${a}`).toBe(false);
    }
  });
});
