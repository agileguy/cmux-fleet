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
   * The three failure classes attended mode actually creates, pinned by their
   * clearest representative so the table cannot be quietly emptied:
   * completion (ISC-87), the pane-is-a-view invariant (ISC-136), and
   * diff-as-the-agent's-work adjudication (ISC-93). Deleting any of these
   * rows deletes a real warning an operator needs.
   */
  test("covers completion, the view invariant, and diff attribution", () => {
    const ids = new Set(TUI_VOIDED.map((v) => v.isc));
    expect(ids.has("ISC-87")).toBe(true);
    expect(ids.has("ISC-136")).toBe(true);
    expect(ids.has("ISC-93")).toBe(true);
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
