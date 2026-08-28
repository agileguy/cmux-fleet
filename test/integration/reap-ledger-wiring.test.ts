/**
 * ISC-300's reporting half, at the only layer an operator can see it.
 *
 * ## The gap these probes exist to close
 *
 * `ReapReport.group` was added so a reap could say WHICH action it took about
 * the process group — `addressed`, `narrowed_to_leader`, or `none`. Three unit
 * probes in `reaper.test.ts` assert `reapSupervisor` returns it, and they
 * passed from the day they were written.
 *
 * They were not enough, and the reason is the one SRD-COMPLETION §8 rule 3
 * exists for. `reapSupervisor`'s return value is not the permanent record; the
 * daemon's ledger is. The daemon built its ledger row inside a callback,
 * copying `supervisor` and `container` across and silently dropping `group`, so
 * the field an operator was given to read never appeared in the file they read
 * it in. Every test stayed green — the return value was correct, and no test
 * could reach the callback that discarded it.
 *
 * That is the same failure `verbgate-collect-wiring.test.ts` was written for
 * ("correct code, green tests, and no worker's ledger ever actually
 * collected"), and this file is its analogue for the reaper.
 *
 * ## What these probes cover, and what they do NOT
 *
 * They drive `recordReaps` — the production mapping, now a named export rather
 * than a closure — with a real `LedgerWriter`, and read the row back OFF DISK.
 * A mapping that drops a field, or a `LedgerRecord` schema that refuses to
 * carry one, fails here.
 *
 * They do not start `pifleet daemon`. Between these probes and production sits
 * one line — the `onReap` hook's call to `recordReaps` — and nothing here would
 * notice if that line were deleted. Stated rather than implied: the reachable
 * mapping is the part that had rotted, and shrinking the unreachable part to a
 * single call site is what this file buys, not eliminating it.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordReaps } from "../../src/cli/commands/daemon.ts";
import { LedgerWriter, mergeLedger } from "../../src/run/ledger.ts";
import { runPaths, type RunPaths } from "../../src/run/paths.ts";
import type { ReapReport } from "../../src/safety/reaper.ts";
import { cliBudget } from "../support/budget.ts";

async function scratchRun(): Promise<{ run: RunPaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-reapledger-"));
  const run = runPaths(`r-rl-${process.pid.toString(36)}`, root);
  await mkdir(run.root, { recursive: true });
  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A reap report with everything but the field under test held constant. */
function report(group: ReapReport["group"], over: Partial<ReapReport> = {}): ReapReport {
  return {
    worker: "eng-1",
    supervisor: "terminated",
    container: "removed",
    group,
    ...over,
  };
}

/** Every row `recordReaps` wrote, in shard order. */
async function rows(run: RunPaths): Promise<{ event: string; detail: Record<string, unknown> }[]> {
  const { records, errors } = await mergeLedger(run);
  expect(errors, "the ledger shard must parse").toEqual([]);
  return records.map((r) => ({ event: r.event, detail: (r.detail ?? {}) as Record<string, unknown> }));
}

describe("a reap's ledger row carries the group action (ISC-300)", () => {
  /**
   * The regression, stated as the criterion's reporting half states it: a
   * narrowing must be legible to whoever reads the record afterwards.
   *
   * This is the assertion that was missing. Before `recordReaps` existed the
   * row said `supervisor` and `container` and nothing else, so the one case
   * this criterion is about — a recorded group whose record could not be
   * trusted, signalled as the leader alone — was indistinguishable in the
   * permanent record from an ordinary reap of a target that never had a group.
   */
  test(
    "a narrowing is named in the row, not just in the return value",
    async () => {
      const { run, cleanup } = await scratchRun();
      try {
        await recordReaps(new LedgerWriter(run, "daemon"), [report("narrowed_to_leader")], () => {
          throw new Error("no ledger write should have failed");
        });
        const [row] = await rows(run);
        expect(row?.detail.group).toBe("narrowed_to_leader");
      } finally {
        await cleanup();
      }
    },
    cliBudget(1),
  );

  /**
   * All three values survive the round trip, and they survive it DISTINCTLY.
   *
   * Asserting only the narrowing would pass against a mapping that hard-coded
   * the string, which is the degenerate way to satisfy the probe above.
   */
  test(
    "addressed, narrowed_to_leader and none are each written as themselves",
    async () => {
      const { run, cleanup } = await scratchRun();
      try {
        const groups: ReapReport["group"][] = ["addressed", "narrowed_to_leader", "none"];
        await recordReaps(
          new LedgerWriter(run, "daemon"),
          groups.map((g, i) => report(g, { worker: `eng-${i}` })),
          () => {
            throw new Error("no ledger write should have failed");
          },
        );
        expect((await rows(run)).map((r) => r.detail.group)).toEqual(groups);
      } finally {
        await cleanup();
      }
    },
    cliBudget(1),
  );

  /**
   * The row a refusal writes is the one an operator actually goes looking for,
   * so the group action has to be on THAT row too — not only on the happy path.
   *
   * `worker_reap_refused` is asserted by its literal name rather than by
   * calling `reapEventName`, which would check the production mapping against
   * itself.
   */
  test(
    "a refused reap is named as a refusal and still reports the group",
    async () => {
      const { run, cleanup } = await scratchRun();
      try {
        await recordReaps(
          new LedgerWriter(run, "daemon"),
          [report("narrowed_to_leader", { supervisor: "group_unconfirmed", container: "spared" })],
          () => {
            throw new Error("no ledger write should have failed");
          },
        );
        const [row] = await rows(run);
        expect(row?.event).toBe("worker_reap_refused");
        expect(row?.detail).toMatchObject({
          supervisor: "group_unconfirmed",
          container: "spared",
          group: "narrowed_to_leader",
        });
      } finally {
        await cleanup();
      }
    },
    cliBudget(1),
  );

  /**
   * A failing ledger write is REPORTED and does not escape.
   *
   * The hook this replaced voided its promises, so a rejection could only ever
   * have surfaced through its own `.catch`. Keeping that property explicit
   * matters more now that the call is awaited: a throw here would propagate
   * into whatever awaits `recordReaps`, and in production that is the scan
   * loop's `void`, where it would become an unhandled rejection.
   */
  test(
    "a ledger failure is handed to onError rather than thrown",
    async () => {
      const { run, cleanup } = await scratchRun();
      try {
        const broken = {
          append: () => Promise.reject(new Error("disk gone")),
        } as unknown as LedgerWriter;
        const seen: string[] = [];
        await recordReaps(broken, [report("addressed")], (m) => seen.push(m));
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain("eng-1");
      } finally {
        await cleanup();
      }
    },
    cliBudget(1),
  );
});
