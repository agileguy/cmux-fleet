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

/**
 * A repo whose second commit weaponizes `git diff` against its reader.
 *
 * `drivers` selects which execution primitives the diff driver defines. This
 * is parameterized rather than fixed because the original fixture defined only
 * `command`, and that single choice hid a live escape for a whole phase: with
 * `command` present it always wins, so a `textconv` that would have run in its
 * absence never gets the chance, and the test named "executes nothing" passes
 * while proving only that the winner was blocked.
 */
async function hostileRepo(
  drivers: ReadonlyArray<"command" | "textconv"> = ["command"],
): Promise<{ dir: string; base: string; markers: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-hostile-"));
  const markers: Record<string, string> = {};
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
  let block = '\n[diff "evil"]\n';
  for (const d of drivers) {
    markers[d] = join(dir, `PWNED-${d}`);
    // textconv must still emit the blob on stdout, or git reports an error
    // instead of a diff and the probe cannot tell "blocked" from "broken".
    block += d === "command" ? `\tcommand = touch ${markers[d]}\n` : `\ttextconv = sh -c 'touch ${markers[d]}; cat "$1"' --\n`;
  }
  await writeFile(cfg, `${await Bun.file(cfg).text()}${block}`);
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-qm", "attack"]);
  return { dir, base, markers };
}

describe("runGit refuses to execute what the repository tells it to", () => {
  test("an in-tree diff driver does not run during git diff", async () => {
    const { dir, base, markers } = await hostileRepo();
    try {
      const r = await runGit(dir, ["diff", `${base}...HEAD`]);
      // The diff still WORKS — hardening that broke the harvest would be a
      // different failure wearing this test as a disguise.
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("f.txt");
      expect(await Bun.file(markers["command"]!).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `textconv` is the other half of the primitive, and it is the half that
   * `--no-ext-diff` alone does not reach.
   */
  test("a textconv driver does not run during git diff", async () => {
    const { dir, base, markers } = await hostileRepo(["textconv"]);
    try {
      const r = await runGit(dir, ["diff", `${base}...HEAD`]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("f.txt");
      expect(await Bun.file(markers["textconv"]!).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The regression that motivated `--no-textconv`: with BOTH drivers defined,
   * `command` wins under plain git, so blocking only `command` hands control
   * to `textconv` — strictly worse than no hardening, because the dormant
   * driver becomes the live one. Neither may run.
   */
  test("blocking the external diff does not activate textconv instead", async () => {
    const { dir, base, markers } = await hostileRepo(["command", "textconv"]);
    try {
      const r = await runGit(dir, ["diff", `${base}...HEAD`]);
      expect(r.code).toBe(0);
      expect(await Bun.file(markers["command"]!).exists()).toBe(false);
      expect(await Bun.file(markers["textconv"]!).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `diff` is not the only subcommand that renders content through a driver;
   * `log -p` and `show` do too, and both are in `EXT_DIFF_COMMANDS`.
   */
  test.each(["log", "show"])("%s runs neither driver", async (sub) => {
    const { dir, markers } = await hostileRepo(["command", "textconv"]);
    try {
      const r = await runGit(dir, [sub, "-p", "-1"]);
      expect(r.code).toBe(0);
      expect(await Bun.file(markers["command"]!).exists()).toBe(false);
      expect(await Bun.file(markers["textconv"]!).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The driver-suppression flags are diff-family only. If one ever migrates
   * into the global list, every one of these fails with "unknown option" —
   * which has happened once already, silently, because the unit tests only
   * exercise the output parsers.
   */
  test.each([
    ["rev-parse", ["rev-parse", "HEAD"]],
    ["merge-base", ["merge-base", "HEAD", "HEAD"]],
  ])("%s still works — driver flags must not be global", async (_name, argv) => {
    const { dir } = await hostileRepo();
    try {
      const r = await runGit(dir, argv as string[]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
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
    // BOTH drivers, because `deriveGitFacts` issues a content diff and the
    // single-driver fixture this test originally used could not distinguish
    // "nothing ran" from "the other one ran".
    const { dir, base, markers } = await hostileRepo(["command", "textconv"]);
    try {
      const facts = await deriveGitFacts(dir, base);
      expect(facts.ok).toBe(true);
      expect(facts.facts.files_changed.length).toBeGreaterThan(0);
      for (const m of Object.values(markers)) {
        expect(await Bun.file(m).exists()).toBe(false);
      }
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
