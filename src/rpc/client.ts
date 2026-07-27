/**
 * Pi RPC client (SRD §4.2): JSONL over the container's stdin/stdout,
 * LF-delimited, optional `id` for correlation.
 *
 * Three facts drive the shape of this file:
 *
 * 1. **The stream is the clock.** Pi's events carry no correlation id — only
 *    responses do — so the only happens-before relation available is the order
 *    of records on the single stdout pipe. The client therefore assigns every
 *    parsed record (event and response alike) a monotonic `streamSeq`, and
 *    hands that seq to every consumer. Epoch fencing (SRD §7.5) is built on
 *    these offsets: a terminal event is attributed to an epoch by comparing
 *    its seq against the seq of that epoch's `prompt` ack, not by wall-clock
 *    windows, which cannot order a late event against a fresh dispatch.
 *
 * 2. **`prompt` acks immediately and is not awaited**, and a failure can emit
 *    a *second* response with the same `id` later. Resolved ids are therefore
 *    remembered, and a straggler response is delivered to `onStray` rather
 *    than dropped — a late `success:false` on a live epoch must fail that
 *    epoch (ISC-86), which is impossible if the client forgot the id.
 *
 * 3. **Framing is `LineSplitter`, nothing else.** Node's and Bun's line
 *    readers also split on U+2028/U+2029, which are legal inside JSON strings;
 *    a tool result containing one would become two invalid fragments and a
 *    silently dropped record (SRD §8.3, ISC-138).
 */

import { isRpcResponse, type RpcEvent, type RpcMessage, type RpcResponse } from "../contracts.ts";
import { LineSplitter, parseLine } from "../util/jsonl.ts";

/** Default per-request timeout. `prompt` acks immediately, so this is generous. */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** How many resolved ids are remembered for straggler attribution. */
const RESOLVED_ID_MEMORY = 256;

export class RpcTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly id: string,
    readonly timeoutMs: number,
  ) {
    super(`RPC ${command} (id ${id}) timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

export class RpcClosedError extends Error {
  constructor(reason: string) {
    super(`RPC stream closed: ${reason}`);
    this.name = "RpcClosedError";
  }
}

/**
 * One malformed record kills the stream. This is a pinned decision, not an
 * accident: a skipped record in a control stream is indistinguishable from an
 * event that never happened, which is precisely the failure the completion
 * detector must not have. Better a dead worker than a false settle.
 */
export class RpcProtocolError extends Error {
  constructor(
    readonly line: string,
    cause: unknown,
  ) {
    super(`unparseable RPC record: ${line.slice(0, 200)}`);
    this.name = "RpcProtocolError";
    this.cause = cause;
  }
}

/** A resolved request: the response plus its position on the stream. */
export interface SentResponse {
  response: RpcResponse;
  seq: number;
}

export type StrayKind = "late" | "unknown";

export interface RpcClientOptions {
  /** Every non-response record, with its stream seq. */
  onEvent: (event: RpcEvent, seq: number) => void;
  /**
   * Responses that match no pending request: `late` if the id was resolved or
   * timed out earlier (the second-`prompt`-response case), `unknown` if the id
   * was never ours (hostile or corrupted stream).
   */
  onStray?: (response: RpcResponse, seq: number, kind: StrayKind) => void;
  /** Fatal framing/parse failure. The client closes itself before calling this. */
  onProtocolError?: (err: RpcProtocolError) => void;
  defaultTimeoutMs?: number;
  /** Prefix for generated ids so two clients' ids can never collide in a log. */
  idPrefix?: string;
}

interface Pending {
  command: string;
  resolve: (r: SentResponse) => void;
  /**
   * Called with the response's stream seq synchronously during line handling,
   * before any later line in the same chunk is dispatched. Epoch fencing needs
   * this: the fence post must be in place before the first event that follows
   * the ack, and a promise resolution cannot guarantee that ordering.
   */
  onAck?: (seq: number) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Monotonic stopwatch with an injectable clock. Deadlines and stall timers
 * must never be computed from `Date.now()`: wall clock jumps under host sleep
 * and NTP steps, and a deadline that jumps with it either fires years early or
 * never. Wall-clock time is for ledger timestamps only.
 */
export class Stopwatch {
  readonly #now: () => number;
  #start: number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#start = now();
  }

  elapsedMs(): number {
    return this.#now() - this.#start;
  }

  restart(): void {
    this.#start = this.#now();
  }
}

export class RpcClient {
  readonly #sink: { write(data: string): unknown; flush?(): unknown };
  readonly #opts: RpcClientOptions;
  readonly #splitter = new LineSplitter();
  readonly #pending = new Map<string, Pending>();
  /** id -> command, insertion-ordered so the oldest can be evicted. */
  readonly #resolved = new Map<string, string>();
  #seq = 0;
  #nextId = 1;
  #closed: Error | null = null;

  constructor(sink: { write(data: string): unknown; flush?(): unknown }, opts: RpcClientOptions) {
    this.#sink = sink;
    this.#opts = opts;
  }

  /** Seq of the most recently parsed record. 0 before anything arrived. */
  get lastSeq(): number {
    return this.#seq;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Feed raw stdout bytes. Chunk boundaries are arbitrary; the splitter copes. */
  feed(chunk: Uint8Array): void {
    if (this.#closed) return;
    let lines: string[];
    try {
      lines = this.#splitter.push(chunk);
    } catch (err) {
      this.#fatal(new RpcProtocolError("<line too long>", err));
      return;
    }
    for (const line of lines) this.#handleLine(line);
  }

  /** Test convenience: feed already-decoded text. */
  feedText(text: string): void {
    if (this.#closed) return;
    for (const line of this.#splitter.pushText(text)) this.#handleLine(line);
  }

  /**
   * End of stream. A buffered partial line is an incomplete write, not a
   * record — it is deliberately NOT flushed into a message (SRD §8.3). All
   * in-flight requests reject: their responses can no longer arrive.
   */
  feedEof(): void {
    this.close("stream ended");
  }

  close(reason = "closed"): void {
    if (this.#closed) return;
    this.#closed = new RpcClosedError(reason);
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      this.#remember(id, p.command);
      p.reject(this.#closed);
    }
    this.#pending.clear();
  }

  /**
   * Send a command and await its (first) response. Resolves with the response
   * whether or not `success` is true — the caller inspects — plus the stream
   * seq at which the response arrived, which epoch fencing records as the
   * epoch's `ack_seq`.
   */
  send(
    command: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number; onAck?: (seq: number) => void } = {},
  ): Promise<SentResponse> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = `${this.#opts.idPrefix ?? "rpc"}-${this.#nextId++}`;
    const timeoutMs = opts.timeoutMs ?? this.#opts.defaultTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

    const promise = new Promise<SentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timed out — but the response may still arrive. Remember the id so a
        // straggler is reported as `late`, not `unknown`.
        this.#pending.delete(id);
        this.#remember(id, command);
        reject(new RpcTimeoutError(command, id, timeoutMs));
      }, timeoutMs);
      this.#pending.set(id, {
        command,
        resolve,
        reject,
        timer,
        ...(opts.onAck !== undefined ? { onAck: opts.onAck } : {}),
      });
    });

    // The sink is the child's stdin. When the child dies the write throws
    // EPIPE synchronously — and every caller treats send() as returning a
    // promise, so the throw escaped while the pending entry stayed registered.
    // Its timer then rejected a promise nobody held, which Bun turns into an
    // unhandled rejection and a dead supervisor. Failures belong on the
    // promise channel the callers already handle.
    try {
      this.#sink.write(`${JSON.stringify({ id, type: command, ...params })}\n`);
      this.#sink.flush?.();
    } catch (err) {
      const p = this.#pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.#pending.delete(id);
        this.#remember(id, command);
      }
      // Swallow the original rejection path; the caller gets this one instead.
      promise.catch(() => {});
      return Promise.reject(
        new RpcClosedError(`write failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    return promise;
  }

  #handleLine(line: string): void {
    let msg: RpcMessage | undefined;
    try {
      msg = parseLine<RpcMessage>(line);
    } catch (err) {
      this.#fatal(new RpcProtocolError(line, err));
      return;
    }
    if (msg === undefined) return; // blank line — not a record, no seq
    // A bare `null` (or any scalar) parses fine but is not a record. Only
    // `undefined` meant "blank", so `null` slipped through and was dereferenced
    // downstream — throwing out of feed(), past the deliberate
    // RpcProtocolError path, and out of the reader's void-ed async IIFE as an
    // unhandled rejection that kills the supervisor.
    if (msg === null || typeof msg !== "object") {
      this.#fatal(new RpcProtocolError(line, new TypeError("record is not an object")));
      return;
    }
    const seq = ++this.#seq;

    if (isRpcResponse(msg)) {
      const id = msg.id;
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (id !== undefined && pending) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        this.#remember(id, pending.command);
        // Synchronously, BEFORE the loop in feed() reaches the next line.
        // Resolving the promise only schedules a microtask, so a caller that
        // records the fence post after `await send(...)` records it one turn
        // too late — and when the peer packs the ack and the first event into
        // a single write, that event is misattributed to the previous epoch
        // and the epoch window never opens. See the note on `onAck`.
        pending.onAck?.(seq);
        pending.resolve({ response: msg, seq });
      } else {
        const kind: StrayKind = id !== undefined && this.#resolved.has(id) ? "late" : "unknown";
        this.#opts.onStray?.(msg, seq, kind);
      }
      return;
    }
    // A handler that throws must not escape the reader loop as an unhandled
    // rejection. The supervisor's onEvent runs epoch attribution, the
    // completion tracker and the probe scheduler; any of them throwing used to
    // kill the process instead of surfacing as a protocol failure.
    try {
      this.#opts.onEvent(msg, seq);
    } catch (err) {
      this.#fatal(new RpcProtocolError(line, err));
    }
  }

  #remember(id: string, command: string): void {
    this.#resolved.set(id, command);
    while (this.#resolved.size > RESOLVED_ID_MEMORY) {
      const oldest = this.#resolved.keys().next().value;
      if (oldest === undefined) break;
      this.#resolved.delete(oldest);
    }
  }

  #fatal(err: RpcProtocolError): void {
    this.close(err.message);
    this.#opts.onProtocolError?.(err);
  }
}
