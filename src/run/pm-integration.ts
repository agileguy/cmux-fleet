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
 *   1. Fetch freely — `git fetch` moves objects and updates a ref; it writes
 *      no working-tree file and runs no filter. The exposure begins at merge,
 *      so nothing here gates the fetch itself.
 *   2. Inspect the incoming tree BEFORE materialising it — `git diff
 *      --name-only <base>..<fetched-head>` lists what the merge would write
 *      without writing it. A path matching a hazard CLASS (`AGENTS.md`,
 *      `CLAUDE.md`, `.pi/**`, `.agents/skills/**`, `.gitattributes`, anything
 *      under `.github/workflows/`) refuses the merge outright — a legitimate
 *      edit to one of these is an edit the operator approves by hand, and
 *      must not be approved by this loop's silence.
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
import { neutralizeRepoHazards } from "../security/repo-hazards.ts";

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
 * The six classes §6.2.1 names, verbatim. This list is intentionally an
 * ARRAY of independent rules rather than one combined regex: the mutation
 * proof for ISC-534 removes one entry at a time and expects exactly that
 * class's fixture to start failing while the other five stay green — a
 * property a combined pattern could not demonstrate as cleanly.
 */
export const HAZARD_PATH_CLASSES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".pi/**",
  ".agents/skills/**",
  ".gitattributes",
  ".github/workflows/**",
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
 */
const HAZARD_PATH_RULES: readonly HazardPathRule[] = [
  { hazardClass: "AGENTS.md", matches: (p) => p === "AGENTS.md" },
  { hazardClass: "CLAUDE.md", matches: (p) => p === "CLAUDE.md" },
  { hazardClass: ".pi/**", matches: (p) => p === ".pi" || p.startsWith(".pi/") },
  {
    hazardClass: ".agents/skills/**",
    matches: (p) => p === ".agents/skills" || p.startsWith(".agents/skills/"),
  },
  { hazardClass: ".gitattributes", matches: (p) => p === ".gitattributes" || p.endsWith("/.gitattributes") },
  {
    hazardClass: ".github/workflows/**",
    matches: (p) => p === ".github/workflows" || p.startsWith(".github/workflows/"),
  },
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

async function spawnGit(cwd: string, args: readonly string[]): Promise<GitResult> {
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
): Promise<string[]> {
  const res = await spawnGit(repoRoot, ["diff", "--name-only", "-z", `${baseRef}...${headRef}`]);
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
}

export type MergeWorkerBranchOutcome =
  | { kind: "refused_hazard"; hazards: HazardTouch[] }
  | { kind: "merge_failed"; detail: string }
  | { kind: "merged"; mergeCommit: string; postMergeHazards: RepoHazard[] };

export interface MergeWorkerBranchResult {
  worker: string;
  remote: string;
  branch: string;
  taskId: string;
  /** The SHA `git fetch` brought in — captured immediately, never re-read from `FETCH_HEAD` later. */
  head: string;
  commitsAhead: number;
  outcome: MergeWorkerBranchOutcome;
}

/**
 * Fetch one worker's branch and either refuse it, merge it, or report a git
 * failure — never leaving the working tree dirtier than it started.
 *
 * `FETCH_HEAD` is captured into a plain SHA immediately after the fetch and
 * used from then on: two workers merged in sequence would otherwise race on
 * the SAME mutable ref, and there is no reason to hold that risk when
 * `rev-parse FETCH_HEAD` costs one more git spawn.
 */
export async function mergeWorkerBranch(input: MergeWorkerBranchInput): Promise<MergeWorkerBranchResult> {
  const { repoRoot, worker, remote, branch, taskId } = input;
  const baseRef = input.baseRef ?? "HEAD";

  // ---- Part 1: fetch freely. ----
  const fetchRes = await spawnGit(repoRoot, ["fetch", remote, branch]);
  if (fetchRes.code !== 0) {
    throw new IntegrationGitError(`git fetch ${remote} ${branch}`, fetchRes);
  }
  const headRes = await spawnGit(repoRoot, ["rev-parse", "FETCH_HEAD"]);
  if (headRes.code !== 0) {
    throw new IntegrationGitError("git rev-parse FETCH_HEAD", headRes);
  }
  const head = headRes.stdout.trim();

  const countRes = await spawnGit(repoRoot, ["rev-list", "--count", `${baseRef}..${head}`]);
  const commitsAhead = countRes.code === 0 ? Number.parseInt(countRes.stdout.trim(), 10) : Number.NaN;

  // ---- Part 2: inspect BEFORE materialising. ----
  const changed = await incomingTreeChanges(repoRoot, baseRef, head);
  const hazards = findHazardTouches(changed, head);
  if (hazards.length > 0) {
    return {
      worker,
      remote,
      branch,
      taskId,
      head,
      commitsAhead,
      outcome: { kind: "refused_hazard", hazards },
    };
  }

  // ---- Part 3: merge with hooks and the attributes file disabled. ----
  const mergeMessage = `Merge worker ${worker} (${remote}/${branch} @ ${head.slice(0, 12)}) into the integration branch`;
  const mergeRes = await spawnGit(repoRoot, [
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
    // Best-effort cleanup: leave the tree as it was found rather than mid-conflict.
    await spawnGit(repoRoot, ["merge", "--abort"]).catch(() => {});
    return {
      worker,
      remote,
      branch,
      taskId,
      head,
      commitsAhead,
      outcome: { kind: "merge_failed", detail: mergeRes.stderr.trim() || mergeRes.stdout.trim() },
    };
  }
  const mergeCommitRes = await spawnGit(repoRoot, ["rev-parse", "HEAD"]);
  if (mergeCommitRes.code !== 0) {
    throw new IntegrationGitError("git rev-parse HEAD", mergeCommitRes);
  }
  const mergeCommit = mergeCommitRes.stdout.trim();

  // ---- Part 4: neutralize the operator's checkout, after every merge, before anything reads it. ----
  const postMergeHazards = await neutralizeRepoHazards(repoRoot);

  return {
    worker,
    remote,
    branch,
    taskId,
    head,
    commitsAhead,
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
    commits_ahead: z.number().int().nonnegative(),
    merged: z.boolean(),
    merge_commit: gitSha40.nullable(),
    hazard_refusal: z.array(HazardRefusalSchema).max(MAX_ITEMS).default([]),
    post_merge_hazards: z.array(RepoHazardSchema).max(MAX_ITEMS).default([]),
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
    commits_ahead: Number.isFinite(result.commitsAhead) ? result.commitsAhead : 0,
  };
  switch (result.outcome.kind) {
    case "merged":
      return IntegrationWorkerRowSchema.parse({
        ...base,
        merged: true,
        merge_commit: result.outcome.mergeCommit,
        hazard_refusal: [],
        post_merge_hazards: result.outcome.postMergeHazards,
        note: "",
      });
    case "refused_hazard":
      return IntegrationWorkerRowSchema.parse({
        ...base,
        merged: false,
        merge_commit: null,
        hazard_refusal: result.outcome.hazards,
        post_merge_hazards: [],
        note: "",
      });
    case "merge_failed":
      return IntegrationWorkerRowSchema.parse({
        ...base,
        merged: false,
        merge_commit: null,
        hazard_refusal: [],
        post_merge_hazards: [],
        note: result.outcome.detail,
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
