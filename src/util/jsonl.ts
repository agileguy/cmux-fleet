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
      // The cap has to be enforced HERE, on each completed line, not only on
      // the unterminated residue afterwards. Checking only the residue meant
      // any line that arrived whole within a single push sailed through at any
      // size — and TailReader hands its entire appended range to one push, so
      // a transcript with one huge line bypassed the bound completely.
      if (nl - start > MAX_LINE_UNITS) {
        this.#buffer = this.#buffer.slice(nl + 1);
        throw new LineTooLongError(nl - start);
      }
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
  /** `dev:ino:birthtime` of the file this reader's offset refers to. */
  #identity: string | null = null;
  #splitter = new LineSplitter();

  constructor(readonly path: string) {}

  get offset(): number {
    return this.#offset;
  }

  /** Read everything appended since the last poll. */
  async poll(): Promise<string[]> {
    const { stat } = await import("node:fs/promises");
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(this.path);
    } catch {
      return []; // not there yet
    }

    // Size alone cannot detect replacement. A session file recreated at the
    // same path with the same length looked like "nothing appended", and one
    // recreated LARGER made the reader resume from the old offset — slicing
    // out of the middle of a record and handing back the tail fragment as a
    // complete line. Identity is what distinguishes append from replace, and
    // this class's own doc-comment already claimed to track it.
    const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
    const size = st.size;
    if (this.#identity !== null && (identity !== this.#identity || size < this.#offset)) {
      this.#offset = 0;
      this.#splitter = new LineSplitter();
    }
    this.#identity = identity;
    if (size <= this.#offset) return [];

    const slice = Bun.file(this.path).slice(this.#offset, size);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    // Advance by what was actually read, not by the stat's size: a truncation
    // between the stat and the read would otherwise skip past unread content.
    this.#offset += bytes.length;
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
  const { open, rename, mkdir, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // The temp name must be unique PER CALL, not per process-millisecond. It was
  // `${pid}-${Date.now()}`, so two writes to one path in the same millisecond —
  // routine when several supervisors register at once — opened the same temp
  // inode with "w" and both wrote at offset 0. A short payload landing on a
  // long one leaves the long one's tail behind, producing a file that is not
  // valid JSON, and the loser's rename fails ENOENT. The supervisor had
  // already noticed and works around it with a per-file write chain; every
  // other caller was still exposed.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;

  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // Never leave the temp behind: a crash-loop would otherwise fill the run
    // directory with them, and nothing reaps them.
    await unlink(tmp).catch(() => {});
    throw err;
  }

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
