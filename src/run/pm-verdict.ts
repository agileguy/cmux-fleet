/**
 * THE REVIEW VERDICT MAPPING — `collation.json` plus the run tree, turned into
 * a loop verdict (SRD-FLEET-PROJECT-MANAGER §7.5, §9.3, §9.4).
 *
 * The collation is FORBIDDEN from carrying its own verdict — `CollationSchema`
 * refuses `acceptance`, `verified` and `status` outright (`collation.ts`) — so
 * something outside the console has to derive one. This module is that
 * derivation, and it is a PURE function over four values: a parsed collation
 * (or `null`, when the `-collate` task never produced one), the host's own
 * coverage of the fan-out, the SHA the review request recorded, and the SHA at
 * collation time. **It reads no file and reaches no network** — every value it
 * needs is a parameter, so a fixture is an object literal and never a temp
 * directory.
 *
 * ## Three gates, in order, and why the order is load-bearing
 *
 * **Gate 0 (`recordedSha` vs `currentSha`).** If the tree moved between
 * dispatch and collation, the lenses read a checkout that no longer exists and
 * every `file:line` in the collation points into a different history. The
 * round is `VOID` — neither approved nor incomplete, and it does not count
 * against `max_review_iterations` because the reviewers did nothing wrong.
 *
 * **Gate 1 (coverage, from `HostCoverage` alone).** `coverage_dispatched` is
 * `journal.children.length` and `coverage_reported` is the number of those
 * children with a READABLE reply on the host. Neither number is read from
 * `collation.lenses[]` — that array is consulted only as a CROSS-CHECK
 * (`computeLensDisagreements` below), because a collator that ignores its
 * brief and claims full coverage over a partial fan-out is capped by nothing
 * upstream of this function (SRD §7.5's `collationCeiling` / `censusCeiling`
 * finding). A gate that read `lenses[]` for the count would pass exactly the
 * fixture this design exists to catch.
 *
 * **Gate 2 (`collation.findings[]`).** Only reached once coverage is full.
 * Severity is not weighed — the collation carries none — and `finding_count`
 * is read only as a cross-check against `findings.length`, never as the
 * authoritative count (`collation.ts`'s own docblock makes the same call for
 * the same reason).
 *
 * ## What this module deliberately does not do
 *
 * It does not read `collation.status` — there is no such field, and there is
 * no parameter here that could smuggle a collate task's own `pifleet.result/v1`
 * status in either. It does not import `harvest/collation-census.ts`, so it
 * cannot depend on `censusCeiling`, which is switched off for exactly the
 * non-`success` claims this gate exists to handle. It does not change
 * `CollationSchema`.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Collation, CollationFinding } from "./collation.ts";
import { REVIEW_CONSOLE_ASPECTS, childTaskId } from "./task-ids.ts";

// ---------------------------------------------------------------------------
// Host coverage — what the run tree says, independent of the collation.
// ---------------------------------------------------------------------------

/**
 * Whether one dispatched child's reply reached the host, and if not, why.
 *
 * **This is a tri-state and the middle state is the one a naive reader
 * skips.** `"reported"` and `"missing"` are the two coverage counts §7.5's
 * formula describes directly. `"unreadable"` is the state §9.4 calls out by
 * name — a reply file exists on disk and its content did not parse — and it
 * is NOT the same as `"reported"`: content nothing here could read cannot be
 * counted toward coverage, and it cannot be counted toward `findings[]`
 * attribution either. It differs from `"missing"` only in what an operator can
 * do about it — the review may still be recoverable by hand — which is why
 * the two are reported with different words rather than folded into one
 * boolean (§9.4, ISC-539).
 */
export type ReplyCoverage =
  | { readonly status: "reported" }
  | { readonly status: "missing" }
  | { readonly status: "unreadable"; readonly path: string; readonly detail?: string };

/** The run tree's account of one round's fan-out, once a journal entry exists. */
export interface JournalCoverage {
  /** `RelayJournalEntry.children` — the dispatched child task ids, host-written at dispatch time. */
  readonly children: readonly string[];
  /**
   * Per dispatched child, whether its reply survived. A child with no entry
   * here is treated exactly like `{ status: "missing" }` — the map only needs
   * an entry when there is something to say beyond that default.
   */
  readonly replies: ReadonlyMap<string, ReplyCoverage>;
}

/**
 * What the host tree can say about a review round, before any collation is
 * consulted. `"no_journal_entry"` is `<run>/relay/<sender>/<parent>.json` not
 * existing at all — the fan-out was never issued (§9.3's `refused` /
 * `none_landed`). Anything else means a journal entry exists, however partial
 * its coverage turns out to be.
 */
export type HostCoverage = { readonly kind: "no_journal_entry" } | ({ readonly kind: "journal" } & JournalCoverage);

// ---------------------------------------------------------------------------
// The verdict lattice.
// ---------------------------------------------------------------------------

/** One dispatched child whose reply did not reach the host, and why. */
export interface MissingLens {
  readonly childTaskId: string;
  readonly reason:
    | { readonly kind: "missing" }
    | { readonly kind: "unreadable"; readonly path: string; readonly detail?: string };
}

/**
 * A place `collation.lenses[]` disagreed with the journal. Reportable in its
 * own right (§7.5): a row missing, a row for a lens the journal never
 * dispatched, or `reported: true` on a lens with no readable reply are each a
 * sign the collator is not copying its brief faithfully.
 */
export interface LensDisagreement {
  readonly kind: "row_missing_for_dispatched_child" | "row_for_undispatched_lens" | "reported_true_without_reply";
  readonly detail: string;
}

/** `collation.finding_count` disagreeing with `findings.length` — a datum, never a refusal. */
export interface FindingCountMismatch {
  readonly declared: number;
  readonly actual: number;
}

/** One finding, ready for the fix brief: its `file` rewritten to repo-relative. */
export interface FixBriefFinding {
  readonly statement: string;
  readonly file: string;
  readonly line: number;
  readonly raisedBy: readonly string[];
  readonly disputedBy: readonly string[];
}

export type ReviewVerdict =
  /** Gate 0 failed: the tree moved between dispatch and collation. */
  | {
      readonly kind: "VOID";
      readonly recordedSha: string;
      readonly currentSha: string;
      readonly countsAgainstIterationBudget: false;
    }
  /**
   * No usable collation exists for this round, for one of three host-observed
   * reasons (§9.3). Never conflated with `REVIEW_INCOMPLETE`: that verdict
   * means a collation exists and is short of full coverage; this one means
   * there is no collation to be short.
   */
  | {
      readonly kind: "NO_COLLATION";
      readonly reason: "refused_or_none_landed" | "not_collated" | "missing_collation";
      readonly countsAgainstIterationBudget: false;
    }
  /** Gate 1 failed: some, but not all, dispatched lenses reported. */
  | {
      readonly kind: "REVIEW_INCOMPLETE";
      readonly coverage: { readonly reported: number; readonly dispatched: number };
      readonly missingLenses: readonly MissingLens[];
      readonly lensDisagreements: readonly LensDisagreement[];
      readonly countsAgainstIterationBudget: false;
    }
  | {
      readonly kind: "APPROVED";
      readonly lensDisagreements: readonly LensDisagreement[];
      readonly findingCountMismatch: FindingCountMismatch | null;
      readonly countsAgainstIterationBudget: false;
    }
  /** Every finding was raised by exactly one lens and disputed by at least one other. */
  | {
      readonly kind: "APPROVED_WITH_DISSENT";
      readonly findings: readonly FixBriefFinding[];
      readonly lensDisagreements: readonly LensDisagreement[];
      readonly findingCountMismatch: FindingCountMismatch | null;
      readonly countsAgainstIterationBudget: false;
    }
  /** Consensus findings (`raised_by.length >= 2`) first, single-lens findings ranked below. */
  | {
      readonly kind: "CHANGES_REQUESTED";
      readonly findings: readonly FixBriefFinding[];
      readonly lensDisagreements: readonly LensDisagreement[];
      readonly findingCountMismatch: FindingCountMismatch | null;
      readonly countsAgainstIterationBudget: true;
    };

export interface DeriveVerdictInput {
  /**
   * The parsed `collation.json` from the round's `-collate` task, or `null`
   * when none exists. **Never the fan-out parent's own settlement** — the
   * parent task settles when the fan-out is ISSUED, not when review is done
   * (D5), so a caller reading the parent's `success` as this input would be
   * exactly ISC-537's mistake. There is deliberately no parameter on this
   * interface through which a parent's verdict, or the collate task's own
   * `pifleet.result/v1` status, could reach this function.
   */
  readonly collation: Collation | null;
  /** Host-observed coverage for this round's fan-out (§7.5 Gate 1). */
  readonly coverage: HostCoverage;
  /** The SHA the review request recorded at dispatch time (§7.3). */
  readonly recordedSha: string;
  /** `git rev-parse HEAD` at collation time. */
  readonly currentSha: string;
}

// ---------------------------------------------------------------------------
// Gate 1 helpers — coverage and the missing-lens report, from HostCoverage only.
// ---------------------------------------------------------------------------

function computeCoverageCounts(coverage: JournalCoverage): { dispatched: number; reported: number } {
  const dispatched = coverage.children.length;
  const reported = coverage.children.filter((c) => coverage.replies.get(c)?.status === "reported").length;
  return { dispatched, reported };
}

/** Every dispatched child whose reply did NOT reach the host, in journal order. */
function computeMissingLenses(coverage: JournalCoverage): MissingLens[] {
  const missing: MissingLens[] = [];
  for (const child of coverage.children) {
    const reply = coverage.replies.get(child);
    if (reply === undefined || reply.status === "missing") {
      missing.push({ childTaskId: child, reason: { kind: "missing" } });
    } else if (reply.status === "unreadable") {
      missing.push({ childTaskId: child, reason: { kind: "unreadable", path: reply.path, detail: reply.detail } });
    }
  }
  return missing;
}

/**
 * One line per missing lens, in the two shapes §9.4 requires — and only the
 * second names a path. `roles/collator.md` calls conflating the two
 * "the specific falsehood this instruction exists to stop"; this is the
 * loop's own report making the same distinction, independently of the brief
 * `relay.ts` already writes to the collator before collation happens.
 */
export function describeMissingLens(m: MissingLens): string {
  if (m.reason.kind === "missing") {
    return `MISSING ASPECT: ${m.childTaskId} — it settled and produced no report: no reply file exists for it.`;
  }
  const detail = m.reason.detail === undefined ? "" : ` (${m.reason.detail})`;
  return (
    `MISSING ASPECT: ${m.childTaskId} — its report WAS WRITTEN AND COULD NOT BE READ: ` +
    `${m.reason.path} did not parse${detail}. The review exists on disk and no report reached ` +
    `the collator.`
  );
}

function tryChildTaskId(parentTaskId: string, aspect: string): string | null {
  try {
    return childTaskId(parentTaskId, aspect);
  } catch {
    return null;
  }
}

/**
 * Where `collation.lenses[]` disagrees with the journal — the cross-check
 * §7.5 asks for, never the source of a coverage count.
 *
 * Three kinds, each a sign the collator did not copy its brief faithfully:
 * a journal child with no corresponding lens row, a lens row whose aspect the
 * journal never dispatched, and a lens claiming `reported: true` for a child
 * with no readable reply on the host.
 */
function computeLensDisagreements(collation: Collation, coverage: JournalCoverage): LensDisagreement[] {
  const disagreements: LensDisagreement[] = [];
  const dispatchedChildren = new Set(coverage.children);
  const lensesByAspect = new Map(collation.lenses.map((l) => [l.aspect, l] as const));

  for (const seat of REVIEW_CONSOLE_ASPECTS) {
    const expected = tryChildTaskId(collation.parent_task_id, seat.aspect);
    if (expected === null || !dispatchedChildren.has(expected)) continue;
    if (!lensesByAspect.has(seat.aspect)) {
      disagreements.push({
        kind: "row_missing_for_dispatched_child",
        detail:
          `the journal dispatched ${expected} for aspect "${seat.aspect}" and collation.lenses[] ` +
          `has no row for it`,
      });
    }
  }

  for (const lens of collation.lenses) {
    const expected = tryChildTaskId(collation.parent_task_id, lens.aspect);
    const wasDispatched = expected !== null && dispatchedChildren.has(expected);
    if (!wasDispatched) {
      disagreements.push({
        kind: "row_for_undispatched_lens",
        detail:
          `collation.lenses[] names aspect "${lens.aspect}" (worker ${lens.worker}) but the ` +
          `journal never dispatched it`,
      });
      continue;
    }
    if (lens.reported && coverage.replies.get(expected!)?.status !== "reported") {
      disagreements.push({
        kind: "reported_true_without_reply",
        detail:
          `collation.lenses[] marks aspect "${lens.aspect}" (worker ${lens.worker}) as reported, ` +
          `but ${expected} has no readable reply on the host`,
      });
    }
  }

  return disagreements;
}

// ---------------------------------------------------------------------------
// Gate 2 helpers — findings, read from collation.findings[] only.
// ---------------------------------------------------------------------------

const DEFAULT_CONTAINER_WORKDIR = "/workspace";

/**
 * A finding's `file` (`/workspace/src/run/relay.ts`), rewritten to
 * repo-relative (`src/run/relay.ts`) for the fix brief (§7.5).
 *
 * Deliberately NOT a containment check — `harvest/collation-census.ts`
 * already resolves each finding's location against the run's real
 * `container_workdir` and grades an unusable one as a defect rather than a
 * refusal. This function's job is narrower: rewrite the common case, and hand
 * back anything it cannot place beneath `containerWorkdir` unchanged rather
 * than fabricate a path that resolves nowhere real.
 */
export function toRepoRelativePath(file: string, containerWorkdir: string = DEFAULT_CONTAINER_WORKDIR): string {
  const root = resolve(containerWorkdir);
  const target = resolve(isAbsolute(file) ? file : join(root, file));
  const rel = relative(root, target);
  if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === "..") {
    return file;
  }
  return rel;
}

function toFixBriefFinding(f: CollationFinding): FixBriefFinding {
  return {
    statement: f.statement,
    file: toRepoRelativePath(f.file),
    line: f.line,
    raisedBy: f.raised_by,
    disputedBy: f.disputed_by,
  };
}

/** §7.5 Gate 2's second row: raised by exactly one lens, disputed by at least one other. */
function isDisputedSingleRaiser(f: CollationFinding): boolean {
  return f.raised_by.length === 1 && f.disputed_by.length >= 1;
}

/**
 * `finding_count` against `findings.length` — reported, never trusted in
 * preference to the list. `collation.ts`'s own docblock makes the same call:
 * "`finding_count` is not authoritative... the disagreement is a datum rather
 * than a refusal."
 */
function computeFindingCountMismatch(collation: Collation): FindingCountMismatch | null {
  return collation.finding_count === collation.findings.length
    ? null
    : { declared: collation.finding_count, actual: collation.findings.length };
}

// ---------------------------------------------------------------------------
// The three gates, in order.
// ---------------------------------------------------------------------------

/**
 * Turn a review round's inputs into a loop verdict. Pure: no filesystem read,
 * no network call, nothing consulted that is not a parameter of this
 * function. See the module header for the three gates and their order.
 */
export function deriveReviewVerdict(input: DeriveVerdictInput): ReviewVerdict {
  const { collation, coverage, recordedSha, currentSha } = input;

  // Gate 0 — the tree did not move.
  if (recordedSha !== currentSha) {
    return { kind: "VOID", recordedSha, currentSha, countsAgainstIterationBudget: false };
  }

  // Gate 1 — coverage, read from the run tree and nowhere else.
  if (coverage.kind === "no_journal_entry") {
    return { kind: "NO_COLLATION", reason: "refused_or_none_landed", countsAgainstIterationBudget: false };
  }

  const { dispatched, reported } = computeCoverageCounts(coverage);
  const lensDisagreements = collation === null ? [] : computeLensDisagreements(collation, coverage);

  if (reported === 0) {
    // Some lenses may have landed, but none survived to be harvested: no
    // reply reached the host for any dispatched child. §9.3's `not_collated`.
    return { kind: "NO_COLLATION", reason: "not_collated", countsAgainstIterationBudget: false };
  }

  if (reported < dispatched) {
    return {
      kind: "REVIEW_INCOMPLETE",
      coverage: { reported, dispatched },
      missingLenses: computeMissingLenses(coverage),
      lensDisagreements,
      countsAgainstIterationBudget: false,
    };
  }

  // Full coverage. A collation must still exist to read findings from —
  // ISC-537: a fan-out parent's own settlement is never read as a substitute.
  if (collation === null) {
    return { kind: "NO_COLLATION", reason: "missing_collation", countsAgainstIterationBudget: false };
  }

  // Gate 2 — findings. Coverage is full; the collation's own claim is read.
  const findingCountMismatch = computeFindingCountMismatch(collation);
  const findings = collation.findings;

  if (findings.length === 0) {
    return { kind: "APPROVED", lensDisagreements, findingCountMismatch, countsAgainstIterationBudget: false };
  }

  if (findings.every(isDisputedSingleRaiser)) {
    return {
      kind: "APPROVED_WITH_DISSENT",
      findings: findings.map(toFixBriefFinding),
      lensDisagreements,
      findingCountMismatch,
      countsAgainstIterationBudget: false,
    };
  }

  const consensus = findings.filter((f) => f.raised_by.length >= 2);
  const rest = findings.filter((f) => f.raised_by.length < 2);
  return {
    kind: "CHANGES_REQUESTED",
    findings: [...consensus, ...rest].map(toFixBriefFinding),
    lensDisagreements,
    findingCountMismatch,
    countsAgainstIterationBudget: true,
  };
}

/**
 * Apply a verdict to a phase's review-iteration counter. `REVIEW_INCOMPLETE`
 * and `VOID` (and the `NO_COLLATION` arms) leave it unchanged — the round did
 * not fail on the code's merits — and only `CHANGES_REQUESTED` advances it
 * (§9.4, §9.5).
 */
export function nextReviewIterationCount(current: number, verdict: ReviewVerdict): number {
  return verdict.countsAgainstIterationBudget ? current + 1 : current;
}
