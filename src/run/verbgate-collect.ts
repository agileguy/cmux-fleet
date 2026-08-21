/**
 * Host-side collection of the per-worker verbgate ledger (ISC-172).
 *
 * ## What this guarantees, and what it does not
 *
 * The criterion is "the verbgate ledger is collected outside the container, so
 * a worker cannot truncate its own audit trail". This closes it by TAIL AND
 * COPY: a host process reads each worker's ledger incrementally and appends
 * what it has read to a file under the run directory, which no mount reaches.
 *
 * THE GUARANTEE IS THE WEAKER OF THE TWO AVAILABLE, and every claim in this
 * file is worded to it:
 *
 *   Everything already collected survives truncation, and truncation itself
 *   is detected and recorded. Rows written AND truncated between two polls
 *   are lost.
 *
 * That window is not closed here and must not be described as though it were.
 * The stronger arm — verbgate writing to a descriptor or unix socket the host
 * holds, so the worker never owns the file and `truncate(2)` has nothing to
 * act on — was considered and deliberately NOT chosen: it changes the
 * container contract and edits `docker/verbgate`, which is security-critical.
 * The distinction matters because the two answers sound alike and are not:
 * this one makes the trail TAMPER-EVIDENT, the other would make it
 * TAMPER-PROOF.
 *
 * The window is bounded by the collector's period, which is the daemon's
 * existing reaper tick (`registry.ts`), i.e. the run's heartbeat interval. A
 * worker cannot enlarge it: it does not know when a poll last ran, and the
 * final pass at `down` (below) removes the "shut down before the next tick"
 * variant.
 *
 * ## Why the collected rows are wrapped
 *
 * A worker cannot delete from the copy — it has no path to it. It CAN write
 * anything it likes to its own ledger, and everything it writes is copied. So
 * if collector records and worker rows shared a namespace, a worker could
 * author a line that reads back as a collector record: a truncation that never
 * happened, or enough forged ones to bury a real one. Nesting the worker's
 * bytes in a string field (`line`) makes a top-level collector record a shape
 * the worker cannot produce, whatever it writes.
 *
 * The nested bytes are stored VERBATIM rather than parsed and re-serialised.
 * The copy is evidence: a row verbgate wrote through its `printf` fallback is
 * not necessarily well-formed JSON — that fallback exists precisely for the
 * cases where `jq` failed — and a collector that dropped or normalised what it
 * could not parse would discard the rows most likely to be interesting.
 *
 * ## Not a ledger shard
 *
 * See `RunPaths.auditDir`. Filing these in `<run>/ledger/` would put rows of a
 * foreign shape in front of `mergeLedger`, which parses every record with
 * `LedgerRecordSchema` and — as of Phase G, deliberately — reports each
 * malformed one in `errors`. The audit trail would present as a permanent
 * stream of merge failures.
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, parseLine, TailReader, type TailRestartReason } from "../util/jsonl.ts";
import { verbgateCollectedPath, workerVerbgateLedger, type RunPaths } from "./paths.ts";

/** One line of a collected copy. See the header for why rows are wrapped. */
export type CollectedVerbgateRecord =
  | {
      kind: "row";
      /** Host clock at collection — NOT the worker's `ts`, which is inside `line`. */
      ts: string;
      worker: string;
      /** The worker's line, byte for byte as it was written. */
      line: string;
    }
  | {
      kind: "truncation";
      ts: string;
      worker: string;
      /** Which signals fired; see `TailRestartReason`. */
      reasons: readonly TailRestartReason[];
      /**
       * Bytes of this worker's ledger that HAD been collected when the trail
       * was cut. Not "bytes lost" — what was written and destroyed between two
       * polls was never read by the host and cannot be counted from here.
       */
      collected_bytes: number;
      /** The ledger's size once the truncation was observed. */
      size_after: number;
    };

const RowSchema = z.object({
  kind: z.literal("row"),
  ts: z.string(),
  worker: z.string(),
  line: z.string(),
});

const TruncationSchema = z.object({
  kind: z.literal("truncation"),
  ts: z.string(),
  worker: z.string(),
  reasons: z.array(z.enum(["shrank", "replaced", "head_rewritten"])).readonly(),
  collected_bytes: z.number(),
  size_after: z.number(),
});

export const CollectedVerbgateRecordSchema = z.discriminatedUnion("kind", [
  RowSchema,
  TruncationSchema,
]);

/** What one pass did for one worker. */
export interface VerbgateCollectReport {
  worker: string;
  /** Rows copied in this pass. */
  rows: number;
  /** Truncations observed in this pass. At most one per worker per pass. */
  truncations: number;
}

/**
 * Reads every worker's verbgate ledger and appends to a copy it cannot reach.
 *
 * STATEFUL, and its state is the reason the final pass at `down` is a daemon
 * RPC rather than something `down` does itself. Each worker's `TailReader`
 * holds the byte offset already collected; that offset lives in this object,
 * in the daemon process, and nowhere on disk. A second process running "one
 * last collection" would start from offset 0 and re-copy every row the daemon
 * had already collected — the copy would still lose nothing, but it would
 * duplicate an entire run's audit trail, which is a poor thing to hand an
 * operator reading it as evidence.
 *
 * The same reasoning bounds the crash case honestly: a daemon that dies and is
 * restarted against a live run rebuilds empty readers and re-collects from the
 * start of each ledger. Duplication, never loss — the safe direction for an
 * append-only trail, and the reason no offset is persisted. Persisting one
 * would be a durability problem of its own, and its failure mode is loss.
 */
export class VerbgateCollector {
  readonly #run: RunPaths;
  readonly #readers = new Map<string, TailReader>();
  /**
   * Workers this collector has ever written a record for.
   *
   * Separates the two silences a poll cannot otherwise tell apart. A worker
   * with NO ledger and a worker whose ledger simply has nothing new both
   * poll empty, and reporting them the same way loses the distinction that
   * matters to an audit: `[]` then means both "nothing to collect" and
   * "the collector observed this trail and it did not move", so a reader
   * cannot tell a quiet worker from an uncollected one. A worker enters this
   * set the first time it yields a record, and from then on its idle passes
   * report `rows: 0` — a positive statement that the trail was watched.
   */
  readonly #collected = new Set<string>();

  constructor(run: RunPaths) {
    this.#run = run;
  }

  /**
   * One pass over every worker with an outbox. Returns a report per worker
   * that has a ledger; workers with none are absent from the result.
   *
   * The worker set comes from the outbox directory on disk, not from
   * `registry.json`. Registration is deliberately optional — `supervisor`
   * registers with `{ optional: true }` so it can run without a daemon — and a
   * worker whose registration never landed, or that a reap has already
   * removed, still has an outbox and still has a trail worth collecting. The
   * audit trail is exactly the wrong thing to key on a liveness record.
   */
  async collectOnce(): Promise<VerbgateCollectReport[]> {
    const reports: VerbgateCollectReport[] = [];
    for (const worker of await this.#workers()) {
      const report = await this.#collectWorker(worker);
      if (report !== null) reports.push(report);
    }
    return reports;
  }

  async #workers(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.#run.root, "outbox"), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      // No outbox directory: a run whose workers were never materialised.
      return [];
    }
  }

  async #collectWorker(worker: string): Promise<VerbgateCollectReport | null> {
    const source = workerVerbgateLedger(this.#run.root, worker);
    let reader = this.#readers.get(worker);
    if (reader === undefined) {
      reader = new TailReader(source);
      this.#readers.set(worker, reader);
    }

    // Sampled BEFORE the poll: `restarts` is monotonic and advances by at most
    // one per poll, so the difference across this call is exactly whether THIS
    // poll restarted — and `lastRestart` then describes that restart and no
    // other. Reading the counter afterwards alone could not distinguish a
    // restart observed now from one observed three passes ago.
    const restartsBefore = reader.restarts;
    const lines = await reader.poll();
    const truncated = reader.restarts > restartsBefore;

    // An absent ledger polls empty and restarts never — indistinguishable
    // here, correctly, from a worker that has run no gated verb. Reporting
    // nothing keeps the collected directory empty for such a worker rather
    // than creating a file that asserts an empty audit trail was observed.
    //
    // But a worker ALREADY being collected is a different silence, and it is
    // reported: `rows: 0` says the trail was polled and did not move, which
    // is a fact an audit wants and `null` would erase. No file is written on
    // this path, so a quiet worker still costs nothing on disk.
    if (!truncated && lines.length === 0) {
      return this.#collected.has(worker) ? { worker, rows: 0, truncations: 0 } : null;
    }

    const ts = new Date().toISOString();
    const out: CollectedVerbgateRecord[] = [];

    /*
     * The mark goes in FIRST, and the order is load-bearing.
     *
     * The restart is detected at the top of `poll()`, so every line that poll
     * returned was read from the file as it exists AFTER the truncation.
     * Appending the rows first would file post-truncation rows ahead of the
     * event that explains them, and an operator reading the trail in order
     * would see the ledger apparently continue and then be cut.
     */
    if (truncated) {
      const restart = reader.lastRestart;
      out.push({
        kind: "truncation",
        ts,
        worker,
        reasons: restart?.reasons ?? [],
        collected_bytes: restart?.abandonedOffset ?? 0,
        size_after: restart?.sizeAtDetection ?? 0,
      });
    }
    for (const line of lines) out.push({ kind: "row", ts, worker, line });

    await mkdir(this.#run.auditDir, { recursive: true });
    const dest = verbgateCollectedPath(this.#run, worker);
    for (const record of out) await appendJsonl(dest, record);
    this.#collected.add(worker);

    return { worker, rows: lines.length, truncations: truncated ? 1 : 0 };
  }
}

/**
 * Read back one worker's collected copy. Absence is normal and reads empty.
 *
 * Exists so the copy has ONE parser. `report` and any future consumer read the
 * trail through this rather than re-deriving the record shape, which is the
 * same rule `run/paths.ts` states for paths and for the same reason: a shape
 * derived independently in two places eventually differs in one of them, and
 * here the divergence would be silent — a reader with a stale union drops the
 * record kind it does not know, and the record it would drop is the truncation
 * mark.
 */
export async function readCollectedVerbgate(
  run: RunPaths,
  workerId: string,
): Promise<CollectedVerbgateRecord[]> {
  const text = await readFile(verbgateCollectedPath(run, workerId), "utf8").catch(() => "");
  const out: CollectedVerbgateRecord[] = [];
  for (const line of text.split("\n")) {
    const rec = parseLine(line);
    if (rec !== undefined) out.push(CollectedVerbgateRecordSchema.parse(rec));
  }
  return out;
}
