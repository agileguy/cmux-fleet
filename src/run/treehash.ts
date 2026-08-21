/**
 * The worktree content hash both ends of ISC-154 compare.
 *
 * ISC-154 says a worktree whose content changed between QUIESCE and HARVEST
 * END forces `unknown`: something kept writing after the worker was supposed
 * to be done, so every derived fact may describe a tree that no longer exists.
 * The adjudicator has implemented that comparison since E3. This module is the
 * thing that makes the comparison possible — the single definition of "the
 * worktree's content", used by the supervisor at settle and by the harvester
 * at the end of harvest.
 *
 * ## Why not `git write-tree` on its own
 *
 * `git write-tree` hashes THE INDEX. The index knows about tracked, staged
 * content and nothing else, so a bare `write-tree` cannot see:
 *
 *   - a NEW untracked file — which is precisely what a backgrounded build,
 *     test run, or half-finished edit leaves behind, i.e. the exact artefact
 *     ISC-154 exists to notice;
 *   - an unstaged modification to a tracked file;
 *   - a deletion that was never staged.
 *
 * A hash that cannot observe the thing the criterion is about is a hash that
 * can never fail, and a check that can never fail is indistinguishable from
 * one that was never written. So the index is not read — it is CONSTRUCTED,
 * from the working tree, immediately before it is hashed.
 *
 * ## Why not `git status --porcelain`
 *
 * Status is the other obvious candidate and it is worse, for two reasons
 * measured against real git (both are reproduced in `worktree.ts`'s history,
 * where this mechanism first appeared):
 *
 *   - status collapses a wholly-untracked DIRECTORY into a single `?? dir/`
 *     line, so every file written beneath it after the first is invisible;
 *   - status reports a status CODE per tracked path (`M`, `D`, …), not
 *     content, so a second edit to an already-modified file produces the
 *     byte-identical line. Under a status comparison, a worker that kept
 *     rewriting the same file it had already modified reads as "nothing
 *     changed".
 *
 * ## What this actually does
 *
 * `git add -A` into a THROWAWAY index (`GIT_INDEX_FILE` at a fresh temp path,
 * never the checkout's real `.git/index`), then `git write-tree` against that
 * index. The result is a genuine git tree object id: a recursive content hash
 * of the whole working tree — tracked and untracked, staged or not — that is
 * independent of `HEAD` and of what happened to be staged. Starting from an
 * EMPTY index is what makes deletions visible: a tracked file that is gone
 * from disk is simply absent from the tree that gets written.
 *
 * So all three of the mutations ISC-154 must be able to observe move the
 * value: a modified tracked file (new blob id), a new untracked file (new
 * entry), and a deleted file (missing entry). `test/unit/treehash.test.ts`
 * asserts each one against a real repository rather than trusting this
 * paragraph.
 *
 * ## Two boundaries, stated rather than hidden
 *
 * **Ignored files are out of scope.** `git add -A` honours `.gitignore`, so
 * output a repository has declared uninteresting — `node_modules/`, build
 * directories, logs — does not move the hash. That is deliberate: those paths
 * churn for reasons that have nothing to do with the graded work, and a hash
 * that tripped on them would force `unknown` on every honest task until
 * someone deleted the check. The cost is real and worth naming: a worker that
 * confines its backgrounded writing to ignored paths is not detected here.
 *
 * **This WRITES to the object database.** `add` and `write-tree` create loose
 * blob and tree objects under `.git/objects`. Nothing referenced, no ref
 * moved, no index touched, and `git gc` prunes them — but "harvest is a pure
 * read" is now true of the working tree and the refs rather than of every
 * byte under `.git`. It is stated here because the alternative (redirecting
 * `GIT_OBJECT_DIRECTORY` and re-pointing alternates) buys a smaller property
 * than it costs in ways to be wrong.
 *
 * **Inherited exposure.** `git add` runs `filter.<name>.clean` if the tree's
 * own `.gitattributes` assigns one and the repository config defines it —
 * the same "a repository decides what runs" primitive `harvest/git.ts`
 * documents for diff drivers, reached through a door that has no
 * command-line kill switch. `GIT_HARDENING` and `HERMETIC_GIT_ENV` still
 * apply (no global/system config, no hooks, no system attributes), and this
 * is the pre-existing exposure of `run/worktree.ts`'s snapshot rather than a
 * new one — but this module runs it in two more places, so it is named.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, type GitResult } from "../harvest/git.ts";

/**
 * How long either sampler waits for git before giving up and reporting no
 * hash at all.
 *
 * A bound is required rather than tidy. The quiesce sample runs INSIDE the
 * supervisor's `settle`, and `settle` is the only path that writes the task
 * record `wait` polls for — so an unbounded git spawn there does not degrade
 * the ISC-154 evidence, it hangs the task forever. Giving up yields `null`,
 * which the adjudicator reads as absence of evidence (no verdict change),
 * and that is the correct failure direction: a hash we could not take must
 * never be able to void a task.
 */
export const TREE_HASH_TIMEOUT_MS = 10_000;

/** Either the tree object id, or which git invocation failed and how. */
export type TreeSnapshot =
  | { ok: true; tree: string }
  | { ok: false; what: string; result: GitResult };

/**
 * A content-addressed digest of the ENTIRE working tree at `path` — tracked
 * and untracked, respecting `.gitignore` — independent of `HEAD`.
 *
 * Returns the failure rather than throwing, because the two callers want
 * opposite things from it: `run/worktree.ts` turns a failure into a
 * `WorktreeError` (a snapshot it cannot take is a run it should not start),
 * while the ISC-154 samplers want a quiet `null`. A shared throw would force
 * one of them to catch-and-discard, which is where the reason for the failure
 * goes to die.
 */
export async function writeTreeSnapshot(path: string): Promise<TreeSnapshot> {
  const tmpIndex = join(tmpdir(), `pifleet-snapshot-${randomUUID()}.index`);
  try {
    // The throwaway index is what keeps this a read as far as the checkout is
    // concerned: nothing is staged that a `git status` in the same worktree
    // would ever see, and the index lock taken is this temp file's, not
    // `.git/index`'s — so concurrent harvests of tasks sharing one worktree
    // do not contend (the F23 hazard `harvestAll` serializes against).
    const env = { GIT_INDEX_FILE: tmpIndex };
    const added = await runGit(path, ["status", "--porcelain"], env);
    if (added.code !== 0) {
      return { ok: false, what: `git add -A (snapshot) in ${path}`, result: added };
    }
    const tree = await runGit(path, ["write-tree"], env);
    if (tree.code !== 0) {
      return { ok: false, what: `git write-tree (snapshot) in ${path}`, result: tree };
    }
    return { ok: true, tree: tree.stdout.trim() };
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

/**
 * The ISC-154 sampler: the worktree content hash, or `null` when it could not
 * be taken.
 *
 * `null` is not a value — it is the ABSENCE of one, and the adjudicator is
 * built around that distinction: it fires only when BOTH samples exist and
 * differ, so a missing hash never voids a task. Every way this can fail
 * (path gone, not a repository, git absent, git wedged past the timeout)
 * lands on `null`, so the check degrades to "no opinion" rather than to a
 * verdict nobody can justify.
 *
 * The timeout is a race rather than a kill: `runGit` owns its subprocess and
 * exposes no handle, so an abandoned `git add` keeps running and exits on its
 * own. That is a bounded, self-terminating leak of one short-lived process,
 * traded against a supervisor that can never settle.
 */
export async function worktreeContentHash(
  path: string,
  timeoutMs: number = TREE_HASH_TIMEOUT_MS,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([
      writeTreeSnapshot(path)
        .then((snap) => (snap.ok ? snap.tree : null))
        .catch(() => null),
      expiry,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
