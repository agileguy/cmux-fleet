/**
 * The WRITER end of the identity channel, against a `ps` it cannot read
 * (ISC-272 residual 1, ISC-191).
 *
 * ## Why this file exists
 *
 * Every earlier round of the kill-ladder work hardened the READER.
 * `sameIdentity` compares at every rung, `confirmGroup` vouches for the group,
 * `anchorIdentity` refuses the climb, and `down-unreadable-ps.test.ts` proves
 * a broken `ps` refuses ONE worker rather than declaring it gone. All of that
 * is about a record that already exists.
 *
 * ISC-272's residual (1) named the other end and said exactly what was missing:
 * the writers' capture-failed sentinel is *"still vacuous at the writer end —
 * no test makes its `ps` fail"*, and *"classifying identically is not the same
 * as being tested"*.
 *
 * Making its `ps` fail showed the sentinel was not merely untested. It was
 * UNREACHABLE. Both writers spelled the degrade as
 *
 *     const started = (await processStartTime(process.pid)) ?? "";
 *
 * and since ISC-192 `processStartTime` THROWS on a read it cannot trust rather
 * than returning `null` — so `??` never sees the failure. Measured on
 * 2026-08-26 against a `ps` on PATH that exits 1 with a diagnostic:
 *
 *   - `src/supervisor/index.ts` died at startup with an unhandled
 *     `IdentityReadError`, before registration and before any state file, so
 *     `pifleet up` could not start a run at all;
 *   - `startRegistryDaemon` threw out of the call, so the registry never came
 *     up.
 *
 * On the environment `processStartTime`'s own header names as the likely one —
 * *"a minimal container image with no procps"* — the fleet did not degrade, it
 * failed to exist. The `pgid` line one line above each of these had caught all
 * along, which is why the surrounding comments described a degrade that half
 * the pair did not perform.
 *
 * ## What each test is anchored on, and why it cannot pass vacuously
 *
 * The binding assertion is that the artifact EXISTS. Before the fix the
 * supervisor died before writing `state.json` and the daemon threw before
 * returning, so "there is a state file" and "there is a daemon" are the facts
 * the catch buys — not the sentinel values, which were reachable on the `pgid`
 * side already.
 *
 * The sentinel values are asserted too, for the opposite reason: they prove
 * the stub `ps` was actually in effect. A real `ps` answers `process.pid` with
 * a positive group and a real start time, so a PATH that failed to take hold
 * would produce a passing process and FAILING assertions rather than a test
 * that quietly proves nothing. `down-unreadable-ps.test.ts` plants live pids
 * for the same reason and says so.
 *
 * ## What is deliberately NOT asserted here
 *
 * That `down` then refuses. `down-identity.test.ts` already proves the
 * `identity_unrecorded` refusal on both rungs, mutation-verified, and
 * re-asserting it here would couple this file to that one's fixtures for no
 * new fact. What this file adds is that the values those refusals key on are
 * the values a real broken-`ps` writer actually produces.
 *
 * ## Budget
 *
 * DERIVED per test, not shared, because the two spawn different counts.
 *
 * The first spawns ONE subprocess from this test process — the supervisor.
 * The `ps` calls it makes are its own children, not this process's, and the
 * budget model counts what the TEST spawns. `cliBudget(1)`.
 *
 * The second spawns TWO: the precondition's `processStartTime` and the one
 * `startRegistryDaemon` makes for its own identity. Both are the stub `ps`,
 * which exits immediately, so this is a ceiling rather than an estimate.
 * `cliBudget(2)`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { processStartTime, startRegistryDaemon, readRegistry } from "../../src/run/registry.ts";
import { cliBudget } from "../support/budget.ts";

const SUPERVISOR_TS = join(import.meta.dir, "..", "..", "src", "supervisor", "index.ts");
const bases: string[] = [];

afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true });
});

/**
 * A directory holding one `ps`, and that `ps` refuses to read anything.
 *
 * Exits 1 WITH a diagnostic on stderr on purpose: `processStartTime` treats a
 * normal exit with both pipes empty as "affirmatively absent" and anything
 * else as a failed read, so a silent stub would exercise the `null` path
 * rather than the throwing one this file is about.
 */
async function brokenPsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-writerid-ps-"));
  bases.push(dir);
  const stub = join(dir, "ps");
  await writeFile(stub, '#!/bin/sh\necho "ps: cannot read process table" 1>&2\nexit 1\n', "utf8");
  await chmod(stub, 0o755);
  return dir;
}

/** Run `fn` with the broken `ps` as the ONLY executable on PATH. */
async function withBrokenPs<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await brokenPsDir();
  const saved = process.env["PATH"];
  // ONLY the stub directory: a fall-through to the real `ps` would make a
  // failing assertion look like a passing one.
  process.env["PATH"] = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["PATH"];
    else process.env["PATH"] = saved;
  }
}

describe("the identity writers degrade rather than die on an unreadable ps (ISC-272)", () => {
  test("the supervisor reaches its state file instead of throwing IdentityReadError", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-writerid-sup-"));
    bases.push(base);
    const runId = "2026-08-26T00-00-00Z-wid1";
    const run = runPaths(runId, base);
    const wp = workerPaths(run, "eng-1");

    const psDir = await brokenPsDir();

    /**
     * PIFLEET_PI_COMMAND is deliberately UNSET.
     *
     * The supervisor then reaches a diagnosed refusal — "nothing to run" — and
     * exits, which is all this test needs: that exit happens well AFTER the
     * identity capture, so reaching it at all is the proof. Giving it a real
     * Pi would add a child process, a model and a settle loop to a test whose
     * whole subject is line 211.
     */
    const proc = Bun.spawn(
      [process.execPath, SUPERVISOR_TS, "--runs-root", base, "--run", runId, "--worker", "eng-1"],
      {
        // NOT inherited: PATH is the entire experiment. `process.execPath` is
        // absolute, so bun itself does not need to be resolvable.
        env: { PATH: psDir, HOME: process.env["HOME"] ?? "/tmp" },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    // THE DEFECT, named. Before the fix this string was the whole output and
    // no state file existed at all.
    expect(
      stderr,
      `the supervisor died on its own identity capture instead of degrading. ` +
        `What it said:\n${stderr}`,
    ).not.toContain("IdentityReadError");

    // THE BINDING FACT: the artifact exists, which it could not before.
    const state = await Bun.file(wp.stateJson)
      .json()
      .catch(() => null);
    expect(
      state,
      `no worker state file at ${wp.stateJson} — the supervisor did not survive its ` +
        `identity capture. stderr was:\n${stderr}`,
    ).not.toBeNull();

    /**
     * THE STUB WAS REALLY IN EFFECT. A working `ps` answers this process's own
     * pid with a positive group, so `0` cannot be produced by a fall-through.
     */
    expect((state as { pgid?: number }).pgid).toBe(0);
  }, cliBudget(1));

  test("startRegistryDaemon returns a daemon and persists the capture-failed sentinel", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-writerid-reg-"));
    bases.push(base);
    const run = runPaths("2026-08-26T00-00-00Z-wid2", base);
    // No `dir` field on RunPaths; the registry lives at the run root.
    await mkdir(dirname(run.registryJson), { recursive: true });

    const daemon = await withBrokenPs(async () => {
      /**
       * PRECONDITION, asserted rather than assumed.
       *
       * If the stub failed to take effect this call returns a start time and
       * the test below would be measuring a healthy `ps`. ISC-272's M-B
       * mutation passed on its first attempt for exactly this class of reason
       * — a fixture that could not run — so the instrument is checked before
       * it is used.
       */
      await expect(processStartTime(process.pid)).rejects.toThrow(/cannot read process table/);
      return await startRegistryDaemon(run);
    });

    try {
      const registry = await readRegistry(run);
      expect(registry, "the daemon started but wrote no registry").not.toBeNull();
      // `""` is the declared capture-failed sentinel every reader refuses
      // beside `null` — never a start time read off the pid.
      expect(registry?.daemon.started).toBe("");
      expect(registry?.daemon.pid).toBe(process.pid);
    } finally {
      await daemon.stop();
    }
  }, cliBudget(2));
});
