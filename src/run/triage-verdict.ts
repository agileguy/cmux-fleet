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
 * ## §7.4's SECOND echo, and why one does not imply the other
 *
 * `window_opened_at` is the third required field on `observer-ops.json` and
 * {@link windowEcho} grades it. §7.4's argument for a third field rather than a
 * second reading of the second: *"`sweep_id` proves the observer ran THIS sweep;
 * `window_opened_at` proves it looked at the right stretch of time. An observer
 * can echo the correct sweep id, name a window in every row, and have queried
 * six hours against a five-minute configuration"*. Two checks, two faults,
 * neither reachable from the other — and the pair of fixtures that proves it is
 * the asymmetric one: a good id with a bad window discards, and a bad id with a
 * good window discards. Without both, either check can be deleted whole.
 *
 * It spends its own reason, `stale_window`, *"because the operator response
 * differs"*, and it is ARTIFACT-level like `stale_replay` — a wrong window
 * applies to every row the document carries.
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
 * **Saturation (§6.7 rule 3, D15) LANDED HERE as task 5.3a**, and it is the one
 * thing in this file that spans more than the sweep's own arithmetic: see
 * {@link saturationVerdict} and {@link sweepObservations} at the foot of the
 * module. The correlation signal was already published here —
 * {@link SweepCensus.observers_missing}, *"two or more observers producing no
 * artifact in one sweep"* — and what 5.3a added is the confirming probe (injected,
 * never defaulted) and the **suppression** of the coverage escalation, which §13
 * requires be written before the verdict.
 *
 * **The escalation itself is still not this module's.** `consecutive_indeterminate`
 * lives in the incident record and only `advanceIncident` moves it. What
 * {@link sweepObservations} does is decide which SIGNAL each service's record is
 * advanced with, and a suppressed sweep hands every one of them
 * `{kind: "suppressed"}` — the member `advanceIncident` answers by returning the
 * caller's own record, identity included.
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

import { hostReachableBaseUrl, probeNativeToolCalls } from "../security/model-probe.ts";
import type {
  FetchLike,
  HostDialConfigView,
  ToolCallProbeResult,
} from "../security/model-probe.ts";
import type {
  IncidentObservation,
  IncidentSignal,
  ObservedIssueReason,
} from "./triage-incident.ts";
import type { PartitionAssignment } from "./triage-partition.ts";
import { seatKind } from "./triage-seat-kinds.ts";
import type { TriageEnvironmentKind } from "./triage-targets.ts";

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
 * The byte ceiling on {@link TriageRow.note} — §13 task 5.8's *"bounded in bytes
 * and refused above the bound by name"*.
 *
 * ## Bytes, and the two units are not interchangeable for this field
 *
 * Every other bound on this document is a `z.string().max()` in
 * `triage-document.ts`, which counts UTF-16 **code units**. This is the one field
 * whose contents are re-emitted into a place measured in **bytes**: `fenceEvidence`
 * caps with `Buffer.byteLength`, ntfy's own limits are byte limits, and §6.9's
 * header rule is about a byte boundary. A 4,000-character note of accented text is
 * 8,000 bytes, so a code-unit bound would admit a note twice the size of the block
 * that has to carry it — the bound would be nominal rather than real.
 *
 * ## The value, and it is derived from a downstream fact rather than picked
 *
 * **A note this host ACCEPTED must never be silently truncated by the thing that
 * renders it.** `fenceEvidence` (`triage-notify.ts`) truncates above
 * `EVIDENCE_MAX_BYTES`, appending a marker but losing the tail; a schema bound
 * above that would mean admitting bytes the operator never sees, with the loss
 * recorded on no surface. So the rule is
 * `TRIAGE_NOTE_MAX_BYTES <= EVIDENCE_MAX_BYTES`, and at equality the refusal lands
 * one byte before the truncation ever can.
 *
 * **Pinned by a test rather than by an import**, on the precedent this console
 * already uses for `CONSOLE_HEALTH_KINDS`/`CONSOLE_HEALTH_ASSESSMENTS`: the
 * notifier deliberately imports nothing from the state machine and is a sibling of
 * this module, not a dependency of it, so a source-level `import` here to borrow a
 * number would add a module edge for no behaviour.
 * `test/unit/triage-verdict.test.ts` asserts the relation, so lowering the
 * notifier's cap reddens here instead of starting a silent truncation.
 */
export const TRIAGE_NOTE_MAX_BYTES = 1_024;

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
  /**
   * §13 task 5.8 — the ONE piece of worker prose this contract carries, bounded
   * by {@link TRIAGE_NOTE_MAX_BYTES} and destined for `Announcement.evidence`.
   *
   * ## Why the field exists, stated as the defect it closes
   *
   * §6.9's containment machinery — `fenceEvidence`, `EVIDENCE_BANNER_OPEN`,
   * `EVIDENCE_LINE_PREFIX` — was built because worker prose flows into a
   * notification. With no prose field on this document it guarded a road nobody
   * used: the pass had nothing to put in `evidence`, so it passed `null` to every
   * announcement and the whole banner block was **structurally unreachable in
   * production**. The operator got `evidence: <ref>` and no sentence, which moves
   * their first question from *"what broke"* to *"where do I look"*.
   *
   * ## It is NOT an input to the evidence gate, and that direction matters
   *
   * {@link evidenceGaps} does not read this field and must never be widened to.
   * §6.7 rule 2 grades a `healthy` on structured citations — coverage, selector,
   * window, ledger — precisely so the gate cannot be satisfied with words. A note
   * that counted toward the gate would let a worker clear its own downgrade by
   * writing a paragraph, which is the claim-over-count inversion the gate exists
   * to prevent, arriving through the one field that is pure claim.
   *
   * ## OPTIONAL here, where {@link ObserverArtifact.window_opened_at} is required
   *
   * The 5.3d ruling made that field a required `string | null` because §7.4 lists
   * it among *"three required fields"*, so an artifact that omitted it commits a
   * contract violation the host must be able to RECORD — and an optional member
   * would spell that fault with the same token as *"the host never read the
   * field"*. **No such second fact exists here.** §13 task 5.8 says *"one
   * OPTIONAL `note` per row"*: a row with nothing worth saying is the ordinary
   * case, not a violation, so `undefined` and `null` denote the same thing and
   * there is nothing for the distinction to lose. Every value this host acts on
   * comes from `parseTriageDocument`, whose schema `.default(null)`s the key, so
   * production never sees `undefined` at all.
   *
   * **Recorded rather than dressed up: the optional member is also what keeps
   * this change inside its slice.** Four files outside it build `TriageRow`
   * literals (`triage-pass.test.ts`, `triage-envelope.test.ts`,
   * `triage-command.test.ts`), and a required member is a compile error in each.
   * The design reason above is the one that decides it; had the two disagreed,
   * the field would have been required and the literals updated.
   */
  readonly note?: string | null;
  /**
   * The environment this row is about, spelled as the envelope names it —
   * SRD-TRIAGE-MIXED-OBSERVERS D21, task 4.1b.
   *
   * A service name alone stops being unique the moment one sweep covers two
   * environments: the tracked `triage/targets.yaml` declares a `grafana` and a
   * `prometheus` under both `do-cluster` and `docker-host`. The row, not the
   * host, has to say which one it means, because the collator writes both rows
   * into one document and nothing else on the row separates them.
   *
   * OPTIONAL for the reason `note` is: a sweep over ONE environment has exactly
   * one legal answer, so an absent value resolves to that environment and every
   * existing single-environment document stays valid. A sweep over more than one
   * environment has no default, and a row without it cannot be keyed. Resolving
   * it is the verdict's job, not the parser's; `parseTriageDocument` only checks
   * the spelling and `.default(null)`s the key.
   */
  readonly environment?: string | null;
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
  /**
   * §7.4's THIRD required field — the instant the observer's queries looked back
   * from. `null` when the artifact named no usable value, which
   * {@link windowEcho} answers as `absent` and {@link assessTriageSweep} spends
   * as `stale_window`.
   *
   * **REQUIRED here, and `string | null` rather than optional, because the two
   * absences are different facts and only one of them is a worker's.** §7.4 lists
   * it among *"three required fields"*, so an artifact that omitted it is a
   * contract violation the host must be able to RECORD — and `null` is how it
   * records one. An OPTIONAL member would have spelled that fault with the same
   * token as *"the host never read the field"*, which is a bug in the host, and a
   * reader cannot tell those apart from a missing key. §13 task 5.3d, closing the
   * debt {@link SweepCoverage.window} records.
   */
  readonly window_opened_at: string | null;
}

/**
 * The two configured values that fix §7.4's legal range.
 *
 * **They come from two different files, which is worth stating because §7.4 says
 * otherwise.** §7.4:1916-1918 has *"§7.8 already holds the two values"*;
 * `default_window` is §7.1's — `environments.<env>.default_window` in
 * `triage/targets.yaml` (§7.1:1766) — and only `reserve_s` is §7.8's
 * (`triage/console.yaml`, :2065). Whatever assembles a {@link SweepCoverage}
 * therefore reads both files, which is the same pairing §7.8:2147-2151 already
 * requires of the loader for the `default_window ≤ cadence_s` refusal.
 *
 * Seconds, both, because that is how §7.8 spells `reserve_s` and how
 * `parseDuration` resolves §7.1's `default_window`.
 */
export interface WindowPolicy {
  /** §7.1 `environments.<env>.default_window`, resolved to seconds. */
  readonly default_window_s: number;
  /** §7.8 `reserve_s`. */
  readonly reserve_s: number;
}

/** {@link WindowPolicy} plus the instant the range is measured back from. */
export interface SweepWindow extends WindowPolicy {
  /** The instant the HOST dispatched this sweep. ISO-8601, minted host-side. */
  readonly dispatched_at: string;
}

/**
 * One environment `SweepCoverage.declared` names, with the services it
 * declares — SRD-TRIAGE-MIXED-OBSERVERS D21, task 4.1b.
 *
 * `kind` is what {@link resolveAssignmentEnvironment} matches a worker's
 * {@link seatKind} against, so an assignment can be attributed to the right
 * entry without the entry carrying a worker list of its own — the partition
 * already IS that list, per kind, upstream in `triage-partition.ts`.
 */
export interface DeclaredEnvironment {
  readonly name: string;
  readonly kind: TriageEnvironmentKind;
  /** Every service this environment declares, in file order. */
  readonly services: readonly string[];
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
  /**
   * Every environment this sweep covers, in file order, each with its own
   * declared services — SRD-TRIAGE-MIXED-OBSERVERS D21, task 4.1b.
   *
   * ONE entry until Phase 4 task 4.2 widens the console's own caller; a
   * single-entry list is what makes every pre-4.1b fixture and caller still
   * legal, because `resolveRowEnvironment` and `resolveAssignmentEnvironment`
   * both fall back to the sole entry when there is only one.
   */
  readonly declared: readonly DeclaredEnvironment[];
  /** The partition the actor dispatched — the journal's `children[]`, with their shares. */
  readonly assignments: readonly PartitionAssignment[];
  /** The observers whose reply artifact is present. Never the worker's claim of same. */
  readonly artifacts: readonly ObserverArtifact[];
  /**
   * §7.4's window bound — the dispatch instant and the environment's configured
   * window.
   *
   * **REQUIRED, and it was optional for exactly one round.** Task 5.3c shipped it
   * optional for a process reason rather than a design one: a required member was
   * a compile error in `test/unit/triage-document.test.ts`, a file that belonged
   * to no task in that round's slice. §13 task 5.3d closes it, and the reason it
   * was worth closing is the posture this module's header states — everything
   * else on this interface is required precisely so a caller cannot skip it,
   * *"a property of the code"* rather than caller discipline. While the member
   * was optional, §7.4's second echo was the one check here a caller could
   * decline to run by omitting an argument, and omitting an argument is not a
   * decision anybody makes on purpose.
   *
   * A caller that supplies it cannot then be lied to — the dispatch instant is
   * the host's own value and is never read out of an artifact, for exactly the
   * reason `sweepIdEcho`'s dispatched id is a parameter: a comparand the
   * document supplied would compare a value to itself and pass forever.
   */
  readonly window: SweepWindow;
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
 * The row's own citation — §7.5's ledger, first named entry, trimmed.
 *
 * The same {@link named} predicate the `ledger` gap uses, so the two cannot
 * disagree about what counts: a row whose gaps do NOT include `ledger` has a
 * non-null citation here, and a row whose gaps DO include it has `null`. That
 * equivalence is what lets {@link serviceSignal} refuse a clear on a null
 * citation without re-deriving §6.7 rule 2.
 *
 * Trimmed because the value is pasted into a notification and a log line, and
 * `named` has already ruled that the surrounding space carries nothing.
 */
function firstEvidenceRef(row: TriageRow): string | null {
  return row.evidence_ref.find(named)?.trim() ?? null;
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
 * How an artifact's echoed `window_opened_at` stands against the range §7.4
 * fixes — §6.6 layer 3's *other* half, and §13 task 5.3c.
 *
 * ## Why this is not a duplicate of {@link sweepIdEcho}
 *
 * §7.4, and the sentence is the whole justification for a third required field:
 * *"`sweep_id` proves the observer ran THIS sweep; `window_opened_at` proves it
 * looked at THE RIGHT STRETCH OF TIME. An observer can echo the correct sweep
 * id, name a window in every row, and have queried six hours against a
 * five-minute configuration — **reporting stale data as fresh, which is the
 * exact failure layer 3 exists to prevent**."* The row-level `window` field does
 * not cover it either: §6.7's structural gate tests that a window was NAMED, not
 * that it was opened when it should have been.
 *
 * ## The table, verbatim
 *
 * | condition | verdict |
 * |---|---|
 * | absent | refused |
 * | earlier than `dispatched_at − default_window − reserve_s` | refused |
 * | later than `dispatched_at` | refused |
 * | otherwise | accepted |
 *
 * Both boundaries are INCLUSIVE, which is what *"earlier than"* and *"later
 * than"* say. §7.4 needs no new knob for either: the host dispatched the sweep
 * at a known instant, and the two values that fix the range are already
 * configured (see {@link WindowPolicy}).
 *
 * ## Three states for the refusal's two, so a log can say which
 *
 * `sweepIdEcho`'s posture exactly. `out_of_range` is the observer looking at the
 * wrong stretch of time; `absent` is an artifact that ignored a required field
 * of §7.4 — a contract violation by a worker that may never have been told, and
 * a different thing to go and fix. {@link assessTriageSweep} spends both as
 * `stale_window`, because §7.4 named one code.
 *
 * **An unparseable value is `absent` rather than `out_of_range`**, and there is
 * no fourth state to give it. `out_of_range` asserts something specific about
 * WHEN the observer looked, and `"yesterday"` asserts nothing of the kind; what
 * is true of it is that the artifact carries no usable window instant, which is
 * what `absent` already means. Both refuse, so the choice reaches the log line
 * and nothing else.
 *
 * ## A malformed HOST bound THROWS, and that arm is load-bearing
 *
 * `Date.parse` answers `NaN`, and every comparison against `NaN` is false — so
 * an implementation that shrugged at its own bound would find no artifact
 * earlier than the earliest and none later than the dispatch, and would answer
 * `fresh` for **every artifact in every sweep**. The check would not merely
 * weaken, it would invert into a rubber stamp, and the only visible symptom
 * would be a `stale_window` that never appeared again. Throwing is also this
 * module's own rule for the class — *"a value, with throwing reserved for host
 * arguments that are wrong for the life of the run"* — and the three inputs
 * split cleanly along it: `dispatchedAt` and `policy` are the host's, `openedAt`
 * is a container's and is answered with a state.
 *
 * A NEGATIVE bound is left to the arithmetic on purpose: it narrows the range
 * and eventually empties it, so a mis-signed knob refuses artifacts rather than
 * accepting them. §7.8's schema bounds both values above zero anyway; this notes
 * which way the unguarded case falls, which is the one that matters.
 */
export function windowEcho(
  dispatchedAt: string,
  openedAt: string | null | undefined,
  policy: WindowPolicy,
): "fresh" | "absent" | "out_of_range" {
  const dispatched = Date.parse(dispatchedAt);
  if (
    !Number.isFinite(dispatched) ||
    !Number.isFinite(policy.default_window_s) ||
    !Number.isFinite(policy.reserve_s)
  ) {
    throw new RangeError(
      `windowEcho: the host's own bound is not a number — dispatched_at=${dispatchedAt}, ` +
        `default_window_s=${policy.default_window_s}, reserve_s=${policy.reserve_s}. ` +
        `Comparing against NaN would accept every window in every sweep.`,
    );
  }

  if (openedAt === null || openedAt === undefined || openedAt.trim() === "") return "absent";
  const opened = Date.parse(openedAt);
  if (!Number.isFinite(opened)) return "absent";

  const earliest = dispatched - (policy.default_window_s + policy.reserve_s) * 1_000;
  if (opened < earliest || opened > dispatched) return "out_of_range";
  return "fresh";
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
  /**
   * §7.4: the artifact echoed a `window_opened_at` outside the legal range, or
   * none.
   *
   * Its own code beside `stale_replay` *"because the operator response differs —
   * a stale sweep id is a worker replaying an old answer, and a wrong window is
   * a worker answering the wrong question"*.
   */
  "stale_window",
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
   * The environment this service belongs to — SRD-TRIAGE-MIXED-OBSERVERS D21,
   * task 4.1b. `assessTriageSweep` mints it from the {@link DeclaredEnvironment}
   * entry the service came from, never from the row: a `blank` row has no row
   * to read at all, and this field is what lets {@link sweepObservations} key
   * every subject on `(environment, service)` without re-deriving it.
   */
  readonly environment: string;
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
  /**
   * THIS service's own citation — §7.5's `evidence_ref` ledger, first named
   * entry. `null` when there was no row to read, or when the row's ledger named
   * nothing (§13 task 5.3e).
   *
   * ## Why a per-row field exists at all
   *
   * §6.8 asks a recovery to name *"the evidence that closed it"* — singular, and
   * about ONE incident. Before this field, {@link sweepObservations} had only a
   * sweep-level ref to cite, following `consoleHealthObservations`' precedent,
   * which is right for a console-health fact (there IS one sweep) and wrong for a
   * service (there are as many observers as the partition dispatched). A recovery
   * on `authorization` that cited the sweep's `triage.json` pointed the operator
   * at the collation rather than at the observation that actually cleared it.
   *
   * ## Singular, and the first named entry
   *
   * §7.5's `evidence_ref` is a LEDGER — an array — and `IncidentSignal` takes one
   * string. Something has to choose, and the choice is made here, once, rather
   * than at each of the call sites that would otherwise each pick differently.
   * First-named is the observer's own ordering, and {@link named} decides what
   * counts, so `[""]` and `["   "]` are `null` here for exactly the reason they
   * are a `ledger` gap above: a citation defeatable with a space bar is not a
   * citation.
   *
   * ## It is a RECORD, not a licence
   *
   * Carried on the `unevidenced_healthy` row too, beside {@link claimed} and
   * {@link gaps}, because on that row the host did read a row and the row's
   * contents are the fact being reported. It is `null` on every {@link blank} row
   * for {@link claimed}'s reason: there was no row the host was willing to read.
   *
   * **A non-null value here is not evidence that the service is fine**, and
   * nothing downstream may treat it as such. {@link serviceSignal} reads
   * `assessment` to decide WHICH signal, and this field only to fill in the
   * citation — an order that matters, because the reverse would let a row with a
   * ledger and a missing selector clear an incident.
   */
  readonly evidence_ref: string | null;
  /**
   * THIS service's own {@link TriageRow.note} — the worker prose the announcement
   * for this subject carries, or `null`.
   *
   * ## Required here where the row's member is optional, and the asymmetry is the
   * ## point rather than an inconsistency
   *
   * {@link TriageRow} is a **worker's** document and may omit the key.
   * {@link ServiceAssessment} is the **host's** answer, produced by exactly one
   * function, and a host that is silent about a field is a host that forgot to
   * read it. `string | null` makes *"this service has no note"* an answer this
   * type can only give on purpose, and `tsc` requires every arm of the precedence
   * ladder below to give it.
   *
   * ## Populated on the same two rows as {@link evidence_ref}, and for its reason
   *
   * The two `observed`/`unevidenced_healthy` arms carry it, because on both of
   * those the host read a row and the row's contents are the fact being reported.
   * Every {@link blank} row is `null`: there was no row the host was willing to
   * read, so there is no prose it is entitled to quote. **An announcement about a
   * service nobody observed must not carry a sentence from a document the host
   * refused** — that is the absence-as-evidence mistake in its most persuasive
   * form, since the prose would read as an observation.
   *
   * ## Still untrusted, and carried no further than the fence
   *
   * Reaching this type does not launder it. It is the string §6.9 requirement 1
   * holds out of the title and the message; `fenceEvidence` is what makes it
   * safe to show at all, and nothing may interpolate it anywhere else.
   */
  readonly note: string | null;
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
   * Dispatched observers whose artifact echoed THIS sweep and a window outside
   * §7.4's range, or no window at all, by name.
   *
   * **A fourth class rather than a widening of `observers_stale`**, so the four
   * still partition the dispatched set and `observers_total` is still their sum.
   * Keeping it out of `observers_reported` is the same rule that keeps a stale
   * id out of it: the observer produced a file, every row of that file was
   * discarded, and counting it as a report is how stale data becomes coverage.
   *
   * Empty on a clean sweep, and there is no second reading of that emptiness:
   * {@link SweepCoverage.window} is required, so the echo ran (§13 task 5.3d).
   */
  readonly observers_stale_window: readonly string[];
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
  /**
   * Every artifact whose window echo failed §7.4, by producing worker. Empty on
   * a clean sweep, and empty means clean.
   *
   * **`window_checked` was RETIRED from this interface by §13 task 5.3d, and the
   * retirement is a decision rather than a tidy-up.** It published whether §7.4's
   * echo had run at all, because {@link SweepCoverage.window} was optional and
   * *"a caller reading `stale_window: []` cannot otherwise tell a sweep whose
   * windows were all in range from one where nobody looked"* — it was the skip's
   * own witness (ISC-698). With the policy required there is no skip left to
   * witness: the echo runs on every sweep this function can be handed, so the
   * field could only ever be `true`. A boolean that is a constant is worse than
   * no boolean — a reader may branch on it believing a `false` case exists, and a
   * test asserting `true` asserts nothing about the code. What ISC-698 actually
   * wanted was an unskippable check, and the required member IS that, enforced by
   * the compiler rather than published after the fact.
   *
   * **The collator can never appear here, and that is the contract rather than
   * an omission.** §7.4 puts `window_opened_at` on `observer-ops.json`; §7.5's
   * `triage.json` carries the sweep id and no window, so `stale_replay` names
   * `tri-1` when the document is stale and this list names observers only.
   */
  readonly stale_window: readonly string[];
}

/**
 * `triage.json` + host-counted coverage → one assessment per declared
 * (environment, service) pair.
 *
 * Pure and total: every input produces a verdict rather than a throw. The
 * document is untrusted input a container wrote and is expected to be wrong
 * sometimes, which is `dispatch-request.ts`'s rule for that shape of failure —
 * a value, with throwing reserved for host arguments that are wrong for the life
 * of the run.
 *
 * ## Keyed by (environment, service), not service alone — D21, task 4.1b
 *
 * `triage/targets.yaml` can declare the same service name under two
 * environments of different kind — `do-cluster` and `docker-host` both hold a
 * `grafana` — and once one sweep can cover more than one environment (§6.1), a
 * plain service name stops being unique inside it. Every place this function
 * used to group, assign or count by `service` now does it by the pair instead:
 * {@link resolveRowEnvironment} and {@link resolveAssignmentEnvironment} are
 * the two places a name is resolved to one, and {@link environmentServiceKey}
 * is the one spelling both of them, and every internal `Map`, key on. A row or
 * an assignment that cannot be resolved to an environment is never guessed
 * into one — see each resolver's own docblock for what happens to it instead.
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
 * 4. **`stale_window`** — the artifact echoed a window outside §7.4's range, or
 *    none. Artifact-level, so it takes the observer's whole share.
 * 5. **`unreported`** — a fresh observer answered and its document has no row for
 *    a service it was assigned.
 * 6. **`duplicate_rows`** — the document gave the service more than one row, and
 *    picking one of them is judgement rather than counting.
 * 7. **`unevidenced_healthy`** — §6.7 rule 2's gate.
 * 8. **`observed`** — taken as written.
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
  // Host assignment, first-wins, keyed on (environment, service) — D21, task
  // 4.1b. `checkTriagePartition` has already refused a second claim on the
  // same service WITHIN ONE KIND (task 4.1); this only keeps the function
  // total. An assignment `resolveAssignmentEnvironment` cannot place is
  // dropped rather than guessed: its services simply gain no assignment here,
  // which is the same total answer an unreached service already gets below.
  const assignedTo = new Map<string, string>();
  for (const assignment of coverage.assignments) {
    const environment = resolveAssignmentEnvironment(assignment, coverage.declared);
    if (environment === null) continue;
    for (const service of assignment.services) {
      const key = environmentServiceKey(environment, service);
      if (!assignedTo.has(key)) assignedTo.set(key, assignment.worker);
    }
  }

  const dispatched = new Set(coverage.assignments.map((a) => a.worker));
  const echoes = new Map<string, "fresh" | "stale" | "absent">();
  const windows = new Map<string, "fresh" | "absent" | "out_of_range">();
  const policy = coverage.window;
  const unsolicited: string[] = [];
  for (const artifact of coverage.artifacts) {
    if (!dispatched.has(artifact.worker)) {
      unsolicited.push(artifact.worker);
      continue;
    }
    echoes.set(artifact.worker, sweepIdEcho(dispatchedSweepId, artifact.sweep_id));
    windows.set(
      artifact.worker,
      windowEcho(policy.dispatched_at, artifact.window_opened_at, policy),
    );
  }

  /**
   * §7.4's echo, failed.
   *
   * The `undefined` arm is an observer that produced NO artifact — `windows` is
   * keyed by the artifacts actually found, so a silent seat has no entry and must
   * not be reported as a window fault. It is `no_artifact`, which is a different
   * and narrower thing to go and fix.
   *
   * **That arm is UNREACHABLE from the three call sites below, and it is kept
   * anyway — stated here so the next mutation round does not re-derive it.** Task
   * 5.3d made `coverage.window` required, so `echoes` and `windows` are now
   * populated together in one loop and `echoes.has(w)` implies `windows.has(w)`;
   * every call site already establishes `echoes.get(w) === "fresh"` first. So
   * deleting `echo !== undefined` is an EQUIVALENT mutant: no fixture can
   * distinguish it, and one that appeared to would be asserting something untrue
   * about the loop above. It survives on purpose. Before 5.3d the guard was
   * load-bearing — `windows` was populated only when a policy was supplied — and
   * this is the module's standing posture for the class either way: the
   * `unassigned` precedence step and `saturationVerdict`'s zero-dispatch arm are
   * both answered rather than assumed away, because a total function that got
   * this wrong would report a window fault against a seat that never wrote a file.
   */
  const badWindow = (worker: string): boolean => {
    const echo = windows.get(worker);
    return echo !== undefined && echo !== "fresh";
  };

  /*
   * Dispatch order, because that is the order the actor's log already reads in.
   *
   * The four lists PARTITION the dispatched set — missing, stale, out-of-window,
   * reported — so `observers_total` is their sum and a seat cannot fall out of
   * all four. An observer that replied with the wrong id is `stale`, not
   * `reported`: it produced a file, and counting it as a report is how a replay
   * becomes coverage. §7.4's window failure is kept out of `reported` by the
   * same rule and for the same reason — every row of that artifact is discarded,
   * so an observer that reported nothing usable did not report.
   */
  const observersMissing = [...dispatched].filter((worker) => !echoes.has(worker));
  const observersStale = [...dispatched].filter((worker) => {
    const echo = echoes.get(worker);
    return echo === "stale" || echo === "absent";
  });
  const observersStaleWindow = [...dispatched].filter(
    (worker) => echoes.get(worker) === "fresh" && badWindow(worker),
  );
  const observersReported = [...dispatched].filter(
    (w) => echoes.get(w) === "fresh" && !badWindow(w),
  ).length;

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
   *
   * **Grouped on (environment, service), not service alone — D21, task 4.1b.**
   * A row `resolveRowEnvironment` cannot place — no `environment` of its own,
   * `declared` names more than one, and its `service` names zero or several of
   * them rather than exactly one — is reported in `undeclaredRows`, bare, and
   * never grouped here at all: duplication is a fact about a KEY two rows
   * share, and an unkeyable row has no key to share with anything.
   */
  const declaredKeys = new Set<string>();
  for (const env of coverage.declared) {
    for (const service of env.services) declaredKeys.add(environmentServiceKey(env.name, service));
  }

  const keyedRows = new Map<string, { readonly environment: string; readonly service: string; rows: TriageRow[] }>();
  const undeclaredRows: string[] = [];
  const seenUndeclared = new Set<string>();
  // Deduplicated, first-appearance order: this is a defect list an operator
  // reads, and a document spamming one name should not fill it. The multiplicity
  // is still visible — `census.declared` is the document's raw row count.
  const noteUndeclared = (label: string): void => {
    if (seenUndeclared.has(label)) return;
    seenUndeclared.add(label);
    undeclaredRows.push(label);
  };

  for (const row of document.services) {
    const environment = resolveRowEnvironment(row, coverage.declared);
    if (environment === null) {
      noteUndeclared(row.service);
      continue;
    }

    const key = environmentServiceKey(environment, row.service);
    const held = keyedRows.get(key);
    if (held === undefined) keyedRows.set(key, { environment, service: row.service, rows: [row] });
    else held.rows.push(row);

    if (!declaredKeys.has(key)) {
      noteUndeclared(censusLabel(environment, row.service, coverage.declared.length));
    }
  }

  const duplicateRows = [...keyedRows.values()]
    .filter((group) => group.rows.length > 1)
    .map((group) => censusLabel(group.environment, group.service, coverage.declared.length));

  const misattributed: string[] = [];
  let counted = 0;

  const services = coverage.declared.flatMap((env) =>
    env.services.map((service): ServiceAssessment => {
      const key = environmentServiceKey(env.name, service);
      const observer = assignedTo.get(key) ?? null;
      if (observer === null) return blank(service, env.name, null, "unassigned");

      const echo = echoes.get(observer);
      if (echo === undefined) return blank(service, env.name, observer, "no_artifact");
      if (echo !== "fresh" || !documentFresh) return blank(service, env.name, observer, "stale_replay");
      /*
       * §7.4's second echo, ARTIFACT-LEVEL: *"a wrong window applies to every row
       * the document carries"*, so it discards here — where the whole of an
       * observer's assigned share falls — rather than gapping a row inside the
       * gate below.
       *
       * Ordered BELOW `stale_replay` deliberately, and the argument is the one
       * this docblock already makes for `no_artifact` sitting above it. When both
       * are wrong, the id is the narrower and more actionable fact: a replaying
       * session returns last sweep's answer entire and last sweep's window comes
       * with it, so the window fault is a consequence rather than a second
       * finding, and the operator's next move is decided by the id.
       */
      if (badWindow(observer)) return blank(service, env.name, observer, "stale_window");

      const held = keyedRows.get(key)?.rows;
      if (held === undefined) return blank(service, env.name, observer, "unreported");
      if (held.length > 1) return blank(service, env.name, observer, "duplicate_rows");
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
      if (named(row.observer) && row.observer !== observer) {
        misattributed.push(censusLabel(env.name, service, coverage.declared.length));
      }

      /*
       * Read AFTER the gate has been computed and never as an input to it —
       * `ServiceAssessment.note`'s docblock states the rule and this is the line
       * that keeps it: `evidenceGaps(row)` above is handed the row and reads four
       * structured fields, and widening it to consult prose would let a worker
       * clear its own downgrade by writing a paragraph.
       */
      const note = rowNote(row);

      const gaps = evidenceGaps(row);
      if (row.assessment === "healthy" && gaps.length > 0) {
        return {
          service,
          environment: env.name,
          assessment: "indeterminate",
          reason: "unevidenced_healthy",
          observer,
          claimed: "healthy",
          gaps,
          evidence_ref: firstEvidenceRef(row),
          note,
        };
      }

      return {
        service,
        environment: env.name,
        assessment: row.assessment,
        reason: "observed",
        observer,
        claimed: row.assessment,
        gaps,
        evidence_ref: firstEvidenceRef(row),
        note,
      };
    }),
  );

  return {
    sweep_id: dispatchedSweepId,
    services,
    stale_replay: staleReplay,
    stale_window: observersStaleWindow,
    census: {
      observers_total: dispatched.size,
      observers_reported: observersReported,
      observers_missing: observersMissing,
      observers_stale: observersStale,
      observers_stale_window: observersStaleWindow,
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
 * The one spelling of an (environment, service) pair — SRD-TRIAGE-MIXED-OBSERVERS
 * D21, task 4.1b.
 *
 * Every internal `Map` in {@link assessTriageSweep} keys on this, and
 * `triage-pass.ts`'s `noteFor` map keys on it too, so a service's note and its
 * verdict can never disagree about which pair they mean by spelling it
 * differently. Not exposed to an operator directly — {@link censusLabel} is
 * that spelling, and the two agree only when `declared` names more than one
 * environment.
 */
export function environmentServiceKey(environment: string, service: string): string {
  return `${environment}/${service}`;
}

/**
 * One census entry's spelling — SRD-TRIAGE-MIXED-OBSERVERS D21, task 4.1b.
 *
 * Bare when `declared` holds exactly one environment: there is only one legal
 * meaning a bare name could have, so every single-environment fixture this
 * module already had reads byte-identical to what it asserted before this
 * task. `environment/service` — {@link environmentServiceKey}'s own spelling —
 * otherwise, because a document covering more than one environment has a real
 * ambiguity a bare name would put back.
 */
function censusLabel(environment: string, service: string, declaredEnvironments: number): string {
  return declaredEnvironments === 1 ? service : environmentServiceKey(environment, service);
}

/**
 * The environment ONE row is about, resolved — SRD-TRIAGE-MIXED-OBSERVERS D21,
 * task 4.1b; widened for the silent row in a multi-environment sweep, so a
 * collator that leaves out the `environment` its brief asks for has a
 * host-side backstop rather than a single point of failure.
 *
 * `row.environment`, verbatim, whenever the worker named one — WHETHER OR NOT
 * `declared` contains it. Resolution and declaration are separate questions,
 * on the same argument this function's caller already makes for `row.service`:
 * a row naming an environment `declared` does not hold is still a row the host
 * can identify, so it is named in `census.undeclared_rows` as
 * `environment/service` rather than dropped into the bare, unkeyable pile —
 * see {@link assessTriageSweep}'s own undeclared-row handling for where that
 * distinction is spent.
 *
 * A sweep over exactly one environment has exactly one legal answer, so a
 * silent row resolves to it and every existing single-environment document
 * keeps parsing exactly as it did before this task.
 *
 * **Otherwise, a silent row asks the same question of its own service name
 * that `declared.length === 1` already answers for the whole sweep**: how
 * many legal answers are there. `declared.length === 1` is the case where the
 * SWEEP has exactly one; this is the case where the ROW's own `service` does —
 * exactly one declared environment lists it among its `services`. Both are the
 * same shape of fact (one candidate, so no guess is required) and both are
 * trusted for the same reason. A service declared nowhere, or under two
 * environments at once — the tracked `triage/targets.yaml`'s `grafana` and
 * `prometheus`, each declared under both `do-cluster` and `docker-host` — has
 * zero or several candidates, which is exactly the shape `null` already means:
 * no single legal guess, so none is made. Those two stay unplaced under either
 * environment, precisely as they did before this widening.
 *
 * `row.observer` — the WORKER's own claim of who produced the row — is never
 * read here, on the document schema's own rule for that field: *"Recorded,
 * never trusted."* Only `declared`, the host's own inventory, and `row.service`,
 * the one fact a silent row does carry, decide the answer.
 *
 * `null` when neither a named environment nor a unique service-name owner
 * exists — more than one candidate, or none, so there is no single legal
 * guess, which is the row's own docblock's *"never guessed"*.
 */
function resolveRowEnvironment(
  row: TriageRow,
  declared: readonly DeclaredEnvironment[],
): string | null {
  if (named(row.environment)) return row.environment as string;
  if (declared.length === 1) return (declared[0] as DeclaredEnvironment).name;
  const owners = declared.filter((environment) => environment.services.includes(row.service));
  return owners.length === 1 ? (owners[0] as DeclaredEnvironment).name : null;
}

/**
 * The environment ONE assignment belongs to — SRD-TRIAGE-MIXED-OBSERVERS D21,
 * task 4.1b.
 *
 * A {@link PartitionAssignment} carries no environment of its own —
 * `checkTriagePartition` scopes assignments to one kind's own declared set
 * (task 4.1), so the fact lives on the WORKER, through {@link seatKind}, and is
 * recovered here by matching that kind against `declared`'s own. `declared`
 * holding exactly one environment is the same escape hatch
 * {@link resolveRowEnvironment} takes, for the same reason — today's
 * single-environment fixtures and callers stay valid whatever worker id they
 * used, because there is only one legal answer to give any of them.
 *
 * `null` when `declared` names more than one environment and the worker's
 * kind matches none of them — an unrecognised worker, or a kind no declared
 * environment carries. Such an assignment is folded into NO environment's
 * `assignedTo`, so its services stay `unassigned` everywhere, the same total
 * answer {@link blank}'s `"unassigned"` arm already gives a service no
 * assignment reached at all.
 */
function resolveAssignmentEnvironment(
  assignment: PartitionAssignment,
  declared: readonly DeclaredEnvironment[],
): string | null {
  if (declared.length === 1) return (declared[0] as DeclaredEnvironment).name;
  const kind = seatKind(assignment.worker);
  if (kind === null) return null;
  return declared.find((e) => e.kind === kind)?.name ?? null;
}

/**
 * A service the host could not get an answer for.
 *
 * `indeterminate` and never `healthy` — SRD-OBSERVER-001 §9.2, and §6.5 says it
 * for this exact case. `claimed` is `null` rather than the row's value: there was
 * no row the host was willing to read, and carrying one here would put a claim
 * the host rejected into the field a log line prints.
 *
 * `evidence_ref` is `null` for the same reason and it is the same sentence: a
 * discarded artifact's ledger is not a citation. A `stale_replay` row that
 * carried last sweep's `evidence_ref` forward would hand the incident machine a
 * reference to the very file the host has just refused to read.
 *
 * **`note` is `null` on the same argument and it is the sharpest instance of it**
 * (§13 task 5.8). The prose is what an operator's phone shows; a `no_artifact` or
 * `stale_replay` announcement carrying a sentence out of a document the host
 * refused would read as an observation of a service nobody observed, which is the
 * absence-as-evidence mistake delivered out of band with nothing to review.
 */
function blank(
  service: string,
  environment: string,
  observer: string | null,
  reason: Exclude<AssessmentReason, "observed" | "unevidenced_healthy">,
): ServiceAssessment {
  return {
    service,
    environment,
    assessment: "indeterminate",
    reason,
    observer,
    claimed: null,
    gaps: [],
    evidence_ref: null,
    note: null,
  };
}

/**
 * A row's note, normalised to the two values {@link ServiceAssessment.note} has.
 *
 * Three inputs collapse to `null` and they are deliberately not distinguished:
 * the key was absent (`undefined`, which only a hand-built row can be — the schema
 * defaults it), it was written as JSON `null`, or it was written as whitespace.
 * The last is {@link named}'s rule applied to prose for the same reason it applies
 * to a ledger entry: *"a citation defeatable with a space bar is not a citation"*,
 * and a note of three spaces produces a fenced block containing one empty line —
 * a banner around nothing, which `fenceEvidence` already refuses to emit and
 * which this stops arriving at its door.
 *
 * The note is otherwise passed through UNCHANGED — not trimmed, not flattened,
 * not truncated. Every one of those is `fenceEvidence`'s job, and doing any of
 * them twice in two modules is how the two copies come to disagree.
 */
function rowNote(row: TriageRow): string | null {
  const note = row.note;
  if (note === undefined || note === null) return null;
  return note.trim() === "" ? null : note;
}

// ───────────────────────────────────────────────────────────────────────────
// §6.7 rule 3, D15, §9.16 — the saturation verdict (§13 task 5.3a)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The inference endpoint a saturation announcement is ABOUT.
 *
 * Two fields rather than one string, because ISC-681 grades the announcement on
 * naming *"the PROVIDER as its subject and the environment only as scope"*, and a
 * pre-joined string is a thing a caller can assemble the wrong way round once and
 * then never notice. {@link inferenceSubject} is the one join site.
 */
export interface InferenceEndpoint {
  /** `llm.providers.<name>` — `omlx` on this fleet (`fleet.yaml:113-140`). */
  readonly provider: string;
  /** The model every seat resolves to — `gpt-oss-20b-MXFP4-Q8`. */
  readonly model: string;
}

/**
 * §6.7 rule 3's *"the provider and model"*, as one token.
 *
 * `provider/model`, which is the shape ISC-681 already asserts by full value on
 * the composed title (`ollama-cloud/qwen3-coder:480b`). It is a function rather
 * than an inline template so that the two halves cannot be swapped in one place
 * and not the other.
 */
export function inferenceSubject(endpoint: InferenceEndpoint): string {
  return `${endpoint.provider}/${endpoint.model}`;
}

/**
 * §6.7 rule 3's confirming probe, as a dep.
 *
 * **It has no default anywhere, and that is the load-bearing half of the design
 * rather than a testing convenience.** `probeNativeToolCalls` removed its own
 * `fetchImpl` default for exactly this reason (ISC-260): *"Leaving it would leave
 * the host-side probe one omitted argument away, in a gate whose entire value is
 * that it tests the path the workers actually use."* Here the stake is the mirror
 * one — a default would leave every fixture in the suite one omitted argument
 * away from a real POST to the operator's own inference server, 288 times a day
 * in CI. So {@link saturationVerdict} takes it as a required parameter, and
 * `saturationVerdict.length` is asserted in the suite: a default would drop the
 * arity and redden.
 *
 * Zero-argument, so the base URL, the key, the model and the timeout are all
 * closed over by whoever built it — see {@link inferenceSaturationProbe}. A probe
 * that took the endpoint as an argument would be a second place the dial target
 * is decided, which is the drift `hostReachableBaseUrl` exists to end.
 */
export type SaturationProbe = () => Promise<ToolCallProbeResult>;

/**
 * §6.7 rule 3's correlation threshold — *"**Two or more** observers producing no
 * artifact in one sweep"*.
 *
 * Exported so a fixture can name it, and so the sentence has one home. The
 * argument for the number is in the section: *"A cluster fault does not arrive at
 * three independent observers in the same sweep; a shared dependency does, and the
 * only dependency all three share is the inference server."* One observer silent
 * is a worker; two is what they have in common.
 */
export const SATURATION_MIN_MISSING = 2;

/**
 * What one sweep concluded about the inference endpoint. Closed, and asserted by
 * name — `test/unit/monitor-readonly.test.ts:363-369`'s rule.
 *
 * Five members for three behaviours, and the extra two are named rather than
 * hidden for {@link sweepIdEcho}'s reason: they arrive from different faults and
 * a log line should be able to say which.
 *
 * | verdict | reached when | `saturated` | `unreachable` | suppresses |
 * |---|---|---|---|---|
 * | `clear` | every dispatched observer produced an artifact, and at least one was dispatched | `false` | `false` | no |
 * | `uncorrelated` | some observer produced nothing, but fewer than {@link SATURATION_MIN_MISSING} | `null` | `null` | no |
 * | `saturated` | correlated, and the probe answered `timeout` | `true` | `null` | **yes** |
 * | `endpoint_down` | correlated, and the probe answered `unreachable` | `null` | `true` | **yes** |
 * | `unconfirmed` | correlated and the probe settled neither way — or nothing was dispatched at all | `null` | `null` | no |
 *
 * **The middle two columns of that table are PROSE, and {@link SATURATION_PAIR}
 * is the code.** They are written here because a reader of the enum needs them,
 * and the probe that forbids a second spelling reads comment-stripped source for
 * exactly this reason — ISC-867's first version reddened on five truthful
 * docblocks, and this one would have reddened on this paragraph.
 */
export const SATURATION_VERDICTS = [
  "clear",
  "uncorrelated",
  "saturated",
  "endpoint_down",
  "unconfirmed",
] as const;
export type SaturationVerdict = (typeof SATURATION_VERDICTS)[number];

/** §6.8a's two independent facts about the inference endpoint, for one verdict. */
export interface SaturationPair {
  /**
   * *"Is the provider keeping up"* — §6.8a's `ConsoleHealthFacts.saturated`.
   * `null` is not `false`, and ISC-675 is the criterion that says so.
   */
  readonly saturated: boolean | null;
  /**
   * *"Is it there at all"* — §6.8a's `ConsoleHealthFacts.unreachable`, the
   * seventh kind's fact. `null` is not `false` for the same reason.
   */
  readonly unreachable: boolean | null;
}

/**
 * The `(saturated, unreachable)` pair each verdict hands §6.8a's composer.
 * **ONE table**, and §13 task 6.4b consolidated it here out of two.
 *
 * ## What it replaced, and why a third assertion was the wrong fix
 *
 * The `unreachable` column lived in `triage-pass.ts` as a `switch` inside
 * `unreachableFrom`, and the whole pair lived a second time as a `Record`
 * literal inside a `describe` in `test/unit/triage-incident.test.ts` — two copies
 * that agreed until the day one of them was edited, with nothing pinning them
 * equal. ISC-869 filed that as ISC-804's shape one file over, and as the THIRD
 * instance on this branch after `CONSOLE_HEALTH_ASSESSMENTS` and the duplicated
 * `sweepTaskId` (ISC-867).
 *
 * A test asserting the two copies agree would have been a THIRD place the
 * mapping is written, and it buys nothing: two copies and an assertion still
 * drift together the moment an editor obliges the assertion by changing both.
 * So both readers DERIVE from this literal instead — {@link saturationVerdict}
 * takes `saturated` from it, and `unreachableFrom` takes `unreachable` from it —
 * and the property that buys is a mutation one: **change one cell here and the
 * pass's behaviour tests and the incident composer's table test both redden.**
 * If only one side moves, the consolidation did not happen.
 *
 * ## `Record<SaturationVerdict, …>` is the exhaustiveness guard, and it MOVED here
 *
 * `unreachableFrom` used to end in a `never` binding after its switch, which is
 * ISC-862's *"a sixth member is a `tsc` error rather than a silent `null`"*. The
 * guard is not weaker for moving: a sixth member of {@link SATURATION_VERDICTS}
 * is a `tsc --noEmit` error on THIS literal, which is the technique the incident
 * suite's table already used (ISC-731's). What changed is that it is now one
 * error at the one place the answer is written, rather than one error per reader
 * — and a reader that forgot its own `never` binding would have answered `null`
 * forever.
 *
 * ## The two columns are INDEPENDENT questions
 *
 * `saturated` says nothing about reachability: the probe TIMED OUT, which is
 * evidence about speed. `endpoint_down` says nothing about speed: the probe could
 * not connect. Only `clear` answers both, because §6.8a's one clearing fact —
 * *"a sweep in which every observer produced an artifact"* — is positive evidence
 * the endpoint was both up and keeping up. Returning `false` anywhere else would
 * recover an incident on the strength of a request that never came back, which is
 * ISC-675's absence-as-evidence mistake wearing a different fault as a disguise.
 *
 * A table whose two columns never disagreed would satisfy every assertion
 * downstream against a composer that read one field for both kinds, so the
 * `saturated`/`endpoint_down` rows disagreeing is graded as a PREMISE rather than
 * left to inspection — this branch's most expensive recorded lesson, that a
 * degenerate fixture hides a narrowing.
 */
export const SATURATION_PAIR: Readonly<Record<SaturationVerdict, SaturationPair>> = {
  // Every dispatched observer produced an artifact — §6.8a's ONLY clearing fact,
  // and it clears both halves because it is positive evidence the endpoint was
  // both up and keeping up.
  clear: { saturated: false, unreachable: false },
  uncorrelated: { saturated: null, unreachable: null },
  // The probe timed out: the endpoint is SLOW. It says nothing about reachable.
  saturated: { saturated: true, unreachable: null },
  // The probe could not connect: the endpoint is DOWN. It says nothing about slow.
  endpoint_down: { saturated: null, unreachable: true },
  unconfirmed: { saturated: null, unreachable: null },
};

/**
 * One sweep's saturation finding.
 *
 * ## `saturated` is `boolean | null` and the `null` is the point
 *
 * It is the field §6.8a's `ConsoleHealthFacts` takes, and §6.8a states the rule
 * this shape exists to keep: *"**`saturated: null` is not `saturated: false`.** A
 * sweep that could not tell says nothing about `inference_saturated`; only a sweep
 * that positively observed every observer producing an artifact clears it"*
 * (ISC-675). So `false` is reachable from `clear` and from nothing else — an
 * `endpoint_down` is emphatically not a clean sweep, and reporting it as one would
 * compose a RECOVERY for a saturation incident out of an outage.
 *
 * ## `saturated: true` is NOT `suppressed`, and they are separate fields on purpose
 *
 * `endpoint_down` suppresses and does not set `saturated`. The two questions are
 * different: *"is the provider saturated"* decides what the operator is TOLD, and
 * *"did this sweep learn anything about the cluster"* decides what the coverage
 * escalation is allowed to conclude. When the probe says the endpoint is
 * unreachable, the answer to the first is *"no — it is down"* and the answer to
 * the second is *"nothing"*, and collapsing them into one boolean forces a choice
 * between announcing a saturation that is not happening and pointing the operator
 * at their cluster over a process on their own machine. §6.7 rule 3's own words
 * for why the two probe classes are kept apart: *"a different sentence on the
 * operator's screen and a different thing for them to go and do."*
 *
 * **The residue, stated rather than discovered.** §6.8a's `kind` is a closed
 * six-member enum with no `inference_unreachable` in it, so an `endpoint_down`
 * sweep composes no announcement of its own from Phase 5. In the case that
 * actually occurs — an endpoint that is down produces no artifact from ANY
 * observer — §6.5's zero-row raises `sweep_produced_nothing` for the environment
 * and the console does speak. The uncovered case is the partial one, and it is one
 * cadence long: the next sweep has nothing at all.
 *
 * **Updated 2026-09-06.** This said *"Recorded for task 6.1"*, and 6.1 shipped
 * without it — the seventh `kind` (`inference_unreachable`) was ruled in AFTER
 * that task was complete, so no task owned the wiring. It is task 5.4e now, and
 * ISC-824 is filed OPEN against it: the enum member and its observation exist and
 * are green, and nothing computes the pair, so the case is still silent in
 * production. A pointer to a finished task is worse than no pointer.
 */
export interface SaturationOutcome {
  readonly verdict: SaturationVerdict;
  /** §6.8a's `ConsoleHealthFacts.saturated`, and `null` is not `false`. */
  readonly saturated: boolean | null;
  /** Whether the coverage escalation is stopped for this sweep. §6.7 rule 3's ordering. */
  readonly suppressed: boolean;
  /** §6.7 rule 3's announcement subject — the provider and model, never the environment. */
  readonly subject: string;
  /**
   * The observers that produced no artifact at all, by name — the correlation
   * itself, published so a log line can name what was correlated.
   *
   * `SweepCensus.observers_missing` verbatim. **Not** `observers_stale` and not
   * `observers_total − observers_reported`: a stale or out-of-window artifact is
   * an artifact, which means that observer got an answer out of the model, which
   * is evidence AGAINST saturation rather than for it.
   */
  readonly correlated: readonly string[];
  /**
   * The confirming probe's own result, or `null` when it was not run.
   *
   * `null` is how a reader tells the two `unconfirmed` roads apart — a sweep that
   * dispatched nobody never asked, while a correlated sweep asked and got an
   * answer that settled neither way.
   */
  readonly probe: ToolCallProbeResult | null;
}

/**
 * §6.7 rule 3 and D15 — is the inference endpoint saturated, or is this a
 * coverage gap?
 *
 * ## The correlation, and why it is a statement about what observers SHARE
 *
 * §6.7: *"A cluster fault does not arrive at three independent observers in the
 * same sweep; a shared dependency does, and the only dependency all three share is
 * the inference server. **Two or more observers producing no artifact in one sweep
 * is a statement about what they have in common**, and what they have in common is
 * not the environment."*
 *
 * So the input is a count of OBSERVERS, never of services and never of
 * indeterminate assessments — and the difference is the whole task. One observer
 * holding three services and stalling makes three services `indeterminate` and is
 * not saturation; two observers holding one service each and stalling makes two
 * services `indeterminate` and is. A rule written over the service verdicts cannot
 * tell those apart, would saturate on every sweep with two blind services, and
 * would pass every positive fixture in §12 while failing the one that matters.
 *
 * ## The probe runs ONCE PER CANDIDATE and never per sweep
 *
 * §6.7's own words. This is not an optimisation: the resource being probed is the
 * one the console is accused of starving (§6.10 — *"the first thing in this fleet
 * that can starve the fleet's own inference server around the clock"*), and a
 * console that added a completion request to all 288 sweeps a day would be
 * manufacturing the condition it exists to report. So the correlation gate is
 * evaluated first and the probe is not called at all unless it fires; the suite
 * asserts the call count on the negative fixtures rather than only on the positive
 * one.
 *
 * ## The two failure classes are kept apart, because the operator's next move differs
 *
 * `probeNativeToolCalls`'s own docblock: *"A timeout is NOT 'unreachable', and
 * conflating them is a misdiagnosis this project has the incident report for
 * (S1)."* §6.7 spends that distinction directly — *"A `timeout` verdict is
 * saturation. An `unreachable` verdict is the server being down, which is a
 * different sentence on the operator's screen and a different thing for them to go
 * and do."* Every other probe class (`prose`, `model-not-found`, `malformed`,
 * `inconclusive`, and success) is `unconfirmed`: the correlation is real and the
 * probe did not settle it, which is a third thing and not a licence to guess.
 *
 * **A successful probe is `unconfirmed` rather than `clear`.** The endpoint
 * answering one small completion promptly, seconds after the sweep ended, is not
 * evidence that it was answering during the sweep — and `clear` is the value that
 * CLEARS an `inference_saturated` incident. §6.8a reserves that for *"a sweep in
 * which every observer produced an artifact"*, which is a fact about the sweep and
 * not about the probe.
 *
 * ## Throwing
 *
 * The probe is documented to never throw (`model-probe.ts:206-210`), so a
 * rejection is a broken injected dep — a host argument that is wrong for the life
 * of the run — and this module's rule for that class is a throw. It propagates to
 * task 6.1's pass, which catches and continues (`relay.ts:700-723`). Swallowing it
 * here would make a permanently broken probe indistinguishable from an endpoint
 * that is merely healthy.
 */
export async function saturationVerdict(
  assessment: SweepAssessment,
  endpoint: InferenceEndpoint,
  probe: SaturationProbe,
): Promise<SaturationOutcome> {
  const subject = inferenceSubject(endpoint);
  const correlated = assessment.census.observers_missing;
  const dispatched = assessment.census.observers_total;

  /**
   * The verdict decides; `saturated` is LOOKED UP rather than passed.
   *
   * §13 task 6.4b. It was a parameter beside `verdict` until this task, which
   * made every call site a place the mapping is written and made
   * `(verdict, saturated)` a pair a future edit could set inconsistently — the
   * defect ISC-869 was filed against, one function in. {@link SATURATION_PAIR}
   * is now the only place the answer exists, so the five settlements below
   * choose a verdict and nothing else.
   */
  const settle = (
    verdict: SaturationVerdict,
    suppressed: boolean,
    result: ToolCallProbeResult | null,
  ): SaturationOutcome => ({
    verdict,
    saturated: SATURATION_PAIR[verdict].saturated,
    suppressed,
    subject,
    correlated,
    probe: result,
  });

  /*
   * A sweep that dispatched nobody learned nothing, and `clear` below would
   * otherwise be reachable from an empty set — `observers_missing` is empty when
   * three observers all replied AND when there were never any observers, and
   * only the first of those is §6.8a's *"a sweep in which every observer produced
   * an artifact"*. `checkTriagePartition` refuses an empty partition before
   * dispatch, so this is unreachable through the console's own path; it is
   * answered rather than assumed away because clearing a saturation incident out
   * of an absence is the exact shape ISC-675 is filed against.
   */
  if (dispatched === 0) return settle("unconfirmed", false, null);

  if (correlated.length === 0) return settle("clear", false, null);
  if (correlated.length < SATURATION_MIN_MISSING) {
    return settle("uncorrelated", false, null);
  }

  const result = await probe();
  if (result.failure === "timeout") return settle("saturated", true, result);
  if (result.failure === "unreachable") return settle("endpoint_down", true, result);
  return settle("unconfirmed", false, result);
}

/**
 * §6.7 rule 3's confirming probe, wired to the two functions §13 names.
 *
 * *"`probeNativeToolCalls` (`src/security/model-probe.ts:230`), run host-side
 * against `hostReachableBaseUrl` (`:603`)"* — and this is the only place in the
 * console where those two meet, so a reader checking that §13's sentence is true
 * of the code has one function to read.
 *
 * **`fetchImpl` is required here for the reason it is required there**, and it is
 * the second fence rather than a repetition of the first: with no default on this
 * parameter and no default on {@link saturationVerdict}'s probe, there is no path
 * from this module to the network that does not pass through a value a caller
 * handed it. The suite reads this file's own source, strips its comments and
 * asserts that no unqualified call to the global `fetch` survives, so the fence is
 * graded rather than promised. (Comments are stripped rather than matched around
 * because a docblock that QUOTES the pattern reddens the probe — which this one
 * did, on its first run.)
 *
 * `hostReachableBaseUrl` is right and `llm.base_url` would be wrong: this probe
 * runs on the HOST, in the actor's process, and `base_url` is documented as what a
 * WORKER dials — on the shipped default it names the relay's bridge alias, which
 * the host cannot resolve at all (ISC-291). A probe that dialled it would report
 * the endpoint unreachable on a healthy machine and turn every saturation
 * candidate into an `endpoint_down`.
 */
export function inferenceSaturationProbe(
  config: HostDialConfigView,
  apiKey: string,
  model: string,
  fetchImpl: FetchLike,
  timeoutMs?: number,
): SaturationProbe {
  const baseUrl = hostReachableBaseUrl(config);
  return () => probeNativeToolCalls(baseUrl, apiKey, model, fetchImpl, timeoutMs);
}

/**
 * What one sweep's service observations need that the assessment does not
 * carry.
 *
 * **No `environment` field — SRD-TRIAGE-MIXED-OBSERVERS D21, task 4.1b
 * retired it.** §6.8's `(environment, service)` key now comes entirely off
 * each {@link ServiceAssessment.environment}, one sweep of which can name more
 * than one environment; a single flat value here would have been wrong for
 * every service but the first environment's. {@link sweepObservations} reads
 * it per service instead.
 */
export interface SweepObservationContext {
  /** Epoch milliseconds. A PARAMETER — Phase 5 has no clock. */
  readonly at: number;
  /**
   * The SWEEP's own artifact — `triage.json` — as the FALLBACK citation, and no
   * longer the only one (§13 task 5.3e).
   *
   * The primary citation is now the row's
   * ({@link ServiceAssessment.evidence_ref}); this value is what an `issue` falls
   * back to when the observer's row named no evidence of its own. That case is
   * ordinary rather than exceptional — §6.7 rule 2's gate applies to `healthy`
   * alone, so a `degraded` row with an empty ledger is perfectly legal — and the
   * collation document is the one artifact the host knows exists for it. Dropping
   * the fallback would spend a real citation to gain nothing:
   * `IncidentSignal["issue"].evidenceRef` is nullable, so the alternative is not
   * a stricter type, it is an operator handed `null`.
   *
   * **A clear NEVER falls back to it**, and that asymmetry is the task's whole
   * point — see {@link serviceSignal}.
   */
  readonly evidenceRef: string;
}

/**
 * One sweep's per-service readings, as {@link IncidentObservation}s — the service
 * twin of `consoleHealthObservations`, and **the suppression's only home**.
 *
 * ## The ordering is structural, which is what §13 asks for
 *
 * §13 task 5.3a: *"**Write the suppression before the verdict** — a saturation
 * verdict that does not stop `consecutive_indeterminate` advancing is a console
 * that reports both findings and lets the operator pick the wrong one."*
 *
 * A caller cannot obey that by discipline here, because there is nothing to be
 * disciplined about: {@link SaturationOutcome} is a **required parameter**, so the
 * verdict has already been computed by the time a service signal exists, and the
 * suppression is the first branch in the body. This is `triage-partition.ts`'s
 * move — it *"made 'nothing was dispatched' a property of the code by taking the
 * dispatch effect as a parameter, so ordering stopped being caller discipline"* —
 * and `assessTriageSweep`'s: *"there is no exported path that hands a caller the
 * worker's raw `healthy`"*. There is likewise no exported path that hands a caller
 * an unsuppressed signal.
 *
 * ## What `suppressed` does downstream, and why it is EVERY service
 *
 * `advanceIncident` answers `{kind: "suppressed"}` by returning the caller's own
 * record — *"no counter, no timestamp, and not the `renotify_after` floor
 * either"*. §6.7 rule 3's requirement is narrower than that (*"a service's
 * `consecutive_indeterminate` counter does not advance"*) and the machine's own
 * docblock argues the stricter reading; this function supplies it uniformly rather
 * than per service, because *"a sweep in which the inference server was the fault
 * carries no information about the cluster"* is a statement about the sweep. A
 * version that suppressed only the blind rows would let a `healthy` observed by
 * the one seat that did get through CLEAR a firing incident on a sweep the console
 * has just declared it could not see — a recovery composed on one third of the
 * evidence, which is §6.8's *"single most damaging message this console could
 * send"*.
 *
 * ## The mapping, for the unsuppressed case
 *
 * | assessment | signal | cites |
 * |---|---|---|
 * | `healthy` | `observed_clear` — post-gate, so §6.7 rule 2 has already run | the ROW's ref, always |
 * | `degraded`, `unhealthy` | `issue`, carrying that word as the reason | the row's ref, else the sweep's |
 * | `indeterminate` | `unobserved` | nothing — it carries no ref |
 *
 * The `healthy` row is the gated one by construction: {@link ServiceAssessment}
 * has no field carrying the worker's raw verdict into `assessment`, and an
 * unevidenced `healthy` arrives here already downgraded to `indeterminate` with
 * `reason: "unevidenced_healthy"`. That is what makes §12's *"assert it does
 * **not** clear a firing incident"* true without this function knowing the rule.
 *
 * `coverage` is deliberately unreachable from here: it is minted by
 * `advanceIncident` alone, because the threshold is a property of a record that
 * spans sweeps. A verdict module that could pass it in would be a second place the
 * escalation is decided.
 */
export function sweepObservations(
  assessment: SweepAssessment,
  saturation: SaturationOutcome,
  context: SweepObservationContext,
): readonly IncidentObservation[] {
  return assessment.services.map((service) => ({
    subject: {
      kind: "service" as const,
      environment: service.environment,
      service: service.service,
    },
    sweepId: assessment.sweep_id,
    at: context.at,
    signal: saturation.suppressed
      ? ({ kind: "suppressed" } as const)
      : serviceSignal(service, context.evidenceRef),
  }));
}

/**
 * The unsuppressed half of {@link sweepObservations}'s table — §13 task 5.3e.
 *
 * ## The citation is the ROW's, because §6.8 asks about ONE incident
 *
 * *"the evidence that closed it"* — singular. A sweep-level ref answers a
 * different question: it names the document that collated every service, so an
 * operator following a recovery on `authorization` arrives at `triage.json` and
 * still has to find the observation inside it. {@link ServiceAssessment} now
 * carries the row's own, and a recovery cites that.
 *
 * ## A `healthy` with no citation is BLINDNESS, and this is a SECOND fence
 *
 * §6.7 rule 2 already downgrades an unevidenced `healthy` to `indeterminate`
 * inside `assessTriageSweep`, so — today — a `healthy` reaching this line has a
 * non-empty ledger by construction and the `null` arm below is unreachable. It is
 * written anyway, and it is not defensive clutter:
 *
 *  - **The type cannot say it.** `IncidentSignal["observed_clear"].evidenceRef`
 *    is a required `string` (ISC-714), and {@link ServiceAssessment.evidence_ref}
 *    is `string | null`. Something must bridge those, and there are exactly two
 *    bridges: refuse, or substitute. Substituting the sweep's ref is the one
 *    thing this task must not do — it would turn a `null` row citation into a
 *    well-formed clear, which is *"a way to construct an evidence-free clear"*
 *    wearing the collation document as a disguise.
 *  - **It holds when the first fence moves.** Delete the `ledger` member from
 *    {@link EVIDENCE_GAPS} and an unevidenced `healthy` walks through
 *    `assessTriageSweep` — and arrives here with `evidence_ref: null` and is
 *    answered as `unobserved` rather than clearing a firing incident. ISC-739's
 *    claim (*"an unevidenced `healthy` reaches the incident machine as blindness,
 *    never as a clear"*) stops depending on one branch in another function.
 *
 * `unobserved` is the right refusal rather than a lesser signal because it is
 * already what this module says when it declines a claim: *"I could not see
 * enough to tell you"*. A `healthy` naming no evidence is precisely that.
 *
 * ## An `issue` DOES fall back, and the asymmetry is the consequence, not a mood
 *
 * `observed_clear` is the message §6.8 calls *"the single most damaging message
 * this console could send"* when it is wrong, and it moves a record toward
 * `clear` on its own. An `issue` is confirmable and *"never notifies on its
 * own"*, and its `evidenceRef` is typed `string | null` for that reason. So the
 * evidence bar differs because the consequence differs, and the fallback costs
 * nothing a clear would have paid for.
 */
function serviceSignal(service: ServiceAssessment, sweepRef: string): IncidentSignal {
  const { assessment, evidence_ref: ref } = service;
  if (assessment === "indeterminate") return { kind: "unobserved" };
  if (assessment === "healthy") {
    return ref === null ? { kind: "unobserved" } : { kind: "observed_clear", evidenceRef: ref };
  }
  return {
    kind: "issue",
    reason: assessment satisfies ObservedIssueReason,
    evidenceRef: ref ?? sweepRef,
  };
}
