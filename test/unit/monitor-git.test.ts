/**
 * The git strip preserves what `git-watch` showed (ISC-486), and invokes
 * neither `watch(1)` nor a pager (ISC-487).
 *
 * ## Why the five properties are asserted individually rather than as a snapshot
 *
 * Each one was paid for once already, on a live console, and a snapshot test
 * fails as a single opaque diff that a reader fixes by re-recording. These fail
 * one at a time, naming which measured lesson was dropped.
 *
 * The most important is `--no-pager`. Without it `git log` finds a terminal on
 * stdout, starts `less`, and the loop stops at `(END)` — the pane shows a
 * plausible commit list and refreshes never, which `operations-plan.ts:697-703`
 * calls "the exact failure a screenshot cannot distinguish from success". It is
 * the failure mode this repository is most likely to reintroduce, because
 * everything about it looks like success.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logArgv, readGit, statusArgv } from "../../src/monitor/read/git.ts";

const NOW = 1_756_000_000_000;
const now = () => NOW;

/** A fake `git` that records what it was asked and replies from a table. */
function fakeGit(table: Record<string, { ok: boolean; out: string }>) {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const key = args.includes("status") ? "status" : "log";
    return table[key] ?? { ok: true, out: "" };
  };
  return { run, calls };
}

const STATUS_OUT = ["## main...origin/main [ahead 1]", " M src/config/render.ts", "?? Docs/x.md", ""].join(
  "\n",
);
const LOG_OUT = ["3355338 Docs: add SRD", "a4c4337 Dispatch to a tui worker", ""].join("\n");

const okTable = { status: { ok: true, out: STATUS_OUT }, log: { ok: true, out: LOG_OUT } };

describe("ISC-486: the five properties the incumbent had", () => {
  test("the branch line survives, which is what --branch is for", async () => {
    const { run } = fakeGit(okTable);
    const r = await readGit({ watchDir: "/w", now, run });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.branchLine).toBe("## main...origin/main [ahead 1]");
  });

  test("the short status survives, and the branch line is not counted among the paths", async () => {
    const { run } = fakeGit(okTable);
    const r = await readGit({ watchDir: "/w", now, run });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.statusLines).toEqual([" M src/config/render.ts", "?? Docs/x.md"]);
  });

  test("the commit list survives, ten deep as the incumbent fetched", async () => {
    const { run, calls } = fakeGit(okTable);
    const r = await readGit({ watchDir: "/w", now, run });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.commitLines).toHaveLength(2);
    // D12 keeps the content in full; compressing at the SOURCE would make the
    // `[c]` expansion lossy and there would be nothing to expand to.
    expect(calls.find((c) => c.includes("log"))).toContain("-10");
  });

  test("the watched directory is carried, and reached with -C rather than a cd", async () => {
    const { run, calls } = fakeGit(okTable);
    const r = await readGit({ watchDir: "/somewhere/else", now, run });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.watchDir).toBe("/somewhere/else");
    for (const c of calls) {
      expect(c).toContain("-C");
      expect(c[c.indexOf("-C") + 1]).toBe("/somewhere/else");
      expect(c).not.toContain("cd");
    }
  });

  /**
   * THE ONE THAT COST A PANE. `--no-pager` on both invocations.
   */
  test("--no-pager is on every git invocation", async () => {
    const { run, calls } = fakeGit(okTable);
    await readGit({ watchDir: "/w", now, run });
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toContain("--no-pager");
  });

  /**
   * Q8's reversal, asserted at the model layer: both halves are always read, so
   * which one is shown is purely a rendering choice and expanding costs no
   * latency. A reader that fetched commits lazily would make `[c]` a spinner.
   */
  test("both halves are read even though only one is shown by default", async () => {
    const { run } = fakeGit(okTable);
    const r = await readGit({ watchDir: "/w", now, run });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.commitsExpanded).toBe(false);
    expect(r.value.commitLines.length).toBeGreaterThan(0);
  });
});

describe("ISC-486: the failure modes are distinguished rather than flattened", () => {
  /**
   * An empty strip reads as A CLEAN TREE, which is a reassuring claim and a
   * different one from "this is not a repository". The incumbent's `|| true`
   * made the same distinction at the shell level.
   */
  test("a directory that is not a repository is failed, never an empty clean-looking strip", async () => {
    const { run } = fakeGit({ status: { ok: false, out: "" }, log: { ok: false, out: "" } });
    const r = await readGit({ watchDir: "/not-a-repo", now, run });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.reason).toContain("/not-a-repo");
  });

  /**
   * …but a repository with NO COMMITS is real, and its status is still worth
   * showing. Failing the whole strip on an empty log would blank a pane for a
   * freshly-initialised repo.
   */
  test("a failed log does not fail the strip when status succeeded", async () => {
    const { run } = fakeGit({
      status: { ok: true, out: STATUS_OUT },
      log: { ok: false, out: "" },
    });
    const r = await readGit({ watchDir: "/w", now, run });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.commitLines).toEqual([]);
    expect(r.value.statusLines.length).toBeGreaterThan(0);
  });

  /** A dropped `--branch` must not render a path as a branch. */
  test("status output with no branch line yields an empty branch, not a mislabelled path", async () => {
    const { run } = fakeGit({
      status: { ok: true, out: " M only/a/path.ts\n" },
      log: { ok: true, out: LOG_OUT },
    });
    const r = await readGit({ watchDir: "/w", now, run });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.branchLine).toBe("");
    expect(r.value.statusLines).toEqual([" M only/a/path.ts"]);
  });

  test("a throwing runner is a failed region, never an escaping exception", async () => {
    const r = await readGit({
      watchDir: "/w",
      now,
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(r.status).toBe("failed");
  });
});

describe("ISC-487 anti: no watch(1), no pager, and no shell", () => {
  const SOURCE = readFileSync(
    new URL("../../src/monitor/read/git.ts", import.meta.url).pathname,
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * `watch(1)` is a procps tool macOS does not ship — a HOST fact, not a pane
   * fact (`operations-plan.ts:47-50`). The pane that recorded it is being
   * replaced, and retiring the constraint with it would lose a measured
   * property to a refactor.
   */
  test("watch(1) is never invoked", () => {
    expect(SOURCE).not.toMatch(/["'`]watch["'`]/);
    expect(SOURCE).not.toMatch(/\bwatch\s+-n/);
  });

  test("no pager is reachable", () => {
    expect(SOURCE).not.toContain("less");
    expect(SOURCE).not.toContain("PAGER");
    // The positive form: the flag is present in both builders.
    expect(statusArgv("/w")).toContain("--no-pager");
    expect(logArgv("/w")).toContain("--no-pager");
  });

  /**
   * No shell at all. `--command` text in the incumbent was shell-INJECTED
   * (`operations-plan.ts:51-54`), which is why every interpolated value there
   * goes through `shellQuote`. Spawning argv directly removes the injection
   * surface rather than quoting around it — a watch directory containing a
   * quote or a semicolon is inert here.
   */
  test("git is spawned as argv, never through a shell", () => {
    expect(SOURCE).not.toContain("/bin/sh");
    expect(SOURCE).not.toContain("shell: true");
    expect(SOURCE).not.toContain("shellQuote");
  });

  test("a hostile watch directory is data, not syntax", async () => {
    const { run, calls } = fakeGit(okTable);
    const hostile = '/tmp/"; rm -rf /; echo "';
    await readGit({ watchDir: hostile, now, run });
    for (const c of calls) {
      // The whole string arrives as ONE argv element. Nothing split it.
      expect(c).toContain(hostile);
      expect(c.some((a) => a.includes("rm -rf") && a !== hostile)).toBe(false);
    }
  });
});

describe("the argv builders take only a directory", () => {
  /**
   * The same shape `docker.ts` uses and for the same reason: a builder that
   * accepts a subcommand is one refactor from accepting any git command, on a
   * surface whose whole claim is that it cannot act.
   */
  test("each builder takes exactly one parameter", () => {
    expect(statusArgv.length).toBe(1);
    expect(logArgv.length).toBe(1);
  });

  test("the argvs are exactly these, byte for byte", () => {
    expect(statusArgv("/w")).toEqual([
      "git",
      "--no-pager",
      "-C",
      "/w",
      "status",
      "--short",
      "--branch",
    ]);
    expect(logArgv("/w")).toEqual(["git", "--no-pager", "-C", "/w", "log", "--oneline", "-10"]);
  });
});

describe("against a real repository (ISC-491: no terminal, no fleet)", () => {
  /**
   * One end-to-end case with the REAL spawn, because every test above uses a
   * fake runner and a fake can agree with a wrong implementation. This one
   * needs no terminal and no fleet — only `git`, which the repository's own
   * test suite already depends on.
   */
  test("reads this repository's own status without a terminal", async () => {
    const r = await readGit({ watchDir: process.cwd(), now });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.branchLine).toStartWith("##");
    expect(r.value.watchDir).toBe(process.cwd());
  });

  test("a directory that is not a repository fails rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-nogit-"));
    try {
      const r = await readGit({ watchDir: dir, now });
      expect(r.status).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
