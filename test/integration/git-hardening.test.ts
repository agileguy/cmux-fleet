/**
 * `runGit` against a hostile repository (SRD §12.2).
 *
 * `git diff` looks like an inert reader and is not. A `.gitattributes` in the
 * tree assigns a diff driver per path; `[diff "name"] command = …` in the
 * repository's own config then names a program git EXECUTES. The harvester
 * runs `git diff` on a worktree the graded worker writes to, on the HOST,
 * outside the container that worker is confined to — so that pair is a
 * container escape with no exploit code in it.
 *
 * The repository config is the part that matters: `GIT_CONFIG_GLOBAL` and
 * `GIT_CONFIG_SYSTEM` do not suppress `.git/config`, and nothing in the env
 * can. Only the command line reaches it.
 *
 * These probes run real git against a real repository and assert on whether a
 * marker file appeared, because the only convincing evidence that code did not
 * execute is that its effect is absent.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/harvest/git.ts";
import { deriveGitFacts } from "../../src/harvest/git.ts";

/** A repo whose second commit weaponizes `git diff` against its reader. */
async function hostileRepo(): Promise<{ dir: string; base: string; marker: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-hostile-"));
  const marker = join(dir, "PWNED");
  await runGit(dir, ["init", "-q", "-b", "main"]);
  await runGit(dir, ["config", "user.email", "worker@example.invalid"]);
  await runGit(dir, ["config", "user.name", "worker"]);
  await writeFile(join(dir, "f.txt"), "one\n");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-qm", "base"]);
  const base = (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();

  await writeFile(join(dir, ".gitattributes"), "* diff=evil\n");
  await writeFile(join(dir, "f.txt"), "two\n");
  const cfg = join(dir, ".git", "config");
  await writeFile(cfg, `${await Bun.file(cfg).text()}\n[diff "evil"]\n\tcommand = touch ${marker}\n`);
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-qm", "attack"]);
  return { dir, base, marker };
}

describe("runGit refuses to execute what the repository tells it to", () => {
  test("an in-tree diff driver does not run during git diff", async () => {
    const { dir, base, marker } = await hostileRepo();
    try {
      const r = await runGit(dir, ["diff", `${base}...HEAD`]);
      // The diff still WORKS — hardening that broke the harvest would be a
      // different failure wearing this test as a disguise.
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("f.txt");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The production path, not just the primitive: `pifleet artifacts` reaches
   * git only through `deriveGitFacts`, so that is where the escape would
   * actually be triggered from.
   */
  test("deriveGitFacts over a hostile worktree executes nothing", async () => {
    const { dir, base, marker } = await hostileRepo();
    try {
      const facts = await deriveGitFacts(dir, base);
      expect(facts.ok).toBe(true);
      expect(facts.facts.files_changed.length).toBeGreaterThan(0);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The harvester's environment must not cross into a subprocess working on a
   * worker-controlled tree. `runGit` used to spread `process.env`, handing it
   * cloud credentials and tokens; `acceptance.ts` next door already built its
   * env from a literal, and the asymmetry was the bug.
   */
  test("the harvester's environment is not inherited by git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-env-"));
    try {
      process.env["PIFLEET_PROBE_SECRET"] = "leaked";
      await runGit(dir, ["init", "-q", "-b", "main"]);
      // `git var` reflects git's own view of its environment; asking for an
      // unset variable is a portable "is it visible in there".
      const r = await runGit(dir, [
        "config",
        "--get-regexp",
        ".*",
      ]);
      expect(r.stdout).not.toContain("leaked");
      const env = await runGit(dir, ["var", "GIT_EDITOR"]);
      expect(env.stdout).not.toContain("leaked");
    } finally {
      delete process.env["PIFLEET_PROBE_SECRET"];
      await rm(dir, { recursive: true, force: true });
    }
  });
});
