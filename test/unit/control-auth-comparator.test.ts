/**
 * The control-socket auth path is pinned to the constant-time comparator (ISC-254).
 *
 * WHY THIS TEST IS STRUCTURAL AND NOT A MEASUREMENT. `timingSafeEqual` and
 * `===` return the same booleans for the same inputs — that is what "the
 * comparator is behaviourally identical" MEANS, and it is the reason ISC-254
 * sat open with "replacing `timingSafeEqual` with `===` leaves the suite green"
 * written against it. The only runtime signal that separates them is elapsed
 * time, and a timing assertion cannot gate CI: it is flaky under a loaded
 * runner, flaky under a JIT that has not warmed, and flaky under a scheduler
 * that is not ours. A test that fails one run in twenty gets its threshold
 * loosened until it cannot fail at all, which is the same as not having it,
 * with the cost of the runs.
 *
 * So the property asserted here is the one that is actually observable: the
 * request gate reaches `secretsEqual`, `secretsEqual` returns the result of
 * `timingSafeEqual`, and nothing in either function compares the two secrets
 * with a short-circuiting operator. That is a fact about the source, and it
 * breaks the moment the comparator is swapped out.
 *
 * WHY IT READS COMMENT-STRIPPED SOURCE, WHICH IS THE WHOLE TRICK.
 * `src/security/control-auth.ts` explains `timingSafeEqual` in prose at line
 * 127. A grep for the comparator's name in that file therefore passes on a
 * module whose body is `return expected === provided` — the docstring answers
 * for the code. `src/container/image.ts`'s header records this repo shipping
 * three docstrings that asserted controls the code did not have, and a probe
 * that can be satisfied by a comment is the same failure wearing a test's
 * clothes. Everything below runs on text with comments removed.
 *
 * WHY THE ANALYSIS IS A FUNCTION AND NOT A LIST OF INLINE GREPS. So that the
 * exact code that clears the real module can be shown, in this same file, to
 * CONDEMN a module that uses `===` — including one carrying the real module's
 * docstring verbatim. An assertion that has only ever been run against passing
 * input is not evidence that it can fail.
 *
 * The behavioural truth table is here too. Structure alone would be satisfied
 * by a comparator that calls `timingSafeEqual` and ignores the result, and a
 * probe that pins the call without pinning the answer is half a control.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AUTH_FIELD,
  checkAuth,
  generateControlSecret,
  secretsEqual,
} from "../../src/security/control-auth.ts";
import { callsIn, functionBody, stripComments, strictComparisons } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const CONTROL_AUTH = readFileSync(`${ROOT}src/security/control-auth.ts`, "utf8");
const REGISTRY = readFileSync(`${ROOT}src/run/registry.ts`, "utf8");

/** The constant-time comparator the auth path is required to route through. */
const COMPARATOR = "timingSafeEqual";

/** What the structural probe found. Every field is a fact about executable text. */
interface Findings {
  /** `secretsEqual` is declared at all. */
  readonly hasComparatorFn: boolean;
  /** `timingSafeEqual` is imported from `node:crypto`, not shadowed locally. */
  readonly importsComparator: boolean;
  /** Calls to `timingSafeEqual` inside `secretsEqual`'s body. */
  readonly comparatorCalls: number;
  /** `secretsEqual` returns the comparator's result rather than discarding it. */
  readonly returnsComparator: boolean;
  /** `checkAuth` routes through `secretsEqual`. */
  readonly gateCallsComparatorFn: boolean;
  /**
   * `===`/`!==` in either body that is not a length comparison.
   *
   * The length branch is legitimate and documented — `timingSafeEqual` DEMANDS
   * equal-length inputs — so `a.length !== b.length` is allowed by shape.
   * Anything else comparing operands with a short-circuiting operator is the
   * defect this criterion exists for.
   */
  readonly contentComparisons: string[];
}

const isLength = (operand: string): boolean => operand.endsWith(".length");

/**
 * Read one `control-auth.ts`-shaped module. The real one and the fixtures below
 * go through this same code, which is what makes the fixtures proof.
 */
function analyse(source: string): Findings {
  const stripped = stripComments(source);
  const comparatorBody = functionBody(stripped, "secretsEqual");
  const gateBody = functionBody(stripped, "checkAuth");

  const bodies = [comparatorBody, gateBody].filter((b): b is string => b !== null);
  const contentComparisons = bodies
    .flatMap((body) => strictComparisons(body))
    .filter((c) => !(isLength(c.left) && isLength(c.right)))
    .map((c) => c.text);

  return {
    hasComparatorFn: comparatorBody !== null,
    importsComparator: new RegExp(
      String.raw`import\s*\{[^}]*\b${COMPARATOR}\b[^}]*\}\s*from\s*["']node:crypto["']`,
    ).test(stripped),
    comparatorCalls:
      comparatorBody === null ? 0 : callsIn(comparatorBody).filter((c) => c === COMPARATOR).length,
    returnsComparator:
      comparatorBody !== null && new RegExp(String.raw`return\s+${COMPARATOR}\s*\(`).test(comparatorBody),
    gateCallsComparatorFn: gateBody !== null && callsIn(gateBody).includes("secretsEqual"),
    contentComparisons,
  };
}

describe("the real control-auth module routes the auth path through the comparator", () => {
  const found = analyse(CONTROL_AUTH);

  test("secretsEqual exists and takes the comparator from node:crypto", () => {
    expect(found.hasComparatorFn).toBe(true);
    expect(found.importsComparator).toBe(true);
  });

  test("secretsEqual RETURNS timingSafeEqual's result — it does not call it and discard it", () => {
    expect(found.returnsComparator).toBe(true);
  });

  test("both branches compare — the length-mismatch path does the work too", () => {
    // The documented design: a mismatched length still performs a full
    // comparison of the secret against itself, so the fast path cannot tell a
    // caller that only the LENGTH was wrong. Two call sites is that design.
    expect(found.comparatorCalls).toBeGreaterThanOrEqual(2);
  });

  test("nothing in secretsEqual or checkAuth compares the secrets with === or !==", () => {
    // Reported as text so a failure shows the offending expression rather than
    // a count. The only strict comparisons allowed by shape are on `.length`.
    expect(found.contentComparisons).toEqual([]);
  });

  test("checkAuth reaches the comparator — the gate does not compare on its own", () => {
    expect(found.gateCallsComparatorFn).toBe(true);
  });

  test("the control socket reaches checkAuth — this is the auth path, not a spare function", () => {
    // Without this, everything above could hold for a function nothing calls.
    expect(callsIn(stripComments(REGISTRY))).toContain("checkAuth");
  });
});

describe("the probe can condemn — the same analysis, run on modules that are wrong", () => {
  /** The real module's shape, reduced to what the probe reads. */
  const faithful = [
    'import { timingSafeEqual } from "node:crypto";',
    "export function secretsEqual(expected: string, provided: string): boolean {",
    '  const a = Buffer.from(expected, "utf8");',
    '  const b = Buffer.from(provided, "utf8");',
    "  if (a.length !== b.length) {",
    "    timingSafeEqual(a, a);",
    "    return false;",
    "  }",
    "  return timingSafeEqual(a, b);",
    "}",
    "export function checkAuth(msg: Record<string, unknown>, secret: string): boolean {",
    "  const provided = msg.auth;",
    '  if (typeof provided !== "string") return false;',
    "  return secretsEqual(secret, provided);",
    "}",
  ].join("\n");

  /** The mutation ISC-254 names: the comparator swapped for string equality. */
  const swapped = faithful
    .replace("  if (a.length !== b.length) {\n    timingSafeEqual(a, a);\n    return false;\n  }\n", "")
    .replace("  return timingSafeEqual(a, b);", "  return expected === provided;");

  test("the faithful shape is cleared — the probe is not simply refusing everything", () => {
    const found = analyse(faithful);
    expect(found.hasComparatorFn).toBe(true);
    expect(found.returnsComparator).toBe(true);
    expect(found.comparatorCalls).toBe(2);
    expect(found.contentComparisons).toEqual([]);
    expect(found.gateCallsComparatorFn).toBe(true);
  });

  test("=== instead of the comparator is condemned on every field that speaks to it", () => {
    const found = analyse(swapped);
    expect(found.returnsComparator).toBe(false);
    expect(found.comparatorCalls).toBe(0);
    expect(found.contentComparisons).toEqual(["expected === provided"]);
  });

  test("a docstring naming the comparator does not answer for the code", () => {
    // The exact failure a raw grep would produce: the real module's prose, over
    // a body that short-circuits. If `stripComments` ever regressed, this is
    // the test that goes red.
    const documented = [
      "/**",
      " * Timing-safe secret comparison.",
      " *",
      " * `===` is wrong here: string equality bails at the first differing",
      " * character. `timingSafeEqual` compares every byte unconditionally, and",
      " * a call to timingSafeEqual(a, b) is what this function returns.",
      " */",
      "export function secretsEqual(expected: string, provided: string): boolean {",
      "  return expected === provided;",
      "}",
    ].join("\n");

    expect(documented).toContain(COMPARATOR); // a grep of the raw text passes
    const found = analyse(documented);
    expect(found.comparatorCalls).toBe(0); // the probe does not
    expect(found.returnsComparator).toBe(false);
    expect(found.contentComparisons).toEqual(["expected === provided"]);
  });

  test("a gate that compares for itself is condemned even with the comparator intact", () => {
    const bypassed = faithful.replace(
      "  return secretsEqual(secret, provided);",
      "  return secret === provided;",
    );
    const found = analyse(bypassed);
    expect(found.returnsComparator).toBe(true); // secretsEqual is still correct
    expect(found.gateCallsComparatorFn).toBe(false); // but nothing calls it
    expect(found.contentComparisons).toEqual(["secret === provided"]);
  });
});

describe("the comparator's answers — structure without a truth table is half a control", () => {
  const secret = generateControlSecret();

  test("equal inputs compare equal", () => {
    expect(secretsEqual(secret, secret)).toBe(true);
    expect(secretsEqual("", "")).toBe(true);
  });

  test("unequal inputs of the same length compare unequal, wherever they differ", () => {
    const first = `f${secret.slice(1)}`;
    const last = `${secret.slice(0, -1)}f`;
    // Both directions matter: a comparator that bails early is still CORRECT
    // on these, which is exactly why the structural check above exists.
    expect(first).not.toBe(secret);
    expect(last).not.toBe(secret);
    expect(secretsEqual(secret, first)).toBe(false);
    expect(secretsEqual(secret, last)).toBe(false);
  });

  test("different lengths compare unequal in both directions and never throw", () => {
    // node's timingSafeEqual THROWS on unequal-length buffers. The wrapper must
    // absorb that; a throw here would crash the socket handler, which is a
    // denial of service wearing an auth check.
    expect(() => secretsEqual(secret, secret.slice(0, 32))).not.toThrow();
    expect(secretsEqual(secret, secret.slice(0, 32))).toBe(false);
    expect(secretsEqual(secret, `${secret}00`)).toBe(false);
    expect(secretsEqual(secret, "")).toBe(false);
    expect(secretsEqual("", secret)).toBe(false);
  });

  test("the comparison is over utf8 bytes, and multi-byte input is not a false positive", () => {
    // "é" is two bytes, so this pair reaches the equal-length branch and is
    // separated on content rather than on length.
    expect(Buffer.from("é", "utf8").length).toBe(2);
    expect(secretsEqual("é", "ee")).toBe(false);
    expect(secretsEqual("é", "é")).toBe(true);
  });

  test("the gate accepts the right token and refuses the wrong one", () => {
    expect(checkAuth({ cmd: "ping", [AUTH_FIELD]: secret }, secret)).toBeNull();
    expect(checkAuth({ cmd: "ping", [AUTH_FIELD]: generateControlSecret() }, secret)?.code).toBe(
      "auth_invalid",
    );
  });
});
