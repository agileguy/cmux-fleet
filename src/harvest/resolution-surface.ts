/**
 * The graded resolution surface — an allowlist keyed on the RESOLVED COMMAND
 * (ISC-243).
 *
 * `DEFAULT_HARNESS_PATTERNS` is a denylist, and ISC-243 is an anti-criterion
 * asserting that such a list cannot be complete. That premise is not taken on
 * its wording: re-measured against the live matcher on 2026-08-26, 38 of 38
 * probed resolution-surface paths are missed, while all three controls are
 * caught. The shape of the misses is the argument rather than their count —
 * the denylist matches `go.mod` but not `go.sum`, `Cargo.toml` but not
 * `Cargo.lock`, `pyproject.toml` but not `poetry.lock`, and `vitest.config.*`
 * but not `vite.config.*`, which is what vitest reads when no vitest config
 * exists. Six adjacent-sibling holes in a list whose ~91 entries were each
 * added by someone thinking hard about that exact family.
 *
 * **Why an allowlist can be complete where a denylist cannot, stated as the
 * mechanism rather than as a preference.** A denylist tries to enumerate every
 * build system in the world at once, from no input, and is wrong by one entry
 * the moment a repository uses a runner nobody listed. An allowlist is keyed on
 * WHICH RUNNER was resolved, and a single runner's resolution surface is closed
 * and documented: `bun test` reads `bunfig.toml`, `package.json`, `tsconfig*`
 * and its `preload` targets, and that is the whole list because Bun says so.
 * The completeness obligation therefore shrinks from "every ecosystem" to "one
 * runner at a time", and — this is the load-bearing half — a command whose
 * runner is NOT recognized yields no allowlist at all, which is a refusal to
 * answer rather than a silent "nothing matched".
 *
 * The command is a legitimate key because it is already pinned: ISC-148
 * resolves the command text from the base SHA and records `resolved_from`, so
 * the runner identified here is the one the FLEET authored, not one the worker
 * could swap.
 *
 * **The grade (ISC-243's word), and what it changes.** Today the cap is one
 * boolean — `facts.harness.touched.length > 0` collapses anything above
 * `blocked` to `unknown`. Three tiers replace it:
 *
 *  - `executes`   — arbitrary code the worker wrote runs before or around the
 *                   suite. The result is meaningless. Full cap.
 *  - `toolchain`  — selects WHICH interpreter, compiler or runtime executes the
 *                   suite. The suite ran, but not necessarily the one that
 *                   matters. Full cap.
 *  - `dependency` — pins what the suite links against. The base tree's tests
 *                   ran against the base tree's code, so there is real evidence
 *                   here; a dependency the worker chose is nonetheless in the
 *                   loop. Capped to `partial`, not to `unknown`.
 *
 * That the lowest tier caps to something OTHER than `unknown` is the point of
 * grading, and it answers this criterion's own complaint that "the
 * all-or-nothing cap is itself what makes narrowing tempting": an operator
 * whose dependency bumps all came back `unknown` had one lever, and it was to
 * shrink the surface.
 *
 * **Two files the ISA listed as misses are deliberately NOT here, because this
 * system's execution model puts them off the surface entirely.** Adding a
 * pattern for a file that provably cannot affect the run is the padding this
 * criterion exists to argue against, so both are recorded in
 * `OFF_SURFACE_BY_MODEL` with the mechanism that excludes them rather than
 * dropped silently.
 */

import type { Verdict } from "../contracts.ts";
import { CommandParseError, tokenize } from "./acceptance.ts";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** The three grades, ISC-243's own wording for them. */
export type SurfaceTier = "dependency" | "toolchain" | "executes";

/**
 * Ascending severity. `dependency` is the weakest claim on a verdict and
 * `executes` the strongest, and the order is exported because merging two
 * surfaces must take the STRICTER of the two — never the later one, and never
 * the more specific one.
 */
export const TIER_ORDER: readonly SurfaceTier[] = ["dependency", "toolchain", "executes"];

/** Severity of a tier; higher binds harder. */
export function tierRank(t: SurfaceTier): number {
  return TIER_ORDER.indexOf(t);
}

/** The stricter of two tiers. Merging surfaces may only ever raise severity. */
export function strictestTier(a: SurfaceTier, b: SurfaceTier): SurfaceTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/**
 * The verdict ceiling a tier imposes.
 *
 * `unknown` is the lattice IDENTITY rather than its bottom (`contracts.ts`), so
 * "cap to unknown" means refuse to grade. `partial` is an ordinary lattice
 * member below `success`, so "cap to partial" is a real downgrade that still
 * carries the evidence forward — which is the distinction the grade buys.
 */
export function capFor(tier: SurfaceTier): Verdict {
  return tier === "dependency" ? "partial" : "unknown";
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface SurfaceRule {
  /** Repo-relative glob, matched with `Bun.Glob` exactly as the denylist is. */
  readonly pattern: string;
  readonly tier: SurfaceTier;
  /** Why this file is on the surface. Reaches the operator in a cap reason. */
  readonly why: string;
}

/**
 * Rules that hold for every runner, because they are properties of the
 * ENVIRONMENT the suite reads rather than of the runner reading it.
 *
 * `.env` deserves its `executes` grade even though nothing in it executes: a
 * committed `.env` is read by dotenv-style loaders in most of these
 * ecosystems, and an env var routinely selects which implementation a module
 * loads. ISC-149 blanks the INHERITED environment, which is a different
 * control — it stops the host leaking in, and does nothing about a file the
 * worker committed into the tree the exam clones.
 */
const AMBIENT: readonly SurfaceRule[] = [
  { pattern: ".env", tier: "executes", why: "committed env read by the suite's loader" },
  { pattern: ".env.*", tier: "executes", why: "committed env read by the suite's loader" },
  { pattern: "**/.env", tier: "executes", why: "committed env read by the suite's loader" },
  { pattern: "**/.env.*", tier: "executes", why: "committed env read by the suite's loader" },
  { pattern: ".tool-versions", tier: "toolchain", why: "asdf/mise pins the interpreter" },
  { pattern: ".mise.toml", tier: "toolchain", why: "mise pins the interpreter" },
  { pattern: "mise.toml", tier: "toolchain", why: "mise pins the interpreter" },
];

/** `bun test` — the runner this repository grades itself with. */
const BUN_TEST: readonly SurfaceRule[] = [
  { pattern: "bunfig.toml", tier: "executes", why: "[test] preload runs before every test file" },
  { pattern: "**/bunfig.toml", tier: "executes", why: "[test] preload runs before every test file" },
  { pattern: "package.json", tier: "executes", why: "scripts, and trustedDependencies postinstall" },
  { pattern: "**/package.json", tier: "executes", why: "scripts, and trustedDependencies postinstall" },
  { pattern: "tsconfig.json", tier: "executes", why: "paths remaps an import to different code" },
  { pattern: "tsconfig.*.json", tier: "executes", why: "paths remaps an import to different code" },
  { pattern: "**/tsconfig*.json", tier: "executes", why: "paths remaps an import to different code" },
  { pattern: "*.test.*", tier: "executes", why: "bun's default test discovery" },
  { pattern: "**/*.test.*", tier: "executes", why: "bun's default test discovery" },
  { pattern: "*.spec.*", tier: "executes", why: "bun's default test discovery" },
  { pattern: "**/*.spec.*", tier: "executes", why: "bun's default test discovery" },
  { pattern: "**/*_test.*", tier: "executes", why: "bun's default test discovery" },
  { pattern: "**/*_spec.*", tier: "executes", why: "bun's default test discovery" },
  { pattern: "node_modules/**", tier: "executes", why: "committed dependency source is the code that runs" },
  { pattern: ".npmrc", tier: "executes", why: "node-options injects flags into every process" },
  { pattern: "**/.npmrc", tier: "executes", why: "node-options injects flags into every process" },
  { pattern: "bun.lock", tier: "dependency", why: "pins the resolved dependency graph" },
  { pattern: "bun.lockb", tier: "dependency", why: "pins the resolved dependency graph" },
  { pattern: ".nvmrc", tier: "toolchain", why: "selects the node/bun runtime" },
  { pattern: ".node-version", tier: "toolchain", why: "selects the node runtime" },
];

/** `pytest`, `python -m pytest`. */
const PYTEST: readonly SurfaceRule[] = [
  { pattern: "conftest.py", tier: "executes", why: "imported and executed at collection" },
  { pattern: "**/conftest.py", tier: "executes", why: "imported and executed at collection" },
  { pattern: "sitecustomize.py", tier: "executes", why: "executed on interpreter start by site" },
  { pattern: "usercustomize.py", tier: "executes", why: "executed on interpreter start by site" },
  { pattern: "**/*.pth", tier: "executes", why: "site executes import lines in .pth files" },
  { pattern: "pytest.ini", tier: "executes", why: "addopts and plugin selection" },
  { pattern: "**/pytest.ini", tier: "executes", why: "addopts and plugin selection" },
  { pattern: "tox.ini", tier: "executes", why: "carries [pytest] addopts" },
  { pattern: "setup.cfg", tier: "executes", why: "carries [tool:pytest] addopts" },
  { pattern: "pyproject.toml", tier: "executes", why: "carries [tool.pytest.ini_options]" },
  { pattern: "**/pyproject.toml", tier: "executes", why: "carries [tool.pytest.ini_options]" },
  { pattern: "setup.py", tier: "executes", why: "arbitrary code at install time" },
  { pattern: "test_*.py", tier: "executes", why: "pytest's default discovery" },
  { pattern: "**/test_*.py", tier: "executes", why: "pytest's default discovery" },
  { pattern: "**/*_test.py", tier: "executes", why: "pytest's default discovery" },
  { pattern: "requirements.txt", tier: "dependency", why: "pins what the suite imports" },
  { pattern: "requirements*.txt", tier: "dependency", why: "pins what the suite imports" },
  { pattern: "**/requirements*.txt", tier: "dependency", why: "pins what the suite imports" },
  { pattern: "constraints.txt", tier: "dependency", why: "pins what the suite imports" },
  { pattern: "Pipfile", tier: "dependency", why: "pins what the suite imports" },
  { pattern: "Pipfile.lock", tier: "dependency", why: "pins what the suite imports" },
  { pattern: "poetry.lock", tier: "dependency", why: "pins what the suite imports" },
  { pattern: "uv.lock", tier: "dependency", why: "pins what the suite imports" },
  { pattern: ".python-version", tier: "toolchain", why: "selects the interpreter" },
  { pattern: "runtime.txt", tier: "toolchain", why: "selects the interpreter" },
];

/** `jest`, `npx jest`. */
const JEST: readonly SurfaceRule[] = [
  { pattern: "jest.config.*", tier: "executes", why: "setupFiles and globalSetup run arbitrary code" },
  { pattern: "**/jest.config.*", tier: "executes", why: "setupFiles and globalSetup run arbitrary code" },
  { pattern: "jest.setup.*", tier: "executes", why: "runs before every test file" },
  { pattern: "**/jest.setup.*", tier: "executes", why: "runs before every test file" },
  { pattern: "package.json", tier: "executes", why: "carries the jest key, and scripts" },
  { pattern: "**/package.json", tier: "executes", why: "carries the jest key, and scripts" },
  { pattern: "babel.config.*", tier: "executes", why: "transforms every file before it runs" },
  { pattern: ".babelrc", tier: "executes", why: "transforms every file before it runs" },
  { pattern: ".babelrc.*", tier: "executes", why: "transforms every file before it runs" },
  { pattern: ".swcrc", tier: "executes", why: "transforms every file before it runs" },
  { pattern: "tsconfig.json", tier: "executes", why: "ts-jest reads it; paths remaps imports" },
  { pattern: "**/tsconfig*.json", tier: "executes", why: "ts-jest reads it; paths remaps imports" },
  { pattern: "**/__tests__/**", tier: "executes", why: "jest's default discovery" },
  { pattern: "**/*.test.*", tier: "executes", why: "jest's default discovery" },
  { pattern: "**/*.spec.*", tier: "executes", why: "jest's default discovery" },
  { pattern: ".npmrc", tier: "executes", why: "node-options injects flags into every process" },
  { pattern: "package-lock.json", tier: "dependency", why: "pins the resolved dependency graph" },
  { pattern: "yarn.lock", tier: "dependency", why: "pins the resolved dependency graph" },
  { pattern: "pnpm-lock.yaml", tier: "dependency", why: "pins the resolved dependency graph" },
  { pattern: ".nvmrc", tier: "toolchain", why: "selects the node runtime" },
  { pattern: ".node-version", tier: "toolchain", why: "selects the node runtime" },
];

/**
 * `vitest`, `npx vitest`.
 *
 * `vite.config.*` is the entry the denylist misses and the reason this runner
 * is worth stating separately from jest: with no `vitest.config.*` present,
 * vitest reads `vite.config.*`, and a vite PLUGIN is arbitrary code running
 * over every module the suite loads.
 */
const VITEST: readonly SurfaceRule[] = [
  { pattern: "vitest.config.*", tier: "executes", why: "setupFiles and plugins run arbitrary code" },
  { pattern: "**/vitest.config.*", tier: "executes", why: "setupFiles and plugins run arbitrary code" },
  { pattern: "vite.config.*", tier: "executes", why: "vitest falls back to it; plugins transform every module" },
  { pattern: "**/vite.config.*", tier: "executes", why: "vitest falls back to it; plugins transform every module" },
  { pattern: "vitest.workspace.*", tier: "executes", why: "selects which projects run at all" },
  { pattern: "vitest.setup.*", tier: "executes", why: "runs before every test file" },
  { pattern: "package.json", tier: "executes", why: "scripts, and the vitest key" },
  { pattern: "**/package.json", tier: "executes", why: "scripts, and the vitest key" },
  { pattern: "tsconfig.json", tier: "executes", why: "paths remaps an import to different code" },
  { pattern: "**/tsconfig*.json", tier: "executes", why: "paths remaps an import to different code" },
  { pattern: "**/*.test.*", tier: "executes", why: "vitest's default discovery" },
  { pattern: "**/*.spec.*", tier: "executes", why: "vitest's default discovery" },
  { pattern: ".npmrc", tier: "executes", why: "node-options injects flags into every process" },
  { pattern: "package-lock.json", tier: "dependency", why: "pins the resolved dependency graph" },
  { pattern: "yarn.lock", tier: "dependency", why: "pins the resolved dependency graph" },
  { pattern: "pnpm-lock.yaml", tier: "dependency", why: "pins the resolved dependency graph" },
  { pattern: ".nvmrc", tier: "toolchain", why: "selects the node runtime" },
];

/** `go test`. */
const GO_TEST: readonly SurfaceRule[] = [
  { pattern: "**/*_test.go", tier: "executes", why: "go's only test discovery rule" },
  { pattern: "**/testdata/**", tier: "executes", why: "go reserves testdata as suite input" },
  { pattern: "tools.go", tier: "executes", why: "pins the code-generation tools the suite may rely on" },
  { pattern: "vendor/**", tier: "executes", why: "vendored source is the code that compiles" },
  { pattern: "go.mod", tier: "toolchain", why: "the go directive selects the language version" },
  { pattern: "**/go.mod", tier: "toolchain", why: "the go directive selects the language version" },
  { pattern: "go.work", tier: "toolchain", why: "redirects module resolution across the workspace" },
  { pattern: ".go-version", tier: "toolchain", why: "selects the toolchain" },
  { pattern: "go.sum", tier: "dependency", why: "pins the module checksums the build accepts" },
  { pattern: "**/go.sum", tier: "dependency", why: "pins the module checksums the build accepts" },
  { pattern: "go.work.sum", tier: "dependency", why: "pins workspace module checksums" },
];

/**
 * `cargo test`.
 *
 * The discovery tier is genuinely weaker here than for the other runners, and
 * it is recorded rather than smoothed over: Rust unit tests live INSIDE `src/`
 * behind `#[cfg(test)]`, so "test file" and "source file" are the same file and
 * no glob can separate them. Grading all of `src/**` as `executes` would cap
 * every ordinary code change, which is the over-cap failure this criterion
 * warns a partial allowlist causes — so cargo's discovery surface is limited to
 * the integration-test directories that ARE separable, and the inline case is
 * left to the denylist and to the fact that a diff touching `src/` is what the
 * exam is grading in the first place.
 */
const CARGO_TEST: readonly SurfaceRule[] = [
  { pattern: "tests/**", tier: "executes", why: "cargo's integration-test directory" },
  { pattern: "benches/**", tier: "executes", why: "compiled and run under cargo test" },
  { pattern: "build.rs", tier: "executes", why: "arbitrary code at build time" },
  { pattern: "**/build.rs", tier: "executes", why: "arbitrary code at build time" },
  { pattern: ".cargo/config.toml", tier: "executes", why: "sets the runner and linker for the test binary" },
  { pattern: ".cargo/config", tier: "executes", why: "sets the runner and linker for the test binary" },
  { pattern: "Cargo.toml", tier: "executes", why: "declares targets, features and dev-dependencies" },
  { pattern: "**/Cargo.toml", tier: "executes", why: "declares targets, features and dev-dependencies" },
  { pattern: "rust-toolchain", tier: "toolchain", why: "selects the compiler" },
  { pattern: "rust-toolchain.toml", tier: "toolchain", why: "selects the compiler" },
  { pattern: "Cargo.lock", tier: "dependency", why: "pins the resolved crate graph" },
  { pattern: "**/Cargo.lock", tier: "dependency", why: "pins the resolved crate graph" },
];

/**
 * `rspec`, `bundle exec rspec`.
 *
 * `Gemfile` is `executes` rather than `dependency` and the distinction is not
 * pedantry: bundler EVALUATES the Gemfile as Ruby, so it is a code file that
 * happens to mostly contain declarations. `Gemfile.lock` is the declarative
 * half and grades one tier lower.
 */
const RSPEC: readonly SurfaceRule[] = [
  { pattern: ".rspec", tier: "executes", why: "--require loads code before any spec" },
  { pattern: "**/.rspec", tier: "executes", why: "--require loads code before any spec" },
  { pattern: "spec/spec_helper.rb", tier: "executes", why: "required by every spec file" },
  { pattern: "spec/rails_helper.rb", tier: "executes", why: "required by every spec file" },
  { pattern: "spec/**", tier: "executes", why: "rspec's default discovery root" },
  { pattern: "Gemfile", tier: "executes", why: "bundler evaluates it as Ruby" },
  { pattern: "**/Gemfile", tier: "executes", why: "bundler evaluates it as Ruby" },
  { pattern: "Rakefile", tier: "executes", why: "arbitrary Ruby the suite may invoke" },
  { pattern: "*.gemspec", tier: "executes", why: "evaluated as Ruby at bundle time" },
  { pattern: "Gemfile.lock", tier: "dependency", why: "pins the resolved gem graph" },
  { pattern: "**/Gemfile.lock", tier: "dependency", why: "pins the resolved gem graph" },
  { pattern: ".ruby-version", tier: "toolchain", why: "selects the interpreter" },
];

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export interface Runner {
  readonly id: string;
  /** Matched against the tokenized command. Never a substring test on raw text. */
  readonly matches: (argv: readonly string[]) => boolean;
  readonly surface: readonly SurfaceRule[];
}

/** `basename`, so `/usr/bin/pytest` and `pytest` identify alike. */
function base(tok: string | undefined): string {
  if (tok === undefined) return "";
  const cut = tok.lastIndexOf("/");
  return cut === -1 ? tok : tok.slice(cut + 1);
}

/**
 * Skip `npx`/`bunx`/`pnpm exec` prefixes to reach the real program.
 *
 * A prefix is dropped only when a token follows it, so `npx` alone stays
 * unidentified rather than being read as its own successor.
 */
function program(argv: readonly string[]): readonly string[] {
  const PREFIX = new Set(["npx", "bunx", "pnpx", "dlx"]);
  let i = 0;
  for (;;) {
    // `bundle exec <prog>` and `poetry run <prog>` are two tokens, not one, and
    // both are the ordinary way their ecosystems invoke a runner. Consuming
    // them here rather than listing every `bundle exec X` as its own runner is
    // what keeps the runner table about RUNNERS.
    if (i < argv.length - 2 && (base(argv[i]) === "bundle" || base(argv[i]) === "poetry")) {
      const verb = argv[i + 1];
      if (verb === "exec" || verb === "run") {
        i += 2;
        continue;
      }
    }
    if (i < argv.length - 1 && PREFIX.has(base(argv[i]))) {
      i += 1;
      continue;
    }
    return argv.slice(i);
  }
}

export const RUNNERS: readonly Runner[] = [
  {
    id: "bun-test",
    matches: (a) => base(a[0]) === "bun" && a[1] === "test",
    surface: [...BUN_TEST, ...AMBIENT],
  },
  {
    id: "pytest",
    matches: (a) =>
      base(a[0]) === "pytest" ||
      (base(a[0]).startsWith("python") && a[1] === "-m" && a[2] === "pytest"),
    surface: [...PYTEST, ...AMBIENT],
  },
  {
    id: "jest",
    matches: (a) => base(a[0]) === "jest",
    surface: [...JEST, ...AMBIENT],
  },
  {
    id: "vitest",
    matches: (a) => base(a[0]) === "vitest",
    surface: [...VITEST, ...AMBIENT],
  },
  {
    id: "go-test",
    matches: (a) => base(a[0]) === "go" && a[1] === "test",
    surface: [...GO_TEST, ...AMBIENT],
  },
  {
    id: "rspec",
    matches: (a) => base(a[0]) === "rspec",
    surface: [...RSPEC, ...AMBIENT],
  },
  {
    id: "cargo-test",
    matches: (a) => base(a[0]) === "cargo" && a[1] === "test",
    surface: [...CARGO_TEST, ...AMBIENT],
  },
];

/**
 * Commands that name a runner only INDIRECTLY, through a file the worker can
 * edit.
 *
 * `npm test` runs whatever `package.json` says, `make test` whatever the
 * Makefile says. Resolving them means reading that file at the base SHA and
 * re-entering identification on the result, which is real work and is not done
 * here — so they are reported as `indirect`, which is a different answer from
 * `unknown` and is why the two are separate variants. Treating them as
 * unrecognized would lose the one useful thing this pass DID establish: the
 * name of the file that decides.
 */
const INDIRECT: readonly { readonly matches: (a: readonly string[]) => boolean; readonly via: string }[] = [
  { matches: (a) => base(a[0]) === "npm" && (a[1] === "test" || a[1] === "run"), via: "package.json scripts" },
  { matches: (a) => base(a[0]) === "yarn", via: "package.json scripts" },
  { matches: (a) => base(a[0]) === "pnpm" && (a[1] === "test" || a[1] === "run"), via: "package.json scripts" },
  { matches: (a) => base(a[0]) === "bun" && a[1] === "run", via: "package.json scripts" },
  { matches: (a) => base(a[0]) === "make" || base(a[0]) === "gmake", via: "the Makefile" },
  { matches: (a) => base(a[0]) === "just", via: "the justfile" },
  { matches: (a) => base(a[0]) === "task", via: "the Taskfile" },
  { matches: (a) => base(a[0]) === "tox", via: "tox.ini" },
  { matches: (a) => base(a[0]) === "nox", via: "noxfile.py" },
  { matches: (a) => base(a[0]) === "gradle" || base(a[0]) === "gradlew", via: "the gradle build" },
  { matches: (a) => base(a[0]) === "bazel", via: "the bazel BUILD graph" },
];

/**
 * What identification concluded. Three outcomes, not two, because "I know the
 * runner is decided by a file I did not read" and "I have never heard of this
 * program" warrant different reporting and — eventually — different work.
 */
export type Resolution =
  | { readonly kind: "runner"; readonly runner: Runner }
  | { readonly kind: "indirect"; readonly via: string }
  | { readonly kind: "unknown"; readonly why: string };

/**
 * Identify the runner behind a resolved acceptance command.
 *
 * Never throws. A command `tokenize` refuses — a shell metacharacter outside
 * quotes — is `unknown`, not an exception: this function runs inside
 * adjudication, and a harvest that dies because it could not classify a command
 * would turn a reporting feature into an outage.
 */
export function identifyRunner(cmd: string): Resolution {
  let argv: readonly string[];
  try {
    argv = program(tokenize(cmd));
  } catch (err) {
    const why = err instanceof CommandParseError ? "command is not tokenizable" : String(err);
    return { kind: "unknown", why };
  }
  if (argv.length === 0) return { kind: "unknown", why: "empty command" };
  for (const r of RUNNERS) if (r.matches(argv)) return { kind: "runner", runner: r };
  for (const i of INDIRECT) if (i.matches(argv)) return { kind: "indirect", via: i.via };
  return { kind: "unknown", why: `unrecognized runner ${JSON.stringify(base(argv[0]))}` };
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export interface SurfaceHit {
  readonly file: string;
  readonly tier: SurfaceTier;
  readonly why: string;
}

export interface GradedSurface {
  /** Runner ids that contributed rules, in the order the commands were run. */
  readonly runners: readonly string[];
  /** Commands whose runner could not be resolved to a surface, with the reason. */
  readonly unresolved: readonly string[];
  /** One entry per matched file, at its strictest tier across all runners. */
  readonly hits: readonly SurfaceHit[];
}

/**
 * Grade a diff against the surfaces of every command that graded it.
 *
 * The union across commands is deliberate: a task whose acceptance is
 * `["bun test", "pytest"]` is graded by both, so a file on EITHER surface makes
 * the result self-certified. Within the union a file takes its strictest tier —
 * `package.json` is `executes` for bun and `executes` for jest, but a file that
 * were `dependency` under one runner and `executes` under another must be
 * treated as `executes`, because merging surfaces may only ever raise severity.
 */
export function gradedSurface(
  commands: readonly string[],
  changedFiles: readonly string[],
): GradedSurface {
  const runners: string[] = [];
  const unresolved: string[] = [];
  const byFile = new Map<string, SurfaceHit>();

  for (const cmd of commands) {
    const res = identifyRunner(cmd);
    if (res.kind !== "runner") {
      unresolved.push(
        `${cmd} — ${res.kind === "indirect" ? `resolved through ${res.via}` : res.why}`,
      );
      continue;
    }
    if (!runners.includes(res.runner.id)) runners.push(res.runner.id);
    for (const rule of res.runner.surface) {
      const glob = new Bun.Glob(rule.pattern);
      for (const file of changedFiles) {
        if (!glob.match(file)) continue;
        const prior = byFile.get(file);
        if (prior === undefined) {
          byFile.set(file, { file, tier: rule.tier, why: rule.why });
          continue;
        }
        // Strictly raise, never replace at equal severity: the first rule to
        // match at a tier is the one whose reason is shown, so a later rule
        // cannot quietly restate the finding in weaker words.
        if (tierRank(rule.tier) > tierRank(prior.tier)) {
          byFile.set(file, { file, tier: rule.tier, why: rule.why });
        }
      }
    }
  }

  const hits = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  return { runners, unresolved, hits };
}

/** The strictest tier present in a surface, or `null` for a clean diff. */
export function peakTier(surface: GradedSurface): SurfaceTier | null {
  let peak: SurfaceTier | null = null;
  for (const h of surface.hits) peak = peak === null ? h.tier : strictestTier(peak, h.tier);
  return peak;
}

/**
 * Paths the ISA measured as denylist misses that this system's execution model
 * puts OFF the resolution surface, with the mechanism that excludes each.
 *
 * Exported so a test can assert the exclusions rather than leaving them as
 * prose, which is the failure mode this ISA calls stale grounds: a sentence
 * about code that nothing re-reads. If any of these mechanisms changes — if the
 * exam ever builds its image from the repo, or ever gains a shell — the paths
 * move onto the surface and the reasons here become false in the same commit
 * that makes them false.
 */
export const OFF_SURFACE_BY_MODEL: ReadonlyMap<string, string> = new Map([
  [
    "Dockerfile",
    "the exam runs in the PINNED image from the worker's launch.json, never one built from the graded repo",
  ],
  [
    "docker-compose.yml",
    "the exam runs in the PINNED image from the worker's launch.json; no compose file is read",
  ],
  [
    ".envrc",
    "direnv needs a shell hook; acceptance spawns argv arrays with --entrypoint and no shell",
  ],
]);
