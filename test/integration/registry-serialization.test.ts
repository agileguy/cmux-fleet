/**
 * Registry writes are serialized (ISC-186).
 *
 * `registry.json` has a single writer — the daemon — but "single writer" is a
 * statement about processes, not about overlapping writes inside one. Each
 * socket line is handled in its own detached async task, so N supervisors
 * registering during `up` land in the same tick. Unique temp names (ISC-168)
 * stop the file from TEARING; they do nothing about ORDER. Two `writeJsonAtomic`
 * calls in flight against one path finish in whatever order the fs threadpool
 * returns them, and the later rename wins — so a write carrying an older
 * snapshot can land last and erase a worker that had already registered. A lost
 * registration silently downgrades that worker's liveness detection to the
 * pid-only path, which is the failure `(pid, started)` identity exists to avoid.
 *
 * WHY THIS PROBE ASSERTS THE MECHANISM AND NOT ONLY THE CONSEQUENCE. The
 * obvious test — fire N concurrent registrations, assert all N are on disk —
 * does detect this, but only SOMETIMES, and the difference matters enough to
 * write down. Measured directly, with `persist()` calling `writeJsonAtomic`
 * instead of going through `serialized()`: the consequence alone failed 18 of
 * 20 runs with no sampler present and 17 of 20 with one, losing a contiguous
 * tail of the newest registrations (`w-11` alone at best, `w-2`…`w-11` at
 * worst). Two and three runs respectively came back green over a race that was
 * live the whole time.
 *
 * A detector that green-lights an unguarded race one run in eight is worse to
 * rest a criterion on than no detector at all, because it teaches whoever hits
 * the red to re-run until it passes. The sampler is the far stronger
 * instrument: `maxConcurrent` read 12 or 13 with the chain bypassed and 1 with
 * it intact, on 20 of 20 runs each, the two distributions nowhere near
 * touching. So the mechanism assertion is the one the criterion rests on and
 * the consequence rides along behind it.
 *
 * Note that the padding below is what makes the flakiness that shape. An
 * earlier revision of this comment argued the consequence could NEVER see the
 * race, reasoning that a later-starting write carries a superset of an earlier
 * one and is therefore larger, so it finishes later and lands last — size and
 * recency correlating in the safe direction. The filler destroys that
 * correlation rather than relying on it: one more worker adds 167 bytes to a
 * 524,562-byte write, a 0.03% step that fs threadpool scheduling noise swamps
 * completely. Completion order is therefore roughly independent of snapshot
 * recency, which is why the losses run the OTHER way — the newest registrations
 * are the ones that disappear.
 *
 * BOTH WRITERS ARE PINNED. `run.registryJson` has exactly two: `persist()`
 * (registry.ts:349) and the reaper's post-scan deregistration (registry.ts:430).
 * The test drives a reap concurrently with the registration burst so the second
 * writer is in flight alongside the first, because a test that exercises only
 * `persist()` stays green when `serialized()` is deleted from the reaper —
 * which is precisely the risk the docstring at registry.ts:290-295 names.
 */

import { describe, expect, test } from "bun:test";
import {
  RegistrySchema,
  readRegistry,
  socketRequest,
  startRegistryDaemon,
} from "../../src/run/registry.ts";
import { WorkerStateSchema, type WorkerState } from "../../src/contracts.ts";
import { runPaths, type RunPaths } from "../../src/run/paths.ts";
import { loadControlSecret } from "../../src/security/control-auth.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cliBudget } from "../support/budget.ts";

/** How many supervisors register at once. `up` fans out on this order. */
const CONCURRENT_REGISTRATIONS = 12;

/** Pre-seeded workers the reaper deregisters, putting writer two in flight. */
const STALE_WORKERS = ["stale-a", "stale-b", "stale-c"];

/**
 * Padding that makes each registry write large enough to have a duration.
 *
 * Not decoration. A write that completes inside a single event-loop turn is
 * one the sampler below can miss entirely, and a probe that cannot observe the
 * thing it is asserting the absence of is a probe that always passes. ~512 KiB
 * of filler puts every `registry.json` write in the millisecond range, which is
 * hundreds of `readdir` samples wide.
 *
 * It is planted on DISK before the daemon starts rather than registered over
 * the socket: `socketRequest` writes a request in one `socket.write` and does
 * not handle backpressure, so a multi-hundred-KiB verb is not a thing this
 * transport can carry. The daemon seeds its in-memory registry from the file.
 *
 * It rides on `registered_at`, which nothing in `src/` reads — it is written
 * once by the supervisor (supervisor/index.ts:183) and never consumed. It used
 * to ride on `started`, which is half of the `(pid, started)` liveness identity
 * and is read by `identityAlive`, `sameIdentity`, `reapSupervisor` and
 * `status`. Schema validation would have caught a shape drift either way, but
 * "half a liveness identity" is a poor place to park 512 KiB of `x`, and the
 * reaper this test now drives reads exactly that field.
 */
const FILLER_BYTES = 512 * 1024;

/**
 * How long the sampler pauses between `readdir` calls (ISC-266).
 *
 * READ THIS BEFORE "FIXING" IT BACK, in either direction. Review raised two
 * concerns about the original undelayed `while (!stop)` readdir loop: that it
 * starves the writes it measures (`readdir` shares libuv's 4-thread pool with
 * `writeJsonAtomic`'s open/write/fsync/rename), and that it pins a core for the
 * test's duration, which matters on a 2-core CI runner. Both are plausible.
 * BOTH WERE MEASURED, AND NEITHER IS TRUE HERE.
 *
 *   - Starvation: interleaved A/B, yield vs undelayed, alternating so ambient
 *     load hits both arms equally. Idle-ish: 26-31 ms either way, no separation.
 *     Under `LOAD_PROCS=32`: yield won 3 pairs of 6, undelayed won 3, ranges
 *     3.5-7.9 s and 4.9-6.7 s — fully overlapping. The pause does not move the
 *     test's wall clock at any load level tried.
 *   - Core-pinning: same interleaved design on CPU time rather than wall time,
 *     because that is what the claim is about. 0.09-0.11 s of user+sys either
 *     way, indistinguishable. The loop LOOKS like a spin but is I/O-bound —
 *     every iteration awaits a real `readdir` syscall, so it is descheduled for
 *     almost all of its life and never had a core to pin.
 *
 * So the pause is NOT what makes this test fit its budget; the derived budget
 * at the bottom of the test is. An earlier revision of this comment claimed the
 * undelayed loop inflated the burst from ~30 ms to ~110 ms and that removing it
 * was the fix for a timeout. That number was inferred from a sample count, not
 * measured, and the A/B above refutes it. It is called out rather than quietly
 * deleted because it is the same error this whole file is about.
 *
 * IT IS KEPT ANYWAY, for the one path where the loop genuinely has no I/O to
 * pace it: `catch { continue }`. If `readdir` starts failing fast — the run
 * directory torn down under the sampler, which is exactly when this fires — the
 * undelayed loop becomes a real busy loop with no syscall in it. One
 * `Bun.sleep` at the TOP of the body covers that path and the success path
 * together, because `continue` re-enters at the loop head. Zero, not one: `1`
 * was tried and takes `samples` from ~100 down to 12, which trips the vacuity
 * guard below, and it buys nothing since there was no CPU cost to buy back.
 * The repo's convention is that a poll always yields (`doctor-omlx.test.ts`
 * states it outright; `control-auth.test.ts` and `steer.test.ts` follow it).
 */
const SAMPLE_PAUSE_MS = 0;

async function scratchRun(): Promise<{ run: RunPaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-regser-"));
  // Unique per process: `socketPath` hashes (run_id, worker) into the SHARED
  // os.tmpdir(), so a fixed id makes two concurrent test processes bind the
  // same daemon socket and answer each other's RPCs.
  const run = runPaths(
    `r-ser-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    root,
  );
  await mkdir(run.root, { recursive: true });
  return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function entry(worker: string) {
  return {
    worker,
    pid: 1,
    pgid: 0,
    started: "Mon Jul 27 09:00:00 2026",
    registered_at: "2026-07-27T09:00:00Z",
  };
}

/** A schema-valid state whose only load-bearing field is `heartbeat_at`. */
function state(worker: string, heartbeatAt: string | null): WorkerState {
  return WorkerStateSchema.parse({
    schema: "pifleet.state/v1",
    worker,
    run_id: "r",
    pid: 1,
    pgid: 0,
    started_at: "2026-07-27T09:00:00Z",
    phase: "idle",
    epoch: 0,
    heartbeat_at: heartbeatAt,
  });
}

/**
 * Watch a directory for `writeJsonAtomic` temp files belonging to one target.
 *
 * `writeJsonAtomic` creates `<path>.tmp-<pid>-<uuid>` and renames it away, so a
 * temp file is visible for precisely the span of one write to that path. Two of
 * them at one instant is two writes in flight.
 */
function watchTempFiles(target: string) {
  const dir = dirname(target);
  const prefix = `${basename(target)}.tmp-`;
  const seen = new Set<string>();
  let maxConcurrent = 0;
  let samples = 0;
  let stop = false;

  const loop = (async () => {
    while (!stop) {
      // First statement in the body ON PURPOSE — see SAMPLE_PAUSE_MS. The
      // `continue` below re-enters here, so the error path cannot spin either.
      await Bun.sleep(SAMPLE_PAUSE_MS);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // directory torn down under us; the caller is finishing.
      }
      const temps = names.filter((n) => n.startsWith(prefix));
      for (const t of temps) seen.add(t);
      if (temps.length > maxConcurrent) maxConcurrent = temps.length;
      samples++;
    }
  })();

  return {
    /**
     * Idempotent, and called twice on the happy path on purpose: once in the
     * body to read the counters while the run directory still exists, once in
     * the `finally` so an assertion that throws before the first call still
     * stops the loop. A spinning sampler outlives the test otherwise — bun
     * runs integration files serially in one process. The second call re-reads
     * settled counters and discards them.
     */
    async finish() {
      stop = true;
      await loop;
      return { maxConcurrent, distinctSeen: seen.size, samples };
    },
  };
}

describe("registry writes are serialized (ISC-186)", () => {
  /**
   * Fails if: either write chain is removed or bypassed, or a third write path
   * to `registry.json` is added alongside them.
   *
   * Mutation-verified against both writers, with different strengths worth
   * knowing. Bypassing `serialized()` in `persist()` is caught 20 of 20 —
   * twelve writes go concurrent at once and `maxConcurrent` reads 12 or 13.
   * Bypassing it in the reaper is caught 19 of 20: that mutation puts exactly
   * ONE write outside the chain, so it is caught only when it overlaps a
   * registration write, and roughly one run in twenty it lands in a gap. That
   * is recorded rather than rounded up, and it is not tuned to 20 of 20 by
   * arranging the timing — a probe that only works because the writes were
   * nudged into overlapping is a worse guarantee than one that admits its rate.
   */
  test("concurrent registrations and a reap never put two writes in flight, and none is lost", async () => {
    const { run, cleanup } = await scratchRun();
    // Everything that can throw is inside the `try`. The seed write and the
    // daemon start used to sit above it, so a throw in either leaked a 512 KiB
    // scratch directory into /tmp for the life of the machine.
    try {
      // Seeded on disk so every registry write has a duration worth sampling.
      // Written through the schema so a drift in the registry shape breaks this
      // setup loudly rather than being silently rejected at daemon start.
      const seeded = Object.fromEntries([
        ["filler", { ...entry("filler"), registered_at: "x".repeat(FILLER_BYTES) }],
        ...STALE_WORKERS.map((w) => [w, entry(w)]),
      ]);
      await writeJsonAtomic(
        run.registryJson,
        RegistrySchema.parse({
          schema: "pifleet.registry/v1",
          run_id: run.runId,
          daemon: { pid: 0, started: "" },
          workers: seeded,
        }),
      );

      // A hand-driven clock and stubbed process ops, so the reap is
      // deterministic: no timer to race, no real signal sent, no grace period
      // waited out. `startTime: null` means "already gone", which short-circuits
      // the kill ladder to a report without touching the machine.
      let clock = 0;
      let beat = 0;
      const daemon = await startRegistryDaemon(run, {
        reaper: {
          heartbeatIntervalMs: 1, // stale at 3ms on the clock below
          // The scan period is pushed out of the way so the ONLY scans are the
          // two below. It defaults to `heartbeatIntervalMs`, which would put a
          // background timer on a 1 ms period racing the hand-driven ones —
          // and it did: the timer reaped everything the instant the clock
          // advanced, and the explicit scan then found nothing to do.
          scanIntervalMs: 60 * 60 * 1000,
          now: () => clock,
          // `filler` reports a CHANGING heartbeat, so its stopwatch restarts
          // every scan and it is never stale. Everything else reports a
          // constant `null`, which is what staleness looks like.
          readState: async (w) => (w === "filler" ? state(w, `beat-${beat++}`) : null),
          ops: {
            startTime: async () => null,
            signal: () => {},
            removeContainer: async () => "absent",
          },
        },
      });
      const watcher = watchTempFiles(run.registryJson);
      try {
        // Scan one only OBSERVES — a worker gets a full window before it can be
        // called stale, so nothing is reaped and nothing is written yet.
        expect(await daemon.reapOnce()).toEqual([]);
        clock += 100;

        const secret = await loadControlSecret(run);
        const names = Array.from({ length: CONCURRENT_REGISTRATIONS }, (_, i) => `w-${i}`);
        // The reap goes out WITH the burst, not before it: writer two has to be
        // in flight against writer one for the sampler to say anything about
        // the two of them together.
        const [reaped] = await Promise.all([
          daemon.reapOnce(),
          ...names.map((w) =>
            socketRequest(run.daemonSock, { cmd: "register_worker", entry: entry(w) }, { secret }),
          ),
        ]);

        const { maxConcurrent, distinctSeen, samples } = await watcher.finish();

        // The reaper really did run and really did write. Without this the
        // second writer could quietly stop being exercised — `reapOnce` returns
        // `[]` and writes nothing when `opts.reaper` is undefined — and the rest
        // of this test would still pass having pinned only `persist()`.
        expect(reaped.map((r) => r.worker).sort()).toEqual([...STALE_WORKERS].sort());

        // The sampler was actually looking. Without these two, a watcher that
        // never ran — or that ran only before the burst — reports "no overlap"
        // having observed nothing, which is the shape of green this repo has
        // spent a session removing.
        //
        // The bar is half the writes because CI's contended two-core runner
        // samples less often than a workstation; the margin measured here is
        // much wider than that. Instrumented on this machine with the sampler
        // yielding as it does now: distinctSeen 13 of 13 on every one of 8
        // runs, over 95-113 samples — nearly 8x the bar, and every write still
        // caught in flight despite the loop no longer spinning.
        //
        // `samples` IS thinner when the chain is bypassed — 21-28, because an
        // unserialized burst is over in less wall-clock — and that was raised in
        // review as a reason to gate on elapsed sampling time instead. Measured
        // and deliberately not changed: the guard exists to stop a VACUOUS
        // GREEN, and green only happens with the chain intact, which is the
        // 95-113 case. In the red case a thin count cannot produce a false pass,
        // only a less specific failure — and it does not even do that here, as
        // 21 still clears 12 and `maxConcurrent` is what actually fails. The
        // coverage guard below is the load-bearing one in both directions
        // anyway: distinctSeen read 13 of 13 in every configuration tried,
        // bypassed or intact.
        expect(samples).toBeGreaterThan(CONCURRENT_REGISTRATIONS);
        expect(distinctSeen).toBeGreaterThanOrEqual(CONCURRENT_REGISTRATIONS / 2);

        // The criterion's mechanism. Catching this many separate writes in
        // flight without ever catching two at once is only possible if they did
        // not overlap.
        expect(maxConcurrent).toBe(1);

        // And its consequence, on the file every other process reads: every
        // registration survived, and the reaper's deletions landed.
        const onDisk = await readRegistry(run);
        expect(Object.keys(onDisk?.workers ?? {}).sort()).toEqual(["filler", ...names].sort());
      } finally {
        await watcher.finish();
        await daemon.stop();
      }
    } finally {
      await cleanup();
    }
    // ISC-266 audit. SPAWN COUNT IS ONE, counted rather than estimated:
    // `startRegistryDaemon` calls `processStartTime(process.pid)`
    // (registry.ts:321), which is a `ps` subprocess. Nothing else here spawns —
    // `loadControlSecret`, `socketRequest` and `writeJsonAtomic` are all
    // in-process, and the reaper's `ops.startTime`/`removeContainer` are stubbed
    // precisely so no ladder ever shells out. So `cliBudget(1)` = 11_400 ms.
    //
    // `cliBudget` is charged at the EXPENSIVE spawn rate (PER_SPAWN_IDLE_MS =
    // 1900, calibrated on `bun run <cli> report`), and a `ps` is nowhere near
    // that. That over-estimate is the helper's stated design — "costing every
    // spawn at the expensive rate is deliberate" — and here it is doing useful
    // work, because this test's real cost is not the spawn at all. It is
    // fifteen ~512 KiB atomic writes to `registry.json` (one seed, one
    // daemon-start persist, twelve registrations, one reap), each an
    // open/write/fsync/rename plus a directory fsync, and fsync latency is what
    // degrades under contention.
    //
    // MEASURED, because the previous version of this test carried no explicit
    // budget at all, passed CI green, and then failed at `LOAD_PROCS=32`:
    //   - idle:                        32 ms per test
    //   - harness DEFAULT (11 loops):  70-91 ms  (2.2-2.8x, matching the repo's
    //                                  measured CONTENTION of 2.09-2.98x)
    //   - LOAD_PROCS=32, i.e. 2.3x cores and outside the harness's stated
    //     envelope, with another engineer's full unit suite running
    //     concurrently: 3.5-7.9 s
    // 11_400 ms clears the worst of those by 1.4x and the actual gate by 125x.
    // It stays BOUNDED on purpose: a genuinely wedged daemon still fails, in
    // ~11 s rather than never.
    //
    // Note the failure mode is a CLIFF, not a slope — 2.8x at the gate, ~200x at
    // 2.3x cores — because once the machine is oversubscribed the 4-thread pool
    // stops being scheduled and every fsync queues behind the others. Do not
    // read the 7.9 s as "contention costs 200x" and scale other budgets by it.
  }, cliBudget(1));
});
