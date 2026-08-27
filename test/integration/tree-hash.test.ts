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
import { chmod, mkdtemp, readdir, rm, unlink, writeFile, mkdir } from "node:fs/promises";
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
   * The failure REASON survives at the lower seam — `run/worktree.ts` turns it
   * into a `WorktreeError`, and a shared throw-or-null would have forced that
   * caller to catch and lose it.
   *
   * This used to end "even though the sampler discards it". It did, and that
   * was the defect: see the `onFailure` tests below.
   */
  test("the underlying snapshot reports which git invocation failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-nonrepo-"));
    dirs.push(dir);
    const snap = await writeTreeSnapshot(dir);
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.what).toContain(dir);
  }, cliBudget(1));

  /**
   * WHY THE SAMPLE FAILED, and not merely THAT it did (ISC-154).
   *
   * `worktreeContentHash` collapsed three different facts onto one `null` —
   * git timed out, git failed, or the snapshot threw — one function below the
   * docstring warning that catch-and-discard is "where the reason for the
   * failure goes to die". Measured cost, 2026-08-26: a CI run settled
   * `success`/`quiesced` with a null hash, the ISC-290 chain probe reported
   * "the supervisor took no quiesce sample", and no artifact anywhere said
   * whether the 10s bound had been hit or git had refused. The failure was
   * undiagnosable by construction.
   *
   * The RETURN is deliberately unchanged — still `string | null`, a missing
   * hash still voids nothing. Only the record gains.
   */
  test("a git failure reaches onFailure naming the invocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-nonrepo-"));
    dirs.push(dir);
    const reasons: string[] = [];
    expect(await worktreeContentHash(dir, { onFailure: (r) => reasons.push(r) })).toBeNull();
    expect(reasons).toHaveLength(1);
    // Which git invocation, and where — the two facts a reader needs to tell
    // this apart from a timeout. The invocation NAMED here changed on
    // 2026-08-27 and the change is the assertion working: the snapshot now
    // asks git where the object store is BEFORE staging anything, so on a
    // directory that is not a repository the first thing to fail is the
    // `rev-parse`, not the `add`. Pinning the old name would have been
    // pinning a stale account of what ran.
    expect(reasons[0]).toContain("git rev-parse --git-path objects");
    expect(reasons[0]).toContain("not a git repository");
    expect(reasons[0]).toContain(dir);
  }, cliBudget(1));

  test("a timeout reaches onFailure naming the bound, not a git error", async () => {
    const dir = await scratchRepo();
    const reasons: string[] = [];
    // 1ms cannot outlast a process spawn. If git ever did beat it this fails
    // loudly rather than skipping, which is the point of not guarding it.
    expect(
      await worktreeContentHash(dir, { timeoutMs: 1, onFailure: (r) => reasons.push(r) }),
    ).toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("did not answer within 1ms");
    expect(reasons[0]).toContain("TREE_HASH_TIMEOUT_MS");
  }, cliBudget(2));

  /**
   * THE LATCH, and it is not defensive tidying.
   *
   * `Promise.race` does not cancel the loser. A sample that gives up leaves
   * the snapshot running, and the losing side lands afterwards with its own
   * verdict — so without the latch ONE missing hash would emit TWO
   * conflicting reasons into the record, and a reader would have to guess
   * which one decided the return value.
   *
   * A non-repo directory with a 1ms bound produces exactly that collision:
   * both sides become ready, and both would report.
   *
   * WHICH side wins is scheduling, not a property, and this test does not
   * assert it. `setTimeout(…, 1)` fires when the event loop next reaches its
   * timers phase; on a loaded runner the loop can stall long enough that
   * git's exit is already queued when it resumes, and the ordering flips.
   * That is exactly how this test failed in CI after passing locally — it
   * had pinned the timer as the winner, which is a fact about one machine's
   * scheduler rather than about the latch.
   *
   * What IS a property, and what is asserted: exactly one reason comes out,
   * and it is a whole well-formed one rather than two spliced together. The
   * "deciding one" part needs no assertion because it holds by construction
   * — `report()` is called synchronously by whichever side settles first, so
   * the reason that latches and the reason that decides the return value are
   * the same event, and no test could observe them differing.
   */
  test("a sample that times out AND then fails reports one reason, never two", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-nonrepo-"));
    dirs.push(dir);
    const reasons: string[] = [];
    expect(
      await worktreeContentHash(dir, { timeoutMs: 1, onFailure: (r) => reasons.push(r) }),
    ).toBeNull();
    // Let the losing side land, so a second report would be observable.
    await new Promise((r) => setTimeout(r, 750));
    expect(reasons, `two reasons for one missing hash: ${JSON.stringify(reasons)}`).toHaveLength(1);
    expect(
      reasons[0],
      `neither side reported a whole reason: ${JSON.stringify(reasons)}`,
    ).toMatch(
      /^git did not answer within 1ms \(TREE_HASH_TIMEOUT_MS\)$|^git rev-parse --git-path objects in .+ exited 128: .*not a git repository/,
    );
  }, cliBudget(2) + 1_500);

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

/**
 * The permission case, which is the one that actually fired in CI.
 *
 * ISC-290's chain probe failed with `the supervisor took no quiesce sample`,
 * and — because PR #91 taught the sampler to say WHY — the artifact named it:
 *
 *     quiesce_sample_failed: git add -A (snapshot) in .../worktrees/eng-1
 *     exited 128: insufficient permission for adding an object to repository
 *     database .git/objects
 *
 * The worker container runs as uid 10001 and writes into the host worktree
 * through a bind mount, so it leaves `.git/objects/<xx>/` owned by 10001 and
 * the host-side sampler can no longer add to the store.
 *
 * THE UID FORM OF THIS CANNOT BE REPRODUCED ON macOS, which is why it went
 * undiagnosed: the bind mount squashes file ownership there, so the defect
 * exists only on the Linux runner. `chmod` reaches the SAME git code path on
 * both — git's failure is "the object store refused my write", and it does not
 * care which mechanism refused it — so these probes reproduce the CI failure
 * on a developer machine, which the real cause does not allow.
 */
describe("the snapshot survives an object store it cannot write to", () => {
  /** Every directory git could need to create a loose object in, made read-only. */
  async function freezeObjectStore(dir: string): Promise<void> {
    const objects = join(dir, ".git", "objects");
    const entries = await readdir(objects, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) await chmod(join(objects, e.name), 0o555);
    }
    await chmod(objects, 0o555);
  }

  async function thawObjectStore(dir: string): Promise<void> {
    const objects = join(dir, ".git", "objects");
    await chmod(objects, 0o755);
    const entries = await readdir(objects, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) await chmod(join(objects, e.name), 0o755).catch(() => {});
    }
  }

  /**
   * Root ignores the mode bits entirely, so on a root runner this probe would
   * pass while measuring nothing. Announced rather than silently skipped —
   * a self-skipping test that reads as coverage is the exact failure this
   * repo's probe guard exists to catch.
   */
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (asRoot) {
    console.warn(
      "[skip] the unwritable-object-store probes are running as root, which ignores the mode " +
        "bits they depend on — they can only measure something as an unprivileged user",
    );
  }
  const it = test.skipIf(asRoot);

  it(
    "a worktree whose object store refuses writes is still sampled, with the same hash",
    async () => {
      const dir = await scratchRepo();
      /**
       * THE TWIN IS NOT TIDINESS — it is what keeps this test from being
       * vacuous, and the first version of it WAS.
       *
       * That version took the expected hash from `dir` itself and then froze
       * the store. Hashing writes `add.js`'s blob, so by the time the store
       * was frozen the object the sample needed was already IN it, `git add`
       * had nothing to write, and the unredirected code passed happily. The
       * mutation that removes the redirection caught it: only the sibling
       * probe went red.
       *
       * A tree id is a content hash, so a second repository with identical
       * content produces the identical id — the expected value comes from
       * there instead, and `dir`'s store never sees `add.js`.
       */
      const twin = await scratchRepo();
      const baseline = await hash(dir);
      const NEW_CONTENT = "// what the worker left behind\n";
      await writeFile(join(dir, "add.js"), NEW_CONTENT);
      await writeFile(join(twin, "add.js"), NEW_CONTENT);

      await freezeObjectStore(dir);
      try {
        const reasons: string[] = [];
        const got = await worktreeContentHash(dir, { onFailure: (r) => reasons.push(r) });
        expect(
          got,
          `the sample failed on an unwritable object store — this is the CI defect, not a ` +
            `new one. What git said: ${JSON.stringify(reasons)}`,
        ).not.toBeNull();
        expect(reasons).toEqual([]);
        // It really did see the new file, so a blob really did have to be
        // written somewhere. Without this the probe would also pass against an
        // implementation that quietly ignored `add.js`.
        expect(got, "the sample did not observe the new file at all").not.toBe(baseline);
        // And the SAME tree the twin produces: redirecting where objects are
        // written must not change what the content hashes to.
        expect(got).toBe(await hash(twin));
      } finally {
        await thawObjectStore(dir);
      }
    },
    cliBudget(12),
  );

  /**
   * The property the module header now claims outright, and it was false
   * before this fix: "harvest is a pure read" was true of the working tree and
   * the refs but not of every byte under `.git`. Loose objects are counted
   * because that is what `add`/`write-tree` create; a hash whose parts landed
   * in the checkout would move this number.
   */
  it(
    "sampling writes nothing into the checkout's own object store",
    async () => {
      const dir = await scratchRepo();
      await writeFile(join(dir, "brand-new.txt"), "content git has never seen\n");
      const count = async (): Promise<number> => {
        const r = await runGit(dir, ["count-objects", "-v"]);
        const m = /^count: (\d+)$/m.exec(r.stdout);
        expect(m, `could not read the loose object count from: ${r.stdout}`).not.toBeNull();
        return Number(m![1]);
      };
      const before = await count();
      await hash(dir);
      expect(
        await count(),
        "the sample left loose objects in the checkout it was supposed to only read",
      ).toBe(before);
    },
    cliBudget(5),
  );
});
