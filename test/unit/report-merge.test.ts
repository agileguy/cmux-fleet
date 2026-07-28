/**
 * Merge pre-check against REAL repositories (SRD §9.3).
 *
 * Every scenario here is a real `git init` with real commits, because the
 * subject under test is our reading of git's exit codes and `-z` framing —
 * behaviours pinned by running git 2.50, not by the manpage. The two
 * assertions most likely to regress silently get their own tests: that the
 * check leaves every working tree byte-identical, and that a deleted branch
 * (merge-tree exit 1, same as a conflict) is reported as uncheckable rather
 * than conflicted.
 */

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergePrecheckSchema } from "../../src/contracts.ts";
import { parseConflictedPaths, precheckMerges } from "../../src/report/merge.ts";

let tmp: string;
let repo: string;
let baseSha: string;
let advancedSha: string;

async function run(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err}`);
  return out;
}
const git = (dir: string, ...args: string[]): Promise<string> =>
  run(["git", "-C", dir, ...args], dir);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-mergecheck-"));
  repo = join(tmp, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "fixture@test");
  await git(repo, "config", "user.name", "fixture");
  await writeFile(join(repo, "shared.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "solo.txt"), "untouched\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

  // Two siblings that BOTH merge cleanly onto the base but conflict with
  // EACH OTHER: each rewrites the same line of shared.txt.
  await git(repo, "branch", "fleet/r/w1", baseSha);
  await git(repo, "worktree", "add", "-q", join(tmp, "wt-w1"), "fleet/r/w1");
  await writeFile(join(tmp, "wt-w1", "shared.txt"), "W1\ntwo\nthree\n");
  await git(join(tmp, "wt-w1"), "commit", "-qam", "w1 edit");

  await git(repo, "branch", "fleet/r/w2", baseSha);
  await git(repo, "worktree", "add", "-q", join(tmp, "wt-w2"), "fleet/r/w2");
  await writeFile(join(tmp, "wt-w2", "shared.txt"), "W2\ntwo\nthree\n");
  await git(join(tmp, "wt-w2"), "commit", "-qam", "w2 edit");

  // A third sibling touching only its own file: clean against everyone.
  await git(repo, "branch", "fleet/r/w3", baseSha);
  await git(repo, "worktree", "add", "-q", join(tmp, "wt-w3"), "fleet/r/w3");
  await writeFile(join(tmp, "wt-w3", "w3-only.txt"), "new file\n");
  await git(join(tmp, "wt-w3"), "add", ".");
  await git(join(tmp, "wt-w3"), "commit", "-qm", "w3 adds its own file");

  // The base ADVANCES past dispatch: main rewrites the same line the
  // siblings did, so a branch checked against the advanced base conflicts.
  await writeFile(join(repo, "shared.txt"), "MAIN MOVED\ntwo\nthree\n");
  await git(repo, "commit", "-qam", "main moved on");
  advancedSha = (await git(repo, "rev-parse", "HEAD")).trim();
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The tree-and-HEAD fingerprint the pre-check must never change. */
async function fingerprint(dir: string): Promise<{ status: string; head: string }> {
  return {
    status: await git(dir, "status", "--porcelain"),
    head: (await git(dir, "rev-parse", "HEAD")).trim(),
  };
}

describe("precheckMerges — against the base", () => {
  // Would fail if the check started reporting clean without computing the
  // merge, or if exit 0 stopped being read as clean.
  test("a branch that merges cleanly is clean, with no conflicts", async () => {
    const [r] = await precheckMerges([
      { worker: "w3", branch: "fleet/r/w3", base_ref: baseSha, repo },
    ]);
    expect(r).toBeDefined();
    expect(r!.clean).toBe(true);
    expect(r!.conflicts_with).toEqual([]);
    expect(r!.conflicting_paths).toEqual([]);
    MergePrecheckSchema.parse(r); // the wire contract, not a lookalike
  });

  // Would fail if merge-tree exit 1 stopped being read as a conflict, or if
  // the conflicted-path list were lost in the -z parsing.
  test("a branch conflicting with an advanced base is not clean and names the paths", async () => {
    const [r] = await precheckMerges([
      { worker: "w1", branch: "fleet/r/w1", base_ref: advancedSha, repo },
    ]);
    expect(r!.clean).toBe(false);
    expect(r!.conflicting_paths).toEqual(["shared.txt"]);
  });

  // Would fail if the ancestor fast-path disappeared or reported unclean:
  // an already-landed branch merges as a no-op, which is clean by definition.
  test("a branch already contained in the base is clean and says the merge is a no-op", async () => {
    // advancedSha's history contains baseSha; a branch pointing AT baseSha is
    // therefore already merged.
    await git(repo, "branch", "fleet/r/landed", baseSha);
    const [r] = await precheckMerges([
      { worker: "landed", branch: "fleet/r/landed", base_ref: advancedSha, repo },
    ]);
    expect(r!.clean).toBe(true);
    expect(r!.detail).toContain("no-op");
  });

  /**
   * The trap this module exists to not fall into: merge-tree exits 1 for an
   * unresolvable ref — the SAME code as a conflict. Would fail if a deleted
   * branch ever surfaced as `clean: true` (the `down` lie) or as a conflict
   * (the exit-1 misread); it must read as "nothing was checked".
   */
  test("a deleted branch produces a report row, never clean and never a conflict", async () => {
    const [r] = await precheckMerges([
      { worker: "gone", branch: "fleet/r/deleted-long-ago", base_ref: baseSha, repo },
    ]);
    expect(r!.clean).toBe(false);
    expect(r!.conflicting_paths).toEqual([]);
    expect(r!.conflicts_with).toEqual([]);
    expect(r!.detail).toContain("does not resolve");
  });

  // Would fail if a missing repository started throwing: report is what the
  // operator runs when things went wrong, including "the repo is gone".
  test("a missing repository degrades to an uncheckable row, not a crash", async () => {
    const [r] = await precheckMerges([
      { worker: "w1", branch: "fleet/r/w1", base_ref: baseSha, repo: join(tmp, "no-such-repo") },
    ]);
    expect(r!.clean).toBe(false);
    expect(r!.detail).toContain("nothing was checked");
  });
});

describe("precheckMerges — sibling conflicts (SRD §9.3, conflicts_with)", () => {
  // Would fail if conflicts_with regressed to paths-only or disappeared: the
  // operator's next action is a conversation with the OWNER of the other
  // branch, so the pre-check must name workers, not just files.
  test("two siblings editing the same line name each other, and the clean sibling names no one", async () => {
    const rs = await precheckMerges([
      { worker: "w1", branch: "fleet/r/w1", base_ref: baseSha, repo },
      { worker: "w2", branch: "fleet/r/w2", base_ref: baseSha, repo },
      { worker: "w3", branch: "fleet/r/w3", base_ref: baseSha, repo },
    ]);
    const byWorker = new Map(rs.map((r) => [r.worker, r]));
    // Each merges cleanly onto the base — the pairwise conflict is a separate
    // fact and must not corrupt the base verdict.
    expect(byWorker.get("w1")!.clean).toBe(true);
    expect(byWorker.get("w2")!.clean).toBe(true);
    expect(byWorker.get("w1")!.conflicts_with).toEqual(["w2"]);
    expect(byWorker.get("w2")!.conflicts_with).toEqual(["w1"]);
    expect(byWorker.get("w1")!.conflicting_paths).toContain("shared.txt");
    expect(byWorker.get("w3")!.conflicts_with).toEqual([]);
  });

  // Would fail if an unresolvable sibling started being "conflicted with" by
  // guesswork: no computed merge, no reported conflict.
  test("a deleted sibling is excluded from pairwise checks rather than guessed about", async () => {
    const rs = await precheckMerges([
      { worker: "w3", branch: "fleet/r/w3", base_ref: baseSha, repo },
      { worker: "gone", branch: "fleet/r/deleted-long-ago", base_ref: baseSha, repo },
    ]);
    expect(rs.find((r) => r.worker === "w3")!.conflicts_with).toEqual([]);
  });
});

describe("precheckMerges — leaves every tree untouched", () => {
  /**
   * The property most likely to regress silently: someone "improves" the
   * check with `git merge --no-commit` or a stash-based probe, and the
   * pre-check starts dirtying the trees it inspects. Fingerprints are taken
   * across the repo AND both sibling worktrees, covering the conflicting
   * path — the case where a working-tree merge would definitely write.
   */
  test("status is empty and HEAD identical everywhere after clean, conflicting and pairwise checks", async () => {
    const dirs = [repo, join(tmp, "wt-w1"), join(tmp, "wt-w2")];
    const before = await Promise.all(dirs.map(fingerprint));

    await precheckMerges([
      { worker: "w1", branch: "fleet/r/w1", base_ref: advancedSha, repo },
      { worker: "w2", branch: "fleet/r/w2", base_ref: baseSha, repo },
      { worker: "w3", branch: "fleet/r/w3", base_ref: baseSha, repo },
    ]);

    const after = await Promise.all(dirs.map(fingerprint));
    expect(after).toEqual(before);
    for (const f of after) expect(f.status).toBe("");
    // And no stash entries were created and popped either — a probe that
    // stashes leaves no status but does leave reflog damage on a dirty tree.
    expect(await git(repo, "stash", "list")).toBe("");
  });
});

describe("parseConflictedPaths — the -z framing", () => {
  // Would fail if the double-NUL boundary were missed: everything after it is
  // git's prose ("Auto-merging", "CONFLICT (content)"), which must never be
  // reported to an operator as a conflicted file.
  test("stops at the double NUL and never returns informational prose", () => {
    const oid = "c".repeat(40);
    const raw = `${oid}\0f.txt\0dir/g.ts\0\0` + `1\0f.txt\0Auto-merging\0Auto-merging f.txt\n\0`;
    expect(parseConflictedPaths(raw)).toEqual(["f.txt", "dir/g.ts"]);
  });

  // Would fail if refusal output were parsed as a conflict: merge-tree's
  // "not something we can merge" exits 1 too, and its output has no OID.
  test("returns null when the output does not begin with a tree OID", () => {
    expect(parseConflictedPaths("merge-tree: no-such-branch - not something we can merge\n")).toBeNull();
    expect(parseConflictedPaths("")).toBeNull();
  });

  test("a clean merge yields the OID and no paths", () => {
    expect(parseConflictedPaths(`${"a".repeat(40)}\0`)).toEqual([]);
  });
});
