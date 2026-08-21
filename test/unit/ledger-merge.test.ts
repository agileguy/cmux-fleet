/**
 * What `mergeLedger` actually guarantees, pinned (ISC-157).
 *
 * ## Read this before adding a version stamp
 *
 * ISC-157 asks for "a ledger written under an older schema version read under a
 * pinned policy", and THAT CRITERION HAS NO SUBJECT. `LedgerRecordSchema`
 * (`src/contracts.ts`) carries no `schema` discriminator at all — only `seq`,
 * `ts`, `actor`, `run_id`, `event` and three optionals — so nothing stamps a
 * version on a ledger record and no record can be from an older one. Stamping
 * one was considered and NOT chosen; this suite is the other half of that
 * decision, which is to pin the guarantee `mergeLedger` really offers instead of
 * restating a criterion nothing implements.
 *
 * ## What this suite establishes, and what it does not
 *
 * IT PINS SHAPE-TOLERANCE: a malformed record does not crash the merge, it is
 * collected into `errors`, and every well-formed record around it still comes
 * through. That is real, it is load-bearing — `mergeLedger` is how the only
 * durable audit trail is read at report time — and it was previously untested.
 *
 * IT IS NOT A VERSION POLICY, and no amount of passing here makes it one. The
 * behaviour is driven entirely by SHAPE, so it cannot tell "written by an older
 * writer" from "corrupt shard": both arrive as a record that fails today's
 * schema, both are discarded, and both are reported with the same words. That
 * distinction is exactly what a version stamp would buy and exactly what was not
 * bought. A record that fails the schema is DISCARDED, not read — which is a
 * strictly weaker statement than "read under a pinned policy".
 *
 * ## Why the malformed record is placed three ways
 *
 * `mergeLedger`'s `try`/`catch` sits INSIDE the per-line loop, so a bad line
 * costs one record. Move it out one level and it costs the rest of the shard;
 * move it out two and it costs every shard after the first failure. Neither
 * regression is visible to a test that puts the bad record last and counts
 * survivors, because there is no tail left to drop. So the bad record is placed
 * FIRST, LAST, and MID-SHARD, and the assertions are on the exact ordered list
 * of surviving events rather than on a count — a merge that dropped the tail and
 * happened to keep the right number of records would pass a count.
 *
 * ## Budget
 *
 * No subprocess is spawned anywhere in this file — every case is bytes written
 * to a temp directory — so no `budget.ts` allowance applies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeLedger } from "../../src/run/ledger.ts";
import { runPaths, type RunPaths } from "../../src/run/paths.ts";

let tmp: string;
let run: RunPaths;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-ledger-"));
  run = runPaths("r-ledger", tmp);
  await mkdir(run.ledgerDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Ordering is by (ts, actor, seq), so distinct increasing `ts` pins write order. */
const BASE_MS = Date.UTC(2026, 7, 20, 0, 0, 0);
const at = (n: number): string => new Date(BASE_MS + n * 1_000).toISOString();

/** A record today's schema accepts. `event` is its identity in the assertions. */
function good(seq: number, event: string, actor = "cli"): string {
  return JSON.stringify({ seq, ts: at(seq), actor, run_id: "r-ledger", event });
}

/**
 * Valid JSON that fails today's schema — `run_id` is required and absent.
 *
 * This is ISC-157's own measured case, and it is ALSO the shape a record written
 * by a hypothetical older writer would arrive in. That the two are
 * indistinguishable here is the point made in this file's header, not an
 * oversight in the fixture.
 */
function missingRunId(seq: number): string {
  return JSON.stringify({ seq, ts: at(seq), actor: "cli", event: "no-run-id" });
}

/** Not JSON at all — a torn write, the other way a shard goes bad. */
function tornLine(): string {
  return '{"seq": 99, "ts": "2026-08-20T00:00:00.000Z", "actor": "cli", "run_';
}

const writeShard = (name: string, lines: string[]): Promise<void> =>
  writeFile(join(run.ledgerDir, `${name}.jsonl`), `${lines.join("\n")}\n`);

const events = (records: Array<{ event: string }>): string[] => records.map((r) => r.event);

describe("a malformed record costs exactly itself, wherever it sits", () => {
  test("FIRST: the records after it all survive", async () => {
    await writeShard("cli", [missingRunId(0), good(1, "b"), good(2, "c"), good(3, "d")]);
    const { records, errors } = await mergeLedger(run);
    expect(events(records)).toEqual(["b", "c", "d"]);
    expect(errors).toHaveLength(1);
  });

  test("LAST: the records before it all survive", async () => {
    await writeShard("cli", [good(0, "a"), good(1, "b"), good(2, "c"), missingRunId(3)]);
    const { records, errors } = await mergeLedger(run);
    expect(events(records)).toEqual(["a", "b", "c"]);
    expect(errors).toHaveLength(1);
  });

  test("MID-SHARD: the TAIL survives — the case a naive test cannot see", async () => {
    // The load-bearing one, and the reason LAST above is not sufficient on its
    // own. Measured: hoisting `mergeLedger`'s try/catch out of the per-line loop
    // reddens this with `- "c", - "d"` — the tail silently gone — while the LAST
    // test still PASSES, because a bad record in final position leaves no tail
    // to drop. A suite that only tested LAST would call that mutation green.
    await writeShard("cli", [good(0, "a"), good(1, "b"), missingRunId(2), good(3, "c"), good(4, "d")]);
    const { records, errors } = await mergeLedger(run);
    expect(events(records)).toEqual(["a", "b", "c", "d"]);
    expect(errors).toHaveLength(1);
  });

  test("ALL THREE AT ONCE: tolerance is per-record, not one-per-shard", async () => {
    await writeShard("cli", [
      missingRunId(0),
      good(1, "a"),
      tornLine(),
      good(3, "b"),
      good(4, "c"),
      missingRunId(5),
    ]);
    const { records, errors } = await mergeLedger(run);
    expect(events(records)).toEqual(["a", "b", "c"]);
    expect(errors).toHaveLength(3);
  });

  test("both failure KINDS are tolerated and both are reported", async () => {
    // Valid-JSON-wrong-shape and not-JSON-at-all take different paths inside the
    // merge (schema rejection vs `parseLine` throwing) and both must land in
    // `errors` rather than one of them escaping.
    await writeShard("cli", [good(0, "a"), missingRunId(1), tornLine(), good(3, "b")]);
    const { records, errors } = await mergeLedger(run);
    expect(events(records)).toEqual(["a", "b"]);
    expect(errors).toHaveLength(2);
  });
});

describe("the errors are usable, and the merge never crashes", () => {
  test("a bad record lands in `errors` NAMING its shard", async () => {
    await writeShard("cli", [good(0, "a"), missingRunId(1)]);
    const { errors } = await mergeLedger(run);
    expect(errors).toHaveLength(1);
    // Which shard is the whole diagnostic value: a run has one shard per writer,
    // and "some record somewhere failed" does not tell an operator which writer
    // to go and look at.
    expect(errors[0]).toContain("cli.jsonl");
    expect(errors[0]).toContain("run_id");
  });

  test("a shard that is ENTIRELY malformed yields errors, not a throw", async () => {
    await writeShard("cli", [tornLine(), tornLine(), tornLine()]);
    const { records, errors } = await mergeLedger(run);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(3);
  });

  test("blank lines are not errors", async () => {
    // `parseLine` returns undefined for an empty line, and a trailing newline is
    // how every shard ends. Counting those as errors would make `errors`
    // non-empty for every healthy run and train report readers to ignore it.
    await writeShard("cli", [good(0, "a"), "", good(1, "b"), "   "]);
    const { records, errors } = await mergeLedger(run);
    expect(events(records)).toEqual(["a", "b"]);
    expect(errors).toEqual([]);
  });
});

describe("one corrupt shard does not poison the others", () => {
  test("a sibling writer's history survives intact", async () => {
    // `ledger.ts`'s own header makes this claim in as many words — "the merge is
    // a read-time sort, where corruption of one shard cannot poison the others"
    // — and nothing tested it. Shards are read in `sort()` order, so `cli`
    // precedes `sup`: the damage is upstream of the healthy writer.
    await writeShard("cli", [tornLine(), good(1, "cli-1"), missingRunId(2)]);
    await writeShard("sup", [good(0, "sup-0"), good(3, "sup-3")]);

    const { records, errors } = await mergeLedger(run);
    // Interleaved by `ts` across shards, which is the merge's actual contract.
    expect(events(records)).toEqual(["sup-0", "cli-1", "sup-3"]);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.startsWith("cli.jsonl"))).toBe(true);
  });

  test("a corrupt FIRST shard does not cost the second shard entirely", async () => {
    // Hoisting the try/catch out to the shard loop is caught here as well as
    // mid-shard: `sup` is read after `cli` fails, so an error that escaped one
    // level too far would take the whole second writer with it.
    await writeShard("cli", [tornLine()]);
    await writeShard("sup", [good(1, "sup-1"), good(2, "sup-2"), good(3, "sup-3")]);

    const { records, errors } = await mergeLedger(run);
    expect(events(records)).toEqual(["sup-1", "sup-2", "sup-3"]);
    expect(errors).toHaveLength(1);
  });
});

describe("the healthy path is unchanged", () => {
  test("a clean ledger merges in (ts, actor, seq) order with no errors", async () => {
    await writeShard("cli", [good(0, "a"), good(2, "c")]);
    await writeShard("sup", [good(1, "b"), good(3, "d")]);
    const { records, errors } = await mergeLedger(run);
    expect(events(records)).toEqual(["a", "b", "c", "d"]);
    expect(errors).toEqual([]);
  });

  test("a run with no ledger directory is empty, not an error", async () => {
    const fresh = runPaths("r-no-ledger", tmp);
    const { records, errors } = await mergeLedger(fresh);
    expect(records).toEqual([]);
    expect(errors).toEqual([]);
  });
});
