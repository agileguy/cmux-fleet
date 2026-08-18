/**
 * Version-banner parsing for `doctor`'s floors (ISC-159).
 *
 * `doctor` captured a version string from every probe and compared it to
 * nothing, so "wrong version" — one of the three conditions ISC-159 names —
 * was undetectable by construction. Comparing requires parsing, and the three
 * banners that have to land in one parser do not agree on a format:
 *
 *   git    `git version 2.43.0`
 *   tmux   `tmux 3.6a`            (letter suffix, no patch field)
 *   docker `28.0.1`               (bare — `--format {{.Server.Version}}`)
 *
 * These tests exist because the obvious implementations are wrong in ways that
 * pass a casual read: string comparison ranks `2.9` above `2.10`, and a
 * `split(".")` parser turns `3.6a` into `NaN`.
 */

import { describe, expect, test } from "bun:test";
import { parseVersion, versionAtLeast } from "../../src/cli/commands/doctor.ts";

describe("parseVersion reads the banner each tool actually prints", () => {
  test("git's `git version X.Y.Z`", () => {
    expect(parseVersion("git version 2.43.0")).toEqual([2, 43, 0]);
  });

  /**
   * Real-world git on macOS appends a vendor suffix. The leading dotted run is
   * the version; everything after it is noise that must not reach the parse.
   */
  test("a vendor suffix does not change the parse", () => {
    expect(parseVersion("git version 2.39.5 (Apple Git-154)")).toEqual([2, 39, 5]);
  });

  /**
   * tmux prints two fields, and point releases are a LETTER rather than a
   * third number. `3.6a` is a patch of `3.6`, so reading it as `3.6.0` can
   * only ever under-report — the safe direction for a floor check.
   */
  test("tmux's two-field banner with a letter suffix", () => {
    expect(parseVersion("tmux 3.6a")).toEqual([3, 6, 0]);
    expect(parseVersion("tmux 3.4")).toEqual([3, 4, 0]);
  });

  test("docker's bare `{{.Server.Version}}`", () => {
    expect(parseVersion("28.0.1")).toEqual([28, 0, 1]);
  });

  /**
   * The failure that must be REPRESENTABLE rather than guessed at. A banner
   * with no dotted numeric run yields null so the caller can say "could not
   * verify" instead of inventing a comparison — `doctor`'s shims and any
   * wrapper script land here.
   */
  test("a banner with no version in it is null, not a guess", () => {
    expect(parseVersion("{}")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("tmux master")).toBeNull();
  });
});

describe("versionAtLeast compares numerically, not lexically", () => {
  /**
   * The whole reason this is not `>=` on strings. Every tool floored here has
   * already shipped a two-digit minor, so the lexical bug is not hypothetical:
   * git 2.9 predates git 2.10 by half a year.
   */
  test("2.9 is BELOW 2.10 (string comparison says the opposite)", () => {
    expect(versionAtLeast("git version 2.9.0", "2.10.0")).toBe(false);
    expect("2.9.0" >= "2.10.0").toBe(true); // the bug this pins shut
  });

  test("equal to the floor passes", () => {
    expect(versionAtLeast("git version 2.32.0", "2.32.0")).toBe(true);
  });

  test("a missing patch field reads as .0", () => {
    expect(versionAtLeast("tmux 2.4", "2.4.0")).toBe(true);
    expect(versionAtLeast("tmux 2.3", "2.4.0")).toBe(false);
  });

  test("above the floor in any field passes", () => {
    expect(versionAtLeast("28.0.1", "23.0.0")).toBe(true);
    expect(versionAtLeast("23.0.0", "23.0.0")).toBe(true);
    expect(versionAtLeast("22.9.9", "23.0.0")).toBe(false);
  });

  /**
   * Unreadable is a THIRD answer, not a false. `doctor` reports it as "could
   * not verify the floor" and names the banner it choked on; collapsing it
   * into `false` would tell an operator to upgrade a tool that may already be
   * current, and collapsing it into `true` would report a machine healthy on
   * no evidence.
   */
  test("an unreadable banner is null, distinct from below-the-floor", () => {
    expect(versionAtLeast("{}", "23.0.0")).toBeNull();
    expect(versionAtLeast("22.0.0", "23.0.0")).toBe(false);
  });
});
