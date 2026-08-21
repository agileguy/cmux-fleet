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
 *
 * THE TOLERANCE IS PER-RECORD, and the placement of the `try` below is the
 * whole of it. A bad line costs exactly that line: the rest of its shard still
 * merges, and so does every other shard. Hoist that `try` out one level and a
 * single bad record silently truncates its writer's history from that point on;
 * hoist it out two and the first bad record in the run discards every shard
 * sorted after it. Neither regression throws, neither shows up in `errors`
 * differently, and neither is visible to a test that puts its malformed record
 * LAST — there is no tail left to lose. `test/unit/ledger-merge.test.ts` places
 * one first, last, and mid-shard for exactly that reason, and mutation-proves
 * all three.
 *
 * WHAT THIS IS NOT, recorded here because ISC-157 asks for something adjacent
 * and a reader will otherwise assume this answers it. This is SHAPE-tolerance,
 * not a version policy. `LedgerRecordSchema` (`../contracts.ts`) carries no
 * `schema` discriminator — only `seq`, `ts`, `actor`, `run_id`, `event` and
 * three optionals — so nothing stamps a version on a ledger record and no
 * record can be from an older one. Stamping one was CONSIDERED AND NOT CHOSEN.
 * The consequence is precise and worth stating: a record that fails today's
 * schema is DISCARDED rather than read, and this merge cannot tell "written by
 * an older writer" from "corrupt shard" — both arrive as a shape that fails,
 * both are dropped, both are reported in the same words. That distinction is
 * exactly what a version stamp would buy, and it has not been bought.
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
