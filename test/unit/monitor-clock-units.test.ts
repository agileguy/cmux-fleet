/**
 * THE TWO CLOCKS DO NOT GET SWAPPED (`model.ts`'s two-clocks note, ISC-155,
 * ISC-477).
 *
 * ## Why this file exists at all
 *
 * The owner's decision of 2026-09-02 made `Region.readAt` and `FleetModel.now`
 * MONOTONIC while leaving `transcriptAgeMs` and the activity ladder on WALL
 * CLOCK, because the latter's other operand is an ISO stamp written by the
 * supervisor — a different process with no monotonic origin in common.
 *
 * Both clocks are `number`. TypeScript cannot tell them apart, every call site
 * that takes one would accept the other, and **the failure is not an error but
 * a reassuring lie**:
 *
 * - Monotonic `now` minus an epoch stamp is about -1.76e12. `transcriptAgeMs`
 *   clamps at zero (`read/worker.ts`), so every worker renders `wrote 0s ago` —
 *   an entire fleet that appears to have spoken this instant.
 * - The same number reaches `grewWithin`, where a large negative is inside ANY
 *   window, so every attended worker that has ever spoken renders `active` — a
 *   liveness claim about processes that may all be finished.
 * - Wall-clock `readAt` subtracted from a monotonic `now` goes negative and
 *   clamps, so every region renders `as of 0s`: permanently, confidently fresh.
 *
 * Each of those is the most reassuring frame the monitor can draw, and each is
 * false. That is the whole reason for a dedicated file: nothing else in the
 * suite fails when the clocks are exchanged, because every number involved
 * stays a plausible number.
 *
 * ## The assertions pin MAGNITUDE, not monotonicity
 *
 * "It goes forward" is true of both clocks and therefore proves nothing. What
 * separates them is scale: `performance.now()` counts from process start and is
 * in the thousands, an epoch stamp is ~1.76e12. Every check below is written
 * against that gap, because it is the only property that actually differs.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerStateSchema, type WorkerState } from "../../src/contracts.ts";
import { deriveActivity, type WorkerFacts } from "../../src/monitor/activity.ts";
import { nowDefault } from "../../src/monitor/clocks.ts";
import { composeFleet } from "../../src/monitor/compose.ts";
import { never, regionAgeMs } from "../../src/monitor/model.ts";
import { readWorkerRow } from "../../src/monitor/read/worker.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { monotonicMs } from "../../src/util/clock.ts";

const EPOCH_FLOOR = 1_600_000_000_000;
const RUN_ID = "2026-09-02T00-00-00Z-clk1";

const bases: string[] = [];
async function fixture(tag: string, transcriptAgeMs: number | null) {
  const base = await mkdtemp(join(tmpdir(), `pifleet-clockunits-${tag}-`));
  bases.push(base);
  const root = join(base, "runs");
  const run = runPaths(RUN_ID, root);
  await mkdir(run.workersDir, { recursive: true });
  await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: RUN_ID }));
  const paths = workerPaths(run, "w-1");
  await mkdir(paths.dir, { recursive: true });
  const state: WorkerState = WorkerStateSchema.parse({
    schema: "pifleet.state/v1",
    worker: "w-1",
    run_id: RUN_ID,
    // This process: alive by construction, so the run resolves as live with no
    // fleet running.
    pid: process.pid,
    pgid: process.pid,
    epoch: 0,
    started_at: new Date().toISOString(),
    phase: "idle",
    session_present: true,
    transcript_activity:
      transcriptAgeMs === null
        ? null
        : {
            entries: 3,
            last_growth_at: new Date(Date.now() - transcriptAgeMs).toISOString(),
          },
  });
  await writeFile(paths.stateJson, JSON.stringify(state));
  /*
   * ATTENDED, and the fixture would be degenerate without it. `isAttended` is
   * false with no `presentation.json`, so the ladder short-circuits at `rpc`
   * and never reaches the transcript rungs — the exact rungs whose clock this
   * file exists to pin. A fixture that cannot reach the code under test passes
   * whatever the clocks are doing.
   */
  await writeFile(
    paths.presentationJson,
    JSON.stringify({
      schema: "pifleet.presentation/v1",
      worker: "w-1",
      backend: "cmux",
      adopted_terminal: true,
    }),
  );
  return { root, run };
}

async function cleanup() {
  for (const b of bases.splice(0)) await rm(b, { recursive: true, force: true }).catch(() => {});
}

describe("the defaults are the clocks the decision named", () => {
  test("nowDefault (readAt, due-ness) is monotonic and nowhere near an epoch stamp", () => {
    expect(nowDefault()).toBeLessThan(EPOCH_FLOOR);
    expect(Math.abs(nowDefault() - monotonicMs())).toBeLessThan(1_000);
  });

  test("a reader's readAt is monotonic when no clock is injected", async () => {
    const { run } = await fixture("readat", 60_000);
    try {
      const region = await readWorkerRow(run, "w-1");
      expect(region.status).toBe("ok");
      if (region.status !== "ok") return;
      /*
       * THE ASSERTION THAT MATTERS. A `readAt` above the epoch floor is
       * `Date.now` leaking back into the stamping path, which is ISC-155's
       * defect and would make every staleness marker jump by the length of the
       * next laptop suspend.
       */
      expect(region.readAt).toBeLessThan(EPOCH_FLOOR);
      expect(region.readAt).toBeCloseTo(monotonicMs(), -3);
    } finally {
      await cleanup();
    }
  });

  /**
   * The other half, and it must be the OTHER clock. A worker whose transcript
   * grew a minute ago has a sixty-second age; if the reader took that age from
   * its monotonic `readAt` the subtraction goes hugely negative and clamps, and
   * the row reads `wrote 0s ago` — a worker that appears to have just spoken.
   */
  test("transcriptAgeMs is wall clock, and a minute-old transcript reads as a minute", async () => {
    const { run } = await fixture("wall", 60_000);
    try {
      const region = await readWorkerRow(run, "w-1");
      if (region.status !== "ok") throw new Error("expected ok");
      expect(region.value.row.transcriptAgeMs).toBeGreaterThan(55_000);
      expect(region.value.row.transcriptAgeMs).toBeLessThan(65_000);
    } finally {
      await cleanup();
    }
  });
});

describe("the swap is detectable at every site that could make it", () => {
  /**
   * `deriveActivity` given the monotonic clock. Not a hypothetical: it is the
   * single most likely mistake in this design, because `FleetModel.now` is
   * right there and is the wrong one.
   */
  const spoken: WorkerFacts = {
    adoptedTerminal: true,
    attendedMode: "tui",
    sessionPresent: true,
    // Grew two hours ago. Unambiguously `quiet`.
    transcriptActivity: {
      entries: 9,
      last_growth_at: new Date(Date.now() - 7_200_000).toISOString(),
    },
    phase: "idle",
    containerPresent: true,
  };

  test("wall clock gives the truth: a two-hour-old transcript is quiet", () => {
    expect(deriveActivity(spoken, Date.now())).toBe("quiet");
  });

  test("the monotonic clock would call it ACTIVE, which is why the parameter is named", () => {
    /*
     * This asserts the HAZARD rather than the behaviour, and it is here so the
     * cost of the mistake is written down and re-checked. `now - grewAt` is
     * about -1.76e12, which is inside any window, so the ladder's last rung
     * answers `active`: a liveness claim about a worker that has been silent
     * for two hours. Nothing throws and no other test notices.
     */
    expect(deriveActivity(spoken, monotonicMs())).toBe("active");
  });

  /**
   * END TO END, with the real clocks, which is the only check that covers the
   * WIRING rather than the individual functions. Every function above can be
   * correct while `composeFleet` hands each one the other's clock.
   */
  test("a composed model ages a two-minute transcript as two minutes and its regions as fresh", async () => {
    const { root } = await fixture("compose", 120_000);
    try {
      /*
       * `containers: never()` — the slow clock has not run. Without it
       * `composeFleet` spawns a real `docker ps`, the fixture's container is
       * of course not in it, and `container-gone` correctly outranks every
       * transcript rung — leaving this test asserting the ladder's FIRST rung
       * while claiming to assert its last. The clocks question is orthogonal
       * to containers and the fixture now says so.
       */
      const model = await composeFleet({
        root,
        columns: 100,
        containers: never(),
      });
      expect(model.now).toBeLessThan(EPOCH_FLOOR);

      if (model.runs.status !== "ok") throw new Error(`runs not ok: ${JSON.stringify(model.runs)}`);
      const row = model.runs.value[0]?.workers[0];
      expect(row).toBeDefined();
      // Wall-clock half: two minutes, not zero.
      expect(row!.transcriptAgeMs).toBeGreaterThan(115_000);
      // …and the ladder agrees, which it could not if it held the other clock.
      expect(row!.activity).toBe("quiet");

      // Monotonic half: the read just happened, so its age is near zero — and
      // this is the assertion that fails if `readAt` were wall clock while
      // `model.now` is monotonic.
      const age = regionAgeMs(model.runs, model.now);
      expect(age).not.toBeNull();
      expect(age!).toBeLessThan(5_000);
    } finally {
      await cleanup();
    }
  });
});
