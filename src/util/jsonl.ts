/**
 * Line-delimited JSON reading, done correctly (SRD §8.3).
 *
 * Two rules, both of which have a real failure behind them:
 *
 * 1. **Split on `\n` only**, stripping an optional trailing `\r`. Never use
 *    `readline` — Node's and Bun's both also split on `U+2028`/`U+2029`, which
 *    are legal *inside* JSON strings and appear routinely in minified JS and
 *    scraped text. A tool result containing `U+2028` would become two invalid
 *    fragments and one silently dropped record.
 *
 * 2. **Decode with a streaming decoder.** A 4-byte codepoint straddling a chunk
 *    boundary must not become `U+FFFD`. `TextDecoder` with `{stream: true}`
 *    holds the partial sequence until the continuation bytes arrive.
 *
 * Both the RPC transport and the session-transcript harvester use this; neither
 * may implement its own splitting.
 */

/**
 * Longest single line accepted before the stream is treated as hostile.
 *
 * Measured in UTF-16 code units, not bytes: the splitter works on decoded text,
 * and the guard exists to bound memory, not to enforce an exact byte budget.
 */
export const MAX_LINE_UNITS = 8 * 1024 * 1024;

export class LineTooLongError extends Error {
  constructor(readonly units: number) {
    super(`JSONL line exceeded ${MAX_LINE_UNITS} code units (saw ${units})`);
    this.name = "LineTooLongError";
  }
}

/**
 * Incremental byte-chunks-to-lines splitter.
 *
 * Feed it arbitrary `Uint8Array` chunks; it yields complete lines. A trailing
 * partial line is retained until its terminator arrives, so a poll that lands
 * mid-write resumes cleanly on the next poll.
 */
export class LineSplitter {
  #decoder = new TextDecoder("utf-8");
  #buffer = "";

  /** Feed a chunk; returns every line completed by it. */
  push(chunk: Uint8Array): string[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain();
  }

  /** Feed already-decoded text. Only safe when no codepoint can be split. */
  pushText(chunk: string): string[] {
    this.#buffer += chunk;
    return this.#drain();
  }

  #drain(): string[] {
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.#buffer.indexOf("\n", start);
      if (nl === -1) break;
      out.push(stripCr(this.#buffer.slice(start, nl)));
      start = nl + 1;
    }
    if (start > 0) this.#buffer = this.#buffer.slice(start);
    if (this.#buffer.length > MAX_LINE_UNITS) {
      throw new LineTooLongError(this.#buffer.length);
    }
    return out;
  }

  /**
   * Flush any buffered partial line. Call only at true end-of-stream: a live
   * transcript's trailing partial line is an incomplete write, not a record.
   */
  flush(): string[] {
    this.#buffer += this.#decoder.decode();
    if (this.#buffer.length === 0) return [];
    const last = stripCr(this.#buffer);
    this.#buffer = "";
    return last.length > 0 ? [last] : [];
  }

  /** Bytes currently held back awaiting a terminator. */
  get pending(): number {
    return this.#buffer.length;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Parse a line into a record, returning `undefined` for blank lines.
 *
 * Malformed lines throw rather than being skipped: a dropped record in a
 * control stream is indistinguishable from an event that never happened, which
 * is precisely the failure the completion detector must not have.
 */
export function parseLine<T = unknown>(line: string): T | undefined {
  const t = line.trim();
  if (t.length === 0) return undefined;
  return JSON.parse(t) as T;
}

/** Convert a stream of byte chunks into parsed JSONL records. */
export async function* readJsonl<T = unknown>(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<T> {
  const splitter = new LineSplitter();
  for await (const chunk of chunks) {
    for (const line of splitter.push(chunk)) {
      const rec = parseLine<T>(line);
      if (rec !== undefined) yield rec;
    }
  }
  for (const line of splitter.flush()) {
    const rec = parseLine<T>(line);
    if (rec !== undefined) yield rec;
  }
}

/**
 * A resumable reader over a file that is being appended to.
 *
 * Tracks byte offset and inode-ish identity. If the file shrinks or its
 * identity changes — rotation, recreation, a session restarted under the same
 * path — the reader restarts from offset 0 rather than reading garbage from the
 * middle of a new file.
 */
export class TailReader {
  #offset = 0;
  #size = 0;
  #splitter = new LineSplitter();

  constructor(readonly path: string) {}

  get offset(): number {
    return this.#offset;
  }

  /** Read everything appended since the last poll. */
  async poll(): Promise<string[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];
    const size = file.size;

    if (size < this.#size) {
      // Truncated or replaced: everything we know about the old file is void.
      this.#offset = 0;
      this.#splitter = new LineSplitter();
    }
    this.#size = size;
    if (size <= this.#offset) return [];

    const slice = file.slice(this.#offset, size);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    this.#offset = size;
    return this.#splitter.push(bytes);
  }

  /** Poll and parse, dropping blank lines. */
  async pollRecords<T = unknown>(): Promise<T[]> {
    const out: T[] = [];
    for (const line of await this.poll()) {
      const rec = parseLine<T>(line);
      if (rec !== undefined) out.push(rec);
    }
    return out;
  }
}

/**
 * Atomic JSON write: tmp + fsync + rename + **directory fsync**.
 *
 * The rename is atomic on APFS but the directory entry's durability is not
 * guaranteed without the final fsync, which is why state files and result
 * envelopes both go through here (SRD §7.6).
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const { open, rename, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;

  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);

  const dh = await open(dir, "r");
  try {
    await dh.sync();
  } catch {
    // Directory fsync is unsupported on some filesystems; the rename still landed.
  } finally {
    await dh.close();
  }
}

/** Append one record to a sharded ledger file, bounded in line length. */
export async function appendJsonl(path: string, record: unknown): Promise<void> {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  let line = JSON.stringify(record);
  if (line.length > MAX_LINE_UNITS) {
    line = JSON.stringify({ error: "record_too_large", bytes: line.length });
  }
  await appendFile(path, `${line}\n`, "utf8");
}
