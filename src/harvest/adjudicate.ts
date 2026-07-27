/**
 * The adjudicator — a claim in, a verdict out, every step replayable.
 *
 * Pure by design: `adjudicate(facts, claimed)` touches no filesystem, no
 * clock, no git. The harvester (harvest/index.ts) gathers `DerivedFacts`; this
 * module only weighs them. That split is what makes the verdict testable
 * without I/O and replayable after the fact (ISC-153).
 *
 * The rules, each with the failure it prevents:
 *
 * - **The lattice lives in contracts.ts and nowhere else.** `min(derived,
 *   claimed)` with `unknown` as IDENTITY, not bottom: a worker that forgot to
 *   write an envelope must not drag a clean diff and green acceptance down to
 *   `unknown` (ISC-94). Self-report may downgrade, never upgrade (SRD §7.3).
 *
 * - **A claim contradicted by the diff is a hard failure, not a warning**
 *   (SRD §8.2, class F5). A worker claiming a file the diff does not touch is
 *   flagged in `discrepancies` (ISC-92), and `success` with an empty diff is
 *   reported `failed` (ISC-93) — an envelope that describes work that did not
 *   happen is worse than no envelope at all.
 *
 * - **The harness-surface cap is applied AFTER combining with the claim**
 *   (ISC-150). Order matters: capped-derived `unknown` combined with claimed
 *   `success` would yield `success` through the identity rule — the exact
 *   upgrade the cap exists to forbid. Cap last, and `success` is unreachable.
 *
 * - **A moved tree voids every fact** (ISC-154). If the worktree hash at
 *   harvest end differs from the hash at quiesce, backgrounded work kept
 *   writing: the diff, the file list, even the acceptance clone's parent may
 *   describe a tree that no longer exists. The only honest verdict is
 *   `unknown`, unconditionally.
 *
 * - **The facts hash covers the FACTS, not the verdict** (ISC-153). Same hash
 *   but a different verdict on replay = adjudicator bug; a different hash =
 *   harvester bug. Hashing the verdict into the bundle would collapse those
 *   two distinct failures into one undiagnosable blob.
 */

import { createHash } from "node:crypto";

import {
  canonicalJson,
  rank,
  adjudicate as latticeCombine,
  type AcceptanceRun,
  type DerivedFacts,
  type ResultEnvelope,
  type Verdict,
} from "../contracts.ts";

/** What the adjudicator returns; `facts_hash` makes it replayable. */
export interface Adjudication {
  verdict: Verdict;
  /** Why, in the order the evidence was considered (mirrors HarvestSchema.reasons). */
  reasons: string[];
  /** Claims contradicted by derived facts (ISC-92; HarvestSchema.discrepancies). */
  discrepancies: string[];
  /** sha256 over canonicalJson(facts) — the replay key (ISC-153). */
  facts_hash: string;
}

/**
 * The replay key: sha256 over the canonical JSON of the fact bundle.
 *
 * `canonicalJson` sorts keys, so two bundles with the same content but
 * different property insertion order hash identically — a re-harvest must be
 * comparable to the original without normalizing anything first.
 */
export function factsHash(facts: DerivedFacts): string {
  return createHash("sha256").update(canonicalJson(facts)).digest("hex");
}

/**
 * What the acceptance runs, on their own, prove about the code.
 *
 * - Any `failed` run → `failed`. An independent red suite is direct evidence.
 * - No failure but any `timed_out` or `not_run` → `unknown`. ISC-152: wall
 *   clock running out proves nothing, and a command that never ran proves
 *   less. Passed runs alongside them are noted but cannot certify a suite
 *   that did not finish.
 * - All runs `passed` → `success`.
 * - No runs at all → `unknown`; there is simply no evidence either way.
 */
export function acceptanceEvidence(runs: readonly AcceptanceRun[]): {
  verdict: Verdict;
  reasons: string[];
} {
  if (runs.length === 0) {
    return { verdict: "unknown", reasons: ["no acceptance commands were run"] };
  }
  const failed = runs.filter((r) => r.outcome === "failed");
  if (failed.length > 0) {
    const detail = failed.map((r) => `${r.cmd} (exit ${r.exit_code})`).join("; ");
    return { verdict: "failed", reasons: [`acceptance failed in the fresh clone: ${detail}`] };
  }
  const inconclusive = runs.filter((r) => r.outcome === "timed_out" || r.outcome === "not_run");
  if (inconclusive.length > 0) {
    const detail = inconclusive.map((r) => `${r.cmd} (${r.outcome})`).join("; ");
    return {
      verdict: "unknown",
      reasons: [`acceptance inconclusive — ${detail}; a timed-out or unrun command proves nothing (ISC-152)`],
    };
  }
  return {
    verdict: "success",
    reasons: [`all ${runs.length} acceptance command(s) passed in the fresh clone`],
  };
}

/**
 * Weigh derived facts against the worker's claim and produce the verdict.
 *
 * `claimed` is the result envelope or null when the worker never wrote one —
 * null is NOT a downgrade (ISC-94). The envelope has already been schema-
 * validated and path-canonicalized by the harvester; this function trusts its
 * shape and distrusts its content.
 */
export function adjudicate(facts: DerivedFacts, claimed: ResultEnvelope | null): Adjudication {
  const facts_hash = factsHash(facts);
  const reasons: string[] = [];
  const discrepancies: string[] = [];

  // ISC-154 first: if the tree moved between quiesce and harvest end, every
  // fact below this line may describe a tree that no longer exists. Nothing —
  // not even a self-reported failure — is weighed on top of voided evidence.
  if (
    facts.tree_hash_quiesce !== null &&
    facts.tree_hash_harvest !== null &&
    facts.tree_hash_quiesce !== facts.tree_hash_harvest
  ) {
    reasons.push(
      `worktree hash changed between quiesce (${facts.tree_hash_quiesce}) and harvest end (${facts.tree_hash_harvest}): backgrounded work kept writing, so every derived fact may be stale (ISC-154)`,
    );
    return { verdict: "unknown", reasons, discrepancies, facts_hash };
  }

  // ISC-151: a base that is not an ancestor of HEAD means the base was
  // rewritten, and `diff base...HEAD` can be shrunk to nothing by exactly that
  // move. The diff-derived facts are untrustworthy, so grading stops here.
  if (!facts.base_is_ancestor) {
    reasons.push(
      "base_ref is not an ancestor of HEAD: the base was rewritten and the diff cannot be trusted (ISC-151)",
    );
    return { verdict: "unknown", reasons, discrepancies, facts_hash };
  }

  const acceptance = acceptanceEvidence(facts.acceptance);
  reasons.push(...acceptance.reasons);
  let derived: Verdict = acceptance.verdict;

  const emptyDiff =
    facts.files_changed.length === 0 && facts.commits.length === 0 && facts.diff_bytes === 0;

  if (claimed === null) {
    reasons.push("no result envelope; grading on derived facts alone");
  } else {
    // ISC-92 / F5: the envelope's file list against the diff, both directions.
    // Over-claiming is fabrication; under-claiming is concealment. SRD §8.2
    // makes A1-vs-A2 disagreement a hard failure class, not a warning.
    const derivedPaths = new Set(facts.files_changed.map((f) => f.path));
    const claimedPaths = new Set(claimed.files_changed.map((f) => f.path));
    let fileDisagreement = false;
    for (const p of claimedPaths) {
      if (!derivedPaths.has(p)) {
        fileDisagreement = true;
        discrepancies.push(`envelope claims ${p} but the diff does not touch it`);
      }
    }
    for (const p of derivedPaths) {
      if (!claimedPaths.has(p)) {
        fileDisagreement = true;
        discrepancies.push(`diff touches ${p} but the envelope does not claim it`);
      }
    }
    if (fileDisagreement) {
      derived = "failed";
      reasons.push("envelope files_changed disagrees with the derived diff (SRD §8.2, F5): hard failure");
    }

    // A commit SHA the repo has no record of is fabricated evidence. Flagged
    // but not F5 on its own — the SRD reserves the hard-failure class for the
    // files/diff disagreement.
    const derivedCommits = new Set(facts.commits);
    for (const c of claimed.commits) {
      if (!derivedCommits.has(c)) {
        discrepancies.push(`envelope claims commit ${c} which is not in base..HEAD`);
      }
    }

    // ISC-93 / SRD §7.2: "success" describing no work at all is `failed`.
    if (claimed.status === "success" && emptyDiff) {
      derived = "failed";
      reasons.push("envelope claims success with an empty diff and no commits (ISC-93)");
    }
  }

  // The one and only lattice combination (contracts.adjudicate): min over
  // failed < blocked < partial < success, with unknown as identity. This is
  // where a self-reported downgrade lands and where a missing envelope
  // becomes a no-op (ISC-94).
  const verdictBeforeCap = latticeCombine(derived, claimed?.status);
  if (claimed !== null && verdictBeforeCap !== derived) {
    reasons.push(
      derived === "unknown"
        ? `no independent evidence either way; adopting the worker's claim '${claimed.status}' (unknown is identity, SRD §7.3)`
        : `worker self-report '${claimed.status}' downgraded the derived '${derived}' (SRD §7.3)`,
    );
  }
  let verdict = verdictBeforeCap;

  // ISC-150, applied LAST: a diff touching the harness surface makes every
  // positive result self-certified. Anything above `blocked` collapses to
  // `unknown` — refuse to grade, don't trust, don't fail. Negative evidence
  // (failed/blocked) survives: trusting a worker's own harness to indict the
  // worker only ever downgrades.
  if (facts.harness.touched.length > 0) {
    reasons.push(
      `diff touches the test-harness surface (${facts.harness.touched.join(", ")}): acceptance is self-certified and cannot prove success (ISC-150)`,
    );
    if (rank(verdict) > rank("blocked")) {
      verdict = "unknown";
    }
  }

  /**
   * ISC-230: an exam that did not FINISH cannot certify success either.
   *
   * `unknown` being the lattice identity is right for a missing CLAIM — a task
   * with a clean diff and green acceptance must not be downgraded because the
   * worker forgot to write an envelope (ISC-94). It is wrong for missing
   * EVIDENCE. Combining a timed-out acceptance to `unknown` and then adopting
   * the claim produced `success` for a worker whose exam never completed, and
   * the route there needs no harness edit at all: ship a change that makes an
   * existing command hang, claim success, collect it. That is precisely the
   * inversion the harness cap exists to prevent, reached by a different door,
   * and it contradicts the SRD's own principle that a self-report is
   * adjudicated against independent evidence *before* it is believed.
   *
   * So: a command that was ATTEMPTED and returned no answer caps the verdict,
   * exactly like a touched harness. ISC-152 still holds — the outcome is
   * `blocked`/`unknown`, never `failed`, because a timeout proves nothing
   * about the code. An EMPTY acceptance list is untouched: no exam was ever
   * set, which is a config decision rather than anything the worker did.
   */
  const inconclusive = facts.acceptance.filter(
    (a) => a.outcome === "timed_out" || a.outcome === "not_run",
  );
  if (inconclusive.length > 0 && rank(verdict) > rank("blocked")) {
    reasons.push(
      `acceptance did not complete (${inconclusive
        .map((a) => `${a.cmd} → ${a.outcome}`)
        .join("; ")}): an unfinished exam cannot certify success, so the claim is not adopted (ISC-230)`,
    );
    verdict = "unknown";
  }

  return { verdict, reasons, discrepancies, facts_hash };
}
