/**
 * THE REVIEW VERDICT MAPPING, ASSERTED — SRD-FLEET-PROJECT-MANAGER §7.5, §9.3,
 * §9.4, and the fixtures §12's review-round block hooks for acceptance
 * criteria (numbered `ISC-537` through `ISC-545` below).
 *
 * Every fixture here is a plain object. `deriveReviewVerdict` reads no file
 * and reaches no network, so nothing in this suite touches the filesystem —
 * `HostCoverage` is the run tree's answer, handed in directly.
 *
 * ## The narrowing trap, and where this file refuses to fall into it
 *
 * `collation.test.ts` records that five probes on this branch were once
 * satisfied by a fixture where both sides of a narrowing agreed — a
 * `lenses[]` that lines up with `journal.children[]` exactly cannot fail when
 * the code stops narrowing one by the other. ISC-542/543's fixture below
 * carries a STRAY reply file the journal never dispatched (children narrowed
 * by replies) and a dedicated cross-check fixture carries both a journal
 * child with no lens row and a lens row for an aspect never dispatched
 * (lenses narrowed by children, in both directions at once).
 */
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { COLLATION_SCHEMA, CollationSchema, type Collation } from "../../src/run/collation.ts";
import { childTaskId } from "../../src/run/task-ids.ts";

import {
  deriveReviewVerdict,
  describeMissingLens,
  nextReviewIterationCount,
  toRepoRelativePath,
  type DeriveVerdictInput,
  type HostCoverage,
  type ReplyCoverage,
} from "../../src/run/pm-verdict.ts";

// ---------------------------------------------------------------------------
// Fixture builders. Every test builds its own parent id so no fixture can
// leak a child task id into another test by accident.
// ---------------------------------------------------------------------------

const SHA_A = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const SHA_B = "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3";

const reported = (): ReplyCoverage => ({ status: "reported" });
const missingReply = (): ReplyCoverage => ({ status: "missing" });
const unreadableReply = (path: string, detail?: string): ReplyCoverage => ({ status: "unreadable", path, detail });

function journalCoverage(children: readonly string[], replies: readonly (readonly [string, ReplyCoverage])[]): HostCoverage {
  return { kind: "journal", children, replies: new Map(replies) };
}

/** The three-lens roster this console ships with (`REVIEW_CONSOLE_ASPECTS`). */
const DEFAULT_LENSES = [
  { aspect: "arch", worker: "rev-arch-1", reported: true },
  { aspect: "context", worker: "rev-ctx-1", reported: true },
  { aspect: "lang", worker: "rev-lang-1", reported: true },
];

/**
 * A parsed `Collation`. `finding_count` is filled from `findings` unless the
 * caller overrides both — `collation.test.ts`'s own rule — so no fixture
 * accidentally exercises the declared-vs-counted disagreement while claiming
 * to test something else.
 */
function buildCollation(opts: {
  parentTaskId: string;
  lenses?: readonly Record<string, unknown>[];
  findings?: readonly Record<string, unknown>[];
  finding_count?: number;
}): Collation {
  const findings = opts.findings ?? [];
  const finding_count = opts.finding_count ?? findings.length;
  return CollationSchema.parse({
    schema: COLLATION_SCHEMA,
    task_id: `${opts.parentTaskId}-collate`,
    parent_task_id: opts.parentTaskId,
    lenses: opts.lenses ?? DEFAULT_LENSES,
    findings,
    finding_count,
  });
}

function input(overrides: Partial<DeriveVerdictInput>): DeriveVerdictInput {
  return {
    collation: null,
    coverage: { kind: "no_journal_entry" },
    recordedSha: SHA_A,
    currentSha: SHA_A,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ISC-537 — the loop reads the collation from the `-collate` task, never
// from the fan-out parent.
// ---------------------------------------------------------------------------

describe("ISC-537 — no collation is never APPROVED", () => {
  test("full host coverage and a null collation must not report APPROVED", () => {
    const parent = "T-rv-537";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const l = childTaskId(parent, "lang");
    const coverage = journalCoverage([a, c, l], [
      [a, reported()],
      [c, reported()],
      [l, reported()],
    ]);

    // There is no field on `DeriveVerdictInput` through which a fan-out
    // parent's own `success` settlement could reach this function — this
    // fixture demonstrates that even when host coverage looks perfect, the
    // absence of a collation itself is never read as APPROVED.
    const result = deriveReviewVerdict(input({ collation: null, coverage }));

    expect(result.kind).not.toBe("APPROVED");
    expect(result.kind).toBe("NO_COLLATION");
    expect(result.countsAgainstIterationBudget).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISC-538 — reported < dispatched yields REVIEW_INCOMPLETE, and the round
// does not advance the iteration counter.
// ---------------------------------------------------------------------------

describe("ISC-538 — partial coverage is REVIEW_INCOMPLETE, not a counted round", () => {
  test("one reported:false row and empty findings is neither APPROVED nor CHANGES_REQUESTED", () => {
    const parent = "T-rv-538";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const l = childTaskId(parent, "lang");
    const coverage = journalCoverage([a, c, l], [
      [a, reported()],
      [c, reported()],
      [l, missingReply()],
    ]);
    const collation = buildCollation({
      parentTaskId: parent,
      lenses: [
        { aspect: "arch", worker: "rev-arch-1", reported: true },
        { aspect: "context", worker: "rev-ctx-1", reported: true },
        { aspect: "lang", worker: "rev-lang-1", reported: false },
      ],
      findings: [],
    });

    const result = deriveReviewVerdict(input({ collation, coverage }));

    // Both halves of the acceptance criterion, asserted separately.
    expect(result.kind).not.toBe("APPROVED");
    expect(result.kind).not.toBe("CHANGES_REQUESTED");
    expect(result.kind).toBe("REVIEW_INCOMPLETE");
    expect(nextReviewIterationCount(2, result)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ISC-539 — the two kinds of missing lens are reported differently.
// ---------------------------------------------------------------------------

describe("ISC-539 — an absent reply and an unreadable one are named differently", () => {
  test("no envelope exists: the report names no path", () => {
    const parent = "T-rv-539a";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const coverage = journalCoverage([a, c], [
      [a, reported()],
      [c, missingReply()],
    ]);
    const collation = buildCollation({
      parentTaskId: parent,
      lenses: [
        { aspect: "arch", worker: "rev-arch-1", reported: true },
        { aspect: "context", worker: "rev-ctx-1", reported: false },
      ],
      findings: [],
    });

    const result = deriveReviewVerdict(input({ collation, coverage }));
    expect(result.kind).toBe("REVIEW_INCOMPLETE");
    if (result.kind !== "REVIEW_INCOMPLETE") throw new Error("unreachable");

    expect(result.missingLenses).toHaveLength(1);
    expect(result.missingLenses[0]!.childTaskId).toBe(c);
    expect(result.missingLenses[0]!.reason.kind).toBe("missing");

    const line = describeMissingLens(result.missingLenses[0]!);
    expect(line).not.toContain("/");
  });

  test("a written-but-unreadable envelope: the report names its path", () => {
    const parent = "T-rv-539b";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const path = `/run/${parent}/relay/rev-ctx-1/replies/${c}.json`;
    const coverage = journalCoverage([a, c], [
      [a, reported()],
      [c, unreadableReply(path, "Unexpected token I in JSON at position 0")],
    ]);
    const collation = buildCollation({
      parentTaskId: parent,
      lenses: [
        { aspect: "arch", worker: "rev-arch-1", reported: true },
        { aspect: "context", worker: "rev-ctx-1", reported: false },
      ],
      findings: [],
    });

    const result = deriveReviewVerdict(input({ collation, coverage }));
    expect(result.kind).toBe("REVIEW_INCOMPLETE");
    if (result.kind !== "REVIEW_INCOMPLETE") throw new Error("unreachable");

    expect(result.missingLenses).toHaveLength(1);
    expect(result.missingLenses[0]!.reason.kind).toBe("unreadable");

    const line = describeMissingLens(result.missingLenses[0]!);
    expect(line).toContain(path);
  });
});

// ---------------------------------------------------------------------------
// ISC-540 — consensus findings drive the fix brief, ranked above single-lens
// findings.
// ---------------------------------------------------------------------------

describe("ISC-540 — consensus findings are ranked first in the fix brief", () => {
  test("a 2-of-3 finding and a single-lens finding both reach the brief, consensus first", () => {
    const parent = "T-rv-540";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const l = childTaskId(parent, "lang");
    const coverage = journalCoverage([a, c, l], [
      [a, reported()],
      [c, reported()],
      [l, reported()],
    ]);
    const collation = buildCollation({
      parentTaskId: parent,
      findings: [
        {
          statement: "the single-lens nit is listed here first, on purpose",
          file: "src/run/other.ts",
          line: 4,
          raised_by: ["rev-lang-1"],
          disputed_by: [],
        },
        {
          statement: "two lenses agree this drops an error silently",
          file: "/workspace/src/run/relay.ts",
          line: 120,
          raised_by: ["rev-arch-1", "rev-ctx-1"],
          disputed_by: [],
        },
      ],
    });

    const result = deriveReviewVerdict(input({ collation, coverage }));
    expect(result.kind).toBe("CHANGES_REQUESTED");
    if (result.kind !== "CHANGES_REQUESTED") throw new Error("unreachable");

    expect(result.findings).toHaveLength(2);
    // Ranked: the consensus finding is FIRST despite appearing second in the source.
    expect(result.findings[0]!.raisedBy).toEqual(["rev-arch-1", "rev-ctx-1"]);
    expect(result.findings[0]!.file).toBe("src/run/relay.ts"); // container path rewritten repo-relative
    expect(result.findings[1]!.raisedBy).toEqual(["rev-lang-1"]);
    expect(result.findings[1]!.file).toBe("src/run/other.ts"); // already repo-relative, unchanged
    expect(result.findingCountMismatch).toBeNull();
  });

  test("finding_count disagreeing with findings.length is reported, and findings.length still governs the verdict", () => {
    const parent = "T-rv-540b";
    const a = childTaskId(parent, "arch");
    const coverage = journalCoverage([a], [[a, reported()]]);
    const collation = buildCollation({
      parentTaskId: parent,
      lenses: [{ aspect: "arch", worker: "rev-arch-1", reported: true }],
      findings: [
        { statement: "one real finding", file: "src/a.ts", line: 1, raised_by: ["rev-arch-1"], disputed_by: [] },
      ],
      finding_count: 5, // the collator's own arithmetic disagrees with the list
    });

    const result = deriveReviewVerdict(input({ collation, coverage }));
    expect(result.kind).toBe("CHANGES_REQUESTED");
    if (result.kind !== "CHANGES_REQUESTED") throw new Error("unreachable");
    expect(result.findings).toHaveLength(1); // findings.length governs, not finding_count
    expect(result.findingCountMismatch).toEqual({ declared: 5, actual: 1 });
  });
});

// ---------------------------------------------------------------------------
// ISC-541 — anti: the loop never reads the collator's own status as the
// review's verdict.
// ---------------------------------------------------------------------------

describe("ISC-541 — anti: a collator's own claimed status is never read", () => {
  test("full coverage and zero findings is APPROVED, regardless of what the collate task's own envelope might claim", () => {
    // There is no parameter on `DeriveVerdictInput` carrying a collate task's
    // `pifleet.result/v1` status — a `partial` claim there, if one existed,
    // has no channel to reach this function at all.
    const parent = "T-rv-541";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const l = childTaskId(parent, "lang");
    const coverage = journalCoverage([a, c, l], [
      [a, reported()],
      [c, reported()],
      [l, reported()],
    ]);
    const collation = buildCollation({ parentTaskId: parent, findings: [] });

    const result = deriveReviewVerdict(input({ collation, coverage }));
    expect(result.kind).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------
// ISC-542 / ISC-543 — coverage is the host's count, never the collation's;
// a disagreement between the two is reported, not silently preferred.
// ---------------------------------------------------------------------------

describe("ISC-542 / ISC-543 — the host's coverage wins, and a lie about it is named", () => {
  test("collation.json claims 3-of-3 reported; the journal's replies say 2-of-3 — REVIEW_INCOMPLETE", () => {
    const parent = "T-rv-542";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const l = childTaskId(parent, "lang");
    const stray = `${parent}-stray`; // a reply file the journal never dispatched
    const coverage = journalCoverage(
      [a, c, l],
      [
        [a, reported()],
        [c, reported()],
        [l, missingReply()],
        [stray, reported()], // must NOT be counted — it is not one of `children`
      ],
    );
    const collation = buildCollation({
      parentTaskId: parent,
      lenses: [
        { aspect: "arch", worker: "rev-arch-1", reported: true },
        { aspect: "context", worker: "rev-ctx-1", reported: true },
        { aspect: "lang", worker: "rev-lang-1", reported: true }, // the lie: host says missing
      ],
      findings: [],
    });

    const result = deriveReviewVerdict(input({ collation, coverage }));

    // ISC-542: a gate reading `lenses[]` for its count would see 3/3 and
    // pass this fixture. The real dispatched/reported numbers are 3/2.
    expect(result.kind).toBe("REVIEW_INCOMPLETE");
    if (result.kind !== "REVIEW_INCOMPLETE") throw new Error("unreachable");
    expect(result.coverage).toEqual({ dispatched: 3, reported: 2 });

    // ISC-543: the disagreement itself is named, not silently preferred.
    const disagreement = result.lensDisagreements.find((d) => d.kind === "reported_true_without_reply");
    expect(disagreement).toBeDefined();
    expect(disagreement!.detail).toContain("lang");
    expect(disagreement!.detail).toContain(l);
  });

  test("a journal child with no lens row, and a lens row for an aspect never dispatched, are both reported (full coverage)", () => {
    const parent = "T-rv-542x";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const l = childTaskId(parent, "lang");
    // Full coverage on the host side — this reaches Gate 2 as APPROVED, and
    // the lens-table cross-check still fires independently of the verdict.
    const coverage = journalCoverage([a, c, l], [
      [a, reported()],
      [c, reported()],
      [l, reported()],
    ]);
    const collation = buildCollation({
      parentTaskId: parent,
      lenses: [
        { aspect: "arch", worker: "rev-arch-1", reported: true },
        // "context" has NO row at all, despite being dispatched and reported.
        { aspect: "lang", worker: "rev-lang-1", reported: true },
        // "extra" was never dispatched by this journal at all.
        { aspect: "extra", worker: "rev-extra-1", reported: true },
      ],
      findings: [],
    });

    const result = deriveReviewVerdict(input({ collation, coverage }));
    expect(result.kind).toBe("APPROVED");
    if (result.kind !== "APPROVED") throw new Error("unreachable");

    const kinds = result.lensDisagreements.map((d) => d.kind).sort();
    expect(kinds).toEqual(["row_for_undispatched_lens", "row_missing_for_dispatched_child"]);
  });

  test("anti: the gate does not depend on censusCeiling — a partial-shaped collation still yields a verdict", () => {
    // `collation-census.ts:490`'s `censusCeiling` returns null unless the
    // claim is `success`; a gate leaning on it would be blind for exactly the
    // status this gate exists to handle. This module never imports it.
    // Checked against the actual `import` statements rather than the whole
    // file: the module's own docblock cites `collation-census.ts` and
    // `censusCeiling` by name as the thing it does NOT depend on, which is
    // documentation, not a dependency.
    const source = readFileSync(new URL("../../src/run/pm-verdict.ts", import.meta.url), "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      expect(line).not.toContain("collation-census");
      expect(line).not.toContain("censusCeiling");
    }

    const parent = "T-rv-544";
    const a = childTaskId(parent, "arch");
    const coverage = journalCoverage([a], [[a, reported()]]);
    const collation = buildCollation({
      parentTaskId: parent,
      lenses: [{ aspect: "arch", worker: "rev-arch-1", reported: true }],
      findings: [
        { statement: "single-lens finding", file: "src/a.ts", line: 1, raised_by: ["rev-arch-1"], disputed_by: [] },
      ],
    });

    const result = deriveReviewVerdict(input({ collation, coverage }));
    expect(result).toBeDefined();
    expect(result.kind).toBe("CHANGES_REQUESTED");
  });
});

// ---------------------------------------------------------------------------
// ISC-545 — a moved checkout voids the round.
// ---------------------------------------------------------------------------

describe("ISC-545 — a moved checkout voids the round", () => {
  test("HEAD differs between dispatch and collation: VOID, not APPROVED, not REVIEW_INCOMPLETE, iteration counter unchanged", () => {
    const parent = "T-rv-545";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const l = childTaskId(parent, "lang");
    const coverage = journalCoverage([a, c, l], [
      [a, reported()],
      [c, reported()],
      [l, reported()],
    ]);
    const collation = buildCollation({ parentTaskId: parent, findings: [] });

    const result = deriveReviewVerdict(
      input({ collation, coverage, recordedSha: SHA_A, currentSha: SHA_B }),
    );

    expect(result.kind).toBe("VOID");
    expect(result.kind).not.toBe("APPROVED");
    expect(result.kind).not.toBe("REVIEW_INCOMPLETE");
    expect(nextReviewIterationCount(1, result)).toBe(1);
    if (result.kind === "VOID") {
      expect(result.recordedSha).toBe(SHA_A);
      expect(result.currentSha).toBe(SHA_B);
    }
  });
});

// ---------------------------------------------------------------------------
// Supporting unit coverage for the repo-relative path rewrite §7.5 requires
// for the fix brief. Not a numbered ISC on its own — folded into ISC-540
// above via the derived verdict, and asserted directly here.
// ---------------------------------------------------------------------------

describe("toRepoRelativePath", () => {
  test("rewrites a container-absolute path to repo-relative", () => {
    expect(toRepoRelativePath("/workspace/src/run/relay.ts")).toBe("src/run/relay.ts");
  });

  test("leaves an already repo-relative path unchanged", () => {
    expect(toRepoRelativePath("src/run/relay.ts")).toBe("src/run/relay.ts");
  });

  test("hands back a path it cannot place under the container workdir, rather than fabricate one", () => {
    expect(toRepoRelativePath("/etc/passwd")).toBe("/etc/passwd");
  });
});

// ---------------------------------------------------------------------------
// Anti-vacuity: a fan-out that dispatched NOTHING.
// ---------------------------------------------------------------------------

/**
 * The degenerate input every coverage gate has to survive, and the one no
 * fixture above supplies: a round where no lens was dispatched at all.
 *
 * `reported === dispatched` is then `0 === 0`, so a gate written as "did
 * everyone who was asked report?" answers YES on a round where nobody was
 * asked. Read together with an empty `findings[]` — what a collator with no
 * lens replies would naturally produce — that is the worst output this
 * function has available: **APPROVED, on a review that never happened.**
 *
 * Writing the fixture found that TWO independent things already prevent it,
 * and neither was pinned. Both are asserted here, because either one alone
 * would leave the other free to rot:
 *
 * 1. `CollationSchema` will not construct the record. `lenses[]` carries a
 *    `.min(1)` whose message is about the denominator a finding's `2/3` needs
 *    — written for a different reason entirely, and load-bearing here.
 * 2. `deriveReviewVerdict` orders its `reported === 0` arm AHEAD of the
 *    `reported < dispatched` comparison, so an empty journal lands on
 *    `NO_COLLATION/not_collated` and never reaches Gate 2. That ordering is
 *    the whole defence, and hoisting the comparison — the obvious tidy — is
 *    the refactor that would have been green before this block existed.
 */
describe("anti: a fan-out that dispatched no lens is never APPROVED", () => {
  test("the collation schema refuses a lens-less record outright", () => {
    expect(() => buildCollation({ parentTaskId: "T-rv-empty", lenses: [], findings: [] })).toThrow(
      /lenses\[\] is empty/,
    );
  });

  test("an empty journal is NO_COLLATION even when a well-formed collation exists", () => {
    // The collation is the ordinary three-lens one; only the RUN TREE is
    // empty. This is the case §7.5 cares about — coverage comes from the
    // journal, never from what the collator claims about itself.
    const verdict = deriveReviewVerdict(
      input({
        coverage: journalCoverage([], []),
        collation: buildCollation({ parentTaskId: "T-rv-empty", findings: [] }),
      }),
    );
    expect(verdict.kind).toBe("NO_COLLATION");
    if (verdict.kind === "NO_COLLATION") expect(verdict.reason).toBe("not_collated");
    expect(verdict.countsAgainstIterationBudget).toBe(false);
  });

  test("and with no collation at all it is still NO_COLLATION, never APPROVED", () => {
    const verdict = deriveReviewVerdict(input({ coverage: journalCoverage([], []), collation: null }));
    expect(verdict.kind).toBe("NO_COLLATION");
  });

  test("the fixture is genuinely empty — otherwise this whole block is vacuous", () => {
    const coverage = journalCoverage([], []);
    expect(coverage.kind).toBe("journal");
    if (coverage.kind === "journal") expect(coverage.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ISC-544 — the gate does not depend on `censusCeiling`.
// ---------------------------------------------------------------------------

/**
 * The criterion is about a DEPENDENCY, so it is asserted two ways: what this
 * module imports, and what it does on the input the dependency would have
 * mattered for.
 *
 * `harvest/collation-census.ts` returns null unless a claim is fully
 * locatable, which is a grade about whether findings can be pointed at — a
 * different question from whether the review happened. A verdict that
 * silently required it would turn "one finding cites a path I cannot resolve"
 * into "no verdict", and the loop would stall on a review that ran fine. The
 * docblock says this module does not import it; this makes that checkable.
 */
describe("ISC-544 (anti): the verdict does not depend on censusCeiling", () => {
  test("the module's source imports nothing from harvest/", () => {
    const src = readFileSync(new URL("../../src/run/pm-verdict.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => i !== undefined && /harvest\//.test(i))).toEqual([]);
    expect(imports.filter((i) => i !== undefined && /collation-census/.test(i))).toEqual([]);
  });

  test("a finding whose file cannot be placed under the workdir still yields a verdict", () => {
    // The exact input a locatability grade refuses: a citation that is not
    // under the container workdir at all. The verdict must still be reached.
    const parent = "T-rv-544";
    const a = childTaskId(parent, "arch");
    const c = childTaskId(parent, "context");
    const l = childTaskId(parent, "lang");
    const verdict = deriveReviewVerdict(
      input({
        coverage: journalCoverage(
          [a, c, l],
          [
            [a, reported()],
            [c, reported()],
            [l, reported()],
          ],
        ),
        collation: buildCollation({
          parentTaskId: parent,
          findings: [
            {
              file: "/etc/passwd",
              line: 1,
              statement: "a citation nothing can place under the workdir",
              raised_by: ["rev-arch-1", "rev-ctx-1"],
            },
          ],
        }),
      }),
    );
    expect(verdict.kind).toBe("CHANGES_REQUESTED");
    if (verdict.kind === "CHANGES_REQUESTED") {
      // Handed back unchanged rather than fabricated into a repo path.
      expect(verdict.findings[0]?.file).toBe("/etc/passwd");
    }
  });
});
