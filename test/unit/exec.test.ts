/**
 * `realExec`'s contract: a failure is a datum, never an exception.
 *
 * `src/container/run.ts` promises this twice in prose — its header says the
 * wrapper "never throws ... a failure IS the datum", and `dockerAvailable`
 * says "absence is a report, not an exception" — and neither was true for a
 * tool that is not installed. `Bun.spawn` throws on a missing executable
 * rather than returning 127 the way a shell does, so every probe in the
 * codebase inherited an uncaught exception from a condition it exists to
 * detect.
 *
 * `doctor` is where that landed: the command whose whole job is reporting
 * which tools are missing crashed with exit 2 and produced no report at all
 * on a machine missing one. It passed locally only because this machine has
 * every probed tool installed; CI, which has no `pi`, is what exposed it.
 * These tests pin the behaviour that made it possible, so the next probe
 * added to `doctor` cannot reintroduce it.
 */

import { describe, expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXEC_NOT_FOUND, dockerAvailable, realExec } from "../../src/container/run.ts";

/** Not on any PATH, and named so nobody is tempted to create it. */
const ABSENT = "pifleet-no-such-executable-a7f3e1";

describe("a missing executable is reported, not thrown", () => {
  test("realExec resolves with 127 rather than rejecting", async () => {
    // `.resolves` is the assertion: before the fix this line REJECTED, which
    // is the entire defect. Asserting only on `code` would still have thrown.
    const r = await realExec([ABSENT]);
    expect(r.code).toBe(EXEC_NOT_FOUND);
    expect(r.timedOut).toBe(false);
    // The reason has to survive into the result, or `doctor` reports a bare
    // number and the operator learns nothing about which tool is missing.
    expect(r.stderr).toContain(ABSENT);
  });

  test("stdout is empty and the result is shaped like any other", async () => {
    const r = await realExec([ABSENT, "--version"]);
    expect(r.stdout).toBe("");
    // Same keys as a real run: callers must not need to know which kind of
    // failure they got in order to read the result.
    expect(Object.keys(r).sort()).toEqual(["code", "stderr", "stdout", "timedOut"]);
  });

  /**
   * 127 must be distinguishable from a genuine non-zero exit. A probe that
   * conflated "not installed" with "installed and broken" would send an
   * operator to fix the wrong problem.
   */
  test("a present-but-failing command is not reported as not-found", async () => {
    const r = await realExec(["sh", "-c", "exit 3"]);
    expect(r.code).toBe(3);
    expect(r.code).not.toBe(EXEC_NOT_FOUND);
  });

  test("a command that really does exit 127 is still just an exit code", async () => {
    const r = await realExec(["sh", "-c", `exit ${EXEC_NOT_FOUND}`]);
    expect(r.code).toBe(EXEC_NOT_FOUND);
    // Indistinguishable by code alone, and that is acceptable — the shell
    // convention is the same one. What matters is that neither one throws.
    expect(r.stderr).toBe("");
  });

  /**
   * A present-but-unexecutable file raises `EACCES`, not `ENOENT`. An earlier
   * version of the fix converted only `ENOENT` and rethrew everything else,
   * which left `doctor` crashing on exactly the case an operator most needs
   * reported: the tool is installed, and its permissions are wrong. Probing
   * the real errnos is what caught it — `ENOENT` also covers a missing `cwd`,
   * so the code never separated the cases the comment claimed it did.
   */
  test("a present-but-unexecutable file is reported, not thrown", async () => {
    const path = join(tmpdir(), `pifleet-noexec-${process.pid.toString(36)}.sh`);
    await Bun.write(path, "#!/bin/sh\necho hi\n");
    await chmod(path, 0o644); // readable, deliberately not executable
    try {
      const r = await realExec([path]);
      expect(r.code).toBe(EXEC_NOT_FOUND);
      expect(r.stderr).toContain("EACCES");
    } finally {
      await rm(path, { force: true });
    }
  });

  test("an unreachable cwd is reported, not thrown", async () => {
    const r = await realExec(["echo", "hi"], { cwd: join(tmpdir(), "pifleet-no-such-dir-9c1e") });
    expect(r.code).toBe(EXEC_NOT_FOUND);
    // `echo` exists; the cwd does not. Same errno as a missing binary, which
    // is precisely why this wrapper does not try to tell them apart by code.
    expect(r.stderr).toContain("ENOENT");
  });

  /**
   * The specific claim in `dockerAvailable`'s doc comment. It is the helper
   * every container path calls first, so if absence throws here the failure
   * surfaces far from its cause.
   */
  test("dockerAvailable reports false for an absent docker instead of throwing", async () => {
    const absentDocker = async (): Promise<Awaited<ReturnType<typeof realExec>>> =>
      realExec([ABSENT, "info"]);
    await expect(dockerAvailable(absentDocker)).resolves.toBe(false);
  });
});
