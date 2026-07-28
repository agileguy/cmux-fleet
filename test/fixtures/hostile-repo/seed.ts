/**
 * Materialize the seeded hostile repository (SRD §12.2, Phase 3 exit).
 *
 * The fixture is stored under NEUTRAL names — `dot-pi/`, `AGENTS.md.seed`,
 * `dot-git-hooks/` — and this seeder maps them onto the live names at
 * materialization time. That indirection is not decoration:
 *
 *  - `.git/` cannot be committed inside another repository at all, so the
 *    git-shaped payloads have to be stored under some other name regardless.
 *  - A live `AGENTS.md` or `.pi/extensions/` checked into cmux-fleet would be
 *    a real hazard IN cmux-fleet — discovered by any agent whose cwd lands in
 *    the fixture directory. A probe that arms itself against its own
 *    repository is not a probe, it is the incident.
 *
 * Tests must materialize into a temp directory and never scan the fixture in
 * place: neutralization RENAMES files, and a test that defused the checked-in
 * fixture would pass once and never again.
 *
 * `__PIFLEET_MARKER_DIR__` in any seeded file is replaced with a per-seed temp
 * path. Every payload's effect is a `touch` into that directory, because the
 * only convincing evidence that code did not execute is that its effect is
 * absent — the same discipline as `test/integration/git-hardening.test.ts`.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../../src/harvest/git.ts";

/** Where the stored (disarmed) fixture tree lives. */
export const FIXTURE_TREE = join(import.meta.dir, "tree");

/** Token replaced in every seeded file with the per-seed marker directory. */
export const MARKER_TOKEN = "__PIFLEET_MARKER_DIR__";

export interface SeededHostileRepo {
  /** The worktree root to hand to the scanner. */
  dir: string;
  /** Directory every payload touches on execution. Empty means nothing ran. */
  markerDir: string;
  /** Absolute marker paths, by payload. */
  markers: {
    hooksPath: string;
    gitHooks: string;
    fsmonitor: string;
    smudge: string;
    clean: string;
    diffDriver: string;
    extension: string;
    mcp: string;
  };
}

/**
 * Stored-name → live-name. Applied per path SEGMENT, so `dot-pi/extensions`
 * becomes `.pi/extensions` while `src/main.ts` is untouched.
 *
 * `dot-git-hooks` and `dot-git-config-fragment.ini` are handled by the caller
 * rather than by this map: they belong INSIDE `.git`, which does not exist
 * until `git init` has run.
 */
function liveName(segment: string): string {
  const stripped = segment.endsWith(".seed") ? segment.slice(0, -".seed".length) : segment;
  return stripped.startsWith("dot-") ? `.${stripped.slice("dot-".length)}` : stripped;
}

/** Paths (live, repo-relative) that must be executable for the probe to be real. */
const EXECUTABLE = [join(".githooks", "post-checkout")];

/** Stored entries the tree walk skips — the caller installs them into `.git`. */
const GIT_ONLY = new Set(["dot-git-hooks", "dot-git-config-fragment.ini"]);

async function copyTree(from: string, to: string, markerDir: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (GIT_ONLY.has(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, liveName(entry.name));
    if (entry.isDirectory()) {
      await copyTree(src, dst, markerDir);
      continue;
    }
    const body = (await readFile(src, "utf8")).replaceAll(MARKER_TOKEN, markerDir);
    await writeFile(dst, body);
  }
}

/**
 * Build a real git repository carrying every hazard class.
 *
 * Setup runs through the hardened `runGit`, deliberately: the SETUP must not
 * be the thing that detonates the payload, or the probe would report a fired
 * hook before the test under discussion had even started. The probe itself
 * uses a raw, unhardened git spawn — that contrast is the control.
 */
export async function seedHostileRepo(): Promise<SeededHostileRepo> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-hostile-repo-"));
  const dir = join(root, "repo");
  const markerDir = join(root, "markers");
  await mkdir(markerDir, { recursive: true });
  await mkdir(dir, { recursive: true });

  await copyTree(FIXTURE_TREE, dir, markerDir);
  for (const rel of EXECUTABLE) await chmod(join(dir, rel), 0o755);

  // A real repository, so `git checkout` is a real checkout and the hooks are
  // reached the way git actually reaches them.
  await runGit(dir, ["init", "-q", "-b", "main"]);
  await runGit(dir, ["config", "user.email", "worker@example.invalid"]);
  await runGit(dir, ["config", "user.name", "worker"]);
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-qm", "initial"]);

  // The `.git` payloads go in AFTER the commit: `.git/hooks` and `.git/config`
  // are not tracked content, and installing them earlier would have the setup
  // commit run them.
  const hookSrc = join(FIXTURE_TREE, "dot-git-hooks", "post-checkout");
  const hookDst = join(dir, ".git", "hooks", "post-checkout");
  await writeFile(hookDst, (await readFile(hookSrc, "utf8")).replaceAll(MARKER_TOKEN, markerDir));
  await chmod(hookDst, 0o755);

  const cfgPath = join(dir, ".git", "config");
  const fragment = (await readFile(join(FIXTURE_TREE, "dot-git-config-fragment.ini"), "utf8"))
    .replaceAll(MARKER_TOKEN, markerDir);
  await writeFile(cfgPath, `${await readFile(cfgPath, "utf8")}\n${fragment}`);

  return {
    dir,
    markerDir,
    markers: {
      hooksPath: join(markerDir, "hookspath-hook-fired"),
      gitHooks: join(markerDir, "githooks-hook-fired"),
      fsmonitor: join(markerDir, "fsmonitor-fired"),
      smudge: join(markerDir, "smudge-fired"),
      clean: join(markerDir, "clean-fired"),
      diffDriver: join(markerDir, "diff-driver-fired"),
      extension: join(markerDir, "extension-loaded"),
      mcp: join(markerDir, "mcp-server-started"),
    },
  };
}

/**
 * Spawn git with NO hardening — the control arm.
 *
 * `harvest/git.ts` exists precisely so production never does this. Here it is
 * the point: it shows the payload firing, which is what makes the neutralized
 * run's silence mean something.
 */
export async function rawGit(cwd: string, args: string[]): Promise<number> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return p.exited;
}

/** Names of markers present — the assertion surface for "nothing ran". */
export async function firedMarkers(markerDir: string): Promise<string[]> {
  return (await readdir(markerDir)).sort();
}
