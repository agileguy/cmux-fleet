#!/usr/bin/env bun
/**
 * ISC-22's second half: the coverage report LISTS EVERY `src/` MODULE.
 *
 * The report itself has worked since the criterion was filed, and the one real
 * gap it exposed — `src/cli/commands/tui.ts`, absent because no test imported
 * it — was closed on 2026-08-19. What kept the entry at `[~]` was narrower and
 * is what this file fixes: CI runs `bun test test/unit`, `test/integration` and
 * `test/e2e` and NEVER `bun run test:coverage`, so the "every module" property
 * was re-checked by nothing. A module added tomorrow with no importer would
 * repeat the original defect silently, and the ONLY reason anyone noticed the
 * first one was a human reading a seventy-row table.
 *
 * **BOTH DIRECTIONS, which is the whole design.** A module absent from the
 * report that is not a declared exemption fails — that is the defect. AND a
 * declared exemption that now appears in the report fails too, because a
 * stale exemption is an unexamined claim that quietly grows: the list would
 * otherwise accumulate names nobody re-checks, which is the failure mode the
 * ISA registry (`test/support/isa-claims.ts`) was built to prevent in prose
 * and this prevents in tooling.
 *
 * **WHY A SCRIPT AND NOT A TEST.** The check needs a full profiled run — about
 * 245 seconds — so as a test file it would attach itself to every `bun test`
 * in the repo, including the narrow ones that are the inner loop of working
 * here. `bunfig.toml` explains at length why coverage is a report you ask for.
 * The LOGIC below is pure and is unit-tested in
 * `test/unit/coverage-modules.test.ts`; only the reading of the report and the
 * disk is left to `main`, so the part that can be wrong is the part that is
 * covered.
 */

import { basename } from "node:path";

/**
 * Modules that CANNOT appear in the report, with the structural reason each
 * one cannot. Anything else absent is a defect, not an exemption.
 *
 * This is not "modules we decided not to test". The entry is unreachable by the
 * profiler for a reason no amount of test-writing changes, and the reason is
 * recorded here rather than in the ISA because this is where a future reader
 * meets the list.
 *
 * **THE LIST STARTED WITH TWO AND THE SECOND WAS ALREADY FALSE.** ISA ISC-22
 * recorded `src/supervisor/index.ts` as structurally absent — "only ever
 * loaded as a spawned subprocess" — and the first real run of this checker
 * reported it as a STALE EXEMPTION, because it appears in the report with
 * `LF:1522, LH:28, FNH:0`. Something imports it in-process far enough to
 * execute module-level code without ever calling a function in it. The
 * exemption was removed rather than reworded: the criterion asks that every
 * module be LISTED, and it is listed.
 *
 * Worth knowing while reading that number: being listed is not being
 * exercised. `supervisor/index.ts` sits at 28 of 1522 lines and zero of four
 * functions, and this checker deliberately does not grade that — a coverage
 * THRESHOLD is a different tool with a different failure mode, and
 * `bunfig.toml` records why there isn't one.
 */
export const STRUCTURAL_ABSENCES: ReadonlyMap<string, string> = new Map([
  [
    "src/backends/types.ts",
    "types-only: interfaces and type aliases, no instrumentable statement survives compilation",
  ],
]);

/** Repo-relative `src/` paths the lcov report accounts for. */
export function modulesFromLcov(lcov: string): string[] {
  const out = new Set<string>();
  for (const line of lcov.split("\n")) {
    if (!line.startsWith("SF:")) continue;
    const raw = line.slice(3).trim();
    // lcov paths may be absolute or relative depending on where bun was run;
    // only the repo-relative `src/...` tail is comparable.
    const at = raw.lastIndexOf("src/");
    if (at === -1) continue;
    out.add(raw.slice(at));
  }
  return [...out].sort();
}

export interface ModuleVerdict {
  /** On disk, not in the report, and not a declared exemption. The defect. */
  missing: string[];
  /** Declared exempt but now present in the report. The exemption is stale. */
  staleExemptions: string[];
}

export function compareModules(
  onDisk: readonly string[],
  covered: readonly string[],
  exemptions: ReadonlyMap<string, string> = STRUCTURAL_ABSENCES,
): ModuleVerdict {
  const have = new Set(covered);
  return {
    missing: onDisk.filter((m) => !have.has(m) && !exemptions.has(m)).sort(),
    staleExemptions: [...exemptions.keys()].filter((m) => have.has(m)).sort(),
  };
}

/** Every `.ts` under `src/`, repo-relative, excluding declaration files. */
export async function sourceModules(root: string): Promise<string[]> {
  const glob = new Bun.Glob("src/**/*.ts");
  const out: string[] = [];
  for await (const rel of glob.scan({ cwd: root })) {
    if (basename(rel).endsWith(".d.ts")) continue;
    out.push(rel);
  }
  return out.sort();
}

async function main(): Promise<number> {
  const root = new URL("../", import.meta.url).pathname;
  const lcovPath = `${root}coverage/lcov.info`;
  const file = Bun.file(lcovPath);
  if (!(await file.exists())) {
    console.error(
      `coverage report not found at ${lcovPath}\n` +
        `run \`bun run test:coverage\` first — this script grades a report, it does not produce one`,
    );
    return 2;
  }

  const onDisk = await sourceModules(root);
  const covered = modulesFromLcov(await file.text());
  const { missing, staleExemptions } = compareModules(onDisk, covered);

  console.log(
    `coverage lists ${covered.length} of ${onDisk.length} src/ modules ` +
      `(${STRUCTURAL_ABSENCES.size} structurally absent)`,
  );

  if (missing.length === 0 && staleExemptions.length === 0) return 0;

  for (const m of missing) {
    console.error(
      `MISSING: ${m} is not in the coverage report — nothing imports it in-process.\n` +
        `  Either add a test that imports it, or declare it in STRUCTURAL_ABSENCES with the\n` +
        `  structural reason the profiler cannot reach it. "We have not tested it yet" is not one.`,
    );
  }
  for (const m of staleExemptions) {
    console.error(
      `STALE EXEMPTION: ${m} is declared structurally absent but IS in the report.\n` +
        `  Remove it from STRUCTURAL_ABSENCES — the reason recorded there is no longer true.`,
    );
  }
  return 1;
}

if (import.meta.main) process.exit(await main());
