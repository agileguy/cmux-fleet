/**
 * The coverage-module checker's logic (ISC-22).
 *
 * The checker itself runs behind a ~245 s profiled build in CI, which is
 * exactly the condition under which a guard goes unexamined: nobody runs it
 * locally, and when it does run it either says nothing or fails a job. So its
 * decision-making is pure and is graded here at unit speed, and only the
 * reading of the report and the disk is left to `main`.
 *
 * That split is the point. A checker whose only proof is "the CI step was
 * green" is indistinguishable from one that returns 0 unconditionally — and
 * this file exists because that is precisely what ISC-22 caught the coverage
 * report itself doing for months: producing a table nobody re-read.
 */

import { describe, expect, test } from "bun:test";

import {
  STRUCTURAL_ABSENCES,
  compareModules,
  modulesFromLcov,
  sourceModules,
} from "../../scripts/coverage-modules.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

describe("reading modules out of an lcov report", () => {
  test("collects SF: paths and ignores everything else", () => {
    const lcov = [
      "TN:",
      "SF:src/a.ts",
      "FNF:2",
      "DA:1,1",
      "end_of_record",
      "SF:src/b/c.ts",
      "end_of_record",
    ].join("\n");
    expect(modulesFromLcov(lcov)).toEqual(["src/a.ts", "src/b/c.ts"]);
  });

  /**
   * bun writes absolute paths when run from outside the repo root and relative
   * ones when run from inside it. Only the `src/...` tail is comparable, and
   * getting this wrong would make EVERY module look missing — a checker that
   * fails loudly and uselessly, which is worse than one that passes, because
   * the fix people reach for is to disable it.
   */
  test("normalises absolute paths to the repo-relative tail", () => {
    const lcov = ["SF:/Users/x/repos/cmux-fleet/src/run/paths.ts", "end_of_record"].join("\n");
    expect(modulesFromLcov(lcov)).toEqual(["src/run/paths.ts"]);
  });

  test("takes the LAST src/ so a repo checked out under a path containing src/ still resolves", () => {
    const lcov = ["SF:/home/me/src/projects/fleet/src/cli/index.ts", "end_of_record"].join("\n");
    expect(modulesFromLcov(lcov)).toEqual(["src/cli/index.ts"]);
  });

  test("deduplicates and sorts, so the comparison is order-independent", () => {
    const lcov = ["SF:src/b.ts", "SF:src/a.ts", "SF:src/b.ts"].join("\n");
    expect(modulesFromLcov(lcov)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("an empty report yields no modules rather than throwing", () => {
    expect(modulesFromLcov("")).toEqual([]);
  });
});

describe("comparing disk against the report", () => {
  const EXEMPT = new Map([["src/types.ts", "types-only"]]);

  test("a module on disk and in the report is fine", () => {
    expect(compareModules(["src/a.ts"], ["src/a.ts"], EXEMPT)).toEqual({
      missing: [],
      staleExemptions: [],
    });
  });

  /** THE DEFECT: a module nothing imports in process. */
  test("a module on disk but absent from the report is missing", () => {
    expect(compareModules(["src/a.ts", "src/b.ts"], ["src/a.ts"], EXEMPT).missing).toEqual([
      "src/b.ts",
    ]);
  });

  test("a declared exemption absent from the report is NOT reported missing", () => {
    expect(compareModules(["src/a.ts", "src/types.ts"], ["src/a.ts"], EXEMPT).missing).toEqual([]);
  });

  /**
   * THE OTHER DIRECTION, and the reason this checker is not just a denylist
   * with extra steps. An exemption that has become false is a claim nobody
   * re-reads; without this the list only ever grows and the report's own
   * meaning erodes one name at a time.
   */
  test("an exemption that now appears in the report is flagged stale", () => {
    const r = compareModules(["src/a.ts", "src/types.ts"], ["src/a.ts", "src/types.ts"], EXEMPT);
    expect(r.staleExemptions).toEqual(["src/types.ts"]);
    expect(r.missing).toEqual([]);
  });

  test("a report naming a module that is no longer on disk is not an error", () => {
    // A deleted module's stale lcov entry says nothing about coverage of what
    // exists now, and failing on it would make the check fail after every
    // deletion until someone re-ran the report.
    expect(compareModules(["src/a.ts"], ["src/a.ts", "src/gone.ts"], EXEMPT)).toEqual({
      missing: [],
      staleExemptions: [],
    });
  });
});

describe("the declared exemptions are real", () => {
  /**
   * Every name in `STRUCTURAL_ABSENCES` must still exist. An exemption for a
   * deleted file is dead weight that reads as a considered decision, and it
   * would silently cover a NEW file that later took the same path.
   */
  test("each exempt module is a file that exists", async () => {
    for (const name of STRUCTURAL_ABSENCES.keys()) {
      expect(await Bun.file(`${ROOT}${name}`).exists(), `${name} is exempt but does not exist`).toBe(
        true,
      );
    }
  });

  test("each exemption carries a stated structural reason", () => {
    for (const [name, why] of STRUCTURAL_ABSENCES) {
      expect(why.length, `${name}'s exemption must say WHY the profiler cannot reach it`).toBeGreaterThan(
        20,
      );
    }
  });

  /**
   * The enumeration reaches real files. If `sourceModules` returned nothing —
   * a wrong cwd, a glob typo — `missing` would be empty and the whole check
   * would pass vacuously on every run, forever.
   */
  test("sourceModules finds the src/ tree, including the exempt names", async () => {
    const found = await sourceModules(ROOT);
    expect(found.length).toBeGreaterThan(50);
    for (const name of STRUCTURAL_ABSENCES.keys()) expect(found).toContain(name);
    expect(found.every((f) => f.startsWith("src/") && f.endsWith(".ts"))).toBe(true);
  });
});
