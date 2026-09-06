/**
 * The verdict mapping and the freshness echo — SRD-TRIAGE-CONSOLE §6.6 layer 3,
 * §6.7 rules 1-2, §7.4, §7.5; §13 tasks 5.2 and 5.3.
 *
 * `triage.json` plus a host-counted coverage record, in; one assessment per
 * DECLARED service, out. Pure, total, and over values — Phase 5 *"touches no
 * container and no network, and that is what makes it the one phase CI can fully
 * re-check."*
 *
 * ## The predicate is the observer's vocabulary, and nothing here is a new one
 *
 * §6.7: *"derived from the observer's own fields, never judged fresh"*.
 * SRD-OBSERVER-001 §9.1 fixes four values — `healthy`, `degraded`, `unhealthy`,
 * `indeterminate` — and {@link ObserverAssessment} is those four and no fifth.
 * A host that invented a value would be judging, and judging is the one thing
 * §6.7 says this layer does not do. What the host does instead is **decline to
 * accept** a claim it cannot see the shape of, and declining resolves to
 * `indeterminate`, which already means *"I could not see enough to tell you"*.
 *
 * The reason a service landed where it did is a SEPARATE closed enum
 * ({@link AssessmentReason}). `unevidenced_healthy` and `stale_replay` are record
 * codes — §6.7 rule 2 *"recorded as `unevidenced_healthy`"*, §6.6 layer 3
 * *"records it as `stale_replay`"* — and putting them on the assessment axis
 * would be exactly the invention the section forbids.
 *
 * ## The structural move: an unevidenced `healthy` cannot reach a caller
 *
 * `triage-partition.ts` made *"nothing was dispatched"* a property of the code by
 * taking the dispatch effect as a parameter, so ordering stopped being caller
 * discipline. The equivalent here is that **there is no exported path that hands
 * a caller the worker's raw `healthy`.** {@link ServiceAssessment.assessment} is
 * always post-gate; the worker's own word is on {@link ServiceAssessment.claimed},
 * which is named for what it is and is a record rather than a verdict —
 * `CollationCensus`'s `declared`-beside-`counted` split (`contracts.ts:1093-1105`)
 * in a second place, and §7.5 names that split as *"precisely the worker-claim-
 * versus-host-count distinction §6.7 turns on"*.
 *
 * That matters because of what reads this next. §6.8's recovery rule — *"the rule
 * most likely to be got wrong"* — requires *"a sweep in which that service
 * returned `assessment: healthy` **with the evidence §6.7's gate demands**"*. If
 * the gate were a separate function a caller invoked before deciding, a recovery
 * path that read the row directly would compile, pass its own tests, and send *"a
 * recovery notification for a service nobody could see"*, which §6.8 calls **"the
 * single most damaging message this console could send"**. Here the incident
 * machine can read `assessment` and nothing else, and cannot see an unevidenced
 * `healthy` at all.
 *
 * ## The second structural move: the output is one row per DECLARED service
 *
 * Not one row per row `triage.json` wrote. The host's list is the targets file's
 * (§6.2 rule 2, *"DECLARED, never derived"*), so:
 *
 *  - a service the worker omitted **still appears**, as `indeterminate` — it
 *    cannot vanish into a shorter array, which is §6.5's *"two clean reports and a
 *    missing third reads exactly like a clean sweep"*;
 *  - a service the worker invented **cannot appear** — it has no namespace, no
 *    `checks[]` and no window, so nothing downstream could act on it, and an
 *    incident record keyed on it would be a permanent orphan under
 *    `~/.pifleet/triage/<env>/`.
 *
 * Both are named rather than silently dropped: {@link SweepCensus} carries the
 * counts and the members.
 *
 * ## Coverage is counted, and the count is the host's
 *
 * §6.7: *"The number of services observed comes from the run tree — the journal's
 * `children[]` against the reply files present — never from `triage.json`'s own
 * claim. This is ISC-517's hazard and SRD-FLEET-PM-001 §7.5's correction, and
 * this console meets it 288 times a day rather than occasionally."*
 *
 * So {@link SweepCoverage} is assembled by the actor from the run tree and this
 * module trusts it, while {@link TriageDocument} is assembled by a container and
 * this module trusts none of its arithmetic. Concretely: a service whose assigned
 * observer produced no reply file is `indeterminate` **whatever row
 * `triage.json` wrote for it**, and `triage.json`'s own
 * {@link TriageDocument.unaccounted} list is recorded as
 * {@link SweepCensus.claimed_unaccounted} and branched on nowhere.
 *
 * ## §6.6 layer 3, and why the echo is checked at BOTH levels
 *
 * §7.4 puts the required `sweep_id` on `observer-ops.json`; §7.5 puts it on
 * `triage.json` too. Both are checked here, and the reason the collator's copy is
 * not redundant is the measured failure itself: §3.4's replay was *"a session
 * carrying the previous task's answer forward"*, the session is per
 * `(run, worker)` and nothing rotates it (§2.3a), and **`tri-1` is the seat that
 * holds the longest session in this console** — it is dispatched twice per sweep
 * where an observer is dispatched once. A stale `tri-1` returns last sweep's
 * verdict for *every* service at once, which is the widest-blast-radius replay
 * available and the one a check on observers alone would miss.
 *
 * **The dispatched id is a required parameter and is never read out of the
 * document.** *"A worker cannot forge it into correctness by accident: the value
 * is minted host-side, per sweep, and echoing last sweep's id is exactly the
 * failure being caught."* A signature that let the document supply its own
 * comparand would compare a value to itself and pass forever.
 *
 * ## What is deliberately NOT decided here, so the silence is not read as coverage
 *
 * **Confirmation (§6.7 rule 1) is not this module's.** *"A notification fires on
 * confirmation, never on the first observation"* is a property of a record that
 * spans sweeps, and this module sees one. §13 task 5.4's state machine owns it.
 * Nothing here counts, escalates or notifies.
 *
 * **The three-consecutive-`indeterminate` coverage escalation is not this
 * module's** either, for the same reason: `consecutive_indeterminate` lives in the
 * incident record (§7.6).
 *
 * **Saturation (§6.7 rule 3, D15) is task 5.3a's**, and this module must not
 * pre-empt it. Its input is available here — {@link SweepCensus.observers_missing}
 * is the correlation signal, *"two or more observers producing no artifact in one
 * sweep"* — but the verdict, the confirming `probeNativeToolCalls`, and above all
 * the **suppression** of the coverage escalation are 5.3a's, and §13 is explicit
 * that the suppression is written before the verdict. What this module owes that
 * task is the count, by name, and it publishes it.
 *
 * **`status: blocked` is not read here.** §6.7 makes it a *console-health* issue
 * rather than a service issue, and §6.8a's `(scope, kind)` identity is task 5.4a's.
 * {@link ObserverArtifact} therefore carries no status field: a field this module
 * accepted and did not read would be a field a later reader assumes is honoured.
 *
 * **"Were these channels ENOUGH" is still refused, and the line moved once.**
 * §6.7 rule 2 now carries a fifth condition — a `healthy` whose `coverage[]` is
 * non-empty but whose every entry is `not_attempted` fails the gate — and it is
 * *"condition 1 read honestly rather than a new judgement"*, because **zero
 * attempts and zero entries carry exactly the same information**. It spends the
 * existing `coverage` gap, mints no name and needs no threshold; see
 * {@link attempted}. What stays refused is the check on the other side of that
 * line: whether the channels an observer DID answer were sufficient has a
 * threshold in it, and a host that answered it would be judging.
 */

import type { PartitionAssignment } from "./triage-partition.ts";

/**
 * SRD-OBSERVER-001 §9.1's `assessment` domain, entire.
 *
 * Exported as a frozen tuple and not only as a type, because §12's console-health
 * criterion records the lesson for closed sets in this repository —
 * *"assert the enum's members by name … not by count"*
 * (`test/unit/monitor-readonly.test.ts:363-369`) — and a `const` array is what
 * lets a test do that. A type alone is erased at runtime and asserts nothing.
 */
export const OBSERVER_ASSESSMENTS = [
  "healthy",
  "degraded",
  "unhealthy",
  "indeterminate",
] as const;
export type ObserverAssessment = (typeof OBSERVER_ASSESSMENTS)[number];

/** SRD-OBSERVER-001 §9.1's per-channel `coverage` domain. */
export const COVERAGE_RESULTS = [
  "answered",
  "unreachable",
  "forbidden",
  "not_attempted",
] as const;
export type CoverageResult = (typeof COVERAGE_RESULTS)[number];

/** One channel the observer says it did or did not get an answer out of. */
export interface CoverageEntry {
  readonly channel: string;
  readonly result: CoverageResult;
}

/**
 * One service's row in `triage.json` — §7.5, and the fields §7.4 requires on the
 * `observer-ops.json` row it is derived from.
 *
 * `selector` and `window` are nullable because their absence is the thing §6.7
 * rule 2 tests for. Modelling them as required `string`s would make two of the
 * gate's four conditions unrepresentable, and a gate whose inputs cannot express
 * the failure is a gate that cannot fail.
 */
export interface TriageRow {
  readonly service: string;
  readonly assessment: ObserverAssessment;
  readonly coverage: readonly CoverageEntry[];
  /** The label selector the observer says it resolved the service to. */
  readonly selector: string | null;
  /** The observation window, as the envelope spelled it (`5m`). */
  readonly window: string | null;
  /** The evidence ledger — §7.5's `evidence_ref`. */
  readonly evidence_ref: readonly string[];
  /** The observer the WORKER says produced this row. Recorded, never trusted. */
  readonly observer: string | null;
}

/**
 * `triage.json` — §7.5. What `tri-1` wrote on turn two.
 *
 * `worker` is carried so a stale document can be named in
 * {@link SweepAssessment.stale_replay} beside the observers, rather than being a
 * boolean the operator has to translate into a seat.
 */
export interface TriageDocument {
  readonly worker: string;
  /** §6.6 layer 3's echo. `null` when the document omitted the required field. */
  readonly sweep_id: string | null;
  readonly services: readonly TriageRow[];
  /** §7.5's *"the services it could not account for, named"* — the worker's claim. */
  readonly unaccounted: readonly string[];
}

/**
 * One observer's reply, as the HOST found it in the run tree.
 *
 * Presence in {@link SweepCoverage.artifacts} is the whole of *"the reply files
 * present"*; there is no `present: boolean`, because an absent artifact is an
 * absent element and a boolean would let a caller record an artifact that is not
 * there.
 */
export interface ObserverArtifact {
  readonly worker: string;
  /** §7.4's required echo. `null` when the artifact omitted it. */
  readonly sweep_id: string | null;
}

/**
 * The host's own account of what this sweep covered — §6.7's *"counted
 * host-side"*.
 *
 * Every field here is derived from the targets file and the run tree. Nothing in
 * it comes from a container, which is the property that makes the arithmetic
 * below trustworthy: `triage.json` is checked AGAINST this and never the reverse.
 */
export interface SweepCoverage {
  /** Every service `triage/targets.yaml` declares for this environment, in file order. */
  readonly declared: readonly string[];
  /** The partition the actor dispatched — the journal's `children[]`, with their shares. */
  readonly assignments: readonly PartitionAssignment[];
  /** The observers whose reply artifact is present. Never the worker's claim of same. */
  readonly artifacts: readonly ObserverArtifact[];
}

/**
 * §6.7 rule 2's conditions, as four names.
 *
 * The order is the sentence's own: *"an empty `coverage[]`, no named selector, no
 * window, or an empty evidence ledger"*.
 *
 * **FOUR NAMES AND FIVE CONDITIONS, deliberately.** §13 task 5.3b adds the
 * all-`not_attempted` case *"spending the existing `coverage` gap rather than a
 * new one"*, on §6.7's ruling that zero attempts and zero entries say the same
 * thing. A fifth member would tell the operator they were two different faults
 * when the thing to go and do about them is identical.
 *
 * **They are reported separately rather than as one boolean**, and that is the
 * difference between a gate a test can hold to account and a gate that merely
 * has a passing test. A gate checking one of the four satisfies any fixture that
 * violates all four at once; four named members make four separable fixtures
 * possible, and this branch's MEMORY carries the defect they exist against.
 */
export const EVIDENCE_GAPS = ["coverage", "selector", "window", "ledger"] as const;
export type EvidenceGap = (typeof EVIDENCE_GAPS)[number];

/**
 * Which of §6.7 rule 2's conditions this row fails, by name. Empty means none.
 *
 * Five conditions over four names: the `coverage` gap covers both an empty
 * `coverage[]` and one whose every entry is `not_attempted`, on §6.7's ruling
 * that the two carry the same information (see {@link attempted}).
 *
 * **This grades STRUCTURE and nothing else**, and SRD-REVIEW-CONSOLE D8's
 * sentence travels with it unchanged: it *"is not acceptance and must not be
 * described as acceptance."* §3.5 states the limit exactly — *"Nothing downstream
 * can re-derive whether an observer looked"* — so this function *"cannot tell a
 * lazy `healthy` from a real one. It can tell a `healthy` with no evidence
 * attached from one with evidence attached"*, and SRD-OBSERVER-001 §11.2 names
 * that as this operator's dominant production failure: *"you told me it was fine
 * but didn't actually check."*
 *
 * Blank is absent. A `selector` of `"   "` is not a named selector and an
 * `evidence_ref` of `[""]` is not a ledger entry — SRD-OBSERVER-001's own warning
 * about selectors is that *"`kubectl logs -l` with a label nothing carries exits
 * zero and prints nothing — identical to a healthy, silent service"*, and a
 * whitespace selector is the degenerate case of exactly that. Treating a blank as
 * present would make the gate defeatable with a space bar.
 *
 * Computed for EVERY assessment, not only `healthy`. The caller decides where to
 * spend it (§6.7 spends it on `healthy` alone), and a function that folded the
 * assessment check into itself could not be given the four separable fixtures
 * that prove all four conditions are read.
 */
export function evidenceGaps(row: TriageRow): readonly EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  if (!row.coverage.some(attempted)) gaps.push("coverage");
  if (!named(row.selector)) gaps.push("selector");
  if (!named(row.window)) gaps.push("window");
  if (!row.evidence_ref.some(named)) gaps.push("ledger");
  return gaps;
}

/** Present, and not merely a string that exists. */
function named(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Did the observer TRY this channel — §6.7 rule 2's fifth condition, and §13 task
 * 5.3b.
 *
 * §6.7's ruling, and the whole of the argument: *"**zero attempts and zero entries
 * carry exactly the same information** — the observer attempted nothing either
 * way, and the array's length is the only thing that differs."* So a `coverage[]`
 * of three `not_attempted` entries fails the FIRST condition rather than a fifth
 * one; it spends the existing `coverage` gap, mints no new name, and needs no
 * threshold.
 *
 * **The predicate is `!== "not_attempted"` and not `=== "answered"`, and the
 * difference is a judgement this host does not make.** `unreachable` and
 * `forbidden` are attempts — SRD-OBSERVER-001 §9.1 puts all three on one axis, and
 * an observer refused by RBAC has told the operator something true. Treating them
 * as non-evidence would be the host deciding the channel set was insufficient,
 * which is *"were these channels enough"* — a check with a threshold in it, the
 * judgement §6.7 rule 2's opening sentence removes from the host, and explicitly
 * still refused.
 */
function attempted(entry: CoverageEntry): boolean {
  return entry.result !== "not_attempted";
}

/**
 * How an artifact's echoed `sweep_id` stands against the one the host dispatched.
 *
 * Three states for two outcomes, and the third is named rather than hidden — the
 * posture `triage-partition.ts` takes for its undeclared services. §7.4 gives one
 * code, `stale_replay`, for *"an artifact whose value is not the dispatched
 * one"*, and an absent value is not the dispatched one. But the two arrive from
 * different faults and a log line should be able to say which: `stale` is the
 * replay §6.6 layer 3 was built to catch, while `absent` is an artifact that
 * ignored a required field of §7.4 — a contract violation by a worker that may
 * never have been told, which is a different thing to go and fix.
 *
 * {@link assessTriageSweep} spends both as `stale_replay`, because §7.4 named one
 * code and this module does not mint a second unilaterally.
 */
export function sweepIdEcho(
  dispatched: string,
  echoed: string | null,
): "fresh" | "stale" | "absent" {
  if (echoed === null || echoed === "") return "absent";
  return echoed === dispatched ? "fresh" : "stale";
}

/**
 * Why a service's assessment is what it is. Closed, and asserted by name.
 *
 * `observed` is the only member meaning *"the row was taken as the observer
 * wrote it"*. Every other member is the host declining a claim, and each one
 * names a different thing for the operator to do about it.
 */
export const ASSESSMENT_REASONS = [
  /** The row was accepted as written — §6.7's *"never judged fresh"*. */
  "observed",
  /** §6.7 rule 2: a `healthy` with no evidence attached. */
  "unevidenced_healthy",
  /** §6.6 layer 3: the artifact echoed the wrong `sweep_id`, or none. */
  "stale_replay",
  /** The assigned observer produced no reply file. §6.5's join, host-counted. */
  "no_artifact",
  /** The observer replied, freshly, and its document carries no row for this service. */
  "unreported",
  /**
   * The document carries MORE THAN ONE row for this service.
   *
   * §12 D12 forbids one verdict over a batch; two verdicts over one service is
   * that rule inverted, and choosing between them is judgement the host does not
   * do. Added after a mutation round found that first-row-wins and last-row-wins
   * were indistinguishable — and that under either, a worker could overturn its
   * own `unhealthy` by appending a `healthy`.
   */
  "duplicate_rows",
  /** The partition assigned this declared service to no observer at all. */
  "unassigned",
] as const;
export type AssessmentReason = (typeof ASSESSMENT_REASONS)[number];

/** One declared service's verdict for one sweep. */
export interface ServiceAssessment {
  readonly service: string;
  /**
   * The HOST's verdict, post-gate. This is the field §6.8's machine reads, and
   * a `healthy` here has already survived §6.7 rule 2.
   */
  readonly assessment: ObserverAssessment;
  readonly reason: AssessmentReason;
  /** The observer the HOST assigned this service to; `null` when unassigned. */
  readonly observer: string | null;
  /**
   * The worker's own word, for the record. `null` when no usable row existed.
   *
   * Deliberately NOT named `assessment`, so a reader reaching for a verdict finds
   * the gated one. It exists because §7.5's census argument is that the claim and
   * the count are both worth keeping — *"Capping on the disagreement would make
   * the datum cost something to record, which is how a field like that comes to
   * be quietly omitted."*
   */
  readonly claimed: ObserverAssessment | null;
  /**
   * §6.7 rule 2's failing conditions, by name. Empty when the row carried
   * evidence, and empty when there was no row to grade.
   */
  readonly gaps: readonly EvidenceGap[];
}

/**
 * The sweep's coverage record — `CollationCensusSchema` with services in place of
 * lenses (§7.5).
 *
 * `declared` and `counted` are published beside each other and **not reconciled**,
 * which is the census's own documented posture: the pair is the point, and a
 * consumer that capped on the disagreement would make the datum cost something to
 * record. Every downstream count in this console branches on `counted`.
 */
export interface SweepCensus {
  /** Observers the partition dispatched — the journal's `children[]`. */
  readonly observers_total: number;
  /** Of those, how many produced a reply artifact echoing THIS sweep. */
  readonly observers_reported: number;
  /** Dispatched observers with no reply artifact at all, by name. */
  readonly observers_missing: readonly string[];
  /** Dispatched observers whose artifact echoed the wrong id, or none, by name. */
  readonly observers_stale: readonly string[];
  /**
   * Artifacts present for workers this sweep did not dispatch, by name.
   *
   * Recorded rather than ignored: a reply from a seat that was not asked is
   * either a run-tree read that crossed a sweep boundary or a roster that moved
   * under the actor, and both are silent in every other field here.
   */
  readonly observers_unsolicited: readonly string[];
  /** `triage.json`'s OWN row count. The worker's claim. */
  readonly declared: number;
  /** Rows the host accepted: declared service, fresh artifact, assigned observer present. */
  readonly counted: number;
  /** §7.5's *"services it could not account for"*, as the worker named them. Never branched on. */
  readonly claimed_unaccounted: readonly string[];
  /** Rows naming a service `triage/targets.yaml` does not declare, by name, once each. */
  readonly undeclared_rows: readonly string[];
  /**
   * Services the document gave more than one row, by name, once each.
   *
   * A contract violation (§7.5's *"per service a row"*) rather than a coverage
   * fact, and it is published because the alternative — a host quietly preferring
   * one of two contradictory verdicts — is the failure this field was added to
   * make impossible to ship silently.
   */
  readonly duplicate_rows: readonly string[];
  /**
   * Declared services whose row named an observer other than the one the host
   * assigned, by service name.
   *
   * The row is still read — the host's assignment decides coverage and the row's
   * `observer` field decides nothing — but a partition the worker did not follow
   * is a fact about the sweep and the only place it would otherwise appear is
   * nowhere.
   */
  readonly misattributed: readonly string[];
}

/**
 * One sweep, assessed. `services` is one row per DECLARED service, in file order.
 */
export interface SweepAssessment {
  /** The id the HOST dispatched, echoed back for the record. */
  readonly sweep_id: string;
  readonly services: readonly ServiceAssessment[];
  readonly census: SweepCensus;
  /**
   * Every artifact whose echo failed §6.6 layer 3, by producing worker — the
   * collator included. Empty on a clean sweep.
   *
   * §12: *"assert the service is `indeterminate` and the outcome names
   * `stale_replay`"*. This is that naming, and the rows are absent from
   * {@link SweepCensus.counted} rather than merely labelled.
   */
  readonly stale_replay: readonly string[];
}

/**
 * `triage.json` + host-counted coverage → one assessment per declared service.
 *
 * Pure and total: every input produces a verdict rather than a throw. The
 * document is untrusted input a container wrote and is expected to be wrong
 * sometimes, which is `dispatch-request.ts`'s rule for that shape of failure —
 * a value, with throwing reserved for host arguments that are wrong for the life
 * of the run.
 *
 * ## Precedence, and every step of it is a host fact beating a worker claim
 *
 * 1. **`unassigned`** — the partition asked nobody. `checkTriagePartition` refuses
 *    this before dispatch (§6.5), so it is unreachable through
 *    `dispatchPartition`; it is answered rather than assumed away because a total
 *    function that returned a `healthy` for a service nobody was asked about
 *    would be the worst single output this module could produce.
 * 2. **`no_artifact`** — the assigned observer wrote no reply file. §6.5: *"A
 *    service whose observer stalled is `indeterminate` for that sweep, never
 *    `healthy`."* This is the step that makes §12's anti-criterion true: a
 *    `triage.json` claiming three services observed against two reply files
 *    yields an `indeterminate` third **whatever the row said**.
 * 3. **`stale_replay`** — the observer's artifact, or the collator's document,
 *    echoed the wrong id. §6.6 layer 3.
 * 4. **`unreported`** — a fresh observer answered and its document has no row for
 *    a service it was assigned.
 * 5. **`duplicate_rows`** — the document gave the service more than one row, and
 *    picking one of them is judgement rather than counting.
 * 6. **`unevidenced_healthy`** — §6.7 rule 2's gate.
 * 7. **`observed`** — taken as written.
 *
 * `no_artifact` is ordered above `stale_replay` deliberately. When the collator's
 * own document is stale, every service falls to step 3; a service whose observer
 * also never replied keeps `no_artifact`, because that is the narrower and more
 * actionable fact and the operator's next move differs — one is a worker to
 * restart, the other is a session to recycle (§6.6 layer 4).
 *
 * A service assigned twice takes its first assignment. `checkTriagePartition`
 * refuses that as `partition_duplicate` before dispatch, so the choice is
 * unreachable rather than arbitrary-by-preference; it is fixed here so the
 * function stays total.
 */
export function assessTriageSweep(
  dispatchedSweepId: string,
  coverage: SweepCoverage,
  document: TriageDocument,
): SweepAssessment {
  // Host assignment, first-wins. `checkTriagePartition` has already refused a
  // second claim on the same service; this only keeps the function total.
  const assignedTo = new Map<string, string>();
  for (const assignment of coverage.assignments) {
    for (const service of assignment.services) {
      if (!assignedTo.has(service)) assignedTo.set(service, assignment.worker);
    }
  }

  const dispatched = new Set(coverage.assignments.map((a) => a.worker));
  const echoes = new Map<string, "fresh" | "stale" | "absent">();
  const unsolicited: string[] = [];
  for (const artifact of coverage.artifacts) {
    if (!dispatched.has(artifact.worker)) {
      unsolicited.push(artifact.worker);
      continue;
    }
    echoes.set(artifact.worker, sweepIdEcho(dispatchedSweepId, artifact.sweep_id));
  }

  /*
   * Dispatch order, because that is the order the actor's log already reads in.
   *
   * The three lists PARTITION the dispatched set — missing, stale, reported —
   * so `observers_total` is their sum and a seat cannot fall out of all three.
   * An observer that replied with the wrong id is `stale`, not `reported`: it
   * produced a file, and counting it as a report is how a replay becomes
   * coverage.
   */
  const observersMissing = [...dispatched].filter((worker) => !echoes.has(worker));
  const observersStale = [...dispatched].filter((worker) => {
    const echo = echoes.get(worker);
    return echo === "stale" || echo === "absent";
  });
  const observersReported = [...dispatched].filter((w) => echoes.get(w) === "fresh").length;

  /*
   * The collator's own echo. §7.5 requires it and §6.6 layer 3 is why: `tri-1`
   * holds the longest session of the four seats, so a replay there returns last
   * sweep's verdict for every service at once.
   */
  const documentEcho = sweepIdEcho(dispatchedSweepId, document.sweep_id);
  const documentFresh = documentEcho === "fresh";

  const staleReplay = [...observersStale];
  if (!documentFresh) staleReplay.unshift(document.worker);

  /*
   * Rows grouped, not indexed — a service can appear more than once and the
   * count is the thing the precedence below reads.
   *
   * **CHANGED after a second mutation round.** The first implementation took the
   * first row and let the rest go, and no fixture separated that from taking the
   * last. Neither is defensible: `triage.json` is a document a container wrote,
   * nothing stops it carrying two rows for one service, and an `unhealthy`
   * followed by a `healthy` flips the verdict under one rule and not the other.
   * Picking silently would let a worker overturn its own finding by appending to
   * its output — the claim-over-count inversion §6.7 exists to prevent, arriving
   * through a door the host held open.
   *
   * So more than one row is refused for that service (§12 D12's rule from the
   * other side: *"a single `assessment` covering a batch is a schema
   * violation"*, and two assessments covering one service is the same disorder
   * inverted). **Agreement is not consulted**, deliberately: a host that accepted
   * two rows because they happened to match would be reconciling them, and
   * reconciling is judging.
   */
  const rows = new Map<string, TriageRow[]>();
  for (const row of document.services) {
    const held = rows.get(row.service);
    if (held === undefined) rows.set(row.service, [row]);
    else held.push(row);
  }

  const declaredSet = new Set(coverage.declared);
  // Deduplicated, first-appearance order: this is a defect list an operator
  // reads, and a document spamming one name should not fill it. The multiplicity
  // is still visible — `census.declared` is the document's raw row count.
  const undeclaredRows = [...rows.keys()].filter((service) => !declaredSet.has(service));
  const duplicateRows = [...rows.entries()].filter(([, held]) => held.length > 1).map(([s]) => s);

  const misattributed: string[] = [];
  let counted = 0;

  const services = coverage.declared.map((service): ServiceAssessment => {
    const observer = assignedTo.get(service) ?? null;
    if (observer === null) return blank(service, null, "unassigned");

    const echo = echoes.get(observer);
    if (echo === undefined) return blank(service, observer, "no_artifact");
    if (echo !== "fresh" || !documentFresh) return blank(service, observer, "stale_replay");

    const held = rows.get(service);
    if (held === undefined) return blank(service, observer, "unreported");
    if (held.length > 1) return blank(service, observer, "duplicate_rows");
    const row = held[0] as TriageRow;

    /*
     * Counted BEFORE the gate, and the two axes are genuinely different
     * questions. `counted` answers §7.5's census question — *"how many
     * independent readers reported"*, with services in place of lenses — and a
     * fresh observer that wrote a row for this service reported on it. The
     * QUALITY of that report is the assessment axis, and §6.7 rule 2 answers it
     * three lines down.
     *
     * Folding the gate into the count would make one number mean both, and the
     * pair `declared`-versus-`counted` exists precisely so that the worker's
     * claim and the host's count can disagree in public. A gate failure is not
     * a disagreement about whether the worker answered.
     */
    counted += 1;
    if (named(row.observer) && row.observer !== observer) misattributed.push(service);

    const gaps = evidenceGaps(row);
    if (row.assessment === "healthy" && gaps.length > 0) {
      return {
        service,
        assessment: "indeterminate",
        reason: "unevidenced_healthy",
        observer,
        claimed: "healthy",
        gaps,
      };
    }

    return {
      service,
      assessment: row.assessment,
      reason: "observed",
      observer,
      claimed: row.assessment,
      gaps,
    };
  });

  return {
    sweep_id: dispatchedSweepId,
    services,
    stale_replay: staleReplay,
    census: {
      observers_total: dispatched.size,
      observers_reported: observersReported,
      observers_missing: observersMissing,
      observers_stale: observersStale,
      observers_unsolicited: unsolicited,
      declared: document.services.length,
      counted,
      claimed_unaccounted: [...document.unaccounted],
      undeclared_rows: undeclaredRows,
      duplicate_rows: duplicateRows,
      misattributed,
    },
  };
}

/**
 * A service the host could not get an answer for.
 *
 * `indeterminate` and never `healthy` — SRD-OBSERVER-001 §9.2, and §6.5 says it
 * for this exact case. `claimed` is `null` rather than the row's value: there was
 * no row the host was willing to read, and carrying one here would put a claim
 * the host rejected into the field a log line prints.
 */
function blank(
  service: string,
  observer: string | null,
  reason: Exclude<AssessmentReason, "observed" | "unevidenced_healthy">,
): ServiceAssessment {
  return { service, assessment: "indeterminate", reason, observer, claimed: null, gaps: [] };
}
