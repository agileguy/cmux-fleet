/**
 * Merge pre-check (SRD §9.3): would each worker branch merge cleanly onto the
 * base — determined WITHOUT merging and WITHOUT touching any working tree.
 *
 * Everything here goes through `git merge-tree --write-tree`, which computes
 * the merge in the object database and never looks at a checkout. `git merge`,
 * `git stash` and `git checkout` are banned from this module by design: a
 * pre-check that dirties a tree is worse than no pre-check, because the
 * operator runs `report` precisely when the run is already in a state they do
 * not fully understand.
 *
 * Two behaviours pinned by running real git 2.50, not by reading the manpage:
 *
 * - `merge-tree` exits 1 BOTH for "the merge has conflicts" and for "this ref
 *   is not something we can merge". Reading exit 1 as "conflict" would report
 *   a deleted branch as a conflicted merge — so both refs are resolved with
 *   `rev-parse --verify` before merge-tree is ever invoked, and exit 1 is
 *   trusted as "conflict" only after that.
 *
 * - With `--name-only -z` the output is `<oid>\0<path>\0...\0\0<informational
 *   sections>`: a DOUBLE NUL separates the conflicted-path list from the
 *   informational messages. Splitting on single NUL and reading to the end
 *   would report git's prose ("Auto-merging", "CONFLICT (content)") as file
 *   paths.
 */

import { MergePrecheckSchema, type MergePrecheck } from "../contracts.ts";
import { runGit, type GitResult } from "../harvest/git.ts";

/** One worker branch to check, with the repo to interrogate about it. */
export interface MergeCheckInput {
  worker: string;
  branch: string;
  /** Resolved SHA the run dispatched against — the merge target. */
  base_ref: string;
  /** Path to any checkout of the repository; only its object db is read. */
  repo: string;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

/**
 * Pre-check every worker branch against its base, then pairwise against its
 * siblings. Never throws for a branch that cannot be checked: `report` is what
 * an operator runs when things went wrong, and a missing branch is a finding,
 * not a crash.
 */
export async function precheckMerges(
  inputs: readonly MergeCheckInput[],
  run: GitRunner = runGit,
): Promise<MergePrecheck[]> {
  const checks: PrecheckState[] = [];
  for (const input of inputs) {
    checks.push(await checkAgainstBase(input, run));
  }
  await checkPairwise(checks, run);
  return checks.map((c) =>
    MergePrecheckSchema.parse({
      worker: c.input.worker,
      branch: c.input.branch,
      base_ref: c.input.base_ref,
      clean: c.clean,
      conflicts_with: [...c.conflictsWith].sort(),
      conflicting_paths: [...c.conflictingPaths].sort(),
      detail: c.details.join("; "),
    }),
  );
}

interface PrecheckState {
  input: MergeCheckInput;
  clean: boolean;
  /** Branch SHA when it resolved; null bars this entry from pairwise checks. */
  branchSha: string | null;
  conflictsWith: Set<string>;
  conflictingPaths: Set<string>;
  details: string[];
}

/**
 * The base-merge check for one branch.
 *
 * `clean: true` means exactly "merged cleanly in the object database at the
 * moment of this check" — it is never set on any path where the merge was not
 * actually computed, because an unverifiable branch reported clean is the same
 * lie `down` once told with `"clean": true` over a leaked tmux session.
 */
async function checkAgainstBase(input: MergeCheckInput, run: GitRunner): Promise<PrecheckState> {
  const state: PrecheckState = {
    input,
    clean: false,
    branchSha: null,
    conflictsWith: new Set(),
    conflictingPaths: new Set(),
    details: [],
  };

  const branch = await run(input.repo, ["rev-parse", "--verify", `${input.branch}^{commit}`]);
  if (branch.code !== 0) {
    // The branch is gone (pruned, or the repo itself is). Nothing was checked,
    // so nothing may be called clean.
    state.details.push(`branch ${input.branch} does not resolve; nothing was checked`);
    return state;
  }
  state.branchSha = branch.stdout.trim();

  const base = await run(input.repo, ["rev-parse", "--verify", `${input.base_ref}^{commit}`]);
  if (base.code !== 0) {
    state.details.push(`base ${input.base_ref} does not resolve; nothing was checked`);
    return state;
  }

  // Already contained in the base: the merge would be a no-op, which is the
  // one case where "clean" is certain without computing anything further.
  const anc = await run(input.repo, ["merge-base", "--is-ancestor", state.branchSha, input.base_ref]);
  if (anc.code === 0) {
    state.clean = true;
    state.details.push(
      "branch is already contained in the base as of this check; merging would be a no-op",
    );
    return state;
  }
  if (anc.code !== 1) {
    // git itself failed — which must not be read as "not an ancestor".
    state.details.push(`merge-base --is-ancestor failed: ${anc.stderr.trim()}`);
    return state;
  }

  const mt = await run(input.repo, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "-z",
    input.base_ref,
    state.branchSha,
  ]);
  if (mt.code === 0) {
    state.clean = true;
    return state;
  }
  if (mt.code === 1) {
    const paths = parseConflictedPaths(mt.stdout);
    if (paths === null) {
      // Exit 1 without a parseable OID is merge-tree refusing, not conflicting
      // — the deleted-branch shape, reachable here only through a race with
      // whatever deleted the ref after rev-parse saw it.
      state.details.push(`merge-tree could not compute the merge: ${mt.stderr.trim()}`);
      return state;
    }
    for (const p of paths) state.conflictingPaths.add(p);
    state.details.push(`conflicts with the base in ${paths.length} path(s)`);
    return state;
  }
  state.details.push(`merge-tree failed (exit ${mt.code}): ${mt.stderr.trim()}`);
  return state;
}

/**
 * Sibling-vs-sibling checks, restricted to entries sharing a repository.
 *
 * `conflicts_with` names WORKER ids because the operator's next action is a
 * conversation with whoever owns the other branch; a list of paths alone
 * sends them off to re-derive the owner by hand.
 */
async function checkPairwise(checks: PrecheckState[], run: GitRunner): Promise<void> {
  for (let i = 0; i < checks.length; i++) {
    for (let j = i + 1; j < checks.length; j++) {
      const a = checks[i]!;
      const b = checks[j]!;
      if (a.input.repo !== b.input.repo) continue;
      if (a.branchSha === null || b.branchSha === null) continue; // unresolvable: no invented conflicts
      const mt = await run(a.input.repo, [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        a.branchSha,
        b.branchSha,
      ]);
      if (mt.code !== 1) continue; // clean, or git failed — either way, no conflict to report
      const paths = parseConflictedPaths(mt.stdout);
      if (paths === null) continue;
      a.conflictsWith.add(b.input.worker);
      b.conflictsWith.add(a.input.worker);
      for (const p of paths) {
        a.conflictingPaths.add(p);
        b.conflictingPaths.add(p);
      }
      a.details.push(`conflicts with sibling ${b.input.worker} in ${paths.length} path(s)`);
      b.details.push(`conflicts with sibling ${a.input.worker} in ${paths.length} path(s)`);
    }
  }
}

/**
 * Extract the conflicted-path list from `merge-tree --name-only -z` output.
 *
 * Returns null when the output does not start with a tree OID — the marker
 * that merge-tree computed nothing and its exit 1 means "refused", not
 * "conflicted".
 */
export function parseConflictedPaths(stdout: string): string[] | null {
  const fields = stdout.split("\0");
  const oid = fields[0];
  if (oid === undefined || !/^[0-9a-f]{40,64}$/.test(oid)) return null;
  const paths: string[] = [];
  for (let i = 1; i < fields.length; i++) {
    const f = fields[i];
    // The empty field is the double-NUL boundary: everything after it is
    // git's informational prose, which must never be reported as a path.
    if (f === undefined || f === "") break;
    paths.push(f);
  }
  return paths;
}
