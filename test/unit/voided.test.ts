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
import { VoidedRequirementSchema, type VoidedRequirement } from "../../src/contracts.ts";
import {
  PANE_MODE_TUI_VOIDED,
  TUI_VOIDED,
  definedIscIds,
  unknownIscs,
  voidedFor,
} from "../../src/attended/voided.ts";

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

  /**
   * EVERY marker is a definition, `[~]` and `[-]` included (ISC-368).
   *
   * The extractor's class was `[ x]` once and a partial grade walked into it:
   * the cross-check reported the operator-facing table as pointing at an id
   * the ISA defines three lines above the ones it accepted. That is a false
   * positive of the exact failure the cross-check exists to detect, and the
   * comment on `definedIscIds` records it.
   *
   * `[-]` — retired — is the same trap laid a second time, and this is the
   * probe that keeps it sprung. A retired criterion stays in the file and may
   * still be named by the voided table; only `progress:` stops counting it.
   * Asserted on synthetic text rather than on `ISA.md`, because the two
   * criteria the real file retires are not ones the table names — so a probe
   * reading `ISA.md` would stay green with the class narrowed back to `[ x~]`
   * and would only redden on the unrelated day someone voided a retired
   * criterion, which is precisely the deferred false positive being avoided.
   */
  test("a retired [-] criterion is still a definition", () => {
    const text = [
      "- [x] ISC-7: closed.",
      "- [~] ISC-8: partially evidenced.",
      "- [-] ISC-9: retired, premise superseded.",
    ].join("\n");
    const defined = definedIscIds(text);
    expect(defined.has("ISC-7")).toBe(true);
    expect(defined.has("ISC-8")).toBe(true);
    expect(
      defined.has("ISC-9"),
      "a retired criterion is excluded from progress:, not from the ISA — " +
        "dropping it from the definition set makes the voided cross-check " +
        "report a real id as nonexistent",
    ).toBe(true);
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

/**
 * `pane_mode: tui` — the SECOND table, and why it had to be a second one
 * (TUI spec item 14).
 *
 * `TUI_VOIDED` above is about a PERSON: what stops holding once someone types
 * into an ordinary worker's pane. Its own docblock says the table is derived
 * from the criteria rather than from SRD §3.5, because "the SRD's tui design
 * reparents Pi's stdin to the pane; this implementation does not — the
 * supervisor keeps the RPC stream".
 *
 * That premise held for every worker in the repo until Phase 1. A
 * `pane_mode: tui` worker runs Pi with `--mode rpc` OMITTED on a real pty and
 * the supervisor holds none of its three streams — so the sentence is true of
 * `rpc` workers only, and everything it said could not happen has happened for
 * this one. `PANE_MODE_TUI_VOIDED` is that difference. It is keyed on the MODE
 * rather than on the operator, because these rows are true from the moment
 * `up` creates the container, whether or not anybody has touched it.
 */
describe("the pane_mode: tui table", () => {
  test("is non-empty and every entry parses against the seam schema", () => {
    expect(PANE_MODE_TUI_VOIDED.length).toBeGreaterThan(0);
    for (const v of PANE_MODE_TUI_VOIDED) {
      expect(VoidedRequirementSchema.parse(v)).toEqual(v);
      expect(v.because.trim().length).toBeGreaterThan(20);
    }
  });

  test("names each criterion at most once", () => {
    const ids = PANE_MODE_TUI_VOIDED.map((v) => v.isc);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The exact set, for the reason the attended table's own exactness test
   * gives: both directions are errors. A missing row is a warning an operator
   * never gets, and a spurious row is how a reader learns to discount the
   * table. Each id is annotated with the requirement it discharges, so a
   * reader deleting one has to say which warning they are dropping.
   */
  const EXPECTED_MODE = [
    "ISC-74", //  F15 — the pane owns the attach
    "ISC-81", //  RPC `abort` -> `docker kill --signal=INT`
    "ISC-84", //  epoch attribution — there is no epoch
    "ISC-85", //  `already_completed` — a re-dispatch RUNS THE TASK TWICE
    "ISC-86", //  no ack on dispatch
    "ISC-87", //  completion is transcript-derived
    "ISC-95", //  the session file is found by suffix match, not recorded
    "ISC-111", // `extension_ui_request` — a dialog blocks until a person answers
    "ISC-115", // `get_session_stats` — the cost merge is permanently one-armed
    "ISC-141", // stream-offset fencing — there is no stream
  ];

  test("names exactly the criteria pane_mode: tui voids", () => {
    expect(PANE_MODE_TUI_VOIDED.map((v) => v.isc).sort()).toEqual([...EXPECTED_MODE].sort());
  });

  test("every consequence is written for its own criterion", () => {
    const reasons = PANE_MODE_TUI_VOIDED.map((v) => v.because);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const v of PANE_MODE_TUI_VOIDED) {
      expect(v.because.length).toBeGreaterThan(60);
      expect(v.because).toMatch(/[a-z]\s+[a-z]/i);
    }
  });

  /**
   * The rows carry the fact the BUILD measured, not the one §3.5 guessed, and
   * every pin below sits where those two differ. `length > 60` and
   * distinctness cannot see that difference — the review that mutated the
   * attended table into ten identical placeholders is the recorded precedent —
   * so the load-bearing clause of each surprising row is pinned by phrase.
   *
   * Only the SURPRISES are pinned. A row an operator could predict from §3.5
   * needs no guard; a row that overturns §3.5 does, because a later editor
   * "correcting" it back to the SRD's wording would be restoring a claim this
   * build measured as false.
   */
  const reason = (isc: string): string =>
    PANE_MODE_TUI_VOIDED.find((v) => v.isc === isc)?.because ?? "";

  test("abort is described as a STOP, not as a turn-interrupt", () => {
    // §2.8's alarm said `docker kill --signal=INT` could not reach the worker
    // at all. Measured, it stops it — and stopping is not interrupting, which
    // is the distinction an operator acts on. Pi's turn-interrupt is ESCAPE.
    expect(reason("ISC-81")).toMatch(/stop/i);
    expect(reason("ISC-81")).toMatch(/escape/i);
  });

  test("the epoch row states the operator-facing consequence: the task runs twice", () => {
    // "completion is transcript-derived, coarser" is §3.5's wording, and it is
    // too gentle to act on. The blunt version is what goes in the table.
    expect(reason("ISC-85")).toMatch(/twice/i);
  });

  test("the ack row says what `cmux` exiting 0 actually proves", () => {
    expect(reason("ISC-86")).toMatch(/pty/i);
  });

  test("the session-path row names the search and its bound", () => {
    // ISC-95's rule is "never glob". This row must say the rule is broken AND
    // how far, or it reads as a rule quietly dropped.
    expect(reason("ISC-95")).toMatch(/suffix/i);
    expect(reason("ISC-95")).toMatch(/newest|count/i);
  });

  test("the F15 row admits it is asserted rather than measured", () => {
    // The one row here with no measurement behind it: `--sig-proxy` sits at
    // docker's default and no probe has ever closed a tui pane and looked at
    // the container. Stated flatly it would be the only unmeasured claim in a
    // table whose value is that its claims are measured.
    expect(reason("ISC-74")).toMatch(/not measured|never measured|asserted/i);
  });

  test("the dialog row says why blocking is acceptable at all", () => {
    expect(reason("ISC-111")).toMatch(/attended/i);
  });
});

describe("cross-check the pane_mode table against the real ISA", () => {
  test("every voided ISC is a criterion ISA.md actually defines", async () => {
    const isa = await Bun.file(ISA_PATH).text();
    const defined = definedIscIds(isa);
    expect(defined.size).toBeGreaterThan(100);
    expect(unknownIscs(PANE_MODE_TUI_VOIDED, defined)).toEqual([]);
  });
});

/**
 * The selector IS the wiring. `report` prints the `voided` array off the
 * attended record, so which table gets stamped there is which guarantees the
 * report names.
 */
describe("voidedFor picks the table by the worker's launch mode", () => {
  test("an rpc worker gets the attended table unchanged", () => {
    expect(voidedFor("rpc")).toEqual([...TUI_VOIDED]);
  });

  /**
   * BOTH tables, because both are true of a tui worker. Its pane is a person's
   * from the moment `up` creates it, so every attended-mode row applies — and
   * the mode's own rows apply on top. A selector returning only the mode's
   * table would DROP the audit-trail and diff-attribution warnings from a run
   * that is attended by construction, which is the worse of the two errors.
   */
  test("a tui worker gets both tables, each criterion once", () => {
    const got = voidedFor("tui");
    const ids = got.map((v) => v.isc);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of TUI_VOIDED) expect(ids).toContain(v.isc);
    for (const v of PANE_MODE_TUI_VOIDED) expect(ids).toContain(v.isc);
    expect(got.length).toBe(
      new Set([...TUI_VOIDED, ...PANE_MODE_TUI_VOIDED].map((v) => v.isc)).size,
    );
  });

  /**
   * THE OVERLAP IS THE INTERESTING PART, and it is asserted rather than left
   * to whichever spread happened to come second.
   *
   * ISC-84, ISC-87 and ISC-141 are in both tables for DIFFERENT reasons, and
   * the mode's reason is the stronger one every time: attended mode says a
   * person's writes carry no stream position, the mode says there is no
   * stream. An operator shown the weaker sentence on a tui worker is being
   * told a fence exists that their work merely sits outside of.
   */
  test("on a criterion both tables name, the MODE's sentence is the one shown", () => {
    const overlap = TUI_VOIDED.filter((a) =>
      PANE_MODE_TUI_VOIDED.some((b) => b.isc === a.isc),
    ).map((v) => v.isc);
    // The overlap is real; an empty one would make this test vacuous.
    expect(overlap.length).toBeGreaterThan(0);

    const got = voidedFor("tui");
    for (const isc of overlap) {
      const shown = got.find((v) => v.isc === isc)!.because;
      const mode = PANE_MODE_TUI_VOIDED.find((v) => v.isc === isc)!.because;
      const attended = TUI_VOIDED.find((v) => v.isc === isc)!.because;
      expect(shown).toBe(mode);
      expect(shown).not.toBe(attended);
    }
  });

  /**
   * Ordered by criterion number, for the reason the attended table's own
   * comment gives: a reader diffs the printed list against the ISA top to
   * bottom. A bare concatenation would print ISC-141 above ISC-74.
   */
  test("the merged table is ordered by criterion number", () => {
    const nums = voidedFor("tui").map((v) => Number(v.isc.slice("ISC-".length)));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  /** A returned array a caller can mutate is a table anyone can edit at runtime. */
  test("the caller cannot mutate the table it is handed", () => {
    const got = voidedFor("tui") as VoidedRequirement[];
    expect(() => got.push({ isc: "ISC-1", because: "x".repeat(70) })).toThrow();
  });
});
