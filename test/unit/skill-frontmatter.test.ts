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
 *
 * This file scans two trees, not one. `skills/*SKILL.md` is the WORKER skill
 * tree — staged per role and mounted at `/skills:ro` inside a container. This
 * repo also tracks one OPERATOR skill, `.claude/skills/fleet/SKILL.md`, read
 * by the CLI/agent driving the fleet rather than by a worker, and it is just
 * as capable of failing the same way — SRD-OBSERVER-ROLES Phase 6 task 6.1
 * changed its frontmatter (the rename to the `fleet` skill's current
 * description), and this test file is that task's acceptance.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

const ROOT = new URL("../..", import.meta.url).pathname;
const SKILLS = join(ROOT, "skills");
const FLEET_SKILL = join(ROOT, ".claude/skills/fleet/SKILL.md");

const skillDirs = readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory());

/**
 * Parse one SKILL.md's frontmatter and assert it carries a `name` matching
 * `expectedName` and a non-empty string `description`. Shared by the worker
 * skill tree and the repo-tracked operator skill, so a frontmatter bug is
 * caught the same way in both.
 */
function expectValidFrontmatter(path: string, expectedName: string) {
  const raw = readFileSync(path, "utf8");
  // Frontmatter is the block between the first two `---` fences.
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  expect(m).not.toBeNull();

  let parsed: unknown;
  expect(() => {
    parsed = YAML.parse(m![1]!);
  }).not.toThrow();

  const fm = parsed as { name?: unknown; description?: unknown };
  // `name` is what Pi registers the skill under; a mismatch with the
  // directory (or, for the fleet skill, with its own declared name) is how a
  // role's `skills:` entry resolves to nothing.
  expect(fm.name).toBe(expectedName);
  expect(typeof fm.description).toBe("string");
  expect((fm.description as string).length).toBeGreaterThan(0);
}

describe("shipped skill frontmatter", () => {
  test("the scan found the skills tree, not an empty glob", () => {
    expect(skillDirs.length).toBeGreaterThan(1);
  });

  for (const dir of skillDirs) {
    test(`${dir}/SKILL.md has frontmatter that parses, with name and description`, () => {
      expectValidFrontmatter(join(SKILLS, dir, "SKILL.md"), dir);
    });
  }
});

describe("repo-tracked operator skill frontmatter", () => {
  // Not a directory scan — there is exactly one operator skill tracked in
  // this repo — so the anti-empty-glob check here is that the path this
  // test reads actually resolves to a real file, rather than that a glob
  // found more than one entry. A skill that moved or was renamed would
  // otherwise silently drop this describe block's only assertions instead
  // of failing them.
  test("the fleet skill path resolves to a real file, not a missing one", () => {
    expect(statSync(FLEET_SKILL).isFile()).toBe(true);
  });

  test(".claude/skills/fleet/SKILL.md has frontmatter that parses, with name and description", () => {
    // `name: fleet` — read from the file itself, current as of Phase 6 task 6.1.
    expectValidFrontmatter(FLEET_SKILL, "fleet");
  });
});
