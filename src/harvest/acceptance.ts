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
import {
  MOUNT_SHARING_HINT,
  probeMountVisibility,
  widenTreeForWorker,
} from "../container/mounts.ts";
import type { Exec } from "../container/run.ts";
import { Deadline, Stopwatch, isoNow } from "../util/clock.ts";
import {
  acceptanceContainerArgv,
  acceptanceContainerEnv,
  acceptanceContainerName,
  reapAcceptanceContainer,
} from "./acceptance-container.ts";
import { HERMETIC_GIT_ENV, hardenedGitArgv } from "./git.ts";

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
 * These are the FALLBACK, not the source of truth (ISC-232): `fleet.yaml`'s
 * `harness.patterns` replaces this list outright when it is set, and the
 * defaults are what a config that says nothing gets. The list stays here
 * rather than in the config schema because it is the matcher's contract —
 * `harnessSurface` must have a defined surface with no config in reach, as
 * it does when `artifacts` reads a run whose config is long gone.
 *
 * Both bare and `**`-prefixed forms are listed so a root-level match does
 * not depend on any one glob engine's zero-segment `**` behavior.
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
  // Runner configuration that executes code BEFORE any test does.
  //
  // `bunfig.toml` was the hole this list was found through: it is the config
  // for `bun test` — the runner this repository itself uses — and its
  // `[test] preload` names a module executed ahead of every test file. A
  // worker committing a `bunfig.toml` plus a preload script turned a red
  // suite green while the implementation stayed wrong, and because neither
  // file matched anything above, `harness.touched` came back empty and the
  // ISC-150 cap never fired. `.npmrc` (`node-options`), the yarn equivalents
  // and `deno.json` are the same primitive for the other runners.
  "bunfig.toml",
  "**/bunfig.toml",
  ".npmrc",
  "**/.npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "deno.json",
  "deno.jsonc",
  // Files the resolution above INHERITS from. `tsconfig.json` was listed but
  // `extends` makes any other tsconfig equally load-bearing, and a Makefile
  // `include` does the same for make. Matching only the entry point means the
  // entry point can keep its contents and change its meaning.
  "tsconfig.*.json",
  "**/tsconfig*.json",
  "*.mk",
  "**/*.mk",
  "Makefile.*",
  // Toolchain selection: changing WHICH interpreter runs the suite changes
  // what the suite proves, without touching a line of test code.
  ".mise.toml",
  ".tool-versions",
  ".nvmrc",
  // CI definitions and hook trees a repo can point `core.hooksPath` at.
  ".github/workflows/**",
  ".githooks/**",
  "scripts/test*",
  // Config that names CODE to execute. Classifying the config and not its
  // target leaves a one-hop indirection open: `jest.config.*` is matched, but
  // the `setupFiles` it points at was not, so the config could stay byte
  // identical while the code it runs was swapped.
  "jest.setup.*",
  "**/jest.setup.*",
  "vitest.workspace.*",
  "vitest.setup.*",
  ".mocharc.*",
  "**/.mocharc.*",
  ".pnpmfile.cjs",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  // Case and depth variants. Globs are case-sensitive and `test/**` had no
  // `**/` form, so `Tests/`, `TEST/` and `a/b/test/` were all misses — and
  // `Tests/` is an ordinary directory name, not an exotic one.
  "[Tt]est/**",
  "[Tt]ests/**",
  "TEST/**",
  "TESTS/**",
  "[Ss]pec/**",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/spec/**",
  "**/scripts/test*",
  // Python harness resolution at depth.
  "**/pytest.ini",
  "**/tox.ini",
  "**/setup.cfg",
  "**/pyproject.toml",
  "noxfile.py",
  // Make and task runners: case, extension and depth siblings.
  "**/makefile",
  "**/GNUmakefile",
  "[Jj]ustfile",
  ".justfile",
  "**/justfile",
  "Taskfile.yaml",
  // CI beyond GitHub workflows, including composite actions workflows call.
  ".github/actions/**",
  ".gitlab-ci.yml",
  ".circleci/config.yml",
  "Jenkinsfile",
  // Other ecosystems' build/test definitions.
  "go.mod",
  "Cargo.toml",
  "build.rs",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Rakefile",
] as const;

/**
 * The pattern list a config actually grades against (ISC-243).
 *
 * `harness.patterns` used to REPLACE the built-in defaults, and that was the
 * silent-disable path this criterion records: the surface an operator narrows
 * is the surface the ISC-150 cap reads, so `patterns: ["ci/**"]` — the first
 * thing someone writes when they want ONE more file covered — switched the cap
 * off for every diff that did not touch `ci/`. Measured on the live matcher:
 * with that list, a diff of `["src/app.ts", "package.json"]` carrying one
 * passing acceptance run certifies `success`, where the defaults cap it to
 * `unknown`.
 *
 * The asymmetry is what settles the default. Over-capping is LOUD — a run
 * comes back `unknown` and the operator goes looking. Under-capping is SILENT
 * — a red suite is certified green and nobody looks at all. So the default
 * extends, and replacement stays available under its own name for the operator
 * who genuinely means "start from nothing".
 *
 * Returns `null` for "no opinion", which is what `run.json` records when no
 * patterns are configured — preserved deliberately so a run that predates this
 * change and one that configures nothing are the same document.
 */
export function effectiveHarnessPatterns(harness: {
  patterns?: readonly string[] | undefined;
  replace?: boolean | undefined;
}): readonly string[] | null {
  const configured = harness.patterns;
  if (configured === undefined || configured.length === 0) return null;
  if (harness.replace === true) return [...configured];
  // Defaults FIRST, so a `report --config` line reads as "the built-ins, plus
  // what this config adds" in the order someone would say it aloud. Duplicates
  // are dropped rather than tolerated: `harnessSurface` compiles one Bun.Glob
  // per entry and a repeated glob is wasted work on every changed file.
  return [...new Set([...DEFAULT_HARNESS_PATTERNS, ...configured])];
}

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

/**
 * The harness surface as the HARVESTER must compute it: config when the
 * operator set it, the built-in defaults when they did not, and a record of
 * what the choice cost (ISC-232).
 *
 * This, not `harnessSurface`, is what `harvestTask` calls. The extra work is
 * the second surface: whenever `configured` is supplied, the defaults are run
 * over the same diff so the two can be compared. `patterns` REPLACES the
 * defaults — that is the documented semantics and it is the right one — but
 * replacement means any configured list that matches nothing in a particular
 * diff silently switches the ISC-150 cap off for that diff, and the realistic
 * way to get there is not malice. `patterns: ["ci/**"]` is the first thing an
 * operator who cares about CI files would write, and it quietly costs all ~91
 * defaults. `Bun.Glob` compiles malformed patterns and matches nothing with
 * them, so a typo lands in the same place with no error anywhere.
 *
 * The response is to make it VISIBLE, not to refuse it: narrowing is a
 * legitimate operator decision (a repo whose suites do not live under `test/`
 * needs it), so the surface still comes from config and the verdict still
 * follows from it. What changes is that the harvest now carries the files the
 * defaults would have flagged, and `adjudicate.ts` raises them as a
 * discrepancy, so "your harness config matched nothing here, but the defaults
 * would have caught something" reaches a human and a JSON consumer instead of
 * being certified in silence.
 *
 * An EMPTY `configured` list throws rather than falling back. It cannot come
 * from a valid `fleet.yaml` — `HarnessSchema` rejects it with an explanation —
 * so reaching here means a hand-edited `run.json` or a caller assembling
 * `HarvestOptions` directly, and for those `??`-style rescue to the defaults
 * would be the silent disable this function exists to prevent. Empty is a
 * config error everywhere, not just at the YAML boundary.
 */
export function harnessSurfaceFor(
  changedFiles: readonly string[],
  configured: readonly string[] | undefined,
): HarnessSurface {
  if (configured === undefined) return harnessSurface(changedFiles, DEFAULT_HARNESS_PATTERNS);
  if (configured.length === 0) {
    throw new Error(
      "harness.patterns is empty — an empty list would disable the ISC-150 " +
        "test-harness cap entirely rather than mean 'no opinion'. Omit the " +
        "harness key to get the built-in defaults.",
    );
  }
  const surface = harnessSurface(changedFiles, configured);
  // Only load-bearing when the config's narrowing is what stopped the cap
  // firing. If `touched` is non-empty the verdict is capped either way, and a
  // wider default surface would change nothing a reader could act on.
  if (surface.touched.length > 0) return surface;
  const byDefault = harnessSurface(changedFiles, DEFAULT_HARNESS_PATTERNS);
  return { ...surface, defaults_missed: byDefault.touched };
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
    hardenedGitArgv(resolve(repo), ["show", `${baseSha}:${path}`]),
    resolve(repo),
    gitEnv(env),
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
   *
   * Applies to the HOST path. On the container path (`container` below) the
   * environment is built by `acceptanceContainerEnv` instead and this is not
   * merged in, because the two run in different filesystems: `PATH` and `HOME`
   * that are correct on the operator's machine name directories the image does
   * not have. A caller that needs a variable inside the container is a change
   * to that builder, not a silent pass-through of laptop state into an exam.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Run each command in a FRESH CONTAINER from the worker's own image, rather
   * than as a host process (SRD §8.2, ISC-233).
   *
   * Absent means the host path, which is what a run launched against the
   * `PIFLEET_PI_COMMAND` double gets: no container ever started, so there is no
   * image to grade in and demanding one would refuse every test double in this
   * repo.
   */
  container?: AcceptanceContainerOptions;
}

export interface AcceptanceContainerOptions {
  /** The image the worker ran, read back out of its `launch.json`. */
  image: string;
  /** The network the worker ran on, or `null` for the daemon default. */
  network?: string | null;
  /**
   * Injection point for the ISC-277 visibility probe ONLY.
   *
   * The acceptance commands themselves always spawn for real, through
   * `execBounded`, because their timeout, excerpt and `timed_out`-vs-`failed`
   * handling is the thing under test everywhere else in this file and routing
   * them through a second exec abstraction would give the suite a path
   * production does not have. The probe is different: it is a yes/no question
   * about the host's mount sharing, and a unit test needs to ask it with the
   * answer NO without a daemon in reach — which is precisely the differential
   * ISC-277 asks for.
   */
  probeExec?: Exec;
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
 * Environment for the ACCEPTANCE COMMANDS — the graded test suites, not git.
 *
 * Built from a literal; nothing here came from this process's environment.
 * `HOME` points into scratch because a real test suite legitimately writes
 * there (caches, tool state), and it is outside the worker's worktree.
 *
 * This is deliberately NOT the environment the git plumbing runs under — see
 * `gitEnv` for why the two must not be the same object.
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
 * Environment for this module's git plumbing (`show`, `clone`, `checkout`),
 * shared verbatim with `harvest/git.ts` rather than assembled again here.
 *
 * These three spawns used to run under `buildEnv`, which differs from the
 * hermetic git environment in one way that matters: `resolveFromTree` passed
 * `HOME: resolve(repo)` — HOME pointed INTO the tree the graded worker writes
 * to. `GIT_CONFIG_GLOBAL=/dev/null` blocks `~/.gitconfig`, but the global
 * ATTRIBUTES file, `$HOME/.config/git/attributes`, has no `GIT_CONFIG_*`
 * equivalent. Verified against git 2.50.1: with HOME pointed at a repo, a
 * committed `.config/git/attributes` naming `diff=evil` IS honoured and the
 * repo-config `[diff "evil"] textconv` it names DOES execute.
 *
 * Today's `git show <sha>:<path>` does not itself request textconv, so the
 * chain stopped one link short of running anything — the probe fires under
 * `cat-file --textconv` and not under `show`. That is not a reason to leave it:
 * the difference between "inert" and "executes" was a flag on an argv this
 * module builds, and the whole history of this hardening is argv changing while
 * the hardening stayed behind. `core.attributesFile=/dev/null` in the shared
 * flag list closes it whichever subcommand is used (re-verified: with the
 * hardening applied, the forced-textconv probe no longer runs the driver).
 */
function gitEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  // `HERMETIC_GIT_ENV` spreads LAST, and any `GIT_*` key in `extra` is dropped
  // rather than merged.
  //
  // The previous order was `{ ...HERMETIC_GIT_ENV, ...extra }`, which let a
  // caller's env win. `extra` is `spec.env` — documented as environment for
  // the acceptance COMMANDS, not for the git spawns that stage them — so a
  // config supplying `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_GLOBAL` or
  // `GIT_ALTERNATE_OBJECT_DIRECTORIES` would silently undo the hardening on
  // the clone/checkout/show spawns, with no error and nothing in the ledger.
  // Unreachable today (nothing passes `env`), which is exactly when it is
  // cheapest to close: the reachable version of this is a config field that
  // turns the hardening off.
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!k.startsWith("GIT_")) safe[k] = v;
  }
  return { ...safe, ...HERMETIC_GIT_ENV };
}

/**
 * Environment for the docker CLIENT on the container path.
 *
 * Third environment in this module, and the third one is the least obvious, so
 * it is spelled out. `buildEnv` is for the graded commands and `gitEnv` is for
 * the plumbing that stages them; both are built from literals because anything
 * inherited from the operator's shell is a channel into the exam. The docker
 * client is plumbing too — it is the same category as `git clone` — but it has
 * one hard requirement a literal cannot supply: it has to be able to REACH a
 * daemon, and on this machine that is `DOCKER_HOST`, which Colima sets in the
 * operator's environment and which no default can be guessed for.
 *
 * So exactly the connection variables are forwarded, by name, and nothing
 * else. The list is short on purpose and each entry is a docker-CLI setting
 * rather than anything a test could read: none of them is passed to
 * `docker run`, so none of them reaches the container — the command's
 * environment is `acceptanceContainerEnv`, built from a literal like the other
 * two, and the `-e K=V` form supplies values rather than inheriting them
 * (ISC-31 forbids the bare `-e NAME` pass-through outright).
 */
function dockerClientEnv(): Record<string, string> {
  const out: Record<string, string> = {
    PATH: DEFAULT_ENV_PATH,
    LC_ALL: "C",
  };
  // `HOME` is on this list rather than blanked, and that is a correction of a
  // first attempt that blanked it. Docker's client config — `contexts/`,
  // `config.json`, any credential helper — lives at `$HOME/.docker`, and
  // Colima installs itself as a CONTEXT as readily as it exports
  // `DOCKER_HOST`. Blanking `HOME` therefore left the client with no way to
  // find the daemon on a perfectly ordinary setup, which would have surfaced
  // as every acceptance run coming back `not_run` on the maintainer's own
  // machine and nowhere else.
  for (const k of ["HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
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

  /**
   * `image` is the audit record's answer to "which environment graded this
   * code", and it was the literal `null` from the day this module shipped.
   * ISC-233's audit measured what that cost: mutating it to a plausible tag —
   * an audit record naming a container that never ran — left 104 tests across
   * four files green, because no assertion anywhere read the field. It is now
   * written from the thing that actually decides, one line below the branch
   * that decides it, and `acceptance-context.test.ts` reads it back on both
   * arms so the same mutation cannot pass again.
   */
  const context = AcceptanceContextSchema.parse({
    clone_path: cloneDir,
    clone_sha: spec.head_sha,
    inherited_env: false,
    image: spec.container?.image ?? null,
    timeout_s: Math.ceil(spec.per_command_timeout_ms / 1000),
  });

  // An already-exhausted budget is reported as what it is. Letting the clone
  // "run" with a zero timeout would report "clone failed" — blaming git for a
  // budget decision, which is exactly the kind of lying diagnosis that wastes
  // an hour later.
  if (spec.deadline.remainingMs() <= 0) {
    return {
      context,
      runs: allNotRun(spec.commands, "run budget exhausted before the fresh clone could be created"),
    };
  }

  await mkdir(scratchAbs, { recursive: true });

  // Fresh clone by SHA. `--no-checkout` then a detached checkout of the exact
  // SHA: a plain clone checks out the default branch, which is not what is
  // being graded. A local clone transfers committed objects only — no dirty
  // files, no hooks, no caches — which is the entire point.
  //
  // `--no-hardlinks` is load-bearing here too, not only in `run/worktree.ts`.
  // `repoAbs` is `spec.repo` — `envelope.host_workdir`, the WORKER's own
  // clone — and a local-path `git clone` defaults to `--local`, which
  // hardlinks object files into `cloneDir` rather than copying them. The
  // acceptance commands this function is about to run are worker-authored
  // (ISC-148..151's whole premise), and a hardlinked scratch clone means
  // anything one of those commands does through what looks like its own
  // private object file corrupts the WORKER's checkout's object store — the
  // same corruption class `run/worktree.ts`'s module header names, one clone
  // hop later, against the exact tree `report` is about to diff.
  const clone = await execBounded(
    hardenedGitArgv(scratchAbs, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", repoAbs, cloneDir]),
    scratchAbs,
    gitEnv(spec.env),
    spec.deadline.boundedBy(GIT_TIMEOUT_MS),
  );
  if (clone.timedOut || clone.exit !== 0) {
    const why = clone.timedOut
      ? "fresh clone timed out under the run budget"
      : `fresh clone failed: ${clone.excerpt}`;
    return { context, runs: allNotRun(spec.commands, why) };
  }
  const checkout = await execBounded(
    hardenedGitArgv(cloneDir, ["checkout", "--quiet", "--detach", spec.head_sha]),
    cloneDir,
    gitEnv(spec.env),
    spec.deadline.boundedBy(GIT_TIMEOUT_MS),
  );
  if (checkout.timedOut || checkout.exit !== 0) {
    return { context, runs: allNotRun(spec.commands, `checkout ${spec.head_sha.slice(0, 12)} failed: ${checkout.excerpt}`) };
  }

  /**
   * ISC-277: the mount is PROVED before a single command is graded.
   *
   * This block is the reason ISC-233 could not simply be "add the argv". On
   * macOS the daemon runs in a VM that shares only a declared set of host
   * directories, and `-v` against a path outside that set does NOT fail — the
   * daemon creates an empty directory inside the VM and mounts THAT
   * (`container/mounts.ts`, measured). The container would then see an empty
   * `/workspace`, the acceptance commands would find no tests to fail, they
   * would exit 0, and the harvester would record `passed`: a green exam
   * against a directory containing nothing, with every symptom pointing at the
   * worker. That is strictly worse than the host-side clone it replaces, which
   * at least grades real files, and it is why the probe is sequenced BEFORE
   * the argv rather than after it.
   *
   * Presence of the mount proves nothing, so presence is not what is checked:
   * `probeMountVisibility` writes a sentinel on the host and reads it back
   * from inside a container, which is the only thing that separates "shared"
   * from "silently empty".
   *
   * Probed on the SCRATCH ROOT rather than on the clone, for two reasons. The
   * criterion names the scratch root; and sharing is by path prefix, so a
   * visible root is a visible clone beneath it, while probing the clone would
   * mean writing a sentinel file into the tree under examination — a small
   * contamination of exactly the kind this module exists to prevent.
   *
   * Failure is `not_run`, never `failed`. Nothing was learned about the code,
   * and `not_run` adjudicates to `unknown` — the module's standing posture for
   * an exam that could not be held.
   */
  if (spec.container !== undefined) {
    // The clone was created by the operator's uid; the image runs as a baked
    // one. Without a recursive widen every write into /workspace fails on a
    // Linux daemon and succeeds on macOS, where the VM squashes ownership
    // (ISC-298). A test suite writing a snapshot or a coverage file is an
    // ordinary suite, so this is not an edge case.
    const widen = await widenTreeForWorker(cloneDir);
    if (!widen.ok) {
      return {
        context,
        runs: allNotRun(
          spec.commands,
          `could not open the fresh clone for the worker uid (chmod exit ${widen.code}): ` +
            `${widen.stderr.trim() || "(no stderr)"}`,
        ),
      };
    }

    const visibility = await probeMountVisibility(
      scratchAbs,
      spec.container.image,
      spec.container.probeExec,
    );
    if (!visibility.visible) {
      return {
        context,
        runs: allNotRun(
          spec.commands,
          `the acceptance scratch root is not visible to the Docker daemon, so a containerized ` +
            `exam would grade an EMPTY directory and report passes (ISC-277): ${visibility.detail}`,
        ),
      };
    }
  }

  const runs: AcceptanceRun[] = [];
  for (const [index, rc] of spec.commands.entries()) {
    runs.push(await runOne(rc, cloneDir, env, spec, nonce, index));
  }
  return { context, runs };
}

async function runOne(
  rc: ResolvedCommand,
  cloneDir: string,
  env: Record<string, string>,
  spec: AcceptanceSpec,
  nonce: string,
  index: number,
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

  /**
   * ISC-233: the same command, in a fresh container from the worker's image.
   *
   * `cmd` and `source` in the record below stay the OPERATOR'S command text,
   * not the docker argv. The record answers "what was the exam", and
   * `docker run --rm --user 10001 ... bun test` is not a question anybody
   * asked; the fact that it ran in a container is carried by
   * `AcceptanceContext.image`, which is where an auditor looks for it.
   *
   * `cwd` becomes the scratch root rather than the clone: on this path the
   * spawned process is the docker CLIENT, and its working directory has no
   * bearing on the container, which gets `-w /workspace`. Pointing the client
   * at the graded tree would be one more way for the exam to depend on it.
   *
   * The environment splits the same way and for the same reason as `gitEnv`
   * above: `dockerClientEnv` is what the CLIENT needs to find its daemon, and
   * `acceptanceContainerEnv` — passed as `-e K=V` inside the argv — is what
   * the COMMAND gets. Nothing crosses.
   */
  if (spec.container !== undefined) {
    const containerName = acceptanceContainerName(spec.head_sha, nonce, index);
    const dockerArgv = acceptanceContainerArgv({
      image: spec.container.image,
      cloneDir,
      argv,
      env: acceptanceContainerEnv(),
      network: spec.container.network ?? null,
      containerName,
    });
    const clientEnv = dockerClientEnv();
    const cr = await execBounded(dockerArgv, resolve(spec.scratch_dir), clientEnv, timeoutMs);
    /**
     * The timeout killed the docker CLIENT. It did not kill the container.
     *
     * `--rm` is a client-side action, so a SIGKILLed client leaves the
     * container running with nothing left to remove it — the same property
     * `container-launch.test.ts` describes for the supervisor's kill ladder.
     * Measured on this feature's own `timed_out` probe: a `sleep 60` container
     * was still `Up` after the run had been recorded and returned. A real
     * acceptance suite is not a 60-second sleep, so the leak is unbounded in
     * both time and resources.
     */
    if (cr.timedOut) await reapAcceptanceContainer(containerName, clientEnv);
    return AcceptanceRunSchema.parse({
      cmd: rc.cmd,
      source: rc.source,
      resolved_from: rc.resolved_from,
      outcome: cr.timedOut ? "timed_out" : cr.exit === 0 ? "passed" : "failed",
      exit_code: cr.timedOut ? null : cr.exit,
      duration_ms: Math.round(cr.durationMs),
      excerpt: cr.excerpt,
    });
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
