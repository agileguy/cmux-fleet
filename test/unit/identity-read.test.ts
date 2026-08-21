/**
 * `processStartTime` separates "the process is gone" from "I could not find
 * out" (carry-in of the Phase F review, the identity half of ISC-272's
 * `group_read_failed`).
 *
 * ## Why this is worth a suite of its own
 *
 * The two facts have OPPOSITE safe answers and the function used to give them
 * the same one. `down`'s `anchorIdentity` maps `null` to `{kind: "gone"}`,
 * which is the single anchor verdict that reports `stopped: true`, calls
 * `reapContainer()` (`docker rm -f`) and makes the worker prunable. So the old
 * `if (proc.exitCode !== 0 || out.length === 0) return null` let a transient
 * `ps` failure against a LIVE supervisor reach the data-loss path — the same
 * defect `processGroupId` was fixed for, one channel over, on identity instead
 * of group.
 *
 * ## What makes the cases below reachable
 *
 * `processStartTime` hard-codes its argv, so a test cannot hand it an illegal
 * flag — but it resolves `ps` through PATH, so a test CAN hand it a different
 * `ps`. The unreadable case below is produced by a shim, and that is a
 * correction rather than a convenience.
 *
 * THE FIRST VERSION OF THIS SUITE USED A PID ABOVE THE KERNEL CEILING and was
 * measured only on Darwin, where it produces exactly the shape the fix turns
 * on:
 *
 *   a live pid                         exit 0  stdout "Fri Aug 21 04:14:42 2026"  stderr ""
 *   a pid that exited and was reaped   exit 1  stdout ""                          stderr ""
 *   pid 999999999, above the ceiling   exit 1  stdout ""                          stderr "ps: process id too large: 999999999"
 *
 * On `ubuntu-latest` the third row does not hold: procps answers an
 * out-of-range pid the same way it answers an absent one — exit 1, silence on
 * both channels — which is a legitimate reading, not a refusal. Four tests
 * passed on the author's machine and failed in CI, which is the exact
 * local-only-evidence trap this project grades `[~]` for.
 *
 * The shim removes the dependency on either kernel's opinion and tests the
 * DISCRIMINATOR ITSELF: a `ps` that exits non-zero with something on stderr is
 * a failed read on every platform, and that — not the pid ceiling — is what
 * the production rule keys off. The first two rows above still come from the
 * real `ps` and still carry their point: exit status alone cannot decide this.
 *
 * ## Budget
 *
 * `processStartTime` spawns `ps`, not this project's CLI, so `cliBudget`'s
 * ~1900 ms-per-spawn model does not describe these tests — a bare `ps` costs
 * single-digit milliseconds. Rather than encode a lie as arithmetic (the
 * argument `budget.ts` makes for why `containerBudget` exists at all), each
 * test below is left on bun's 5000 ms default DELIBERATELY: the most any one of
 * them performs is three `ps` spawns plus one `Bun.spawn(["true"])`, which is
 * two orders of magnitude inside that ceiling even under the 3x contention
 * `budget.ts` measured. The one test that spawns a real sleeping child says so
 * inline.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import {
  IDENTITY_FORMAT,
  IdentityReadError,
  identityAlive,
  isPinnedIdentity,
  processStartTime,
} from "../../src/run/registry.ts";

/**
 * The pid handed to the shimmed `ps`, and it is THIS PROCESS on purpose.
 *
 * The first version used 424242, and that was still wrong for the reason the
 * pid ceiling was wrong: 424242 is ALSO above Darwin's ceiling, so a real `ps`
 * refuses it with a diagnostic and the refusal tests pass whether or not the
 * shim takes effect. Measured by disabling the PATH mutation: 8 of 9 tests
 * still passed on this machine. The shim was decorative and the platform was
 * still doing the work — the same trap one layer down.
 *
 * A live pid cannot do that. A real `ps` answers it with exit 0 and a start
 * time, so every assertion about refusal below FAILS LOUDLY on every platform
 * the moment the shim stops being reached — a noexec `TMPDIR`, a hostile
 * umask, or a refactor of `withPsFrom`. That is what makes the shim
 * load-bearing rather than merely first on PATH.
 */
const UNREADABLE_PID = process.pid;

/** The stderr line the shim emits, asserted on so the diagnostic is carried. */
const SHIM_DIAGNOSTIC = "ps: cannot read process table (test shim)";

/**
 * Run `fn` with a `ps` on PATH that FAILS THE WAY A BROKEN ps FAILS: exit 1,
 * nothing on stdout, a diagnostic on stderr.
 *
 * PATH is restored in a `finally`, and the shim directory is created once per
 * call under the OS temp dir. `processStartTime` builds its env from
 * `process.env`, so mutating PATH here is what the child sees. Tests in one
 * bun file run sequentially, so the mutation cannot leak into a sibling.
 */
let shimDir: string | null = null;
let killedDir: string | null = null;
let emptyDir: string | null = null;

beforeAll(async () => {
  // Built ONCE for the file rather than per call. Four mkdtemp+write cycles
  // cost ~1.4 s against ~40 ms for the whole suite otherwise, and a suite that
  // spends its budget on its own fixtures is the shape `budget.ts` exists to
  // argue against.
  shimDir = await mkdtemp(join(tmpdir(), "pifleet-ps-shim-"));
  await writeFile(join(shimDir, "ps"), `#!/bin/sh\necho "${SHIM_DIAGNOSTIC}" >&2\nexit 1\n`, {
    encoding: "utf8",
    mode: 0o755,
  });
  /*
   * A `ps` that is KILLED BY A SIGNAL rather than exiting. `kill -9 $$` makes
   * the shim die the way an OOM killer, a cgroup limit or a stray `pkill`
   * would kill a real one: no exit status at all, and silence on both pipes.
   */
  // A PATH entry with no `ps` in it at all, prepended AND with the real
  // directories removed by the caller — the minimal-container case.
  emptyDir = await mkdtemp(join(tmpdir(), "pifleet-ps-absent-"));
  killedDir = await mkdtemp(join(tmpdir(), "pifleet-ps-killed-"));
  await writeFile(join(killedDir, "ps"), `#!/bin/sh\nkill -9 $$\n`, {
    encoding: "utf8",
    mode: 0o755,
  });
});

afterAll(async () => {
  if (shimDir !== null) await rm(shimDir, { recursive: true, force: true });
  if (killedDir !== null) await rm(killedDir, { recursive: true, force: true });
  if (emptyDir !== null) await rm(emptyDir, { recursive: true, force: true });
});

async function withPsFrom<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

const withBrokenPs = <T,>(fn: () => Promise<T>): Promise<T> => withPsFrom(shimDir!, fn);
const withKilledPs = <T,>(fn: () => Promise<T>): Promise<T> => withPsFrom(killedDir!, fn);

/** No `ps` anywhere on PATH — PATH is REPLACED, not prepended. */
async function withNoPs<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = emptyDir!;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

/** A pid that has exited AND been reaped — the affirmatively-gone case. */
async function reapedPid(): Promise<number> {
  const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

describe("processStartTime distinguishes gone from unreadable", () => {
  test("a live pid yields a tagged token", async () => {
    const started = await processStartTime(process.pid);
    expect(started).not.toBeNull();
    expect(isPinnedIdentity(started!)).toBe(true);
    expect(started!.startsWith(`${IDENTITY_FORMAT} `)).toBe(true);
    // Never the empty string: `""` is the capture-failed sentinel that callers
    // persist, and a real reading must not be confusable with it.
    expect(started).not.toBe(`${IDENTITY_FORMAT} `);
  });

  test("an affirmatively absent pid is null, and STAYS null", async () => {
    // The other half of the contract. A fix that made everything throw would
    // pass every assertion below about refusal and destroy the one answer
    // `down` legitimately acts on — `gone` is what lets a finished run be
    // cleaned up at all.
    expect(await processStartTime(await reapedPid())).toBeNull();
  });

  test("a pid `ps` REFUSES to read throws instead of reporting absence", async () => {
    let caught: unknown;
    await withBrokenPs(async () => {
      try {
        await processStartTime(UNREADABLE_PID);
      } catch (err) {
        caught = err;
      }
    });

    // The assertion the whole criterion rests on. Before the fix this call
    // returned `null`, which `down` reads as "nothing holds this pid".
    expect(caught).toBeInstanceOf(IdentityReadError);
    expect((caught as IdentityReadError).pid).toBe(UNREADABLE_PID);

    const msg = (caught as Error).message;
    // `ps`'s own words are carried, not swallowed: "could not be read" with no
    // reason sends an operator to inspect a process that is fine.
    expect(msg).toContain(SHIM_DIAGNOSTIC);
    // And the message must say what this is NOT, because the failure mode is a
    // reader concluding "gone" from a refusal.
    expect(msg).toContain("NOT the process being gone");
  });

  /**
   * THE ROW THAT WAS MISSING FROM THE MEASUREMENT TABLE.
   *
   * A signal-killed `ps` is byte-identical to an absent process on every
   * channel this function reads: `exitCode !== 0` holds (bun reports `null`,
   * not a number), stdout is empty and stderr is empty. Measured on bun
   * 1.3.11: `{exitCode: null, signalCode: "SIGKILL", stdoutLen: 0,
   * stderrLen: 0}`.
   *
   * Fails if: absence stops requiring a NORMAL exit. `gone` is the one verdict
   * `down` may report as a stop, act on with `docker rm -f` and hand to the
   * `--prune` gate — so under memory pressure, an OOM killer or a stray
   * `pkill`, this returning `null` deletes the checkout of a supervisor that
   * is alive and mid-write.
   */
  test("a `ps` killed by a signal is a failed read, not an absent process", async () => {
    const err = await withKilledPs(() =>
      processStartTime(UNREADABLE_PID).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(IdentityReadError);
    // The diagnosis must name the signal: "ps exited null" tells an operator
    // nothing about a machine that is killing short-lived children.
    expect((err as Error).message).toContain("killed by SIGKILL");
    expect((err as { exitCode?: number }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
  });

  /**
   * The likeliest real instance of "the measuring instrument is broken": a
   * minimal container image with no procps at all.
   *
   * `Bun.spawn` throws SYNCHRONOUSLY here — `Executable not found in $PATH` —
   * with no `exitCode` on the error, so an unwrapped spawn is reported by the
   * entry point as `EXIT.INTERNAL`, "a bug in pifleet itself", for what is
   * purely an environment failure. Every other refusal in this file exercises
   * a `ps` that RAN; this is the one that never starts.
   *
   * Fails if: the spawn is unwrapped again. The `exitCode` assertion is the
   * load-bearing half — a bare `Error` satisfies `toBeInstanceOf(Error)` and
   * proves nothing.
   */
  test("a `ps` that is not on PATH at all is a diagnosed refusal, not an internal error", async () => {
    const err = await withNoPs(() => processStartTime(process.pid).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(IdentityReadError);
    expect((err as { exitCode?: number }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect((err as { exitCode?: number }).exitCode).not.toBe(EXIT.INTERNAL);
    expect((err as Error).message).toContain("could not be started");
  });

  test("the refusal is a DIAGNOSED failure, not an internal error", async () => {
    // Unlike `GroupReadError`, this one has callers that do not catch it, so it
    // reaches the CLI. Without an `exitCode` the entry point reports
    // `EXIT.INTERNAL` — "a bug in pifleet itself" — for a broken `ps`.
    const err = await withBrokenPs(() =>
      processStartTime(UNREADABLE_PID).catch((e: unknown) => e),
    );
    expect((err as { exitCode?: number }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect((err as { exitCode?: number }).exitCode).not.toBe(EXIT.INTERNAL);
  });

  test("the two failing reads are told apart, not merged", async () => {
    // Both are exit 1 with empty stdout. If a future edit reaches for the exit
    // code as the discriminator, one of these two flips and this fails.
    // `gone` uses the REAL `ps` — the whole comparison is worthless if both
    // sides come from the shim.
    const gone = await processStartTime(await reapedPid());
    const unreadable = await withBrokenPs(() =>
      processStartTime(UNREADABLE_PID).catch((e: unknown) => e),
    );
    expect(gone).toBeNull();
    expect(unreadable).toBeInstanceOf(IdentityReadError);
  });
});

describe("identityAlive propagates the refusal", () => {
  test("a live pid recorded correctly is alive", async () => {
    const started = await processStartTime(process.pid);
    expect(await identityAlive({ pid: process.pid, started: started! })).toBe(true);
  });

  test("a live pid recorded WRONG is not alive — false is still reachable", async () => {
    expect(await identityAlive({ pid: process.pid, started: "utc1 Thu Jan 1 00:00:00 1970" })).toBe(
      false,
    );
  });

  test("an unreadable pid THROWS rather than answering false", async () => {
    // `false` here would mean "the supervisor we recorded is not there", which
    // is what `status` prints and what `up`'s post-launch check acts on. It has
    // not been established, so it must not be asserted.
    const err = await withBrokenPs(() =>
      identityAlive({ pid: UNREADABLE_PID, started: "utc1 whenever" }).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(IdentityReadError);
  });

  test("an affirmatively gone pid is still false, not a throw", async () => {
    expect(await identityAlive({ pid: await reapedPid(), started: "utc1 whenever" })).toBe(false);
  });
});
