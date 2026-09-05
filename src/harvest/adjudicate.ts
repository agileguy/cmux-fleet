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
 *   happen is worse than no envelope at all. ISC-93 is gated on
 *   `facts.repository`, as ISC-151's clamp is: a task that never had a
 *   repository has no diff for "empty" to be a finding about.
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
 *
 * - **A collation's STRUCTURAL CENSUS can cap a verdict and can never lift one**
 *   (SRD-REVIEW-CONSOLE §6.8, D8). The rules are in `collation-census.ts`; what
 *   matters here is what the census is NOT. It counts a JSON document the worker
 *   wrote, so it carries none of the independence the acceptance block below
 *   carries, it is never spelled as acceptance, and it never writes to
 *   `facts.acceptance` — which stays empty for a review task, correctly, because
 *   a review has nothing to re-execute.
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
import { censusCeiling } from "./collation-census.ts";
import { capFor, peakTier } from "./resolution-surface.ts";

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
  //
  // `facts.repository` gates it, because `base_is_ancestor: false` is the
  // VACUOUS default as well as the finding, and only one of the two is a
  // reason to stop. A task dispatched without a `host_workdir` never had a
  // base to rewrite; clamping it here reports a tampered diff to an operator
  // who did not ask for a diff, and buries a result envelope that may be
  // completely sound. Repository tasks are untouched — the clamp is what
  // stops a rewritten base grading green, and it still runs for every one of
  // them.
  if (facts.repository && !facts.base_is_ancestor) {
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

    /**
     * ISC-93 / SRD §7.2: "success" describing no work at all is `failed`.
     *
     * UNLESS the harvester's own acceptance run says otherwise. An empty diff
     * is not evidence of idleness — it is the NORMAL shape of a task whose
     * deliverable is information rather than a change: run this suite, review
     * this branch, find out whether X reproduces. `contracts.ts`'s lattice
     * docstring already names the case ("a task with a clean diff and green
     * acceptance commands must not be downgraded"); this check did not honour
     * it, and graded every one of them `failed`.
     *
     * Measured 2026-09-04: a tester ran rally-cli's suite to
     * `.venv/bin/pytest -q -> exit 0, 1120 passed`, reported success, changed
     * nothing because nothing needed changing, and was graded `failed` for
     * fabricating. The transcript corroborated the run completely.
     *
     * `acceptance.verdict === "success"` is not the worker's word for it.
     * `facts.acceptance` holds the exit codes of the commands THE HARVESTER
     * re-ran, in a fresh clone, in a container the worker never touched — the
     * one piece of evidence in this function a fabricating worker cannot
     * author. Where it exists and is green, it settles the question that the
     * empty diff only raises.
     *
     * With no acceptance commands there is still nothing to weigh, and the
     * verdict stays `failed` rather than softening to `unknown`: ISC-93 exists
     * because a worker with no `bun` on PATH reported `bun test -> exit 0, 27
     * pass`, and softening it would have let that through. What changes is the
     * REASON, which now names the remedy — an information-shaped task is
     * gradable exactly when it carries acceptance commands, and silently
     * failing one whose operator did not know that is its own defect.
     *
     * GATED ON `facts.repository`, exactly as ISC-151's clamp 80 lines above
     * is, and for the same reason: `emptyDiff` carries two meanings and this
     * rule only wants one.
     *
     * For repository work it is a FINDING — the worker had a tree, touched
     * nothing in it, and claimed success anyway. For a task dispatched without
     * a `host_workdir` it is the VACUOUS DEFAULT. `harvest/index.ts:226-242`
     * builds that bundle deliberately and says why in as many words: "NO
     * WORKDIR IS A KIND OF TASK, NOT A DEGRADED HARVEST." There was never a
     * tree, so `files_changed`, `commits` and `diff_bytes` are empty because
     * there was nowhere for them to come from, and reading that as fabrication
     * indicts a task for failing to produce an artifact nobody asked it for.
     *
     * MEASURED 2026-09-03, and why this is a prerequisite of the review console
     * (SRD-REVIEW-CONSOLE §6.8, D9) rather than a tidy-up. The `reviewer` role
     * is `isolation: shared-ro` (`fleet.yaml:461`), so no worktree is created,
     * so `hasWorktree` is false, so `harvest/index.ts:569` never runs the
     * acceptance exam, so `acceptance.verdict` can never be `success`. The
     * exemption arm below was therefore UNREACHABLE BY CONSTRUCTION for the one
     * role whose deliverable is, by definition, no diff at all: every honest
     * review in the fleet was adjudicated as fabrication. Worse, the reason
     * text offered a remedy — "give it acceptance commands" — that this role
     * structurally cannot take, because acceptance needs a worktree to clone
     * from and the absent worktree is the whole cause.
     *
     * REPOSITORY TASKS ARE UNTOUCHED, and that is the property a future edit
     * must not spend. ISC-93 exists because a worker with no `bun` on PATH
     * reported `bun test -> exit 0, 27 pass` behind an empty diff; that worker
     * HAD a workdir, so `facts.repository` is true, so it still grades
     * `failed`. Any widening of this gate — `!facts.repository || …`, or
     * anything keyed on the acceptance list merely being empty — puts that
     * case straight back.
     *
     * The gate skips the exemption arm along with the failure arm. That costs
     * nothing today and is worth stating: acceptance cannot run without a
     * worktree (`harvest/index.ts:569`), so a non-repository bundle's
     * `acceptance` is empty by construction and there is no green run to exempt
     * — but if that ever changes, note that a skipped ISC-93 needs no exemption
     * from itself.
     */
    if (facts.repository && claimed.status === "success" && emptyDiff) {
      if (acceptance.verdict === "success") {
        reasons.push(
          "empty diff, but the acceptance commands passed when the harvester re-ran them " +
            "in a fresh clone: this is a task whose product is not a change (ISC-93 not applied)",
        );
      } else {
        derived = "failed";
        reasons.push(
          "envelope claims success with an empty diff and no commits (ISC-93). If this task " +
            "was not meant to change files, give it acceptance commands — the harvester " +
            "re-runs those itself and they are what makes a no-diff task gradable",
        );
      }
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

  /**
   * THE STRUCTURAL CENSUS (SRD-REVIEW-CONSOLE §6.8, D8) — a ceiling, never an
   * assignment, and deliberately not spelled as acceptance.
   *
   * §6.8's three rules, evaluated in `collation-census.ts` where they sit beside
   * the counting that produces them. What lands here is a maximum, so ORDER
   * AMONG THE CAPS DOES NOT MATTER and the guard is what makes that true:
   * `rank(verdict) > rank(ceiling)` can only ever lower, so a verdict the
   * ISC-150 or ISC-243 blocks below have already pinned to `unknown` (rank -1)
   * is untouched, and a census can never excuse a diff the harness cap caught.
   *
   * WHAT IT DOES NOT DO, said here because the block reads like the acceptance
   * block above and is nothing like it. `acceptance` holds exit codes THE
   * HARVESTER produced in a fresh clone the worker never touched. `collation`
   * holds counts read out of a file the worker WROTE. The census bounds the
   * shape of that claim — a finding has to quote a file and a line, and say
   * which reviewers raised it — and verifies none of its content. §6.8: *"calling
   * it acceptance would be claiming an independence it does not possess."* It is
   * therefore capable of only two answers, `failed` and `partial`; `success` is
   * not in its range at all, so no route exists by which a worker's own document
   * certifies the worker's own work.
   */
  const census = censusCeiling(facts.collation, claimed?.status);
  if (census !== null) {
    reasons.push(census.reason);
    if (rank(verdict) > rank(census.ceiling)) verdict = census.ceiling;
  }

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
   * ISC-243: the GRADED cap, applied after the denylist's and never instead
   * of it.
   *
   * The safety property is the CEILING comparison, and it is worth naming
   * precisely because the obvious answer — "it runs second" — is wrong. Order
   * does not matter: run this block first and a `dependency` hit sets
   * `partial`, after which the ISC-150 block still finds `rank("partial") >
   * rank("blocked")` and lands on `unknown` exactly as it would have.
   *
   * What matters is that the tier imposes a MAXIMUM rather than an
   * assignment. `verdict = ceiling` would let a `dependency` hit rewrite a
   * verdict the denylist had already pinned to `unknown` back up to `partial`
   * — a graded surface that EXCUSES a file the denylist caught. With the
   * comparison, `rank("unknown")` is -1 and no tier can raise anything. The
   * merge is one-directional: the allowlist adds files and raises severity and
   * has no expressible way to subtract. That is what makes a PARTIAL allowlist
   * safe here, where this criterion's own entry — correctly — warned that a
   * partial allowlist able to subtract would cap ordinary source files.
   *
   * The two upper tiers cap exactly as ISC-150 always did. The point of the
   * grade is the third:
   *
   *  - `executes`   — worker-authored code ran before or around the suite, so
   *                   the suite proves nothing. Refuse to grade.
   *  - `toolchain`  — the suite ran under an interpreter the worker selected.
   *                   Refuse to grade.
   *  - `dependency` — the base tree's tests ran against the base tree's code
   *                   and that is real evidence, but a dependency the worker
   *                   chose is in the loop. `partial`, not `unknown`: a real
   *                   downgrade that carries the evidence forward.
   *
   * A dependency bump collapsing to `unknown` was the all-or-nothing behaviour
   * that made narrowing the surface tempting, and narrowing is the silent
   * disable ISC-232 exists to catch. Grading it is how that pressure is
   * removed without weakening anything.
   */
  const peak = peakTier({ runners: [], unresolved: [], hits: facts.harness.graded });
  if (peak !== null) {
    const worst = facts.harness.graded.filter((g) => g.tier === peak);
    reasons.push(
      `diff touches the ${peak} tier of the ${facts.harness.graded_runners.join("/")} resolution surface ` +
        `(${worst.map((g) => `${g.file}: ${g.why}`).join("; ")}) — capped to ${capFor(peak)} (ISC-243)`,
    );
    const ceiling = capFor(peak);
    if (ceiling === "unknown") {
      if (rank(verdict) > rank("blocked")) verdict = "unknown";
    } else if (rank(verdict) > rank(ceiling)) {
      verdict = ceiling;
    }
  }

  /**
   * ISC-243: the residual, made visible rather than left indistinguishable
   * from a clean diff.
   *
   * An allowlist is complete PER RUNNER, and a command whose runner it cannot
   * classify gets no allowlist at all — the known-partial denylist is then the
   * only thing grading it. That is the honest limit of this mechanism, and the
   * one shape it must never take is silence: "I could not determine the
   * harness surface for `npm test`" and "the diff is clean" produce the same
   * uncapped `success` and must not produce the same report.
   *
   * Gated on the verdict not already being capped, mirroring ISC-232's
   * condition and for the same reason: when something else already refused to
   * certify, the un-gradeable command did not change the outcome and saying so
   * is noise.
   */
  if (facts.harness.graded_unresolved.length > 0 && rank(verdict) > rank("blocked")) {
    discrepancies.push(
      `the harness surface could not be resolved for ${facts.harness.graded_unresolved.join("; ")} — ` +
        `only the known-partial built-in denylist graded this diff (ISC-243)`,
    );
  }

  /**
   * ISC-232: the cap did not fire, and the configured surface is the reason.
   *
   * A DISCREPANCY rather than another cap, and the distinction is deliberate.
   * Narrowing the harness surface is a legitimate operator decision, so the
   * configured patterns still decide the verdict — overriding them here would
   * make `harness.patterns` unable to do the one thing it exists to do. But
   * the operator who wrote `patterns: ["ci/**"]` to describe their CI files
   * almost certainly did not intend to stop grading `test/**`, and nothing
   * else in the pipeline would ever tell them: the config is valid, the globs
   * are well-formed, the diff is real, and the verdict comes back `success`.
   *
   * It lands in `discrepancies` specifically because that array is the one
   * `artifacts` prints at the top of the human report and carries verbatim
   * into the JSON payload — the same channel a falsified `files_changed`
   * claim uses. A weakened control has to be as loud as a caught lie.
   */
  if (facts.harness.defaults_missed.length > 0) {
    discrepancies.push(
      `configured harness.patterns (${facts.harness.patterns.join(", ")}) matched none of this diff, ` +
        `but the built-in defaults would have flagged ${facts.harness.defaults_missed.join(", ")} — ` +
        `the ISC-150 cap did not fire because of the config, not because the diff is clean`,
    );
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
