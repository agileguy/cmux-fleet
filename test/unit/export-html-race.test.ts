/**
 * The A5 export race, pinned where it cannot flake (ISC-234).
 *
 * `EXPORT_HTML_TIMEOUT_MS` carried a load-bearing comment — "deliberately under
 * the CLI's own 10s ceiling" — and nothing enforced it. The falsifying mutation
 * is one character-class wide: set it to `60_000`, inverting the documented
 * ordering so the CLI is now the side that gives up first, and the entire suite
 * stayed green. A comment cannot fail.
 *
 * WHY HERE AND NOT ONLY IN THE INTEGRATION TEST. `supervisor.test.ts` proves
 * the ordering behaviourally, by delaying Pi's render into the gap and showing
 * the supervisor is the side that reports. That test is the better evidence and
 * the weaker guard: it depends on a real 8s timer firing before a real 10s one
 * on a machine whose load average has been observed between 15 and 190, and the
 * whole margin it has is the gap asserted below. This file has no timers, no
 * subprocesses and no clock — it compares two numbers — so the mutation is red
 * here on any machine at any load, and red for the right reason.
 *
 * The two files are not redundant. This one says the numbers are ordered; that
 * one says the ordering has the consequence the comment claims.
 */

import { describe, expect, test } from "bun:test";
import { EXPORT_HTML_TIMEOUT_MS } from "../../src/supervisor/index.ts";
import { CLI_EXPORT_HTML_TIMEOUT_MS } from "../../src/cli/commands/transcript.ts";

/**
 * The slack the supervisor's answer has to cross a unix socket and be read.
 *
 * Strictly-less-than is the invariant; a bare `<` would also be satisfied by
 * 9_999 against 10_000, which is the invariant honoured in letter and lost in
 * practice — the reply would routinely arrive after the CLI had already stopped
 * listening, and the operator would be back to a silent fallback. The number is
 * the current 2s margin, asserted as a floor rather than an equality so the
 * budgets can move together without a test edit demanding one.
 */
const MIN_REPORTING_MARGIN_MS = 2_000;

describe("the export budgets are ordered so the supervisor reports first (ISC-234)", () => {
  test("the supervisor gives up strictly before the CLI does", () => {
    // MUTATION: EXPORT_HTML_TIMEOUT_MS = 60_000 → red here, with both numbers
    // in the failure message, before anything is spawned.
    expect(EXPORT_HTML_TIMEOUT_MS).toBeLessThan(CLI_EXPORT_HTML_TIMEOUT_MS);
  });

  test("and by enough for its answer to arrive while the CLI is still listening", () => {
    expect(CLI_EXPORT_HTML_TIMEOUT_MS - EXPORT_HTML_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MIN_REPORTING_MARGIN_MS,
    );
  });

  test("both are real budgets, not a disabled timeout", () => {
    // 0 or Infinity would satisfy an ordering check while meaning "never give
    // up" on one side or "give up instantly" on the other. Neither is a
    // timeout, and neither should pass as one.
    expect(Number.isFinite(EXPORT_HTML_TIMEOUT_MS)).toBe(true);
    expect(Number.isFinite(CLI_EXPORT_HTML_TIMEOUT_MS)).toBe(true);
    expect(EXPORT_HTML_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
