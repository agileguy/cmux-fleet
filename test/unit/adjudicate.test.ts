/**
 * The adjudicator (ISC-92..94, 150..154), table-driven.
 *
 * Every fixture is built through the real zod schemas, so a schema change
 * that breaks the adjudicator's inputs breaks these tests too. Every case
 * imports and calls the production `adjudicate` — nothing here re-derives a
 * verdict by hand, because a test that re-implements the expression under
 * test can never fail.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  DerivedFactsSchema,
  ResultEnvelopeSchema,
  AcceptanceRunSchema,
  type AcceptanceRun,
  type DerivedFacts,
  type ResultEnvelope,
  type Status,
  type Verdict,
} from "../../src/contracts.ts";
import { acceptanceEvidence, adjudicate, factsHash } from "../../src/harvest/adjudicate.ts";
import { gradedSurface } from "../../src/harvest/resolution-surface.ts";

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "b".repeat(40);
const SHA_GHOST = "c".repeat(40);

function run(outcome: AcceptanceRun["outcome"], over: Partial<AcceptanceRun> = {}): AcceptanceRun {
  return AcceptanceRunSchema.parse({
    cmd: "bun test",
    source: "envelope",
    resolved_from: SHA_BASE,
    outcome,
    exit_code: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null,
    ...over,
  });
}

/** A healthy baseline: clean one-file diff, one commit, green acceptance. */
// Overrides are typed as the schema's INPUT, not its output, so a fixture may
// name only the fields it cares about — `harness: {patterns, touched}` without
// restating every defaulted key beside them.
function facts(over: Partial<z.input<typeof DerivedFactsSchema>> = {}): DerivedFacts {
  return DerivedFactsSchema.parse({
    branch: "fleet/run-1/eng-1",
    base_ref: SHA_BASE,
    head_ref: SHA_HEAD,
    base_is_ancestor: true,
    commits: [SHA_HEAD],
    files_changed: [{ path: "src/a.ts", change: "modified" }],
    diff_bytes: 120,
    acceptance: [run("passed")],
    acceptance_context: null,
    harness: { patterns: [], touched: [] },
    tree_hash_quiesce: "tree-1",
    tree_hash_harvest: "tree-1",
    ...over,
  });
}

/**
 * The worker's claim for a `gradedFacts` diff.
 *
 * It must list the SAME files the derived diff has, or ISC-92's over/under
 * claim rule fires first and the case grades that instead of the ISC-243 cap
 * it was written for — which is exactly what these nine cases did on their
 * first run.
 */
function gradedClaim(file: string, status: Status = "success"): ResultEnvelope {
  return claim(status, {
    files_changed: [
      { path: "src/a.ts", change: "modified" },
      { path: file, change: "modified" },
    ],
  });
}

/**
 * Facts whose graded surface is computed by the PRODUCTION `gradedSurface`
 * (ISC-243), not hand-written.
 *
 * Hand-writing the `graded` array would let a case assert a tier no manifest
 * actually assigns, which is the shape of a test that grades its own fixture.
 * Here the only inputs are a command and a file, exactly as the harvester has
 * them, and the tier is whatever the real manifests say it is.
 */
function gradedFacts(
  cmd: string,
  file: string,
  denylist: { patterns: string[]; touched: string[] } = { patterns: [], touched: [] },
): DerivedFacts {
  const files = ["src/a.ts", file];
  const surface = gradedSurface([cmd], files);
  return facts({
    files_changed: files.map((path) => ({ path, change: "modified" as const })),
    acceptance: [run("passed", { cmd })],
    harness: {
      ...denylist,
      graded: surface.hits.map((h) => ({ file: h.file, tier: h.tier, why: h.why })),
      graded_runners: [...surface.runners],
      graded_unresolved: [...surface.unresolved],
    },
  });
}

function claim(status: Status, over: Partial<ResultEnvelope> = {}): ResultEnvelope {
  return ResultEnvelopeSchema.parse({
    schema: "pifleet.result/v1",
    task_id: "T-1",
    epoch: 1,
    worker: "eng-1",
    status,
    files_changed: [{ path: "src/a.ts", change: "modified" }],
    commits: [SHA_HEAD],
    ...over,
  });
}

interface Case {
  name: string;
  facts: DerivedFacts;
  claimed: ResultEnvelope | null;
  want: Verdict;
  /** Substring that must appear in reasons (evidence trail is part of the contract). */
  wantReason?: string;
  /** Substring that must appear in discrepancies. */
  wantDiscrepancy?: string;
  /** When set, discrepancies must be exactly empty. */
  noDiscrepancies?: boolean;
}

const CASES: Case[] = [
  // ISC-94 — the identity rule. Fails if a missing envelope is ever treated
  // as the lattice bottom instead of the identity element.
  {
    name: "ISC-94: clean diff + green acceptance + missing envelope is success, not unknown",
    facts: facts(),
    claimed: null,
    want: "success",
    wantReason: "no result envelope",
    noDiscrepancies: true,
  },
  // ISC-93 — fails if the claimed-success-with-empty-diff rule is dropped or
  // if the empty-diff test forgets any of files/commits/bytes.
  {
    name: "ISC-93: claimed success with an empty diff is failed",
    facts: facts({ files_changed: [], commits: [], diff_bytes: 0, acceptance: [] }),
    claimed: claim("success", { files_changed: [], commits: [] }),
    want: "failed",
    wantReason: "ISC-93",
  },
  // ISC-92 — fails if the over-claim comparison is removed or compares the
  // envelope against itself rather than against the derived diff.
  {
    name: "ISC-92: a claimed file the diff does not touch is flagged and hard-fails (F5)",
    facts: facts(),
    claimed: claim("success", {
      files_changed: [
        { path: "src/a.ts", change: "modified" },
        { path: "src/ghost.ts", change: "added" },
      ],
    }),
    want: "failed",
    wantReason: "F5",
    wantDiscrepancy: "src/ghost.ts",
  },
  // Concealment direction of F5 — fails if the comparison only runs one way.
  {
    name: "a diff file the envelope conceals is flagged and hard-fails (F5)",
    facts: facts({
      files_changed: [
        { path: "src/a.ts", change: "modified" },
        { path: ".github/workflows/ci.yml", change: "modified" },
      ],
    }),
    claimed: claim("success"),
    want: "failed",
    wantDiscrepancy: ".github/workflows/ci.yml",
  },
  // Fabricated commit — fails if the commits cross-check is dropped. Verdict
  // stays success (F5 is reserved for files-vs-diff), the flag must not be.
  {
    name: "a claimed commit not in base..HEAD is flagged without failing on its own",
    facts: facts(),
    claimed: claim("success", { commits: [SHA_HEAD, SHA_GHOST] }),
    want: "success",
    wantDiscrepancy: SHA_GHOST,
  },
  // SRD §7.3 downgrade — fails if the claim is ignored or the lattice min is
  // replaced by anything claim-favoring.
  {
    name: "self-report may downgrade: derived success + claimed partial is partial",
    facts: facts(),
    claimed: claim("partial"),
    want: "partial",
    wantReason: "downgraded",
  },
  // SRD §7.3 no-upgrade — fails if min() becomes max() or the claim wins ties
  // upward.
  {
    name: "self-report may not upgrade: derived failed + claimed success is failed",
    facts: facts({ acceptance: [run("failed")] }),
    claimed: claim("success"),
    want: "failed",
    wantReason: "acceptance failed",
  },
  // ISC-152 — fails if timed_out is folded into failed anywhere between the
  // runner's outcome and the adjudicated verdict.
  {
    name: "ISC-152: a timed-out acceptance command adjudicates to unknown, not failed",
    facts: facts({ acceptance: [run("timed_out")] }),
    claimed: null,
    want: "unknown",
    wantReason: "ISC-152",
  },
  // ISC-230. `unknown` as identity is about a missing CLAIM, not missing
  // EVIDENCE. Adopting a success claim when the exam timed out gave a worker a
  // grading bypass that needs no harness edit: ship a change that makes an
  // existing command hang, claim success, collect it. An exam that did not
  // finish cannot certify success, so the claim is not adopted.
  //
  // Fails if the ISC-230 cap is removed from adjudicate() — the verdict then
  // reverts to "success", which is how this was found.
  {
    name: "timed-out acceptance does NOT let a success claim through (ISC-230)",
    facts: facts({ acceptance: [run("timed_out")] }),
    claimed: claim("success"),
    want: "unknown",
    wantReason: "an unfinished exam cannot certify success",
  },
  // The cap must not become a downgrade-blocker: negative claims still land.
  // Fails if the cap is applied unconditionally rather than only above blocked.
  {
    name: "a timed-out exam still lets the worker's own failure claim through",
    facts: facts({ acceptance: [run("timed_out")] }),
    claimed: claim("failed"),
    want: "failed",
  },
  // And ISC-94 is untouched: no exam configured at all is not an unfinished
  // exam. Fails if the cap keys on "not all passed" instead of "attempted and
  // inconclusive".
  {
    name: "an empty acceptance list is not an unfinished exam (ISC-94 preserved)",
    facts: facts({ acceptance: [] }),
    claimed: claim("success"),
    want: "success",
  },
  // Mixed evidence: one green run does not certify a suite that did not
  // finish. Fails if the evidence function returns success on any-passed.
  {
    name: "passed + timed_out together are inconclusive, not success",
    facts: facts({ acceptance: [run("passed"), run("timed_out")] }),
    claimed: null,
    want: "unknown",
  },
  // not_run proves nothing — fails if budget-exhausted commands are counted
  // as failures.
  {
    name: "not_run acceptance adjudicates to unknown",
    facts: facts({ acceptance: [run("not_run")] }),
    claimed: null,
    want: "unknown",
  },
  // ISC-150, the load-bearing ordering case: the cap must be applied AFTER
  // the lattice combination. Fails if the cap runs first — capped-derived
  // unknown + claimed success would then resurrect success via the identity.
  {
    name: "ISC-150: harness touched + claimed success can never be success",
    facts: facts({
      files_changed: [{ path: "test/a.test.ts", change: "modified" }],
      harness: { patterns: ["test/**"], touched: ["test/a.test.ts"] },
    }),
    claimed: claim("success", { files_changed: [{ path: "test/a.test.ts", change: "modified" }] }),
    want: "unknown",
    wantReason: "ISC-150",
  },
  // ISC-150 with everything green and no claim — fails if the cap only fires
  // on the claimed path.
  {
    name: "ISC-150: harness touched + green acceptance + no envelope is unknown, not success",
    facts: facts({
      files_changed: [{ path: "package.json", change: "modified" }],
      harness: { patterns: ["package.json"], touched: ["package.json"] },
    }),
    claimed: null,
    want: "unknown",
    wantReason: "self-certified",
  },
  // The cap is a ceiling, not a floor — verdicts at or below blocked pass
  // through. Fails if the cap overwrites everything with unknown.
  {
    name: "ISC-150: harness touched + claimed blocked stays blocked",
    facts: facts({
      files_changed: [{ path: "test/a.test.ts", change: "modified" }],
      harness: { patterns: ["test/**"], touched: ["test/a.test.ts"] },
    }),
    claimed: claim("blocked", { files_changed: [{ path: "test/a.test.ts", change: "modified" }] }),
    want: "blocked",
  },
  // Negative evidence survives the cap: a worker's own harness indicting the
  // worker only ever downgrades. Fails if the cap lifts failures to unknown.
  {
    name: "ISC-150: harness touched + failed acceptance stays failed",
    facts: facts({
      acceptance: [run("failed")],
      files_changed: [{ path: "test/a.test.ts", change: "modified" }],
      harness: { patterns: ["test/**"], touched: ["test/a.test.ts"] },
    }),
    claimed: null,
    want: "failed",
  },
  // ISC-154 — fails if the tree-hash comparison is dropped or only warns.
  {
    name: "ISC-154: a tree that moved between quiesce and harvest forces unknown",
    facts: facts({ tree_hash_quiesce: "tree-1", tree_hash_harvest: "tree-2" }),
    claimed: claim("success"),
    want: "unknown",
    wantReason: "ISC-154",
  },
  // ISC-154 only fires on a PROVEN move — a missing hash is absence of
  // evidence. Fails if null is treated as a mismatch, which would void every
  // harvest that could not hash the tree.
  {
    name: "a missing tree hash does not force unknown",
    facts: facts({ tree_hash_quiesce: null, tree_hash_harvest: "tree-2" }),
    claimed: null,
    want: "success",
  },
  // ISC-151 — fails if the ancestor flag is ignored, which would let a
  // rewritten base shrink the diff to nothing and sail through as success.
  {
    name: "ISC-151: base not an ancestor of HEAD forces unknown",
    facts: facts({ base_is_ancestor: false }),
    claimed: claim("success"),
    want: "unknown",
    wantReason: "ISC-151",
  },

  /**
   * ISC-243 — the graded cap.
   *
   * These are the cases the DENYLIST lets through today, verbatim from the
   * measurement in this criterion's ISA entry: each is a diff of one ordinary
   * source file plus one resolution-surface file, carrying one passing
   * acceptance run, which certified `success` before the allowlist existed.
   * The `graded` field is built the way the harvester builds it — by calling
   * the production `gradedSurface` — so a case cannot assert a tier the
   * manifests do not actually produce.
   */
  {
    name: "ISC-243: executes tier (vite.config.ts under vitest) caps a green run to unknown",
    facts: gradedFacts("vitest run", "vite.config.ts"),
    claimed: gradedClaim("vite.config.ts"),
    want: "unknown",
    wantReason: "ISC-243",
  },
  {
    name: "ISC-243: toolchain tier (.python-version under pytest) caps a green run to unknown",
    facts: gradedFacts("pytest", ".python-version"),
    claimed: gradedClaim(".python-version"),
    want: "unknown",
    wantReason: "toolchain tier",
  },
  /**
   * The grade's whole operational content. If this ever reads `unknown` the
   * three tiers have collapsed back into the boolean they replaced, and
   * ISC-243's word "graded" is decoration.
   */
  {
    name: "ISC-243: dependency tier (go.sum under go test) caps to partial, NOT unknown",
    facts: gradedFacts("go test ./...", "go.sum"),
    claimed: gradedClaim("go.sum"),
    want: "partial",
    wantReason: "dependency tier",
  },
  {
    name: "ISC-243: dependency tier (Cargo.lock) caps to partial under cargo too",
    facts: gradedFacts("cargo test", "Cargo.lock"),
    claimed: gradedClaim("Cargo.lock"),
    want: "partial",
  },
  /**
   * Keyed on the RUNNER, which is the property a denylist cannot have: the
   * same file, the same diff, a different resolved command, and no cap —
   * because `bun test` genuinely does not read `vite.config.ts`.
   */
  {
    name: "ISC-243: the same file under a runner that does not read it is not capped",
    facts: gradedFacts("bun test", "vite.config.ts"),
    claimed: gradedClaim("vite.config.ts"),
    want: "success",
  },
  /**
   * The merge direction, which is the safety property. The denylist caps to
   * `unknown`; a `dependency`-tier graded hit must not lift it back to
   * `partial`. Fails if the graded cap is ever applied as an assignment rather
   * than as a ceiling, or is moved above the ISC-150 block.
   */
  {
    name: "ISC-243: a dependency-tier grade cannot lift a verdict the denylist pinned",
    facts: gradedFacts("go test ./...", "go.sum", { patterns: [], touched: ["test/a_test.go"] }),
    claimed: gradedClaim("go.sum"),
    want: "unknown",
    wantReason: "ISC-150",
  },
  /**
   * The residual made loud (ISC-243). "I could not determine the harness
   * surface for `npm test`" and "the diff is clean" both certify `success`,
   * and must not produce the same report.
   */
  {
    name: "ISC-243: an unresolvable runner certifies, but raises a discrepancy",
    facts: gradedFacts("npm test", "src/b.ts"),
    claimed: gradedClaim("src/b.ts"),
    want: "success",
    wantDiscrepancy: "could not be resolved",
  },
  {
    name: "ISC-243: no discrepancy when something else already refused to certify",
    facts: gradedFacts("npm test", "src/b.ts", { patterns: [], touched: ["test/a.test.ts"] }),
    claimed: gradedClaim("src/b.ts"),
    want: "unknown",
  },
  {
    name: "ISC-243: a clean diff under a resolved runner is untouched and silent",
    facts: gradedFacts("bun test", "docs/design.md"),
    claimed: gradedClaim("docs/design.md"),
    want: "success",
    noDiscrepancies: true,
  },
];

describe("adjudicate — verdict table", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const got = adjudicate(c.facts, c.claimed);
      expect(got.verdict).toBe(c.want);
      if (c.wantReason !== undefined) {
        expect(got.reasons.join("\n")).toContain(c.wantReason);
      }
      if (c.wantDiscrepancy !== undefined) {
        expect(got.discrepancies.join("\n")).toContain(c.wantDiscrepancy);
      }
      if (c.noDiscrepancies) {
        expect(got.discrepancies).toEqual([]);
      }
    });
  }
});

describe("acceptanceEvidence", () => {
  // Fails if any-passed short-circuits to success or empty becomes failed.
  test("empty run list is unknown, all-passed is success, any-failed is failed", () => {
    expect(acceptanceEvidence([]).verdict).toBe("unknown");
    expect(acceptanceEvidence([run("passed"), run("passed")]).verdict).toBe("success");
    expect(acceptanceEvidence([run("passed"), run("failed")]).verdict).toBe("failed");
  });

  // ISC-152 at the evidence layer — fails if timed_out is grouped with failed.
  test("failed outranks timed_out; timed_out alone is unknown", () => {
    expect(acceptanceEvidence([run("timed_out"), run("failed")]).verdict).toBe("failed");
    expect(acceptanceEvidence([run("timed_out")]).verdict).toBe("unknown");
  });
});

describe("facts hash (ISC-153)", () => {
  // Fails if the hash reads JSON.stringify property order instead of
  // canonicalJson — the exact class of replay-mismatch bug the hash exists
  // to catch in others.
  test("hash is stable under property insertion order", () => {
    const a = facts();
    // Rebuild with keys inserted in reverse order; schema parse preserves the
    // shape, the object literal below scrambles insertion order on purpose.
    const scrambled = DerivedFactsSchema.parse(
      JSON.parse(canonicalScramble(JSON.stringify(a))),
    );
    expect(factsHash(scrambled)).toBe(factsHash(a));
  });

  // Fails if the hash stops covering some fact field — a harvester could then
  // change evidence without changing the replay key.
  test("changing any fact changes the hash", () => {
    const base = factsHash(facts());
    expect(factsHash(facts({ diff_bytes: 121 }))).not.toBe(base);
    expect(factsHash(facts({ base_is_ancestor: false }))).not.toBe(base);
    expect(factsHash(facts({ acceptance: [run("failed")] }))).not.toBe(base);
  });

  // ISC-153's diagnostic split: same hash, different verdict = adjudicator
  // bug; different hash = harvester bug. The hash must therefore ignore the
  // claim entirely. Fails if the claim (or the verdict) leaks into the hash.
  test("the hash covers the facts, not the claim or the verdict", () => {
    // A GREEN exam, so the claim is what moves the verdict: no claim yields
    // success, a `partial` claim downgrades it. A timed-out fixture no longer
    // works here — ISC-230 caps both branches to `unknown`, which would make
    // the "different verdict" leg pass vacuously rather than prove anything.
    const f = facts({ acceptance: [run("passed")] });
    const withClaim = adjudicate(f, claim("partial"));
    const withoutClaim = adjudicate(f, null);
    expect(withClaim.facts_hash).toBe(withoutClaim.facts_hash);
    expect(withClaim.verdict).not.toBe(withoutClaim.verdict); // same hash, different claim input
    expect(withClaim.facts_hash).toBe(factsHash(f));
  });
});

/** Round-trip JSON with object keys emitted in reverse-sorted order. */
function canonicalScramble(json: string): string {
  const reorder = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(reorder);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort().reverse()) out[k] = reorder(o[k]);
    return out;
  };
  return JSON.stringify(reorder(JSON.parse(json)));
}

// ---------------------------------------------------------------------------
// A task with no repository is not a task with a rewritten one
// ---------------------------------------------------------------------------

/**
 * `base_is_ancestor: false` carries two meanings and the clamp only wants one.
 *
 * ISC-151 reads it as "the base was rewritten, so `diff base...HEAD` can be
 * shrunk to nothing by exactly that move" — a finding, and grading rightly
 * stops. It is ALSO the vacuous default on a fact bundle for a task that never
 * had a base: `harvest/index.ts` builds one of those for every dispatch whose
 * envelope names no `host_workdir`, which is every read-only inquiry — a
 * ticket query, a cluster read.
 *
 * MEASURED, and this is why the field was added rather than the clamp merely
 * loosened: a ticketing task returned `status: success` with both of its
 * acceptance criteria met and its artifacts on disk, and was reported
 * `verdict: unknown` with "the base was rewritten and the diff cannot be
 * trusted" — a sentence about a repository that did not exist, attached to the
 * one task in the run whose evidence was complete.
 *
 * `facts.repository` states which of the two meanings applies, so neither has
 * to be inferred from a default.
 */
describe("the ISC-151 ancestry clamp applies to repository work only", () => {
  /** What `harvest/index.ts` builds when the envelope names no workdir. */
  function inquiryFacts(over: Partial<z.input<typeof DerivedFactsSchema>> = {}): DerivedFacts {
    return DerivedFactsSchema.parse({
      branch: null,
      base_ref: null,
      head_ref: null,
      repository: false,
      base_is_ancestor: false,
      commits: [],
      files_changed: [],
      diff_bytes: 0,
      acceptance: [],
      acceptance_context: null,
      harness: { patterns: [], touched: [] },
      tree_hash_quiesce: null,
      tree_hash_harvest: null,
      ...over,
    });
  }

  /**
   * THE REGRESSION. Fails against the ungated clamp, which returns early with
   * the ancestry reason before it has looked at the envelope at all.
   *
   * The claim lists no files because the task changed none — asserting that
   * explicitly, because ISC-92's over/under-claim rule compares the two lists
   * and an inquiry task's agreement is that both are empty.
   */
  test("an inquiry task with an envelope is not clamped by a base it never had", () => {
    const got = adjudicate(inquiryFacts(), claim("success", { files_changed: [], commits: [] }));

    expect(got.reasons.join(" ")).not.toContain("ISC-151");
    expect(got.reasons.join(" ")).not.toContain("the base was rewritten");
  });

  /**
   * THE CONTROL ARM, and without it the test above is satisfied by deleting
   * the clamp.
   *
   * A task that DOES have a repository and whose base is not an ancestor is
   * the case ISC-151 was written for, and it must still stop grading. The only
   * difference from the fixture above is the flag.
   */
  test("a repository task with a rewritten base still clamps", () => {
    const got = adjudicate(facts({ base_is_ancestor: false }), claim("success"));

    expect(got.verdict).toBe("unknown");
    expect(got.reasons.join(" ")).toContain("ISC-151");
  });

  /**
   * The envelope-less inquiry task still says so.
   *
   * Removing the clamp must not remove the STATEMENT that nothing was checked:
   * a worker that wrote no `result.json` is exactly the case ISC-94's note and
   * the harvester's discrepancy exist for, and an inquiry task has no diff to
   * speak for it in the envelope's absence.
   */
  test("an inquiry task with no envelope is graded on derived facts and says so", () => {
    const got = adjudicate(inquiryFacts(), null);

    expect(got.reasons.join(" ")).not.toContain("ISC-151");
    expect(got.reasons.join(" ")).toContain("no result envelope");
  });

  /**
   * The DEFAULT's direction, asserted rather than assumed.
   *
   * Every fact bundle written before this field existed, and every fixture in
   * this file that does not name it, must keep being graded as repository
   * work — the clamp is what stops a rewritten base grading green, so the
   * default has to be the one that keeps it.
   */
  test("a fact bundle that never names the field is repository work", () => {
    const parsed = DerivedFactsSchema.parse({
      branch: null,
      base_ref: null,
      head_ref: null,
      base_is_ancestor: false,
      harness: {},
    });

    expect(parsed.repository).toBe(true);
    expect(adjudicate(parsed, null).reasons.join(" ")).toContain("ISC-151");
  });
});
