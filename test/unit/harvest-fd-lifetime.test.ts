/**
 * `harvestTask` gives its outbox descriptors back (ISC-301).
 *
 * ## The defect this exists to catch
 *
 * `scanOutboxFiles` returns `OutboxFile` entries that each hold an OPEN
 * descriptor — that is the point of the ISC-246 restatement, and `OutboxFile`
 * says so: "THE CALLER OWNS IT AND MUST CLOSE IT". `closeOutboxScan` is the
 * only thing that hands them back, and for one release it had no caller
 * anywhere in `src/` at all. `harvestTask` opened a scan, read `scan.refused`,
 * and dropped the object.
 *
 * `MAX_HELD_DESCRIPTORS` is 128, and its docstring says why that number: it is
 * "half of that 256 floor, so the scan leaves headroom for the rest of the
 * process". That reasoning is sound and it is PER SCAN. Nothing released
 * between scans, and `harvestAll` loops `harvestTask` over every task in the
 * run — so two tasks with full outboxes reach the very soft limit the cap was
 * sized against, by way of two scans that each stayed politely under it.
 *
 * ## Why an fd count and not a source grep
 *
 * A grep for `closeOutboxScan` in `harvest/index.ts` would pass against a call
 * placed somewhere it does not run — inside the `refused` loop, after an early
 * return, on the success path only. The property is not "the name appears", it
 * is "the process is not holding more descriptors afterwards", and that is
 * observable directly. `/proc/self/fd` on Linux and `/dev/fd` on macOS both
 * enumerate exactly that.
 *
 * If neither directory exists the probe FAILS rather than skipping. A test that
 * quietly declines to measure is worth less than no test, because it reports
 * the same green as one that measured and found nothing wrong.
 *
 * ## The throwing path, and how it stopped being unreachable
 *
 * This file used to say the throwing half rested on reading the code rather
 * than on a test, and that inducing a throw inside `harvestTask` needed a seam
 * it did not have. Measured, so it was not a guess: moving the release out of
 * the `finally` and onto the success path alone left both probes above green.
 *
 * The seam was the wrong thing to want. The scan's ownership now lives in
 * `withOutboxScan`, so the throwing path is reachable by passing a body that
 * throws — no hook exists in production whose only purpose is to make a test
 * possible. The last `describe` drives it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestTask } from "../../src/harvest/index.ts";
import { closeOutboxScan, scanOutboxFiles, withOutboxScan } from "../../src/harvest/outbox.ts";
import { runPaths, workerOutboxDir, type RunPaths } from "../../src/run/paths.ts";
import { cliBudget } from "../support/budget.ts";

const RUN_ID = "r-fdlife";
const WORKER = "w1";
const TASK = "t1";
/** Enough artifacts that a per-call leak is unmistakable, well under the 128 cap. */
const ARTIFACTS = 5;
/** Enough calls that ARTIFACTS * CALLS dwarfs any tolerance. */
const CALLS = 5;

/**
 * Descriptors this process currently holds.
 *
 * Both directories are themselves read through an fd that is closed before
 * `readdirSync` returns, so the count is stable between calls rather than
 * drifting by one depending on who asks.
 */
function openDescriptorCount(): number {
  const dir = existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
  if (!existsSync(dir)) {
    throw new Error(
      "neither /proc/self/fd nor /dev/fd exists, so open descriptors cannot be counted here — " +
        "this probe fails rather than skipping, because a silent skip reports the same green " +
        "as a real measurement",
    );
  }
  return readdirSync(dir).length;
}

/** A run directory with one dispatched task and a populated outbox. */
async function scaffold(): Promise<{ run: RunPaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-fdlife-"));
  const run = runPaths(RUN_ID, join(root, "runs"));
  await mkdir(run.inboxDir, { recursive: true });
  /*
   * `host_workdir: "unset"` is load-bearing, not laziness. `harvestTask` reads
   * it to decide whether a worktree exists, and skips `deriveGitFacts`
   * entirely when it does not — so the probe reaches the outbox scan without
   * standing up a real git repository it would never look at. The scan is
   * driven by the outbox, and that is the only half under measurement here.
   */
  await writeFile(
    join(run.inboxDir, `${TASK}.json`),
    JSON.stringify({
      acceptance: [],
      schema: "pifleet.task/v1",
      task_id: TASK,
      run_id: RUN_ID,
      epoch: 1,
      attempt: 1,
      worker: WORKER,
      dispatched_at: new Date().toISOString(),
      title: TASK,
      brief: "fd lifetime fixture",
      repo: root,
      host_workdir: "unset",
      container_workdir: "/workspace",
      branch: `fleet/${RUN_ID}/${WORKER}`,
      base_ref: "0000000000000000000000000000000000000000",
      outbox: `/outbox/${TASK}`,
      deadline_s: 1500,
    }),
  );

  const files = join(workerOutboxDir(run.root, WORKER), TASK, "files");
  await mkdir(files, { recursive: true });
  for (let i = 0; i < ARTIFACTS; i++) {
    await writeFile(join(files, `artifact-${i}.txt`), `artifact ${i}\n`);
  }
  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("harvestTask releases the descriptors its outbox scan holds (ISC-301)", () => {
  /**
   * THE CONTROL, and every number below is meaningless without it.
   *
   * If the scaffold produced an outbox the scan refuses — wrong directory,
   * wrong layout, entries rejected as unsafe — then `safe` is empty, no
   * descriptor is ever held, and a leak test over it passes for the one reason
   * that proves nothing. This asserts the scan really does hold `ARTIFACTS`
   * descriptors on this exact fixture, and closes them itself.
   */
  test(
    "the fixture really does make the scan hold descriptors",
    async () => {
      const { run, cleanup } = await scaffold();
      try {
        /*
         * The same `OutboxLocation` shape `harvestTask` builds at
         * `harvest/index.ts:204`, including `hostWorkdir: null` — the value it
         * derives for this fixture, because `host_workdir` is "unset". Passing
         * a narrower object here would measure a scan production never runs.
         */
        const scan = await scanOutboxFiles({
          workerOutboxDir: workerOutboxDir(run.root, WORKER),
          taskId: TASK,
          epoch: 1,
          containerWorkdir: "/workspace",
          hostWorkdir: null,
        });
        try {
          expect(scan.refused, "the fixture must not be refused").toEqual([]);
          expect(scan.safe).toHaveLength(ARTIFACTS);
        } finally {
          await closeOutboxScan(scan);
        }
      } finally {
        await cleanup();
      }
    },
    cliBudget(1),
  );

  /**
   * The regression itself: repeated harvests must not accumulate descriptors.
   *
   * Measured against a tolerance rather than exact equality, because unrelated
   * machinery may legitimately open something once and keep it — a lazily
   * initialised reader, a cached handle. The tolerance is small and the leak it
   * has to distinguish itself from is ARTIFACTS * CALLS, so the two cannot be
   * confused: before the fix this grows by 25 and the tolerance is 4.
   */
  test(
    "five harvests of a five-artifact outbox leak nothing",
    async () => {
      const { run, cleanup } = await scaffold();
      try {
        // One warm-up harvest OUTSIDE the measurement, so anything this path
        // opens once and keeps is already open when the baseline is taken and
        // cannot be charged to the loop as a leak.
        await harvestTask(run, TASK);

        const before = openDescriptorCount();
        for (let i = 0; i < CALLS; i++) await harvestTask(run, TASK);
        const after = openDescriptorCount();

        expect(
          after - before,
          `held ${before} descriptors before ${CALLS} harvests and ${after} after; ` +
            `a scan that never closes leaks ${ARTIFACTS} per call`,
        ).toBeLessThanOrEqual(4);
      } finally {
        await cleanup();
      }
    },
    cliBudget(2),
  );
});

describe("withOutboxScan gives the descriptors back however the body ends (ISC-301)", () => {
  /** The location `harvestTask` builds for this fixture, so both agree. */
  const locFor = (run: RunPaths) => ({
    workerOutboxDir: workerOutboxDir(run.root, WORKER),
    taskId: TASK,
    epoch: 1,
    containerWorkdir: "/workspace",
    hostWorkdir: null,
  });

  /**
   * THE PROBE THIS CRITERION WAS SHORT OF.
   *
   * `harvestAll` catches a failing harvest and keeps looping, so the throwing
   * path is the one that would accumulate the MOST descriptors, and until the
   * ownership moved into a combinator nothing could reach it: a mutation that
   * released only on success left every other probe in this file green.
   */
  test(
    "a body that throws still releases every descriptor",
    async () => {
      const { run, cleanup } = await scaffold();
      try {
        await withOutboxScan(locFor(run), async () => undefined);
        const before = openDescriptorCount();
        for (let i = 0; i < CALLS; i++) {
          await expect(
            withOutboxScan(locFor(run), async () => {
              throw new Error("the body failed after the scan was open");
            }),
          ).rejects.toThrow("the body failed");
        }
        expect(
          openDescriptorCount() - before,
          `${CALLS} throwing bodies must release as surely as returning ones`,
        ).toBeLessThanOrEqual(4);
      } finally {
        await cleanup();
      }
    },
    cliBudget(2),
  );

  test(
    "the body's value comes back, and the scan really held descriptors",
    async () => {
      const { run, cleanup } = await scaffold();
      try {
        const held = await withOutboxScan(locFor(run), async (scan) => scan.safe.length);
        // The control again, at this layer: a body handed an empty scan would
        // make the release probe above pass having released nothing.
        expect(held).toBe(ARTIFACTS);
      } finally {
        await cleanup();
      }
    },
    cliBudget(1),
  );

  test(
    "a body that closes the scan itself is not double-closed",
    async () => {
      const { run, cleanup } = await scaffold();
      try {
        const n = await withOutboxScan(locFor(run), async (scan) => {
          await closeOutboxScan(scan);
          return scan.safe.length;
        });
        expect(n).toBe(0);
      } finally {
        await cleanup();
      }
    },
    cliBudget(1),
  );
});
