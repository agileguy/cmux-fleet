/**
 * The integration path (SRD §6.2, §6.2.1, §7.2) — Phase 3.
 *
 * §6.2's mechanism already exists as a docblock: after `up`, the operator's
 * own repository carries one `worker-<id>` remote per worker, and the
 * integration step is "four ordinary git commands the calling session already
 * has every credential for" — fetch, inspect, merge, neutralize. This module
 * is those four commands made a supported, tested, RECORDED operation, which
 * is the whole of what §13 Phase 3 asks for. It does not add a `pifleet
 * merge` verb and it does not decide WHEN a merge happens — the orchestrator
 * calls `mergeWorkerBranch` once per worker branch and persists the result.
 *
 * ## The gate (§6.2.1) — this module's reason for existing
 *
 * §6.2.1 is this design's most serious finding: `neutralizeRepoHazards` runs
 * on the way IN (a worker's freshly cloned checkout, `up.ts:2043`), and
 * nothing ran on the way OUT — a `git fetch` + `git merge` from a worker's
 * branch materialises worker-authored files into the OPERATOR's own working
 * tree, read next by the very process holding `gh` credentials and the
 * operator's git identity. The gate below is implemented in the four parts
 * §6.2.1 specifies, in order, and none is optional:
 *
 *   0. Before either: the operator's checkout is verified fit to merge into
 *      (on a branch, no uncommitted changes to tracked files — finding 9),
 *      and the worker's CLONE is scanned read-only, because a local-path
 *      fetch runs `git-upload-pack` inside it (finding 5). Neither is in
 *      §6.2.1's original four; both were added from phase 6's review round,
 *      and they are numbered 0 rather than renumbering the four the SRD names.
 *   1. Fetch freely — `git fetch` moves objects and updates a ref; it writes
 *      no working-tree file and runs no filter. The exposure begins at merge,
 *      so nothing here gates the fetch itself. It fetches into
 *      `refs/pifleet/incoming/<worker>` rather than reading the shared
 *      `FETCH_HEAD`, which any other process in the checkout can move
 *      (finding 6).
 *   2. Inspect the incoming tree BEFORE materialising it — `git diff
 *      --name-only <base>..<fetched-head>` lists what the merge would write
 *      without writing it. A path matching a hazard CLASS (`AGENTS.md`,
 *      `CLAUDE.md`, `.pi/**`, `.agents`, `.agents/skills/**`, `.gitattributes`,
 *      anything under `.github/workflows/`, `.mcp.json`) refuses the merge
 *      outright — a legitimate edit to one of these is an edit the operator
 *      approves by hand, and must not be approved by this loop's silence. That
 *      the class list covers every tree-visible path part 4 scans is a CHECKED
 *      relation (`TREE_VISIBLE_HAZARD_PATHS`), not a remembered one: the two
 *      lists had drifted by exactly one entry when phase 6's review looked
 *      (finding 4), and by one more when phase 7's did — `.agents`, which was
 *      missing from BOTH lists, so the check itself could not see it.
 *   3. Merge with hooks and the global/user attributes file disabled —
 *      `-c core.hooksPath=/dev/null -c core.attributesFile=/dev/null`.
 *   4. `neutralizeRepoHazards` (imported, never re-implemented — see below)
 *      runs on the operator's checkout after every merge that lands, before
 *      the orchestrator reads anything from it.
 *
 * Part 2 and part 4 are BOTH kept deliberately, and they are not redundant:
 * part 2 is a host-side list this module maintains, and it can refuse before
 * a single byte is written; part 4 is the security module's own, broader
 * scanner (MCP configs, Pi settings files, executable git hooks already
 * resident, dangerous `.git/config` keys) and it is the one that gets updated
 * the day a new hazard class is found. Collapsing them into one list would
 * lose exactly the property that makes keeping both worth the duplication.
 *
 * ## A part 3 claim that does not hold, verified rather than assumed
 *
 * §6.2.1 part 3 says disabling `core.attributesFile` means "a `.gitattributes`
 * already in the base cannot act during checkout". **Reproduced against real
 * git 2.x and it is not true for that file.** `core.attributesFile` names an
 * ADDITIONAL, global attributes file consulted alongside a repository's own
 * `.gitattributes` — it has never been the switch that turns the tracked file
 * off, and setting it to `/dev/null` changes nothing about whether a `filter=`
 * driver the tracked `.gitattributes` already assigns runs during a merge's
 * checkout step. A live reproduction confirms it: a base repo with
 * `.gitattributes` assigning `filter=sentinel` to `*.bin`, a matching
 * `[filter "sentinel"] smudge = …` in `.git/config`, and a worker branch that
 * only adds a `payload.bin` (never touching `.gitattributes` itself, so gate
 * part 2 does not refuse it) — merging with both `-c` flags set still runs
 * the smudge command. `core.hooksPath=/dev/null` DOES work as claimed — a
 * `post-merge` hook configured on the base does not fire. Only the
 * attributes half of part 3's claim is false, and only for a driver that was
 * already resident in the base rather than arriving via the merge (gate part
 * 2 refuses the latter case outright, before any driver has a chance to run).
 * `test/unit/pm-integration.test.ts` pins both the true half and the false
 * half as separate, named assertions, rather than one that would have hidden
 * the gap behind an average.
 *
 * ## The record (§7.2)
 *
 * Written to `<repo>/.claude/project-manager/phase-<N>/integration.json`,
 * shaped by `IntegrationRecordSchema` and validated on every read — a
 * hand-edited or half-written record is refused at the boundary rather than
 * discovered by whatever reads it next. `writeIntegrationRecord` and
 * `readIntegrationRecord` both refuse a host path outside the repository
 * (§7.2: "Refused: any field naming a model, a container, a mount, or a host
 * path outside the repository") — enforced at the one place this module
 * touches a filesystem, rather than trusted to every future caller. The
 * refusal is categorical: a directory with no `.git` at all, OR a
 * subdirectory of a real repository that is not itself the repository's top
 * level, both refuse. A `.git` that is a FILE (a linked worktree's `gitdir:`
 * pointer, `worktree.ts`'s own shape) is accepted — it is still the top of a
 * real checkout.
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  MAX_ITEMS,
  MAX_SHORT,
  MAX_TEXT,
  RepoHazardSchema,
  SESSION_ID_RE,
  workerId,
  type RepoHazard,
} from "../contracts.ts";
import { MAX_RELAY_TASK_ID_CHARS } from "./task-ids.ts";
import { detectRepoHazards, neutralizeRepoHazards } from "../security/repo-hazards.ts";

const shortStr = z.string().max(MAX_SHORT);
const text = z.string().max(MAX_TEXT);
const gitSha40 = z.string().regex(/^[0-9a-f]{40}$/, { error: "must be a full 40-char git SHA" });

/**
 * Refused rather than left to `.strict()` alone, on the argument
 * `run/collation.ts` made first: `.strict()` answers "unrecognized key",
 * which teaches an author nothing about a field that is deliberately
 * unavailable HERE because it belongs to a different concern entirely.
 */
const notHere = (message: string) => z.never({ error: message }).optional();

const taskIdField = z
  .string()
  .max(MAX_RELAY_TASK_ID_CHARS, {
    error: `task_id is longer than ${MAX_RELAY_TASK_ID_CHARS} characters — it names a path segment`,
  })
  .regex(SESSION_ID_RE, {
    error: "task_id must be letters, digits, '.', '_' or '-', beginning and ending alphanumeric",
  });

// ---------------------------------------------------------------------------
// The outbound hazard gate (§6.2.1 part 2) — a host-side path list.
// ---------------------------------------------------------------------------

/**
 * The six classes §6.2.1 names, verbatim, plus the two the reviews added
 * (`.mcp.json`, `.agents` — each with its own note below). This list is
 * intentionally an ARRAY of independent rules rather than one combined regex:
 * the mutation proof for ISC-534 removes one entry at a time and expects
 * exactly that class's fixture to start failing while the others stay green — a
 * property a combined pattern could not demonstrate as cleanly.
 */
export const HAZARD_PATH_CLASSES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".pi/**",
  ".agents/skills/**",
  ".gitattributes",
  ".github/workflows/**",
  // Added 2026-09-05 for finding 4. `repo-hazards.ts` has scanned `.mcp.json`
  // all along, so a worker branch adding one was NOT refused before the merge
  // — it landed in the operator's tree and was only neutralized afterwards.
  // Its sibling `.pi/mcp.json` was refused the whole time, by `.pi/**`, which
  // is what made the gap invisible: the class LOOKED covered. The drift is now
  // a checked relation, not a remembered one — see `TREE_VISIBLE_HAZARD_PATHS`.
  ".mcp.json",
  // Added 2026-09-05 for phase 7's finding: the BARE parent, not the skills
  // directory under it. `.pi/**` covers `p === ".pi"` by construction and
  // `.agents/skills/**` never covered `.agents`, so a committed `.agents`
  // symlink was refused by nothing — while `repo-hazards.ts` scans exactly that
  // path, as a parent dot-dir, precisely because it can be a symlink. See
  // `HAZARD_PATH_RULES` for why a bare path in the diff means a symlink.
  ".agents",
] as const;
export type HazardPathClass = (typeof HAZARD_PATH_CLASSES)[number];

interface HazardPathRule {
  readonly hazardClass: HazardPathClass;
  readonly matches: (repoRelativePath: string) => boolean;
}

/**
 * Matching is on the PATH ALONE, never on content — §6.2.1 part 2 refuses a
 * touch to `.gitattributes` outright, regardless of what it contains. Content
 * inspection (a `filter=`/`diff=` assignment specifically) is part 4's job,
 * over `neutralizeRepoHazards`, on a tree the gate already let through.
 *
 * `.gitattributes` and the two `**` classes match NESTED occurrences too —
 * git honours a `.gitattributes` in every directory, and a nested
 * `.pi`/`.agents/skills` is exactly where a worker would place one to avoid a
 * root-only check.
 *
 * ## Why the BARE parent paths have rules of their own
 *
 * `.pi/**` matched `p === ".pi"` from the start and `.agents/skills/**` never
 * matched `.agents`, and for a long time that asymmetry looked like a
 * formatting detail. It is not, because of what a bare path in a diff listing
 * MEANS. Measured with git 2.50.1: a committed `.agents -> /etc` is a
 * mode-120000 blob at that exact path, and `git diff --name-only` reports the
 * single entry `.agents`. A real directory is never listed by name — only its
 * children are. **So a bare parent in the incoming listing is a symlink or a
 * file, and nothing else**, which is the one shape `repo-hazards.ts` scans
 * `.pi` and `.agents` for (`DISCOVERY_PARENT_DIRS`): the link resolves outside
 * the worktree and everything Pi discovers "under" it comes from wherever the
 * worker pointed. The scanner saw it, the gate did not, and it landed in the
 * operator's tree to be neutralized afterwards instead of refused before.
 *
 * `.agents` is matched EXACTLY, not as a prefix. Widening it to `.agents/**`
 * would refuse `.agents/anything`, which `repo-hazards.ts` does not scan and Pi
 * does not read — and this module's own header states the cost of that mistake:
 * a gate that refuses good branches gets turned off.
 */
const HAZARD_PATH_RULES: readonly HazardPathRule[] = [
  { hazardClass: "AGENTS.md", matches: (p) => p === "AGENTS.md" },
  { hazardClass: "CLAUDE.md", matches: (p) => p === "CLAUDE.md" },
  { hazardClass: ".pi/**", matches: (p) => p === ".pi" || p.startsWith(".pi/") },
  {
    hazardClass: ".agents/skills/**",
    matches: (p) => p === ".agents/skills" || p.startsWith(".agents/skills/"),
  },
  { hazardClass: ".agents", matches: (p) => p === ".agents" },
  { hazardClass: ".gitattributes", matches: (p) => p === ".gitattributes" || p.endsWith("/.gitattributes") },
  {
    hazardClass: ".github/workflows/**",
    matches: (p) => p === ".github/workflows" || p.startsWith(".github/workflows/"),
  },
  // Root-level only, matching `repo-hazards.ts`'s own reasoning for the
  // instruction files: discovery runs from the workspace root, so a nested
  // `.mcp.json` is never loaded and flagging it would be the detector that
  // flags everything.
  { hazardClass: ".mcp.json", matches: (p) => p === ".mcp.json" },
];

/** Classify one repo-relative path (as `git diff --name-only` reports it), or `null` if it is not a hazard. */
export function classifyHazardPath(repoRelativePath: string): HazardPathClass | null {
  for (const rule of HAZARD_PATH_RULES) {
    if (rule.matches(repoRelativePath)) return rule.hazardClass;
  }
  return null;
}

/** One hazard-classed path the incoming tree would have written, and the commit it came from. */
export interface HazardTouch {
  path: string;
  hazard_class: HazardPathClass;
  commit: string;
}

/** Classify every path in a changed-file list, keeping only the hazards. */
export function findHazardTouches(paths: readonly string[], commit: string): HazardTouch[] {
  const out: HazardTouch[] = [];
  for (const p of paths) {
    const hazardClass = classifyHazardPath(p);
    if (hazardClass !== null) out.push({ path: p, hazard_class: hazardClass, commit });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal, argv-only git spawning — no shell, ever (SRD §12.2).
//
// This is deliberately its OWN spawner rather than `harvest/git.ts`'s
// `runGit`. That module's `HERMETIC_GIT_ENV` blanks `HOME` and every
// `GIT_CONFIG_*` global/system path — correct for reading a WORKER's
// untrusted repository without inheriting host secrets, and wrong here: a
// merge commit needs the OPERATOR's own git identity, which commonly lives in
// the global config this module must NOT blank. The two `-c` overrides
// §6.2.1 part 3 asks for are applied per-invocation instead, which is the
// narrower and correct-scoped control for THIS module's threat model.
// ---------------------------------------------------------------------------

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * How this module runs git — one signature, and the seam every function below
 * takes as a defaulted trailing argument.
 *
 * The signature is deliberately the WHOLE of git: a working directory and an
 * argv, in and out, with the exit code carried rather than thrown. Nothing
 * narrower would do, because the property this seam exists to test is an
 * ORDERING property — what is true about the repository between two git
 * invocations — and a seam that only stubbed the two commands a test happens to
 * care about could not observe the ones in between.
 */
export type GitSpawner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

/**
 * The default {@link GitSpawner}, and the reason it is exported.
 *
 * A test that wants to interleave something into the middle of
 * `mergeWorkerBranch` needs to WRAP this, not replace it: the interesting
 * scenarios are all "real git, plus one extra thing at one exact moment", and a
 * test that re-implemented the spawn instead would be a second copy of this
 * function that drifts the day an argument is added here. Exporting it keeps
 * the injected spawner a decorator over production's own behaviour.
 */
export async function spawnGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", cwd, "--no-pager", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Git itself failed. Carries stderr verbatim — a paraphrased git error is a git error nobody can search for. */
export class IntegrationGitError extends Error {
  constructor(what: string, result: GitResult) {
    super(`${what} failed (git exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "IntegrationGitError";
  }
}

/**
 * The paths the INCOMING branch changed — read-only, writes no working-tree
 * file (§6.2.1 parts 1 and 2).
 *
 * ## Three dots, and this is the whole correctness of the gate
 *
 * §6.2.1 spells the probe `git diff --name-only <base>..FETCH_HEAD`, and for
 * `git diff` two dots do NOT mean what they mean for `rev-list`: `diff A..B`
 * is just `diff A B`, a comparison of two ENDPOINTS. On a long-lived
 * integration branch — which is the model §6.2 describes — the orchestrator
 * commits between merges, so anything HEAD has gained since the worker's
 * branch was cut shows up in that comparison as a path the worker "changed".
 *
 * Measured, on this branch: inspecting `phase3-pm-integration` against `HEAD`
 * listed `.claude/project-manager-state.json` — a file that branch never
 * touched, changed by the orchestrator after the branch was cut — and the
 * gate refused a clean branch on it. **A gate that refuses good branches gets
 * turned off**, so this is not a cosmetic bug; and the same asymmetry can
 * mask, when HEAD already carries an identical hazard edit.
 *
 * `A...B` is git's name for "what B changed since the merge base", which is
 * the question the gate is actually asking. `rev-list --count` above keeps
 * two dots, where two dots already mean the range.
 *
 * ## `-z`, and this is the OTHER half of the gate's correctness
 *
 * The listing is the gate's only input, and **its shape is chosen by the party
 * being gated.** `git diff --name-only` C-quotes any path holding a non-ASCII
 * byte (`core.quotePath` defaults on) or a control character, and wraps it in
 * double quotes. Measured:
 *
 * ```
 * ".github/workflows/deploy-caf\303\251.yml"
 * .github/workflows/plain.yml
 * ".pi/ext\303\251nsion.json"
 * ```
 *
 * Every rule in `HAZARD_PATH_RULES` is an `===`, a `startsWith` or an
 * `endsWith` against a raw repo-relative path, so an entry beginning with `"`
 * matches none of them. **A worker wanting `.pi/**` or `.github/workflows/**`
 * past the gate needed one accented character in the filename** — verified as
 * a merge, not as a mismatch: the fixture branch whose only hazard was an
 * accented workflow file came back `merged`. A newline is worse still, because
 * it does not merely fail to match: it breaks the line format, and one path
 * becomes two entries that are not paths.
 *
 * `-z` is NUL-delimited, and NUL is the one byte a path cannot contain. This
 * was already the convention everywhere else in this repository that reads a
 * path listing — `harvest/git.ts:396`, `report/merge.ts:132`,
 * `worktree.ts:261` — and `parseNameStatusZ`'s docblock gives the same reason
 * in the same words. The gate was the single reader that had not adopted it,
 * which is the one place it mattered most.
 *
 * Found by `rev-lang-1` in phase 6's review round, as finding 3.
 */
export async function incomingTreeChanges(
  repoRoot: string,
  baseRef: string,
  headRef: string,
  git: GitSpawner = spawnGit,
): Promise<string[]> {
  const res = await git(repoRoot, ["diff", "--name-only", "-z", `${baseRef}...${headRef}`]);
  if (res.code !== 0) {
    throw new IntegrationGitError(`git diff --name-only -z ${baseRef}...${headRef}`, res);
  }
  // NUL-delimited and NOT trimmed. `-z` turns the quoting off at the source, so
  // every byte between two NULs is the path; trimming it would be this function
  // deciding that a path git reported is not the path git reported.
  return res.stdout.split("\0").filter((path) => path.length > 0);
}

// ---------------------------------------------------------------------------
// The merge (§6.2.1 parts 1, 3 and 4, composed).
// ---------------------------------------------------------------------------

export interface MergeWorkerBranchInput {
  /** The operator's own checkout — must be sitting ON the integration branch. */
  repoRoot: string;
  worker: string;
  /** The `worker-<id>` remote registered against this worker's clone (§2.1). */
  remote: string;
  /** The branch to fetch from that remote. */
  branch: string;
  /** The task whose dispatch produced this branch — recorded, never re-derived. */
  taskId: string;
  /**
   * The integration branch's tip BEFORE this merge — what the incoming tree
   * is diffed against. Defaults to `HEAD`, which is exactly right the
   * instant before this merge runs and wrong the instant after, so callers
   * merging more than one worker in sequence should not cache it.
   */
  baseRef?: string;
  /**
   * Workers earlier in THIS batch whose row came back `tree_restored: false`.
   *
   * Passed rather than derived, because it cannot be derived here: the rows live
   * with the orchestrator, and a checkout that a failed merge left modified
   * looks — to `git status` alone — exactly like an operator's own half-finished
   * edit. Optional, and the refusal degrades to what the checkout itself shows
   * (see `assertMergePreconditions`) when a caller passes nothing.
   */
  unrestoredPriorWorkers?: readonly string[];
}

/**
 * The side effects {@link mergeWorkerBranch} has, so its ORDER is testable —
 * `fresh-dispatch.ts`'s `FreshDispatchDeps` convention, applied to the one
 * effect this function has (ISC-562).
 *
 * ## Why a second parameter rather than a field on `MergeWorkerBranchInput`
 *
 * Every field of `MergeWorkerBranchInput` is DATA ABOUT THE MERGE, and five of
 * the six are copied verbatim into `MergeWorkerBranchResult` and from there
 * into the integration record (`toIntegrationWorkerRow`) — the artifact §6.4
 * step 6 is re-derived from. A function is not data about the merge, it is not
 * serialisable, and putting it on that type would make the input the one
 * argument in this module that is part record and part machinery. This repo
 * already separates the two everywhere it needs a seam: `recreateThenDispatch`
 * takes `(deps, opts)`, and `withConsoleRestart` takes `(opts, deps)`. This is
 * that convention, not a second one.
 *
 * It differs from `FreshDispatchDeps` in exactly one respect, and only because
 * of what was counted rather than guessed: 37 existing call sites in this
 * module's own suite, and one in `src` (this definition). The parameter is
 * therefore OPTIONAL and defaults to {@link DEFAULT_MERGE_DEPS}, so injecting
 * the seam changed no caller and no test that was not about the seam. A
 * required deps object would have been the better shape on a new function.
 *
 * ## What the seam is for, stated so it is not mistaken for a mock point
 *
 * It is NOT here so tests can avoid real git — every test in this module's
 * suite runs against real repositories on purpose, because the gate's whole
 * subject is what git actually does. It is here because the race ISC-562
 * describes lives in the window BETWEEN two git calls, and the only way to
 * enter that window deterministically is to be the thing that returns from the
 * first one. A test wraps {@link spawnGit}, lets the real fetch run, does its
 * interfering work, and returns; production passes the default and behaves
 * exactly as it did before.
 */
export interface MergeWorkerBranchDeps {
  /** Runs one git command. Defaults to {@link spawnGit}. */
  readonly git: GitSpawner;
}

/** What {@link mergeWorkerBranch} uses when a caller injects nothing. */
export const DEFAULT_MERGE_DEPS: MergeWorkerBranchDeps = { git: spawnGit };

export type MergeWorkerBranchOutcome =
  | { kind: "refused_hazard"; hazards: HazardTouch[] }
  | {
      kind: "merge_failed";
      detail: string;
      /**
       * Whether the checkout was actually left OUT of the merge — not whether
       * `merge --abort` exited zero. See `restoreAfterFailedMerge`.
       */
      treeRestored: boolean;
      /** Why the tree could not be restored, or `""` when it was. */
      cleanupDetail: string;
    }
  | { kind: "merged"; mergeCommit: string; postMergeHazards: RepoHazard[] };

export interface MergeWorkerBranchResult {
  worker: string;
  remote: string;
  branch: string;
  taskId: string;
  /** The SHA `git fetch` brought in — captured immediately, never re-read from `FETCH_HEAD` later. */
  head: string;
  /**
   * How many commits the fetched head is ahead of the base — or `null` when
   * git could not say. Never `NaN`, and never `0` standing in for "unknown"
   * (finding 8). `worktrees.ts:52` already spells an undetermined count this
   * way; this is that convention, not a new one.
   */
  commitsAhead: number | null;
  /**
   * Hazards found in the WORKER's clone, read before the fetch — the state
   * that existed while git ran its server side there (finding 5).
   */
  preFetchHazards: RepoHazard[];
  outcome: MergeWorkerBranchOutcome;
}

/**
 * The operator's checkout is not in a state this module may merge into
 * (§6.2 — finding 9 from phase 6's review round).
 *
 * Thrown rather than returned as a per-worker outcome, on
 * `HostPathOutsideRepositoryError`'s precedent: a checkout that fails this
 * test fails it for EVERY worker in the batch, so recording one refusal row
 * and carrying on would produce a record whose remaining rows are all equally
 * unsafe and none of them says so.
 */
export class IntegrationPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationPreconditionError";
  }
}

/**
 * Check what the docblock used to only assert (finding 9).
 *
 * `MergeWorkerBranchInput.repoRoot` was documented as "the operator's own
 * checkout — must be sitting ON the integration branch" and nothing verified
 * a word of it. The review put the consequence precisely: *"A dirty tree
 * merges whenever paths don't overlap, interleaving worker content with the
 * operator's uncommitted edits."* An instruction is not a mechanism — the
 * same sentence ISC-530 was filed over.
 *
 * ## Two checks, and why not a third
 *
 * **Detached HEAD** — a merge here would land on no branch at all, and the
 * merge commit would be reachable from nothing the moment anything else is
 * checked out. `symbolic-ref --quiet HEAD` is the question asked directly.
 *
 * **Uncommitted changes to TRACKED files** — staged or unstaged. This is the
 * interleaving the finding names: the operator's half-finished edit to one
 * file ends up in the tree on top of a merge commit they did not intend to
 * author with it.
 *
 * **Untracked files are deliberately NOT checked**, and that is not laziness.
 * Git already refuses a merge that would overwrite one — measured: a merge
 * whose incoming tree adds a path the operator holds untracked exits 2 and
 * writes no MERGE_HEAD at all. So untracked files are already protected by
 * the thing doing the merging, and refusing on them here would reject a
 * checkout git itself considers safe. `--untracked-files=no` is the whole
 * difference between a precondition that guards the harm and one that also
 * blocks the operator for having a scratch file in the tree.
 *
 * The integration BRANCH's name is not checked, because this function is not
 * told it — `mergeWorkerBranch` takes a repo root, and the branch identity
 * lives in the integration record. "On a branch, and clean" is the part of
 * the precondition that is both knowable here and load-bearing.
 *
 * ## The second refusal in a batch is a different sentence (phase 7)
 *
 * The dirty-tree message told the operator to "commit or stash first", which is
 * correct advice for THEIR uncommitted work and wrong, misleading advice for
 * the case the batch produces: worker A's merge fails, its row records
 * `tree_restored: false`, and worker B's precondition then finds the tree A left
 * behind. Stashing that is stashing half of A's merge. The operator has already
 * been told, in A's row, that A needs cleaning up by hand — and then gets a
 * refusal on B that does not mention A at all, in a loop where B is the message
 * they are actually looking at.
 *
 * Two independent sources say so, and the message uses whichever is available:
 *
 *  - **What the caller knows.** `unrestoredPriorWorkers` names the workers whose
 *    rows in THIS batch carried `tree_restored: false`. The orchestrator holds
 *    those rows; nothing in the checkout does.
 *  - **What the checkout itself shows.** A live `MERGE_HEAD`, or unmerged index
 *    entries (`git status --porcelain` marks those with `U` on either side, plus
 *    `AA`/`DD`), is evidence of an interrupted merge that needs no caller
 *    cooperation to find. This is what covers the caller that passes nothing.
 *
 * Neither is invented when absent: with no prior workers named and no leftover
 * state in the checkout, the message is the original one, unchanged. A refusal
 * that blamed a previous merge on every dirty tree would be the same defect in
 * the other direction — an operator told their own half-finished edit was
 * somebody else's merge.
 */
async function assertMergePreconditions(
  repoRoot: string,
  unrestoredPriorWorkers: readonly string[] = [],
  git: GitSpawner = spawnGit,
): Promise<void> {
  const symref = await git(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  if (symref.code !== 0) {
    throw new IntegrationPreconditionError(
      `refused: ${repoRoot} has a detached HEAD, so a merge here would land on no branch — ` +
        "check out the integration branch before merging worker branches into it",
    );
  }
  const dirty = await git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.code !== 0) throw new IntegrationGitError("git status --porcelain", dirty);
  const changed = dirty.stdout.split("\n").filter((l) => l.trim().length > 0);
  if (changed.length === 0) return;

  const changedList =
    `Changed: ${changed.slice(0, 5).join(", ")}` + (changed.length > 5 ? ` (+${changed.length - 5} more)` : "");

  const evidence: string[] = [];
  if (unrestoredPriorWorkers.length > 0) {
    evidence.push(
      `${unrestoredPriorWorkers.map((w) => `"${w}"`).join(", ")} failed to merge earlier in this batch and its ` +
        "row records tree_restored: false",
    );
  }
  const midMerge = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  if (midMerge.code === 0) evidence.push("MERGE_HEAD is present, so this checkout is still mid-merge");
  // Porcelain v1 status codes: `U` on either side is an unmerged path, and
  // `AA`/`DD` are the two unmerged shapes that carry no `U` at all.
  const unmerged = changed.filter((l) => {
    const xy = l.slice(0, 2);
    return xy.includes("U") || xy === "AA" || xy === "DD";
  });
  if (unmerged.length > 0) {
    evidence.push(`${unmerged.length} path(s) are left unresolved in the index (${unmerged.slice(0, 3).join(", ")})`);
  }

  if (evidence.length === 0) {
    throw new IntegrationPreconditionError(
      `refused: ${repoRoot} has ${changed.length} uncommitted change(s) to tracked files, and a ` +
        "merge would interleave them with the worker's content in a commit you did not author " +
        `them into — commit or stash first. ${changedList}`,
    );
  }
  throw new IntegrationPreconditionError(
    `refused: ${repoRoot} has ${changed.length} uncommitted change(s) to tracked files, and they are ` +
      `LEFTOVER STATE FROM AN EARLIER MERGE rather than your own work: ${evidence.join("; ")}. Do not commit ` +
      "or stash this — that would fold half of a failed merge into the integration branch. Finish or undo " +
      "that merge first (`git merge --abort` while MERGE_HEAD is live, otherwise resolve or `git checkout --` " +
      `the listed paths), then merge the rest of the batch. ${changedList}`,
  );
}

/**
 * The local filesystem path a `worker-<id>` remote points at, or `null` when
 * the remote is not a plain local path.
 *
 * Only a local path has a clone on THIS machine to scan. A `scheme://` URL or
 * an scp-style `host:path` is somebody else's filesystem, and this module has
 * no business guessing at it.
 */
/**
 * The ref this module fetches a worker's branch INTO (finding 6).
 *
 * Under `refs/pifleet/` rather than `refs/heads/` or `refs/remotes/` so it
 * cannot collide with a branch, a remote-tracking ref, or a tag, and so
 * `git branch`/`git tag` never show it. Per-worker rather than per-call: it
 * is useful after the fact to see what was last fetched for a worker, and two
 * concurrent merges of the SAME worker into the same checkout is not a shape
 * this module supports for reasons that predate the ref.
 *
 * The worker id is re-validated here even though callers pass a `workerId`
 * elsewhere, because this is the one place a worker id becomes part of a git
 * REF NAME. `mergeWorkerBranch`'s input types it as a bare `string`, so the
 * boundary is here or nowhere.
 *
 * ## It does not survive a merge that did not happen (phase 7)
 *
 * The ref was written on every fetch and deleted never, which made the
 * operator's repository the durable home of content it had just REFUSED. A
 * hazard-refused branch — an `AGENTS.md` rewriting the grader's instructions, a
 * `.agents` symlink — stayed fully reachable from a ref in the operator's own
 * repo after the gate said no, and every run added another. Reachable is the
 * operative word: deleting the ref removes no object, it removes the last
 * thing keeping those objects alive, which is what lets `git gc` reclaim them.
 * With the ref in place, nothing ever would.
 *
 * The delete is only half of it, and the other half was invisible until the
 * test asserted unreachability instead of ref-absence: a fetch from a named
 * remote ALSO writes `refs/remotes/<remote>/<branch>` opportunistically, so
 * dropping this ref left the refused head reachable from that one instead.
 * `--refmap=` on the fetch is what makes the delete mean anything — see the
 * fetch itself.
 *
 * On a merge that LANDS the ref is kept, and the reason is that the growth
 * argument does not apply there: the merge commit already makes that head an
 * ancestor of the integration branch, so the ref pins nothing the branch is not
 * pinning anyway and deleting it would reclaim exactly zero objects. What it
 * does buy is the one thing this module's record cannot: `git rev-parse
 * refs/pifleet/incoming/<worker>` answers "what was last fetched for this
 * worker" from the repository itself, with no record file to read, which is
 * where an operator looks when reconstructing a run by hand.
 */
function incomingRefFor(worker: string): string {
  if (!SESSION_ID_RE.test(worker) || worker.length > 64) {
    throw new IntegrationPreconditionError(
      `refused: "${worker}" is not a usable worker id, and it would become part of a git ref name`,
    );
  }
  return `refs/pifleet/incoming/${worker}`;
}

/**
 * Drop the incoming ref for a merge that did not land.
 *
 * Best-effort by design, and the failure mode is bounded rather than ignored: a
 * delete that does not take leaves a ref the NEXT fetch of this worker
 * force-updates anyway (`+<branch>:<ref>`), so the worst case is one stale
 * pointer, not an accumulating set. Turning that into a thrown error would
 * replace the refusal the operator needs to read with a cleanup error about the
 * refusal, which is a strictly worse thing to hand back.
 *
 * `update-ref -d <ref> <oldvalue>` rather than a bare `-d`: the old value is the
 * head this call fetched, so if anything else has moved the ref since, the
 * delete declines instead of discarding whatever is there now.
 */
async function deleteIncomingRef(
  repoRoot: string,
  ref: string,
  fetchedHead: string,
  git: GitSpawner = spawnGit,
): Promise<void> {
  await git(repoRoot, ["update-ref", "-d", ref, fetchedHead]);
}

export async function workerCloneLocalPath(
  repoRoot: string,
  remote: string,
  git: GitSpawner = spawnGit,
): Promise<string | null> {
  const res = await git(repoRoot, ["remote", "get-url", remote]);
  if (res.code !== 0) return null;
  const url = res.stdout.trim();
  if (url.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null; // scheme://host/... (file:// included — not a bare path)
  if (/^[^/]+:/.test(url)) return null; // scp-style host:path
  return url;
}

/**
 * Read-only hazard scan of the worker's own clone, run BEFORE the fetch
 * (§6.2.1 part 0 — finding 5 from phase 6's review round).
 *
 * ## What a local-path fetch actually does, measured
 *
 * `git fetch <path> <branch>` is not a one-sided read. Traced against git
 * 2.50.1, the operator's fetch spawns `git-upload-pack <clone path>` and then
 * `trace: built-in: git upload-pack /…/worker`. **Git runs its SERVER side as
 * a subprocess inside the worker's clone**, a directory whose `.git/config`
 * the worker has held write access to for the whole run. `up.ts` scans the
 * checkout at creation time, before the worker exists; nothing has looked at
 * the clone since. That timing gap is certain.
 *
 * ## What that gap does NOT currently buy an attacker, also measured
 *
 * The review named `uploadpack.packObjectsHook` (`repo-hazards.ts:163`) as the
 * key class. It was worth checking rather than assuming, and the check
 * refutes it: a clone with `uploadpack.packObjectsHook` set to a marker script
 * was fetched from, `git-upload-pack` ran, and **the hook did not**. git's own
 * documentation says why:
 *
 * > Note that this configuration variable is only respected when it is
 * > specified in protected configuration … This is a safety measure against
 * > fetching from untrusted repositories.
 *
 * Protected scope is system, global and `-c` — never the repository's own
 * config, which is the only scope a worker can write. `core.alternateRefsCommand`
 * was tried the same way (with a real separate alternate object store) and
 * also did not fire on fetch; it serves `receive-pack`, not this path.
 *
 * ## The one thing in the clone that DOES change what the fetch pulls
 *
 * Phase 7's review pointed out that the "record, don't refuse" posture below
 * was stated over a scan that had never looked at
 * `.git/objects/info/alternates` — the string appeared nowhere in this module
 * or in `repo-hazards.ts` — while a local-path fetch honours that file. That is
 * now measured and closed, and the measurement is worth stating because it is
 * the only item here that is not merely visible-but-inert. Three repositories,
 * git 2.50.1: a `worker/` clone whose alternates file named an unrelated
 * `secret/.git/objects` on the same machine, with its branch pointed straight
 * at a commit that exists only there. The operator's
 * `git fetch ../worker feat:refs/pifleet/incoming/w` **succeeded**, and
 * `git ls-tree -r` on the fetched ref in the OPERATOR's repository listed that
 * repository's file. The worker's object store is not confined to the run tree.
 *
 * `repo-hazards.ts` now detects that file (detect-only — see its docblock for
 * why moving it would break a repository whose objects legitimately live in an
 * alternate), so this scan records it along with everything else. Gate part 2
 * still governs what may LAND: whatever store the objects came out of, the
 * merge is refused unless the paths pass `HAZARD_PATH_RULES`.
 *
 * ## So why scan at all
 *
 * Because the two keys we could name being covered by git's current hardening
 * is not the same claim as "the clone is safe", and this module must not rest
 * on the second when it only measured the first. `repo-hazards.ts` states the
 * standing reason directly: *"Detection is also what makes a hazard VISIBLE to
 * the operator, which suppression alone never does."*
 *
 * The scan therefore RECORDS and does not refuse. A worker whose clone config
 * names a program is a fact the operator should see next to that worker's
 * merge; it is not, on the evidence above, grounds for this loop to reject the
 * branch on its own.
 *
 * ## Stated precisely, because the previous version of this docblock did not
 *
 * What is recorded is exactly `detectRepoHazards`'s own coverage of the clone
 * directory: root instruction files, MCP and Pi settings files, the discovery
 * dot-dirs, `.gitattributes` (root and nested, to its own depth bound), both
 * `.git` config files, `.git/objects/info/alternates`, and executable
 * `.git/hooks` entries. What is NOT recorded is anything outside that walk —
 * the clone's ref namespace, its packed objects, and any state the worker
 * created outside the directory the `worker-<id>` remote names. A remote that
 * is not a bare local path is not scanned at all: there is no clone on this
 * machine to look at, and the function returns an empty list rather than a
 * misleading clean one.
 */
async function scanWorkerCloneBeforeFetch(
  repoRoot: string,
  remote: string,
  git: GitSpawner = spawnGit,
): Promise<RepoHazard[]> {
  const clonePath = await workerCloneLocalPath(repoRoot, remote, git);
  if (clonePath === null) return [];
  // A remote whose directory is gone is the FETCH's error to report, with
  // git's own wording — not something this scan should pre-empt with a
  // worse-phrased throw of its own.
  const st = await lstat(clonePath).catch(() => null);
  if (st === null || !st.isDirectory()) return [];
  return detectRepoHazards(clonePath);
}

/**
 * Put the checkout back after a merge that failed, and report whether that
 * actually happened (finding 7 from phase 6's review round).
 *
 * ## Why the abort's exit code is the WRONG thing to inspect
 *
 * The review's own suggested fix was to stop ignoring `merge --abort`'s
 * result. Measured against real git, that fix would fire constantly on a
 * healthy path. There are two merge-failure shapes and they differ exactly
 * here:
 *
 * | failure | merge exit | MERGE_HEAD | `merge --abort` |
 * |---|---|---|---|
 * | content conflict | 1 | present | exit 0, clears it |
 * | refused before starting (untracked file would be overwritten) | 2 | **absent** | **fatal: There is no merge to abort** |
 *
 * In the second shape git never began the merge, so there is nothing to abort
 * and the abort failing is the CORRECT outcome — the tree was never dirtied.
 * A guard that alarmed on a non-zero abort would cry wolf on every one of
 * those, and a guard that cries wolf gets turned off.
 *
 * ## Why MERGE_HEAD alone is also the wrong thing to inspect (phase 7)
 *
 * The first fix asked for MERGE_HEAD after the abort, on the grounds that it is
 * "the state itself rather than a proxy for it". It is a state, but it is
 * MERGE-state, and the field it feeds is called `tree_restored`. The two come
 * apart, and not only in theory. Reproduced with git 2.50.1: drive a real
 * conflicting merge (MERGE_HEAD present, `README.md` left with conflict
 * markers, index entry `UU`), then remove `.git/MERGE_HEAD` — which is what a
 * merge killed mid-checkout, or an abort that failed after clearing the merge
 * state, leaves behind. `git merge --abort` now exits 128 with *"There is no
 * merge to abort (MERGE_HEAD missing)"*, MERGE_HEAD is absent, and
 * `git status --porcelain --untracked-files=no` still prints `UU README.md`.
 * The old probe reported `treeRestored: true` over a tree holding the worker's
 * conflict markers, and the record said so under this worker's task_id.
 *
 * So both are asked, and restored means BOTH are clean: no MERGE_HEAD, and no
 * uncommitted change to a tracked file.
 *
 * ## The false-positive guarantee survives, and this is why
 *
 * `--untracked-files=no` is the same flag, chosen for the same reason, as in
 * `assertMergePreconditions`. In the refused-before-starting shape the only
 * thing in the tree is the operator's own UNTRACKED file — git wrote nothing —
 * so the status probe is empty and the verdict stays `true`, exactly as before.
 * (The status probe is also readable under the contention that makes the abort
 * fail: measured with `.git/index.lock` held, `git status --porcelain -uno`
 * still exits 0 and still prints `UU README.md`. The one probe that cannot run
 * in that state is the abort, whose exit code this function already ignores.)
 *
 * A status probe that itself fails is reported as NOT restored: this function's
 * answer is written into the record as a fact about the operator's checkout,
 * and "we could not tell" must never be recorded as "it is fine".
 */
export async function restoreAfterFailedMerge(
  repoRoot: string,
  git: GitSpawner = spawnGit,
): Promise<{ treeRestored: boolean; detail: string }> {
  const abort = await git(repoRoot, ["merge", "--abort"]);
  const midMerge = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  const status = await git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  const dirty = status.stdout.split("\n").filter((l) => l.trim().length > 0);

  const problems: string[] = [];
  if (midMerge.code === 0) problems.push("MERGE_HEAD is still present, so the checkout is mid-merge");
  if (status.code !== 0) {
    problems.push(
      `git status could not read the working tree (exit ${status.code}: ${status.stderr.trim() || "no output"}), ` +
        "so whether it was restored is unknown",
    );
  } else if (dirty.length > 0) {
    problems.push(
      `${dirty.length} tracked path(s) are left modified: ${dirty.slice(0, 5).join(", ")}` +
        (dirty.length > 5 ? ` (+${dirty.length - 5} more)` : ""),
    );
  }
  if (problems.length === 0) return { treeRestored: true, detail: "" };
  return {
    treeRestored: false,
    detail:
      `git merge --abort exited ${abort.code} and ${problems.join("; ")} — ${repoRoot} must be cleaned up ` +
      `by hand before anything else is merged into it` +
      (abort.stderr.trim() ? `: ${abort.stderr.trim()}` : ""),
  };
}

/**
 * Fetch one worker's branch and either refuse it, merge it, or report a git
 * failure — never leaving the working tree dirtier than it started.
 *
 * ## The fetch writes to a ref of its own (finding 6)
 *
 * This used to fetch with no refspec and read `FETCH_HEAD`. Capturing that
 * into a plain SHA immediately was a real improvement over re-reading it, and
 * it defended against exactly one thing: this module's own next fetch. It
 * could not defend against anybody else's. `FETCH_HEAD` is ONE file per
 * repository, rewritten by every fetch in that checkout from any process — the
 * operator's own terminal, a second scratchpad script, an editor's background
 * sync. A fetch landing in the window between this module's fetch and its
 * `rev-parse` swaps the SHA, and the gate then inspects, merges and RECORDS a
 * head that is not the one it fetched, under this worker's task_id. The record
 * is the artifact §6.4 step 6 is re-derived from, so that is a wrong answer
 * written down as a right one.
 *
 * `+<branch>:refs/pifleet/incoming/<worker>` gives the fetch a destination no
 * other git command writes by convention, and the `rev-parse` then asks for
 * that ref by name. A concurrent fetch cannot move it, because nothing else
 * names it.
 *
 * ## And the race is now TESTED, not only closed by construction (ISC-562)
 *
 * The mechanism above was mutation-proved from the day it landed; the RACE was
 * not, and the entry said so — with the justification that the window "cannot
 * be deterministically entered from a test". That was true of the code and not
 * of the window: `spawnGit` was a module-level import, so no test could be the
 * thing that returned from the fetch. It is a {@link MergeWorkerBranchDeps}
 * now, and the test wraps it, lets the real fetch run, drives a SECOND, foreign
 * fetch into the operator's checkout while the window is open, and then asserts
 * that what this function inspected, merged and recorded is the owned ref's
 * head rather than the one that fetch left in `FETCH_HEAD`.
 *
 * Three things were measured rather than argued, and each changed the test:
 *
 *  - Replacing `rev-parse <incomingRef>` with `rev-parse FETCH_HEAD` makes the
 *    function record the INTERLOPER's head — the failure, reproduced end to end
 *    under this worker's task_id, not merely described.
 *  - A test hook keyed on the `rev-parse`'s argv passes GREEN under that same
 *    mutation, because the mutation rewrites the argv the hook was watching
 *    for. The hook is keyed on the fetch's RETURN instead. This was run, and it
 *    is why the trap is worth a paragraph.
 *  - Dropping the `git` argument at a single call site — the shape a later edit
 *    would produce by accident — is caught, because a second test asserts the
 *    injected spawner sees every command this function issues.
 *
 * ## And it is dropped again unless the merge lands
 *
 * Every exit from here that is not `merged` deletes the ref it fetched into:
 * the hazard refusal, the failed merge, and — through the `catch` — the paths
 * where git itself fails between the fetch and the merge. `incomingRefFor`
 * carries the argument for the asymmetry with the merged case, which keeps it.
 * The `catch` re-throws untouched; it exists to stop a thrown `rev-parse` or
 * `diff` from being the one way refused content stays reachable forever.
 */
export async function mergeWorkerBranch(
  input: MergeWorkerBranchInput,
  deps: MergeWorkerBranchDeps = DEFAULT_MERGE_DEPS,
): Promise<MergeWorkerBranchResult> {
  const { repoRoot, worker, remote, branch, taskId } = input;
  const baseRef = input.baseRef ?? "HEAD";
  const git = deps.git;

  // ---- Part -1: the operator's checkout must be fit to merge into. ----
  await assertMergePreconditions(repoRoot, input.unrestoredPriorWorkers ?? [], git);

  // ---- Part 0: look at the clone git is about to run its SERVER side inside. ----
  const preFetchHazards = await scanWorkerCloneBeforeFetch(repoRoot, remote, git);

  // ---- Part 1: fetch freely, into a ref THIS call owns. ----
  const incomingRef = incomingRefFor(worker);
  // `+` forces the update: this ref is a scratch pointer for one merge, and a
  // previous merge of the same worker leaving a non-fast-forward tip behind is
  // the ordinary case, not an error.
  //
  // `--refmap=` is not decoration, and it was found by asserting the property
  // rather than the mechanism. Deleting the incoming ref after a refusal
  // reclaims NOTHING on its own: fetching from a named remote also performs
  // git's opportunistic remote-tracking update, so the same head stayed
  // reachable from `refs/remotes/worker-<id>/<branch>` — measured, git 2.50.1,
  // an explicit refspec on the command line does not suppress it. An empty
  // `--refmap` tells git to ignore the remote's configured refspecs entirely
  // and use only what this command names, and with it the fetch writes exactly
  // one ref: the one this call owns and can therefore drop again. It also makes
  // finding 6's property literal — one fetch, one ref, named here.
  const fetchRes = await git(repoRoot, ["fetch", "--refmap=", remote, `+${branch}:${incomingRef}`]);
  if (fetchRes.code !== 0) {
    throw new IntegrationGitError(`git fetch --refmap= ${remote} +${branch}:${incomingRef}`, fetchRes);
  }
  // THE WINDOW. Everything between the line above and the line below is time in
  // which any other process in this checkout can run a fetch of its own, and
  // `FETCH_HEAD` — the file this used to read — would be whatever theirs left
  // behind. `incomingRef` is asked for by name because nothing else writes it.
  const headRes = await git(repoRoot, ["rev-parse", incomingRef]);
  if (headRes.code !== 0) {
    throw new IntegrationGitError(`git rev-parse ${incomingRef}`, headRes);
  }
  const head = headRes.stdout.trim();

  const countRes = await git(repoRoot, ["rev-list", "--count", `${baseRef}..${head}`]);
  // `null`, not `NaN`, and emphatically not `0`: the undetermined value is
  // killed HERE, at the point it enters the module, rather than rendered into
  // a determinate-looking `0` three hundred lines downstream (finding 8). A
  // successful-but-unparseable count is the same unknown as a failed one and
  // takes the same answer.
  const parsedAhead = Number.parseInt(countRes.stdout.trim(), 10);
  const commitsAhead = countRes.code === 0 && Number.isFinite(parsedAhead) ? parsedAhead : null;

  let mergeCommit: string;
  let postMergeHazards: RepoHazard[];
  try {
    // ---- Part 2: inspect BEFORE materialising. ----
    const changed = await incomingTreeChanges(repoRoot, baseRef, head, git);
    const hazards = findHazardTouches(changed, head);
    if (hazards.length > 0) {
      // Refused content does not stay reachable from the operator's repository.
      await deleteIncomingRef(repoRoot, incomingRef, head, git);
      return {
        worker,
        remote,
        branch,
        taskId,
        head,
        commitsAhead,
        preFetchHazards,
        outcome: { kind: "refused_hazard", hazards },
      };
    }

    // ---- Part 3: merge with hooks and the attributes file disabled. ----
    const mergeMessage = `Merge worker ${worker} (${remote}/${branch} @ ${head.slice(0, 12)}) into the integration branch`;
    const mergeRes = await git(repoRoot, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      mergeMessage,
      head,
    ]);
    if (mergeRes.code !== 0) {
      const cleanup = await restoreAfterFailedMerge(repoRoot, git);
      // Same argument as the refusal above, and it holds even when the cleanup
      // could not restore the tree: the ref is what would keep this head
      // reachable FOREVER, and dropping it is independent of whatever hand
      // cleanup the checkout still needs.
      await deleteIncomingRef(repoRoot, incomingRef, head, git);
      return {
        worker,
        remote,
        branch,
        taskId,
        head,
        commitsAhead,
        preFetchHazards,
        outcome: {
          kind: "merge_failed",
          detail: mergeRes.stderr.trim() || mergeRes.stdout.trim(),
          treeRestored: cleanup.treeRestored,
          cleanupDetail: cleanup.detail,
        },
      };
    }
    const mergeCommitRes = await git(repoRoot, ["rev-parse", "HEAD"]);
    if (mergeCommitRes.code !== 0) {
      throw new IntegrationGitError("git rev-parse HEAD", mergeCommitRes);
    }
    mergeCommit = mergeCommitRes.stdout.trim();

    // ---- Part 4: neutralize the operator's checkout, after every merge, before anything reads it. ----
    postMergeHazards = await neutralizeRepoHazards(repoRoot);
  } catch (err) {
    // A throw between the fetch and a landed merge is a merge that did not
    // happen, and it must not be the one path where the fetched head stays
    // parked in the operator's repository. A throw from the two steps AFTER the
    // merge lands (`rev-parse HEAD`, the part 4 re-scan) deletes the ref too,
    // and that costs nothing: the merge commit already pins that head, so the
    // delete reclaims no objects there — it only forfeits the "what was last
    // fetched" convenience `incomingRefFor` describes, on a call that is
    // throwing anyway. Re-thrown untouched: this handler adds cleanup, never a
    // second, worse-worded error.
    await deleteIncomingRef(repoRoot, incomingRef, head, git);
    throw err;
  }

  return {
    worker,
    remote,
    branch,
    taskId,
    head,
    commitsAhead,
    preFetchHazards,
    outcome: { kind: "merged", mergeCommit, postMergeHazards },
  };
}

// ---------------------------------------------------------------------------
// The integration record (§7.2).
// ---------------------------------------------------------------------------

export const INTEGRATION_RECORD_SCHEMA = "pifleet.pmintegration/v1" as const;

const HazardRefusalSchema = z
  .object({
    path: shortStr,
    hazard_class: z.enum(HAZARD_PATH_CLASSES),
    commit: gitSha40,
  })
  .strict();

/**
 * One worker's row. Beyond the minimal shape §7.2's prose lists (`worker`,
 * `remote`, `branch`, `task_id`, `head`, `commits_ahead`, `merged`,
 * `merge_commit`), this carries what §6.2.1 requires be RECORDED and nothing
 * else: `hazard_refusal` is "the worker, the path and the commit" a refusal
 * must report (part 2), and `post_merge_hazards` is what `neutralizeRepoHazards`
 * found on the operator's checkout after this merge (part 4, ISC-535). Both
 * default to empty rather than being optional, so a reader never has to ask
 * "was this not recorded, or genuinely nothing found".
 */
export const IntegrationWorkerRowSchema = z
  .object({
    worker: workerId,
    /** The `worker-<id>` remote this row was fetched through — recorded, never re-derived (§2.1). */
    remote: shortStr,
    branch: shortStr,
    task_id: taskIdField,
    /** The SHA `git fetch` brought in, captured once and never re-read from a ref. */
    head: gitSha40,
    /**
     * How far ahead the fetched head was — or `null` when git could not say
     * (finding 8). Nullable rather than defaulted, because a default is a
     * value somebody chose and "we do not know" is not a value somebody
     * chose. `worktrees.ts:52` already carries an undetermined commit count
     * as `null`; a second spelling of the same unknown would be worse than
     * either spelling alone.
     */
    commits_ahead: z.number().int().nonnegative().nullable(),
    merged: z.boolean(),
    merge_commit: gitSha40.nullable(),
    hazard_refusal: z.array(HazardRefusalSchema).max(MAX_ITEMS).default([]),
    post_merge_hazards: z.array(RepoHazardSchema).max(MAX_ITEMS).default([]),
    /**
     * Hazards standing in the WORKER's clone at the moment git ran its server
     * side inside it (finding 5). Recorded, never a refusal — see
     * `scanWorkerCloneBeforeFetch` for what was measured and what was refuted.
     */
    pre_fetch_hazards: z.array(RepoHazardSchema).max(MAX_ITEMS).default([]),
    /**
     * For a row whose merge FAILED: whether the checkout was actually left out
     * of the merge (finding 7). `null` on every other row — the question does
     * not arise when no merge was attempted or the merge landed. `false` means
     * MERGE_HEAD survived the abort and the checkout needs a human.
     */
    tree_restored: z.boolean().nullable().default(null),
    /** Free text: a merge-failed detail, or blank. Never load-bearing. */
    note: text.default(""),

    // ── Refused (§7.2): "any field naming a model, a container, a mount, or
    // a host path outside the repository". This record exists to make step 6
    // of §6.4 re-derivable FROM GIT; a field naming any of these would make
    // it a second, driftable spelling of state that already lives elsewhere
    // (the container registry, the run tree, `~/.pifleet`).
    model: notHere(
      'an integration record row may not name "model" (§7.2) — what ran a worker is the run ' +
        "tree's concern, and a row naming it here would be a second, driftable spelling of it.",
    ),
    container: notHere(
      'an integration record row may not name "container" (§7.2) — same argument as "model": ' +
        "this record is about commits reaching a branch, not about what produced them.",
    ),
    mount: notHere(
      'an integration record row may not name "mount" (§7.2) — a mount path is a container-side ' +
        "detail this record has no use for and no business repeating.",
    ),
    host_path: notHere(
      'an integration record row may not name "host_path" (§7.2) — a path into `~/.pifleet` or ' +
        "anywhere else outside the repository would make this record a second spelling of the run tree.",
    ),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.merged && row.merge_commit === null) {
      ctx.addIssue({
        code: "custom",
        path: ["merge_commit"],
        message: `worker "${row.worker}" is recorded merged but carries no merge_commit`,
      });
    }
    if (!row.merged && row.merge_commit !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["merge_commit"],
        message: `worker "${row.worker}" is not recorded merged but carries a merge_commit`,
      });
    }
  });
export type IntegrationWorkerRow = z.infer<typeof IntegrationWorkerRowSchema>;

export const IntegrationRecordSchema = z
  .object({
    schema: z.literal(INTEGRATION_RECORD_SCHEMA, {
      error: `not a ${INTEGRATION_RECORD_SCHEMA} document`,
    }),
    run_id: shortStr,
    integration_branch: shortStr,
    base_sha: gitSha40,
    workers: z.array(IntegrationWorkerRowSchema).max(MAX_ITEMS),

    model: notHere('an integration record may not name "model" (§7.2) — see the per-row field for the full argument.'),
    container: notHere(
      'an integration record may not name "container" (§7.2) — see the per-row field for the full argument.',
    ),
    mount: notHere('an integration record may not name "mount" (§7.2) — see the per-row field for the full argument.'),
    host_path: notHere(
      'an integration record may not name "host_path" (§7.2) — a path into `~/.pifleet` would make ' +
        "this record a second spelling of the run tree.",
    ),
  })
  .strict();
export type IntegrationRecord = z.infer<typeof IntegrationRecordSchema>;

/** Fold one merge outcome into the row shape the record persists. */
export function toIntegrationWorkerRow(result: MergeWorkerBranchResult): IntegrationWorkerRow {
  const base = {
    worker: result.worker,
    remote: result.remote,
    branch: result.branch,
    task_id: result.taskId,
    head: result.head,
    // No `Number.isFinite(...) ? ... : 0` here any more. `commitsAhead` is
    // already `number | null` by the time it arrives, because the unknown is
    // killed where it enters (finding 8).
    commits_ahead: result.commitsAhead,
    pre_fetch_hazards: result.preFetchHazards,
  };
  switch (result.outcome.kind) {
    case "merged":
      return IntegrationWorkerRowSchema.parse({
        ...base,
        merged: true,
        merge_commit: result.outcome.mergeCommit,
        hazard_refusal: [],
        post_merge_hazards: result.outcome.postMergeHazards,
        tree_restored: null,
        note: "",
      });
    case "refused_hazard":
      return IntegrationWorkerRowSchema.parse({
        ...base,
        merged: false,
        merge_commit: null,
        hazard_refusal: result.outcome.hazards,
        post_merge_hazards: [],
        tree_restored: null,
        note: "",
      });
    case "merge_failed":
      return IntegrationWorkerRowSchema.parse({
        ...base,
        merged: false,
        merge_commit: null,
        hazard_refusal: [],
        post_merge_hazards: [],
        tree_restored: result.outcome.treeRestored,
        // The cleanup verdict is carried by `tree_restored`, which is a
        // boolean a reader can act on. This note is the human sentence beside
        // it, and stays non-load-bearing.
        note: result.outcome.cleanupDetail
          ? `${result.outcome.detail}\n${result.outcome.cleanupDetail}`
          : result.outcome.detail,
      });
  }
}

// ---------------------------------------------------------------------------
// Record I/O — refuses a host path outside the repository (§7.2, task 3.1).
// ---------------------------------------------------------------------------

/**
 * `dir` is not the top level of a git repository — either nothing is there
 * at all, or `dir` is a subdirectory of a real repository rather than its
 * root. Both are "a host path outside the repository" in §7.2's sense: the
 * record's whole purpose is to make step 6 of §6.4 re-derivable INSIDE the
 * repository it describes, and a path that is not that repository's own top
 * level is refused categorically rather than written to.
 */
export class HostPathOutsideRepositoryError extends Error {
  constructor(dir: string) {
    super(
      `refused: ${dir} is not a git repository root, so the integration record cannot be ` +
        `written there or read from there. A host path outside the repository (§7.2) is refused ` +
        `categorically — this includes a subdirectory of a real repository that is not itself ` +
        `the top level.`,
    );
    this.name = "HostPathOutsideRepositoryError";
  }
}

async function assertRepositoryRoot(dir: string): Promise<void> {
  const gitPath = join(resolve(dir), ".git");
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(gitPath);
  } catch {
    throw new HostPathOutsideRepositoryError(dir);
  }
  // A directory (ordinary repo) or a file (linked worktree's `gitdir:`
  // pointer, `worktree.ts`'s own shape) both mean `dir` really is a
  // repository's top level. Anything else (symlink, socket, …) is not.
  if (!st.isDirectory() && !st.isFile()) {
    throw new HostPathOutsideRepositoryError(dir);
  }
}

/** Where the record lives for one phase, per §7.2's exact path. */
export function integrationRecordPath(repoRoot: string, phase: number): string {
  if (!Number.isInteger(phase) || phase < 0) {
    throw new RangeError(`phase must be a non-negative integer, got ${phase}`);
  }
  return join(resolve(repoRoot), ".claude", "project-manager", `phase-${phase}`, "integration.json");
}

/**
 * Validate and write. Written AFTER each merge, never before — a record
 * written first turns a crash into a merge that silently never happens, and
 * one written last turns it into a merge attempted twice, which git reports
 * as a no-op against an already-merged branch. This document (§7.2) takes the
 * duplicate, on `relay-journal.ts`'s own reasoning.
 */
export async function writeIntegrationRecord(
  repoRoot: string,
  phase: number,
  record: IntegrationRecord,
): Promise<void> {
  await assertRepositoryRoot(repoRoot);
  const parsed = IntegrationRecordSchema.parse(record);
  const path = integrationRecordPath(repoRoot, phase);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/**
 * Read and validate (§7.2, task 3.3). A resumed run refuses a malformed or
 * hand-edited record rather than acting on one — the same argument §7.2 makes
 * for `CollationSchema` being validated on every read.
 */
export async function readIntegrationRecord(repoRoot: string, phase: number): Promise<IntegrationRecord> {
  await assertRepositoryRoot(repoRoot);
  const path = integrationRecordPath(repoRoot, phase);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`could not read integration record at ${path}: ${String(err)}`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new Error(`integration record at ${path} is not valid JSON: ${String(err)}`);
  }
  /*
   * Wrapped, like every other durable reader in this repository
   * (`report/collect.ts:473`, `security/control-auth.ts`, `attended/mode.ts`)
   * and for the reason `test/unit/durable-reader-wrapping.test.ts` scans for:
   * a bare `.parse` on FILE BYTES surfaces a raw ZodError whose message names
   * a field path and no file, so the operator learns a record is malformed
   * without learning WHICH record. This one is read on resume, when the run
   * that wrote it is over and its author is not around to ask.
   */
  try {
    return IntegrationRecordSchema.parse(parsedJson);
  } catch (err) {
    throw new Error(`integration record at ${path} is malformed: ${String(err)}`);
  }
}
