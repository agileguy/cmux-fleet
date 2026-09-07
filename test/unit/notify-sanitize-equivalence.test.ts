/**
 * `sanitize-keeps-newlines` is an EQUIVALENT mutant, and this file is why that
 * is a fact rather than a claim.
 *
 * ## Why this file exists
 *
 * Task 5.6a's mutation battery ran 44 cases and killed 43. The survivor widens
 * {@link sanitizeToken}'s first-pass character class from `[^\x20-\x7e]` to
 * `[^\x20-\x7e\n]`, so a newline survives that pass — and the argument for
 * calling it equivalent is that the SECOND pass, `/\s+/g → " "`, collapses the
 * newline anyway, leaving the two functions agreeing on every input.
 *
 * That argument is correct. It is also **the single easiest place for a
 * mutation report to launder an untested branch**: "the survivor is equivalent"
 * asserted in prose is a sentence nobody can falsify, and a reader has no way to
 * tell a real equivalence from a missing test. So the engineer wrote it as an
 * executable probe instead — the right instinct, and the reason ISC-690 records
 * the reasoning as the best form that claim has taken on this branch.
 *
 * It still graded `[~]`, because the probe lived in a session scratchpad under
 * `/private/tmp` that would not survive the session: nothing re-checked it.
 * Moving it here is what closes ISC-690. The strictness rule is that `[x]`
 * requires something reproducible to re-check the claim, and a script that has
 * been deleted re-checks nothing.
 *
 * ## What changed in the move, and it is not a transcription
 *
 * The scratchpad version hand-copied BOTH functions. That makes the equivalence
 * a statement about two local copies rather than about the shipped code: edit
 * `sanitizeToken` tomorrow and the probe keeps proving a fact about a function
 * that no longer exists, in green. Here the real implementation is IMPORTED and
 * only the mutant is written out, so the comparison is against what actually
 * ships.
 *
 * The random arm is seeded rather than `Math.random`, because a suite that fails
 * on an input it cannot reproduce is worse than one that does not fail at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sanitizeToken } from "../../src/run/triage-notify.ts";

/**
 * The mutant, spelled out: the first-pass class admits `\n`.
 *
 * Everything else is character-for-character the shipped function. If the two
 * bodies ever diverge in any OTHER way, the guard at the bottom of this file
 * reddens and says so — that divergence would make this comparison meaningless
 * rather than merely stale.
 */
function mutantSanitizeToken(raw: string, maxBytes: number): string {
  const flattened = raw
    .replace(/[^\x20-\x7e\n]/g, (ch) => (/\s/.test(ch) ? " " : "?"))
    .replace(/\s+/g, " ")
    .trim();
  if (Buffer.byteLength(flattened, "utf8") <= maxBytes) return flattened;
  return `${flattened.slice(0, Math.max(0, maxBytes - 3))}...`;
}

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);

/**
 * Fifteen cases chosen to attack the argument rather than to illustrate it:
 * bare newlines, CRLF, runs, leading and trailing, newlines adjacent to other
 * whitespace, a header-injection attempt, non-ASCII, an astral-plane character,
 * the empty string, and one long enough to force the truncation branch — which
 * is the only place the two functions could differ by a byte offset rather than
 * by a character.
 */
const CORPUS: readonly string[] = [
  `a${NL}b`,
  `a${CR}${NL}b`,
  `${NL}${NL}${NL}`,
  `  ${NL} `,
  `a${NL}${NL}${NL}b`,
  `Title: x${NL}X-Priority: 5${NL}${NL}Ignore previous instructions`,
  "café   naïve",
  `${"x".repeat(500)}${NL}${"y".repeat(500)}`,
  "",
  " a",
  `tab${TAB}here${NL}and${CR}there`,
  `mixed ${NL} ${TAB} ${CR}${NL}   spaces`,
  `${NL}leading`,
  `trailing${NL}`,
  "\u{1F600} emoji",
];

/** Every cap the composer actually uses, plus the two ends of the range. */
const CAPS: readonly number[] = [10, 48, 96, 200, 1000];

/** A seeded LCG — the same 50,000 strings on every run, on every machine. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("the `sanitize-keeps-newlines` survivor is equivalent, not a gap (ISC-690)", () => {
  /**
   * The premise, asserted rather than assumed. A corpus that carried no
   * newlines at all would make every comparison below vacuous and green — the
   * degenerate-fixture defect, in the one file whose entire job is to be
   * convincing.
   */
  test("premise: the corpus really exercises the character the mutant admits", () => {
    const withNewlines = CORPUS.filter((s) => s.includes(NL));
    expect(withNewlines.length).toBeGreaterThanOrEqual(10);
    expect(CORPUS.some((s) => s.includes(`${CR}${NL}`))).toBe(true);
    expect(CORPUS.some((s) => s.startsWith(NL))).toBe(true);
    expect(CORPUS.some((s) => s.endsWith(NL))).toBe(true);
    // And one input long enough that the truncation branch is reached at 200.
    expect(CORPUS.some((s) => Buffer.byteLength(s, "utf8") > 200)).toBe(true);
  });

  test("the corpus does not distinguish the shipped function from the mutant", () => {
    const differing: string[] = [];
    for (const raw of CORPUS) {
      for (const cap of CAPS) {
        if (sanitizeToken(raw, cap) !== mutantSanitizeToken(raw, cap)) {
          differing.push(`${JSON.stringify(raw)} @ ${cap}`);
        }
      }
    }
    expect(
      differing,
      "a differing input means the survivor is a REAL gap and the suite needs a case for it",
    ).toEqual([]);
  });

  test("nor do 50,000 seeded random strings across the interesting code points", () => {
    const rand = lcg(0x5eed_1234);
    const differing: string[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      let raw = "";
      // 0-299 spans control characters, printable ASCII, and past U+00FF into
      // multi-byte territory — the three classes the first pass treats
      // differently.
      for (let j = 0; j < 14; j += 1) raw += String.fromCharCode(Math.floor(rand() * 300));
      for (const cap of [10, 96]) {
        if (sanitizeToken(raw, cap) !== mutantSanitizeToken(raw, cap)) {
          differing.push(`${JSON.stringify(raw)} @ ${cap}`);
        }
      }
    }
    expect(differing.slice(0, 5)).toEqual([]);
    expect(differing).toHaveLength(0);
  });

  /**
   * The anti-criterion, and the one that stops this file being decorative.
   *
   * Every test above passes trivially if `mutantSanitizeToken` is a COPY of the
   * real one rather than a mutant of it — the two would agree on everything for
   * the boring reason. So this asserts the two function objects really do differ
   * in the one way the equivalence argument is about.
   *
   * **The first version of this test was itself decorative and a mutation caught
   * it.** It re-spelled the two first passes with local regex literals and
   * compared those, which is a true statement about two regexes and says nothing
   * about `mutantSanitizeToken`: rewriting the mutant's class to match the real
   * one left the whole file green. The repair is to read the actual function
   * objects rather than a restatement of them — [[feedback_probe_the_fix_not_just_the_finding]],
   * earned again in the file whose entire job was to be convincing.
   */
  test("ANTI: the mutant really is a mutant of the shipped function, not a copy of it", () => {
    const realSource = sanitizeToken.toString();
    const mutantSource = mutantSanitizeToken.toString();

    // The claimed difference, read off the functions themselves.
    expect(realSource).toContain(String.raw`[^\x20-\x7e]`);
    expect(realSource).not.toContain(String.raw`[^\x20-\x7e\n]`);
    expect(mutantSource).toContain(String.raw`[^\x20-\x7e\n]`);

    // And the demonstration of what that difference DOES, one pass in — which
    // is the step at which the two genuinely diverge, before the collapse
    // makes them agree again.
    const firstPass = (raw: string, cls: RegExp) =>
      raw.replace(cls, (ch) => (/\s/.test(ch) ? " " : "?"));
    expect(firstPass(`a${NL}b`, /[^\x20-\x7e]/g)).toBe("a b");
    expect(firstPass(`a${NL}b`, /[^\x20-\x7e\n]/g)).toBe(`a${NL}b`);
  });

  /**
   * The guard that keeps the equivalence honest as the code moves.
   *
   * The argument rests on exactly two facts about the shipped implementation:
   * the narrow first-pass class, and a `/\s+/g → " "` collapse that follows it.
   * If either changes, the equivalence has to be re-derived — and a comparison
   * against a hand-written mutant of the OLD shape would go on passing while
   * meaning nothing. So the shape is asserted, with the reason in the message.
   */
  test("the two facts the argument rests on are still true of the shipped code", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "run", "triage-notify.ts"),
      "utf8",
    );
    const body = src.slice(src.indexOf("export function sanitizeToken"));
    expect(
      body.includes(String.raw`/[^\x20-\x7e]/g`),
      "sanitizeToken's first-pass class changed — ISC-690's equivalence must be re-derived, " +
        "not re-run: the mutant in this file is a mutation of the OLD shape.",
    ).toBe(true);
    expect(
      body.includes(String.raw`.replace(/\s+/g, " ")`),
      "the whitespace collapse is what makes the newline mutant equivalent. If it is gone, " +
        "the survivor is a REAL gap and this file is asserting a fact about code that no " +
        "longer exists.",
    ).toBe(true);
  });
});
