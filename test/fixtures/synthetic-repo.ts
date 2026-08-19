/**
 * Synthetic git repositories for tests — built by `git init`, never cloned.
 *
 * **Every test fixture that needs a git repository must come from here.**
 *
 * The rule this module exists to make unbreakable: a test must never use `git
 * clone` or `git worktree add` with THIS PROJECT'S repository as the source,
 * not even for a "throwaway" fixture. `git clone` from a local path defaults
 * to `--local`, which HARDLINKS the source's object files into the clone — one
 * inode, two names. A test that then writes into what it believes is a
 * disposable copy is writing into the real repository's object store, and a
 * test that deliberately CORRUPTS one (which is exactly the kind of test this
 * feature warrants) corrupts the real repository. That is not a hypothetical
 * failure mode: it is how the spike investigating per-worker isolation
 * destroyed this repository's pack file before the feature was written.
 *
 * `run/worktree.ts` passes `--no-hardlinks` for the same reason, and the test
 * that pins that flag is the one with the strongest need for a fixture that
 * cannot reach the real repository — so the safe construction is the only one
 * offered here.
 *
 * The same discipline `test/unit/materialize.test.ts` applies to `skills/`,
 * where `skillSourceRoot()` builds synthetic bundles in a temp directory
 * rather than reading the repository's real ones. One layer down, same rule.
 */

import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Does anything exist at `path` — file, directory, or dangling symlink?
 *
 * `Bun.file(p).exists()` answers FALSE for a directory, which makes it a
 * silent trap in exactly the assertions this feature needs most: every
 * "nothing was created behind that refusal" check is about a DIRECTORY, and
 * written with `Bun.file` it passes whether the directory is there or not.
 * Caught here by a fixture assertion that failed for the opposite reason —
 * `expect(exists(clonePath)).toBe(true)` on a clone that was demonstrably on
 * disk — which is the only way a trivially-passing negative ever surfaces.
 *
 * `lstat`, not `stat`, so a dangling symlink counts as occupancy: that is what
 * `run/worktree.ts`'s own stale-directory check uses, and a test asking a
 * weaker question than the code would not pin it.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A hermetic environment for every git spawn in a fixture.
 *
 * Built from a literal rather than from `process.env` for the reason
 * `harvest/git.ts` states about `HERMETIC_GIT_ENV`: the developer's own
 * `~/.gitconfig` must not decide what a test observes. A `commit.gpgsign =
 * true` or an `init.defaultBranch` in a real config would make these fixtures
 * behave differently on one machine than another, which is the class of
 * flakiness that gets a test deleted rather than fixed.
 */
export const FIXTURE_GIT_ENV: Readonly<Record<string, string>> = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
  HOME: "/dev/null",
  LC_ALL: "C",
  TERM: "dumb",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "pifleet fixture",
  GIT_AUTHOR_EMAIL: "fixture@pifleet.invalid",
  GIT_COMMITTER_NAME: "pifleet fixture",
  GIT_COMMITTER_EMAIL: "fixture@pifleet.invalid",
};

export interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn git in `cwd`. Argv array in, decoded streams out — no shell, ever. */
export async function git(cwd: string, ...args: string[]): Promise<GitRun> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...FIXTURE_GIT_ENV },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

/** Same, but a non-zero exit throws with git's own stderr — for fixture SETUP. */
export async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) {
    throw new Error(`fixture: git ${args.join(" ")} in ${cwd} exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

export interface SeedOptions {
  /** Initial branch. Fixed rather than inherited so `init.defaultBranch` cannot change a test. */
  branch?: string;
  /** Files written and committed in the first commit, keyed by repo-relative path. */
  files?: Record<string, string>;
  /** Extra commits, each a batch of files; every batch becomes one commit. */
  commits?: Array<Record<string, string>>;
}

/**
 * Create a repository at `dir` with at least one commit, and return its HEAD.
 *
 * Always at least one commit: a repository with no commits has no HEAD to
 * resolve, no branch to clone from, and `symbolic-ref HEAD` succeeds while
 * `rev-parse HEAD` fails — a shape that makes a fixture fail in the setup
 * rather than in the assertion, where the failure is legible.
 */
export async function seedGitRepo(dir: string, opts: SeedOptions = {}): Promise<string> {
  const branch = opts.branch ?? "main";
  await mkdir(dir, { recursive: true });
  await gitOk(dir, "init", "-q", "-b", branch);

  const first = opts.files ?? { "README.md": "# synthetic fixture\n" };
  await writeFiles(dir, first);
  await gitOk(dir, "add", "-A");
  await gitOk(dir, "commit", "-q", "-m", "seed");

  for (const [i, batch] of (opts.commits ?? []).entries()) {
    await writeFiles(dir, batch);
    await gitOk(dir, "add", "-A");
    await gitOk(dir, "commit", "-q", "-m", `seed ${i + 2}`);
  }
  return gitOk(dir, "rev-parse", "HEAD");
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}
