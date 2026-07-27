/**
 * Run ledger (SRD §7.7): sharded per writer, merged at report time.
 *
 * N detached supervisors plus the CLI plus the daemon appending to ONE file
 * cannot rely on `O_APPEND` atomicity for large records across filesystems —
 * interleaved partial writes would corrupt the only durable audit trail. So
 * every writer owns `<run-dir>/ledger/<writer-id>.jsonl` exclusively, and the
 * merge is a read-time sort, where corruption of one shard cannot poison the
 * others.
 */

import { LedgerRecordSchema, type LedgerRecord } from "../contracts.ts";
import { appendJsonl, LineSplitter, parseLine } from "../util/jsonl.ts";
import { ledgerShard, type RunPaths } from "./paths.ts";

export class LedgerWriter {
  #seq = 0;
  readonly #path: string;
  readonly #actor: string;
  readonly #runId: string;

  constructor(run: RunPaths, actor: string) {
    this.#path = ledgerShard(run, actor);
    this.#actor = actor;
    this.#runId = run.runId;
  }

  /**
   * Append one record. `seq` orders records within this shard; cross-shard
   * order comes from `ts` at merge time and is advisory — two writers'
   * clocks are not comparable at millisecond precision, and nothing
   * correctness-bearing may depend on cross-shard order.
   */
  async append(
    event: string,
    fields: {
      worker?: string;
      task_id?: string;
      epoch?: number;
      detail?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const record: LedgerRecord = LedgerRecordSchema.parse({
      seq: this.#seq++,
      ts: new Date().toISOString(),
      actor: this.#actor,
      run_id: this.#runId,
      event,
      ...fields,
    });
    await appendJsonl(this.#path, record);
  }
}

/**
 * Merge every shard, sorted by (ts, actor, seq). Unparseable lines are
 * returned in `errors` rather than thrown: at report time a corrupt shard is
 * a finding to surface, not a reason to lose the other writers' history.
 */
export async function mergeLedger(
  run: RunPaths,
): Promise<{ records: LedgerRecord[]; errors: string[] }> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const records: LedgerRecord[] = [];
  const errors: string[] = [];

  let shards: string[];
  try {
    shards = (await readdir(run.ledgerDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { records, errors };
  }

  for (const shard of shards.sort()) {
    const path = join(run.ledgerDir, shard);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const splitter = new LineSplitter();
    const lines = [...splitter.push(bytes), ...splitter.flush()];
    for (const line of lines) {
      try {
        const parsed = parseLine(line);
        if (parsed !== undefined) records.push(LedgerRecordSchema.parse(parsed));
      } catch (err) {
        errors.push(`${shard}: ${String(err)}`);
      }
    }
  }

  records.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
    return a.seq - b.seq;
  });
  return { records, errors };
}
