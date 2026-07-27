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
import { detectRepoHazards, neutralizeRepoHazards } from "../../src/security/repo-hazards.ts";

async function gitConfigGet(dir: string, key: string): Promise<string | null> {
  const p = Bun.spawn(["git", "-C", dir, "config", "--get", key], { stdout: "pipe", stderr: "pipe" });
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
    // `ignorecase` deliberately: the sibling must be a key that names no
    // program, or it is itself a hazard and gets quarantined too — which is
    // correct behaviour that would make this test fail for the wrong reason.
    const dir = await repoWithConfig('[core] hooksPath = /tmp/evil\n\tignorecase = true\n');
    try {
      expect(await gitConfigGet(dir, "core.ignorecase")).toBe("true");
      await neutralizeRepoHazards(dir);
      expect(await gitConfigGet(dir, "core.hookspath")).toBeNull();
      expect(await gitConfigGet(dir, "core.ignorecase")).toBe("true");
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
