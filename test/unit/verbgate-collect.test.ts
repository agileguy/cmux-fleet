/**
 * The verbgate ledger is collected outside the container (ISC-172).
 *
 * ## The guarantee, stated as the weaker of the two available
 *
 * This is TAIL AND COPY, not a transport change. A host-side collector reads
 * the worker's ledger incrementally and appends what it reads to a file the
 * worker has no mount to. What that buys, exactly:
 *
 *   Everything already collected survives truncation, and truncation itself
 *   is detected and recorded. Rows written AND truncated between two polls
 *   are lost.
 *
 * That window is real and is not closed here. The stronger arm — verbgate
 * writing to a descriptor or socket the host holds, so the worker never owns
 * the file and truncation is impossible — was NOT chosen: it changes the
 * container contract and edits `docker/verbgate`, which is security-critical.
 * A criterion closed on the tailer must not be worded as though it closed on
 * the transport, so every claim here is worded to the tailer.
 *
 * ## What these probes are for
 *
 * The attack is `: > /outbox/ledger/verbgate.jsonl` from inside the container.
 * `truncateSource` below IS that attack, performed against the same path
 * `docker/verbgate` writes and `workerVerbgateLedger` names. The assertion is
 * on the host-collected copy, which must be unchanged by it.
 *
 * These run WITHOUT Docker, deliberately. The verbgate suite is Docker-gated
 * (`describe.skipIf(!DOCKER)`), and SRD-COMPLETION §8 rule 2 — a self-skipping
 * test is not an exit criterion — has already been mis-applied four times in
 * this project's history. The collector is host-side code and the truncation
 * is a `truncate(2)` on a host path, so nothing here NEEDS a container; gating
 * it would put the criterion's only evidence behind a skip.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runPaths,
  workerVerbgateLedger,
  verbgateCollectedPath,
  type RunPaths,
} from "../../src/run/paths.ts";
import {
  VerbgateCollector,
  readCollectedVerbgate,
} from "../../src/run/verbgate-collect.ts";

const roots: string[] = [];

async function makeRun(): Promise<RunPaths> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-vgc-"));
  roots.push(root);
  const run = runPaths("run-1", root);
  await mkdir(run.root, { recursive: true });
  return run;
}

/** Write rows to the ledger the WORKER owns, exactly where verbgate puts it. */
async function appendSource(run: RunPaths, worker: string, ...rows: string[]): Promise<void> {
  const p = workerVerbgateLedger(run.root, worker);
  await mkdir(dirname(p), { recursive: true });
  const existing = await readFile(p, "utf8").catch(() => "");
  await writeFile(p, existing + rows.map((r) => `${r}\n`).join(""));
}

/** The attack: `: > ledger` from inside the container. Same inode, size 0. */
async function truncateSource(run: RunPaths, worker: string): Promise<void> {
  await truncate(workerVerbgateLedger(run.root, worker), 0);
}

const ROW_A = '{"ts":"2026-08-21T10:00:00Z","tool":"kubectl","verb":"delete","decision":"refuse"}';
const ROW_B = '{"ts":"2026-08-21T10:00:01Z","tool":"git","verb":"push","decision":"allow"}';
const ROW_C = '{"ts":"2026-08-21T10:00:02Z","tool":"gcloud","verb":"auth","decision":"allow"}';

describe("VerbgateCollector", () => {
  test("collects the worker's rows to a path outside its /outbox mount", async () => {
    const run = await makeRun();
    await appendSource(run, "eng-1", ROW_A, ROW_B);

    const reports = await new VerbgateCollector(run).collectOnce();
    expect(reports).toEqual([{ worker: "eng-1", rows: 2, truncations: 0 }]);

    const collected = await readCollectedVerbgate(run, "eng-1");
    expect(collected.map((r) => r.kind)).toEqual(["row", "row"]);
    // VERBATIM. The copy is evidence, so it holds the worker's bytes as
    // written rather than a re-serialisation of a parse of them.
    expect(collected.map((r) => (r.kind === "row" ? r.line : null))).toEqual([ROW_A, ROW_B]);

    // The destination is under the run dir and NOT under the worker's outbox,
    // which is the only writable mount the worker has into the run dir.
    const dest = verbgateCollectedPath(run, "eng-1");
    expect(dest.startsWith(run.root)).toBe(true);
    expect(dest.startsWith(join(run.root, "outbox"))).toBe(false);
  });

  test("appends only what is new on the next pass", async () => {
    const run = await makeRun();
    const c = new VerbgateCollector(run);
    await appendSource(run, "eng-1", ROW_A);
    expect(await c.collectOnce()).toEqual([{ worker: "eng-1", rows: 1, truncations: 0 }]);

    // Nothing new: an idle pass must not re-copy the file.
    expect(await c.collectOnce()).toEqual([{ worker: "eng-1", rows: 0, truncations: 0 }]);

    await appendSource(run, "eng-1", ROW_B);
    expect(await c.collectOnce()).toEqual([{ worker: "eng-1", rows: 1, truncations: 0 }]);
    expect(await readCollectedVerbgate(run, "eng-1")).toHaveLength(2);
  });

  /**
   * THE PROBE for ISC-172, and the only one that is the criterion itself.
   *
   * Everything else here proves plumbing. This proves the property: the worker
   * destroys its own ledger and the host-collected copy is unchanged.
   */
  test("a worker that truncates its ledger cannot remove what was collected", async () => {
    const run = await makeRun();
    const c = new VerbgateCollector(run);
    await appendSource(run, "eng-1", ROW_A, ROW_B, ROW_C);
    await c.collectOnce();

    const before = await readCollectedVerbgate(run, "eng-1");
    expect(before.filter((r) => r.kind === "row")).toHaveLength(3);

    // The attack.
    await truncateSource(run, "eng-1");
    expect((await readFile(workerVerbgateLedger(run.root, "eng-1"), "utf8")).length).toBe(0);

    await c.collectOnce();

    const after = await readCollectedVerbgate(run, "eng-1");
    const rows = after.filter((r) => r.kind === "row");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => (r.kind === "row" ? r.line : null))).toEqual([ROW_A, ROW_B, ROW_C]);
  });

  test("records the truncation as an event rather than merely surviving it", async () => {
    const run = await makeRun();
    const c = new VerbgateCollector(run);
    await appendSource(run, "eng-1", ROW_A, ROW_B);
    await c.collectOnce();

    await truncateSource(run, "eng-1");
    expect(await c.collectOnce()).toEqual([{ worker: "eng-1", rows: 0, truncations: 1 }]);

    const after = await readCollectedVerbgate(run, "eng-1");
    const mark = after.at(-1);
    expect(mark?.kind).toBe("truncation");
    if (mark?.kind !== "truncation") throw new Error("unreachable");
    expect(mark.worker).toBe("eng-1");
    expect(mark.reasons).toEqual(["shrank"]);
    // How much had been collected when the trail was cut, and what was left.
    expect(mark.collected_bytes).toBe(ROW_A.length + ROW_B.length + 2);
    expect(mark.size_after).toBe(0);
  });

  test("keeps collecting after a truncation, in order, on the far side of the mark", async () => {
    const run = await makeRun();
    const c = new VerbgateCollector(run);
    await appendSource(run, "eng-1", ROW_A);
    await c.collectOnce();
    await truncateSource(run, "eng-1");
    await appendSource(run, "eng-1", ROW_C);
    await c.collectOnce();

    // The trail reads: what we had, THEN the cut, THEN what came after. A
    // marker appended out of order would put post-truncation rows before the
    // event that explains them.
    const after = await readCollectedVerbgate(run, "eng-1");
    expect(after.map((r) => r.kind)).toEqual(["row", "truncation", "row"]);
    expect(after[0]?.kind === "row" ? after[0].line : null).toBe(ROW_A);
    expect(after[2]?.kind === "row" ? after[2].line : null).toBe(ROW_C);
  });

  /**
   * The copy is host-owned, so the worker cannot delete from it. It can still
   * WRITE to its own ledger, and everything it writes is copied — so without
   * an envelope a worker could author a line that reads back as a collector
   * record and forge, say, a truncation that never happened, or bury a real
   * one under noise. Nesting the worker's bytes in a string field means a
   * top-level collector record is a shape the worker cannot produce.
   */
  test("a worker cannot forge a collector record", async () => {
    const run = await makeRun();
    const forged = '{"kind":"truncation","worker":"eng-1","reasons":["shrank"]}';
    await appendSource(run, "eng-1", forged);
    await new VerbgateCollector(run).collectOnce();

    const collected = await readCollectedVerbgate(run, "eng-1");
    expect(collected).toHaveLength(1);
    expect(collected[0]?.kind).toBe("row");
    expect(collected[0]?.kind === "row" ? collected[0].line : null).toBe(forged);
  });

  test("an absent ledger is normal, not an error", async () => {
    const run = await makeRun();
    // `<outbox>/ledger/` is created by NOTHING on the host — only verbgate's
    // own `mkdir -p` inside the container. A worker that has run no gated verb
    // has no ledger, and neither has a run whose containers never started.
    await mkdir(join(run.root, "outbox", "eng-1"), { recursive: true });
    expect(await new VerbgateCollector(run).collectOnce()).toEqual([]);
    expect(await readCollectedVerbgate(run, "eng-1")).toEqual([]);
  });

  test("collects every worker in the run, and no worker that has no outbox", async () => {
    const run = await makeRun();
    await appendSource(run, "eng-1", ROW_A);
    await appendSource(run, "rev-1", ROW_B);
    const reports = await new VerbgateCollector(run).collectOnce();
    expect(reports.map((r) => r.worker).sort()).toEqual(["eng-1", "rev-1"]);
    expect(await readCollectedVerbgate(run, "ghost-1")).toEqual([]);
  });

  test("survives a run directory with no outbox at all", async () => {
    const run = await makeRun();
    expect(await new VerbgateCollector(run).collectOnce()).toEqual([]);
  });
});

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true }).catch(() => {});
});
