/**
 * Phase 3 exit criterion: a seeded hostile repo changes nothing (SRD §12.2,
 * §16).
 *
 * The repository here is real — `git init`, a commit, a populated
 * `.git/config`, an executable `.git/hooks/post-checkout` — and every payload
 * in it does one observable thing: `touch` a marker. Assertions are about
 * whether markers appeared, never about what the scanner claims, because the
 * only convincing evidence that code did not execute is that its effect is
 * absent.
 *
 * The CONTROL tests come first and are load-bearing. Without them, "no marker
 * appeared" is equally consistent with a working defence and with a probe
 * that never armed — and a fixture that cannot fire is a green test that
 * proves nothing. So the first two tests demonstrate the payloads firing.
 *
 * What this file does NOT prove, stated plainly: no Pi process runs here, so
 * "the extension is not loaded" is established structurally — the extension is
 * absent from the discovery path Pi reads, and the argv Pi is launched with
 * denies extension discovery outright (asserted against the real
 * `buildPiArgv`). Executing Pi to watch it not load an extension would need
 * the container, which is Phase 1 machinery this test deliberately does not
 * drag in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  firedMarkers,
  rawGit,
  seedHostileRepo,
  type SeededHostileRepo,
} from "../fixtures/hostile-repo/seed.ts";
import { runGit } from "../../src/harvest/git.ts";
import {
  QUARANTINE_SUFFIX,
  detectRepoHazards,
  neutralizeRepoHazards,
} from "../../src/security/repo-hazards.ts";
import { cliBudget } from "../support/budget.ts";

const seeded: string[] = [];
afterEach(async () => {
  for (const dir of seeded.splice(0)) await rm(join(dir, ".."), { recursive: true, force: true });
});

async function seed(): Promise<SeededHostileRepo> {
  const s = await seedHostileRepo();
  seeded.push(s.dir);
  return s;
}

/** A checkout is the cheapest real trigger: `post-checkout` runs on branch switch. */
async function checkout(dir: string, branch: string): Promise<void> {
  await rawGit(dir, ["checkout", "-q", "-b", branch]);
}

describe("control — the fixture is genuinely armed", () => {
  // If this ever goes green-by-silence, every neutralization assertion below
  // becomes vacuous. It fails loudly if the payload stops being executable,
  // stops being wired, or stops being reached.
  test("core.hooksPath fires an in-tree committed hook on checkout", async () => {
    const s = await seed();
    await checkout(s.dir, "probe");
    expect(await Bun.file(s.markers.hooksPath).exists()).toBe(true);
  }, cliBudget(2));

  test(".git/hooks/post-checkout fires once hooksPath is out of the way", async () => {
    const s = await seed();
    // hooksPath WINS when set, so it masks .git/hooks. Removing just that key
    // exposes the second payload and proves it is independently live — which
    // is why the scanner walks the hooks directory as well as the config.
    const cfg = join(s.dir, ".git", "config");
    const text = await readFile(cfg, "utf8");
    await writeFile(cfg, text.replace(/\n\thooksPath = \.githooks/, ""));
    await checkout(s.dir, "probe");
    expect(await Bun.file(s.markers.gitHooks).exists()).toBe(true);
  }, cliBudget(2));
});

describe("detection sees every hazard class in the seeded repo", () => {
  test("all five kinds are reported, and nothing is claimed neutralized", async () => {
    const s = await seed();
    const hs = await detectRepoHazards(s.dir);
    const kinds = new Set(hs.map((h) => h.kind));
    expect(kinds.has("agents_md")).toBe(true);
    expect(kinds.has("pi_extension")).toBe(true);
    expect(kinds.has("hooks_path")).toBe(true);
    expect(kinds.has("mcp_config")).toBe(true);
    expect(kinds.has("other")).toBe(true);
    // Detection is not neutralization; conflating them is the seam's whole
    // reason for existing.
    expect(hs.every((h) => h.detected)).toBe(true);
    expect(hs.some((h) => h.neutralized)).toBe(false);
    // And a detect-only pass leaves the payloads exactly where they were.
    expect(await firedMarkers(s.markerDir)).toEqual([]);
    expect(await Bun.file(join(s.dir, "AGENTS.md")).exists()).toBe(true);
  }, cliBudget(1));
});

describe("neutralized, the hostile repo changes nothing", () => {
  test("no payload fires on checkout after neutralization", async () => {
    const s = await seed();
    const hs = await neutralizeRepoHazards(s.dir);
    expect(hs.length).toBeGreaterThan(0);
    expect(hs.every((h) => h.neutralized)).toBe(true);

    await checkout(s.dir, "probe");
    // Deliberately asserting on the DIRECTORY LISTING rather than on named
    // markers: a payload added to the fixture later and forgotten here would
    // slip past a per-name check, and this is the assertion that catches it.
    expect(await firedMarkers(s.markerDir)).toEqual([]);
  }, cliBudget(2));

  test("a full status/diff/add cycle fires nothing either", async () => {
    const s = await seed();
    await neutralizeRepoHazards(s.dir);
    // fsmonitor, clean/smudge filters and diff drivers hang off these verbs,
    // not off checkout — the hook markers alone would not have covered them.
    await rawGit(s.dir, ["status", "--porcelain"]);
    await writeFile(join(s.dir, "src", "main.ts"), "export const add = 1;\n");
    await rawGit(s.dir, ["add", "-A"]);
    await rawGit(s.dir, ["diff", "HEAD"]);
    expect(await firedMarkers(s.markerDir)).toEqual([]);
  }, cliBudget(4));

  test("the extension and instruction files are gone from the paths Pi reads", async () => {
    const s = await seed();
    await neutralizeRepoHazards(s.dir);
    for (const rel of [
      "AGENTS.md",
      "CLAUDE.md",
      ".mcp.json",
      join(".pi", "extensions"),
      join(".pi", "skills"),
      join(".agents", "skills"),
    ]) {
      await expect(lstat(join(s.dir, rel))).rejects.toThrow();
    }
  }, cliBudget(1));

  test("nothing is deleted — every hazard is renamed aside with content intact", async () => {
    const s = await seed();
    await neutralizeRepoHazards(s.dir);

    // The requirement in one assertion: a worker whose legitimate AGENTS.md
    // vanished with no record gets debugged as a mystery, so the content must
    // still be there under a name that explains itself.
    const agents = await readFile(join(s.dir, `AGENTS.md${QUARANTINE_SUFFIX}`), "utf8");
    expect(agents).toContain("MANDATORY");
    const ext = await readFile(
      join(s.dir, ".pi", `extensions${QUARANTINE_SUFFIX}`, "observer.ts"),
      "utf8",
    );
    expect(ext).toContain("FIXTURE PAYLOAD");
    // The in-tree hook is committed content and is NOT removed — neutralizing
    // it is the config line that pointed git at it. Deleting a worker's
    // tracked files would be the silent-deletion failure, and it would show up
    // as an unexplained diff in the harvest.
    expect(await Bun.file(join(s.dir, ".githooks", "post-checkout")).exists()).toBe(true);
    const cfg = await readFile(join(s.dir, ".git", "config"), "utf8");
    expect(cfg).toContain("; pifleet-quarantined");
    expect(cfg).toContain("hooksPath");
  }, cliBudget(1));

  test("the neutralized tree is clean on a second scan", async () => {
    const s = await seed();
    await neutralizeRepoHazards(s.dir);
    expect(await detectRepoHazards(s.dir)).toEqual([]);
  }, cliBudget(1));

  test("git still works — hardening that broke the harvest would wear this as a disguise", async () => {
    const s = await seed();
    await neutralizeRepoHazards(s.dir);
    const r = await runGit(s.dir, ["status", "--porcelain"]);
    expect(r.code).toBe(0);
    const log = await runGit(s.dir, ["log", "--oneline"]);
    expect(log.code).toBe(0);
    expect(log.stdout).toContain("initial");
  }, cliBudget(3));
});

describe("the layered defence, each layer proven separately", () => {
  // Neutralization is not the only thing standing between the harvester and a
  // repo-supplied program: harvest/git.ts hardens every host-side spawn. This
  // asserts that layer holds on a FULLY ARMED repo, which matters because
  // neutralization runs at worktree preflight and the harvester may meet a
  // tree that was re-armed afterwards.
  test("the hardened runGit fires nothing even BEFORE neutralization", async () => {
    const s = await seed();
    await runGit(s.dir, ["checkout", "-q", "-b", "probe"]);
    await runGit(s.dir, ["status", "--porcelain"]);
    await runGit(s.dir, ["diff", "HEAD"]);
    expect(await firedMarkers(s.markerDir)).toEqual([]);
  }, cliBudget(4));

  test("in-tree quarantine is reversible by the worker — stated, not assumed", async () => {
    const s = await seed();
    await neutralizeRepoHazards(s.dir);
    // AGENTS.md is TRACKED, so the object store still holds it and one
    // command brings it back. This is the honest limit of a worktree-level
    // control against an actor with write access to the worktree, and it is
    // why the load-bearing controls (the Pi argv denials, the git -c
    // hardening) live outside the mount. Asserted rather than commented so
    // the limitation cannot quietly stop being true.
    await rawGit(s.dir, ["checkout", "--", "AGENTS.md"]);
    expect(await Bun.file(join(s.dir, "AGENTS.md")).exists()).toBe(true);
  }, cliBudget(2));
});

describe("Pi is launched with discovery denied", () => {
  // The control that a worker CANNOT undo, because it is argv on a process
  // started outside the container's reach (SRD §12.2: mandatory and
  // non-overridable). Read-only use of the shared renderer.
  test("buildPiArgv emits --no-extensions, --no-skills and --no-context-files", async () => {
    const { buildPiArgv } = await import("../../src/config/render.ts");
    const worker = {
      id: "w1",
      role: "reviewer",
      provider: "omlx",
      model: "local/qwen",
      skills: [] as string[],
      briefing: [],
      isolation: "worktree",
      cloudAccess: false,
      toolchain: "base",
    } as unknown as Parameters<typeof buildPiArgv>[0];
    const argv = buildPiArgv(worker, false);
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--no-context-files");
  });
});
