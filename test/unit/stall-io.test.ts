/**
 * `eventSilenceMs` against a REAL filesystem (ISC-282, first half).
 *
 * ISC-110 and ISC-117 sat at `[~]` because `test/unit/scheduler-stall.test.ts`
 * drives the scheduler with a FAKE `eventSilenceMs` — it proves the policy is
 * acted on, and says nothing about whether the number handed to that policy in
 * production is a measurement of anything. This file supplies the missing
 * half: real `runPaths`, a real worker directory, a real `events.jsonl`, and
 * the function `cli/commands/dispatch.ts` actually calls.
 *
 * NO SLEEPING. A silence is manufactured with `utimes`, which moves the file's
 * real mtime into the real past — so every reading here is a genuine mtime
 * subtraction and not a simulated one, and a 4-minute silence costs no wall
 * clock. A test that slept would be both slower and weaker: it could only ever
 * reach silences small enough to be confused with scheduling jitter.
 *
 * The second half — whether the `abort` RPC ends a wedged agent — needs a live
 * supervisor and lives in `test/integration/supervisor.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, appendFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { eventSilenceMs } from "../../src/run/stall-io.ts";

/** A run tree with `worker`'s directory made, and nothing else. */
async function freshRun(worker: string): Promise<{ root: string; run: ReturnType<typeof runPaths> }> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-silence-"));
  const run = runPaths("silence-run", root);
  await mkdir(workerPaths(run, worker).dir, { recursive: true });
  return { root, run };
}

/** Backdate `path`'s mtime by `ms`, so a real silence exists to measure. */
async function backdate(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

describe("eventSilenceMs measures a worker's real event silence (ISC-282)", () => {
  test("an appended event moves the reading back to ~0", async () => {
    const { root, run } = await freshRun("eng-1");
    try {
      const events = workerPaths(run, "eng-1").eventsJsonl;
      await writeFile(events, `${JSON.stringify({ type: "agent_start" })}\n`);
      await backdate(events, 240_000);

      // THE MEASUREMENT: four minutes of real mtime distance, read back.
      const before = await eventSilenceMs(run, "eng-1");
      expect(before).not.toBeNull();
      expect(before!).toBeGreaterThanOrEqual(239_000);

      // THE CRITERION's first question, in its own words: does an appended
      // event actually move the reading?
      await appendFile(events, `${JSON.stringify({ type: "turn_start" })}\n`);
      const after = await eventSilenceMs(run, "eng-1");
      expect(after).not.toBeNull();
      expect(after!).toBeLessThan(5_000);
      expect(after!).toBeLessThan(before!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * The question the criterion asks second, and the one with teeth: a worker
   * that has emitted NOTHING must not read as maximally wedged. `null` is not
   * a stand-in for a large number here — `classifyStall` is never consulted on
   * it, so a worker still starting up cannot be killed for the silence of a
   * file its supervisor has not yet touched.
   */
  test("an absent events.jsonl answers null, not an infinite silence", async () => {
    const { root, run } = await freshRun("eng-1");
    try {
      // The worker DIRECTORY exists — this is a launched worker mid-start, not
      // a typo'd worker id, and the two must not be distinguishable here.
      expect(await eventSilenceMs(run, "eng-1")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unknown worker answers null rather than throwing", async () => {
    const { root, run } = await freshRun("eng-1");
    try {
      expect(await eventSilenceMs(run, "no-such-worker")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Per-worker, and asserted because the adapter's whole signature is
   * `(worker)` — a reading that came from the wrong file would still look like
   * a plausible duration, and would exempt a genuinely wedged worker for as
   * long as any OTHER worker kept talking.
   */
  test("one worker's appends do not move another's reading", async () => {
    const { root, run } = await freshRun("eng-1");
    try {
      await mkdir(workerPaths(run, "eng-2").dir, { recursive: true });
      const a = workerPaths(run, "eng-1").eventsJsonl;
      const b = workerPaths(run, "eng-2").eventsJsonl;
      await writeFile(a, "{}\n");
      await writeFile(b, "{}\n");
      await backdate(a, 300_000);

      await appendFile(b, "{}\n");

      const quiet = await eventSilenceMs(run, "eng-1");
      const busy = await eventSilenceMs(run, "eng-2");
      expect(quiet!).toBeGreaterThanOrEqual(299_000);
      expect(busy!).toBeLessThan(5_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * It reads the path `workerPaths` DERIVES, not one that happens to match.
   *
   * Without this, the module could read `<dir>/events.jsonl` by coincidence
   * and every test above would still pass while production, whose layout comes
   * from `run/paths.ts`, read nothing. Asserted by moving the mtime on the
   * derived path and observing THAT number come back.
   */
  test("the file it stats is the one workerPaths names", async () => {
    const { root, run } = await freshRun("eng-1");
    try {
      const derived = workerPaths(run, "eng-1").eventsJsonl;
      await writeFile(derived, "{}\n");
      await backdate(derived, 123_000);
      const st = await stat(derived);
      const reading = await eventSilenceMs(run, "eng-1");
      // Same file, same clock, so the two agree to within the test's own
      // execution time rather than approximately.
      expect(Math.abs(reading! - (Date.now() - st.mtimeMs))).toBeLessThan(1_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A future mtime clamps to 0 rather than going negative.
   *
   * A negative silence compares below every threshold, so it would silently
   * exempt that worker from the stall policy for as long as the skew lasted —
   * a wedged worker made immortal by a clock step, which is the failure
   * direction that does not announce itself.
   */
  test("an mtime in the future reads 0, never a negative silence", async () => {
    const { root, run } = await freshRun("eng-1");
    try {
      const events = workerPaths(run, "eng-1").eventsJsonl;
      await writeFile(events, "{}\n");
      await backdate(events, -600_000);
      const reading = await eventSilenceMs(run, "eng-1");
      expect(reading).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * The injected clock is a PARAMETER and not the scheduler's `io.now()`, and
   * this pins the difference. `scheduler.ts` runs its stall poll against a
   * clock a test may have faked to 1970 or to 10× speed; subtracting a real
   * filesystem mtime from that would not be a duration at all. Production
   * passes no `now`, so the default is the only one that ships.
   */
  test("the clock is the caller's, and both readings come from it", async () => {
    const { root, run } = await freshRun("eng-1");
    try {
      const events = workerPaths(run, "eng-1").eventsJsonl;
      await writeFile(events, "{}\n");
      const st = await stat(events);
      const frozen = st.mtimeMs + 45_000;
      expect(await eventSilenceMs(run, "eng-1", () => frozen)).toBe(45_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The delegation itself, because the whole design above rests on it.
 *
 * Everything in this file and in `supervisor.test.ts`'s ISC-282 block drives
 * `run/stall-io.ts`. That is only evidence about production while
 * `cli/commands/dispatch.ts` keeps calling it — re-inline either behaviour
 * into the adapter and every probe here stays green over code nothing runs,
 * which is precisely the RC-1 shape that put ISC-282 on the board.
 *
 * A source sweep is the weakest instrument available and is used here for the
 * reason `test/support/env-sweep.ts` gives: the object it would rather inspect
 * cannot be constructed. `const io: SchedulerIO = {...}` is built inside
 * `register()`'s action handler, closed over a `run` and a `ledger` that exist
 * only during a CLI invocation — the very fact that motivated the extraction.
 */
describe("the dispatch adapter delegates rather than reimplementing (ISC-282)", () => {
  test("both methods call this module, and neither carries the behaviour back", async () => {
    const { stripComments } = await import("../support/source-structure.ts");
    const src = stripComments(
      await Bun.file(new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname).text(),
    );

    expect(src).toContain('from "../../run/stall-io.ts"');
    expect(src).toContain("return eventSilenceMs(run, worker);");
    expect(src).toContain("await abortWedged({ run, worker, taskId, ledger });");

    // The two things that would mean the behaviour came home. `controlCall`
    // itself is NOT banned — dispatch legitimately speaks it to send an
    // envelope — so the abort is pinned by its own verb instead.
    expect(src).not.toContain("mtimeMs");
    expect(src).not.toContain('cmd: "abort"');
  });
});
