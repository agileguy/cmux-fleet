/**
 * ISC-172, the half a unit test cannot reach: the collector's PRODUCTION CALLER.
 *
 * `test/unit/verbgate-collect.test.ts` proves what `VerbgateCollector` does when
 * something calls it. That is the module, not the criterion — SRD-COMPLETION §8
 * rule 3, the rule that put eight criteria in this ISA into RC-1, and the exact
 * shape ISC-172 would fail in if the collector shipped unwired: correct code,
 * green tests, and no worker's ledger ever actually collected.
 *
 * So these probes never construct a `VerbgateCollector`. They drive
 * `startRegistryDaemon` — the thing `up` actually launches — and assert the
 * copy appears on disk. Both call sites are covered, because they fail
 * differently:
 *
 *   - THE TICK is the ongoing guarantee. Without it nothing is collected until
 *     teardown, so a worker that writes and truncates during the run leaves no
 *     trace at all.
 *   - THE FINAL PASS is the teardown guarantee. `down` removes the containers
 *     and then stops this daemon, so without it the trail ends at the last
 *     periodic tick and every gated verb between that tick and teardown is
 *     lost — including anything a worker did precisely because it was being
 *     shut down.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runPaths, workerVerbgateLedger, type RunPaths } from "../../src/run/paths.ts";
import { socketRequest, startRegistryDaemon } from "../../src/run/registry.ts";
import { readCollectedVerbgate } from "../../src/run/verbgate-collect.ts";
import { loadControlSecret } from "../../src/security/control-auth.ts";
import { cliBudget } from "../support/budget.ts";

async function scratchRun(): Promise<{ run: RunPaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-vgwire-"));
  // Unique per process for the same reason reaper.test.ts states: `socketPath`
  // hashes (run_id, worker) into the SHARED os.tmpdir(), so a fixed id makes two
  // concurrent test processes bind one socket and answer each other's RPCs.
  const run = runPaths(
    `r-vgw-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    root,
  );
  await mkdir(run.root, { recursive: true });
  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Write one verbgate row where the container's bind mount would put it. */
async function appendLedger(run: RunPaths, worker: string, row: object): Promise<void> {
  const p = workerVerbgateLedger(run.root, worker);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(row)}\n`, { flag: "a" });
}

const ROW = { ts: "2026-08-21T00:00:00Z", decision: "refuse", verb: "delete", task: "T-1" };

async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe("the verbgate collector has a production caller (ISC-172)", () => {
  test("the daemon's own tick collects a worker's ledger, unprompted", async () => {
    const { run, cleanup } = await scratchRun();
    // A reaper config is required for the tick to exist at all; `readState`
    // answers for no worker, so the reap half is inert and only the collector
    // does anything. The point of this probe is that NOTHING here calls the
    // collector — the interval does.
    const daemon = await startRegistryDaemon(run, {
      reaper: {
        heartbeatIntervalMs: 1_000,
        scanIntervalMs: 40,
        readState: () => Promise.resolve(null),
        now: () => 0,
      },
    });
    try {
      await appendLedger(run, "eng-1", ROW);
      const collected = await waitFor(
        async () => (await readCollectedVerbgate(run, "eng-1")).length > 0,
        2_000,
      );
      expect(collected).toBe(true);
      const rows = await readCollectedVerbgate(run, "eng-1");
      expect(rows.some((r) => r.kind === "row")).toBe(true);
    } finally {
      await daemon.stop();
      await cleanup();
    }
  },
    /*
     * The count is honest about what it covers. The guard's call graph reaches
     * `ps` through the reaper, so a budget is required — but no worker is
     * registered here, so no `ps` is ever actually spawned. What the budget has
     * to dominate is the explicit wait ceiling above, and cliBudget(1)'s
     * 11_400 ms clears it several times over even under a loaded suite.
     */
    cliBudget(1),
  );

  test("shutdown takes one last pass, so the trail does not end at the last tick", async () => {
    const { run, cleanup } = await scratchRun();
    // The interval is set FAR beyond the test's life, so it cannot fire even
    // once. Anything collected here was collected by the shutdown path and by
    // nothing else — without that, this probe would pass on the tick's work and
    // prove nothing about teardown.
    const daemon = await startRegistryDaemon(run, {
      reaper: {
        heartbeatIntervalMs: 1_000,
        scanIntervalMs: 3_600_000,
        readState: () => Promise.resolve(null),
        now: () => 0,
      },
    });
    let cleanedUp = false;
    try {
      await appendLedger(run, "eng-1", ROW);
      // Nothing collected yet: proving the interval really is inert, so the
      // assertion below cannot be satisfied by a tick that fired early.
      expect(await readCollectedVerbgate(run, "eng-1")).toEqual([]);

      const secret = await loadControlSecret(run);
      await socketRequest(run.daemonSock, { cmd: "shutdown" }, { secret });

      const collected = await waitFor(
        async () => (await readCollectedVerbgate(run, "eng-1")).length > 0,
        3_000,
      );
      expect(collected).toBe(true);
      cleanedUp = true;
    } finally {
      if (!cleanedUp) await daemon.stop();
      await cleanup();
    }
  },
    /*
     * The count is honest about what it covers. The guard's call graph reaches
     * `ps` through the reaper, so a budget is required — but no worker is
     * registered here, so no `ps` is ever actually spawned. What the budget has
     * to dominate is the explicit wait ceiling above, and cliBudget(1)'s
     * 11_400 ms clears it several times over even under a loaded suite.
     */
    cliBudget(1),
  );
});
