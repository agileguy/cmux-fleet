/**
 * No test file leaves a `PIFLEET_*` variable different at process exit from what
 * it was at process load (ISC-278).
 *
 * WHY THE CRITERION IS WORDED OVER THE PROPERTY AND NOT OVER THE THREE KNOWN
 * SITES. Because fixing the sites is not what closes it. The defect is
 * invisible to the suite in BOTH states: `test/unit/tui-command.test.ts` leaked
 * `PIFLEET_RUNS_DIR` to process exit pointing at a directory its own `afterAll`
 * had deleted, and it passed 7/7 before the fix and 7/7 after it. Nothing in 55
 * test files went red, and nothing would have. A defect no test can see in
 * either state regresses silently the moment the person who swept for it stops
 * sweeping.
 *
 * WHY A TEST FILE CANNOT ASSERT IT DIRECTLY, WHICH DICTATES THIS FILE'S SHAPE.
 * The property is about the process AFTER the last test file finishes, and no
 * test file is running then. Nor can this file assert it by running last: bun
 * executes files in `readdir()` order — not alphabetical, not argument order,
 * and different between APFS and a fresh Linux CI clone — so "runs last" is not
 * a thing a file can be. The instrument therefore lives in a PRELOAD
 * (`test/support/env-hygiene.ts`, armed by `test/support/env-hygiene-preload.ts`
 * from `bunfig.toml`), and this file's job is the two things a test file CAN do
 * about an instrument it cannot be:
 *
 *   1. Prove the instrument is armed in this very process, and wired durably in
 *      `bunfig.toml` rather than by whatever command happened to be typed.
 *   2. Prove the instrument can FAIL — by running real child `bun test` runs
 *      over fixtures that leak, and showing they come back non-zero naming the
 *      variable, while a fixture that restores comes back clean.
 *
 * Point 2 is the one that matters. `test/support/env-sweep.ts` documents what
 * this repo shipped without it: a sweep asserting `toEqual([])` against an array
 * it could never have filled, green on every commit and on every possible
 * commit. A guard that has only ever been observed passing is not evidence, and
 * the child runs below are the only way to observe this one failing without
 * deliberately breaking the suite it guards.
 *
 * COST, STATED PLAINLY BECAUSE `bunfig.toml`'s own comments care about it: the
 * preload attaches to EVERY `bun test` invocation in the repo, including the
 * narrow single-file runs that are this codebase's inner loop. It is one small
 * module, one `Object.entries` over `process.env` at load and one more at exit —
 * no I/O, no subprocess, nothing that scales with the suite. What it can do to a
 * narrow run is fail it: a single-file run of a file that leaks now goes red at
 * the end, which is the entire point, but it means the failure can appear in a
 * run that is not "about" that file.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envDrift,
  formatDrift,
  GUARD_KEY,
  GUARDED_PREFIX,
  installedGuard,
  snapshotPrefixed,
} from "../support/env-hygiene.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const PRELOAD = new URL("../support/env-hygiene-preload.ts", import.meta.url).pathname;

/** The variable the child fixtures mutate. Distinctive so it cannot collide. */
const PROBE = `${GUARDED_PREFIX}ENV_HYGIENE_FIXTURE`;

/**
 * Budget for one child `bun test`.
 *
 * Measured on this machine, not guessed: a one-test child run costs ~16 ms end
 * to end (`time bun test --preload … a.test.ts` → 0.016 s total, of which bun
 * reports 9 ms as test time), so the four child runs below account for the
 * whole file's ~70 ms. Nothing here transpiles a CLI entrypoint, which is what
 * makes it three orders of magnitude cheaper than the spawns
 * `test/support/budget.ts` models — that helper costs every spawn at ~1900 ms
 * because it models `bun run <cli>`, and it is scoped to integration and e2e.
 * Importing it here would import a model of a different thing.
 *
 * 15 s is therefore a CEILING and not a performance assertion: three orders of
 * magnitude of headroom over the measurement, present only so a child that
 * hangs dies as a hang rather than tripping bun's 5 s default and reporting a
 * timeout that reads like a guard failure.
 */
const CHILD_MS = 15_000;

interface ChildRun {
  readonly code: number;
  /** stdout and stderr together — bun reports hook failures across both. */
  readonly output: string;
}

/**
 * Run `bun test` over one fixture file in a throwaway directory, with the guard
 * preloaded exactly as `bunfig.toml` preloads it.
 *
 * The temp directory is the isolation: it has no `bunfig.toml`, so the only
 * preload in effect is the one named here, and the only test file is the
 * fixture. What comes back is a real bun exit code from a real run.
 */
async function runChild(fixture: string, extraEnv: Record<string, string> = {}): Promise<ChildRun> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-envguard-"));
  try {
    await writeFile(join(dir, "fixture.test.ts"), fixture, "utf8");
    const proc = Bun.spawn({
      cmd: ["bun", "test", "--preload", PRELOAD, "fixture.test.ts"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...extraEnv },
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, output: `${out}\n${err}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fixture whose single test runs `body` and passes. */
function fixture(body: string): string {
  return [
    'import { test, expect } from "bun:test";',
    'test("fixture", () => {',
    body,
    "  expect(1).toBe(1);",
    "});",
    "",
  ].join("\n");
}

describe("the guard is armed in this process and wired to stay armed", () => {
  test("the preload ran here — this is what proves bunfig is doing its job", () => {
    // If someone deletes the `preload` line from bunfig.toml, this is the test
    // that notices. Nothing else in the suite would.
    const guard = installedGuard();
    expect(guard).not.toBeNull();
    expect(guard?.prefix).toBe(GUARDED_PREFIX);
    expect(typeof guard?.baseline).toBe("object");
  });

  test("bunfig.toml names the preload, so a bare `bun test` is covered", () => {
    // The property was found by a human reading code, not by any command anyone
    // runs on purpose. A guard that only attaches when someone remembers to
    // pass --preload guards nothing.
    const bunfig = readFileSync(`${ROOT}bunfig.toml`, "utf8");
    const testSection = bunfig.slice(bunfig.indexOf("[test]"));
    expect(testSection).toContain("preload");
    expect(testSection).toContain("./test/support/env-hygiene-preload.ts");
  });

  test("the guard parked itself under a name a test can find without importing it", () => {
    expect((globalThis as Record<string, unknown>)[GUARD_KEY]).toBeDefined();
  });
});

describe("what counts as drift", () => {
  test("a variable that was absent and is now set is drift", () => {
    // This is the shape the tui-command.test.ts leak actually had.
    expect(envDrift({}, { [PROBE]: "/tmp/gone" })).toEqual([
      { name: PROBE, before: undefined, after: "/tmp/gone", kind: "set" },
    ]);
  });

  test("a variable that was set and is now absent is drift", () => {
    // The unconditional `delete process.env[...]` teardown: harmless when the
    // variable was absent, which is why it survives review, and destructive of
    // a developer's own value when it was not.
    expect(envDrift({ [PROBE]: "mine" }, {})).toEqual([
      { name: PROBE, before: "mine", after: undefined, kind: "cleared" },
    ]);
  });

  test("a variable whose value moved is drift", () => {
    expect(envDrift({ [PROBE]: "a" }, { [PROBE]: "b" })).toEqual([
      { name: PROBE, before: "a", after: "b", kind: "changed" },
    ]);
  });

  test("an unchanged environment is not drift, and neither is a set-then-restored one", () => {
    expect(envDrift({ [PROBE]: "a" }, { [PROBE]: "a" })).toEqual([]);
    expect(envDrift({}, {})).toEqual([]);
  });

  test("several drifts are reported together and in a stable order", () => {
    const drifts = envDrift(
      { [`${GUARDED_PREFIX}B`]: "1", [`${GUARDED_PREFIX}C`]: "1" },
      { [`${GUARDED_PREFIX}A`]: "1", [`${GUARDED_PREFIX}B`]: "2" },
    );
    expect(drifts.map((d) => d.name)).toEqual([
      `${GUARDED_PREFIX}A`,
      `${GUARDED_PREFIX}B`,
      `${GUARDED_PREFIX}C`,
    ]);
  });

  test("only the guarded namespace is watched", () => {
    const snap = snapshotPrefixed({ [PROBE]: "x", PATH: "/usr/bin", HOME: undefined });
    expect(snap).toEqual({ [PROBE]: "x" });
  });

  test("the report names the variable, both values, and the idiom that fixes it", () => {
    const text = formatDrift(envDrift({}, { [PROBE]: "/tmp/gone" }));
    expect(text).toContain(PROBE);
    expect(text).toContain("/tmp/gone");
    expect(text).toContain("<absent>");
    expect(text).toContain("afterAll");
    expect(formatDrift([])).toBe("");
  });
});

describe("the guard fails a real run — the part that makes it evidence", () => {
  test(
    "a fixture that sets a PIFLEET_* variable and walks away fails the run, by name",
    async () => {
      const run = await runChild(fixture(`  process.env["${PROBE}"] = "/tmp/leaked";`));
      // The fixture's own test PASSES. That is the whole problem this closes:
      // the suite is green and the environment is corrupt.
      expect(run.output).toContain("1 pass");
      expect(run.code).not.toBe(0);
      expect(run.output).toContain(PROBE);
      expect(run.output).toContain("/tmp/leaked");
      expect(run.output).toContain("differ at process exit from process load");
    },
    CHILD_MS,
  );

  test(
    "a fixture that sets and restores passes — the guard is not simply failing everything",
    async () => {
      const run = await runChild(
        [
          'import { test, expect, afterAll } from "bun:test";',
          `const BEFORE = process.env["${PROBE}"];`,
          "afterAll(() => {",
          `  if (BEFORE === undefined) delete process.env["${PROBE}"];`,
          `  else process.env["${PROBE}"] = BEFORE;`,
          "});",
          'test("fixture", () => {',
          `  process.env["${PROBE}"] = "/tmp/temporary";`,
          `  expect(process.env["${PROBE}"]).toBe("/tmp/temporary");`,
          "});",
          "",
        ].join("\n"),
      );
      expect(run.code).toBe(0);
      expect(run.output).not.toContain("differ at process exit");
    },
    CHILD_MS,
  );

  test(
    "an unconditional delete is caught when the variable was already set",
    async () => {
      // The `git-hardening.test.ts` shape: a `finally` that deletes rather than
      // restoring. Invisible in the usual case and destructive in the other, so
      // the guard has to be handed the other one to show it sees it.
      const run = await runChild(fixture(`  delete process.env["${PROBE}"];`), {
        [PROBE]: "set-by-the-developer",
      });
      expect(run.code).not.toBe(0);
      expect(run.output).toContain("cleared");
      expect(run.output).toContain("set-by-the-developer");
    },
    CHILD_MS,
  );

  test(
    "a clean fixture that never touches the environment passes",
    async () => {
      const run = await runChild(fixture("  const noop = 1; expect(noop).toBe(1);"));
      expect(run.code).toBe(0);
    },
    CHILD_MS,
  );
});

describe("this file leaves the environment as it found it", () => {
  // Said out loud because a guard's own test mutating the thing it guards is
  // the obvious way to produce a guard that fails on itself. It does not touch
  // process.env at all: every mutation above happens in a child process, and
  // the pure-function cases are handed literals rather than the real env.
  const OWN_BASELINE = snapshotPrefixed(process.env);

  afterAll(() => {
    expect(envDrift(OWN_BASELINE, snapshotPrefixed(process.env))).toEqual([]);
  });

  test("the fixtures run out-of-process, so nothing here can drift", () => {
    expect(process.env[PROBE]).toBeUndefined();
  });
});
