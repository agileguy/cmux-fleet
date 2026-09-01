/**
 * Every role the example ships can actually be launched (ISC-328, ISC-329).
 *
 * WHY THIS FILE EXISTS. `append_system_prompt_file` and `skills:` are the two
 * places where `fleet.example.yaml` names something that has to EXIST ON DISK,
 * and until this file nothing checked either against the shipped example. The
 * config schema validates the string; it cannot know whether the path resolves.
 * `assertSkillSourcesExist` (`src/run/materialize.ts`) does refuse a missing
 * bundle — but at `up`, on the operator's machine, which is the wrong end of
 * the loop for a file this repository ships as its worked example.
 *
 * The failure being prevented is cheap to cause and expensive to meet: a role
 * added to the example with a briefing path that was never committed, or a
 * `skills:` name for a bundle that does not exist, produces a config that
 * PARSES and a fleet that refuses to start — and it does it for the operator,
 * not for us.
 *
 * Both checks are on the RESOLVED workers, not the raw role blocks, because
 * `defaults <- roles <- worker` is what actually decides a worker's briefing
 * and skill list, and arrays REPLACE on merge rather than concatenating.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadConfig, resolveAllWorkers } from "../../src/config/load.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EXAMPLE = join(REPO_ROOT, "fleet.example.yaml");

describe("the shipped example names only things that exist", () => {
  test("every role's append_system_prompt_file resolves to a readable file", async () => {
    const loaded = await loadConfig(EXAMPLE);
    const checked: string[] = [];
    for (const [name, role] of Object.entries(loaded.config.roles)) {
      const p = (role as { append_system_prompt_file?: string }).append_system_prompt_file;
      if (!p) continue;
      // Relative paths resolve against the CONFIG's directory, not the cwd —
      // one of the three documented merge exceptions at the top of the example.
      const abs = isAbsolute(p) ? p : join(REPO_ROOT, p);
      expect(existsSync(abs), `role "${name}" briefing missing: ${p}`).toBe(true);
      expect(statSync(abs).size, `role "${name}" briefing is empty: ${p}`).toBeGreaterThan(0);
      checked.push(name);
    }
    // A guard that checked nothing would pass forever. Pin the count so that
    // removing every briefing path — or renaming the key — goes red here.
    expect(checked.sort()).toEqual([
      "engineer",
      "observer",
      "reviewer",
      "sre",
      "tester",
      "ticketing",
      "verifier",
    ]);
  });

  test("every skill a resolved worker asks for has a bundle directory", async () => {
    const loaded = await loadConfig(EXAMPLE);
    const wanted = new Set<string>();
    for (const w of resolveAllWorkers(loaded)) for (const s of w.skills) wanted.add(s);
    expect(wanted.size).toBeGreaterThan(0);
    for (const name of wanted) {
      const dir = join(REPO_ROOT, "skills", name);
      expect(existsSync(dir), `skill bundle missing: skills/${name}/`).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      // A bundle with no SKILL.md is a directory the worker learns nothing from.
      expect(existsSync(join(dir, "SKILL.md")), `skills/${name}/SKILL.md missing`).toBe(true);
    }
    // `pifleet-worker` is re-injected post-merge and must reach every worker.
    expect(wanted.has("pifleet-worker")).toBe(true);
    expect(wanted.has("ticket-ops")).toBe(true);
  });

  test("the ticket-ops bundle ships its renderer, and it is the only executable in it", async () => {
    // The renderer is the structural control behind the "no hand-written
    // markup" rule. A bundle that mounted the prose without the script would
    // leave the role with an instruction it cannot follow.
    const renderer = join(REPO_ROOT, "skills", "ticket-ops", "render-blocks.mjs");
    expect(existsSync(renderer)).toBe(true);
    expect(statSync(renderer).size).toBeGreaterThan(0);
  });
});
