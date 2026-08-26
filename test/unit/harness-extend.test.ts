/**
 * `harness.patterns` extends the built-in defaults; `harness.replace` opts out
 * (ISC-243's escape hatch).
 *
 * WHAT WAS WRONG, measured on the live matcher rather than argued. The
 * operator's only lever REPLACED all 91 built-in globs, so the first edit
 * anyone actually writes — `patterns: ["ci/**"]`, to get one more file
 * covered — switched the ISC-150 test-harness cap off for every diff that did
 * not touch `ci/`. A worker could then green a red suite through
 * `package.json` and be certified `success`.
 *
 * WHY THE DEFAULT FLIPPED RATHER THAN THE DOCS IMPROVING. The two failure
 * modes are not symmetric. Over-capping is LOUD: a run comes back `unknown`
 * and someone goes looking. Under-capping is SILENT: a red suite is certified
 * green and nobody looks at all. A default should fail in the loud direction.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HARNESS_PATTERNS,
  effectiveHarnessPatterns,
  harnessSurface,
} from "../../src/harvest/acceptance.ts";

/** The realistic first edit, and the one that used to disable the cap. */
const ONE_MORE_FILE = ["ci/**"];

describe("the effective pattern list", () => {
  test("no patterns configured means no opinion, not an empty surface", () => {
    expect(effectiveHarnessPatterns({})).toBeNull();
    expect(effectiveHarnessPatterns({ patterns: undefined })).toBeNull();
    expect(effectiveHarnessPatterns({ patterns: [] })).toBeNull();
  });

  test("configured patterns are ADDED to the built-ins by default", () => {
    const effective = effectiveHarnessPatterns({ patterns: ONE_MORE_FILE })!;
    expect(effective).toContain("ci/**");
    for (const d of DEFAULT_HARNESS_PATTERNS) expect(effective).toContain(d);
    expect(effective).toHaveLength(DEFAULT_HARNESS_PATTERNS.length + 1);
  });

  test("replace: true still starts from nothing, for the operator who means it", () => {
    const effective = effectiveHarnessPatterns({ patterns: ONE_MORE_FILE, replace: true })!;
    expect(effective).toEqual(["ci/**"]);
  });

  /**
   * A repeated glob is not merely untidy: `harnessSurface` compiles one
   * `Bun.Glob` per entry and matches every changed file against every one of
   * them, so a config that re-states `package.json` would pay for it on every
   * file of every diff for the life of the run.
   */
  test("a pattern that duplicates a built-in is not compiled twice", () => {
    const effective = effectiveHarnessPatterns({ patterns: ["package.json", "ci/**"] })!;
    expect(effective.filter((p) => p === "package.json")).toHaveLength(1);
    expect(effective).toHaveLength(DEFAULT_HARNESS_PATTERNS.length + 1);
  });
});

describe("the cap the extension protects (ISC-150 / ISC-243)", () => {
  /**
   * THE REGRESSION, stated as the ISA measured it: a diff carrying a harness
   * file must still be SEEN when the operator has narrowed the surface to add
   * something of their own.
   *
   * Fails if `effectiveHarnessPatterns` ever goes back to replacing: with
   * `["ci/**"]` alone, `package.json` matches nothing, `harness.touched` comes
   * back empty, and `adjudicate`'s `if (facts.harness.touched.length > 0)`
   * cap never fires.
   */
  test("a package.json edit is still caught when the operator added ci/**", () => {
    const diff = ["src/app.ts", "package.json"];
    const patterns = effectiveHarnessPatterns({ patterns: ONE_MORE_FILE })!;
    expect(harnessSurface(diff, patterns).touched).toEqual(["package.json"]);
  });

  /**
   * The one-field-different control: the SAME config with `replace: true`
   * misses it. Without this the test above could pass against a matcher that
   * ignores the configured list entirely.
   */
  test("…and is missed under replace: true, which is what that flag means", () => {
    const diff = ["src/app.ts", "package.json"];
    const patterns = effectiveHarnessPatterns({ patterns: ONE_MORE_FILE, replace: true })!;
    expect(harnessSurface(diff, patterns).touched).toEqual([]);
  });

  test("the operator's own addition is caught too — extending is not ignoring", () => {
    const patterns = effectiveHarnessPatterns({ patterns: ONE_MORE_FILE })!;
    expect(harnessSurface(["ci/deploy.sh"], patterns).touched).toEqual(["ci/deploy.sh"]);
  });

  /**
   * Nothing moves for a config that sets no patterns, which is every
   * `fleet.yaml` written before this key existed and the shipped example.
   */
  test("a config with no harness key grades exactly as before", () => {
    expect(effectiveHarnessPatterns({})).toBeNull();
    expect(harnessSurface(["package.json"]).touched).toEqual(["package.json"]);
  });
});
