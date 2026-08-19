/**
 * The guard that grades the probe suites, exercised against its own failure
 * modes (ISC-257, ISC-262).
 *
 * ## Why this file exists
 *
 * `.github/scripts/probe-guard.sh` is the thing standing between "the job is
 * green" and "a whole file's worth of criteria silently stopped being tested".
 * Four separate criteria in this project have reported green having executed
 * nothing, through four different mechanisms, and this guard is the answer to
 * all four. That makes it the single highest-leverage piece of shell in the
 * repo — and, until this file existed, the only piece with no test at all.
 *
 * A guard nobody has tried to break is not a guard. Every check below is a
 * MUTATION: it takes a run the guard should accept, breaks exactly one thing,
 * and asserts the guard goes red for that specific reason with a message that
 * names it. A guard that fails for the wrong reason is barely better than one
 * that passes for the wrong reason, because the operator acts on the message.
 *
 * ## Why fixtures rather than the real suites
 *
 * The real probe suites need a Docker daemon, a built worker image, and in one
 * case an Apple-silicon inference server. None of that is available where this
 * runs, and none of it is what is under test here: the subject is the SHELL, so
 * the input is a handful of two-line fixture suites in a temp directory whose
 * pass/skip/fail/todo shape is known exactly. That also means these tests are
 * ungated and run in the fast `test` job on every push, which is the point —
 * the guard is checked by something reproducible, not by hoping CI is honest.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(new URL("../../", import.meta.url).pathname, ".github/scripts/probe-guard.sh");

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

/** Exact names, referenced by the pin lists below. Keep them in sync by hand. */
const NAMES = {
  passA: "fixture alpha passes",
  passB: "fixture bravo passes",
  pinnedSkip: "fixture charlie skips on purpose",
  unpinnedSkip: "fixture delta skips without a pin",
} as const;

/**
 * A directory of fixture suites with a KNOWN pass/skip/fail/todo shape.
 *
 * Each case gets its own directory: `bun test` discovers files by scanning the
 * working directory, so a shared one would let a fixture written for one case
 * be collected by another's filters and quietly change its arithmetic — the
 * same class of accident this guard exists to catch.
 *
 * ## The filenames are chosen so that none is a SUBSTRING of another
 *
 * Measured while writing this file, and it cost two red tests to find: a `bun
 * test` argument is a SUBSTRING filter over discovered paths, not a path.
 * `bun test pinned.test.ts` in a directory that also holds `unpinned.test.ts`
 * collects BOTH — "unpinned.test.ts" contains "pinned.test.ts" — so the
 * fixture that was supposed to be excluded from a case silently joined it and
 * the arithmetic moved under the test. Renamed to `orphan-skip.test.ts`.
 *
 * The same trap applies to the workflow's own file lists, and it is worth
 * stating because the failure is silent in the direction that ADDS tests: a
 * future `test/integration/xrelay.test.ts` would be swept into the container
 * job by the existing `test/integration/relay.test.ts` filter with no warning.
 * The guard catches that — the total goes UP and the total check fires — which
 * is the same check, from the other side, as the dropped-file case below.
 * Verified for the current lists: `bun test` reports exactly 5 files for the
 * container job's filters and exactly 1 for the live-oMLX step's.
 */
async function fixtures(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-probe-guard-"));
  bases.push(base);
  const write = (name: string, body: string) =>
    writeFile(join(base, name), `import { test, expect } from "bun:test";\n${body}\n`);

  await Promise.all([
    // 2 pass.
    write(
      "pass.test.ts",
      `test(${JSON.stringify(NAMES.passA)}, () => { expect(1).toBe(1); });\n` +
        `test(${JSON.stringify(NAMES.passB)}, () => { expect(2).toBe(2); });`,
    ),
    // 1 pass, 1 skip — the skip is the one the pin lists name.
    write(
      "pinned.test.ts",
      `test("fixture pinned sibling passes", () => { expect(1).toBe(1); });\n` +
        `test.skipIf(true)(${JSON.stringify(NAMES.pinnedSkip)}, () => { expect(1).toBe(2); });`,
    ),
    // 1 skip, deliberately NOT pinned anywhere. Named `orphan-skip` and not
    // `unpinned` on purpose — see the substring note above.
    write(
      "orphan-skip.test.ts",
      `test.skipIf(true)(${JSON.stringify(NAMES.unpinnedSkip)}, () => { expect(1).toBe(2); });`,
    ),
    // 1 genuine failure.
    write("fail.test.ts", `test("fixture echo fails", () => { expect(1).toBe(2); });`),
    // 1 written-but-not-implemented test.
    write("todo.test.ts", `test.todo("fixture foxtrot is not written yet");`),
  ]);
  return base;
}

interface Run {
  code: number;
  out: string;
}

/**
 * Invoke the guard with `cwd` inside the fixture directory.
 *
 * `cwd` and not an absolute file list, because `bun test` resolves its
 * arguments as filters against the files it discovers under the working
 * directory. Running from the repo root would make the fixture filters match
 * nothing — the guard would then correctly report a collection shortfall, and
 * every case here would pass for a reason that has nothing to do with what it
 * claims to test.
 */
async function runGuard(
  cwd: string,
  files: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<Run> {
  const p = Bun.spawn(["bash", GUARD, ...files], {
    cwd,
    env: {
      ...process.env,
      JUNIT_FILE: join(cwd, `report-${Math.random().toString(36).slice(2)}.xml`),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out: stdout + stderr };
}

describe("the probe guard accepts a clean run", () => {
  test("a run whose every skip is pinned by name is graded green", async () => {
    const base = await fixtures();
    const r = await runGuard(base, ["pass.test.ts", "pinned.test.ts"], {
      LABEL: "clean",
      TOTAL_EXPECTED: "4",
      EXPECTED_SKIPS: `${NAMES.pinnedSkip}\n`,
    });
    expect(r.out).toContain("parsed[clean]: pass=3 fail=0 skip=1 todo=0 total=4");
    expect(r.out).toContain("ok[clean]: 4 probes accounted for");
    expect(r.code).toBe(0);
  }, 60_000);

  test("blank lines in a pinned list are ignored, so a YAML block scalar pastes in", async () => {
    // The workflow supplies these as `EXPECTED_...: |` block scalars, which
    // arrive with a trailing newline, and the container job concatenates two
    // such blocks — producing an interior blank line. If blanks counted, the
    // pinned total would exceed the real skip count and a clean run would go
    // red for a formatting reason.
    const base = await fixtures();
    const r = await runGuard(base, ["pass.test.ts", "pinned.test.ts"], {
      LABEL: "blanks",
      TOTAL_EXPECTED: "4",
      EXPECTED_SKIPS: `\n${NAMES.pinnedSkip}\n\n`,
    });
    expect(r.out).toContain("matches all 1 pinned names exactly");
    expect(r.code).toBe(0);
  }, 60_000);
});

describe("the probe guard rejects each thing it exists to catch", () => {
  test("a file that silently drops out of collection is caught by the total", async () => {
    /**
     * The headline failure mode, and the reason the total check is written in
     * terms of COLLECTION rather than passes. Measured directly: `bun test
     * present.test.ts absent.test.ts` runs the one that exists, prints no
     * warning about the one that does not, and exits 0. Even when EVERY filter
     * matches nothing, bun exits 0. So a renamed or deleted suite produces a
     * green step and a lower total, and nothing but this check notices.
     *
     * The dropped file here is the one with NO pinned skip, deliberately: that
     * leaves the identity and skip-count checks satisfied, so the total check
     * is the only thing that can fire, and this test cannot pass by accident
     * through an earlier check.
     */
    const base = await fixtures();
    const r = await runGuard(base, ["pass-RENAMED-AWAY.test.ts", "pinned.test.ts"], {
      LABEL: "dropped",
      TOTAL_EXPECTED: "4",
      EXPECTED_SKIPS: `${NAMES.pinnedSkip}\n`,
    });
    expect(r.out).toContain("expected 4 probes collected (pass+skip), got only 2");
    expect(r.out).toContain("silently matched nothing");
    expect(r.code).toBe(1);
  }, 60_000);

  test("a SURPLUS is caught too, and advises the opposite fix from a shortfall", async () => {
    /**
     * The other direction, and it needs its own message rather than sharing
     * the shortfall one. Found by mutating TOTAL_EXPECTED against a real relay
     * run: 5 expected against 6 collected printed "a test dropped out of
     * collection entirely" — shortfall advice, for a surplus, which sends the
     * reader hunting for a deleted file that was never deleted.
     *
     * A live scenario, not a hypothetical, because the arguments are substring
     * filters: a future file whose name contains a listed one is swept in with
     * no warning, and this check is the only thing that notices.
     */
    const base = await fixtures();
    const r = await runGuard(base, ["pass.test.ts", "pinned.test.ts"], {
      LABEL: "surplus",
      TOTAL_EXPECTED: "3",
      EXPECTED_SKIPS: `${NAMES.pinnedSkip}\n`,
    });
    expect(r.out).toContain("got 4 — MORE, not fewer");
    expect(r.out).toContain("SUBSTRING filters");
    // The shortfall advice must NOT appear: acting on it would send the reader
    // looking for a file that was never removed.
    expect(r.out).not.toContain("dropped out of collection");
    expect(r.code).toBe(1);
  }, 60_000);

  test("a pinned name that no longer exists is caught by identity, not by count", async () => {
    // Renaming a test while leaving the pin behind keeps the skip COUNT
    // correct — one pinned, one skipped — so only a lookup by name can see it.
    const base = await fixtures();
    const r = await runGuard(base, ["pass.test.ts", "pinned.test.ts"], {
      LABEL: "renamed",
      TOTAL_EXPECTED: "4",
      EXPECTED_SKIPS: "a pinned name nobody ever wrote\n",
    });
    expect(r.out).toContain('expected skip "a pinned name nobody ever wrote" does not appear');
    expect(r.code).toBe(1);
  }, 60_000);

  test("a pinned test that RAN instead of skipping is caught", async () => {
    // The case where a precondition the runner is not supposed to satisfy
    // becomes satisfied — a real host credential appearing in CI, an inference
    // server showing up. The count would be one lower, but the message that
    // matters is which test changed behaviour.
    const base = await fixtures();
    const r = await runGuard(base, ["pass.test.ts", "pinned.test.ts"], {
      LABEL: "unskipped",
      TOTAL_EXPECTED: "4",
      EXPECTED_SKIPS: `${NAMES.passA}\n`,
    });
    expect(r.out).toContain(`expected skip "${NAMES.passA}" RAN instead of skipping`);
    expect(r.code).toBe(1);
  }, 60_000);

  test("an UNPINNED test that skips is caught even though the total still matches", async () => {
    /**
     * The case a bare `MAX_*_SKIPS` ceiling cannot detect, and the whole reason
     * the pins are names. Collection is 5 either way; one pinned skip is
     * present and correct; but a second, unpinned test also skipped. A ceiling
     * of 2 would have called this fine.
     */
    const base = await fixtures();
    const r = await runGuard(base, ["pass.test.ts", "pinned.test.ts", "orphan-skip.test.ts"], {
      LABEL: "unpinned",
      TOTAL_EXPECTED: "5",
      EXPECTED_SKIPS: `${NAMES.pinnedSkip}\n`,
    });
    expect(r.out).toContain("2 probes skipped, but exactly 1 are pinned by name");
    expect(r.out).toContain("an UNPINNED probe skipped too");
    expect(r.code).toBe(1);
  }, 60_000);

  test("an empty pin list permits no skips at all", async () => {
    /**
     * This is the shape the live-oMLX step takes when someone DOES supply a
     * server: `PIFLEET_OMLX=1` means the probes must RUN, so nothing is
     * pinned and any skip is a defect. Asking for the probes and not getting
     * them has to be loud — a skip silently reachable from a half-configured
     * environment is how a criterion reports green having never executed.
     */
    const base = await fixtures();
    const r = await runGuard(base, ["pinned.test.ts"], {
      LABEL: "nopins",
      TOTAL_EXPECTED: "2",
      EXPECTED_SKIPS: "",
    });
    expect(r.out).toContain("1 probes skipped, but exactly 0 are pinned by name");
    expect(r.code).toBe(1);
  }, 60_000);

  test("a real failure is reported as a failure, never as total drift", async () => {
    /**
     * Order matters here, not just detection. `total` is pass+skip, so a
     * failing test makes the total come up SHORT — arithmetically identical to
     * a dropped file. If the total check ran first, the operator would be told
     * to raise TOTAL_EXPECTED, which papers over the exact regression this job
     * exists to catch. So the assertion is both that it goes red AND that the
     * message is the failure one.
     */
    const base = await fixtures();
    const r = await runGuard(base, ["pass.test.ts", "fail.test.ts"], {
      LABEL: "broken",
      TOTAL_EXPECTED: "3",
      EXPECTED_SKIPS: "",
    });
    expect(r.out).toContain("1 broken probe(s) FAILED");
    expect(r.out).toContain("do not raise TOTAL_EXPECTED");
    expect(r.out).not.toContain("probes collected (pass+skip)");
    expect(r.code).toBe(1);
  }, 60_000);

  test("a test.todo() is a gap, not an accepted skip", async () => {
    const base = await fixtures();
    const r = await runGuard(base, ["pass.test.ts", "todo.test.ts"], {
      LABEL: "unwritten",
      TOTAL_EXPECTED: "3",
      EXPECTED_SKIPS: "",
    });
    expect(r.out).toContain("1 unwritten probe(s) are test.todo()");
    expect(r.code).toBe(1);
  }, 60_000);

  test("being given no files at all is refused, not graded as a pass", async () => {
    // An empty run has 0 failures and 0 skips. Without this check the guard
    // would only object on the total, and a TOTAL_EXPECTED of 0 would sail
    // through — a guard that grades nothing and says ok.
    const base = await fixtures();
    const r = await runGuard(base, [], {
      LABEL: "empty",
      TOTAL_EXPECTED: "0",
      EXPECTED_SKIPS: "",
    });
    expect(r.out).toContain("was given no test files to run");
    expect(r.code).toBe(1);
  }, 60_000);

  test("a missing required variable fails loudly rather than defaulting", async () => {
    // `TOTAL_EXPECTED` unset must not read as 0 and grade an empty collection
    // as correct. `set -u` plus `:?` is what makes a misconfigured workflow
    // step a red step instead of a vacuous green one.
    const base = await fixtures();
    const p = Bun.spawn(["bash", GUARD, "pass.test.ts"], {
      cwd: base,
      env: { ...process.env, LABEL: "novar", JUNIT_FILE: join(base, "r.xml") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    expect(stdout + stderr).toContain("TOTAL_EXPECTED");
    expect(code).not.toBe(0);
  }, 60_000);
});
