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
  /**
   * Lines that were already complete when the oversized one was hit.
   *
   * They are valid records and the caller must not lose them: a stream reader
   * that treats this as fatal (RpcClient does) can still drain them, and one
   * that recovers (TailReader, readJsonl) must. Dropping them would make one
   * huge tool result destroy the records around it — the precise failure the
   * completion detector cannot survive.
   */
  constructor(
    readonly units: number,
    readonly completed: readonly string[] = [],
  ) {
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
  /**
   * Set after an oversized line is dropped: the bytes that follow are the
   * CONTINUATION of that record, not a new one, so everything up to the next
   * newline must be discarded too.
   *
   * Without this, dropping the residue and returning made the next "complete
   * line" a tail fragment of the record just rejected — handed to the caller as
   * if it were valid. That is the same corruption the TailReader identity fix
   * exists to prevent, reintroduced one layer down.
   */
  #resyncing = false;

  /** Feed a chunk; returns every line completed by it. */
  push(chunk: Uint8Array): string[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    if (this.#resyncing) {
      const nl = this.#buffer.indexOf("\n");
      if (nl === -1) {
        // Still inside the rejected record. Keep nothing; a resync must not
        // accumulate the very bytes it is discarding.
        this.#buffer = "";
        return [];
      }
      this.#buffer = this.#buffer.slice(nl + 1);
      this.#resyncing = false;
    }
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
        // Carry the lines already completed in this push. Throwing bare
        // discarded `out`, so a single oversized record silently destroyed
        // every good record that arrived before it in the same chunk —
        // `{"a":1}\n{"b":2}\n<huge>\n{"c":3}\n` yielded only `{"c":3}`. That is
        // exactly the dropped-record failure this module's contract forbids.
        throw new LineTooLongError(nl - start, out);
      }
      out.push(stripCr(this.#buffer.slice(start, nl)));
      start = nl + 1;
    }
    if (start > 0) this.#buffer = this.#buffer.slice(start);
    if (this.#buffer.length > MAX_LINE_UNITS) {
      // Drop the offending residue as well. Leaving it made every subsequent
      // push re-throw on a line the caller had already been told about, so one
      // oversized tail wedged the splitter permanently.
      //
      // The residue is UNTERMINATED, so the next bytes continue it. Enter
      // resync and discard through the next newline; simply clearing the
      // buffer would emit that continuation as if it were a whole record.
      const n = this.#buffer.length;
      this.#buffer = "";
      this.#resyncing = true;
      throw new LineTooLongError(n, out);
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
/** How many leading bytes identify a file's *content* generation. */
const HEAD_FINGERPRINT_BYTES = 64;

/**
 * Hash of exactly the first `n` bytes of `path`, or `null` if unreadable.
 *
 * `n` is FIXED by the caller across polls and never derived from the current
 * size. Hashing `min(size, 64)` instead looks right and is not: an append grows
 * the file, so the next poll hashes a longer range, the digest differs, and a
 * perfectly ordinary append is misread as a rewrite — the reader then replays
 * records it has already returned.
 */
async function headHash(path: string, n: number): Promise<string | null> {
  if (n <= 0) return null;
  try {
    const bytes = new Uint8Array(await Bun.file(path).slice(0, n).arrayBuffer());
    if (bytes.length < n) return null; // shrank under us; caller treats as replace
    const h = new Bun.CryptoHasher("sha256");
    h.update(bytes);
    return h.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export class TailReader {
  #offset = 0;
  /** `dev:ino:birthtime` of the file this reader's offset refers to. */
  #identity: string | null = null;
  /** Byte count the head fingerprint covers; fixed once, never size-derived. */
  #headLen = 0;
  #headHash: string | null = null;
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
    // complete line.
    //
    // Inode identity alone cannot detect it either, and this is where the
    // first fix fell short: Pi rewrites the session file IN PLACE on
    // load-time migration and on auto-compaction, so `dev`, `ino` and
    // `birthtimeMs` all survive unchanged. Regrown past the old offset, that
    // is byte-for-byte indistinguishable from an append — the enabled test
    // produced `"ed":true}` as a "complete line".
    //
    // So identity is (dev, ino, birthtime) AND a fingerprint of the head. A
    // rewrite changes the first bytes; an append never does. Reading 64 bytes
    // per poll is the cost of not silently corrupting a transcript.
    const size = st.size;
    const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
    // The head is re-hashed over the SAME byte count that was hashed last
    // time — a prefix this reader has already consumed, which an append can
    // never alter and a rewrite almost always does.
    // `null` means "could not read the head", which is NOT the same as "the
    // head changed". Treating them alike made a transient EINTR/ENOENT during
    // rotation reset the offset and re-emit the entire file as new records —
    // duplicates, silently, with no error anywhere.
    const anchored = this.#headLen > 0 && this.#headHash !== null;
    const head = anchored ? await headHash(this.path, this.#headLen) : null;
    const headChanged = anchored && head !== null && head !== this.#headHash;
    const replaced =
      this.#identity !== null && (identity !== this.#identity || size < this.#offset || headChanged);
    if (replaced) {
      this.#offset = 0;
      this.#headLen = 0;
      this.#headHash = null;
      this.#splitter = new LineSplitter();
    }
    this.#identity = identity;
    if (size <= this.#offset) return [];

    const slice = Bun.file(this.path).slice(this.#offset, size);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    // Advance by what was actually read, not by the stat's size: a truncation
    // between the stat and the read would otherwise skip past unread content.
    this.#offset += bytes.length;

    // Re-anchor the head fingerprint on bytes now known to be consumed. Fixing
    // the length here is what keeps the next poll's comparison apples-to-apples.
    //
    // Retry on every poll until it succeeds: a single failed anchor used to
    // leave `#headLen > 0` with a null hash, which compares equal forever and
    // silently disabled rewrite detection for the life of the reader, with no
    // signal that the guarantee had been withdrawn.
    if (this.#headHash === null && this.#offset > 0) {
      const len = Math.min(this.#offset, HEAD_FINGERPRINT_BYTES);
      const h = await headHash(this.path, len);
      if (h !== null) {
        this.#headLen = len;
        this.#headHash = h;
      }
    }
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
 * fsync a directory, reporting nothing when it cannot be done (ISC-218).
 *
 * This runs AFTER the rename has landed, so by the time it is called the new
 * contents are already visible to every reader — only the durability of the
 * directory ENTRY across a power loss is still in question. Downgrading that
 * one guarantee is a strictly better outcome than telling the caller the write
 * failed, because a caller told "failed" retries, reports a broken worker, or
 * unwinds a state machine over a file that is sitting on disk, correct.
 *
 * Every step is swallowed, not just the `sync()`. The original only guarded
 * the sync, which read as complete and was not: `open(dir, "r")` needs READ
 * permission on the directory, while writing and renaming inside it need only
 * write+search. A `0o300` run directory — a hardened umask, a deliberately
 * locked-down runs root — therefore let the tmp file be written, fsynced and
 * renamed into place and THEN threw `EACCES` out of `writeJsonAtomic`.
 *
 * The `close()` is guarded too, but for a WEAKER reason than the rest, and the
 * distinction is worth keeping straight. An earlier revision of this comment
 * justified it with deferred-writeback error reporting — NFS close-to-open, the
 * Linux `errseq_t` mechanism that surfaces a lost async writeback at `close()`.
 * That cannot happen here: those errors are reported to descriptors that had
 * WRITES issued through them, and this handle is `open(dir, "r")` — read-only,
 * on a directory, with nothing ever written through it. There is no dirty page
 * for a deferred error to be owed to.
 *
 * What `close()` can actually return here is EBADF or EINTR, neither of which
 * the caller can act on any more than the `sync()` failure above. So the guard
 * stays as defence in depth and for consistency — every step of a best-effort
 * helper swallowing, rather than one step left able to fail the call the whole
 * function exists to protect — and not as a mechanism that could fire.
 *
 * Contrast `fh` in `writeJsonAtomic`: opened "w", written, synced, and its
 * `close()` deliberately NOT guarded. That is the descriptor the deferred-error
 * mechanism genuinely applies to, and a failure there happens BEFORE the
 * rename, so it means the write did not land and the caller must hear about it.
 *
 * Exported so the guarantee can be tested against a directory that cannot be
 * opened at all, rather than only inferred from the code shape.
 */
export async function fsyncDirBestEffort(dir: string): Promise<void> {
  const { open } = await import("node:fs/promises");
  let dh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    dh = await open(dir, "r");
    await dh.sync();
  } catch {
    // Directory fsync is unsupported on some filesystems and unavailable on
    // an unreadable directory; the rename still landed either way.
  } finally {
    // Optional chaining short-circuits the whole chain, so a null handle skips
    // the `.catch` too rather than throwing on it.
    await dh?.close().catch(() => {});
  }
}

/**
 * Atomic JSON write: tmp + fsync + rename + **directory fsync**.
 *
 * The rename is atomic on APFS but the directory entry's durability is not
 * guaranteed without the final fsync, which is why state files and result
 * envelopes both go through here (SRD §7.6).
 *
 * The directory fsync is best-effort and CANNOT fail the call: once the rename
 * returns, the write is done (ISC-218). See `fsyncDirBestEffort`.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The same five-step protocol for a payload that is not JSON.
 *
 * It exists because the A5 HTML export needs exactly what `writeJsonAtomic`
 * already provides and nothing about the guarantee is JSON-shaped: a reader
 * opening the path sees either the whole previous document or the whole new
 * one, never a prefix of one wearing the tail of the other. The alternative
 * was a second hand-rolled tmp-and-rename beside a protocol that is already
 * pinned at every syscall boundary by `test/unit/jsonl.test.ts` (ISC-156) —
 * two implementations of one invariant, only one of them tested.
 *
 * `writeJsonAtomic` is now a serializer in front of this; the SIGKILL cases
 * exercise this body through it unchanged.
 */
export async function writeTextAtomic(path: string, body: string): Promise<void> {
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

  await fsyncDirBestEffort(dir);
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
