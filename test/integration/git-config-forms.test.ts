/**
 * The `.git/config` scanner, graded against git itself (SRD §12.2).
 *
 * A hazard scanner that parses a format differently from the program it is
 * defending against is not a scanner, it is a second opinion. Every case here
 * asks `git config --get` for the EFFECTIVE value and compares it with what
 * `scanRepoHazards` concluded, so neither side is graded against the test
 * author's idea of the format. That framing is what caught the original
 * defects: five of eight accepted forms were honoured by git and invisible to
 * the scanner.
 *
 * Two distinct bugs produced those five:
 *
 *   `[core] hooksPath = x`   header and key on ONE line. The header pattern
 *                            was anchored `\]\s*$` and the key pattern demanded
 *                            the line start with a key, so a line with both
 *                            matched neither and vanished entirely.
 *
 *   CRLF endings             `.` in a JS regex excludes `\r`, so the value
 *                            capture could not reach `$`. The header line still
 *                            parsed, so `section` tracked correctly and only the
 *                            keys disappeared — selective and silent.
 *
 * Detection alone is not the property under test. Neutralization must make git
 * stop honouring the setting, must leave the file parseable, and must not
 * disturb unrelated keys — a quarantine that comments out a shared line would
 * take the section header with it and silently re-parent everything below.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_HAZARDS, detectRepoHazards, neutralizeRepoHazards } from "../../src/security/repo-hazards.ts";

/**
 * Ask git for the effective value, with the MACHINE'S config held out.
 *
 * Without the two `GIT_CONFIG_*` overrides this reads the developer's own
 * `~/.gitconfig`: `core.editor` came back `"code --wait"` and
 * `credential.helper` came back `"osxkeychain"`, so a key correctly stripped
 * from the repo still looked honoured and the test failed on a machine
 * setting rather than on the code. It would also have passed for the wrong
 * reason anywhere those keys happen to be unset — a test whose verdict
 * depends on whose laptop it runs on.
 *
 * The repo config is what this scanner defends against and is unaffected by
 * these variables, so scoping to it is exact rather than approximate.
 */
async function gitConfigGet(dir: string, key: string): Promise<string | null> {
  const p = Bun.spawn(["git", "-C", dir, "config", "--get", key], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 ? out : null;
}

/** A fresh repo whose `.git/config` has `fragment` appended verbatim. */
async function repoWithConfig(fragment: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-cfgform-"));
  await Bun.spawn(["git", "-C", dir, "init", "-q", "."], { stdout: "pipe", stderr: "pipe" }).exited;
  const cfg = join(dir, ".git", "config");
  await writeFile(cfg, (await readFile(cfg, "utf8")) + fragment, "utf8");
  return dir;
}

/** Every form is one git accepts; the key is what git calls the setting. */
const FORMS: ReadonlyArray<{ name: string; fragment: string; key: string }> = [
  { name: "key on its own line", fragment: '[core]\n\thooksPath = /tmp/evil\n', key: "core.hookspath" },
  { name: "header and key on one line", fragment: '[core] hooksPath = /tmp/evil\n', key: "core.hookspath" },
  { name: "comment after header", fragment: '[core] # note\n\thooksPath = /tmp/evil\n', key: "core.hookspath" },
  { name: "CRLF endings", fragment: '[core]\r\n\thooksPath = /tmp/evil\r\n', key: "core.hookspath" },
  { name: "quoted value", fragment: '[core]\n\thooksPath = "/tmp/evil"\n', key: "core.hookspath" },
  { name: "diff driver on one line", fragment: '[diff "pwn"] command = /tmp/evil\n', key: "diff.pwn.command" },
  { name: "filter on one line", fragment: '[filter "p"] clean = /tmp/evil\n', key: "filter.p.clean" },
  { name: "includeIf on one line", fragment: '[includeIf "gitdir:/"] path = /tmp/evil\n', key: "includeif.gitdir:/.path" },
];

describe("the .git/config scanner sees every form git honours", () => {
  test.each(FORMS.map((f) => [f.name, f] as const))("%s is detected", async (_name, form) => {
    const dir = await repoWithConfig(form.fragment);
    try {
      // Precondition: git really does honour this. A form git ignores would
      // make the detection assertion below pass for the wrong reason.
      expect(await gitConfigGet(dir, form.key)).not.toBeNull();

      const hazards = await detectRepoHazards(dir);
      expect(hazards.some((h) => h.path.endsWith("config"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each(FORMS.map((f) => [f.name, f] as const))(
    "%s stops being honoured after neutralization",
    async (_name, form) => {
      const dir = await repoWithConfig(form.fragment);
      try {
        expect(await gitConfigGet(dir, form.key)).not.toBeNull();
        const hazards = await neutralizeRepoHazards(dir);
        expect(hazards.every((h) => h.neutralized)).toBe(true);
        // The property that matters. Detection without this is theatre.
        expect(await gitConfigGet(dir, form.key)).toBeNull();
        // Still a parseable config, not a file git now refuses.
        expect(await gitConfigGet(dir, "core.repositoryformatversion")).not.toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  /**
   * The regression the header-split quarantine exists for: commenting out a
   * line that carries BOTH a header and a hazard would comment out the header,
   * silently re-parenting every following indented key to the previous section.
   */
  test("quarantining a shared line preserves the section for the keys below it", async () => {
    // `[sequence]`, NOT `[core]`, and this choice is the whole test.
    //
    // The first version used `[core] hooksPath = …` with an `ignorecase`
    // sibling, and it passed even against a naive whole-line comment-out —
    // because `repoWithConfig` APPENDS to the config `git init` already wrote,
    // which itself ends in `[core]`. Commenting out the shared header simply
    // re-parented the orphan to that pre-existing `[core]`, so
    // `core.ignorecase` was still readable and the assertion held. The fixture
    // cancelled the exact defect the test is named for; reverting the split
    // left the suite green.
    //
    // A fresh `.git/config` has no `[sequence]`, so if the header is lost the
    // orphan lands under `[core]` and `sequence.foo` becomes unreadable —
    // which is what makes the two behaviours distinguishable at all.
    const dir = await repoWithConfig("[sequence] editor = /tmp/evil\n\tfoo = keepme\n");
    try {
      expect(await gitConfigGet(dir, "sequence.foo")).toBe("keepme");
      await neutralizeRepoHazards(dir);
      expect(await gitConfigGet(dir, "sequence.editor")).toBeNull();
      // Still in ITS OWN section, not re-parented into `[core]`.
      expect(await gitConfigGet(dir, "sequence.foo")).toBe("keepme");
      expect(await gitConfigGet(dir, "core.foo")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `.git/info/attributes` is the untracked, repository-local twin of
   * `.gitattributes`, and `-c core.attributesFile=/dev/null` does NOT suppress
   * it — that flag overrides only the global/user file. Confirmed by running:
   * with no `.gitattributes` anywhere in the tree, a driver assigned here ran
   * the filter's smudge program on checkout.
   */
  test(".git/info/attributes driver assignments are detected", async () => {
    const dir = await repoWithConfig("");
    try {
      await mkdir(join(dir, ".git", "info"), { recursive: true });
      await writeFile(join(dir, ".git", "info", "attributes"), "*.bin filter=pwn\n", "utf8");
      // Precondition: git really does honour this file.
      const p = Bun.spawn(["git", "-C", dir, "check-attr", "filter", "--", "x.bin"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await new Response(p.stdout).text()).toContain("filter: pwn");

      const hazards = await detectRepoHazards(dir);
      expect(hazards.some((h) => h.path.includes("attributes"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(".git/info/attributes stops assigning the driver after neutralization", async () => {
    const dir = await repoWithConfig("");
    try {
      await mkdir(join(dir, ".git", "info"), { recursive: true });
      // An unrelated entry that must survive — a rename-aside quarantine would
      // take it with the hazard, which is why this file is commented in place.
      await writeFile(join(dir, ".git", "info", "attributes"), "*.bin filter=pwn\n*.txt text\n", "utf8");
      const hazards = await neutralizeRepoHazards(dir);
      expect(hazards.every((h) => h.neutralized)).toBe(true);

      const attr = async (key: string, path: string): Promise<string> => {
        const p = Bun.spawn(["git", "-C", dir, "check-attr", key, "--", path], {
          stdout: "pipe",
          stderr: "pipe",
        });
        return await new Response(p.stdout).text();
      };
      expect(await attr("filter", "x.bin")).not.toContain("filter: pwn");
      expect(await attr("text", "x.txt")).toContain("text: set");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The module's docstring claimed `.pi/settings.json` was covered while the
   * scan list contained no such entry — a comment asserting a control that had
   * never existed.
   */
  test(".pi/settings.json is detected and neutralized", async () => {
    const dir = await repoWithConfig("");
    try {
      await mkdir(join(dir, ".pi"), { recursive: true });
      await writeFile(join(dir, ".pi", "settings.json"), '{"extensions":{"enabled":true}}', "utf8");
      const hazards = await neutralizeRepoHazards(dir);
      const hit = hazards.filter((h) => h.path.includes("settings.json"));
      expect(hit).toHaveLength(1);
      expect(hit[0]!.neutralized).toBe(true);
      expect(await Bun.file(join(dir, ".pi", "settings.json")).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Every key in `CONFIG_HAZARDS` that names a program git will execute.
   *
   * Six of these were added in one commit with no test at all, so deleting all
   * six left the suite green — coverage claimed by a hazard list rather than
   * by anything that runs. That is the same defect the `.pi/settings.json`
   * docstring had, committed by the same hand that had just called it out.
   *
   * Table-driven so adding a key to `CONFIG_HAZARDS` without adding a row here
   * is visible: the count assertion below fails when the two drift.
   */
  const PROGRAM_KEYS: ReadonlyArray<{ key: string; fragment: string }> = [
    { key: "core.hookspath", fragment: "[core]\n\thooksPath = /tmp/evil\n" },
    { key: "core.fsmonitor", fragment: "[core]\n\tfsmonitor = /tmp/evil\n" },
    { key: "core.pager", fragment: "[core]\n\tpager = /tmp/evil\n" },
    { key: "core.sshcommand", fragment: "[core]\n\tsshCommand = /tmp/evil\n" },
    { key: "core.editor", fragment: "[core]\n\teditor = /tmp/evil\n" },
    { key: "sequence.editor", fragment: "[sequence]\n\teditor = /tmp/evil\n" },
    { key: "credential.helper", fragment: "[credential]\n\thelper = /tmp/evil\n" },
    { key: "gpg.program", fragment: "[gpg]\n\tprogram = /tmp/evil\n" },
    { key: "uploadpack.packobjectshook", fragment: "[uploadpack]\n\tpackObjectsHook = /tmp/evil\n" },
    { key: "pager.log", fragment: "[pager]\n\tlog = /tmp/evil\n" },
    { key: "diff.pwn.command", fragment: '[diff "pwn"]\n\tcommand = /tmp/evil\n' },
    { key: "diff.pwn.textconv", fragment: '[diff "pwn"]\n\ttextconv = /tmp/evil\n' },
    { key: "filter.pwn.clean", fragment: '[filter "pwn"]\n\tclean = /tmp/evil\n' },
    { key: "filter.pwn.smudge", fragment: '[filter "pwn"]\n\tsmudge = /tmp/evil\n' },
    { key: "filter.pwn.process", fragment: '[filter "pwn"]\n\tprocess = /tmp/evil\n' },
    { key: "include.path", fragment: "[include]\n\tpath = /tmp/evil\n" },
    // Top-level `[diff]`, which `/^diff\./` could never reach.
    { key: "diff.external", fragment: "[diff]\n\texternal = /tmp/evil\n" },
    { key: "core.attributesfile", fragment: "[core]\n\tattributesFile = /tmp/evil\n" },
    { key: "protocol.ext.allow", fragment: '[protocol "ext"]\n\tallow = /tmp/evil\n' },
    { key: "merge.pwn.driver", fragment: '[merge "pwn"]\n\tdriver = /tmp/evil\n' },
    { key: "init.templatedir", fragment: "[init]\n\ttemplateDir = /tmp/evil\n" },
    { key: "remote.origin.uploadpack", fragment: '[remote "origin"]\n\tuploadpack = /tmp/evil\n' },
  ];

  test.each(PROGRAM_KEYS.map((k) => [k.key, k] as const))(
    "%s is detected and stops being honoured",
    async (_name, spec) => {
      const dir = await repoWithConfig(spec.fragment);
      try {
        // Precondition: git honours it. Without this a typo in the fragment
        // would make the detection assertion pass against nothing.
        expect(await gitConfigGet(dir, spec.key)).toBe("/tmp/evil");
        const hazards = await neutralizeRepoHazards(dir);
        expect(hazards.some((h) => h.path.endsWith("config"))).toBe(true);
        // Not `toBeNull()`: Apple's git ships
        // `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig`,
        // which sets `credential.helper=osxkeychain` and is NOT suppressed by
        // `GIT_CONFIG_SYSTEM=/dev/null`. The property under test is that the
        // REPOSITORY'S value stopped being honoured, not that the key is
        // globally unset — asserting absence would make the verdict depend on
        // how the machine's git was installed.
        expect(await gitConfigGet(dir, spec.key)).not.toBe("/tmp/evil");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  /**
   * Guards the table above against silently falling behind the source list.
   * A new hazard pattern with no row here means an undetected key shipped
   * with the suite green, which is exactly how the six arrived.
   */
  test("every CONFIG_HAZARDS pattern has a case in this file", () => {
    expect(CONFIG_HAZARDS.length).toBe(17);
    expect(PROGRAM_KEYS.length).toBe(22);
  });

  /**
   * Git honours a `.gitattributes` in EVERY directory. The first version of
   * this scan covered only `.git/info/attributes` — the untracked, rarest
   * source — and missed the root and nested tracked files, which are the ones
   * a hostile repo actually commits. Covering the exotic case while missing
   * the ordinary one is worse than no scan, because the report reads complete.
   */
  test.each([
    [".git/info/attributes", join(".git", "info", "attributes")],
    ["root .gitattributes", ".gitattributes"],
    ["nested sub/.gitattributes", join("sub", ".gitattributes")],
    ["deep a/b/c/.gitattributes", join("a", "b", "c", ".gitattributes")],
  ])("%s is seen by the scanner", async (_name, rel) => {
    const dir = await repoWithConfig("");
    try {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), "*.bin filter=pwn\n", "utf8");
      // Precondition: git honours this file at this location.
      const probe = join(rel, "..", "x.bin");
      const p = Bun.spawn(["git", "-C", dir, "check-attr", "filter", "--", probe], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await new Response(p.stdout).text()).toContain("filter: pwn");

      const hazards = await detectRepoHazards(dir);
      expect(hazards.some((h) => h.path.includes("attributes"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `.git/config.worktree` is a SECOND honoured config file, switched on by
   * `extensions.worktreeConfig`. Scanning only `.git/config` left it entirely
   * invisible — and an unscanned file is worse than an unparsed form, because
   * no amount of parser correctness reaches it.
   */
  test(".git/config.worktree is scanned too", async () => {
    const dir = await repoWithConfig("[extensions]\n\tworktreeConfig = true\n");
    try {
      await writeFile(
        join(dir, ".git", "config.worktree"),
        "[core]\n\thooksPath = /tmp/evil-worktree\n",
        "utf8",
      );
      expect(await gitConfigGet(dir, "core.hookspath")).toBe("/tmp/evil-worktree");
      const hazards = await detectRepoHazards(dir);
      expect(hazards.some((h) => h.path.includes("config.worktree"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Two headers on one line. Consuming only the FIRST left the remainder still
   * starting with `[`, so the key regex never matched — the same vanishing-line
   * bug the non-anchored header was introduced to fix, one header along.
   */
  test("a key after a second header on the same line is detected", async () => {
    const dir = await repoWithConfig("[foo] [core] hooksPath = /tmp/evil\n");
    try {
      expect(await gitConfigGet(dir, "core.hookspath")).toBe("/tmp/evil");
      const hazards = await neutralizeRepoHazards(dir);
      expect(hazards.some((h) => h.path.endsWith("config"))).toBe(true);
      expect(await gitConfigGet(dir, "core.hookspath")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Re-scanning must not re-flag what is already quarantined (idempotence). */
  test("a second neutralization pass finds nothing left to defuse", async () => {
    const dir = await repoWithConfig('[core] hooksPath = /tmp/evil\n');
    try {
      expect((await neutralizeRepoHazards(dir)).length).toBeGreaterThan(0);
      const second = await neutralizeRepoHazards(dir);
      expect(second.filter((h) => h.path.endsWith("config"))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
