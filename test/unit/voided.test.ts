/**
 * The voided-requirements table stays true to the ISA (SRD §3.5, Phase 6).
 *
 * The table's whole value is that an operator can trust it: it names the ISA
 * criteria that stop holding once a person types into a pane. A table naming
 * a renumbered or deleted criterion is worse than no table — it looks
 * authoritative while pointing at nothing — so the cross-check here runs
 * against the REAL `ISA.md`, not a fixture, and renumbering a voided
 * criterion in the ISA fails this suite until the table is updated to match.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { VoidedRequirementSchema } from "../../src/contracts.ts";
import { TUI_VOIDED, definedIscIds, unknownIscs } from "../../src/attended/voided.ts";

const ISA_PATH = join(new URL("../../", import.meta.url).pathname, "ISA.md");

describe("the table itself", () => {
  test("is non-empty and every entry parses against the seam schema", () => {
    expect(TUI_VOIDED.length).toBeGreaterThan(0);
    for (const v of TUI_VOIDED) {
      expect(VoidedRequirementSchema.parse(v)).toEqual(v);
      // "One sentence an operator can act on" — an empty or whitespace
      // `because` is a row that tells the operator nothing.
      expect(v.because.trim().length).toBeGreaterThan(20);
    }
  });

  test("names each criterion at most once", () => {
    const ids = TUI_VOIDED.map((v) => v.isc);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The failure classes attended mode actually creates, pinned by their
   * clearest representative so the table cannot be quietly emptied:
   * completion (ISC-87), diff-as-the-agent's-work adjudication (ISC-93), and
   * the mutating-verb audit trail (ISC-106).
   *
   * ISC-136 used to be pinned here and should not have been. Its text is
   * "Anti: no code path outside diagnostics calls readScreen()", and entering
   * tui adds no such call — the code is unchanged. What attended mode voids
   * is the SRD §3.3 principle ISC-136 stands for, not ISC-136 itself, and a
   * test asserting the wrong row by id enshrines the error.
   */
  test("covers completion, diff attribution, and the audit trail", () => {
    const ids = new Set(TUI_VOIDED.map((v) => v.isc));
    expect(ids.has("ISC-87")).toBe(true);
    expect(ids.has("ISC-93")).toBe(true);
    // The one a container shell genuinely breaks: the pane's shell inherits
    // the image PATH, so a person's cloud verbs pass through the verbgate
    // and land in the ledger wearing the agent's row shape.
    expect(ids.has("ISC-106")).toBe(true);
  });

  /**
   * The other half of honesty: a criterion that still HOLDS under attended
   * mode must not be listed. Four were, and an operator who checks one row,
   * finds the criterion intact, and learns to discount the rest is worse off
   * than one with no table at all.
   */
  test("does not list criteria that attended mode leaves intact", () => {
    const ids = new Set(TUI_VOIDED.map((v) => v.isc));
    // "The reported diff equals git diff" — still true; only the AUTHORSHIP
    // changes, which is what ISC-92/93/94 already cover.
    expect(ids.has("ISC-90")).toBe(false);
    // "no code path outside diagnostics calls readScreen()" — unchanged.
    expect(ids.has("ISC-136")).toBe(false);
    // "closing a pane does not stop the worker" — closing a tui pane kills
    // the shell, not Pi, and the task still settles.
    expect(ids.has("ISC-74")).toBe(false);
    // Already inert in EVERY run per the ISA's own annotation; listing it
    // here implies a person's keystrokes caused it.
    expect(ids.has("ISC-154")).toBe(false);
  });
});

describe("cross-check against the real ISA", () => {
  test("every voided ISC is a criterion ISA.md actually defines", async () => {
    const isa = await Bun.file(ISA_PATH).text();
    const defined = definedIscIds(isa);
    // Guard the extractor before trusting its verdict: an extractor whose
    // regex rotted would return few ids and fail the membership check below
    // loudly — but assert the scale anyway so the failure names the right
    // culprit. The ISA carries 200+ checkbox criteria as of this phase.
    expect(defined.size).toBeGreaterThan(100);
    expect(unknownIscs(TUI_VOIDED, defined)).toEqual([]);
  });

  /**
   * Positive control: the check must be able to FAIL. A cross-check that
   * cannot reject a fabricated id proves nothing about the ids it accepts.
   */
  test("the check rejects a criterion the ISA does not define", async () => {
    const isa = await Bun.file(ISA_PATH).text();
    const defined = definedIscIds(isa);
    const bogus = VoidedRequirementSchema.parse({
      isc: "ISC-99999",
      because: "this criterion does not exist and the check must say so",
    });
    expect(unknownIscs([...TUI_VOIDED, bogus], defined)).toEqual(["ISC-99999"]);
  });

  /**
   * The extractor matches definitions, not mentions. The ISA discusses
   * criteria by id throughout its Decisions and Verification prose; a voided
   * entry pointing at an id that is only ever MENTIONED would be exactly the
   * rot the cross-check exists to catch, so a mention must not count.
   */
  test("a prose mention of an ISC id is not a definition", () => {
    const text = [
      "- [x] ISC-7: a real criterion.",
      "- [ ] ISC-248a: a real criterion with a letter suffix.",
      "This paragraph mentions ISC-8 without defining it.",
      "  - [x] ISC-9: indented, so not a top-level criterion row.",
    ].join("\n");
    const defined = definedIscIds(text);
    expect(defined.has("ISC-7")).toBe(true);
    expect(defined.has("ISC-248a")).toBe(true);
    expect(defined.has("ISC-8")).toBe(false);
    expect(defined.has("ISC-9")).toBe(false);
  });
});

/**
 * The table cannot be quietly emptied or quietly padded.
 *
 * Review mutated it from ten rows down to the three the suite named by id,
 * and replaced every `because` with the same placeholder — nothing went red.
 * Seven rows were deletable and no row's prose was pinned, which makes a
 * document whose entire value is authority editable without review.
 *
 * The exact set is asserted rather than a minimum count, because both
 * directions are errors: a missing row is a warning an operator never gets,
 * and a spurious row is how a reader learns to discount the whole table.
 * Changing this list should require changing this test, deliberately.
 */
describe("the voided set is exact", () => {
  const EXPECTED = [
    "ISC-84", // epoch attribution
    "ISC-87", // completion detection
    "ISC-92", // claim-vs-diff flagging
    "ISC-93", // success over a human-supplied diff
    "ISC-94", // verdict reconstruction
    "ISC-106", // mutating-verb audit trail
    "ISC-107", // the ledger stops being a record of the agent
    "ISC-141", // stream-offset fencing
  ];

  test("names exactly the criteria attended mode voids", () => {
    expect(TUI_VOIDED.map((v) => v.isc).sort()).toEqual([...EXPECTED].sort());
  });

  /**
   * `length > 20` was the only assertion on the operator-facing sentence, so
   * every row could carry the same placeholder. Distinctness is cheap and
   * catches exactly that: ten identical strings are not ten explanations.
   */
  test("every consequence is written for its own criterion", () => {
    const reasons = TUI_VOIDED.map((v) => v.because);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const v of TUI_VOIDED) {
      // A sentence, not a stub: an operator has to be able to act on it.
      expect(v.because.length).toBeGreaterThan(60);
      expect(v.because).toMatch(/[a-z]\s+[a-z]/i);
    }
  });
});
