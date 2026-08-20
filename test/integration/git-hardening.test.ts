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
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/harvest/git.ts";
import { deriveGitFacts } from "../../src/harvest/git.ts";
import { resolveFromEnvelope, resolveFromTree, runAcceptance } from "../../src/harvest/acceptance.ts";
import { Deadline } from "../../src/util/clock.ts";
import { cliBudget } from "../support/budget.ts";

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
  }, cliBudget(2));

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
  }, cliBudget(2));

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
  }, cliBudget(2));

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
  }, cliBudget(2));

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
  }, cliBudget(2));

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
  }, cliBudget(2));

  /**
   * The harvester's environment must not cross into a subprocess working on a
   * worker-controlled tree. `runGit` used to spread `process.env`, handing it
   * cloud credentials and tokens; `acceptance.ts` next door already built its
   * env from a literal, and the asymmetry was the bug.
   */
  test("the harvester's environment is not inherited by git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-env-"));
    // Captured, not assumed absent (ISC-278). An unconditional `delete` in the
    // `finally` is harmless when the variable was unset — the usual case, which
    // is why it survives review — and destructive when it was not: it clears an
    // operator's real value and leaves the process environment different at
    // exit from what it was at load.
    const priorSecret = process.env["PIFLEET_PROBE_SECRET"];
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
      if (priorSecret === undefined) delete process.env["PIFLEET_PROBE_SECRET"];
      else process.env["PIFLEET_PROBE_SECRET"] = priorSecret;
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(3));
});

/**
 * Review finding 1 — the global ATTRIBUTES file.
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` neutralizes `~/.gitconfig` AND
 * `$XDG_CONFIG_HOME/git/config`. It does NOT touch the global attributes file,
 * `$HOME/.config/git/attributes`, which has no `GIT_CONFIG_*` equivalent and is
 * reachable only through `core.attributesFile` on the command line. That
 * mattered because `harvest/acceptance.ts` ran git with `HOME` pointed at
 * `resolve(repo)` — the tree the graded worker writes to — so a worker could
 * commit its own global attributes file.
 *
 * Measured on git 2.50.1 while fixing this, with the acceptance environment and
 * no hardening flags:
 *
 *   cat-file --textconv + committed .config/git/attributes   DRIVER RAN
 *   cat-file --textconv + in-tree .gitattributes             DRIVER RAN
 *   show <sha>:<path>   + either attributes source           driver did not run
 *
 * The last row is why the fix is the flag and not the argv: `git show
 * <sha>:<path>` does not request textconv, so the chain stopped one link short
 * of executing — a property of the subcommand in use today, not a defence. The
 * probe below therefore drives the case that DOES execute, because a test built
 * on the case that never executes would pass with the hardening removed.
 */
describe("the global attributes file is not a way in (finding 1)", () => {
  /** A repo that commits its own `$HOME/.config/git/attributes`. */
  async function xdgAttributeRepo(): Promise<{ dir: string; base: string; marker: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-xdg-"));
    await runGit(dir, ["init", "-q", "-b", "main"]);
    await runGit(dir, ["config", "user.email", "worker@example.invalid"]);
    await runGit(dir, ["config", "user.name", "worker"]);
    await writeFile(join(dir, "ACCEPTANCE"), "true\n");
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-qm", "base"]);
    const base = (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();

    // The driver is a standalone executable, not a quoted shell fragment:
    // a mis-quoted driver fails to run for the wrong reason and reads as
    // "blocked" when it was only broken.
    const marker = join(dir, "PWNED-xdg");
    const drv = join(dir, "drv.sh");
    await writeFile(drv, `#!/bin/sh\ntouch "${marker}"\n[ -f "$1" ] && cat "$1"\nexit 0\n`);
    await chmod(drv, 0o755);

    await mkdir(join(dir, ".config", "git"), { recursive: true });
    await writeFile(join(dir, ".config", "git", "attributes"), "* diff=evil\n");
    const cfg = join(dir, ".git", "config");
    await writeFile(cfg, `${await Bun.file(cfg).text()}\n[diff "evil"]\n\ttextconv = ${drv}\n`);
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-qm", "attack"]);
    return { dir, base, marker };
  }

  /**
   * The discriminating probe. `cat-file` is not in `EXT_DIFF_COMMANDS`, so
   * `--no-textconv` is never appended to it and the ONLY thing standing between
   * this repo and an executed program is `-c core.attributesFile=/dev/null`.
   * Drop that one flag and this test goes red — verified by doing exactly that.
   */
  test("a committed .config/git/attributes cannot name a program git runs", async () => {
    const { dir, base, marker } = await xdgAttributeRepo();
    try {
      const r = await runGit(dir, ["cat-file", "--textconv", `${base}:ACCEPTANCE`]);
      expect(r.code).toBe(0);
      // Still reads the blob — hardening that broke the read would be a
      // different failure wearing this test as a disguise.
      expect(r.stdout).toContain("true");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(2));

  /**
   * The same repository through `acceptance.ts`'s own entry point. This is the
   * call that ran with `HOME` inside the worker's tree.
   */
  test("resolveFromTree over that repo executes nothing", async () => {
    const { dir, base, marker } = await xdgAttributeRepo();
    try {
      const cmds = await resolveFromTree(dir, base, "ACCEPTANCE");
      expect(cmds.map((c) => c.cmd)).toEqual(["true"]);
      expect(cmds[0]?.resolved_from).toBe(base);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(2));
});

/**
 * `acceptance.ts` spawns git at three sites that carried no hardening at all
 * for a whole phase. Nothing above can catch a regression there by observing
 * behaviour, because none of those three argvs executes a driver today — so
 * these pin the spawn itself: every git process this subsystem starts is
 * built by `hardenedGitArgv` and handed `HERMETIC_GIT_ENV`.
 *
 * Reverting either call site to its previous bare argv fails these.
 */
describe("every git spawn in acceptance.ts is hardened (finding 1)", () => {
  /** Record the argv and env of every process spawned inside `fn`. */
  async function captureSpawns(
    fn: () => Promise<unknown>,
  ): Promise<Array<{ argv: string[]; env: Record<string, string> }>> {
    const real = Bun.spawn;
    const seen: Array<{ argv: string[]; env: Record<string, string> }> = [];
    try {
      Bun.spawn = ((...args: unknown[]) => {
        // runGit passes (argv, opts); execBounded passes a single options object.
        const first = args[0];
        const opts = (Array.isArray(first) ? args[1] : first) as
          | { cmd?: string[]; env?: Record<string, string> }
          | undefined;
        const argv = Array.isArray(first) ? (first as string[]) : (opts?.cmd ?? []);
        seen.push({ argv, env: opts?.env ?? {} });
        return (real as unknown as (...a: unknown[]) => unknown)(...args);
      }) as typeof Bun.spawn;
      await fn();
    } finally {
      Bun.spawn = real;
    }
    return seen;
  }

  const PINS = [
    "core.fsmonitor=",
    "core.hooksPath=/dev/null",
    "core.attributesFile=/dev/null",
    "diff.external=",
  ];

  function expectHardened(spawn: { argv: string[]; env: Record<string, string> }): void {
    const joined = spawn.argv.join(" ");
    for (const pin of PINS) expect(joined).toContain(pin);
    expect(spawn.argv).toContain("--no-pager");
    // HOME used to be `resolve(repo)` — inside the tree the worker writes to.
    expect(spawn.env["HOME"]).toBe("/dev/null");
    expect(spawn.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(spawn.env["GIT_ATTR_NOSYSTEM"]).toBe("1");
  }

  test("resolveFromTree's `git show` is hardened", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-acc-show-"));
    try {
      await runGit(dir, ["init", "-q", "-b", "main"]);
      await runGit(dir, ["config", "user.email", "w@example.invalid"]);
      await runGit(dir, ["config", "user.name", "w"]);
      await writeFile(join(dir, "ACCEPTANCE"), "true\n");
      await runGit(dir, ["add", "-A"]);
      await runGit(dir, ["commit", "-qm", "base"]);
      const base = (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();

      const spawns = await captureSpawns(() => resolveFromTree(dir, base, "ACCEPTANCE"));
      const shows = spawns.filter((s) => s.argv.includes("show"));
      expect(shows.length).toBe(1);
      expectHardened(shows[0]!);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, cliBudget(7));

  test("runAcceptance's `git clone` and `git checkout` are hardened", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-acc-clone-"));
    const scratch = await mkdtemp(join(tmpdir(), "pifleet-acc-scratch-"));
    try {
      await runGit(dir, ["init", "-q", "-b", "main"]);
      await runGit(dir, ["config", "user.email", "w@example.invalid"]);
      await runGit(dir, ["config", "user.name", "w"]);
      await writeFile(join(dir, "data.txt"), "needle\n");
      await runGit(dir, ["add", "-A"]);
      await runGit(dir, ["commit", "-qm", "base"]);
      const head = (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();

      const spawns = await captureSpawns(() =>
        runAcceptance({
          repo: dir,
          head_sha: head,
          scratch_dir: scratch,
          commands: resolveFromEnvelope(["grep -q needle data.txt"], head),
          deadline: new Deadline(60_000),
          per_command_timeout_ms: 30_000,
        }),
      );

      const clone = spawns.find((s) => s.argv.includes("clone"));
      const checkout = spawns.find((s) => s.argv.includes("checkout"));
      expect(clone).toBeDefined();
      expect(checkout).toBeDefined();
      expectHardened(clone!);
      expectHardened(checkout!);

      // The acceptance COMMAND itself keeps the scratch HOME a real suite needs;
      // only the git plumbing runs hermetic. Conflating the two would either
      // re-open the git hole or break every test suite that writes a cache.
      const cmd = spawns.find((s) => s.argv.includes("grep"));
      expect(cmd).toBeDefined();
      expect(cmd!.env["HOME"]).toBe(scratch);
      expect(cmd!.env["CI"]).toBe("1");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  }, cliBudget(7));
});
