/**
 * A2 parser layer (SRD §8.2) — the `-z` wire formats, byte-verified.
 *
 * The fixture strings below are transcribed from `od -c` of real git 2.x
 * output, captured while building this module — notably the numstat rename
 * form (`0\t0\t\0old\0new\0`, an EMPTY inline path with the two paths as
 * separate NUL fields), which is easy to get wrong from the manpage alone.
 * The production call sites are pinned by test/integration/harvest.test.ts,
 * which runs these parsers against a real repository's actual output.
 */

import { describe, expect, test } from "bun:test";
import { MAX_ITEMS } from "../../src/contracts.ts";
import {
  MAX_DIFF_BYTES,
  deriveGitFacts,
  hardenedGitArgv,
  mergeLineCounts,
  parseNameStatusZ,
  parseNumstatZ,
  runGit,
  type GitResult,
} from "../../src/harvest/git.ts";

describe("parseNameStatusZ", () => {
  // Would fail if the parser regressed to line/whitespace splitting: -z
  // records are NUL-delimited precisely because paths may contain newlines.
  test("plain add/modify/delete records", () => {
    const raw = ["D", "a.txt", "A", "b.txt", "M", "dir/c.ts", ""].join("\0");
    expect(parseNameStatusZ(raw)).toEqual([
      { path: "a.txt", change: "deleted" },
      { path: "b.txt", change: "added" },
      { path: "dir/c.ts", change: "modified" },
    ]);
  });

  // Would fail if the R branch stopped consuming THREE fields: everything
  // after a rename would shift by one and attribute statuses to wrong paths.
  test("a rename carries two paths and reports the new one", () => {
    const raw = ["R100", "old.txt", "new.txt", "M", "after.ts", ""].join("\0");
    expect(parseNameStatusZ(raw)).toEqual([
      { path: "new.txt", change: "renamed" },
      { path: "after.ts", change: "modified" },
    ]);
  });

  // Would fail if unknown status letters started throwing or being invented:
  // the FileChange enum is the wire contract, so T (typechange) must collapse
  // into an existing member, not extend the vocabulary.
  test("typechange collapses to modified; copy to added", () => {
    const raw = ["T", "link-or-file", "C75", "src.txt", "copy.txt", ""].join("\0");
    expect(parseNameStatusZ(raw)).toEqual([
      { path: "link-or-file", change: "modified" },
      { path: "copy.txt", change: "added" },
    ]);
  });

  // Would fail if a path containing a newline broke record framing — the
  // reason -z exists (worker-controlled filenames, SRD §12.2).
  test("a path containing a newline survives", () => {
    const raw = ["A", "evil\nname.txt", ""].join("\0");
    expect(parseNameStatusZ(raw)).toEqual([{ path: "evil\nname.txt", change: "added" }]);
  });

  test("empty output parses to no changes", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});

describe("parseNumstatZ", () => {
  test("plain records keyed by path", () => {
    const raw = ["4\t0\tb.txt", "0\t3\ta.txt", ""].join("\0");
    const m = parseNumstatZ(raw);
    expect(m.get("b.txt")).toEqual({ added: 4, removed: 0 });
    expect(m.get("a.txt")).toEqual({ added: 0, removed: 3 });
  });

  // Would fail if the rename form were read as an inline path: git emits an
  // EMPTY path field for renames (`0\t0\t\0old\0new\0`) and the counts must
  // land on the NEW name.
  test("the rename form keys counts on the new path", () => {
    const raw = ["2\t1\t", "old.txt", "new.txt", ""].join("\0");
    const m = parseNumstatZ(raw);
    expect(m.get("new.txt")).toEqual({ added: 2, removed: 1 });
    expect(m.has("old.txt")).toBe(false);
  });

  // Would fail if `-` were coerced with Number(): binary files have no line
  // counts, and NaN or 0 would both be false claims.
  test("binary files carry no counts", () => {
    const raw = ["-\t-\timage.png", ""].join("\0");
    expect(parseNumstatZ(raw).get("image.png")).toEqual({});
  });

  // Would fail if the tab-split truncated a path containing a literal tab —
  // -z leaves paths unquoted, so the tail must be rejoined.
  test("a path containing a tab survives", () => {
    const raw = ["1\t0\tweird\tname.txt", ""].join("\0");
    expect(parseNumstatZ(raw).get("weird\tname.txt")).toEqual({ added: 1, removed: 0 });
  });
});

describe("mergeLineCounts", () => {
  // Would fail if the merge started inventing counts for paths numstat did
  // not report (e.g. defaulting to 0/0), or dropping changes without counts.
  test("attaches counts where present and leaves the rest untouched", () => {
    const merged = mergeLineCounts(
      [
        { path: "a.txt", change: "modified" },
        { path: "bin.png", change: "added" },
      ],
      new Map([["a.txt", { added: 4, removed: 1 }]]),
    );
    expect(merged).toEqual([
      { path: "a.txt", change: "modified", lines_added: 4, lines_removed: 1 },
      { path: "bin.png", change: "added" },
    ]);
  });
});

/**
 * Two branches of `deriveGitFacts` that a real repository cannot be made to
 * take, pinned through the injectable runner.
 *
 * Both were found by mutation: reverting each left the entire suite green,
 * because no fixture can build a 32 MiB diff and no healthy repo makes
 * `merge-base` fail. Both failure modes report UNKNOWN facts as verified
 * ones, which is the specific error class this module's header is about.
 */
describe("deriveGitFacts — the branches only a broken git reaches", () => {
  const sha = "a".repeat(40);

  /** A runner that answers each git subcommand from a table. */
  function fakeGit(table: Record<string, GitResult>): (cwd: string, args: string[]) => Promise<GitResult> {
    return (_cwd, args) => {
      const key = args.find((a) => !a.startsWith("-")) ?? args[0] ?? "";
      const sub = args[0] ?? "";
      const hit = table[`${sub} ${key}`] ?? table[sub];
      return Promise.resolve(hit ?? { code: 0, stdout: "", stderr: "" });
    };
  }

  /**
   * ISC-151's other half. Exit 0 = ancestor, 1 = not, anything else = git
   * broke — and "git broke" must not be reported as facts. The mutation that
   * survived made an exit >= 2 fall through BOTH branches and emit a full
   * fact bundle with `base_is_ancestor: true`.
   */
  test("merge-base failing (exit >= 2) yields no facts, not confirmed ancestry", async () => {
    const facts = await deriveGitFacts(
      "/nowhere",
      sha,
      fakeGit({
        "rev-parse": { code: 0, stdout: `${sha}\n`, stderr: "" },
        "merge-base": { code: 128, stdout: "", stderr: "fatal: not a valid object name" },
      }),
    );
    expect(facts.ok).toBe(false);
    expect(facts.facts.base_is_ancestor).toBe(false);
    expect(facts.reasons.join(" ")).toContain("merge-base");
  });

  test("exit 1 is still 'not an ancestor', which is a different answer", async () => {
    const facts = await deriveGitFacts(
      "/nowhere",
      sha,
      fakeGit({
        "rev-parse": { code: 0, stdout: `${sha}\n`, stderr: "" },
        "merge-base": { code: 1, stdout: "", stderr: "" },
      }),
    );
    // `ok` — the harvest succeeded; it is the DIFF that is withheld.
    expect(facts.ok).toBe(true);
    expect(facts.facts.base_is_ancestor).toBe(false);
    expect(facts.reasons.join(" ")).toContain("not an ancestor");
  });

  /**
   * ISC-90: withheld, never truncated. A truncated diff is indistinguishable
   * from a small one to every consumer, so shipping the first 32 MiB while
   * the reason string still says "withheld" is the exact conflation the rule
   * exists to prevent.
   */
  test("an over-cap diff is withheld entirely, not truncated to the cap", async () => {
    const huge = "x".repeat(MAX_DIFF_BYTES + 1024);
    const facts = await deriveGitFacts(
      "/nowhere",
      sha,
      fakeGit({
        "rev-parse": { code: 0, stdout: `${sha}\n`, stderr: "" },
        "merge-base": { code: 0, stdout: "", stderr: "" },
        diff: { code: 0, stdout: huge, stderr: "" },
      }),
    );
    expect(facts.diffText).toBeNull();
    expect(facts.reasons.join(" ")).toContain("withheld");
  });

  /**
   * Review finding 3. `commits` was truncated with a recorded reason from the
   * start; `files_changed` went straight into `.max(MAX_ITEMS)`, so the 1001st
   * changed file made `DerivedFactsSchema.parse` throw out of a module whose
   * contract is "return {ok, reasons}, never throw". A worker touching 1001
   * files is an ordinary large refactor, not an attack — measured before the
   * fix: N=1000 returned ok, N=1001 threw a ZodError.
   */
  function nameStatusFor(n: number): string {
    const fields: string[] = [];
    for (let i = 0; i < n; i++) fields.push("M", `src/f${i}.ts`);
    return `${fields.join("\0")}\0`;
  }

  async function factsForFileCount(n: number) {
    return deriveGitFacts(
      "/nowhere",
      sha,
      fakeGit({
        "rev-parse": { code: 0, stdout: `${sha}\n`, stderr: "" },
        "merge-base": { code: 0, stdout: "", stderr: "" },
        diff: { code: 0, stdout: nameStatusFor(n), stderr: "" },
      }),
    );
  }

  test(`exactly MAX_ITEMS changed files is reported whole, with no truncation reason`, async () => {
    const facts = await factsForFileCount(MAX_ITEMS);
    expect(facts.ok).toBe(true);
    expect(facts.facts.files_changed.length).toBe(MAX_ITEMS);
    expect(facts.reasons.join(" ")).not.toContain("file list truncated");
  });

  // Would fail (by THROWING, not by asserting) against the pre-fix module.
  test("one file past MAX_ITEMS truncates with a reason instead of throwing", async () => {
    const facts = await factsForFileCount(MAX_ITEMS + 1);
    expect(facts.ok).toBe(true);
    expect(facts.facts.files_changed.length).toBe(MAX_ITEMS);
    expect(facts.reasons.join(" ")).toContain(`file list truncated from ${MAX_ITEMS + 1}`);
  });

  /**
   * The count must be guarded BEFORE the schema sees the array, not by
   * catching the ZodError after. Zod validates every element before enforcing
   * the array's `.max()`, so a long array reaches element validation first:
   * measured at N=100000, parsing cost 77 ms and 20 MB of heap for valid
   * elements and 511 ms / 1122 MB for invalid ones. Guarding the count means
   * that array is never parsed at all — which is why this stays fast.
   */
  test("a 100k-file diff truncates cheaply rather than parsing 100k elements", async () => {
    const t0 = performance.now();
    const facts = await factsForFileCount(100_000);
    const elapsed = performance.now() - t0;
    expect(facts.ok).toBe(true);
    expect(facts.facts.files_changed.length).toBe(MAX_ITEMS);
    expect(facts.reasons.join(" ")).toContain("file list truncated from 100000");
    // Generous by 10x against the measured pre-fix 77 ms parse; this fails
    // loudly if the guard ever moves back to after the schema.
    expect(elapsed).toBeLessThan(2_000);
  });
});

/**
 * Review finding 2 — the environment scrub had ZERO coverage.
 *
 * Mutation-confirmed before this suite existed: replacing the literal in
 * `git.ts` with a `...process.env` spread left the whole suite green, as did
 * pointing `GIT_CONFIG_GLOBAL` at the operator's real `~/.gitconfig` and
 * restoring the real `HOME`. The docstring said the spread had already been a
 * bug once; a docstring is not a control.
 *
 * The expected environment below is written out LONGHAND on purpose. Importing
 * `HERMETIC_GIT_ENV` and comparing it to itself would agree with any mutation
 * applied to it, which is precisely the failure mode being fixed.
 */
describe("runGit's environment is a literal, never process.env (finding 2)", () => {
  /** Capture the options object `runGit` hands to Bun.spawn. */
  async function captureSpawnEnv(): Promise<Record<string, string>> {
    const real = Bun.spawn;
    let captured: Record<string, string> | undefined;
    try {
      Bun.spawn = ((...args: unknown[]) => {
        const opts = args[1] as { env?: Record<string, string> } | undefined;
        captured = opts?.env;
        return (real as unknown as (...a: unknown[]) => unknown)(...args);
      }) as typeof Bun.spawn;
      await runGit(process.cwd(), ["--version"]);
    } finally {
      Bun.spawn = real;
    }
    if (captured === undefined) throw new Error("Bun.spawn was never called with an env");
    return captured;
  }

  test("the spawned environment equals the intended key set and values exactly", async () => {
    const env = await captureSpawnEnv();
    expect(env).toEqual({
      PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
      HOME: "/dev/null",
      LC_ALL: "C",
      TERM: "dumb",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GIT_EXTERNAL_DIFF: "",
    });
  });

  /**
   * `toEqual` above already rejects extra keys, but it rejects them against a
   * list written by hand — so it can only catch what that list anticipates.
   * A canary planted in `process.env` at run time catches the spread by its
   * mechanism instead of by its contents, and names the leak in the failure.
   */
  test("nothing from process.env reaches the subprocess, canary included", async () => {
    const canary = "PIFLEET_ENV_CANARY_FINDING_2";
    process.env[canary] = "leaked";
    try {
      const env = await captureSpawnEnv();
      expect(Object.keys(env)).not.toContain(canary);
      expect(Object.values(env)).not.toContain("leaked");
      // The harvester's real HOME and any credential paths are the actual
      // prize: GOOGLE_APPLICATION_CREDENTIALS, CLOUDSDK_*, KUBECONFIG.
      expect(env["HOME"]).toBe("/dev/null");
      expect(env["HOME"]).not.toBe(process.env["HOME"]);
    } finally {
      delete process.env[canary];
    }
  });
});

/**
 * The hardening flag list is shared with `harvest/acceptance.ts`, which spawns
 * git at three more sites. Nothing pinned the shape of that list, and the two
 * regressions this file's header describes were both about WHERE a flag went
 * rather than whether it existed.
 */
describe("hardenedGitArgv (finding 1)", () => {
  test("every spawn carries the config pins that stop the repo choosing programs", () => {
    const argv = hardenedGitArgv("/repo", ["show", "abc:file"]);
    expect(argv.slice(0, 3)).toEqual(["git", "-C", "/repo"]);
    const joined = argv.join(" ");
    for (const pin of [
      "core.fsmonitor=",
      "core.hooksPath=/dev/null",
      "core.attributesFile=/dev/null",
      "diff.external=",
      "protocol.ext.allow=never",
      "--no-pager",
    ]) {
      expect(joined).toContain(pin);
    }
  });

  // The exact regression the module header records: these two are diff-family
  // options, and putting them in the global list breaks init/rev-parse/merge-base
  // with "unknown option" while the parser unit tests stay green.
  test("driver flags attach to diff-family subcommands only", () => {
    expect(hardenedGitArgv("/r", ["diff", "a...b"])).toContain("--no-ext-diff");
    expect(hardenedGitArgv("/r", ["diff", "a...b"])).toContain("--no-textconv");
    expect(hardenedGitArgv("/r", ["show", "a:b"])).toContain("--no-textconv");
    expect(hardenedGitArgv("/r", ["rev-parse", "HEAD"])).not.toContain("--no-ext-diff");
    expect(hardenedGitArgv("/r", ["merge-base", "a", "b"])).not.toContain("--no-ext-diff");
    expect(hardenedGitArgv("/r", ["clone", "--quiet", "/src", "/dst"])).not.toContain("--no-ext-diff");
    expect(hardenedGitArgv("/r", ["checkout", "--detach", "sha"])).not.toContain("--no-textconv");
  });

  test("the driver flags land after the subcommand, not before it", () => {
    const argv = hardenedGitArgv("/r", ["diff", "--numstat", "a...b"]);
    expect(argv.indexOf("diff")).toBeLessThan(argv.indexOf("--no-ext-diff"));
    expect(argv[argv.length - 1]).toBe("a...b");
  });
});
