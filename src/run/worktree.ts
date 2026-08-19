/**
 * Per-worker code isolation (SRD §9.1) — implemented as a CLONE, not a linked
 * worktree.
 *
 * The module keeps the name `worktree` because `isolation: worktree` is the
 * vocabulary an operator writes in `fleet.yaml` and the SRD's §9.1 table
 * defines; only the mechanism underneath it is a clone. Three designs were
 * built and tested against a real container before this one was chosen, and
 * the two that were rejected are recorded here because a future reader will
 * otherwise reach for the obvious one first:
 *
 *  1. **`git worktree add`, mounting only the worktree directory.** Fails
 *     outright. A linked worktree's `.git` is a FILE holding a `gitdir:`
 *     pointer into the parent's `.git/worktrees/<name>`, which is outside
 *     everything the container can see, so git inside the container answers
 *     `fatal: not a git repository` and the worker cannot commit at all.
 *
 *  2. **`git worktree add`, ALSO mounting the gitdir at its real host path.**
 *     Works, and is a confirmed container-to-host remote code execution.
 *     From inside such a container the spike zeroed the host's
 *     `refs/heads/main` and planted an executable `.git/hooks/post-checkout`
 *     that ran as the OPERATOR'S host user on their next ordinary `git
 *     checkout`. The container boundary is the fleet's primary isolation
 *     (§9.1); a mount that hands the confined party write access to the
 *     confining party's hook directory dissolves it. Never build this.
 *
 *  3. **`git clone --no-hardlinks`** — this module. The clone is entirely
 *     self-contained: `.git` is a real directory INSIDE the mount, so nothing
 *     the container touches resolves outside `/workspace`, and the parent
 *     repository is unaffected by anything the worker does.
 *
 * **`--no-hardlinks` is load-bearing, not hygiene.** `git clone` from a local
 * path defaults to `--local`, which HARDLINKS the source's object files into
 * the clone. A hardlink is one inode with two names: the 0444 mode on a pack
 * does not stop the owning uid from `chmod +w`, and a worker container writing
 * through its own copy corrupts the PARENT'S object store. That is not
 * theoretical — it is how the spike investigating this feature destroyed the
 * real repository's pack file, from a clone it believed was a throwaway.
 * Measured on this machine: a default local clone leaves every object at
 * `nlink=2` sharing the source's inode, for loose objects and packs alike;
 * with `--no-hardlinks` every object is `nlink=1` at a fresh inode.
 * `test/integration/worktree.test.ts` asserts that property directly, because
 * a missing flag here fails no other test in the suite.
 *
 * Two further properties, each established by running rather than by reading:
 *
 *  - **`--branch` names a BRANCH, never a SHA.** `git clone --branch <sha>`
 *    exits 128 with `Remote branch <sha> not found in upstream origin`, and
 *    cloning with no `--branch` at all silently follows the source's default
 *    branch — a DIFFERENT commit from a detached HEAD. So a detached parent is
 *    a named refusal here rather than a base ref quietly substituted for the
 *    one the operator is sitting on.
 *
 *  - **`origin` is stripped after the clone.** Nothing fetches or pushes
 *    through it, and leaving it records the host's absolute repository path
 *    inside a config file the worker can read — a gratuitous disclosure of the
 *    host layout to the confined party. Verified: after `git remote remove
 *    origin` the clone's `.git/config` contains no reference to the source
 *    path, and committing still works.
 *
 * Preflight is REF-SCOPED and runs once, before any clone exists.
 * `security/repo-hazards.ts` is the sibling control and is deliberately not
 * reused for it: that module walks a working tree on disk with `lstat`, and at
 * preflight time the only thing that exists is a ref in the parent's object
 * store. It also answers a different question — "what in this tree would
 * execute?" — while this one asks "would cloning this ref produce a usable
 * checkout at all?", which submodules and LFS both answer no to for reasons
 * that have nothing to do with hostility. The two meet AFTER creation:
 * `up` runs `neutralizeRepoHazards` on the finished clone, which — unlike a
 * linked worktree, whose `.git` is a file that scanner explicitly declines to
 * follow — has a real `.git` directory, so every scanner in that module
 * applies to it completely (ISC-249).
 */

import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { ConfigError, resolveWorker, type LoadedConfig } from "../config/load.ts";
import { EXIT } from "../contracts.ts";
import { runGit, type GitResult } from "../harvest/git.ts";
import { resolvedWithin } from "../harvest/outbox.ts";
import { workerBranch, workerWorktree, type RunPaths } from "./paths.ts";

/**
 * What `up` recorded about one worker's checkout, and what `down --prune`,
 * `dispatch` and the operator all read back.
 *
 * `baseSha` is not decoration: it is the floor `pruneWorkerWorktree` measures
 * "this clone holds work" against, and the value `harvest` would grade a diff
 * from. `remoteName` is recorded rather than re-derived so a rename of the
 * naming scheme cannot orphan the remotes an in-flight run already created.
 */
export interface WorkerWorktree {
  workerId: string;
  path: string;
  branch: string;
  baseSha: string;
  remoteName: string;
  /**
   * `git status --porcelain`, captured once the checkout is fully prepared —
   * empty at creation, then overwritten by `captureWorktreeBaseline` after
   * `up` runs hazard neutralization. See that function for why this exists:
   * neutralization is a real, uncommitted change the instant it happens, and
   * without a recorded baseline every clone of a repository with a root
   * `AGENTS.md`/`CLAUDE.md` reads as dirty from birth.
   */
  baselineStatus: string;
}

/**
 * The base ref could not be cloned as-is, and the operator has to change
 * something: a detached HEAD, submodules, LFS-tracked content, a leftover
 * directory. Exit 2 by way of `ConfigError` — this is the same class as a bad
 * `fleet.yaml`, not an environment that will not cooperate.
 */
export class WorktreePreflightError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "WorktreePreflightError";
  }
}

/**
 * Git itself failed — the clone, the branch, the remote registration.
 *
 * Exit 3 rather than 2, matching `MaterializeError` and the egress-network
 * guard in `up.ts`: a control that could not be ESTABLISHED is not an operator
 * mistake. Carries the git stderr verbatim, because a paraphrased git error is
 * a git error nobody can search for.
 */
export class WorktreeError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;
  constructor(what: string, result: GitResult) {
    super(`${what} failed (git exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "WorktreeError";
  }
}

/** `<repo>/.worktrees/<id>` already exists; adopting it silently is the one thing not to do. */
export class StaleWorktreeError extends WorktreePreflightError {
  constructor(workerId: string, path: string) {
    super(
      `refusing to create worker ${workerId}: ${path} already exists. ` +
        `A leftover checkout is either a live run's workspace or a crashed run's remains, ` +
        `and this path is NOT run-scoped — adopting it would hand a second run's worker a tree ` +
        `with another run's commits, branch and uncommitted edits in it. ` +
        `Run \`pifleet down --prune\` (add --force if it holds work you do not want) or remove it by hand.`,
    );
    this.name = "StaleWorktreeError";
  }
}

/**
 * Bounds on the ref-scoped preflight scan, matching the shape
 * `security/repo-hazards.ts` and `run/materialize.ts` already use. A base ref
 * is operator-controlled today, so these are defence in depth — but an
 * unbounded read of tree content is an unbounded read either way.
 */
export const MAX_ATTRIBUTE_FILES = 256;
export const MAX_ATTRIBUTE_BYTES = 1024 * 1024;

/**
 * `filter=lfs` in a `.gitattributes` line.
 *
 * Narrower than `repo-hazards.ts`'s `ATTRIBUTE_DRIVER`, deliberately. That one
 * flags ANY `diff=`/`filter=` assignment because any of them names a program
 * git may execute; this one is looking for a specific incompatibility — LFS
 * pointer files that a clone materializes as pointers, not content, so a
 * worker grades against and commits against text that is not the file. A
 * `diff=` driver is a hazard to neutralize after cloning, not a reason to
 * refuse to clone, and conflating the two would make this gate refuse ordinary
 * repositories.
 */
const LFS_FILTER = /(^|\s)filter\s*=\s*lfs(\s|$)/;

/** Findings about a ref, separated from the decision to refuse it. */
export interface BaseRefFindings {
  /** Paths recorded as gitlinks (mode 160000) — a submodule, whatever `.gitmodules` says. */
  gitlinks: string[];
  /** `.gitmodules` is present in the tree at this ref. */
  gitmodules: boolean;
  /** `<attributes path>: <offending line>` for every LFS assignment found. */
  lfs: string[];
  /** Attribute files the scan declined to read, with the reason. Never silent. */
  unscanned: string[];
}

/** Split a git path on "/" — git records paths with forward slashes on every platform. */
function gitBasename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Inspect a ref for the two things that make a clone of it unusable, WITHOUT
 * checking anything out.
 *
 * One `ls-tree -r -z` pass finds both classes: gitlinks announce themselves
 * with mode `160000`, and every `.gitattributes` in the tree — root and nested
 * alike, because git honours one in every directory — comes back in the same
 * listing. `-z` for the reason `harvest/git.ts` uses it: paths are repository
 * content, a newline or a quote in one breaks the line-oriented format, and
 * NUL cannot appear in a path.
 *
 * Blobs are read with `cat-file blob <ref>:<path>` rather than `show`, because
 * the `<ref>:<path>` form leaves no room for a path to be re-read as a
 * revision, and `cat-file` is outside the diff family so no driver flag
 * applies to it.
 */
export async function inspectBaseRef(repo: string, baseRef: string): Promise<BaseRefFindings> {
  const listing = await runGit(repo, ["ls-tree", "-r", "-z", baseRef]);
  if (listing.code !== 0) throw new WorktreeError(`ls-tree ${baseRef} in ${repo}`, listing);

  const findings: BaseRefFindings = { gitlinks: [], gitmodules: false, lfs: [], unscanned: [] };
  const attributeFiles: string[] = [];
  for (const record of listing.stdout.split("\0")) {
    if (record === "") continue;
    // `<mode> SP <type> SP <sha> TAB <path>`; the path may itself contain tabs,
    // so the FIRST tab is the separator and everything after it is the path.
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const mode = record.slice(0, tab).split(" ")[0] ?? "";
    const path = record.slice(tab + 1);
    if (mode === "160000") findings.gitlinks.push(path);
    if (path === ".gitmodules") findings.gitmodules = true;
    if (gitBasename(path) === ".gitattributes") attributeFiles.push(path);
  }

  const scanned = attributeFiles.slice(0, MAX_ATTRIBUTE_FILES);
  if (attributeFiles.length > scanned.length) {
    findings.unscanned.push(
      `${attributeFiles.length - scanned.length} further .gitattributes file(s) beyond the ` +
        `cap of ${MAX_ATTRIBUTE_FILES}; not read`,
    );
  }
  for (const path of scanned) {
    const spec = `${baseRef}:${path}`;
    const size = await runGit(repo, ["cat-file", "-s", spec]);
    if (size.code !== 0) {
      findings.unscanned.push(`${path}: could not size (${size.stderr.trim()})`);
      continue;
    }
    if (Number(size.stdout.trim()) > MAX_ATTRIBUTE_BYTES) {
      findings.unscanned.push(`${path}: ${size.stdout.trim()} bytes exceeds ${MAX_ATTRIBUTE_BYTES}; not read`);
      continue;
    }
    const blob = await runGit(repo, ["cat-file", "blob", spec]);
    if (blob.code !== 0) {
      findings.unscanned.push(`${path}: could not read (${blob.stderr.trim()})`);
      continue;
    }
    for (const raw of blob.stdout.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.trimStart().startsWith("#")) continue;
      if (LFS_FILTER.test(line)) findings.lfs.push(`${path}: ${line.trim().slice(0, 160)}`);
    }
  }
  return findings;
}

/**
 * SRD §9.2's fail-fast, retargeted from "the worktree" to "the ref about to be
 * cloned" — which is the only thing that exists at this point.
 *
 * Submodules and LFS are refused for different reasons and both are real.
 * A gitlink clones as an EMPTY directory unless `--recurse-submodules` is
 * passed, which this module deliberately never passes (a submodule URL is
 * repository-controlled input, and `protocol.ext.allow=never` in
 * `GIT_HARDENING` exists precisely because such a URL can name a program). So
 * the worker gets a tree that builds differently from the operator's and
 * nothing says so. LFS-tracked content clones as POINTER FILES — a 130-byte
 * text stub where the file should be — so a worker reads, edits and commits
 * something that is not the file, and its diff is graded against the stub.
 * Both are silent-wrong-answer failures, which is what makes them worth an
 * up-front refusal rather than a warning.
 */
export function assertBaseRefCloneable(
  repo: string,
  baseRef: string,
  findings: BaseRefFindings,
): void {
  const problems: string[] = [];
  if (findings.gitlinks.length > 0) {
    problems.push(
      `submodules at ${findings.gitlinks.slice(0, 8).join(", ")}` +
        (findings.gitlinks.length > 8 ? ` (+${findings.gitlinks.length - 8} more)` : "") +
        " — a clone materializes these as empty directories, so every worker would build a " +
        "different tree from yours with nothing reporting it",
    );
  } else if (findings.gitmodules) {
    // `.gitmodules` with no gitlink is inert, and saying so is the point: the
    // operator gets told what was found and why it still refuses, rather than
    // a bare "submodules present" they cannot reconcile with `git submodule
    // status` printing nothing.
    problems.push(
      ".gitmodules is present at this ref (with no gitlink entries) — submodule configuration " +
        "in the tree is not something this isolation mode reproduces",
    );
  }
  if (findings.lfs.length > 0) {
    problems.push(
      `LFS-tracked content: ${findings.lfs.slice(0, 4).join("; ")}` +
        (findings.lfs.length > 4 ? ` (+${findings.lfs.length - 4} more)` : "") +
        " — a clone materializes these as pointer stubs, so a worker would read, edit and be " +
        "graded on text that is not the file",
    );
  }
  // A `.gitattributes` this scan declined to read is not evidence of absence —
  // `findings.lfs` can only report what an assignment this scan actually READ
  // said, and a file skipped for size or an unreadable blob is a question
  // this preflight never answered. Returning past it silently was exactly the
  // silent-wrong-answer failure this whole gate exists to refuse instead of
  // warn about, and this struct's own doc comment says "Never silent" — so an
  // unscanned file is now itself a refusal reason, not a caveat appended only
  // when something else already triggered one.
  if (findings.unscanned.length > 0) {
    problems.push(
      `${findings.unscanned.length} attribute file(s) could not be fully scanned, so this ref's ` +
        `cloneability could not be confirmed rather than confirmed clean: ${findings.unscanned.join("; ")}`,
    );
  }
  if (problems.length === 0) return;
  throw new WorktreePreflightError(
    `refusing to create per-worker checkouts of ${baseRef} in ${repo}: ${problems.join(" / ")}. ` +
      `Use \`isolation: shared-ro\` or \`isolation: none\` for this repository (SRD §9.1), or ` +
      `run the fleet against a ref without them.`,
  );
}

/** The parent's checked-out branch and the commit it points at. */
export interface BaseRef {
  branch: string;
  sha: string;
}

/**
 * Resolve what every worker clones FROM: the branch the operator's repository
 * currently has checked out.
 *
 * There is no config field for this and deliberately none added — `run.repo`
 * names a checkout, and the branch it is sitting on is the base the operator
 * means. What DOES get recorded is the resolved `sha`, for the same reason
 * §7.1 makes `base_ref` a 40-char SHA in the envelope: a symbolic ref moves,
 * and a run graded against a moving floor is not reproducible.
 *
 * A detached HEAD is refused rather than worked around. `symbolic-ref -q HEAD`
 * is the test — `rev-parse --abbrev-ref HEAD` answers the literal string
 * `HEAD` when detached, which is not distinguishable from a branch NAMED
 * `HEAD` and is not a name `--branch` accepts either way.
 */
export async function resolveBaseRef(repo: string): Promise<BaseRef> {
  const sym = await runGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = sym.stdout.trim();
  if (sym.code !== 0 || branch === "") {
    throw new WorktreePreflightError(
      `the repository at ${repo} has a DETACHED HEAD, so there is no branch name to clone from. ` +
        `\`git clone --branch\` accepts a branch or tag, never a commit — passing a SHA exits 128 ` +
        `with "Remote branch <sha> not found in upstream origin" — and cloning with no --branch ` +
        `silently follows the repository's default branch instead, which is a DIFFERENT commit ` +
        `from the one you are sitting on. Check out a branch before \`pifleet up\`.`,
    );
  }
  const sha = await runGit(repo, ["rev-parse", `${branch}^{commit}`]);
  if (sha.code !== 0) throw new WorktreeError(`rev-parse ${branch} in ${repo}`, sha);
  return { branch, sha: sha.stdout.trim() };
}

/**
 * The remote a worker's clone is registered under in the PARENT repository.
 *
 * `git worktree list` shows nothing useful now that each worker is an
 * independent clone, and an operator still has to be able to see what a worker
 * did without leaving their own checkout. With this registered,
 * `git -C <repo> fetch worker-<id>` followed by `git -C <repo> log
 * worker-<id>/<branch>` reads the worker's commits from the operator's own
 * terminal; verified end to end, with the parent's own branch untouched.
 *
 * Collision across runs cannot happen even though worker ids repeat: the
 * remote is created in the same step as `workerWorktree(repo, id)`, which is
 * NOT run-scoped, so a second live run reusing the id is refused at the
 * directory before it ever reaches the remote. What CAN survive is a remote
 * whose clone was deleted by hand — stale by construction, and replaced rather
 * than adopted (see `registerWorkerRemote`).
 */
export function workerRemoteName(workerId: string): string {
  return `worker-${workerId}`;
}

/**
 * `.git/config` is a lockfile-protected file and `git remote add` contends on
 * it.
 *
 * Measured, not assumed: twelve concurrent `git remote add` calls against one
 * repository produced five failures reading `error: could not lock config
 * file .git/config: File exists`, with the remaining seven recorded correctly.
 * Git's lockfile FAILS rather than corrupting, so the exposure is a refused
 * `up`, not a damaged config — which makes a bounded retry the whole fix and
 * a cross-process mutex unnecessary. Within one `up` there is no
 * self-contention at all, because worktrees are created in sequence; this
 * covers two operators (or two `up` processes) touching one repository at
 * once, which is narrow but real.
 */
const CONFIG_LOCK_RETRIES = 20;
const CONFIG_LOCK_DELAY_MS = 50;
const CONFIG_LOCKED = /could not lock config file/i;

async function runGitWithConfigLockRetry(cwd: string, args: string[]): Promise<GitResult> {
  let last = await runGit(cwd, args);
  for (let i = 0; i < CONFIG_LOCK_RETRIES && last.code !== 0 && CONFIG_LOCKED.test(last.stderr); i++) {
    await new Promise((r) => setTimeout(r, CONFIG_LOCK_DELAY_MS));
    last = await runGit(cwd, args);
  }
  return last;
}

/**
 * Point the parent at one worker's clone, replacing any same-named remote.
 *
 * The remove-then-add is not laziness. `worker-<id>` is a namespace this module
 * owns, and by the time control reaches here the directory check has already
 * established that no LIVE pifleet clone holds this id — so an existing remote
 * of that name is the wreckage of a run whose directory was removed by hand.
 * Adopting it would point `fetch` at a path that no longer exists; failing on
 * it would make an unrelated leftover block every future run. It is replaced,
 * and the caller is told, which is the same detected-vs-neutralized honesty
 * `repo-hazards.ts` insists on.
 */
async function registerWorkerRemote(
  repo: string,
  remoteName: string,
  clonePath: string,
): Promise<{ replacedStale: boolean }> {
  const existing = await runGit(repo, ["remote", "get-url", remoteName]);
  const replacedStale = existing.code === 0;
  if (replacedStale) {
    const removed = await runGitWithConfigLockRetry(repo, ["remote", "remove", remoteName]);
    if (removed.code !== 0) throw new WorktreeError(`git remote remove ${remoteName}`, removed);
  }
  const added = await runGitWithConfigLockRetry(repo, ["remote", "add", remoteName, clonePath]);
  if (added.code !== 0) throw new WorktreeError(`git remote add ${remoteName}`, added);
  return { replacedStale };
}

/**
 * `<branch_prefix>/<run-id>/<worker-id>` has to be a valid git ref name, and
 * nothing upstream enforces that today. `run.branch_prefix` is an
 * unconstrained string (an operator can set it to anything, including `..`,
 * a leading `-`, or a trailing `.lock`) and `workerId`'s own grammar
 * (`SESSION_ID_RE`) permits both of those too. Checked HERE, for every wanted
 * worker, before ANY clone is attempted — the "pure work first" rule this
 * module already applies to the base-ref scan — because a name git refuses
 * only surfaces today at `git switch -c`, AFTER the clone directory already
 * exists: exit 3 for what is actually a config mistake, and (before the
 * atomicity fix below) an orphan checkout nothing had recorded yet.
 *
 * Delegates to git's own `check-ref-format --branch` rather than a
 * hand-written regex: the ref grammar (no `..`, no trailing `.lock`, no
 * control characters, no leading `-`, and more) is git's to define, and
 * restating a subset of it here would drift the moment git's own grammar
 * does. `--branch` mode specifically, not the bare `refs/heads/<name>` form:
 * measured directly, `check-ref-format refs/heads/-x` exits 0 — a leading
 * `-` is syntactically legal as a REF — while `git switch -c -x` and
 * `check-ref-format --branch -x` both refuse it, because a branch NAME
 * starting with `-` is indistinguishable from an option to the branch-taking
 * commands that consume it. `--branch` mode is what actually answers "will
 * `git switch -c` accept this", which is the question this function exists
 * to ask.
 */
async function assertValidBranchName(repo: string, branch: string, workerId: string): Promise<void> {
  const check = await runGit(repo, ["check-ref-format", "--branch", branch]);
  if (check.code !== 0) {
    throw new WorktreePreflightError(
      `worker ${workerId} would commit on branch ${JSON.stringify(branch)}, which git refuses as a ` +
        `ref name. This is built from run.branch_prefix, the run id and the worker id — check ` +
        `run.branch_prefix for characters git's ref grammar disallows (no "..", no trailing ` +
        `".lock", no leading "-", no spaces or control characters).`,
    );
  }
}

/**
 * Idempotently add `.worktrees/` to the OPERATOR's own exclude list, once,
 * before the first clone of a run is created.
 *
 * Without this, an operator's completely ordinary `git add -A && git commit`
 * embeds every worker's clone as a GITLINK (mode 160000): git treats an
 * un-ignored nested `.git` directory as a candidate submodule, not as content
 * to walk into. That gitlink then makes THIS MODULE'S OWN preflight
 * (`assertBaseRefCloneable`, above) refuse every subsequent `up` with a
 * "submodules present" diagnosis the operator never authored and cannot
 * reconcile with `git submodule status` printing nothing — reproduced
 * directly: create one clone, `git add -A && git commit` in the parent, then
 * re-run the ref scan against the new HEAD.
 *
 * Written to `.git/info/exclude`, never to `.gitignore`. SRD §12.8 requires
 * the operator's checkout be left otherwise unchanged, and `.gitignore` is
 * TRACKED content — writing to it would edit a file the operator did not ask
 * to edit and put it in their next commit's diff for a reason they never
 * authored. `info/exclude` is git's own mechanism for exactly this: local,
 * untracked, read only by git itself. Resolved via `git rev-parse
 * --git-path` rather than a hand-joined `<repo>/.git/info/exclude`, because
 * the operator's OWN checkout can itself be a linked worktree, where `.git`
 * is a pointer file and the real `info/exclude` lives elsewhere.
 */
async function excludeWorktreesDir(repo: string): Promise<void> {
  const gitPath = await runGit(repo, ["rev-parse", "--git-path", "info/exclude"]);
  if (gitPath.code !== 0) throw new WorktreeError(`rev-parse --git-path info/exclude in ${repo}`, gitPath);
  const excludePath = resolvePath(repo, gitPath.stdout.trim());

  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    // No exclude file yet — created below.
  }
  if (current.split("\n").some((l) => l.trim() === "/.worktrees/")) return;

  await mkdir(dirname(excludePath), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current;
  await writeFile(excludePath, `${prefix}/.worktrees/\n`, "utf8");
}

export interface CreateWorktreesOptions {
  loaded: LoadedConfig;
  run: RunPaths;
  /** The operator's checkout — already expanded by the caller. */
  repo: string;
  workerIds: readonly string[];
  /**
   * Called AS each checkout completes, never once over the returned array.
   *
   * The same argument `up.ts` makes for its materialization ledger appends: a
   * clone is real state on disk, and a failure on worker three leaves workers
   * one and two on disk. A batch record written afterwards records neither,
   * which is the forensic gap on precisely the failure path that most needs
   * one — `down --prune` would have no idea those two directories exist.
   */
  onCreated?: (w: WorkerWorktree, note: { replacedStaleRemote: boolean }) => Promise<void>;
}

/**
 * Create one independent, writable, committable checkout per `worktree`-mode
 * worker, plus the parent-side remote that makes it visible.
 *
 * Preflight runs ONCE over the base ref before any clone is attempted rather
 * than per worker: the finding is a property of the ref, and refusing on
 * worker four after three clones exist would leave exactly the mess the
 * up-front gate exists to avoid. This is the same ordering rule
 * `materialize.ts` states — pure work first, so a refusal costs nothing to
 * reap.
 *
 * Workers whose resolved isolation is not `worktree` are skipped silently;
 * `shared-ro` mounts the operator's checkout read-only and `none` gets no repo
 * mount at all (SRD §9.1), and neither has a checkout to make.
 */
export async function createWorkerWorktrees(
  opts: CreateWorktreesOptions,
): Promise<WorkerWorktree[]> {
  const { loaded, run, repo, workerIds } = opts;

  const wanted = workerIds.filter((id) => {
    try {
      return resolveWorker(loaded, id).isolation === "worktree";
    } catch {
      // Not in `workers:` — the Phase 1 `--workers` path can name ids the
      // config never defined, and those have no isolation mode to honour.
      return false;
    }
  });
  if (wanted.length === 0) return [];

  const base = await resolveBaseRef(repo);
  assertBaseRefCloneable(repo, base.branch, await inspectBaseRef(repo, base.branch));

  // Every wanted worker's branch name is validated BEFORE any clone exists —
  // same "pure work first" reasoning as the ref scan above. Looping over all
  // of `wanted` here, rather than checking lazily inside the per-worker loop
  // below, is the point: refusing on worker four after three clones exist
  // would leave exactly the mess an up-front gate exists to avoid.
  for (const workerId of wanted) {
    await assertValidBranchName(
      repo,
      workerBranch(loaded.config.run.branch_prefix, run.runId, workerId),
      workerId,
    );
  }

  await excludeWorktreesDir(repo);

  const created: WorkerWorktree[] = [];
  for (const workerId of wanted) {
    const path = workerWorktree(repo, workerId);
    // lstat, not `exists`: a dangling symlink at this path is still something
    // that must not be cloned over, and `stat` would follow it and report
    // absence.
    let occupied = true;
    try {
      await lstat(path);
    } catch {
      occupied = false;
    }
    if (occupied) throw new StaleWorktreeError(workerId, path);

    const branch = workerBranch(loaded.config.run.branch_prefix, run.runId, workerId);
    const remoteName = workerRemoteName(workerId);

    // `--single-branch` keeps the clone to the one ref a worker needs; it does
    // NOT prevent creating a branch afterwards (verified — `switch -c`
    // succeeds and HEAD is unchanged). `--no-hardlinks` is the safety flag;
    // see the module header.
    const cloned = await runGit(repo, [
      "clone",
      "--no-hardlinks",
      "--single-branch",
      "--branch",
      base.branch,
      repo,
      path,
    ]);
    if (cloned.code !== 0) throw new WorktreeError(`git clone into ${path}`, cloned);

    /**
     * From here the checkout exists on disk. Everything below either
     * finishes and is RECORDED via `onCreated`, or is rolled back before the
     * error propagates — the same argument this function's own docstring
     * makes for `onCreated` firing per-worker, one level down: a clone
     * abandoned mid-setup is invisible to `down --prune`, which reaps by
     * RECORD, and blocks every later `up` at this exact path with
     * `StaleWorktreeError`, whose own message points the operator at the one
     * command that cannot see it. The branch-name preflight above removes
     * the likeliest cause of a failure landing here; this is the backstop
     * for the others (disk full, a concurrent `up` racing this same repo,
     * anything `registerWorkerRemote`'s retry budget does not absorb).
     */
    let replacedStale = false;
    let baseSha = "";
    try {
      const switched = await runGit(path, ["switch", "-c", branch]);
      if (switched.code !== 0) throw new WorktreeError(`git switch -c ${branch} in ${path}`, switched);

      const unremoted = await runGit(path, ["remote", "remove", "origin"]);
      if (unremoted.code !== 0) throw new WorktreeError(`git remote remove origin in ${path}`, unremoted);

      // `remote remove` clears `.git/config`, but `git clone` ALSO writes
      // "clone: from <absolute source path>" into `.git/logs/HEAD` and
      // `.git/logs/refs/heads/<base branch>` — both inside the mount, both
      // readable by the worker, and NEITHER touched by removing the remote.
      // The line also carries the operator's committer identity (name and
      // host, from `user.name`/gecos) via the reflog's actor field. Deleted
      // wholesale rather than edited: a disposable clone whose history
      // starts at the base sha has no use for its own reflog, and
      // `core.logAllRefUpdates` defaults on for a non-bare repository, so
      // git recreates `logs/HEAD` and `logs/refs/heads/<branch>` fresh — with
      // no reference to the source path or the operator — on the worker's
      // very first ref update.
      await rm(join(path, ".git", "logs"), { recursive: true, force: true });

      const registered = await registerWorkerRemote(repo, remoteName, path);
      replacedStale = registered.replacedStale;

      // Read back rather than trusting `base.sha`: this is the commit the
      // clone ACTUALLY landed on, and it is the floor `down --prune`
      // measures work against. The two agree in every normal case, and when
      // they do not the recorded value must describe the tree that exists.
      const head = await runGit(path, ["rev-parse", "HEAD"]);
      if (head.code !== 0) throw new WorktreeError(`rev-parse HEAD in ${path}`, head);
      baseSha = head.stdout.trim();
    } catch (err) {
      await rm(path, { recursive: true, force: true });
      // Best-effort: `registerWorkerRemote` may never have run, in which case
      // this is "No such remote" and harmless; a failure here must not mask
      // the original error.
      await runGitWithConfigLockRetry(repo, ["remote", "remove", remoteName]);
      throw err;
    }

    const record: WorkerWorktree = {
      workerId,
      path,
      branch,
      baseSha,
      remoteName,
      // Empty until `up` calls `captureWorktreeBaseline` after hazard
      // neutralization — this module has no reason to know about hazards.
      baselineStatus: "",
    };
    created.push(record);
    if (opts.onCreated) await opts.onCreated(record, { replacedStaleRemote: replacedStale });
  }
  return created;
}

/**
 * Snapshot `git status --porcelain` as the WORKING-TREE baseline `down
 * --prune` and `pifleet worktrees` measure "this clone holds work" against,
 * alongside `baseSha` for commit history.
 *
 * Called once, by `up`, AFTER hazard neutralization finishes — never by
 * `createWorkerWorktrees` itself, which has no reason to know about hazards.
 * Quarantine (`security/repo-hazards.ts`) neutralizes a tracked hazard file
 * by RENAME, which is real, uncommitted change in `git status --porcelain`
 * the instant it happens — so without this, a clone of ANY repository with a
 * root `AGENTS.md`/`CLAUDE.md` reads as dirty from the moment `up` finishes,
 * before the worker has done anything at all.
 *
 * Committing the change instead was considered and rejected. No git identity
 * is configured in this module's hermetic environment — `runGit`'s
 * `HERMETIC_GIT_ENV` sets `HOME=/dev/null` and blanks both config scopes —
 * so a commit would fail outright; and even with an identity, a synthetic
 * pifleet commit ahead of `baseSha` would itself register as "1 commit
 * ahead" in `inspectCloneDirt` below, moving the exact same false positive
 * from the working tree into history, and would pollute the exact-diff
 * equality ISC-90 expects between a worker's reported diff and `git diff` on
 * its own branch. A recorded STATUS baseline generalizes to every present
 * and future hazard-neutralization shape (rename, in-place edit, whatever
 * `repo-hazards.ts` grows next) without this module ever enumerating them,
 * because `inspectCloneDirt` compares against whatever this actually
 * captured rather than assuming empty.
 */
export async function captureWorktreeBaseline(wt: WorkerWorktree): Promise<WorkerWorktree> {
  const status = await runGit(wt.path, ["status", "--porcelain"]);
  if (status.code !== 0) throw new WorktreeError(`git status in ${wt.path}`, status);
  return { ...wt, baselineStatus: status.stdout };
}

// ---------------------------------------------------------------------------
// Pruning (SRD §9.3)
// ---------------------------------------------------------------------------

/** Why one clone was or was not removed. One line per worker, always produced. */
export interface PruneOutcome {
  workerId: string;
  path: string;
  pruned: boolean;
  /** Present tense, operator-facing; `down` prints it verbatim. */
  reason: string;
}

/**
 * What "dirty" means for a disposable clone with no upstream to compare
 * against — stated here because the SRD's "never force-removes a dirty
 * worktree without `--force`" was written for a linked worktree that had a
 * parent to diff against, and this one has neither a remote nor an upstream.
 *
 * Two independent conditions, because there are two independent ways work
 * lives in a clone and deleting it destroys both:
 *
 *  1. `git status --porcelain` is non-empty — uncommitted edits, staged
 *     changes, or untracked files. Untracked counts: a worker that wrote a new
 *     file and never added it has still done work.
 *  2. `HEAD` has moved past the recorded `baseSha` — commits that exist
 *     NOWHERE else. `origin` was stripped at creation and no push target was
 *     ever configured, so unlike an ordinary clone there is no "it is safe,
 *     it is upstream" case to fall through to. This is what `baseSha` is
 *     recorded for.
 */
export interface DirtyState {
  dirty: boolean;
  statusLines: number;
  commitsAhead: number;
}

export async function inspectCloneDirt(wt: WorkerWorktree): Promise<DirtyState> {
  const status = await runGit(wt.path, ["status", "--porcelain"]);
  if (status.code !== 0) throw new WorktreeError(`git status in ${wt.path}`, status);
  // Compared against the recorded BASELINE, not against empty. `up`'s own
  // hazard neutralization (`security/repo-hazards.ts`) renames a tracked
  // file the instant it runs, which is real, uncommitted change in
  // `git status --porcelain` from that moment on — so without a baseline,
  // every clone of a repository with a root `AGENTS.md`/`CLAUDE.md` reads as
  // dirty from birth, and `down --prune` refuses every worker on an entirely
  // ordinary repository without `--force`. `wt.baselineStatus` is empty for
  // a checkout nothing has baselined (identical to the old always-empty
  // assumption, so a caller that never calls `captureWorktreeBaseline` sees
  // no change in behaviour); `captureWorktreeBaseline` sets it to whatever
  // `up` actually produced. See that function's own docstring for why a
  // status snapshot generalizes over trying to filter known artifact shapes.
  const currentLines = new Set(status.stdout.split("\n").filter((l) => l.trim() !== ""));
  const baselineLines = new Set(wt.baselineStatus.split("\n").filter((l) => l.trim() !== ""));
  const statusLines =
    [...currentLines].filter((l) => !baselineLines.has(l)).length +
    [...baselineLines].filter((l) => !currentLines.has(l)).length;

  const ahead = await runGit(wt.path, ["rev-list", "--count", `${wt.baseSha}..HEAD`]);
  // A base commit the clone no longer contains (history rewritten by the
  // worker) is not "clean" — it is a tree whose relationship to its floor
  // cannot be established, and treating an unanswerable question as a
  // negative answer is the mistake `deriveGitFacts` documents at length. That
  // is also why a SUCCESSFUL but unparseable count (`Number(...)` is `NaN`)
  // must not fall through `NaN || 0` to the literal `0` — a genuinely
  // undetermined ahead-count silently reading as "zero commits ahead" is the
  // exact same mistake with an extra step, and `rev-list --count` failing
  // outright is handled one line below by the same `POSITIVE_INFINITY`.
  const aheadCount = Number(ahead.stdout.trim());
  const commitsAhead = ahead.code === 0 && !Number.isNaN(aheadCount) ? aheadCount : Number.POSITIVE_INFINITY;
  return { dirty: statusLines > 0 || commitsAhead > 0, statusLines, commitsAhead };
}

/**
 * Remove one worker's clone and the parent-side remote pointing at it.
 *
 * The remote goes FIRST. A remote whose directory is gone makes every later
 * `git fetch --all` in the operator's own repository fail, and that is a
 * failure they will meet long after they have forgotten this run; a directory
 * whose remote is gone is merely an orphan. Ordering the recoverable failure
 * last is the same reasoning `down` applies to destroying panes after
 * processes.
 *
 * A missing directory is still a successful prune, not an error: `down` is the
 * command that makes a run's leftovers go away, and it must be runnable twice.
 */
export async function pruneWorkerWorktree(opts: {
  repo: string;
  worktree: WorkerWorktree;
  force: boolean;
}): Promise<PruneOutcome> {
  const { repo, worktree: wt, force } = opts;
  const base = { workerId: wt.workerId, path: wt.path };

  // The recorded path is not container-writable — `run.json` is host-side —
  // but it IS operator-editable, and this is the one place in the module
  // that runs a RECURSIVE delete off a value read back from disk rather than
  // computed from `workerWorktree(repo, id)`. A hand-edited or truncated
  // `run.json` must not turn `--force` into an unbounded `rm -rf`; refused as
  // a normal prune outcome, not a thrown error, for the same "runnable twice"
  // reason a missing directory is not an error either.
  if (!resolvedWithin(join(repo, ".worktrees"), wt.path)) {
    return {
      ...base,
      pruned: false,
      reason: `run.json records this checkout at ${wt.path}, which is outside ${join(repo, ".worktrees")}; refusing to delete it`,
    };
  }

  let present = true;
  try {
    await lstat(wt.path);
  } catch {
    present = false;
  }

  if (present && !force) {
    const dirt = await inspectCloneDirt(wt);
    if (dirt.dirty) {
      const ahead =
        dirt.commitsAhead === Number.POSITIVE_INFINITY
          ? `base sha ${wt.baseSha.slice(0, 12)} is no longer in this history`
          : `${dirt.commitsAhead} commit(s) past ${wt.baseSha.slice(0, 12)}`;
      return {
        ...base,
        pruned: false,
        reason:
          `holds work that exists nowhere else ` +
          `(${dirt.statusLines} uncommitted path(s), ${ahead}); ` +
          `fetch it with \`git -C ${repo} fetch ${wt.remoteName}\` or re-run with --force`,
      };
    }
  }

  const removedRemote = await runGitWithConfigLockRetry(repo, ["remote", "remove", wt.remoteName]);
  // Exit non-zero here is almost always "No such remote", which is the state
  // this call is trying to reach. It is recorded in the reason rather than
  // raised: refusing to delete a directory because a remote was already gone
  // would make `down --prune` un-rerunnable.
  const remoteNote = removedRemote.code === 0 ? "remote removed" : "remote already absent";

  if (present) await rm(wt.path, { recursive: true, force: true });
  return {
    ...base,
    pruned: true,
    reason: present ? `${remoteNote}; checkout deleted` : `${remoteNote}; checkout already absent`,
  };
}
