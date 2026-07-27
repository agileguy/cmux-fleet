/**
 * The acceptance runner — independence is the entire point (ISC-148..152).
 *
 * "Independently re-run the tests" sounds independent and is not. The command
 * string resolves through `package.json` scripts, `conftest.py`, `.git/hooks`
 * and the Makefile — every one of which sits inside the worker's mutable
 * surface — so a naive re-run grades the worker using the worker's own
 * harness. Independence is a property of WHERE and FROM WHICH TREE the command
 * is resolved and executed, not of WHO runs it (ISA changelog, 2026-07-27).
 *
 * Three mechanisms, one per attack:
 *
 * 1. **Command text resolves from the base SHA** (ISC-148). `resolveFromTree`
 *    reads via `git show <base>:<path>` — the object store, never a checkout —
 *    and `resolveFromEnvelope` carries text authored at dispatch. Both refuse
 *    a symbolic ref for `resolved_from`: "HEAD" would resolve through the
 *    worker's tree, which is the exact bug this module exists to prevent.
 *
 * 2. **Execution happens in a fresh clone by SHA, outside the worker's
 *    worktree, with no inherited environment** (ISC-149). A clone transfers
 *    committed objects only: no dirty files, no pre-seeded `node_modules`, no
 *    `.git/hooks` (hooks are never cloned), no cache that makes a red suite
 *    green. The environment is built from a literal — never `...process.env` —
 *    and commands are spawned as argv arrays, never shell strings, so there is
 *    no expansion surface at all.
 *
 * 3. **A timed-out command is `timed_out`, never `failed`** (ISC-152). Running
 *    out of wall clock proves nothing about the code; collapsing it into
 *    failure invents evidence. The adjudicator maps it to `unknown`.
 *
 * What this module deliberately does NOT do: decide a verdict. It produces
 * `AcceptanceRun[]` facts and an `AcceptanceContext` audit record; weighing
 * them against the diff and the worker's claim is `adjudicate.ts`'s job.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  AcceptanceContextSchema,
  AcceptanceRunSchema,
  HarnessSurfaceSchema,
  type AcceptanceContext,
  type AcceptanceRun,
  type HarnessSurface,
} from "../contracts.ts";
import { Deadline, Stopwatch, isoNow } from "../util/clock.ts";

// ---------------------------------------------------------------------------
// Harness surface (ISC-150)
// ---------------------------------------------------------------------------

/**
 * Default globs for the test-harness surface — the files through which an
 * acceptance command's MEANING resolves, as opposed to the code it grades.
 *
 * A worker whose diff touches any of these has produced an unfalsifiable
 * claim: even a fresh clone at its head runs harness code the worker wrote.
 * The verdict is then capped (see `adjudicate.ts`); this list only decides
 * what counts as harness.
 *
 * These defaults belong in the config schema; that file is owned elsewhere,
 * so they live here as the exported fallback until the wiring lands. Both
 * bare and `**`-prefixed forms are listed so a root-level match does not
 * depend on any one glob engine's zero-segment `**` behavior.
 */
export const DEFAULT_HARNESS_PATTERNS: readonly string[] = [
  // Test trees and test files.
  "test/**",
  "tests/**",
  "__tests__/**",
  "spec/**",
  "*.test.*",
  "**/*.test.*",
  "*.spec.*",
  "**/*.spec.*",
  // Command resolution: scripts, tasks, lockfiles.
  "package.json",
  "**/package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "Makefile",
  "**/Makefile",
  "makefile",
  "GNUmakefile",
  "justfile",
  "Taskfile.yml",
  // Python harness resolution.
  "conftest.py",
  "**/conftest.py",
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "pyproject.toml",
  // JS/TS runner configuration.
  "jest.config.*",
  "vitest.config.*",
  "playwright.config.*",
  "karma.conf.*",
  "tsconfig.json",
  // CI definitions and hook trees a repo can point `core.hooksPath` at.
  ".github/workflows/**",
  ".githooks/**",
  "scripts/test*",
] as const;

/**
 * Which of the worker's changed files fall on the harness surface.
 *
 * Pure set intersection over globs: the caller supplies the repo-relative
 * changed paths from the derived diff (never from the envelope — the envelope
 * is the actor being graded, and a worker that edited a test would simply
 * not list it).
 */
export function harnessSurface(
  changedFiles: readonly string[],
  patterns: readonly string[] = DEFAULT_HARNESS_PATTERNS,
): HarnessSurface {
  const globs = patterns.map((p) => new Bun.Glob(p));
  const touched = changedFiles.filter((f) => globs.some((g) => g.match(f)));
  return HarnessSurfaceSchema.parse({ patterns: [...patterns], touched });
}

// ---------------------------------------------------------------------------
// Command resolution (ISC-148)
// ---------------------------------------------------------------------------

/** An acceptance command with its provenance pinned. */
export interface ResolvedCommand {
  cmd: string;
  source: "envelope" | "tree";
  /** Full SHA the text was resolved from. Never a symbolic ref. */
  resolved_from: string;
}

const SHA40_RE = /^[0-9a-f]{40}$/;

/**
 * Refuse anything but a full SHA. A symbolic ref ("HEAD", a branch name)
 * resolves through whatever tree git happens to be looking at — which for a
 * harvester pointed at the worker's repo is the worker's tree. That is not a
 * hypothetical: it is the precise failure ISC-148 exists to name.
 */
function requireSha40(sha: string, what: string): void {
  if (!SHA40_RE.test(sha)) {
    throw new Error(`${what} must be a full 40-char SHA, got ${JSON.stringify(sha)}`);
  }
}

/**
 * Commands authored at dispatch time, in the task envelope's `acceptance[]`.
 *
 * The envelope here is the TASK envelope the fleet wrote, not the result
 * envelope the worker wrote — the text predates the worker's first keystroke,
 * which is what makes it safe. `resolved_from` records the task's base SHA so
 * the provenance is auditable alongside tree-resolved commands.
 */
export function resolveFromEnvelope(
  commands: readonly string[],
  baseSha: string,
): ResolvedCommand[] {
  requireSha40(baseSha, "resolveFromEnvelope base");
  return commands.map((cmd) => ({ cmd, source: "envelope", resolved_from: baseSha }));
}

/**
 * Commands read from a file IN THE REPO AT THE BASE SHA.
 *
 * `git show <sha>:<path>` reads the object store: it cannot see the working
 * tree, the index, or anything the worker committed after base. A worker that
 * rewrites the acceptance file on its branch changes what `<head>:<path>`
 * says and changes nothing about what this function returns.
 *
 * Format: one command per line; blank lines and `#` comments ignored.
 */
export async function resolveFromTree(
  repo: string,
  baseSha: string,
  path: string,
  env?: Readonly<Record<string, string>>,
): Promise<ResolvedCommand[]> {
  requireSha40(baseSha, "resolveFromTree base");
  const r = await execBounded(
    ["git", "-C", resolve(repo), "show", `${baseSha}:${path}`],
    resolve(repo),
    buildEnv(env, resolve(repo)),
    GIT_TIMEOUT_MS,
  );
  if (r.timedOut || r.exit !== 0) {
    throw new Error(`git show ${baseSha.slice(0, 12)}:${path} failed: ${r.excerpt}`);
  }
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((cmd) => ({ cmd, source: "tree" as const, resolved_from: baseSha }));
}

// ---------------------------------------------------------------------------
// Tokenization — argv arrays, never shell strings
// ---------------------------------------------------------------------------

/** A command this runner refuses to execute, with the reason attached. */
export class CommandParseError extends Error {
  constructor(cmd: string, why: string) {
    super(`unrunnable acceptance command ${JSON.stringify(cmd)}: ${why}`);
    this.name = "CommandParseError";
  }
}

/**
 * Split a command string into argv, honoring single and double quotes.
 *
 * There is no shell anywhere in this path, on purpose: a shell means `$(...)`,
 * backticks, redirects and pipes — an expansion surface fed by text that
 * ultimately crosses the worker's boundary. Metacharacters OUTSIDE quotes are
 * therefore refused loudly rather than passed through as literal argv (which
 * would run something the author did not intend, silently). A criterion that
 * genuinely needs a shell belongs in a script committed at the base SHA.
 *
 * Inside quotes, everything is literal — there is no expansion here, so `$`
 * in a quoted argument is just a byte.
 */
export function tokenize(cmd: string): string[] {
  const META = new Set(["|", "&", ";", "<", ">", "`", "$", "(", ")", "\\", "*", "?", "~"]);
  const argv: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | '"' | null = null;

  for (const ch of cmd) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) {
        argv.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    if (META.has(ch)) {
      throw new CommandParseError(cmd, `shell metacharacter '${ch}' outside quotes (no shell is ever invoked; commit a script at the base SHA instead)`);
    }
    cur += ch;
    started = true;
  }
  if (quote !== null) throw new CommandParseError(cmd, "unclosed quote");
  if (started) argv.push(cur);
  if (argv.length === 0) throw new CommandParseError(cmd, "empty command");
  return argv;
}

// ---------------------------------------------------------------------------
// Execution (ISC-149, ISC-152)
// ---------------------------------------------------------------------------

export interface AcceptanceSpec {
  /** Path of the repository to clone FROM (the worker's worktree is fine — clone reads objects, not files). */
  repo: string;
  /** The committed code being graded; checked out detached in the fresh clone. */
  head_sha: string;
  /** Where the fresh clone is created. MUST be outside the worker's worktree. */
  scratch_dir: string;
  commands: readonly ResolvedCommand[];
  /** The run's overall budget; per-command timeouts are bounded by it. */
  deadline: Deadline;
  per_command_timeout_ms: number;
  /**
   * Extra environment, merged over the built-in minimal one. This is the ONLY
   * way any variable reaches an acceptance command — nothing is ever read
   * from `process.env` (ISC-149; `inherited_env: false` is recorded because
   * it is true by construction).
   */
  env?: Readonly<Record<string, string>>;
}

export interface AcceptanceResult {
  context: AcceptanceContext;
  runs: AcceptanceRun[];
}

/** Search path for the hermetic environment. Callers extend via `spec.env`. */
const DEFAULT_ENV_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";

/** Budget for each git plumbing step (clone, checkout, show). */
const GIT_TIMEOUT_MS = 120_000;

/** Longest excerpt kept per command; the tail, where failures usually speak. */
const EXCERPT_MAX = 4_096;

/**
 * Environment built from a literal. `HOME` points into scratch so git cannot
 * read `~/.gitconfig`, and the two `GIT_CONFIG_*` pins close the remaining
 * config doors. Nothing here came from this process's environment.
 */
function buildEnv(
  extra: Readonly<Record<string, string>> | undefined,
  home: string,
): Record<string, string> {
  return {
    PATH: DEFAULT_ENV_PATH,
    HOME: home,
    LC_ALL: "C",
    TERM: "dumb",
    CI: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

/**
 * Run every resolved command in a fresh clone of `repo` at `head_sha`.
 *
 * Failure posture: a clone or checkout that cannot be completed yields every
 * command as `not_run` — the harvester has NO evidence, and `not_run`
 * adjudicates to `unknown`. Faking `failed` here would punish the worker for
 * the grader's infrastructure; faking `passed` is unthinkable. The runner
 * refuses to grade, which is the only honest option left.
 */
export async function runAcceptance(spec: AcceptanceSpec): Promise<AcceptanceResult> {
  requireSha40(spec.head_sha, "runAcceptance head");
  if (!Number.isInteger(spec.per_command_timeout_ms) || spec.per_command_timeout_ms <= 0) {
    throw new Error(`per_command_timeout_ms must be a positive integer, got ${spec.per_command_timeout_ms}`);
  }

  const repoAbs = resolve(spec.repo);
  const scratchAbs = resolve(spec.scratch_dir);

  // ISC-149: the clone lives OUTSIDE the worker's worktree. A clone inside it
  // would be reachable by the worker's own globs and — worse — could be
  // clobbered by backgrounded work that kept writing after quiesce. Checked
  // before any filesystem access so a bad spec cannot half-execute.
  const rel = relative(repoAbs, scratchAbs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(
      `scratch_dir ${scratchAbs} is inside the worker tree ${repoAbs}; the fresh clone must live outside it (ISC-149)`,
    );
  }

  // Unique per invocation so a re-harvest cannot collide with a prior clone.
  const nonce = createHash("sha256").update(`${isoNow()}-${Math.random()}`).digest("hex").slice(0, 8);
  const cloneDir = join(scratchAbs, `accept-${spec.head_sha.slice(0, 12)}-${nonce}`);
  const env = buildEnv(spec.env, scratchAbs);

  const context = AcceptanceContextSchema.parse({
    clone_path: cloneDir,
    clone_sha: spec.head_sha,
    inherited_env: false,
    image: null,
    timeout_s: Math.ceil(spec.per_command_timeout_ms / 1000),
  });

  await mkdir(scratchAbs, { recursive: true });

  // Fresh clone by SHA. `--no-checkout` then a detached checkout of the exact
  // SHA: a plain clone checks out the default branch, which is not what is
  // being graded. A local clone transfers committed objects only — no dirty
  // files, no hooks, no caches — which is the entire point.
  const clone = await execBounded(
    ["git", "clone", "--quiet", "--no-checkout", repoAbs, cloneDir],
    scratchAbs,
    env,
    spec.deadline.boundedBy(GIT_TIMEOUT_MS),
  );
  if (clone.timedOut || clone.exit !== 0) {
    return { context, runs: allNotRun(spec.commands, `fresh clone failed: ${clone.excerpt}`) };
  }
  const checkout = await execBounded(
    ["git", "-C", cloneDir, "checkout", "--quiet", "--detach", spec.head_sha],
    cloneDir,
    env,
    spec.deadline.boundedBy(GIT_TIMEOUT_MS),
  );
  if (checkout.timedOut || checkout.exit !== 0) {
    return { context, runs: allNotRun(spec.commands, `checkout ${spec.head_sha.slice(0, 12)} failed: ${checkout.excerpt}`) };
  }

  const runs: AcceptanceRun[] = [];
  for (const rc of spec.commands) {
    runs.push(await runOne(rc, cloneDir, env, spec));
  }
  return { context, runs };
}

async function runOne(
  rc: ResolvedCommand,
  cloneDir: string,
  env: Record<string, string>,
  spec: AcceptanceSpec,
): Promise<AcceptanceRun> {
  // `boundedBy` is why a per-command timeout cannot outlive the run's budget:
  // ten 30-second commands under a 60-second run get 60 seconds total, not 300.
  const timeoutMs = spec.deadline.boundedBy(spec.per_command_timeout_ms);
  if (timeoutMs <= 0) {
    return notRun(rc, "run budget exhausted before this command started");
  }

  let argv: string[];
  try {
    argv = tokenize(rc.cmd);
  } catch (e) {
    // Unrunnable is not the same as failing: nothing executed, so nothing was
    // proven about the code. `not_run` adjudicates to `unknown`.
    return notRun(rc, e instanceof Error ? e.message : String(e));
  }

  const r = await execBounded(argv, cloneDir, env, timeoutMs);
  return AcceptanceRunSchema.parse({
    cmd: rc.cmd,
    source: rc.source,
    resolved_from: rc.resolved_from,
    // ISC-152: `timed_out` is its own outcome, never folded into `failed`.
    outcome: r.timedOut ? "timed_out" : r.exit === 0 ? "passed" : "failed",
    exit_code: r.timedOut ? null : r.exit,
    duration_ms: Math.round(r.durationMs),
    excerpt: r.excerpt,
  });
}

function notRun(rc: ResolvedCommand, why: string): AcceptanceRun {
  return AcceptanceRunSchema.parse({
    cmd: rc.cmd,
    source: rc.source,
    resolved_from: rc.resolved_from,
    outcome: "not_run",
    exit_code: null,
    duration_ms: 0,
    excerpt: why.slice(0, EXCERPT_MAX),
  });
}

function allNotRun(commands: readonly ResolvedCommand[], why: string): AcceptanceRun[] {
  return commands.map((rc) => notRun(rc, why));
}

interface ExecResult {
  exit: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  /** Tail of stdout+stderr, capped at EXCERPT_MAX. */
  excerpt: string;
}

/**
 * Spawn argv with an explicit environment and a hard wall-clock bound.
 *
 * Streams are consumed concurrently with the exit wait — a pipe left undrained
 * deadlocks any command whose output exceeds the kernel buffer, and a test
 * suite's output routinely does. The timer SIGKILLs rather than SIGTERMs:
 * this process's judgment of the command is already "timed out", and a
 * graceful shutdown cannot improve it, only delay the harvest.
 *
 * A spawn that cannot start at all (binary absent from the hermetic PATH)
 * reports `not started` via `exit: null` without `timedOut` — the caller maps
 * it to `not_run`, because nothing about the code was proven.
 */
async function execBounded(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ExecResult> {
  const sw = new Stopwatch();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({ cmd: argv, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return {
      exit: null,
      timedOut: false,
      durationMs: sw.elapsedMs(),
      stdout: "",
      excerpt: `spawn failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, EXCERPT_MAX),
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited between the timer firing and the kill: outcome is
      // decided by `timedOut` either way.
    }
  }, Math.max(1, timeoutMs));

  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const combined = stdout + (stderr.length > 0 ? `\n${stderr}` : "");
  return {
    exit: timedOut ? null : exit,
    timedOut,
    durationMs: sw.elapsedMs(),
    stdout,
    excerpt: combined.slice(-EXCERPT_MAX),
  };
}
