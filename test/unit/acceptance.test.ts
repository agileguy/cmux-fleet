/**
 * Acceptance runner — the pure parts (ISC-148..150).
 *
 * Everything here runs without git or a filesystem: tokenization, harness
 * matching, resolution provenance, and the guards that must reject a bad spec
 * BEFORE any side effect. The clone-and-execute path is covered by
 * test/integration/acceptance.test.ts against a real repository.
 */

import { describe, expect, test } from "bun:test";

import { Deadline } from "../../src/util/clock.ts";
import {
  CommandParseError,
  DEFAULT_HARNESS_PATTERNS,
  harnessSurface,
  resolveFromEnvelope,
  runAcceptance,
  tokenize,
} from "../../src/harvest/acceptance.ts";

const SHA_BASE = "a".repeat(40);

describe("tokenize", () => {
  // Fails if tokenization stops splitting on whitespace or starts collapsing
  // quoted arguments — either would change what argv actually executes.
  test("splits words and honors quotes without expansion", () => {
    expect(tokenize("bun test")).toEqual(["bun", "test"]);
    expect(tokenize('grep -q "two words" data.txt')).toEqual(["grep", "-q", "two words", "data.txt"]);
    expect(tokenize("a  b\t c")).toEqual(["a", "b", "c"]);
    // $ inside quotes is a literal byte — there is no shell to expand it.
    expect(tokenize("sh -c 'test -z \"$POISON\"'")).toEqual(["sh", "-c", 'test -z "$POISON"']);
  });

  // Fails if the metacharacter refusal is dropped — a `;` passed through as
  // literal argv silently runs a different command than the author wrote,
  // and a `;` handed to a future shell would run TWO commands.
  test("refuses shell metacharacters outside quotes", () => {
    for (const cmd of ["bun test; rm -rf /", "a | b", "a > out", "echo $HOME", "a && b", "ls *.ts"]) {
      expect(() => tokenize(cmd)).toThrow(CommandParseError);
    }
  });

  // Fails if unterminated input starts being silently accepted, which would
  // execute a truncated argv.
  test("refuses unclosed quotes and empty commands", () => {
    expect(() => tokenize('grep -q "unclosed')).toThrow(CommandParseError);
    expect(() => tokenize("   ")).toThrow(CommandParseError);
  });
});

describe("harnessSurface (ISC-150)", () => {
  // Fails if the default patterns lose any of these classes — each one is a
  // resolution path an acceptance command's meaning flows through.
  test("default patterns match the files a command's meaning resolves through", () => {
    const changed = [
      "test/unit/epoch.test.ts",
      "package.json",
      "Makefile",
      "conftest.py",
      "src/deep/conftest.py",
      ".github/workflows/ci.yml",
      "src/thing.test.ts",
    ];
    const s = harnessSurface(changed);
    expect(new Set(s.touched)).toEqual(new Set(changed));
  });

  // Fails if the matcher inverts (production code counting as harness would
  // cap every verdict at unknown and no task could ever succeed).
  test("production source files are not harness", () => {
    const s = harnessSurface(["src/harvest/adjudicate.ts", "Docs/SRD.md", "README.md"]);
    expect(s.touched).toEqual([]);
  });

  // Fails if caller-supplied patterns stop overriding the defaults — the
  // config wiring depends on this seam.
  test("explicit patterns replace the defaults", () => {
    const s = harnessSurface(["ci/grade.sh", "test/a.test.ts"], ["ci/**"]);
    expect(s.touched).toEqual(["ci/grade.sh"]);
    expect(s.patterns).toEqual(["ci/**"]);
  });

  // Pins the exported defaults as the FALLBACK contract (ISC-232): config
  // decides the surface, and this is what a config with no opinion gets.
  // Fails if the export is emptied or renamed.
  test("defaults are exported and non-empty", () => {
    expect(DEFAULT_HARNESS_PATTERNS.length).toBeGreaterThan(0);
    expect(harnessSurface(["package.json"]).patterns).toEqual([...DEFAULT_HARNESS_PATTERNS]);
  });
});

describe("resolveFromEnvelope (ISC-148)", () => {
  // Fails if provenance stops being pinned — `resolved_from`/`source` are
  // what makes an adjudication auditable after the fact.
  test("carries the command text with source and base SHA", () => {
    const cmds = resolveFromEnvelope(["bun test", "bun run typecheck"], SHA_BASE);
    expect(cmds).toEqual([
      { cmd: "bun test", source: "envelope", resolved_from: SHA_BASE },
      { cmd: "bun run typecheck", source: "envelope", resolved_from: SHA_BASE },
    ]);
  });

  // The load-bearing guard: "HEAD" resolves through the worker's tree, which
  // is the exact bug ISC-148 names. Fails if the sha40 check is loosened.
  test("refuses a symbolic ref as the base", () => {
    expect(() => resolveFromEnvelope(["bun test"], "HEAD")).toThrow(/40-char SHA/);
    expect(() => resolveFromEnvelope(["bun test"], "main")).toThrow(/40-char SHA/);
    expect(() => resolveFromEnvelope(["bun test"], SHA_BASE.slice(0, 12))).toThrow(/40-char SHA/);
  });
});

describe("runAcceptance spec guards (ISC-149)", () => {
  // Fails if the outside-the-worktree guard is removed or runs after the
  // clone — a scratch dir inside the worker's tree is reachable by the
  // worker's own globs and writable by backgrounded work. The paths are
  // fictitious: the guard must reject before touching the filesystem.
  test("a scratch dir inside the worker tree is rejected before any I/O", async () => {
    const spec = {
      repo: "/nonexistent/worker/tree",
      head_sha: SHA_BASE,
      scratch_dir: "/nonexistent/worker/tree/scratch",
      commands: resolveFromEnvelope(["bun test"], SHA_BASE),
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 1_000,
    };
    await expect(runAcceptance(spec)).rejects.toThrow(/ISC-149/);
    // Same dir entirely is just as inside.
    await expect(
      runAcceptance({ ...spec, scratch_dir: "/nonexistent/worker/tree" }),
    ).rejects.toThrow(/ISC-149/);
  });

  // Fails if head_sha validation is loosened to accept refs — a branch name
  // here would grade whatever the branch happens to point at by the time the
  // clone checks out.
  test("a symbolic head is rejected", async () => {
    await expect(
      runAcceptance({
        repo: "/nonexistent/worker/tree",
        head_sha: "main",
        scratch_dir: "/nonexistent/scratch",
        commands: [],
        deadline: new Deadline(60_000),
        per_command_timeout_ms: 1_000,
      }),
    ).rejects.toThrow(/40-char SHA/);
  });
});

/**
 * The harness surface must cover the files through which a command's MEANING
 * resolves, not only the files that look like tests.
 *
 * Found by attacking the real `runAcceptance`: a worker committing a
 * `bunfig.toml` with a `[test] preload` plus the preload script turned a red
 * suite green — the implementation still returning the wrong value — while
 * `harness.touched` came back EMPTY, so the ISC-150 cap never fired. Every
 * ISC-149 control (fresh clone by SHA, no hooks, hermetic env) held and was
 * irrelevant: the sabotage arrived as ordinary committed source.
 *
 * These are regression pins for that class. A denylist cannot fully express
 * "files the command resolves through" — recorded as ISC-237 — so each entry
 * here is a known bypass that has been closed, not a claim of completeness.
 */
describe("harnessSurface covers runner configuration, not just test files", () => {
  const bypasses = [
    ["bunfig.toml", "bun test [test] preload runs before every test file"],
    ["packages/api/bunfig.toml", "the same file, nested"],
    [".npmrc", "npm node-options injects flags into the runner"],
    ["tsconfig.base.json", "tsconfig extends: the entry point keeps its contents, changes its meaning"],
    ["common.mk", "Makefile include: same trick for make"],
    [".tool-versions", "changing WHICH interpreter runs the suite"],
    [".nvmrc", "node version selection"],
    ["deno.json", "deno task/test configuration"],
  ] as const;

  for (const [file, why] of bypasses) {
    test(`${file} is harness — ${why}`, () => {
      expect(harnessSurface([file]).touched).toEqual([file]);
    });
  }

  /**
   * The complement. A pattern list broad enough to match everything would
   * cap every verdict at `unknown` and quietly disable grading altogether —
   * which looks like safety and is the opposite.
   */
  /**
   * Case and depth variants, measured as live misses. Globs are
   * case-sensitive and the test-tree glob was root-anchored with no
   * recursive form, so a monorepo's nested test directory and an ordinary
   * capitalised `Tests` directory both walked straight past the cap.
   */
  const variants = [
    "Tests/helper.ts",
    "Test/helper.ts",
    "packages/api/test/thing.ts",
    "sub/scripts/test.sh",
    "sub/pytest.ini",
    "sub/makefile",
    "Justfile",
    ".github/actions/setup/action.yml",
    "Cargo.toml",
    "go.mod",
  ] as const;
  for (const file of variants) {
    test(`${file} is harness (case/depth variant)`, () => {
      expect(harnessSurface([file]).touched).toEqual([file]);
    });
  }

  /**
   * The one-hop indirection: a CLASSIFIED config naming an UNCLASSIFIED code
   * file. `jest.config.*` was matched while the `setupFiles` it points at was
   * not, so the config could stay byte-identical while the executed code was
   * swapped underneath it.
   */
  const indirection = ["jest.setup.ts", ".mocharc.yml", "vitest.workspace.ts", ".pnpmfile.cjs"] as const;
  for (const file of indirection) {
    test(`${file} is harness (config names code)`, () => {
      expect(harnessSurface([file]).touched).toEqual([file]);
    });
  }

  test("ordinary source is not harness", () => {
    expect(
      harnessSurface(["src/index.ts", "README.md", "src/lib/parse.ts", "docs/design.md"]).touched,
    ).toEqual([]);
  });
});
