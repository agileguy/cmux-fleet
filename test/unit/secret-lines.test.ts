/**
 * `secretLines` pinned directly: which lines of a multi-line value are secret
 * material, under a floor the caller chooses.
 *
 * ## Why this file exists when two suites already call it
 *
 * The redactor and the harvest credential sweep (`harvest/needles.ts`) both
 * consume this function, and their suites exercised it only through their own
 * outputs. Two mutants of it survived every one of those suites:
 *
 *   - returning each line UNTRIMMED, and
 *   - dropping the `line.length < floor` check.
 *
 * The second is not cosmetic. The harvest sweep applies no floor of its own to
 * a line, so without this one the short final base64 line of a key (`AA==`)
 * becomes a needle, and a needle that short matches honest artifacts.
 *
 * Every value here is synthetic. Nothing is key material and nothing reads the
 * real environment.
 */

import { describe, expect, test } from "bun:test";

import { isArmorLine, secretLines } from "../../src/security/secret-lines.ts";

describe("a value with no LF has no lines", () => {
  test("a single-line value yields [], however long or padded", () => {
    expect(secretLines("a-single-line-value-well-over-any-floor", 8)).toEqual([]);
    expect(secretLines("   padded-single-line-value-over-the-floor   ", 8)).toEqual([]);
    // CR is not a line break here: delivery refuses CR, and this splits on LF.
    expect(secretLines("carriage-return\ronly-value-over-the-floor", 8)).toEqual([]);
    // Even with a floor of zero there is nothing to return.
    expect(secretLines("x", 0)).toEqual([]);
  });
});

describe("each line comes back trimmed", () => {
  test("leading, trailing and both-sided whitespace is removed", () => {
    const value = "   leading-space-line\ntrailing-space-line   \n\t both-sides-line \t\n";
    expect(secretLines(value, 8)).toEqual([
      "leading-space-line",
      "trailing-space-line",
      "both-sides-line",
    ]);
  });

  test("a returned line is a substring of the value, so it matches wherever the line did", () => {
    const value = "  first-secret-line-0001  \n\tsecond-secret-line-0002\t\n";
    for (const line of secretLines(value, 8)) {
      expect(value).toContain(line);
      expect(line).toBe(line.trim());
    }
  });
});

describe("a line below the floor is never returned", () => {
  test("the floor is inclusive: floor - 1 is out, floor is in", () => {
    expect(secretLines("1234567\n12345678\n", 8)).toEqual(["12345678"]);
  });

  test("the floor counts the TRIMMED line, not the padded one", () => {
    // Eleven characters raw, five once trimmed. Under a floor of eight it is out.
    expect(secretLines("   short   \nlong-enough-line-0001\n", 8)).toEqual(["long-enough-line-0001"]);
  });

  test("the floor is the caller's own", () => {
    const value = "sixteen-chars-ab\ntwenty-four-characters-x\n";
    expect(secretLines(value, 8)).toEqual(["sixteen-chars-ab", "twenty-four-characters-x"]);
    expect(secretLines(value, 20)).toEqual(["twenty-four-characters-x"]);
    expect(secretLines(value, 25)).toEqual([]);
  });

  test("a key's short final base64 line is not secret material under the floor", () => {
    // The PEM layout with a padded four-character last body line. Base64 of
    // fixture text, not a key.
    const body = Buffer.from("pifleet-secret-lines-fixture-not-a-key;".repeat(4)).toString("base64");
    const wrapped = body.match(/.{1,70}/g)!;
    const value = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      ...wrapped,
      "AA==",
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n");
    const lines = secretLines(value, 8);
    expect(lines).toEqual(wrapped.filter((l) => l.length >= 8));
    expect(lines).not.toContain("AA==");
  });
});

describe("armor and blank lines are excluded", () => {
  test("PEM armor lines are never returned, padded or not", () => {
    const value = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "Ym9keS1saW5lLW9uZS1ub3QtYS1rZXk=",
      "  -----END RSA PRIVATE KEY-----  ",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "Ym9keS1saW5lLXR3by1ub3QtYS1rZXk=",
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n");
    expect(secretLines(value, 8)).toEqual([
      "Ym9keS1saW5lLW9uZS1ub3QtYS1rZXk=",
      "Ym9keS1saW5lLXR3by1ub3QtYS1rZXk=",
    ]);
  });

  test("a line that only STARTS like armor is an ordinary line", () => {
    const value = "-----BEGIN but not armor-shaped at all\nsecond-ordinary-line\n";
    expect(isArmorLine("-----BEGIN but not armor-shaped at all")).toBe(false);
    expect(secretLines(value, 8)).toEqual([
      "-----BEGIN but not armor-shaped at all",
      "second-ordinary-line",
    ]);
  });

  test("blank and whitespace-only lines are excluded even with a floor of zero", () => {
    // Floor zero, so only the blank rule can be what keeps these out.
    expect(secretLines("\n   \n\t\nreal-line\n\n", 0)).toEqual(["real-line"]);
  });
});

describe("order and repeats", () => {
  test("lines come back in first-seen order, each once", () => {
    const value = "line-bravo-0002\nline-alpha-0001\n  line-bravo-0002  \nline-alpha-0001\n";
    expect(secretLines(value, 8)).toEqual(["line-bravo-0002", "line-alpha-0001"]);
  });
});
