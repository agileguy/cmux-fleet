/**
 * ISC-361's named gap, closed: `ensureEgressNetwork` cannot return without
 * having contained the bridge gateway.
 *
 * ## What was already proved, and what was not
 *
 * ISC-361's two registered claims pin the RULE SHAPE (the narrow `-i`/`-d`
 * pair, so a generalisation to a blanket drop reddens) and the CALL SITE inside
 * `ensureEgressNetwork`. `test/integration/relay.test.ts` enumerates the
 * gateway across all 65535 ports and asserts the reachable set is empty.
 *
 * None of that can observe the property the module's own docblock claims: that
 * containment is UNCONDITIONAL. Wrapping `await containGateway(...)` in an
 * `if` leaves the call site intact, leaves the rule shape intact, leaves both
 * claims green — and leaves `ensureEgressNetwork` free to hand back a network
 * that reports deny-all and is not. The port enumeration would not catch it
 * either, because that test takes the path where the condition happens to hold.
 *
 * ## Why this is structural rather than behavioural
 *
 * The honest version of this test would stub the firewall call, make it fail,
 * and assert `ensureEgressNetwork` throws. `docker()` is a private
 * module-scope spawn inside `gateway-block.ts`, and `inspectEgressNetwork`
 * spawns its own, so reaching the containment path without a daemon needs two
 * module mocks — at which point the test is asserting over a graph it built
 * rather than the one that ships.
 *
 * So the property asserted is the one observable in the source, which is the
 * shape `supervisor-session-latch.test.ts` argues for and ISC-361 itself asked
 * for ("a unit-level assertion that `ensureEgressNetwork` cannot return without
 * `ensureGatewayBlocked` having succeeded — the seam exists, and it was not
 * built here").
 *
 * ## The rule, and why indentation carries it
 *
 * Every `return` in the function must be IMMEDIATELY preceded by an
 * `await containGateway(...)` at the SAME indentation. Same-indentation is the
 * load-bearing half: the adopt-path call already lives inside
 * `if (before.exists)`, so "is nested at all" cannot be the test. What must not
 * happen is the call becoming conditional RELATIVE TO ITS OWN RETURN, which is
 * exactly a deeper indent than the `return` it guards.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { functionBody, stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const NETWORK = stripComments(readFileSync(`${ROOT}src/security/network.ts`, "utf8"));

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

describe("ensureEgressNetwork cannot return an uncontained network", () => {
  const body = functionBody(NETWORK, "ensureEgressNetwork");

  test("the function is still findable — the probe has not rotted", () => {
    expect(body, "ensureEgressNetwork not found in src/security/network.ts").not.toBeNull();
    expect(body!).toContain("containGateway");
  });

  test("every return is immediately preceded by an unconditional containGateway", () => {
    const lines = body!.split("\n").filter((l) => l.trim() !== "");
    // ANYWHERE in the line, not just at its start. The first version of this
    // probe matched /^\s*return\b/ and was blind to `if (x) return y;` on one
    // line — which is the cheapest possible way to add an uncontained exit, and
    // it left the probe GREEN. Found by mutating, not by reading.
    const returns = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /\breturn\b/.test(l));

    // CONTROL: a body that parsed to nothing, or a function that stopped
    // returning a status, would make the loop below vacuous.
    expect(returns.length, "no return statements found — the extractor has rotted").toBeGreaterThanOrEqual(2);

    const offenders: string[] = [];
    for (const { l, i } of returns) {
      // A return sharing its line with a condition is conditional by
      // construction: whatever containment precedes it does not run on the
      // path that reaches it.
      if (/\b(if|else|\?)\b/.test(l) || /\?/.test(l)) {
        offenders.push(`conditional return, so preceding containment does not guard it: ${l.trim()}`);
        continue;
      }
      const prev = lines[i - 1];
      if (prev === undefined || !/await containGateway\(/.test(prev)) {
        offenders.push(`return not preceded by containGateway: ${l.trim()}`);
        continue;
      }
      if (indentOf(prev) !== indentOf(l)) {
        offenders.push(
          `containGateway is nested deeper than the return it guards, so it is conditional: ${prev.trim()}`,
        );
      }
    }
    expect(
      offenders,
      `ensureEgressNetwork can return without containing the gateway:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  test("there are exactly as many containment calls as returns, so none covers for another", () => {
    const lines = body!.split("\n").filter((l) => l.trim() !== "");
    const returns = lines.filter((l) => /\breturn\b/.test(l)).length;
    const calls = lines.filter((l) => /await containGateway\(/.test(l)).length;
    expect(calls).toBe(returns);
  });
});

describe("containGateway itself cannot succeed without the firewall call", () => {
  /**
   * The other half of the chain. `ensureEgressNetwork` calling `containGateway`
   * proves nothing if `containGateway` can return having done no work — and it
   * has a guard clause, so "it throws sometimes" is not enough either.
   */
  const body = functionBody(NETWORK, "containGateway");

  test("its only non-throwing exit awaits ensureGatewayBlocked", () => {
    expect(body, "containGateway not found").not.toBeNull();
    const lines = body!.split("\n").filter((l) => l.trim() !== "");

    // No bare `return` at all: the function is void, and its last statement
    // must be the firewall call. A `return` added before that call is the
    // silent-skip this asserts against.
    // Any `return` at all, including one sharing a line with an `if` — the
    // early-exit this guards against is most naturally written that way.
    expect(lines.some((l) => /\breturn\b/.test(l))).toBe(false);
    expect(lines.filter((l) => /await ensureGatewayBlocked\(/.test(l)).length).toBe(1);

    // `functionBody` returns the braces too, so the last STATEMENT is the last
    // line that is not a bare closer.
    const statements = lines.filter((l) => !/^\s*[})\]]+;?\s*$/.test(l));
    const last = statements[statements.length - 1]!;
    expect(last, "the firewall call must be the final statement").toMatch(
      /await ensureGatewayBlocked\(/,
    );
  });
});
