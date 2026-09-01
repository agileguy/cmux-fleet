/**
 * Every shipped skill's frontmatter must parse as YAML.
 *
 * This is not style. Pi reads `SKILL.md`'s frontmatter to register the skill,
 * and a file whose frontmatter does not parse is not registered — it is listed
 * under `[Skill conflicts]` in the startup banner and then silently absent from
 * `[Skills]`. The worker boots, looks healthy, and simply does not have the
 * skill its role declares.
 *
 * Measured 2026-08-31, from a live worker: `observer-ops` shipped a description
 * reading `... the mode: deploy and mode: inquiry task shapes ...`. Unquoted,
 * `mode:` inside a plain scalar makes YAML try to open a nested mapping, so the
 * whole document failed with "Nested mappings are not allowed in compact
 * mappings at line 2, column 14" and `observer`'s own skill never loaded. The
 * `fleet.yaml` referenced it, the mount delivered it, and every config check
 * passed — this failure lives entirely inside a file nothing else parses.
 *
 * A colon-space is the trap and it is easy to write, because a description
 * naturally names the field values a skill deals in.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

const SKILLS = join(new URL("../..", import.meta.url).pathname, "skills");

const skillDirs = readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory());

describe("shipped skill frontmatter", () => {
  test("the scan found the skills tree, not an empty glob", () => {
    expect(skillDirs.length).toBeGreaterThan(1);
  });

  for (const dir of skillDirs) {
    test(`${dir}/SKILL.md has frontmatter that parses, with name and description`, () => {
      const raw = readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8");
      // Frontmatter is the block between the first two `---` fences.
      const m = /^---\n([\s\S]*?)\n---/.exec(raw);
      expect(m).not.toBeNull();

      let parsed: unknown;
      expect(() => {
        parsed = YAML.parse(m![1]!);
      }).not.toThrow();

      const fm = parsed as { name?: unknown; description?: unknown };
      // `name` is what Pi registers the skill under; a mismatch with the
      // directory is how a role's `skills:` entry resolves to nothing.
      expect(fm.name).toBe(dir);
      expect(typeof fm.description).toBe("string");
      expect((fm.description as string).length).toBeGreaterThan(0);
    });
  }
});
