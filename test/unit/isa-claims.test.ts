/**
 * Re-runs the ISA's live absence-and-presence claims.
 *
 * A criterion's GRADE is a checkbox a human moves. Its GROUNDS are sentences
 * about the code — "nothing imports this", "the scheduler calls that" — and
 * nothing in this repo has ever re-read them. Measured cost of that gap:
 * ISC-115 and ISC-193 sat `[ ]` for five days on grounds falsified the day
 * after they were written, and ISC-110, ISC-117 and a `src/safety/kill.ts`
 * comment carried the same staleness for the same reason.
 *
 * These are not tests of the product. They are tests of the ISA, and a failure
 * is a re-grading job, not a red build to be quieted. See
 * `test/support/isa-claims.ts` for what to do when one goes red — the short
 * version is that editing the expectation without touching the entry is the
 * failure mode, not the fix.
 */

import { describe, expect, test } from "bun:test";

import { ISA_CLAIMS, runIsaClaim, type IsaClaim } from "../support/isa-claims.ts";

const ISA = await Bun.file("ISA.md").text();

/** The failure a stale claim should produce: the entry, not the command. */
function why(c: IsaClaim, got: string[]): string {
  return [
    ``,
    `${c.isc} (${c.grade}) rests on a claim the code no longer supports.`,
    ``,
    `  ISA.md says: ${c.claim}`,
    `  command:     ${c.argv.join(" ")}`,
    `  expected:    ${typeof c.expect === "number" ? `${c.expect} line(s)` : c.expect}`,
    `  got:         ${got.length} line(s)`,
    ...got.slice(0, 8).map((l) => `    ${l.slice(0, 160)}`),
    ``,
    `  RE-GRADE ${c.isc} — verify, mutate, rewrite the entry — and update`,
    `  test/support/isa-claims.ts afterwards. Editing the expectation alone`,
    `  leaves ISA.md asserting something false while this file shows green,`,
    `  which is the exact failure it exists to catch.`,
    ``,
  ].join("\n");
}

describe("the ISA's checkable claims still hold", () => {
  for (const c of ISA_CLAIMS) {
    test(`${c.isc} ${c.grade} — ${c.argv.join(" ")}`, async () => {
      const got = await runIsaClaim(c);
      const message = why(c, got);
      if (c.expect === "empty") expect(got, message).toHaveLength(0);
      else if (c.expect === "nonempty") expect(got.length, message).toBeGreaterThan(0);
      else expect(got, message).toHaveLength(c.expect);
    });
  }
});

describe("the registry itself stays honest", () => {
  /**
   * The registry records each criterion's grade, and a re-grade that does not
   * come back here leaves a line describing a criterion that no longer exists
   * in that state. This is the seam that makes the guard self-maintaining
   * rather than a snapshot that rots quietly beside the file it guards.
   */
  test("every claim names a criterion that is still at the grade recorded", () => {
    for (const c of ISA_CLAIMS) {
      const line = ISA.split("\n").find((l) => l.startsWith(`- [`) && l.includes(`] ${c.isc}:`));
      expect(line, `${c.isc} is not in ISA.md at all`).toBeDefined();
      expect(
        line!.startsWith(`- ${c.grade} ${c.isc}:`),
        `${c.isc} is graded ${line!.slice(2, 5)} in ISA.md but ${c.grade} here — ` +
          `re-grading a criterion means revisiting the claims that carried it`,
      ).toBe(true);
    }
  });

  /**
   * BOTH DIRECTIONS, or the guard only catches half of what breaks a grade.
   * An `empty` claim goes stale when something is BUILT; a `nonempty` claim
   * goes stale when wiring is REMOVED, which is the case no checkbox notices
   * and the one ISC-115 spent five days in.
   */
  test("the registry carries presence claims as well as absence claims", () => {
    const kinds = new Set(ISA_CLAIMS.map((c) => (typeof c.expect === "number" ? "count" : c.expect)));
    expect(kinds.has("empty")).toBe(true);
    expect(kinds.has("nonempty")).toBe(true);
  });

  /**
   * A claim whose command cannot reproduce its own number is not evidence.
   * `ISA.md` records `grep -rn 'a|b|c' src/` twice (ISC-125, ISC-126); without
   * `-E` those read `|` as a literal and return zero against entries reporting
   * NOTHING and exactly one. Alternation here must say which flavour it means.
   */
  test("any alternation pattern names its grep flavour explicitly", () => {
    for (const c of ISA_CLAIMS) {
      const alternates = c.argv.some((a, i) => i > 0 && a.includes("|") && !a.startsWith("-"));
      if (!alternates) continue;
      const flags = c.argv.filter((a) => a.startsWith("-")).join("");
      expect(
        flags.includes("E") || flags.includes("F"),
        `${c.isc}: \`${c.argv.join(" ")}\` uses | without -E, so grep reads it literally`,
      ).toBe(true);
    }
  });
});
