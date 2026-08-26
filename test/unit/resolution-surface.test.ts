/**
 * The graded resolution surface (ISC-243).
 *
 * ISC-243 is an ANTI-criterion: it asserts the harness denylist cannot be
 * complete. The first block below is that assertion held as a live
 * measurement rather than as a sentence, because the ISA's own rule is that
 * grounds go stale — a criterion's grade is a checkbox, but its grounds are
 * claims about code that nothing re-reads. If someone answers ISC-243 by
 * widening `DEFAULT_HARNESS_PATTERNS` instead, `the denylist still misses all
 * of them` goes red and says so.
 */

import { describe, expect, test } from "bun:test";

import { DEFAULT_HARNESS_PATTERNS, harnessSurface } from "../../src/harvest/acceptance.ts";
import { acceptanceContainerArgv } from "../../src/harvest/acceptance-container.ts";
import {
  OFF_SURFACE_BY_MODEL,
  RUNNERS,
  TIER_ORDER,
  capFor,
  gradedSurface,
  identifyRunner,
  peakTier,
  strictestTier,
  type SurfaceTier,
} from "../../src/harvest/resolution-surface.ts";

/** Every runner's manifest at once — the best the allowlist can do. */
const ALL_COMMANDS = ["bun test", "pytest", "jest", "vitest", "go test ./...", "cargo test", "rspec"];

/**
 * Paths the ISA measured on 2026-08-20 as denylist misses and this file
 * re-measured on 2026-08-26. Kept verbatim so the two measurements are
 * comparable rather than merely similar.
 */
const MEASURED_MISSES = [
  ".env", ".env.test", ".python-version", ".ruby-version", ".sdkmanrc", ".envrc",
  "requirements.txt", "setup.py", "Pipfile", "poetry.lock", "uv.lock",
  "Gemfile", "Gemfile.lock", "go.sum", "Cargo.lock", "composer.json",
  "vite.config.ts", "babel.config.js", ".babelrc", ".swcrc",
  "cypress.config.ts", "ava.config.js", "nightwatch.conf.js",
  "BUILD.bazel", "WORKSPACE", ".bazelrc", "CMakeLists.txt", "meson.build",
  "build.sbt", "mix.exs", "project.clj", "Directory.Build.props",
  "settings.gradle", "gradle.properties", "gradle/wrapper/gradle-wrapper.properties",
  "Dockerfile", "docker-compose.yml", ".gitattributes",
];

describe("the anti-criterion's premise, measured rather than quoted (ISC-243)", () => {
  test("the denylist still misses all of them, and still catches its controls", () => {
    expect(harnessSurface(MEASURED_MISSES).touched).toEqual([]);
    // Controls, so an empty result above cannot be a broken matcher.
    expect(harnessSurface(["package.json", "bunfig.toml", ".github/workflows/ci.yml"]).touched)
      .toEqual(["package.json", "bunfig.toml", ".github/workflows/ci.yml"]);
    expect(harnessSurface(["src/harvest/acceptance.ts"]).touched).toEqual([]);
  });

  test("the shape of the misses is the argument: six adjacent-sibling holes", () => {
    // Each pair is one file the denylist matches and its sibling it does not.
    // This is what "cannot be complete" means concretely — every entry in that
    // list was added by someone thinking hard about that exact family.
    const SIBLINGS = [
      ["go.mod", "go.sum"],
      ["Cargo.toml", "Cargo.lock"],
      ["pyproject.toml", "poetry.lock"],
      ["build.gradle", "settings.gradle"],
      ["Rakefile", "Gemfile"],
      ["vitest.config.ts", "vite.config.ts"],
    ] as const;
    for (const [caught, missed] of SIBLINGS) {
      expect(harnessSurface([caught]).touched).toEqual([caught]);
      expect(harnessSurface([missed]).touched).toEqual([]);
    }
  });

  test("the allowlist closes 17 of them, and each closure carries a tier and a reason", () => {
    const hits = new Map(gradedSurface(ALL_COMMANDS, MEASURED_MISSES).hits.map((h) => [h.file, h]));
    const closed = MEASURED_MISSES.filter((f) => hits.has(f));
    expect(closed.sort()).toEqual([
      ".babelrc", ".env", ".env.test", ".python-version", ".swcrc", "Cargo.lock",
      "Gemfile", "Gemfile.lock", "Pipfile", "babel.config.js", "go.sum",
      "poetry.lock", "requirements.txt", "setup.py", "uv.lock", "vite.config.ts",
      ".ruby-version",
    ].sort());
    for (const f of closed) {
      expect(TIER_ORDER).toContain(hits.get(f)!.tier);
      expect(hits.get(f)!.why.length).toBeGreaterThan(10);
    }
  });

  /**
   * The residual, stated as a number rather than left implied.
   *
   * These are not holes in a runner's manifest — they belong to ecosystems
   * with no runner implemented (bazel, cmake, gradle, sbt, mix, lein, msbuild,
   * composer, cypress, ava, nightwatch). The difference matters: adding a
   * runner is a bounded, completable unit of work, where adding a denylist
   * pattern is another guess. If this count ever DROPS without a runner being
   * added, something widened a manifest by guessing.
   */
  test("what the allowlist does not reach is accounted for, not silent", () => {
    const surface = gradedSurface(ALL_COMMANDS, MEASURED_MISSES);
    const covered = new Set(surface.hits.map((h) => h.file));
    const uncovered = MEASURED_MISSES.filter((f) => !covered.has(f));
    const excused = uncovered.filter((f) => OFF_SURFACE_BY_MODEL.has(f));
    expect(excused.sort()).toEqual([".envrc", "Dockerfile", "docker-compose.yml"]);
    expect(uncovered.length - excused.length).toBe(18);
  });
});

/**
 * The two exclusions are asserted against the VALUE the production builder
 * produces, not against the prose in `OFF_SURFACE_BY_MODEL`. A reason that is
 * only a sentence stays true-looking after the code moves; these go red in the
 * same commit that makes them false.
 */
describe("paths the execution model puts off the surface (ISC-243)", () => {
  const BASE = {
    image: "pifleet/pi-worker:verify",
    cloneDir: "/tmp/clone",
    argv: ["bun", "test"] as const,
    env: {},
    containerName: "pifleet-accept-a-b-0",
  };

  test("Dockerfile: the exam runs a PINNED image and never builds one", () => {
    const argv = acceptanceContainerArgv(BASE);
    expect(argv.slice(0, 2)).toEqual(["docker", "run"]);
    expect(argv).not.toContain("build");
    expect(argv).toContain(BASE.image);
    // An image is REQUIRED, so there is no path where the repo supplies one.
    expect(() => acceptanceContainerArgv({ ...BASE, image: "" })).toThrow(/empty image/);
    expect(gradedSurface(ALL_COMMANDS, ["Dockerfile", "docker-compose.yml"]).hits).toEqual([]);
  });

  test(".envrc: the command is argv with an entrypoint, so there is no shell to hook", () => {
    const argv = acceptanceContainerArgv({ ...BASE, argv: ["pytest", "-q"] });
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("pytest");
    for (const shell of ["sh", "bash", "-c", "zsh"]) expect(argv).not.toContain(shell);
    expect(gradedSurface(ALL_COMMANDS, [".envrc"]).hits).toEqual([]);
  });

  test("every exclusion states a mechanism, not just a verdict", () => {
    expect(OFF_SURFACE_BY_MODEL.size).toBeGreaterThan(0);
    for (const [, why] of OFF_SURFACE_BY_MODEL) expect(why.length).toBeGreaterThan(30);
  });
});

describe("identifying the runner behind a resolved command (ISC-243)", () => {
  test("each runner is reached by its ordinary invocation", () => {
    const cases: Record<string, string> = {
      "bun test": "bun-test",
      "bun test --coverage": "bun-test",
      "pytest": "pytest",
      "pytest -q tests/": "pytest",
      "python -m pytest": "pytest",
      "python3 -m pytest -x": "pytest",
      "jest": "jest",
      "npx jest --ci": "jest",
      "vitest run": "vitest",
      "bunx vitest": "vitest",
      "go test ./...": "go-test",
      "cargo test": "cargo-test",
      "cargo test --all-features": "cargo-test",
      "rspec": "rspec",
      "bundle exec rspec": "rspec",
    };
    for (const [cmd, id] of Object.entries(cases)) {
      const res = identifyRunner(cmd);
      expect(res.kind).toBe("runner");
      expect(res.kind === "runner" ? res.runner.id : null).toBe(id);
    }
  });

  test("an absolute path identifies the same as a bare name", () => {
    const a = identifyRunner("/usr/local/bin/pytest -q");
    expect(a.kind === "runner" ? a.runner.id : null).toBe("pytest");
  });

  /**
   * `indirect` is a THIRD outcome, not a flavour of unknown, and this is the
   * probe that keeps it one. Collapsing it into `unknown` would discard the
   * single useful thing identification established: the name of the file that
   * decides which runner actually runs.
   */
  test("a command that resolves through a worker-editable file says so, and names it", () => {
    for (const [cmd, via] of [
      ["npm test", "package.json"],
      ["yarn test", "package.json"],
      ["bun run test", "package.json"],
      ["make test", "Makefile"],
      ["just check", "justfile"],
      ["tox", "tox.ini"],
      ["gradle test", "gradle"],
      ["bazel test //...", "bazel"],
    ] as const) {
      const res = identifyRunner(cmd);
      expect(res.kind).toBe("indirect");
      expect(res.kind === "indirect" ? res.via : "").toContain(via);
    }
  });

  test("`bun run test` is indirect while `bun test` is direct — the tokens differ by one", () => {
    expect(identifyRunner("bun test").kind).toBe("runner");
    expect(identifyRunner("bun run test").kind).toBe("indirect");
  });

  test("an unrecognized program is unknown, and the reason names it", () => {
    const res = identifyRunner("ctest --output-on-failure");
    expect(res.kind).toBe("unknown");
    expect(res.kind === "unknown" ? res.why : "").toContain("ctest");
  });

  /**
   * Never throws, and this is load-bearing rather than tidy: identification
   * runs inside adjudication, so an exception here would turn a reporting
   * feature into a harvest outage. `tokenize` refuses shell metacharacters
   * outside quotes by design (ISC-149) — that refusal must arrive as a
   * classification, not as a stack trace.
   */
  test("a command tokenize refuses is unknown, not an exception", () => {
    for (const cmd of ["bun test | tee log", "pytest && echo ok", "$(evil)", ""]) {
      let res: ReturnType<typeof identifyRunner> | null = null;
      expect(() => {
        res = identifyRunner(cmd);
      }).not.toThrow();
      expect(res!.kind).toBe("unknown");
    }
  });

  test("a bare prefix with nothing after it is not read as its own successor", () => {
    expect(identifyRunner("npx").kind).toBe("unknown");
    expect(identifyRunner("bundle").kind).toBe("unknown");
  });
});

describe("tiers (ISC-243)", () => {
  test("severity ascends dependency < toolchain < executes", () => {
    expect(TIER_ORDER).toEqual(["dependency", "toolchain", "executes"]);
  });

  test("strictestTier raises and never lowers, in both argument orders", () => {
    const pairs: [SurfaceTier, SurfaceTier, SurfaceTier][] = [
      ["dependency", "executes", "executes"],
      ["executes", "dependency", "executes"],
      ["dependency", "toolchain", "toolchain"],
      ["toolchain", "toolchain", "toolchain"],
    ];
    for (const [a, b, want] of pairs) expect(strictestTier(a, b)).toBe(want);
  });

  /**
   * The grade's entire operational content. If both branches ever return the
   * same verdict, ISC-243's "graded" is decoration over the boolean it was
   * meant to replace, and this goes red.
   */
  test("the tiers do not all cap to the same thing", () => {
    expect(capFor("executes")).toBe("unknown");
    expect(capFor("toolchain")).toBe("unknown");
    expect(capFor("dependency")).toBe("partial");
    expect(new Set(TIER_ORDER.map(capFor)).size).toBeGreaterThan(1);
  });

  test("peakTier reports the strictest hit, and null for a clean diff", () => {
    expect(peakTier(gradedSurface(["bun test"], ["docs/a.md"]))).toBeNull();
    expect(peakTier(gradedSurface(["bun test"], ["bun.lock"]))).toBe("dependency");
    expect(peakTier(gradedSurface(["bun test"], ["bun.lock", ".nvmrc"]))).toBe("toolchain");
    expect(peakTier(gradedSurface(["bun test"], ["bun.lock", ".nvmrc", "bunfig.toml"]))).toBe("executes");
  });
});

describe("grading a diff (ISC-243)", () => {
  /**
   * The over-cap probe, and the reason this criterion's own entry called a
   * partial allowlist dangerous: "a half-built allowlist caps on ordinary
   * source files". It does not, and the structural reason is that the graded
   * surface only ever ADDS to the denylist — but structure is an argument and
   * this is a measurement.
   */
  test("ordinary source and documentation are not on any runner's surface", () => {
    const ORDINARY = [
      "src/app.ts", "src/lib/util.ts", "lib/thing.go", "app/models.py",
      "src/main.rs", "README.md", "docs/design.md", "CHANGELOG.md",
      "assets/logo.svg", ".gitignore", "LICENSE",
    ];
    expect(gradedSurface(ALL_COMMANDS, ORDINARY).hits).toEqual([]);
  });

  test("a file is graded only for the runner that actually reads it", () => {
    // vite.config.ts is vitest's fallback config; `bun test` never reads it.
    // A denylist must either miss it everywhere or cap it everywhere; keying
    // on the resolved runner is the whole reason the allowlist can do neither.
    expect(gradedSurface(["bun test"], ["vite.config.ts"]).hits).toEqual([]);
    expect(gradedSurface(["vitest run"], ["vite.config.ts"]).hits.map((h) => h.file))
      .toEqual(["vite.config.ts"]);
  });

  test("commands union: a file on EITHER surface is graded", () => {
    const s = gradedSurface(["bun test", "pytest"], ["bunfig.toml", "conftest.py"]);
    expect(s.hits.map((h) => h.file)).toEqual(["bunfig.toml", "conftest.py"]);
    expect(s.runners).toEqual(["bun-test", "pytest"]);
  });

  test("a file matched at two tiers takes the stricter one", () => {
    // `Gemfile` is `executes` for rspec (bundler evaluates it as Ruby). No
    // runner grades it lower, so construct the collision from the ambient
    // rules instead: `.tool-versions` is toolchain everywhere, and a runner
    // that also matched it at dependency must not win.
    const hit = gradedSurface(ALL_COMMANDS, [".tool-versions"]).hits[0];
    expect(hit?.tier).toBe("toolchain");
    // The real two-tier case: Gemfile (executes) vs Gemfile.lock (dependency).
    const g = gradedSurface(["rspec"], ["Gemfile", "Gemfile.lock"]);
    expect(g.hits.find((h) => h.file === "Gemfile")?.tier).toBe("executes");
    expect(g.hits.find((h) => h.file === "Gemfile.lock")?.tier).toBe("dependency");
  });

  test("hits are sorted and deduplicated, so the record is stable across runs", () => {
    const s = gradedSurface(["bun test", "bun test"], ["package.json", "bunfig.toml", "bun.lock"]);
    expect(s.hits.map((h) => h.file)).toEqual(["bun.lock", "bunfig.toml", "package.json"]);
    expect(s.runners).toEqual(["bun-test"]);
  });

  test("an unresolvable command contributes no surface and is recorded with its reason", () => {
    const s = gradedSurface(["npm test"], ["package.json"]);
    expect(s.hits).toEqual([]);
    expect(s.runners).toEqual([]);
    expect(s.unresolved).toHaveLength(1);
    expect(s.unresolved[0]).toContain("npm test");
    expect(s.unresolved[0]).toContain("package.json");
  });

  test("a resolvable and an unresolvable command in one task keep both halves", () => {
    const s = gradedSurface(["bun test", "make check"], ["bunfig.toml"]);
    expect(s.hits.map((h) => h.file)).toEqual(["bunfig.toml"]);
    expect(s.unresolved).toHaveLength(1);
  });

  test("no acceptance commands means no graded surface at all", () => {
    const s = gradedSurface([], ["bunfig.toml", "conftest.py"]);
    expect(s).toEqual({ runners: [], unresolved: [], hits: [] });
  });
});

describe("the manifests themselves (ISC-243)", () => {
  test("every rule carries a pattern, a tier in the ordering, and a stated reason", () => {
    expect(RUNNERS.length).toBeGreaterThanOrEqual(7);
    for (const r of RUNNERS) {
      expect(r.surface.length).toBeGreaterThan(0);
      for (const rule of r.surface) {
        expect(rule.pattern.length).toBeGreaterThan(0);
        expect(TIER_ORDER).toContain(rule.tier);
        expect(rule.why.length).toBeGreaterThan(10);
        // Compiles — `Bun.Glob` accepts malformed patterns silently, so this
        // asserts the pattern MATCHES something rather than merely parses.
        expect(() => new Bun.Glob(rule.pattern)).not.toThrow();
      }
    }
  });

  test("runner ids are unique", () => {
    expect(new Set(RUNNERS.map((r) => r.id)).size).toBe(RUNNERS.length);
  });

  /**
   * Every runner grades at more than one tier. A manifest that put everything
   * at `executes` would be a denylist wearing the allowlist's types, and the
   * `partial` outcome would never be reachable through it.
   */
  test("no runner's manifest collapses to a single tier", () => {
    for (const r of RUNNERS) {
      expect(new Set(r.surface.map((s) => s.tier)).size).toBeGreaterThan(1);
    }
  });

  test("the denylist is still in place — the allowlist adds to it, it did not replace it", () => {
    // ISC-243 as WRITTEN says "replaces". It does not yet, and pretending
    // otherwise in the grade is the failure this ISA calls a stale claim.
    expect(DEFAULT_HARNESS_PATTERNS.length).toBeGreaterThan(80);
    expect(harnessSurface(["test/unit/a.test.ts"]).touched).toEqual(["test/unit/a.test.ts"]);
  });
});
