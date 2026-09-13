/**
 * Every test that starts the pifleet CLI goes through `spawnCli` (ISC-296).
 *
 * ## Why a guard rather than a sweep
 *
 * The defect this closes was invisible on CI by construction. Config
 * resolution is `--config` -> `./fleet.yaml` -> `~/.config/pifleet/fleet.yaml`,
 * and a spawn that inherits the developer's cwd discovers a `fleet.yaml` in the
 * repo root. That file was gitignored in August 2026, when this happened, so it
 * existed on laptops and not on runners: the suite was green on CI and failed
 * fifteen tests on a machine with one, with symptoms that pointed at product
 * defects that did not exist.
 *
 * A sweep fixes the files that exist today. It cannot say anything about the
 * file someone writes next month, and that file would have passed CI for
 * exactly the reason the original defect passed CI — the runner had no
 * `fleet.yaml` to discover. This is the same argument ISC-274's budget guard
 * makes, and it applied harder here, because the failure was not merely
 * invisible on CI, it was ANTI-correlated with it: the more hermetic the
 * runner, the less likely CI is to notice that the suite is not.
 *
 * ## What changed on 2026-09-12, and why the guard stays
 *
 * `fleet.yaml` is now TRACKED, so THIS PARTICULAR ASYMMETRY IS OVER: the runner
 * and the laptop both have one, and an ambient-config difference between those
 * two is no longer something a green CI run can hide. The account above is kept
 * in the past tense rather than deleted, because it is the measurement that
 * bought this guard, and a guard whose reason has been edited out gets deleted
 * by the next person to read it.
 *
 * The guard's justification is untouched, because it was never about that one
 * file. It is about a spawn inheriting an ambient cwd AT ALL: the resolution
 * chain still ends at `~/.config/pifleet/fleet.yaml`, which is per-machine and
 * always will be; `fleet-development.yaml` and `fleet-operations-local.yaml`
 * are still ignored by name and still sit in operators' working trees, and
 * `--config` can point at either; and a test that reaches ambient state is
 * wrong even on a day when the ambient state happens to be identical
 * everywhere. Tracking `fleet.yaml` removed one instance of the hazard, not the
 * hazard.
 *
 * ## What is asserted
 *
 * That no test file builds a CLI subprocess itself. `spawnCli` defaults its
 * `cwd` to an empty directory, so a test that forgets to think about config
 * discovery gets the hermetic answer; a test that builds its own `Bun.spawn`
 * inherits the ambient one and nothing says so.
 *
 * Comment-stripped before matching, for the reason `source-structure.ts`
 * gives: a docstring naming a control reads identically to a call using it.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/** The helper itself is the one place allowed to build the subprocess. */
const EXEMPT = new Set([
  "test/support/spawn-cli.ts",
  // This file's own fixtures spell the forbidden shape on purpose, inside
  // string literals — `stripComments` removes comments, not strings.
  "test/unit/hermetic-cli-spawn-guard.test.ts",
]);

async function testFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const root of ["test/integration", "test/e2e", "test/unit"]) {
    const glob = new Bun.Glob(`${root}/**/*.test.ts`);
    for await (const f of glob.scan({ cwd: ROOT })) out.push(f);
  }
  return out.sort();
}

/**
 * A CLI spawn is a subprocess whose argv names the CLI entry point.
 *
 * Matched on the argv rather than on `Bun.spawn` alone, because these files
 * legitimately spawn other things — `git`, `tmux`, `docker`, the fake Pi — and
 * a rule that caught those would be unsatisfiable.
 */
function cliSpawns(stripped: string): string[] {
  const hits: string[] = [];
  const re = /(?:Bun\.spawn|Bun\.spawnSync)\s*\(\s*\[[^\]]*\bCLI\b[^\]]*\]/g;
  for (const m of stripped.matchAll(re)) hits.push(m[0].replace(/\s+/g, " ").slice(0, 90));
  return hits;
}

describe("every CLI spawn is hermetic by construction (ISC-296)", () => {
  test("the scan reaches the tree rather than an empty glob", async () => {
    const files = await testFiles();
    expect(files.length).toBeGreaterThan(30);
  });

  test("no test file builds its own CLI subprocess", async () => {
    const offenders: string[] = [];
    for (const rel of await testFiles()) {
      if (EXEMPT.has(rel)) continue;
      const stripped = stripComments(await readFile(join(ROOT, rel), "utf8"));
      for (const hit of cliSpawns(stripped)) offenders.push(`${rel}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  // The guard is worthless if its matcher cannot see the shape it forbids, and
  // an empty-offender list looks identical whether the rule holds or the regex
  // is broken. Planted rather than hoped for.
  test("the matcher recognises the shape it forbids", () => {
    expect(cliSpawns('Bun.spawn([process.execPath, CLI, ...args], { env })')).toHaveLength(1);
    expect(cliSpawns('Bun.spawn([process.execPath, CLI, "up", "--json"], {})')).toHaveLength(1);
    expect(cliSpawns("Bun.spawnSync([process.execPath, CLI, ...a])")).toHaveLength(1);
    // …and does not fire on the other subprocesses these files legitimately start.
    expect(cliSpawns('Bun.spawn(["git", "-C", repo, "status"])')).toEqual([]);
    expect(cliSpawns('Bun.spawn(["docker", "network", "rm", net])')).toEqual([]);
    expect(cliSpawns('Bun.spawn(["tmux", "kill-server"], { env })')).toEqual([]);
  });
});
