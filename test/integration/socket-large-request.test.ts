/**
 * Control-socket requests larger than the kernel's send buffer (regression).
 *
 * A unix stream socket on macOS has an 8 KiB send buffer
 * (`net.local.stream.sendspace`). `socketRequest` used to write its request in
 * a single unchecked `socket.write`, which on a larger payload takes only what
 * fits and reports the rest as not-written. Nothing retried it, so the tail was
 * dropped; the far end reads LINES, so the request never completed one, and the
 * call surfaced as `no response in 5000ms` against a server that was healthy
 * and still heartbeating.
 *
 * The failure was invisible because every existing probe sends a small verb.
 * It is reproduced here by SIZE alone — no special characters, no auth edge
 * case — because size alone is what caused it: measured on this repository, a
 * task envelope with a 6.5 KB brief staged and one with a 7.6 KB brief hung,
 * every time, on freshly created runs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketRequest, startRegistryDaemon } from "../../src/run/registry.ts";
import { runPaths } from "../../src/run/paths.ts";
import { loadControlSecret } from "../../src/security/control-auth.ts";
import { cliBudget } from "../support/budget.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describe("socketRequest with a payload past the send buffer", () => {
  /*
   * Well past 8 KiB, and deliberately not a round multiple of it: a fix that
   * merely raised a constant, or that only handled a single clean refill,
   * still has to survive several `drain` round trips to pass this.
   */
  const SIZES = [9_000, 100_000];

  for (const size of SIZES) {
    test(`a ${size}-byte request round-trips`, async () => {
      const root = await mkdtemp(join(tmpdir(), "pifleet-bigreq-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const run = runPaths(`bigreq-${size}-${RUN_TAG}`, root);
      await mkdir(run.root, { recursive: true });
      const daemon = await startRegistryDaemon(run);
      try {
        const secret = await loadControlSecret(run);
        // `ping` ignores extra fields, so the padding is pure transport load.
        const reply = await socketRequest(
          run.daemonSock,
          { cmd: "ping", padding: "x".repeat(size) },
          { secret },
        );
        expect(reply["ok"]).toBe(true);
        expect(reply["pid"]).toBe(process.pid);
      } finally {
        await daemon.stop();
      }
    }, cliBudget(1));
  }
});
