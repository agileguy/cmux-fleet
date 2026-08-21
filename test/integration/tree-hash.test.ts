/**
 * The ISC-154 worktree content hash, against real git (`src/run/treehash.ts`).
 *
 * This file proves the MODULE. On its own that is not enough to close
 * ISC-154 — a unit test over a callerless module proves the module, not the
 * criterion — and the wired halves live where the callers do:
 * `supervisor.test.ts` for the quiesce sample the supervisor takes at settle,
 * and `harvest.test.ts` for the harvest-end sample and the verdict it forces.
 *
 * What this file is for is the property those two depend on and neither can
 * isolate: that the hash can SEE the mutations the criterion is about. The
 * criterion's failure mode is a hash that cannot fail — `git write-tree` over
 * the index cannot see an untracked file, and `git status --porcelain`
 * cannot see a second edit to an already-modified one — and either would sail
 * through the wired tests' happy paths while making the check permanently
 * inert. So each mutation is asserted separately, against a real repository.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/harvest/git.ts";
import { worktreeContentHash, writeTreeSnapshot } from "../../src/run/treehash.ts";
import { cliBudget } from "../support/budget.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A real repository with one committed file and one committed directory. */
async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-treehash-"));
  dirs.push(dir);
  await runGit(dir, ["init", "-q", "-b", "main"]);
  await runGit(dir, ["config", "user.email", "fixture@test"]);
  await runGit(dir, ["config", "user.name", "fixture"]);
  await writeFile(join(dir, "tracked.txt"), "original\n");
  await writeFile(join(dir, "doomed.txt"), "delete me\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "keep.ts"), "export const keep = 1;\n");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-qm", "base"]);
  return dir;
}

/** The hash, asserted present — every case below compares two real values. */
async function hash(dir: string): Promise<string> {
  const h = await worktreeContentHash(dir);
  expect(h).not.toBeNull();
  return h!;
}

describe("the worktree content hash observes what ISC-154 is about", () => {
  /**
   * THE criterion's own scenario. Backgrounded work does not politely `git
   * add` what it writes; it drops files into the tree. An index-only hash
   * cannot see this, which is why the check has to construct its index from
   * the working tree rather than read the existing one.
   */
  test("a NEW untracked file appearing between two samples moves the hash", async () => {
    const dir = await scratchRepo();
    const before = await hash(dir);
    await writeFile(join(dir, "background-output.log"), "the build kept running\n");
    const after = await hash(dir);
    expect(after).not.toBe(before);
  }, cliBudget(2));

  /** Nested one level down, where a `?? dir/` status line would collapse it. */
  test("an untracked file under an untracked directory still moves the hash", async () => {
    const dir = await scratchRepo();
    await mkdir(join(dir, "out"), { recursive: true });
    await writeFile(join(dir, "out", "first"), "one\n");
    const before = await hash(dir);
    await writeFile(join(dir, "out", "second"), "two\n");
    const after = await hash(dir);
    expect(after).not.toBe(before);
  }, cliBudget(2));

  test("a modified tracked file moves the hash", async () => {
    const dir = await scratchRepo();
    const before = await hash(dir);
    await writeFile(join(dir, "tracked.txt"), "rewritten\n");
    const after = await hash(dir);
    expect(after).not.toBe(before);
  }, cliBudget(2));

  /**
   * The status-line blind spot, stated as a test: a file that was ALREADY
   * modified at the first sample and is modified AGAIN before the second.
   * `git status --porcelain` prints ` M tracked.txt` both times, so a
   * status-based hash reads this as silence.
   */
  test("a SECOND edit to an already-modified file still moves the hash", async () => {
    const dir = await scratchRepo();
    await writeFile(join(dir, "tracked.txt"), "first edit\n");
    const before = await hash(dir);
    await writeFile(join(dir, "tracked.txt"), "second edit\n");
    const after = await hash(dir);
    expect(after).not.toBe(before);
  }, cliBudget(2));

  test("a deleted tracked file moves the hash", async () => {
    const dir = await scratchRepo();
    const before = await hash(dir);
    await unlink(join(dir, "doomed.txt"));
    const after = await hash(dir);
    expect(after).not.toBe(before);
  }, cliBudget(2));

  /**
   * The other direction, and the one that makes every assertion above mean
   * something: an untouched tree hashes IDENTICALLY across two independent
   * samples. Without this, "the hash changed" is unfalsifiable — a hash that
   * embedded a timestamp or a temp path would pass all five tests above and
   * force `unknown` on every honest task in the fleet.
   */
  test("an untouched worktree hashes identically across two samples", async () => {
    const dir = await scratchRepo();
    await writeFile(join(dir, "tracked.txt"), "some real work\n");
    await writeFile(join(dir, "untracked.txt"), "and some output\n");
    expect(await hash(dir)).toBe(await hash(dir));
  }, cliBudget(2));

  /**
   * The hash is independent of HEAD by construction, but committing is still
   * a WRITE the tree records — the staged content leaves the working tree's
   * dirty state and the tree object changes. Named so the semantics are not
   * discovered later by a task that was voided for committing after quiesce.
   */
  test("committing after the first sample moves the hash", async () => {
    const dir = await scratchRepo();
    await writeFile(join(dir, "tracked.txt"), "work\n");
    await runGit(dir, ["add", "-A"]);
    const before = await hash(dir);
    await writeFile(join(dir, "late.txt"), "written after quiesce\n");
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-qm", "backgrounded commit"]);
    const after = await hash(dir);
    expect(after).not.toBe(before);
  }, cliBudget(3));
});

describe("a hash that cannot be taken is absent, never wrong", () => {
  /**
   * `null` is the only safe failure. The adjudicator fires on two PRESENT
   * values that differ, so an unhashable worktree contributes no opinion —
   * a harvest that could not reach the tree must never be able to void a
   * task, and a sentinel string would do exactly that against a real hash.
   */
  test("a path that is not a repository yields null, not a value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-nonrepo-"));
    dirs.push(dir);
    await writeFile(join(dir, "loose.txt"), "no git here\n");
    expect(await worktreeContentHash(dir)).toBeNull();
  }, cliBudget(1));

  test("a path that does not exist yields null", async () => {
    expect(await worktreeContentHash(join(tmpdir(), "pifleet-absent-xyzzy"))).toBeNull();
  }, cliBudget(1));

  /**
   * The failure REASON survives at the lower seam even though the sampler
   * discards it — `run/worktree.ts` turns it into a `WorktreeError`, and a
   * shared throw-or-null would have forced that caller to catch and lose it.
   */
  test("the underlying snapshot reports which git invocation failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-nonrepo-"));
    dirs.push(dir);
    const snap = await writeTreeSnapshot(dir);
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.what).toContain(dir);
  }, cliBudget(1));

  /** A hash is a git tree object id — 40 hex characters, nothing else. */
  test("the value is a git tree object id", async () => {
    const dir = await scratchRepo();
    expect(await hash(dir)).toMatch(/^[0-9a-f]{40}$/);
  }, cliBudget(1));
});

describe("the snapshot leaves the checkout it measured alone", () => {
  /**
   * The throwaway index is the whole reason this is usable during harvest,
   * which is documented as a pure read. If `add -A` reached the real
   * `.git/index`, sampling would STAGE the worker's uncommitted work — and
   * the next `git status`, `git diff` or `down --prune` would see a tree the
   * harvester created rather than the one the worker left.
   */
  test("sampling stages nothing a later git status would see", async () => {
    const dir = await scratchRepo();
    await writeFile(join(dir, "tracked.txt"), "dirty\n");
    await writeFile(join(dir, "fresh.txt"), "untracked\n");
    const before = await runGit(dir, ["status", "--porcelain"]);
    await hash(dir);
    const after = await runGit(dir, ["status", "--porcelain"]);
    expect(after.stdout).toBe(before.stdout);
    // Specifically: still untracked, still unstaged.
    expect(after.stdout).toContain("?? fresh.txt");
    expect(after.stdout).toContain(" M tracked.txt");
  }, cliBudget(3));
});
