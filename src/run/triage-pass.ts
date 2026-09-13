/**
 * The pass — SRD-TRIAGE-CONSOLE §6.3, §6.4, §6.5, §6.7, §6.8a; §13 task 6.1.
 *
 * One function: read the run tree, decide tick-or-skip, perform the fan-out,
 * drive the incident machine, emit. §6.4's decision in one sentence — *"a
 * host-side actor … that is both the console's clock and its fan-out
 * performer"*, whose *"pass is exported and `--once` runs exactly one; the loop
 * is a `setTimeout` wrapper"*.
 *
 * ## This module is the CALLER Phase 5 was built for, and it composes rather than decides
 *
 * `checkTriagePartition`, `assessTriageSweep`, `saturationVerdict`,
 * `sweepObservations`, `consoleHealthObservations`, `advanceIncident` and
 * `reportSweep` each shipped with no production caller. Every one of them is
 * invoked below exactly once, and **nothing they decide is decided again here**:
 * there is no second coverage count, no second evidence gate, no second
 * transition table and no second observation mapper. §13 names that hazard for
 * this task in particular — *"`sweepObservations` … is the service-observation
 * mapper. Do not write a second one."*
 *
 * What IS this module's own is the ORDER, and §12 grades three orderings:
 *
 *  1. **Validate the whole partition before dispatching any of it** (§6.5). Not
 *     caller discipline: `dispatchPartition` takes the dispatch effect as a
 *     parameter, so a refusal cannot arrive after the reads it was meant to
 *     prevent.
 *  2. **Saturation is evaluated before the coverage escalation and suppresses
 *     it** (§6.7 rule 3). Also not discipline: `sweepObservations` takes the
 *     `SaturationOutcome` as a required parameter, so the verdict exists before
 *     any service signal does.
 *  3. **The record is written before the transport is called** (§6.9 requirement
 *     7, ISC-706). This one IS this module's, because only this module writes the
 *     sequence — which is precisely why §13 widened the task to own
 *     `saveIncidentRecord`.
 *
 * ## Two fences against the outside world, and both are REQUIRED deps
 *
 * `probe` and `transport` have no defaults anywhere on this path.
 * `saturationVerdict` removed the default from its probe because *"a default
 * would leave every fixture in the suite one omitted argument away from a real
 * POST to the operator's own inference server"*, and the notifier's shipped
 * default endpoint is the operator's live `https://ntfy.agileguy.ca/Alerts`. A
 * pass that defaulted either would reach a real service from CI, 288 times a day
 * in the one case and on every announcement in the other. So both are fields of
 * {@link TriagePassDeps} with no fallback, and a fixture that forgets one does
 * not compile.
 *
 * The disk is the third: {@link IncidentStore} is required for the same reason —
 * `saveIncidentRecord`'s default writes under `~/.pifleet/triage/`, which is
 * keyed off `$HOME` rather than off the checkout.
 *
 * ## The confirming probe is deduplicated ACROSS sweeps, and that is this task's half
 *
 * §6.7 wants the probe *"once per saturation candidate and never per sweep"*.
 * `saturationVerdict` supplies the within-a-sweep half (ISC-730) and cannot
 * supply the other, because Phase 5 has no state that spans sweeps — so twelve
 * consecutive saturated sweeps made twelve probes. {@link SaturationMemo} is the
 * missing state and it is threaded through the pass as a value in and a value
 * out, on the same discipline as the cursor and the delivery state. §6.10 records
 * why this is not an optimisation: this console *"is the first thing in this
 * fleet that can starve the fleet's own inference server around the clock"*, and
 * a console that probed on every saturated sweep would be adding load to the
 * resource it has just concluded is overloaded.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not sleep, retry, or schedule: `runTriageActor` owns the loop and this
 * function owns one pass. It reaches the run tree only through
 * {@link SweepDriver}, so it names no path, no container and no task file — the
 * adapter that does is task 6.2's. And it holds no clock: `now` is a dep, called
 * ONCE per pass so every timestamp a pass writes agrees with every other.
 */
import {
  advanceIncident,
  announcementFacts,
  consoleHealthObservations,
  subjectKey,
  withUndelivered,
  type AnnouncementExtras,
  type ConsoleHealthFacts,
  type IncidentNotification,
  type IncidentObservation,
  type IncidentRecord,
  type IncidentRecordRead,
  type IncidentRecordRefusal,
  type IncidentSubject,
} from "./triage-incident.ts";
import { dispatchPartition, type PartitionAssignment, type PartitionFault } from "./triage-partition.ts";
import {
  orderForDelivery,
  reportSweep,
  reporterUndelivered,
  type AnnouncementFacts,
  type DeliverDeps,
  type DeliveryState,
  type NotifyEnvRead,
  type NotifySignalFor,
  type NotifyTransport,
  type SweepReport,
} from "./triage-notify.ts";
import {
  assessTriageSweep,
  saturationVerdict,
  sweepObservations,
  SATURATION_MIN_MISSING,
  SATURATION_PAIR,
  type InferenceEndpoint,
  type ObserverArtifact,
  type SaturationOutcome,
  type SaturationProbe,
  type SweepAssessment,
  type SweepCoverage,
  type TriageDocument,
  type WindowPolicy,
} from "./triage-verdict.ts";
import { TRIAGE_COLLATOR, type TriageActorCursor } from "./triage-actor.ts";
/*
 * §6.6 layer 2's id, from the ONE module that mints it — and `relay.ts:116-135`
 * wrote the rule naming this file, in advance, as the caller that would be
 * tempted to spell it a second time:
 *
 *   *"names added to `task-ids.ts` after the extraction are imported FROM
 *   `task-ids.ts`"* … *"The next consumer of these names is the triage actor's
 *   pass, a `src/run/` module under SRD-TRIAGE-CONSOLE D7a's read-only import
 *   guard."*
 *
 * This module HAD a second copy, and the two were not equivalent: the canonical
 * one refuses an `n` that is not a safe integer ≥ 1 with a `SweepCounterError`,
 * and the local one minted whatever it was handed. **They agreed on every value
 * this pass can currently produce** — `resumedCursor` floors the counter at the
 * run tree's own non-negative answer, so `number` is always ≥ 1 — so this is a
 * duplication defect rather than a live bug, and it is recorded that way rather
 * than dressed up. What it cost is the freedom to drift: two spellings of the id
 * grammar that the ACTOR mints and `inFlightSweep` reads back, agreeing by
 * coincidence, with no test pinning them equal. `task-ids.ts` imports NOTHING, so
 * taking it costs the read-only closure exactly one leaf.
 */
import { sweepTaskId } from "./task-ids.ts";
import { sweepExpiryS } from "./triage-config.ts";
import type { NotifyConfig, TriageConsoleConfig } from "./triage-config.ts";
import type { ToolCallProbeResult } from "../security/model-probe.ts";

// ---------------------------------------------------------------------------
// The run tree, as a port
// ---------------------------------------------------------------------------

/**
 * A sweep the run tree says is still going — §6.4's *"a sweep whose parent task
 * exists and whose `-collate` task has not settled is in flight"*.
 *
 * `waitingOn` is a separate field from `sweepId` because §12 asks the skip to
 * *"name the in-flight sweep"* and the useful name is the TASK an operator can
 * go and look at, which is the sweep's or its collation's depending on how far
 * it got. Deriving one from the other here would put the task-id grammar in two
 * modules.
 */
export interface InFlightSweep {
  readonly sweepId: string;
  /** The task the actor is waiting on, verbatim, for the skip record and the log. */
  readonly waitingOn: string;
  /**
   * The instant the sweep was dispatched, ISO-8601, or `null` when it cannot be
   * dated — ISC-1168.
   *
   * ## This port reported whether a sweep had SETTLED and never how long it had OWED
   *
   * §6.4's predicate is a pure run-tree read and every branch of it is a
   * question about existence: does the parent envelope exist, does the
   * `-collate` task exist, has either settled. None of those can become false
   * on their own. A collator whose turn dies mid-work leaves a parent that is
   * dispatched and never settles, so *"in flight"* is true, is true for the
   * same reason forever, and the actor skips every subsequent tick — measured
   * live on `T-sweep-127`, eleven consecutive skips over 2h50m, ending only
   * because the console was rebuilt by hand.
   *
   * **REQUIRED and nullable rather than optional**, which is the whole of the
   * guarantee. An optional field defaults to absent, and absent would have to
   * mean *"never expires"* — so every construction site that forgot it would
   * re-create the wedge silently. A required field makes each caller say what
   * it knows, and `null` is a caller SAYING it cannot date this sweep.
   *
   * `null` is therefore never expired. A sweep whose envelope is truncated or
   * unreadable is not abandoned on a guess: the same refusal
   * {@link ResumableSweep} already makes, for the same reason — the cost of
   * refusing is one wasted cadence, and the cost of acting on a bad date is
   * tearing down a sweep that was working.
   */
  readonly dispatchedAt: string | null;
}

/**
 * A sweep the pass ABANDONED because it had owed longer than the console allows
 * — ISC-1168, and the fact §7.7's log renders as `sweep_expired`.
 *
 * Published on {@link TriagePassOutcome} rather than logged here because
 * `triagePass` holds no log port: §7.7's surface belongs to the actor, and the
 * composition root at `cli/commands/triage.ts` is where the outcome is still
 * whole. Carrying the fact out keeps the pass pure and keeps the log line
 * beside every other one the actor writes.
 */
export interface ExpiredSweep {
  readonly sweepId: string;
  /** The task it was still waiting on when it was abandoned, verbatim. */
  readonly waitingOn: string;
  /** How long it had been outstanding, whole seconds, for the operator's log line. */
  readonly ageS: number;
}

/**
 * §13 task 6.4a — a sweep the run tree says NOBODY owes a step on, and which
 * never reached §6.3 step 8.
 *
 * ## This is the read ISC-868 was filed open for, and it is a proof rather than a hint
 *
 * {@link InFlightSweep} reports a sweep exactly while a WORKER task is
 * outstanding. The state worth resuming — the actor died between the join and the
 * collation dispatch — reads `null` through that port, and is indistinguishable
 * there from a sweep that finished, because §6.4's corrected predicate
 * deliberately collapses *"parent settled, no collation"* into `null` so a §6.5
 * zero-row cannot wedge the actor (ISC-805).
 *
 * `resumableSweep` answers the missing question — **does `T-sweep-<n>-collate`
 * exist** — for a parent that has SETTLED. That narrows the run tree to two
 * sweeps and they are told apart by one further fact, `join`'s artifact count:
 *
 *  - **artifacts present** — this pass dispatches a collation if and only if the
 *    join found artifacts, so *artifacts AND no `-collate` task* proves the sweep
 *    never reached step 8, and a sweep that never reached step 8 produced no
 *    document for the incident machine to have consumed. It is carried.
 *  - **no artifacts** — §6.5's zero-row, which was already assessed and
 *    announced (`sweep_produced_nothing`) by the pass that ran it. It is left
 *    alone and the next id is minted.
 *
 * **Resuming on *"the record is behind the run tree"* alone was refused**, and
 * that refusal is the whole reason this member exists: it would re-drive the
 * machine over a document already consumed, minting two `unhealthy` observations
 * from ONE sweep and opening a firing incident on a single sweep's evidence,
 * which ISC-712 forbids by name. That is worse than the failure it prevents,
 * which is one wasted five-minute cadence.
 */
export interface ResumableSweep {
  readonly sweepId: string;
  /**
   * The instant the sweep was ORIGINALLY dispatched, ISO-8601, read back from
   * the host's own inbox envelope.
   *
   * Not `now`, and not optional. §7.4's echo refuses an artifact opened earlier
   * than `dispatched_at − default_window − reserve_s`, so assessing a resumed
   * sweep against the resuming pass's clock would report every observer that
   * answered correctly as `stale_window` — three innocent workers named for an
   * outage the console itself had, which is §6.7 rule 3's misdiagnosis family.
   * A sweep whose dispatch instant cannot be recovered is therefore not
   * resumable at all; the adapter answers `null` and the cadence is spent.
   */
  readonly dispatchedAt: string;
}

/**
 * §6.10's exit 5, as the only thing `openSweep` may say other than *"opened"*.
 *
 * A refused admission is not a thrown pass: the run's token ceiling is a
 * configured limit doing its job, and §6.8a gives it a `kind` of its own so the
 * operator is told once rather than 288 times. A throw here would be caught by
 * the loop and logged as a fault, which is the same information with none of the
 * deduplication.
 */
export type SweepOpen =
  | { readonly kind: "opened" }
  | { readonly kind: "budget_exhausted"; readonly reason: string };

/** §6.3 step 7's join, as the HOST found it in the run tree. */
export interface SweepJoin {
  /**
   * The reply artifacts PRESENT. §6.7: *"The number of services observed comes
   * from the run tree … never from `triage.json`'s own claim."*
   */
  readonly artifacts: readonly ObserverArtifact[];
  /** Observers whose reply carried SRD-OBSERVER-001 §9.3's `status: blocked`. */
  readonly blocked: readonly string[];
  /**
   * Observers whose TASK settled `success` and which wrote no artifact at all.
   *
   * **A silent false success, and it is worse than a failure.** Measured on the
   * first live console: the observer started, ran one `ls`, narrated what it was
   * about to do, and its turn ended eleven seconds later with an empty outbox —
   * whereupon the supervisor read the quiet transcript as `quiesced` and settled
   * the task `success`. Forty-five passes ran that way and produced not one
   * artifact.
   *
   * The console was never fooled — §6.5 counts what the HOST harvested, so the
   * services came back unobserved and escalated to coverage correctly. What was
   * missing is the DIAGNOSIS: "coverage" reads as "the environment did not
   * answer", and the truth was "the worker said it was done and wrote nothing".
   * Those send an operator to different places, and only one of them is a
   * cluster.
   *
   * Separate from {@link blocked} on purpose. A `blocked` observer reported — it
   * said it could not see, which is an answer. These seats did not report and
   * claimed they had.
   */
  readonly claimedSuccess: readonly string[];
}

/** §6.3 steps 8-9: the collation, and what a signal derived from it may cite. */
export interface SweepCollation {
  /** `null` when the collator produced no readable document. */
  readonly document: TriageDocument | null;
  /**
   * What a signal CITES — the artifact this sweep's verdicts rest on.
   *
   * A string the ADAPTER supplies rather than one composed here, because it is a
   * pointer into the run tree and this module names no paths. It is required
   * even when `document` is `null`: a sweep that collated nothing still has a
   * task an operator can go and read, and `ConsoleHealthFacts.evidenceRef` is
   * non-nullable for the reason a clear that names nothing is a clear derived
   * from an absence.
   */
  readonly evidenceRef: string;
  /**
   * Collators whose document did not echo THIS sweep — added 2026-09-12 with the
   * second pair, and it exists to stop a merge losing an accusation.
   *
   * **The hazard, stated concretely.** `assessTriageSweep` takes ONE document and
   * derives `stale_replay` from `document.worker` when that document's
   * `sweep_id` echo fails. With two collators the adapter merges their documents,
   * so a fresh `tri-1` merged with a `tri-2` replaying last sweep would carry the
   * FRESH sweep id, be judged fresh, and `tri-2` would never be named. Its
   * services would still come back unobserved — §6.5 counts what the host
   * harvested, never what a worker claimed — but the DIAGNOSIS would degrade from
   * *"tri-2 replayed last sweep"* to *"those services were unobserved"*, which
   * sends an operator to the cluster instead of to the seat.
   *
   * So the adapter runs `sweepIdEcho` per document, contributes rows only from
   * the fresh ones, and names the rest here. `triagePass` appends them to the
   * assessment's own list, which is already keyed BY PRODUCING WORKER and
   * already documented as including the collator — so nothing downstream needs a
   * new concept, and a one-pair console puts an empty array here.
   */
  readonly staleCollators: readonly string[];
}

/**
 * Everything the pass does to the run tree, as nine functions.
 *
 * **A port rather than an import, and §12's first clock criterion is why**: *"One
 * pass is exported and a test drives it with no timer … This is the coverage
 * gate's requirement stated as a criterion."* Every member here is a thing that
 * would otherwise reach a container, a control socket or a file, and the whole
 * fan-out is graded with a spy over an array — `dispatchPartition`'s own move,
 * one layer up.
 */
export interface SweepDriver {
  /** §6.4's D12 read: the RUN TREE decides, never `~/.pifleet/triage-relay.json`. */
  readonly inFlight: () => Promise<InFlightSweep | null>;
  /**
   * §13 task 6.4a's read — the parent settled and no `-collate` task was ever
   * dispatched. See {@link ResumableSweep} for why this cannot be `inFlight`.
   */
  readonly resumableSweep: () => Promise<ResumableSweep | null>;
  /**
   * §6.6 layer 2's *"re-derived from the run tree on restart"* — the highest
   * `T-sweep-<n>` the run tree holds, or `0`.
   *
   * The counter is taken as `max(record, run tree)` rather than from either
   * alone: the record is the cheap hint and the run tree is the authority (D12),
   * and a restarted actor that trusted an empty record would mint an id the
   * epoch fence has already seen — *"the symptom would be intermittent"*.
   */
  readonly highestSweepNumber: () => Promise<number>;
  /** The per-seat pins, re-derived every pass. §6.6 layer 4 makes them move. */
  readonly runs: () => Promise<Readonly<Record<string, string>>>;
  /** §6.3 steps 2-3: render the envelope and dispatch it to `tri-1`. */
  readonly openSweep: (sweepId: string, dispatchedAt: string) => Promise<SweepOpen>;
  /** §6.3 step 4's read, projected by `partitionFromRequests`. */
  readonly readPartition: (sweepId: string) => Promise<readonly PartitionAssignment[]>;
  /** §6.3 step 5's per-observer dispatch. Called ONLY through `dispatchPartition`. */
  readonly dispatchObserver: (sweepId: string, assignment: PartitionAssignment) => Promise<void>;
  /** §6.3 steps 6-7. */
  readonly join: (sweepId: string) => Promise<SweepJoin>;
  /** §6.3 steps 8-9. NOT called when §6.5's zero-row holds. */
  readonly collate: (sweepId: string) => Promise<SweepCollation>;
}

// ---------------------------------------------------------------------------
// The incident record, as a port
// ---------------------------------------------------------------------------

/**
 * §7.6's records, as two functions.
 *
 * `loadIncidentRecord` and `saveIncidentRecord` are the production
 * implementation and live beside the schema they spend; this is the seam that
 * keeps them out of every fixture. Load returns the READ rather than a record,
 * so a refusal cannot be collapsed into a fresh record at the port — §7.6's
 * *"refuses rather than being acted on"* survives the indirection.
 */
export interface IncidentStore {
  readonly load: (subject: IncidentSubject) => Promise<IncidentRecordRead>;
  readonly save: (record: IncidentRecord) => Promise<void>;
}

/** A record on disk this pass declined to act on, published rather than swallowed. */
export interface RefusedRecord {
  readonly subject: IncidentSubject;
  readonly code: IncidentRecordRefusal;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// §6.7 rule 3's cross-sweep memo
// ---------------------------------------------------------------------------

/**
 * What one saturation CANDIDATE learned, carried between sweeps.
 *
 * ## A candidate is a RUN of correlated sweeps, not a sweep
 *
 * §6.7's threshold — *"two or more observers producing no artifact in one
 * sweep"* — is evaluated every sweep, and a saturated inference server stays
 * saturated across many. The probe answers a question about the ENDPOINT, and
 * the endpoint does not change its answer between two sweeps five minutes apart
 * often enough to be worth 288 completion requests a day against the resource
 * §6.10 calls the one this console can starve. So the probe is taken on the
 * first sweep of a correlated run and reused for the rest of it.
 *
 * ## The candidate ends when the correlation does, and NOT when the verdict changes
 *
 * The gate is `correlated.length >= SATURATION_MIN_MISSING` — the same condition
 * `saturationVerdict` uses to decide whether to probe at all. A sweep that fails
 * that gate is a sweep in which the shared-dependency evidence is absent, so the
 * next one that meets it is a NEW question and gets its own probe. Keying the
 * memo on the verdict instead would be subtly wrong in both directions: an
 * `unconfirmed` candidate would re-probe every sweep forever, and a `saturated`
 * memo would outlive the correlation that justified taking it.
 *
 * `sweepId` is retained so a reader can tell WHEN the retained answer was taken;
 * nothing branches on it.
 */
export interface SaturationMemo {
  /** The probe's answer for the live candidate, or `null` when there is none. */
  readonly result: ToolCallProbeResult | null;
  /** The sweep the answer was taken on. Recorded, never branched on. */
  readonly sweepId: string | null;
}

/**
 * A factory, so no two passes alias one memo — `freshDeliveryState`'s rule and
 * `freshIncidentRecord`'s, applied to a third carried value even though this one
 * holds no array today. The constant below exists for a fixture that wants to
 * assert the shape by value.
 */
export function freshSaturationMemo(): SaturationMemo {
  return { result: null, sweepId: null };
}

/** {@link freshSaturationMemo}'s value, for an assertion. Never handed to a pass. */
export const FRESH_SATURATION_MEMO: SaturationMemo = { result: null, sweepId: null };

// ---------------------------------------------------------------------------
// Deps and outcome
// ---------------------------------------------------------------------------

export interface TriagePassDeps {
  /**
   * The environment this console sweeps.
   *
   * **ONE SWEEP IS ONE ENVIRONMENT, and that is a limit rather than a law.**
   * `assessTriageSweep` counts one `declared` list, `sweepObservations` takes one
   * `environment`, and §8.1 opens the console *"against `cni-dev`"* — so a single
   * environment is what Phases 5 and 8 are both written for. `ConsoleHealthFacts`
   * takes a LIST of environments, which is the seam a multi-environment console
   * would grow into; nothing in Phase 6 asks for it and nothing here forecloses
   * it. Recorded rather than left to be discovered.
   */
  readonly environment: string;
  /** Every service `triage/targets.yaml` declares for it, in FILE order. */
  readonly declared: readonly string[];
  /** §7.4's legal window range, assembled from the two files that fix it. */
  readonly windowPolicy: WindowPolicy;
  /**
   * §7.8's knobs, whole.
   *
   * Passed as the config object rather than as loose numbers, which is what
   * §12's *"no `src/` module reads a triage tuning value that
   * `TriageConsoleConfigSchema` does not define"* asks for. `IncidentPolicy` is a
   * `Pick` of this type, so the three knobs the machine spends arrive without a
   * second spelling.
   */
  readonly config: TriageConsoleConfig;
  /** `null` DISABLES the channel without disabling the console. §6.9 requirement 7. */
  readonly notify: NotifyConfig | null;
  /** §6.7 rule 3's announcement subject — the provider and model. */
  readonly endpoint: InferenceEndpoint;
  /** REQUIRED. See the header: a default is a POST to the operator's own server. */
  readonly probe: SaturationProbe;
  /** REQUIRED, and for the same reason: the shipped endpoint is the live one. */
  readonly transport: NotifyTransport;
  /** The previous pass's cursor. D12: a hint; the run tree is the authority. */
  readonly cursor: TriageActorCursor;
  /** The notifier's carried backoff and backlog. See {@link TriagePassOutcome.delivery}. */
  readonly delivery: DeliveryState;
  /** §6.7 rule 3's cross-sweep probe memo. */
  readonly saturationMemo: SaturationMemo;
  readonly sweep: SweepDriver;
  readonly records: IncidentStore;
  /** Epoch milliseconds. Called ONCE per pass, so a pass's timestamps agree. */
  readonly now: () => number;
  /** `AbortSignal.timeout` by default — a bound, not a network reach. */
  readonly signalFor?: NotifySignalFor;
  /** How `notify.token_env` is resolved. Defaults to the process environment. */
  readonly env?: NotifyEnvRead;
}

/**
 * What one pass did, as a closed set.
 *
 * Asserted by NAME rather than by count — `test/unit/monitor-readonly.test.ts`'s
 * rule, which is that naming the permitted set is what makes a fifth member fail.
 */
export const TRIAGE_PASS_OUTCOMES = [
  /** A sweep was dispatched, joined, assessed and announced. */
  "swept",
  /** §6.4: a sweep was already in flight. Nothing was dispatched. */
  "skipped",
  /** §6.10 exit 5: admission was refused on the run's ceiling. */
  "budget_exhausted",
  /** §6.5: the worker's partition did not cover the environment exactly once. */
  "partition_refused",
] as const;
export type TriagePassKind = (typeof TRIAGE_PASS_OUTCOMES)[number];

export interface TriagePassOutcome {
  readonly kind: TriagePassKind;
  /** §7.7's three mutable fields, for `runTriageActor` to persist. */
  readonly cursor: TriageActorCursor;
  /**
   * The notifier's state, carried in memory between passes.
   *
   * **§6.9's *"Not assigned anywhere: `DeliveryState` has no on-disk contract"*
   * is decided HERE, and the decision is that it stays in memory.** §7.6's record
   * holds `undelivered[]` because an operator must be able to see what was lost
   * after a restart, and that survives; the backoff COUNTDOWN does not, and
   * losing it is the right failure. A restarted actor retries the channel on its
   * next pass rather than continuing a twelve-sweep wait it can no longer
   * justify — the endpoint may well be the thing that was restarted — and a
   * persisted countdown would mean an actor that came up healthy sat silent for
   * an hour because of an outage that ended while it was down. The cost is
   * bounded at one extra attempt per restart; the alternative costs a schema, a
   * writer, a reader and a refusal path for a value whose whole content is *"how
   * long to keep quiet"*.
   */
  readonly delivery: DeliveryState;
  readonly saturationMemo: SaturationMemo;
  /** The sweep this pass minted, or on a skip the one it is waiting for. */
  readonly sweepId: string | null;
  /** §12: the skip *"names the in-flight sweep"*. Non-null exactly on `skipped`. */
  readonly waitingOn: string | null;
  /** `null` on every kind but `swept` and `partition_refused`. */
  readonly assessment: SweepAssessment | null;
  readonly saturation: SaturationOutcome | null;
  /** Non-null exactly on `partition_refused`, with every list §6.5 populates. */
  readonly partition: PartitionFault | null;
  /** The observers this pass actually dispatched to, in order. Empty on a refusal. */
  readonly dispatched: readonly string[];
  /** Every transition this pass composed, before any of them was delivered. */
  readonly notifications: readonly IncidentNotification[];
  /** §9.15's four surfaces. Always present — an empty pass still ticks the countdown. */
  readonly report: SweepReport;
  /** Records this pass WROTE, in write order. */
  readonly written: readonly IncidentRecord[];
  /** Records on disk this pass declined to act on. §7.6. */
  readonly refused: readonly RefusedRecord[];
  /**
   * The sweep this pass abandoned on §6.4's expiry, or `null` — ISC-1168.
   *
   * Non-null on the kinds that RAN, never on `skipped`: an expired sweep stops
   * being skipped, which is the whole point of the bound. The actor renders it
   * as `sweep_expired`; nothing else reads it.
   */
  readonly expired: ExpiredSweep | null;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * §6.4's *"the run tree is authoritative and the record is a cursor"* — D12,
 * applied on EVERY exit rather than only on the one that mints. §13 task 6.4.
 *
 * ## What "resume" means here, and it is a record change rather than a re-dispatch
 *
 * §6.4: *"On start the actor derives in-flight state by reading the run tree, not
 * by trusting `~/.pifleet/triage-relay.json` … and the actor resumes it rather
 * than starting a new one."* A restarted actor that finds `T-sweep-12` in flight
 * adopts it as ITS current sweep — it does not open a thirteenth, and its record
 * stops disagreeing with the run tree about which sweep the console is on.
 *
 * ## Leaving the skip path at the record's own number is a LATENT ID REUSE
 *
 * Before this function the skip path returned `deps.cursor.sweep_cursor`
 * untouched, so a restarted actor skipping a live `T-sweep-12` persisted
 * `sweep_cursor: 0` on every one of those passes. That is correct only while the
 * run-tree read keeps working — and `highestSweepNumber` answers `0` on an
 * unreadable inbox by design (`triage.ts`'s `catch { return 0 }`), because an
 * absent inbox is the ordinary state of a console that has never swept. Both
 * sources at `0` mints `T-sweep-1`, an id the epoch fence has already seen, and
 * §6.6 layer 2 says what happens then: *"a resumed actor that re-derives the same
 * id is refused rather than duplicated"* — the sweep silently does nothing.
 * **ISC-743's own words for this class are that the symptom is intermittent**, and
 * it needed both halves to fail at once. Carrying the number in the record makes
 * it need both halves to fail at once *and* the record to have been lost.
 *
 * ## Monotone by construction, which is the property that matters
 *
 * `max` and never an assignment: a run tree that transiently reads low can only
 * fail to advance the cursor, never move it backwards onto an id that has been
 * dispatched.
 *
 * ## What this does NOT decide, and §13 task 6.4a is what decides it instead
 *
 * The cursor is **not** the signal for resuming an abandoned sweep, and that is
 * a ruling rather than an omission. Task 6.4 left the resume half unbuilt on this
 * argument, ISC-868 was filed OPEN against it, and task 6.4a closed it with a
 * different read rather than by relaxing this one.
 *
 * *"The record is behind the run tree"* is true of a sweep that was abandoned AND
 * of one that completed perfectly while the actor's record write was lost, and
 * resuming on it would re-drive the incident machine over a document already
 * consumed — two `unhealthy` observations minted from ONE sweep, opening a
 * firing incident on a single sweep's evidence, which is what §12's *"a first
 * unhealthy notifies NOTHING"* exists to forbid (ISC-712). That is worse than
 * the failure it prevents, which is one wasted five-minute cadence.
 *
 * The discrimination that IS safe is {@link ResumableSweep} — *does
 * `T-sweep-<n>-collate` exist*, for a parent that has settled — plus the join's
 * artifact count, which is a proof rather than a hint. See that interface. This
 * function stays what it was: a monotone floor on the counter, and nothing else.
 */
export function resumedCursor(recorded: number, runTree: number): number {
  return Math.max(recorded, runTree);
}

/**
 * §6.5's zero-row and the refusal paths need a document that says NOTHING.
 *
 * It echoes the dispatched sweep id deliberately: the alternative — a `null` echo
 * — routes every service through `assessTriageSweep`'s `stale_replay` step and
 * names `tri-1` as having replayed an old answer, which is a specific accusation
 * about a worker that in this case never wrote anything at all. With a fresh
 * echo and no rows, every assigned service falls to `unreported` and every
 * unassigned one to `no_artifact` or `unassigned` — all three `indeterminate`,
 * which is §6.5's *"A service whose observer stalled is `indeterminate` for that
 * sweep, never `healthy`"* reached without inventing a fault.
 */
function silentDocument(sweepId: string): TriageDocument {
  return { worker: TRIAGE_COLLATOR, sweep_id: sweepId, services: [], unaccounted: [] };
}

/**
 * §6.7 rule 3's probe, wrapped in {@link SaturationMemo}.
 *
 * The wrapper is handed to `saturationVerdict` in place of the real probe, so the
 * correlation gate still decides WHETHER to ask and this decides whether the
 * answer is already known. Both layers are needed and neither subsumes the other:
 * without the gate every sweep would probe, and without the memo every
 * *correlated* sweep would.
 */
function memoized(
  memo: SaturationMemo,
  sweepId: string,
  probe: SaturationProbe,
): { readonly probe: SaturationProbe; readonly taken: () => SaturationMemo } {
  let next = memo;
  return {
    probe: async () => {
      if (memo.result !== null) return memo.result;
      const result = await probe();
      next = { result, sweepId };
      return result;
    },
    taken: () => next,
  };
}

/**
 * §6.7 rule 3's `unreachable` half of §6.8a's pair — §13 task 5.4e, and the
 * criterion is ISC-824.
 *
 * ## It READS one column now, and does not spell one — §13 task 6.4b
 *
 * `ConsoleHealthFacts` takes `(saturated, unreachable)` and the two are
 * independent questions (`triage-incident.ts:1660-1702`). Both columns now live
 * in `SATURATION_PAIR` (`triage-verdict.ts`, beside `SaturationOutcome`), so this
 * function is a lookup and the only thing left in it is the `null` rule below.
 *
 * **It used to be a `switch`, and that switch was half of ISC-869's defect.** The
 * other half was a `Record<SaturationVerdict, …>` literal inside a `describe` in
 * `test/unit/triage-incident.test.ts` — the pair written twice, in two files, with
 * nothing pinning the two equal. They agreed, which is what made it a duplication
 * defect rather than a live bug, and is exactly the state ISC-804 exists to catch
 * before it stops being one. Consolidating was the fix rather than a third
 * assertion: an assertion that two copies agree is a third place the mapping is
 * written and goes green the day both are edited together and wrongly.
 *
 * ## The rows in prose, so a reader here need not open another file
 *
 * `clear` is the only `false`: §6.8a's clearing fact is *"a sweep in which every
 * observer produced an artifact"*, and that is `clear` and nothing else.
 * `endpoint_down` is the only `true`. `uncorrelated`, `saturated` and
 * `unconfirmed` are all `null` — and the `saturated` row is the one worth stating
 * outright, because it is the row a hurried edit gets wrong: that verdict means
 * the probe TIMED OUT, which is evidence about speed and no evidence at all about
 * reachability. Returning `false` there would recover an *"endpoint is down"*
 * incident on the strength of a request that never came back, which is ISC-675's
 * absence-as-evidence mistake wearing a different fault as a disguise.
 *
 * **That paragraph is PROSE and `SATURATION_PAIR` is the code.** The probe that
 * forbids a second spelling reads comment-stripped source for exactly this
 * reason: a raw scan for those verdict names reddens right here, on the sentences
 * that explain them, and the repair a hurried reader reaches for is to delete the
 * explanation.
 *
 * ## What is still THIS function's, and is not in the table
 *
 * `null` for a `null` outcome. A pass that never swept — a skip, a budget refusal
 * — did not ask, and `ConsoleHealthFacts`' optional field is documented as *"this
 * sweep could not tell"*. There is no verdict for *"no verdict"*, so it cannot be
 * a row: adding one would put a sweep that did not happen into the vocabulary of
 * sweeps that did.
 *
 * ## Exhaustiveness MOVED rather than weakened
 *
 * The `never` binding after the old switch was ISC-862's *"a sixth member is a
 * `tsc` error rather than a silent `null`"*. `SATURATION_PAIR` is typed
 * `Record<SaturationVerdict, …>`, so a sixth member of `SATURATION_VERDICTS` is a
 * `tsc --noEmit` error on that literal — one error at the one place the answer is
 * written, rather than one per reader, and a reader cannot now forget to have a
 * guard at all.
 */
export function unreachableFrom(saturation: SaturationOutcome | null): boolean | null {
  if (saturation === null) return null;
  return SATURATION_PAIR[saturation.verdict].unreachable;
}

/**
 * §6.7 rule 3's *"the announcement composed for a saturation issue carries the
 * provider and model as its subject"*, applied at the ONE place the two
 * vocabularies meet.
 *
 * `announcementFacts` maps a console-health subject's `health` into
 * `AnnouncementFacts.subject`, which is right for five of §6.8a's six kinds and
 * wrong for this one: `inference_saturated` is the kind whose subject is not the
 * identity but the thing that is saturated. ISC-681 asserts the composed title by
 * full value against a `provider/model` pair, so the override is graded rather
 * than assumed, and it is a named function rather than an inline spread so that
 * the exception has one home and a reader can see there is exactly one.
 *
 * The environment rides along as `extras.environment` on §6.9 requirement 1's
 * note that a `_console`-scoped announcement *"still has an environment worth
 * naming"* — as the SCOPE of what went unobserved, never as the subject.
 */
function extrasFor(
  notification: IncidentNotification,
  environment: string,
  saturationSubject: string,
  note: string | null,
): { readonly extras: AnnouncementExtras; readonly subject: string | null } {
  const subject = notification.subject;
  if (subject.kind === "console_health" && subject.health === "inference_saturated") {
    return { extras: { environment }, subject: saturationSubject };
  }
  return { extras: { evidence: note }, subject: null };
}

/**
 * ONE pass — §6.3's eleven steps, of which this function performs 1-3, 5, 7, 8,
 * 10 and 11 and the worker performs 4, 6 and 9.
 *
 * ## The three exits before a sweep is dispatched, and each is its own `kind`
 *
 *  - **A sweep already in flight → `skipped`.** §6.4: *"SKIP, never queue … A
 *    queue of skipped ticks becomes a thundering herd the moment the stall
 *    clears, which converts one slow sweep into three concurrent ones against the
 *    same control plane."* Nothing is opened and nothing is dispatched, which is
 *    also the half of §12's anti-double-dispatch criterion this task carries:
 *    a restarted actor reading a run tree that holds a live sweep skips it. (The
 *    other half — RESUMING that sweep rather than waiting for it — is task 6.4's.)
 *  - **Admission refused → `budget_exhausted`.** The id is CONSUMED rather than
 *    returned to the counter: §6.6 layer 2's *"No sweep ever reuses an id"* is
 *    about the epoch fence, and an id that was rendered into an envelope has been
 *    seen whether or not the dispatch landed.
 *  - **The partition does not cover the environment → `partition_refused`.**
 *    Through `dispatchPartition`, so *"nothing was dispatched"* is a property of
 *    the code. The sweep still reaches the incident machine, because a sweep that
 *    observed nothing is not a clean sweep (§6.5) — every service is
 *    `unassigned`, therefore `indeterminate`, and §6.5's zero-row raises
 *    `sweep_produced_nothing` for the environment.
 *
 * ## The write order, and it is the rule §13 says a plausible implementation breaks
 *
 * Records are advanced and SAVED, then the announcements are delivered, then the
 * losses are folded back with `withUndelivered`. §6.9 requirement 7 — *"a
 * delivery failure never advances or clears an incident"* — is behavioural here
 * rather than structural, because this is the only module that holds both a
 * record and a transport, and ISC-706 pins it by capturing the record's state
 * from inside the transport. `withUndelivered` is the one write allowed after the
 * `await`, and it touches exactly one field.
 *
 * ## Throwing
 *
 * Nothing here catches. `runTriageActor` logs a thrown pass and continues
 * (`relay.ts:700-723`), and `--once` propagates it (task 6.2) because *"a single
 * pass is somebody's command and its exit code should mean something"*. Swallowing
 * a broken driver or a permanently broken probe here would make it
 * indistinguishable from a healthy console with nothing to say.
 */
/**
 * §6.4's missing clock — ISC-1168. `null` when the sweep may still be owed.
 *
 * ## Three ways to answer "not expired", and only one of them is a duration
 *
 *  - **No sweep in flight.** Nothing to expire.
 *  - **A sweep that cannot be DATED.** {@link InFlightSweep.dispatchedAt} is
 *    `null`, which is the adapter saying the envelope was unreadable. A sweep
 *    is never abandoned on a guess: the cost of refusing is one more cadence of
 *    waiting, and the cost of guessing is tearing down a collator that was
 *    working. Same refusal {@link ResumableSweep} makes, for the same reason.
 *  - **A sweep still inside its allowance**, which is the ordinary case.
 *
 * A dispatch instant in the FUTURE — a clock that stepped backwards, a
 * hand-edited envelope — yields a negative age and is therefore *not* expired,
 * which falls out of the comparison rather than needing a branch. That is the
 * safe direction: skew delays an abandonment, it never manufactures one.
 *
 * Pure, and takes the config rather than reading one, so the whole policy is
 * assertable without a run tree.
 */
function expiredSweep(
  inFlight: InFlightSweep | null,
  config: TriageConsoleConfig,
  at: number,
): ExpiredSweep | null {
  if (inFlight === null || inFlight.dispatchedAt === null) return null;
  const dispatched = Date.parse(inFlight.dispatchedAt);
  if (!Number.isFinite(dispatched)) return null;
  const ageMs = at - dispatched;
  if (ageMs < sweepExpiryS(config) * 1_000) return null;
  return {
    sweepId: inFlight.sweepId,
    waitingOn: inFlight.waitingOn,
    ageS: Math.floor(ageMs / 1_000),
  };
}

export async function triagePass(deps: TriagePassDeps): Promise<TriagePassOutcome> {
  const at = deps.now();
  const runs = await deps.sweep.runs();
  const inFlight = await deps.sweep.inFlight();
  /*
   * §6.6 layer 2's counter, read ONCE and read on EVERY exit — §13 task 6.4.
   *
   * It was previously read only on the path that mints, which left the skip path
   * returning `deps.cursor.sweep_cursor` unchanged. See {@link resumedCursor} for
   * why that is a latent id reuse rather than a cosmetic lag.
   */
  const highest = await deps.sweep.highestSweepNumber();

  /*
   * ISC-1168's bound, and it is a condition on the SKIP rather than a third
   * quadrant in the predicate.
   *
   * §6.4's read asks whether a sweep has SETTLED and never how long it has
   * OWED, so a collator whose turn dies mid-work leaves an answer that is true
   * for the same reason forever. Measured live on `T-sweep-127`: eleven
   * consecutive skips over 2h50m, ending only because the console was rebuilt
   * by hand.
   *
   * **The fact and the policy are separated on purpose.** The adapter reports
   * WHEN the sweep was dispatched, because it is the half that can read the run
   * tree; this decides what is too old, because it is the half that holds
   * `deps.config`. Bounding the predicate itself would have put a deadline in a
   * function that has no config and is also consulted by the recycle gate
   * (`TriageConsolePorts.sweepInFlight`), where "expired" would wrongly read as
   * "no sweep in flight" and permit a teardown mid-sweep.
   *
   * An expired sweep does NOT settle as `skipped` — it falls through to the
   * mint below and the pass reports what it actually did. §6.6 layer 2's *"no
   * sweep ever reuses an id"* makes that safe: the abandoned worker can only
   * write into the old id's outbox, which nothing joins again.
   */
  const expired = expiredSweep(inFlight, deps.config, at);

  if (inFlight !== null && expired === null) {
    return await settle(deps, {
      at,
      runs,
      kind: "skipped",
      sweepId: inFlight.sweepId,
      waitingOn: inFlight.waitingOn,
      /*
       * §13 task 6.4: the actor ADOPTS the in-flight sweep rather than leaving
       * its record behind the run tree. See {@link resumedCursor}.
       */
      sweepCursor: resumedCursor(deps.cursor.sweep_cursor, highest),
      /*
       * §6.4's counter, and §6.8a's raise line reads it: `max_consecutive_skips −
       * 1`, so the OPEN lands on the threshold itself once the machine's own
       * confirmation is spent. The pass supplies the number and decides nothing
       * about it.
       */
      consecutiveSkips: deps.cursor.consecutive_skips + 1,
      /*
       * A skipped pass says NOTHING about any environment — no `observer_blocked`
       * observation and no `sweep_produced_nothing` one. §12: *"a `firing`
       * `observer_blocked` record followed by a sweep that did not run at all;
       * assert it stays `firing`"*, and an empty list is stronger than the
       * `unobserved` that arm would produce, because a subject with no
       * observation is a subject whose record this pass never even loads.
       */
      environments: [],
      /*
       * §6.10's ceiling, and this is the one console-health fact a skipped pass
       * is entitled to answer. A skip happens precisely because a sweep the
       * actor already dispatched is still running, which is a POSITIVE
       * observation that admission is being granted — not the absence of a
       * refusal, but the presence of an admitted task.
       */
      budgetExhausted: false,
      /*
       * The in-flight task is what a `budget_exhausted` clear derived from this
       * pass cites. It is a pointer to something an operator can go and read,
       * which is all `evidenceRef` promises.
       */
      evidenceRef: inFlight.waitingOn,
      assessment: null,
      saturation: null,
      partition: null,
      dispatched: [],
      serviceObservations: [],
      memo: deps.saturationMemo,
      /* A skip is the branch an expiry does not take. Structurally `null`. */
      expired: null,
    });
  }

  /*
   * §13 task 6.4a — ISC-868. A sweep whose parent settled with no collation ever
   * dispatched is one of exactly two things, and the join tells them apart.
   *
   * The artifacts decide, and the reasoning is in {@link ResumableSweep}: this
   * pass dispatches a collation if and only if the join found artifacts, so
   * *artifacts present AND no `-collate` task* is a PROOF that the sweep never
   * reached step 8 and the incident machine has never seen a document from it.
   * The zero-row — the same run-tree shape with nothing to collate — falls
   * through and the next id is minted, because it was assessed and announced by
   * the pass that ran it and re-collating it would spend a worker turn every
   * tick, forever, on a document with no rows.
   *
   * `openSweep` is NOT called and no observer is dispatched a second time: the
   * envelope was rendered and the fan-out landed on the pass that opened this
   * sweep, and §6.6 layer 2's *"No sweep ever reuses an id"* means the epoch
   * fence would refuse the re-dispatch anyway.
   */
  const resumable = await deps.sweep.resumableSweep();
  if (resumable !== null) {
    const carried = await deps.sweep.join(resumable.sweepId);
    if (carried.artifacts.length > 0) {
      return await completeSweep(deps, {
        at,
        runs,
        sweepId: resumable.sweepId,
        /* The SWEEP's instant, never this pass's clock. {@link ResumableSweep}. */
        dispatchedAt: resumable.dispatchedAt,
        sweepCursor: resumedCursor(deps.cursor.sweep_cursor, highest),
        assignments: await deps.sweep.readPartition(resumable.sweepId),
        join: carried,
        dispatched: [],
        refusedPartition: null,
        expired,
      });
    }
  }

  // §6.6 layer 2: `max(record, run tree)`. D12 keeps the tree authoritative and
  // the record is the hint that makes finding the number cheap.
  const previous = resumedCursor(deps.cursor.sweep_cursor, highest);
  const number = previous + 1;
  const sweepId = sweepTaskId(number);
  const dispatchedAt = new Date(at).toISOString();

  const open = await deps.sweep.openSweep(sweepId, dispatchedAt);
  if (open.kind === "budget_exhausted") {
    return await settle(deps, {
      at,
      runs,
      kind: "budget_exhausted",
      sweepId,
      waitingOn: null,
      sweepCursor: number,
      /*
       * The skip counter is CARRIED rather than reset. A pass that could not open
       * a sweep did not sweep, and §6.8a's rule 3 is that `sweeps_skipped` clears
       * on *"a sweep that ran"* — *"an actor that stopped counting is not an actor
       * that recovered"*. Resetting here would compose that recovery out of a
       * pass that swept nothing.
       */
      consecutiveSkips: deps.cursor.consecutive_skips,
      /*
       * Nothing was dispatched, so nothing is said about the environment. Raising
       * §6.5's zero-row here as WELL as `budget_exhausted` would announce two
       * findings for one cause and let the operator read the one that names their
       * cluster — §6.7 rule 3's misdiagnosis family, in miniature.
       */
      environments: [],
      budgetExhausted: true,
      evidenceRef: sweepId,
      assessment: null,
      saturation: null,
      partition: null,
      dispatched: [],
      serviceObservations: [],
      memo: deps.saturationMemo,
      expired,
    });
  }

  const assignments = await deps.sweep.readPartition(sweepId);
  /*
   * The fan-out runs CONCURRENTLY, so `dispatched` is derived from the results in
   * ASSIGNMENT order rather than appended as each dispatch finishes. Pushing from
   * inside the callback would order this list by whichever observer settled first,
   * which is a schedule and not a fact: it reaches §7.7's record and the `--json`
   * envelope, where two identical sweeps would differ for no reason a reader could
   * act on. `Promise.all` preserves input order in `results`, so this is the
   * partition's own order and it is stable.
   */
  const fanOut = await dispatchPartition(deps.declared, assignments, async (assignment) => {
    await deps.sweep.dispatchObserver(sweepId, assignment);
    return assignment.worker;
  });
  const dispatched: string[] = fanOut.kind === "dispatched" ? [...fanOut.results] : [];

  const refusedPartition = fanOut.kind === "refused" ? fanOut : null;

  const join: SweepJoin =
    refusedPartition === null
      ? await deps.sweep.join(sweepId)
      : { artifacts: [], blocked: [], claimedSuccess: [] };

  return await completeSweep(deps, {
    at,
    runs,
    sweepId,
    dispatchedAt,
    sweepCursor: number,
    assignments: refusedPartition === null ? assignments : [],
    join,
    dispatched,
    refusedPartition,
    expired,
  });
}

/** §6.3 steps 8-11 for a sweep whose observers have already been joined. */
interface CompletedSweep {
  readonly at: number;
  readonly runs: Readonly<Record<string, string>>;
  readonly sweepId: string;
  /** The instant the SWEEP was dispatched — task 6.4a carries an older one. */
  readonly dispatchedAt: string;
  readonly sweepCursor: number;
  /** `[]` when the partition was refused, so coverage reports every service unassigned. */
  readonly assignments: readonly PartitionAssignment[];
  readonly join: SweepJoin;
  /** The observers THIS pass dispatched to. Empty on a refusal and on a resume. */
  readonly dispatched: readonly string[];
  readonly refusedPartition: PartitionFault | null;
  /** ISC-1168's abandonment, passed through to {@link Settlement}. */
  readonly expired: ExpiredSweep | null;
}

/**
 * Steps 8-11, shared by the sweep this pass dispatched and the sweep it resumed.
 *
 * **One spelling rather than two, and §13 task 6.4b's argument is why**: the
 * resume path differs from the mint path in the four values above it and in
 * nothing below, and a second copy of the collate/assess/saturate/settle chain
 * is the shape ISC-804 exists to catch — *"two spellings agreeing by
 * coincidence, with no test pinning them equal"*. A resumed sweep that quietly
 * stopped running the saturation memo, or stopped resetting §6.4's skip counter,
 * would be invisible in a file where the two paths were written out separately.
 */
async function completeSweep(
  deps: TriagePassDeps,
  s: CompletedSweep,
): Promise<TriagePassOutcome> {
  /*
   * §6.5's ZERO-ROW, and it is a call that does not happen rather than a result
   * that is discarded: *"with no child succeeding, no collation is dispatched"*.
   * Dispatching a collation into a run where nothing replied spends a worker
   * turn to produce a document with no rows, and the document would then be the
   * console's own answer to a question nobody answered.
   */
  const collation: SweepCollation =
    s.join.artifacts.length > 0
      ? await deps.sweep.collate(s.sweepId)
      : // §6.5's zero-row: no child succeeded, so no collation was dispatched and
        // no collator can have replayed one. Empty rather than absent — see
        // `SweepCollation.staleCollators`.
        { document: null, evidenceRef: s.sweepId, staleCollators: [] };

  const coverage: SweepCoverage = {
    declared: deps.declared,
    assignments: s.assignments,
    artifacts: s.join.artifacts,
    window: {
      default_window_s: deps.windowPolicy.default_window_s,
      reserve_s: deps.windowPolicy.reserve_s,
      dispatched_at: s.dispatchedAt,
    },
  };
  const assessed = assessTriageSweep(
    s.sweepId,
    coverage,
    collation.document ?? silentDocument(s.sweepId),
  );
  /*
   * THE COLLATORS THE MERGE ALREADY REFUSED, folded back in — §6.6 layer 3 for a
   * console with more than one collator.
   *
   * `assessTriageSweep` takes ONE document and can therefore accuse only one
   * author. With two pairs the adapter merges two documents, and it echo-checks
   * each BEFORE merging precisely so a replay cannot ride in on the other
   * collator's fresh sweep id (see `SweepCollation.staleCollators`). Those
   * refusals are computed there and would be dropped on the floor here — the
   * services would still come back unobserved, so the console would still be
   * right, while saying `coverage` where it could have said WHO replayed.
   *
   * `stale_replay` is already "every artifact whose echo failed, BY PRODUCING
   * WORKER — the collator included", so this needs no new concept and no new
   * field: it is the same list, completed. A one-pair console contributes an
   * empty array and this is identity.
   */
  const assessment =
    collation.staleCollators.length === 0
      ? assessed
      : {
          ...assessed,
          stale_replay: [...assessed.stale_replay, ...collation.staleCollators],
        };

  const memo = memoized(deps.saturationMemo, s.sweepId, deps.probe);
  const saturation = await saturationVerdict(assessment, deps.endpoint, memo.probe);
  /*
   * The candidate lives exactly as long as the correlation does. See
   * {@link SaturationMemo}: keying on the verdict instead would either re-probe
   * an `unconfirmed` candidate every sweep or outlive the evidence that justified
   * the answer.
   */
  const correlated = saturation.correlated.length >= SATURATION_MIN_MISSING;
  const nextMemo = correlated ? memo.taken() : freshSaturationMemo();

  const serviceObservations = sweepObservations(assessment, saturation, {
    environment: deps.environment,
    at: s.at,
    evidenceRef: collation.evidenceRef,
  });

  return await settle(deps, {
    at: s.at,
    runs: s.runs,
    kind: s.refusedPartition === null ? "swept" : "partition_refused",
    sweepId: s.sweepId,
    waitingOn: null,
    sweepCursor: s.sweepCursor,
    /** A sweep that RAN resets §6.4's counter. §6.8a's *"cleared by a sweep that ran"*. */
    consecutiveSkips: 0,
    environments: [
      {
        environment: deps.environment,
        observerBlocked: s.join.blocked.length > 0,
        /** §6.5's zero-row, as the fact §6.8a's table branches on. */
        collated: collation.document !== null,
      },
    ],
    budgetExhausted: false,
    evidenceRef: collation.evidenceRef,
    assessment,
    saturation,
    partition: s.refusedPartition,
    dispatched: s.dispatched,
    serviceObservations,
    memo: nextMemo,
    expired: s.expired,
  });
}

/** Everything the four exits of a pass agree on before the machine runs. */
interface Settlement {
  readonly at: number;
  readonly runs: Readonly<Record<string, string>>;
  readonly kind: TriagePassKind;
  readonly sweepId: string;
  readonly waitingOn: string | null;
  readonly sweepCursor: number;
  readonly consecutiveSkips: number;
  readonly environments: readonly ConsoleEnvironmentFactsLocal[];
  readonly budgetExhausted: boolean;
  readonly evidenceRef: string;
  readonly assessment: SweepAssessment | null;
  readonly saturation: SaturationOutcome | null;
  readonly partition: PartitionFault | null;
  readonly dispatched: readonly string[];
  readonly serviceObservations: readonly IncidentObservation[];
  readonly memo: SaturationMemo;
  /** ISC-1168's abandonment, carried to the outcome. `null` on every ordinary exit. */
  readonly expired: ExpiredSweep | null;
}

/** `ConsoleEnvironmentFacts`, named locally so the settlement shape reads whole. */
interface ConsoleEnvironmentFactsLocal {
  readonly environment: string;
  readonly observerBlocked: boolean;
  readonly collated: boolean;
}

/**
 * Steps 10 and 11 — drive the machine, write, then emit.
 *
 * Shared by all four exits deliberately: a skip that did not run the incident
 * machine would never reach §6.8a's `sweeps_skipped` open, and a budget refusal
 * that did not reach the notifier would be a console-health issue nobody is told
 * about. §6.8a's whole content is that these six kinds go through the SAME
 * machine, so they must also go through the same tail.
 */
async function settle(deps: TriagePassDeps, s: Settlement): Promise<TriagePassOutcome> {
  const facts: ConsoleHealthFacts = {
    ran: true,
    sweepId: s.sweepId,
    at: s.at,
    evidenceRef: s.evidenceRef,
    environments: s.environments,
    consecutiveSkips: s.consecutiveSkips,
    maxConsecutiveSkips: deps.config.max_consecutive_skips,
    saturated: s.saturation?.saturated ?? null,
    /*
     * §13 task 5.4e / ISC-824 — the seventh kind's fact, computed in PRODUCTION.
     *
     * Until this line existed the field was absent on every sweep, so §6.8a's
     * `inference_unreachable` was an enum member, an observation and an anti-twin
     * with nothing that could ever raise it: ISC-820..823 were all satisfiable by
     * hand-built facts. This is the caller 5.4d's *Touches* line excluded.
     */
    unreachable: unreachableFrom(s.saturation),
    budgetExhausted: s.budgetExhausted,
    /*
     * §9.15 surface 1, read from the state as the pass STARTED.
     *
     * The predicate is the notifier's own `reporterUndelivered` rather than a
     * copy of its rule — *"it enters `firing` on the first `rejected` outcome and
     * on the second consecutive `retryable` one"* is a decision that belongs to
     * one module. What this module chooses is WHICH state to ask it about, and
     * the answer is the pre-pass one: a channel that fails inside this sweep is
     * accused by the NEXT sweep, which is the only order in which the accusation
     * can be delivered at all, and one that recovered inside this sweep must not
     * clear the issue before the message about it has gone out.
     */
    reporterUndelivered: reporterUndelivered(deps.delivery),
  };

  const observations: IncidentObservation[] = [
    ...s.serviceObservations,
    ...consoleHealthObservations(facts),
  ];

  const notifications: IncidentNotification[] = [];
  const written: IncidentRecord[] = [];
  const refused: RefusedRecord[] = [];
  /** Subject by key, so a loss can be folded back into the record it came from. */
  const byKey = new Map<string, IncidentRecord>();

  for (const observation of observations) {
    const read = await deps.records.load(observation.subject);
    if (read.kind === "refused") {
      /*
       * §7.6: *"refuses rather than being acted on"*. There is no fallback to a
       * fresh record — falling back would turn a hand-edited or half-written file
       * into a silent reset of a `firing` incident — so the subject is skipped
       * and the refusal is published for the log and `--status`.
       */
      refused.push({ subject: observation.subject, code: read.code, reason: read.reason });
      continue;
    }
    const advance = advanceIncident(read.record, observation, deps.config);
    /*
     * A `suppressed` observation returns the caller's OWN object, so identity is
     * exactly *"this sweep moved nothing"* and the write is skipped. Comparing
     * fields instead would have to enumerate them and would silently start
     * writing the day one was added.
     */
    if (advance.record !== read.record) {
      await deps.records.save(advance.record);
      written.push(advance.record);
    }
    byKey.set(subjectKey(observation.subject), advance.record);
    notifications.push(...advance.notifications);
  }

  const saturationSubject = s.saturation?.subject ?? "";
  /*
   * §13 task 5.8 — the row's own `note`, carried into `Announcement.evidence`.
   *
   * Keyed by SERVICE because an announcement is about one subject and a note is
   * about one row: a sweep-level note would attribute one service's prose to
   * another service's incident, in the host's own voice, on somebody's phone.
   * `s.assessment` is null on the three exits that dispatched nothing, and a
   * sweep that read no rows has no prose to quote.
   *
   * The `inference_saturated` arm above deliberately carries no `evidence`: a
   * console-health incident is about the CONSOLE, and a note belongs to a
   * service row. `announcementFacts` reads `extras.evidence ?? null`, so that
   * arm is unchanged in behaviour.
   */
  const noteFor = new Map<string, string | null>(
    (s.assessment?.services ?? []).map((a) => [a.service, a.note]),
  );
  const pairs = notifications.map((notification) => {
    const subj = notification.subject;
    const note = subj.kind === "service" ? (noteFor.get(subj.service) ?? null) : null;
    const { extras, subject } = extrasFor(notification, deps.environment, saturationSubject, note);
    const composed = announcementFacts(notification, extras);
    return {
      key: subjectKey(notification.subject),
      facts: subject === null ? composed : { ...composed, subject },
    };
  });

  const deliverDeps: DeliverDeps = {
    transport: deps.transport,
    now: deps.now,
    env: deps.env,
    signalFor: deps.signalFor,
  };
  const report = await reportSweep(
    pairs.map((p) => p.facts),
    deps.notify,
    deps.delivery,
    deliverDeps,
  );

  /*
   * §7.6's `undelivered[]`, and it is the ONE write allowed after the transport.
   *
   * `orderForDelivery` is called here rather than re-derived, because it is the
   * same exported function `reportSweep` uses to order its own attempts — so
   * `deliveries[i]` and `ordered[i]` are the same announcement by construction
   * rather than by a coincidence of two sorts. A private ordering here would
   * attribute a loss to the wrong record the first time a reporter recovery was
   * hoisted past a service message, which is exactly the case §9.15 surface 4
   * creates.
   */
  const ordered = orderForDelivery(pairs.map((p) => p.facts));
  const keyOf = new Map<AnnouncementFacts, string>(pairs.map((p) => [p.facts, p.key]));
  for (let i = 0; i < report.deliveries.length && i < ordered.length; i += 1) {
    const delivery = report.deliveries[i]!;
    const lost =
      delivery.announcement !== null &&
      (delivery.disposition === "held" ||
        (delivery.disposition === "attempted" && delivery.outcome?.status !== "delivered"));
    if (!lost) continue;
    const key = keyOf.get(ordered[i]!);
    const record = key === undefined ? undefined : byKey.get(key);
    if (record === undefined) continue;
    const updated = withUndelivered(record, [delivery.announcement.title]);
    if (updated === record) continue;
    await deps.records.save(updated);
    written.push(updated);
    byKey.set(key!, updated);
  }

  return {
    kind: s.kind,
    cursor: {
      runs: s.runs,
      sweep_cursor: s.sweepCursor,
      consecutive_skips: s.consecutiveSkips,
    },
    delivery: report.state,
    saturationMemo: s.memo,
    sweepId: s.sweepId,
    waitingOn: s.waitingOn,
    assessment: s.assessment,
    saturation: s.saturation,
    partition: s.partition,
    dispatched: s.dispatched,
    notifications,
    report,
    written,
    refused,
    expired: s.expired,
  };
}
