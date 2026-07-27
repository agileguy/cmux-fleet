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
import {
  MAX_DIFF_BYTES,
  deriveGitFacts,
  mergeLineCounts,
  parseNameStatusZ,
  parseNumstatZ,
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
});
