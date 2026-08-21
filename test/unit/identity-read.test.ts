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
 * flag. It CAN hand it a pid, and a pid above the kernel's ceiling produces the
 * exact shape the fix turns on — exit 1, empty stdout, and a diagnostic on
 * stderr. Measured on this machine (Darwin 25.5, base-system `ps`, `-o
 * lstart=`, two consecutive runs, both identical):
 *
 *   a live pid                         exit 0  stdout "Fri Aug 21 04:14:42 2026"  stderr ""
 *   a pid that exited and was reaped   exit 1  stdout ""                          stderr ""
 *   pid 999999999, above the ceiling   exit 1  stdout ""                          stderr "ps: process id too large: 999999999"
 *
 * The first two rows are the reason exit status alone cannot decide this, and
 * the third is the row the old code answered with `null`.
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

import { describe, expect, test } from "bun:test";
import { EXIT } from "../../src/contracts.ts";
import {
  IDENTITY_FORMAT,
  IdentityReadError,
  identityAlive,
  isPinnedIdentity,
  processStartTime,
} from "../../src/run/registry.ts";

/**
 * Above the kernel's pid ceiling, so `ps` refuses with a diagnostic rather than
 * reporting an absence. NOT merely "a pid that is probably unused" — that would
 * be the affirmatively-gone case and would prove the opposite of what is wanted.
 */
const PID_ABOVE_CEILING = 999_999_999;

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
    try {
      await processStartTime(PID_ABOVE_CEILING);
    } catch (err) {
      caught = err;
    }

    // The assertion the whole criterion rests on. Before the fix this call
    // returned `null`, which `down` reads as "nothing holds this pid".
    expect(caught).toBeInstanceOf(IdentityReadError);
    expect((caught as IdentityReadError).pid).toBe(PID_ABOVE_CEILING);

    const msg = (caught as Error).message;
    // `ps`'s own words are carried, not swallowed: "could not be read" with no
    // reason sends an operator to inspect a process that is fine.
    expect(msg).toContain("process id too large");
    // And the message must say what this is NOT, because the failure mode is a
    // reader concluding "gone" from a refusal.
    expect(msg).toContain("NOT the process being gone");
  });

  test("the refusal is a DIAGNOSED failure, not an internal error", async () => {
    // Unlike `GroupReadError`, this one has callers that do not catch it, so it
    // reaches the CLI. Without an `exitCode` the entry point reports
    // `EXIT.INTERNAL` — "a bug in pifleet itself" — for a broken `ps`.
    const err = await processStartTime(PID_ABOVE_CEILING).catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect((err as { exitCode?: number }).exitCode).not.toBe(EXIT.INTERNAL);
  });

  test("the two failing reads are told apart, not merged", async () => {
    // Both are exit 1 with empty stdout. If a future edit reaches for the exit
    // code as the discriminator, one of these two flips and this fails.
    const gone = await processStartTime(await reapedPid());
    const unreadable = await processStartTime(PID_ABOVE_CEILING).catch((e: unknown) => e);
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
    const err = await identityAlive({ pid: PID_ABOVE_CEILING, started: "utc1 whenever" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IdentityReadError);
  });

  test("an affirmatively gone pid is still false, not a throw", async () => {
    expect(await identityAlive({ pid: await reapedPid(), started: "utc1 whenever" })).toBe(false);
  });
});
