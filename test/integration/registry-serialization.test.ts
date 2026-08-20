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
 * WHY THIS PROBE LOOKS THE WAY IT DOES. The obvious test — fire N concurrent
 * registrations, assert all N are on disk — proves nothing, and it is worth
 * saying why, because it is the test a reviewer will ask for. Each handler
 * mutates the in-memory registry SYNCHRONOUSLY and its write payload is
 * snapshotted when the write begins, so a later-starting write always carries a
 * superset of an earlier one AND is larger, which means it finishes later and
 * lands last. Payload size and snapshot recency correlate in the SAFE
 * direction: unserialized, that test passes anyway. It would be a green
 * checkbox over an unguarded race.
 *
 * So this probe asserts the mechanism the criterion actually names — that the
 * writes are serialized — by observing `writeJsonAtomic`'s temp files, which
 * exist for exactly the span of one write. One temp file at a time means the
 * writes did not overlap. It also asserts the consequence (every worker
 * present) and, so the sampler cannot pass by having watched nothing, that it
 * caught most of the writes in flight.
 */

import { describe, expect, test } from "bun:test";
import {
  RegistrySchema,
  readRegistry,
  socketRequest,
  startRegistryDaemon,
} from "../../src/run/registry.ts";
import { runPaths, type RunPaths } from "../../src/run/paths.ts";
import { loadControlSecret } from "../../src/security/control-auth.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** How many supervisors register at once. `up` fans out on this order. */
const CONCURRENT_REGISTRATIONS = 12;

/**
 * Padding that makes each registry write large enough to have a duration.
 *
 * Not decoration. A write that completes inside a single event-loop turn is
 * one the sampler below can miss entirely, and a probe that cannot observe the
 * thing it is asserting the absence of is a probe that always passes. ~512 KiB
 * of filler puts every `registry.json` write in the millisecond range, which is
 * thousands of `readdir` samples wide.
 *
 * It is planted on DISK before the daemon starts rather than registered over
 * the socket: `socketRequest` writes a request in one `socket.write` and does
 * not handle backpressure, so a multi-hundred-KiB verb is not a thing this
 * transport can carry. The daemon seeds its in-memory registry from the file.
 */
const FILLER_BYTES = 512 * 1024;

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
    async finish() {
      stop = true;
      await loop;
      return { maxConcurrent, distinctSeen: seen.size, samples };
    },
  };
}

describe("registry writes are serialized (ISC-186)", () => {
  /**
   * Fails if: the daemon's write chain is removed or bypassed, or a second
   * write path to `registry.json` is added alongside it. Mutation-verified by
   * making `persist()` call `writeJsonAtomic` directly — the sampler then sees
   * up to `CONCURRENT_REGISTRATIONS` temp files at one instant.
   */
  test("concurrent registrations never put two writes in flight, and none is lost", async () => {
    const { run, cleanup } = await scratchRun();

    // Seeded on disk so every registry write has a duration worth sampling.
    // Written through the schema so a drift in the registry shape breaks this
    // setup loudly rather than being silently rejected at daemon start.
    await writeJsonAtomic(
      run.registryJson,
      RegistrySchema.parse({
        schema: "pifleet.registry/v1",
        run_id: run.runId,
        daemon: { pid: 0, started: "" },
        workers: { filler: { ...entry("filler"), started: "x".repeat(FILLER_BYTES) } },
      }),
    );

    const daemon = await startRegistryDaemon(run);
    const watcher = watchTempFiles(run.registryJson);
    try {
      const secret = await loadControlSecret(run);
      const names = Array.from({ length: CONCURRENT_REGISTRATIONS }, (_, i) => `w-${i}`);
      await Promise.all(
        names.map((w) =>
          socketRequest(run.daemonSock, { cmd: "register_worker", entry: entry(w) }, { secret }),
        ),
      );

      const { maxConcurrent, distinctSeen, samples } = await watcher.finish();

      // The sampler was actually looking. Without these two, a watcher that
      // never ran — or that ran only before the burst — reports "no overlap"
      // having observed nothing, which is the shape of green this repo has
      // spent a session removing.
      //
      // The bar is half the writes because CI's contended two-core runner
      // samples less often than a workstation; the margin measured here is
      // much wider than that. Instrumented on this machine: distinctSeen 12 of
      // 12, over 91 samples — every write was caught in flight.
      expect(samples).toBeGreaterThan(CONCURRENT_REGISTRATIONS);
      expect(distinctSeen).toBeGreaterThanOrEqual(CONCURRENT_REGISTRATIONS / 2);

      // The criterion's mechanism. Catching this many separate writes in
      // flight without ever catching two at once is only possible if they did
      // not overlap.
      expect(maxConcurrent).toBe(1);

      // And its consequence, on the file every other process reads.
      const onDisk = await readRegistry(run);
      expect(Object.keys(onDisk?.workers ?? {}).sort()).toEqual(
        ["filler", ...names].sort(),
      );
    } finally {
      await watcher.finish();
      await daemon.stop();
      await cleanup();
    }
  });
});
