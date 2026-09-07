/**
 * The incident state machine — SRD-TRIAGE-CONSOLE §6.7 rule 1, §6.8, §7.6; §13
 * task 5.4.
 *
 * One pure function, `(record, observation) => {record, notifications[]}`, and it
 * is the whole of what turns 288 sweeps a day into a number an operator will
 * still be reading next week. §6.8 states the target as the rule rather than as
 * an aspiration — *"`firing → firing` … **This is the rule that turns 288 into
 * 1**"* — and everything below exists to make that rule, and the three
 * refinements around it, mechanical.
 *
 * Phase 5 *"touches no worker and reads no cluster"*. Nothing here reads a file,
 * a clock or a network: `at` is a parameter, the policy is a parameter, and the
 * record is a value in and a value out. The caller writes it to
 * `~/.pifleet/triage/<env>/<service>.json` (§7.6) and that is task 5.5's.
 *
 * ## ONE MACHINE, AND THE SECOND IDENTITY IS A DATA ADDITION
 *
 * §13 task 5.4a drives console-health issues *"through 5.4's machine
 * unchanged"*, and states the failure condition outright: *"If this task finds
 * itself writing a second state machine, it has gone wrong — the whole content of
 * §6.8a is that the identity was missing and the machine was not."*
 *
 * So this module reads NOTHING about who an incident is about. {@link
 * IncidentSubject} is copied from the observation into the record and out into
 * every notification, and no branch below inspects a field of it. §6.8a's
 * `(scope, kind)` identity is therefore a union member and six {@link
 * ObservedIssueReason} tokens, and the function bodies do not change. {@link
 * ADVANCE_READS_NO_SUBJECT_FIELD} is the executable half of that claim.
 *
 * ## The type is the guard, on the one rule this console must not get wrong
 *
 * §6.8: *"**A recovery notification for a service nobody could see is the single
 * most damaging message this console could send**, because it is an all-clear
 * derived from an absence, and the operator would act on it."*
 *
 * The cheap version of that rule is a runtime check — an `if` on an evidence
 * field, which a later edit can delete and no fixture would notice unless one was
 * written for it. {@link IncidentSignal} spends the type system instead: the only
 * member that can move a record toward `clear` is `observed_clear`, and its
 * `evidenceRef` is a REQUIRED, non-nullable string. There is no way to construct
 * a recovery out of a silence, so *"`unhealthy → indeterminate` does not
 * recover"* is not a branch that can be removed. `unobserved` carries no payload
 * at all, which is what stops a caller smuggling an all-clear through it.
 *
 * That is the same posture `triage-config.ts` takes on `sweep_deadline_s` — *"the
 * refusal is unreachable BY CONSTRUCTION"* — applied to the rule that costs the
 * most.
 *
 * ## What THROWS and what returns a value
 *
 * `triage-partition.ts`'s split, unchanged: a document a container wrote is
 * untrusted input and gets a value; a HOST argument that is wrong for the life of
 * the run gets a throw. Handing this function a record for one subject and an
 * observation for another is the second kind — the caller loaded the wrong file —
 * and continuing would write one service's state into another service's record.
 *
 * ## Three numbers that are not knobs, and why
 *
 * §7.8 gives this console NINE tuning values and §12 requires that *"no `src/`
 * module reads a triage tuning value that `TriageConsoleConfigSchema` does not
 * define"*. Three of the nine reach this module and they arrive as {@link
 * IncidentPolicy}, which is a `Pick` OF that schema's inferred type rather than a
 * re-spelling of it: rename `flap_window_s` in the schema and this alias stops
 * compiling at every construction site. {@link COVERAGE_THRESHOLD} is the one
 * number here that is NOT a knob — §6.7's table fixes it at *"3+ consecutive,
 * same service"* and §7.8's nine do not include it — so it is a named constant a
 * test can reference rather than a literal `3` in a comparison.
 */

import { dirname, join } from "node:path";

import { z } from "zod";

import { SESSION_ID_RE } from "../contracts.ts";
import { runsRoot } from "./paths.ts";
import type { TriageConsoleConfig } from "./triage-config.ts";
import type { AnnouncementFacts, NotifyBacklog } from "./triage-notify.ts";

/**
 * §6.8a's closed `kind` set, entire — the six things this console can notify
 * about that are not a service.
 *
 * Closed *"on §6.2's rule for `checks[]` — a closed set cannot acquire a seventh
 * member by accident, and a `kind` a reader cannot enumerate is a `kind` nobody
 * writes a criterion for"*. Exported as a frozen tuple and not only as a type,
 * because §12's console-health criterion is *"assert the enum's members by name …
 * not by count"* and a type is erased at runtime and asserts nothing.
 *
 * The order is §6.8a's own table, top to bottom.
 */
export const CONSOLE_HEALTH_KINDS = [
  /** An observer returned `status: blocked` (SRD-OBSERVER-001 §9.3). */
  "observer_blocked",
  /** §6.5's zero-row: no child succeeded, so no collation was dispatched. */
  "sweep_produced_nothing",
  /** Consecutive skips reached `max_consecutive_skips` (§6.4). */
  "sweeps_skipped",
  /** §6.7 rule 3. */
  "inference_saturated",
  /** Admission refused on the run's ceiling, exit 5 (§6.10). */
  "budget_exhausted",
  /** §9.15 — the delivery path itself is failing. */
  "reporter_undelivered",
] as const;
export type ConsoleHealthKind = (typeof CONSOLE_HEALTH_KINDS)[number];

/**
 * §6.8a's literal scope for the kinds that are about the console rather than
 * about an environment.
 *
 * **It also makes a collision between the two record kinds unrepresentable, and
 * that is worth more than the readability.** Environment keys and service names
 * are held to `SESSION_ID_RE` by `triage-targets.ts:107-117`, which requires an
 * alphanumeric first character — so no environment and no service can ever be
 * named `_console`. §7.6's `<env>/<service>.json` and §6.8a's
 * `<scope>/_console/<kind>.json` therefore cannot name the same file however the
 * targets file is written, rather than merely being unlikely to.
 */
export const CONSOLE_SCOPE = "_console";

/**
 * Who an incident is about. **The machine copies this and never reads it.**
 *
 * §6.8 keys per `(environment, service)`. §6.8a adds `(scope, kind)` for the six
 * things that are not a service, and its whole content is that the identity was
 * the missing piece — *"a state machine with no key deduplicates nothing"*.
 *
 * The second member is a DATA ADDITION and no function body below changed to
 * admit it — {@link ADVANCE_READS_NO_SUBJECT_FIELD} is the executable half of
 * that claim, and §13 task 5.4a states the failure condition outright: *"if this
 * task finds itself writing a second state machine, it has gone wrong"*.
 *
 * `subjectKey` is the ONE place the shape is read, and it is read to compare two
 * subjects rather than to decide anything.
 */
export type IncidentSubject =
  | {
      readonly kind: "service";
      readonly environment: string;
      readonly service: string;
    }
  | {
      readonly kind: "console_health";
      /** An environment token, or {@link CONSOLE_SCOPE} for the console itself. */
      readonly scope: string;
      readonly health: ConsoleHealthKind;
    };

/**
 * A stable string for one subject — the equality this module needs, and nothing
 * more.
 *
 * Deliberately NOT a path, even though {@link incidentRecordPath} now exists
 * beside it. This is an identity token for a `throw` message and an equality
 * test; a path is a location, and conflating the two would make an equality
 * check depend on a runs root.
 *
 * The two arms cannot collide: the discriminator leads, and `CONSOLE_SCOPE`
 * cannot be an environment name.
 */
export function subjectKey(subject: IncidentSubject): string {
  return subject.kind === "service"
    ? `service:${subject.environment}/${subject.service}`
    : `console_health:${subject.scope}/${subject.health}`;
}

/**
 * What a CALLER may say an issue is — §6.7's first two rows.
 *
 * `coverage` is deliberately absent: it is minted by this module and by nothing
 * else, because the escalation that produces it is a property of
 * `consecutive_indeterminate`, which only the record knows. A verdict module that
 * could pass `coverage` in would be a second place the threshold is decided.
 *
 * §6.8a's six `kind` tokens are HERE as well as on the subject, and that is not
 * duplication: the subject says which record a sweep is about, and the reason
 * says what the record is open for. A console-health incident whose reason was
 * `unhealthy` would compose a notification saying an environment is unhealthy
 * when the fact is that an observer was blocked, which is §6.7 rule 3's
 * misdiagnosis family again. It remains a data addition — no `switch` below reads
 * the value, and {@link ADVANCE_READS_NO_ISSUE_REASON} asserts it by driving
 * every member through the same fixture.
 *
 * Spread rather than re-spelled, so a seventh `kind` cannot become a reason the
 * schema accepts and the subject does not.
 */
export const OBSERVED_ISSUE_REASONS = [
  "unhealthy",
  "degraded",
  ...CONSOLE_HEALTH_KINDS,
] as const;
export type ObservedIssueReason = (typeof OBSERVED_ISSUE_REASONS)[number];

/** What a RECORD may hold — the above, plus the escalation this module mints. */
export const ISSUE_REASONS = [...OBSERVED_ISSUE_REASONS, "coverage"] as const;
export type IssueReason = (typeof ISSUE_REASONS)[number];

/**
 * What one sweep learned about one subject.
 *
 * Four members, and the shape of each is the rule it enforces:
 *
 *  - **`issue`** — §6.7 rows 1 and 2. Confirmable; never notifies on its own.
 *  - **`observed_clear`** — §6.8's *"Recovery must be OBSERVED"*. The ONLY member
 *    that can move a record toward `clear`, and its `evidenceRef` is required and
 *    non-nullable so that an all-clear cannot be assembled out of an absence.
 *  - **`unobserved`** — §6.7 rows 4-5. *"'I could not see enough to tell you' is
 *    not 'it is broken'"*, and it is not "it is fine" either. It carries no
 *    payload, so nothing can be smuggled through it. It is also where §6.7's
 *    structural gate lands: a `healthy` row downgraded host-side to
 *    `indeterminate` and recorded as `unevidenced_healthy` arrives here, and this
 *    machine treats it exactly like any other blindness — which is §12's *"assert
 *    it does **not** clear a firing incident"*.
 *  - **`suppressed`** — §6.7 rule 3's ordering. A sweep marked `saturated` says
 *    nothing about any individual service, so *"a service's
 *    `consecutive_indeterminate` counter does not advance across a sweep marked
 *    saturated"*. See {@link advanceIncident} for how far that "does not advance"
 *    is taken, and why.
 */
export type IncidentSignal =
  | {
      readonly kind: "issue";
      readonly reason: ObservedIssueReason;
      /** The artifact the assessment came from, when the sweep produced one. */
      readonly evidenceRef: string | null;
    }
  | {
      readonly kind: "observed_clear";
      /**
       * REQUIRED and NON-NULLABLE. §6.7's structural gate has already downgraded
       * a `healthy` with an empty `coverage[]` or an empty evidence ledger to
       * `indeterminate` by the time an observation is built, so a clear that
       * reaches this machine has a ledger by construction. Typing it that way is
       * what makes §6.8's most expensive rule unremovable rather than merely
       * tested.
       */
      readonly evidenceRef: string;
    }
  | { readonly kind: "unobserved" }
  | { readonly kind: "suppressed" };

/** One sweep's reading of one subject. */
export interface IncidentObservation {
  readonly subject: IncidentSubject;
  /** §6.6 layer 3's echoed id. Carried into notifications; not interpreted here. */
  readonly sweepId: string;
  /** Epoch milliseconds. A PARAMETER — this phase has no clock. */
  readonly at: number;
  readonly signal: IncidentSignal;
}

/**
 * §6.8's four states. `flapping` is a state and not a comment — see §6.8.
 *
 * A frozen tuple as well as a type, so {@link IncidentRecordSchema} derives its
 * enum from the same four members rather than re-spelling them.
 */
export const INCIDENT_STATES = ["clear", "provisional", "firing", "flapping"] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

/**
 * §7.6's record, as a value.
 *
 * Task 5.5 adds the zod schema and the validated read — *"a malformed record
 * refuses rather than being acted on"* — over this same shape. `undelivered[]` is
 * declared here because §7.6 declares it and 5.6b fills it; **this module never
 * writes it**, on §6.9 requirement 7: *"a delivery failure never advances or
 * clears an incident"*, which is only true if the transition and the delivery
 * touch different fields.
 *
 * ## `since` and `sweep_count`, defined rather than implied
 *
 * §7.6 names both and defines neither, and the recovery notification spends both
 * — §6.8: *"how long it was firing, how many sweeps"*. So:
 *
 *  - **`since`** is when the CURRENT state began. On a recovery that makes
 *    `at - since` the firing duration, which is the number the sentence asks for.
 *  - **`sweep_count`** is the number of sweeps in which the issue was OBSERVED
 *    since the record last left `clear`. A sweep that could not see the service
 *    does not advance it: counting blind sweeps would let *"observed in 40
 *    sweeps"* be true of an incident nobody looked at, which is the same
 *    absence-as-evidence mistake §6.8 spends its longest paragraph on.
 *  - **`last_seen`** is the timestamp of the last sweep in which the issue was
 *    observed, for the same reason.
 */
export interface IncidentRecord {
  readonly subject: IncidentSubject;
  readonly state: IncidentState;
  /** What the incident is about while it is open; `null` in `clear`. */
  readonly reason: IssueReason | null;
  /** When the current state began. `null` only for a never-touched record. */
  readonly since: number | null;
  /** Last sweep that OBSERVED the issue. */
  readonly last_seen: number | null;
  /** Sweeps the issue was observed in since the record left `clear`. */
  readonly sweep_count: number;
  /** §6.7 row 5's counter. Reset by any sweep that saw the service either way. */
  readonly consecutive_indeterminate: number;
  /** §6.8's flap damping: timestamps of returns to `clear`, inside `flap_window`. */
  readonly flap_transitions: readonly number[];
  /** When this machine last composed anything for this subject. */
  readonly last_notified_at: number | null;
  /** 5.6b's. Declared here because §7.6 declares it; never written by this module. */
  readonly undelivered: readonly string[];
  readonly last_artifact_ref: string | null;
}

/**
 * The record for a subject nothing has ever been observed about.
 *
 * A factory rather than a constant, so that no two records alias one array —
 * `triage-config.ts` records the same hazard for zod's by-reference defaults:
 * *"a parsed config that aliases an exported constant is one whose mutation
 * reaches every other parse in the process."*
 */
export function freshIncidentRecord(subject: IncidentSubject): IncidentRecord {
  return {
    subject,
    state: "clear",
    reason: null,
    since: null,
    last_seen: null,
    sweep_count: 0,
    consecutive_indeterminate: 0,
    flap_transitions: [],
    last_notified_at: null,
    undelivered: [],
    last_artifact_ref: null,
  };
}

/**
 * The three §7.8 knobs this machine spends, NARROWED FROM the console config
 * rather than re-spelled.
 *
 * `Pick` makes the relationship a compile-time claim, on `PartitionRefusal`'s
 * precedent in `triage-partition.ts`: rename or delete any of the three in
 * `TriageConsoleConfigSchema` and this alias stops naming them, which reddens
 * every construction under `tsc --noEmit`. A local interface with three numbers
 * would let §7.8 and this module drift into two sets of defaults, which is
 * exactly what §12's *"a contract nothing is required to route through is a
 * second copy of the defaults"* is written against.
 */
export type IncidentPolicy = Pick<
  TriageConsoleConfig,
  "flap_threshold" | "flap_window_s" | "renotify_after_s"
>;

/**
 * §6.7 row 5's *"3+ consecutive, same service"*.
 *
 * NOT a knob, deliberately: §7.8 enumerates nine tuning values and this is not
 * one of them, so putting it in the config would be adding a tenth that §12's
 * grep criterion has no row for. Exported so a fixture can name it instead of
 * repeating the literal — a test that hard-codes `3` still passes when the
 * threshold moves and the machine changes meaning.
 *
 * **Three is also the confirmation.** §6.7 rule 1 requires *"two separated
 * observations"* before anything is announced; three consecutive blind sweeps is
 * more than two, so the escalation goes straight to `firing` rather than pausing
 * in `provisional` for a fourth. §12 fixes that reading: *"three fixture sweeps;
 * assert the THIRD notifies as a coverage issue"*.
 */
export const COVERAGE_THRESHOLD = 3;

/** What this machine composes. §6.9's `Announcement` is 5.6's, rendered FROM these. */
export type NotificationKind = "opened" | "recovered" | "flapping" | "reminder";

/**
 * A transition worth telling somebody about — a VALUE, not a rendered message.
 *
 * §6.9 keeps composition and rendering apart, and §4.3 is why: *"worker prose is
 * data, and a notification is the sharpest case yet"*. Nothing here is a
 * sentence, so nothing a container wrote can become one by passing through this
 * module.
 */
export interface IncidentNotification {
  readonly kind: NotificationKind;
  /** Copied from the record. §6.9's composer turns it into a subject and a scope. */
  readonly subject: IncidentSubject;
  /** What the incident is about. `coverage` here was minted by this module. */
  readonly reason: IssueReason;
  readonly at: number;
  readonly sweepId: string;
  /**
   * How long the incident had been in the state it is leaving or holding.
   * §6.8's *"how long it was firing"*. `0` when the state began on this sweep.
   */
  readonly firingForMs: number;
  /** §6.8's *"how many sweeps"* — sweeps the issue was OBSERVED in. */
  readonly sweepCount: number;
  /**
   * The artifact this notification rests on.
   *
   * NON-NULL on `recovered` by construction, because only an `observed_clear` —
   * whose `evidenceRef` is a required string — can produce one. §6.8: the
   * recovery says *"the evidence that closed it — with the word observed"*.
   */
  readonly evidenceRef: string | null;
}

/** What one sweep did to one record. */
export interface IncidentAdvance {
  readonly record: IncidentRecord;
  readonly notifications: readonly IncidentNotification[];
}

/**
 * Advance one subject's incident by one sweep.
 *
 * Pure, total, and the only writer of {@link IncidentRecord}'s state fields.
 *
 * ## The transitions, and which of them speak (§6.8's table)
 *
 * | from → to | notifies | why |
 * |---|---|---|
 * | `clear → provisional` | no | §6.7 rule 1. *"One observation is not a finding"* |
 * | `provisional → firing` | **`opened`** | confirmed on a second observation |
 * | `provisional → clear` | no | *"resolved before it was confirmed; recorded, not announced"* |
 * | `firing → firing` | no | *"the rule that turns 288 into 1"* |
 * | `firing → clear` | **`recovered`** | and only from an `observed_clear` |
 * | `* → flapping` | **`flapping`**, once | replaces the notification that transition would have sent |
 * | `flapping → clear` | **`recovered`** | after `flap_window` of stability |
 * | `flapping → firing` | **`opened`**, once | after `flap_window` with no observed clear |
 * | `firing` held | **`reminder`** | at most one per `renotify_after` |
 *
 * ## A flap transition is any return to `clear`, not only `firing → clear → firing`
 *
 * §6.8 describes the damping in terms of `firing → clear → firing` round trips,
 * because the notification storm is the failure it was written against. Counting
 * only those leaves the case §12 actually asks for uncounted: *"a service
 * alternating EVERY sweep"* never reaches `firing` at all, because §6.7 rule 1's
 * confirmation catches it one state earlier — so a machine that only counted
 * `firing → clear` would emit zero for twenty sweeps and satisfy *"does not
 * notify every sweep"* while never reaching `flapping`, which §12 requires in the
 * same sentence.
 *
 * So a transition is appended whenever the record LEAVES an issue-side state for
 * `clear`, `provisional → clear` included. That is the same finding under both
 * readings — §6.8's own words for what the state is worth are *"a service that
 * cannot make up its mind is a different finding from a service that is down"* —
 * and a service oscillating below the confirmation threshold is the purest
 * instance of it.
 *
 * The count is `> flap_threshold`, on §6.8's literal *"more than `flap_threshold`
 * (default 3) … round trips"*.
 *
 * ## `suppressed` returns the record UNCHANGED, identity included
 *
 * §6.7 rule 3 requires that `consecutive_indeterminate` not advance across a
 * saturated sweep. This takes that further and moves nothing at all — no counter,
 * no timestamp, and not the `renotify_after` floor either. A sweep in which the
 * inference server was the fault carries no information about the cluster, and
 * the cost of the stricter reading is bounded at one cadence of reminder latency,
 * against a saturation incident of its own (§6.8a `inference_saturated`) that is
 * firing at the same moment and is the message the operator needs. Returning the
 * caller's own object makes that assertable by identity rather than by a
 * field-by-field comparison that could miss a new field.
 *
 * ## `flapping → firing`, and it spends `flap_window` in the other direction
 *
 * §6.8's transition table was missing this edge, and the hole it left is the one
 * §6.8 now calls *"the worst shape a notifier has"*: a service that flaps and then
 * goes HARD DOWN was silent indefinitely — not stable, so `flapping → clear` never
 * fires; not `firing`, so the re-notify floor never reaches it. *"The service that
 * most needs attention is the one that goes quiet."*
 *
 * The repair adds **no knob and no field**. `flap_window` already means *"how long
 * a thing must hold before I believe it"*, and §6.8's table spends it on stability
 * in one direction and on instability in the other:
 *
 * | direction | condition over `flap_window` | result |
 * |---|---|---|
 * | `flapping → clear` | no transitions, and the state observed is healthy | `recovered` |
 * | `flapping → firing` | no transitions, and no observed clear | `opened`, ONCE, and the floor restarts |
 *
 * **`flap_transitions[]` is the condition, and that is why a clear observed while
 * `flapping` is now appended to it.** §7.6 already defines the field as
 * *"timestamps inside `flap_window`"* and this module already prunes it on every
 * advance, so an EMPTY list is precisely *"no transition in the last
 * `flap_window`"* — but only if the clears this record keeps seeing go into it.
 * Without the append the list merely ages out, a still-alternating service empties
 * it, and the edge re-opens a service that never stopped flapping. **That is the
 * anti-twin §13 task 5.4b grades this on**, and it is the reason the append is part
 * of the edge rather than incidental to it. Entries added while `flapping` cannot
 * reach a future `flap_threshold`: the list is emptied on the way out to `clear`.
 */
export function advanceIncident(
  record: IncidentRecord,
  observation: IncidentObservation,
  policy: IncidentPolicy,
): IncidentAdvance {
  if (subjectKey(record.subject) !== subjectKey(observation.subject)) {
    /*
     * A HOST bug, so a throw: the caller loaded one subject's record and handed
     * it another subject's sweep, and continuing would write `authorization`'s
     * state into `authentication`'s file. `triage-partition.ts` draws the same
     * line — a value for untrusted container output, a throw for a host argument
     * that is wrong for the life of the run.
     */
    throw new Error(
      `incident record for ${subjectKey(record.subject)} was handed an observation for ` +
        `${subjectKey(observation.subject)}. The record is keyed per subject (§6.8) and ` +
        `advancing it with another subject's sweep would write one service's state into ` +
        `another's file.`,
    );
  }

  // §6.7 rule 3's ordering, and the earliest possible return: nothing moves.
  if (observation.signal.kind === "suppressed") {
    return { record, notifications: [] };
  }

  const at = observation.at;
  const windowMs = policy.flap_window_s * 1_000;
  // Pruned on every advance, so `flap_transitions[]` means what §7.6 says it
  // means — "timestamps inside `flap_window`" — rather than growing forever and
  // being filtered at read time by whoever remembers to.
  const transitions = record.flap_transitions.filter((t) => t > at - windowMs);

  switch (observation.signal.kind) {
    case "issue":
      return onIssue(record, observation, policy, transitions, observation.signal);
    case "observed_clear":
      return onObservedClear(record, observation, policy, transitions, observation.signal);
    case "unobserved":
      return onUnobserved(record, observation, policy, transitions);
  }
}

/** §6.7 rows 1-2: the service is not doing its job, and we could see that. */
function onIssue(
  record: IncidentRecord,
  observation: IncidentObservation,
  policy: IncidentPolicy,
  transitions: readonly number[],
  signal: Extract<IncidentSignal, { kind: "issue" }>,
): IncidentAdvance {
  const at = observation.at;
  const base = {
    ...record,
    consecutive_indeterminate: 0,
    flap_transitions: transitions,
    last_seen: at,
    last_artifact_ref: signal.evidenceRef ?? record.last_artifact_ref,
  };

  switch (record.state) {
    /*
     * §6.7 rule 1, and the criterion §12 puts first in this block: "A first
     * `unhealthy` observation notifies nothing." One observation is not a
     * finding, so the record moves and the console stays quiet.
     */
    case "clear":
      return {
        record: {
          ...base,
          state: "provisional",
          reason: signal.reason,
          since: at,
          sweep_count: 1,
        },
        notifications: [],
      };

    /*
     * CONFIRMED. The one place an `opened` notification is composed, and §6.7
     * rule 1's *"A notification fires on confirmation, never on the first
     * observation"* is the whole of why it is here and not one case above.
     */
    case "provisional": {
      const sweepCount = record.sweep_count + 1;
      return {
        record: {
          ...base,
          state: "firing",
          reason: signal.reason,
          since: at,
          sweep_count: sweepCount,
          last_notified_at: at,
        },
        notifications: [
          {
            kind: "opened",
            subject: record.subject,
            reason: signal.reason,
            at,
            sweepId: observation.sweepId,
            firingForMs: 0,
            sweepCount,
            evidenceRef: signal.evidenceRef,
          },
        ],
      };
    }

    /*
     * `firing → firing`. §6.8: *"`last_seen` and `sweep_count` advance and
     * nothing is sent. This is the rule that turns 288 into 1"* — and the
     * `reminder` below is the deliberate exception, floored at `renotify_after`.
     *
     * The `reason` is NOT overwritten. An incident that opened as `unhealthy`
     * and is now observed `degraded` is the same incident at a lower amplitude
     * (§6.7 puts both on one axis), and rewriting the reason mid-incident would
     * make the eventual recovery notification name something the `opened` one
     * never said.
     */
    case "firing": {
      const advanced: IncidentRecord = { ...base, sweep_count: record.sweep_count + 1 };
      return withReminder(advanced, observation, policy);
    }

    /*
     * `flapping` is QUIET. §6.8: the record *"goes quiet until the service has
     * been stable for a full `flap_window`"*, and an issue is not stability. The
     * counters still advance so the eventual recovery can say how much of this
     * there was.
     *
     * Quiet, that is, UNTIL the window empties. §6.8's `flapping → firing` row is
     * the other half of the same window: a service still being seen bad with no
     * observed clear behind it for a full `flap_window` has stopped flapping and
     * settled into being down, and this is the sweep that says so.
     */
    case "flapping": {
      const advanced: IncidentRecord = { ...base, sweep_count: record.sweep_count + 1 };
      if (transitions.length === 0) {
        return settleFlappingIntoFiring(advanced, observation, signal.evidenceRef);
      }
      return { record: advanced, notifications: [] };
    }
  }
}

/**
 * §6.8's `flapping → firing` — *"the open notification, **once**, and the
 * re-notify floor restarts"*.
 *
 * Called only with a record whose pruned `flap_transitions[]` is empty, which is
 * the table's *"no transitions, and no observed clear"* over one `flap_window`.
 * Two properties are the whole of the row and both are structural rather than
 * commented:
 *
 *  - **ONCE.** The record leaves `flapping` for `firing`, so the next bad sweep is
 *    `firing → firing` — *"the rule that turns 288 into 1"*. A machine that stayed
 *    `flapping` and emitted would re-open every sweep, and §13 task 5.4b names
 *    that as the failure the anti-twin fixture exists to catch.
 *  - **THE FLOOR RESTARTS.** `last_notified_at` is stamped `at`, so the first
 *    reminder is one `renotify_after` past THIS open rather than past the flapping
 *    notice that preceded it. Both readings emit the same NUMBER of reminders over
 *    a day, which is why the fixture asserts their instants by value.
 *
 * `firingForMs` is `0` on `provisional → firing`'s rule: the state being reported
 * began on this sweep. `evidenceRef` is the SWEEP's, and `null` when the sweep saw
 * nothing — citing the artifact that closed the previous good sweep would attach a
 * clean report to an open.
 */
function settleFlappingIntoFiring(
  base: IncidentRecord,
  observation: IncidentObservation,
  evidenceRef: string | null,
): IncidentAdvance {
  const at = observation.at;
  const reason = base.reason ?? "unhealthy";
  return {
    record: {
      ...base,
      state: "firing",
      reason,
      since: at,
      flap_transitions: [],
      last_notified_at: at,
    },
    notifications: [
      {
        kind: "opened",
        subject: base.subject,
        reason,
        at,
        sweepId: observation.sweepId,
        firingForMs: 0,
        sweepCount: base.sweep_count,
        evidenceRef,
      },
    ],
  };
}

/**
 * §6.8's *"Recovery must be OBSERVED"* — the ONLY path back to `clear`.
 *
 * Reachable only from `observed_clear`, whose `evidenceRef` is a required string,
 * so every `recovered` notification this function composes carries the artifact
 * that closed it.
 */
function onObservedClear(
  record: IncidentRecord,
  observation: IncidentObservation,
  policy: IncidentPolicy,
  transitions: readonly number[],
  signal: Extract<IncidentSignal, { kind: "observed_clear" }>,
): IncidentAdvance {
  const at = observation.at;
  const base = {
    ...record,
    consecutive_indeterminate: 0,
    last_artifact_ref: signal.evidenceRef,
  };

  switch (record.state) {
    // Nothing was open. A clear sweep on a clear record is the ordinary case,
    // 288 times a day, and it must cost nothing and say nothing.
    case "clear":
      return {
        record: { ...base, flap_transitions: transitions },
        notifications: [],
      };

    case "provisional":
    case "firing": {
      const oscillations = [...transitions, at];
      const firingForMs = record.since === null ? 0 : at - record.since;
      const reason = record.reason ?? "unhealthy";

      /*
       * FLAP DAMPING WINS THE TRANSITION, and sends ONE notification instead of
       * the one this edge would otherwise have sent — §6.8: *"marks the record
       * `flapping`, emits **one** notification saying so, and goes quiet"*.
       *
       * Emitting both would defeat the refinement on the very sweep it fires:
       * the operator would get a recovery AND a flapping notice for a service
       * that is about to go bad again.
       */
      if (oscillations.length > policy.flap_threshold) {
        return {
          record: {
            ...base,
            state: "flapping",
            reason,
            since: at,
            sweep_count: 0,
            flap_transitions: oscillations,
            last_notified_at: at,
          },
          notifications: [
            {
              kind: "flapping",
              subject: record.subject,
              reason,
              at,
              sweepId: observation.sweepId,
              firingForMs,
              sweepCount: record.sweep_count,
              evidenceRef: signal.evidenceRef,
            },
          ],
        };
      }

      const cleared: IncidentRecord = {
        ...base,
        state: "clear",
        reason: null,
        since: at,
        sweep_count: 0,
        flap_transitions: oscillations,
        // Only a CONFIRMED incident is announced as recovered; an unconfirmed one
        // is §6.8's *"recorded, not announced"*, so it must not move the
        // `renotify` clock either.
        last_notified_at: record.state === "firing" ? at : record.last_notified_at,
      };
      return {
        record: cleared,
        notifications:
          record.state === "firing"
            ? [
                {
                  kind: "recovered",
                  subject: record.subject,
                  reason,
                  at,
                  sweepId: observation.sweepId,
                  firingForMs,
                  sweepCount: record.sweep_count,
                  evidenceRef: signal.evidenceRef,
                },
              ]
            : [],
      };
    }

    /*
     * `flapping → clear`, and the bar is a FULL `flap_window` OF STABILITY
     * (§6.8) — not merely one good sweep.
     *
     * The clock is `last_seen`, used for exactly what §7.6 says it is: the last
     * sweep in which the issue was OBSERVED. A service still alternating
     * refreshes it every other sweep and can never satisfy the window, which is
     * the whole content of *"goes quiet until the service has been stable"*; a
     * service that has genuinely settled stops refreshing it and clears one
     * window later.
     *
     * `flap_transitions[]` is deliberately NOT the clock here. It counts ROUND
     * TRIPS toward `flap_threshold`, and its entries age out of the window on
     * their own — so a still-alternating record would empty it and read as
     * stable, which is the opposite of the truth. That is a real trace, not a
     * hypothetical: with a 300s cadence and the 1h default, twenty alternating
     * sweeps empty a four-entry list by sweep twenty and would have composed a
     * SECOND notification — a recovery, for a service that had not recovered.
     *
     * The oscillation record is dropped on the way out. Carrying a finished
     * episode's timestamps into the next `clear` would let one later round trip
     * re-trip a threshold four round trips earned.
     */
    case "flapping": {
      const lastBad = record.last_seen ?? at;
      if (at - lastBad < policy.flap_window_s * 1_000) {
        /*
         * NOT YET STABLE, and THIS CLEAR IS RECORDED — the line the
         * `flapping → firing` edge rests on.
         *
         * §6.8's other direction asks whether there was *"no observed clear"*
         * across a `flap_window`, and an empty `flap_transitions[]` is that
         * question already answered, because the list is pruned to the window on
         * every advance. It is only the right answer if the clears a flapping
         * service keeps producing go into it. They are transitions in every sense
         * that matters here: the record sits in `flapping` precisely BECAUSE it
         * keeps returning to a clear observation, and the state is a stand-in for
         * that oscillation rather than a denial of it.
         *
         * Omitting the append is not a smaller change, it is a different one: the
         * list would merely age out, a service alternating forever would empty it
         * one window after the flapping notice, and the edge would re-open a
         * service that never settled. That is the anti-twin fixture, and it is
         * the reason this line is part of task 5.4b.
         *
         * These entries cannot reach a future `flap_threshold`: the list is
         * emptied on the way out to `clear`, in the branch just below.
         */
        return {
          record: { ...base, flap_transitions: [...transitions, at] },
          notifications: [],
        };
      }
      const reason = record.reason ?? "unhealthy";
      return {
        record: {
          ...base,
          state: "clear",
          reason: null,
          since: at,
          sweep_count: 0,
          flap_transitions: [],
          last_notified_at: at,
        },
        notifications: [
          {
            kind: "recovered",
            subject: record.subject,
            reason,
            at,
            sweepId: observation.sweepId,
            firingForMs: record.since === null ? 0 : at - record.since,
            sweepCount: record.sweep_count,
            evidenceRef: signal.evidenceRef,
          },
        ],
      };
    }
  }
}

/**
 * §6.7 rows 4-5 — *"I could not see enough to tell you"*.
 *
 * **This function is the one §12 calls the criterion that stops the most damaging
 * message this console could send**, and it is short because the type did the
 * work: there is no `evidenceRef` in scope here, so there is nothing a recovery
 * could be built out of. A `firing` record stays `firing`.
 */
function onUnobserved(
  record: IncidentRecord,
  observation: IncidentObservation,
  policy: IncidentPolicy,
  transitions: readonly number[],
): IncidentAdvance {
  const at = observation.at;
  const blind = record.consecutive_indeterminate + 1;
  const base: IncidentRecord = {
    ...record,
    consecutive_indeterminate: blind,
    flap_transitions: transitions,
  };

  /*
   * THE COVERAGE ESCALATION. §6.7: *"fifteen minutes of not being able to see a
   * service is a finding about the console, and it must not be silent"*.
   *
   * **The STATE guard is what makes this fire once, and the comparison is
   * deliberately `>=` rather than `===`.** A record already `firing` on
   * `unhealthy` is not re-announced as a coverage issue: it is one incident, §6.8
   * says it *"stays `firing` with its coverage gap recorded"*, and the gap is
   * recorded in `consecutive_indeterminate` above. That guard alone turns a day
   * of invisibility into one notification, so `===` buys nothing on any record
   * this machine wrote — a MUTATION BATTERY confirmed the two spellings
   * indistinguishable across every fixture, which is what sent this comment back
   * to be rewritten.
   *
   * It is not indistinguishable on a record this machine did NOT write. Task
   * 5.5 reads these from disk, and a record carrying `state: "clear"` with a
   * counter already past the threshold — an older build, a partial write, a hand
   * edit — is one that `===` would step over forever, leaving a service
   * permanently invisible and permanently silent. `>=` escalates it on the next
   * sweep, which is the direction a console whose whole job is noticing absence
   * has to fail in.
   *
   * **`flapping` was NOT in this guard until task 5.4c, and its absence was the
   * same oversight as the missing `flapping → firing` row.** Both came from a
   * table that treated `flapping` as terminal. A flapping service that goes
   * invisible is exactly what this escalation is for — *"I could not see enough
   * to tell you"* — and routing it here rather than through the settle edge is
   * what lets the notification say `coverage` instead of repeating the record's
   * last observed reason. Announcing `unhealthy` when the fact is *"we could not
   * see it"* is §6.7 rule 3's misdiagnosis family in miniature, and this console
   * exists to distinguish the two.
   *
   * Adding one state to a threshold that was already chosen is **not a new
   * judgement**, which is what made it safe to add here rather than defer.
   *
   * The oscillation record is dropped on the way out, for the reason
   * `flapping → clear` drops it: carrying a finished episode's timestamps into
   * the next state would let one later round trip re-trip a threshold that four
   * round trips earned. A `clear` or `provisional` record keeps its partial
   * history, because nothing there is finished.
   */
  if (
    blind >= COVERAGE_THRESHOLD &&
    (record.state === "clear" || record.state === "provisional" || record.state === "flapping")
  ) {
    return {
      record: {
        ...base,
        state: "firing",
        reason: "coverage",
        since: at,
        sweep_count: 0,
        flap_transitions: record.state === "flapping" ? [] : transitions,
        last_notified_at: at,
      },
      notifications: [
        {
          kind: "opened",
          subject: record.subject,
          reason: "coverage",
          at,
          sweepId: observation.sweepId,
          firingForMs: 0,
          sweepCount: 0,
          // Nothing was seen, so nothing is cited. A coverage issue that named an
          // artifact would be naming one that does not exist.
          evidenceRef: null,
        },
      ],
    };
  }

  /*
   * **There is deliberately NO `flapping → firing` edge here, and task 5.4c
   * removed the one there was.**
   *
   * The literal reading of §6.8's row — *"no transitions, and no observed
   * clear"* — is satisfied by a window in which nothing was seen at all, so
   * settling on blindness was defensible and shipped first. What it could not do
   * is say the true thing: `settleFlappingIntoFiring` carries the record's last
   * observed reason, so a service that flapped and then went INVISIBLE was
   * announced as `unhealthy`.
   *
   * The escalation above now covers that case with the right word and sooner —
   * `COVERAGE_THRESHOLD` sweeps rather than a full `flap_window`, which at the
   * shipped defaults is fifteen minutes rather than an hour. **Removing this
   * branch closes no hole**, and the two paths no longer overlap: blindness
   * escalates as `coverage`, an observed issue settles with what was seen.
   *
   * Requiring the settling sweep to have SEEN something is therefore not the
   * silent-forever risk it looked like when 5.4b weighed it. It was, until the
   * guard above admitted `flapping`.
   */

  /*
   * Everything else HOLDS. `provisional` does not fall back to `clear` on a blind
   * sweep — §6.7 rule 1 asks for two SEPARATED observations rather than two
   * adjacent ones, so the confirmation is still pending — and `firing` does not
   * recover, which is the rule this whole module is arranged around.
   */
  return withReminder(base, observation, policy);
}

/**
 * §6.8's re-notify floor — *"While `firing`, one reminder every
 * `renotify_after`"*.
 *
 * Applied only to a record that is `firing` after this sweep and only when
 * nothing else was composed, so it can never double up with an `opened` or a
 * `recovered`. `0` disables, per §7.8.
 *
 * `>=` and not `>`: the floor is *"at most once per `renotify_after`"*, and a
 * sweep landing exactly on the boundary is the boundary. At the 6h default
 * against a 300s cadence, one of every 72 sweeps can carry a reminder and the
 * other 71 cannot, which is the arithmetic §6.8a states as *"4 messages in 24h …
 * rather than 288"*.
 *
 * The clock runs from `last_notified_at`, so the FIRST reminder is
 * `renotify_after` past the `opened` notification rather than past the incident's
 * start. A reminder that arrived one cadence after the open would be the noise
 * this floor exists to prevent.
 */
function withReminder(
  record: IncidentRecord,
  observation: IncidentObservation,
  policy: IncidentPolicy,
): IncidentAdvance {
  if (record.state !== "firing") return { record, notifications: [] };
  if (policy.renotify_after_s === 0) return { record, notifications: [] };
  const last = record.last_notified_at;
  if (last === null) return { record, notifications: [] };
  const at = observation.at;
  if (at - last < policy.renotify_after_s * 1_000) return { record, notifications: [] };

  const reason = record.reason ?? "unhealthy";
  return {
    record: { ...record, last_notified_at: at },
    notifications: [
      {
        kind: "reminder",
        subject: record.subject,
        reason,
        at,
        sweepId: observation.sweepId,
        firingForMs: record.since === null ? 0 : at - record.since,
        sweepCount: record.sweep_count,
        evidenceRef: record.last_artifact_ref,
      },
    ],
  };
}

/**
 * The claim that task 5.4a rests on, stated where a reader will find it.
 *
 * Neither constant is read by any code path; both are read by
 * `test/unit/triage-incident.test.ts`, which drives the fixtures they name and
 * asserts the machine's output does not vary with the field in question. They are
 * here rather than in the test file so that the claim and the code it is about
 * live together — a promise in a test file is one a reader of this module never
 * sees.
 */
export const ADVANCE_READS_NO_SUBJECT_FIELD =
  "advanceIncident copies IncidentSubject and never inspects a field of it, so §6.8a's " +
  "(scope, kind) identity is a union member rather than a second machine (§13 task 5.4a).";

/** The same claim for the reason token. See {@link ObservedIssueReason}. */
export const ADVANCE_READS_NO_ISSUE_REASON =
  "advanceIncident copies ObservedIssueReason into the record and into every notification " +
  "and never branches on it, so §6.8a's six kinds are a data addition (§13 task 5.4a).";

// ---------------------------------------------------------------------------
// §7.6 — the record on disk, and the validated read (§13 task 5.5)
// ---------------------------------------------------------------------------

/**
 * §7.6: *"Zod-validated on read, so a malformed record refuses rather than being
 * acted on — SRD-FLEET-PM-001 Phase 5 task 5.4's rule."*
 *
 * ## This is not hygiene, and `onUnobserved`'s comparison is the proof
 *
 * `onUnobserved`'s coverage escalation is spelled `blind >= COVERAGE_THRESHOLD`,
 * and a mutation battery found `>=` and `===` **indistinguishable on every record
 * the machine itself wrote** — because the counter is incremented by one per
 * sweep and reset on every observation, so it passes through the threshold
 * exactly. The two spellings part company on precisely one class of input: a
 * record read from DISK whose counter is already past the threshold, where `===`
 * steps over it forever and leaves a service permanently invisible and
 * permanently silent.
 *
 * **Everything below is what makes that class of record reachable**, so the
 * schema is not a formality standing between the machine and its own outputs. It
 * is what stands between a hand-edited, half-written or older-build record and a
 * state machine whose every branch assumes its inputs are its own outputs.
 *
 * ## Which is why there is NO cross-field refinement here, deliberately
 *
 * A `state: "clear"` record carrying `consecutive_indeterminate: 40`, or a `clear`
 * record with a non-null `reason`, is internally inconsistent — and refusing it
 * would delete the input class this task exists to admit. A `.superRefine` that
 * "tidied" such a record would put the validator in the business of deciding what
 * the machine should have written, and the machine already answers every one of
 * those shapes: the escalation is `>=`, and `record.reason ?? "unhealthy"` covers
 * a missing reason. The schema checks TYPES and DOMAINS. It does not reconcile.
 *
 * ## What refuses, and each name reachable by exactly one fault
 *
 * Four codes, ordered so that no fixture has to be wrong twice to reach the
 * third: bytes that are not JSON never reach the object check, a non-object never
 * reaches the schema, and a record that fails the schema never reaches the
 * subject comparison.
 */
export const INCIDENT_RECORD_SCHEMA = "pifleet.triageincident/v1";

/**
 * One record's worth of `flap_transitions[]`, bounded.
 *
 * `advanceIncident` prunes the list to `flap_window` on every advance, so a live
 * record holds at most `flap_window_s / cadence_s` entries — twelve at the shipped
 * defaults. The cap is three orders of magnitude above that because it is not a
 * policy: it is the bound that stops a corrupt or hand-written file turning a read
 * into an unbounded allocation, and a cap near the working figure would refuse a
 * legitimate record the day an operator shortened the cadence.
 */
export const MAX_FLAP_TRANSITIONS = 4096;

/** The same bound for 5.6b's backlog, and for the same reason. */
export const MAX_UNDELIVERED = 4096;

/**
 * Absent, or present and wrong.
 *
 * **Deliberately the same three tokens `triage-document.ts` spends**, so an actor
 * can log and count a refusal without knowing which of the two files produced it.
 * That is `dispatch-request.ts:879-917`'s rule for refusal vocabularies — one
 * alphabet, *"whichever module spends them"* — and the two are held identical by
 * an assertion in `test/unit/triage-incident.test.ts` rather than by a comment,
 * because the implementations are deliberately NOT shared: importing §7.5's
 * document reader here would pull the targets and verdict modules into this
 * module's transitive closure for the sake of seven lines, and §12's read-only
 * criterion walks that closure.
 */
export const INCIDENT_RECORD_FAULTS = ["missing", "invalid", "unrecognized"] as const;
export type IncidentRecordFault = (typeof INCIDENT_RECORD_FAULTS)[number];

export interface IncidentRecordIssue {
  /** Dotted, `subject.environment`. `""` is the record itself. */
  readonly path: string;
  readonly fault: IncidentRecordFault;
  readonly message: string;
}

/** Why a record on disk was refused, as a value rather than as prose. */
export type IncidentRecordRefusal =
  | "not_json"
  | "not_an_object"
  | "schema"
  /**
   * The record parsed, and it is about somebody else.
   *
   * Its own arm rather than a schema issue, because it is the only refusal here
   * that depends on WHERE the file was found. `advanceIncident` throws on this
   * pairing — a host bug, the caller loaded the wrong file — and catching it at
   * read time turns the throw into something a polling actor can log, which is
   * the same value-versus-throw split `triage-partition.ts` draws.
   */
  | "subject_mismatch";

/**
 * The three outcomes, and `missing` is not a failure.
 *
 * A subject nothing has ever been observed about has no file, and that is the
 * ordinary state on a console's first sweep for every service it watches. It
 * resolves to {@link freshIncidentRecord} at the loader rather than here, so the
 * parse stays a pure function of bytes.
 *
 * **There is no fallback from `refused` to a fresh record, and that is the
 * decision this type exists to make unavailable.** Falling back would turn a
 * hand-edited or half-written file into a silent reset: a `firing` incident would
 * become `clear`, the recovery notification would never be sent, and the next bad
 * sweep would re-open it as new. §7.6's *"refuses rather than being acted on"* is
 * exactly that, and a `record` field on the refused arm would make ignoring it a
 * one-character mistake.
 */
export type IncidentRecordRead =
  | { kind: "ok"; record: IncidentRecord }
  | {
      kind: "refused";
      code: IncidentRecordRefusal;
      reason: string;
      issues: readonly IncidentRecordIssue[];
    };

/**
 * An environment key, a service name or a scope — the grammar
 * `triage/targets.yaml` holds all three to.
 *
 * `SESSION_ID_RE` is a traversal refusal rather than a naming convention here,
 * for the reason `triage-targets.ts:102-117` states: the value *"becomes a path
 * segment under ~/.pifleet/triage/, so a name carrying a slash, a space or a
 * leading dot is a directory traversal rather than a label"*. A record read off
 * disk is exactly where an unchecked one would arrive, since the targets file
 * that vetted the live names never saw this file.
 */
const recordToken = z
  .string()
  .min(1)
  .max(64)
  .regex(SESSION_ID_RE, "must be a bare token — it becomes a path segment under ~/.pifleet/triage/");

/** `recordToken`, or §6.8a's literal console scope, which begins with `_`. */
const scopeToken = z.union([z.literal(CONSOLE_SCOPE), recordToken]);

/** Epoch milliseconds. Integral and non-negative; a clock is not a float. */
const epochMs = z.number().int().nonnegative();

/** A non-negative count. */
const counter = z.number().int().nonnegative();

const SubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("service"),
      environment: recordToken,
      service: recordToken,
    })
    .strict(),
  z
    .object({
      kind: z.literal("console_health"),
      scope: scopeToken,
      health: z.enum(CONSOLE_HEALTH_KINDS),
    })
    .strict(),
]);

/**
 * §7.6's record, as a schema over the same shape {@link IncidentRecord} declares.
 *
 * Every closed set is DERIVED — `z.enum(INCIDENT_STATES)`, `z.enum(ISSUE_REASONS)`,
 * `z.enum(CONSOLE_HEALTH_KINDS)` — rather than re-spelled, so a fifth state or a
 * seventh `kind` widens the schema in the same commit that widens the constant or
 * not at all. A re-spelled list is a second copy of a decision, and this
 * repository has the receipts for what those cost.
 *
 * **`subject` and `reason` are fields §7.6's own list does not name.** They are
 * on `IncidentRecord` because round 7 put them there and the recovery
 * notification spends both; §7.6 enumerates nine fields and neither is among
 * them. Recorded here rather than silently reconciled — see the round report.
 *
 * `.strict()`: an unrecognised key means the file was written by a build whose
 * record shape this one does not implement, and a reader cannot know whether the
 * part it could not read was the load-bearing part.
 */
export const IncidentRecordSchema = z
  .object({
    subject: SubjectSchema,
    state: z.enum(INCIDENT_STATES),
    reason: z.enum(ISSUE_REASONS).nullable(),
    since: epochMs.nullable(),
    last_seen: epochMs.nullable(),
    sweep_count: counter,
    consecutive_indeterminate: counter,
    flap_transitions: z.array(epochMs).max(MAX_FLAP_TRANSITIONS),
    last_notified_at: epochMs.nullable(),
    undelivered: z.array(z.string().max(4096)).max(MAX_UNDELIVERED),
    last_artifact_ref: z.string().max(4096).nullable(),
  })
  .strict();

/**
 * Where §7.6's and §6.8a's records live.
 *
 * `~/.pifleet/triage/` by default, and beside the runs root rather than inside it
 * — `relayRecordPath`'s placement and its reason: inside would put non-run
 * directories in the tree `runIdsAscending` enumerates, *"which is how a stray
 * filename becomes a run id and then a path segment"*. It follows
 * `PIFLEET_RUNS_DIR`, so a test never touches the operator's own.
 */
export function incidentRecordRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dirname(runsRoot(env)), "triage");
}

/** A subject that cannot become a path. Thrown, never returned. */
export class IncidentPathError extends Error {
  constructor(field: string, value: string) {
    super(
      `${field} ${JSON.stringify(value)} cannot be spelled as a path segment, so no incident ` +
        `record path was built from it. Both halves of a record's location are segments under ` +
        `~/.pifleet/triage, and \`join\` resolves ".." rather than refusing it — so an unchecked ` +
        `name here reads or writes a file of the caller's choosing. The grammar is 1-64 ` +
        `characters of letters, digits, ".", "_" or "-", beginning and ending alphanumeric.`,
    );
    this.name = "IncidentPathError";
  }
}

/**
 * §7.6's `<env>/<service>.json` and §6.8a's `<scope>/_console/<kind>.json`.
 *
 * ## It THROWS on a segment it cannot spell, and a bare `join` is why
 *
 * `dispatchRequestPath`'s argument, measured there rather than hypothesised:
 * *"`join` is not a containment predicate — it is string arithmetic that resolves
 * `..` cheerfully"*, and it returned `/etc/dispatch-request.json` for a traversal
 * id without a word. The refusal belongs in the builder rather than in each
 * caller's memory of it, **including callers that do not exist yet** — the actor
 * is task 6.1.
 *
 * That the live names came through `triage/targets.yaml`, which holds them to the
 * same grammar, is not a reason to omit the check: a subject can also be
 * reconstructed from a record read off disk, and that record never met the
 * targets file. {@link parseIncidentRecord} refuses such a name as a VALUE first,
 * so this throw is the second of two independent gates rather than the only one.
 *
 * A `console_health` subject needs no guard on its `health`: it is a closed enum
 * of six literals, none of which contains a separator.
 */
export function incidentRecordPath(
  subject: IncidentSubject,
  env: Record<string, string | undefined> = process.env,
): string {
  const root = incidentRecordRoot(env);
  if (subject.kind === "service") {
    if (!spellable(subject.environment)) throw new IncidentPathError("environment", subject.environment);
    if (!spellable(subject.service)) throw new IncidentPathError("service", subject.service);
    return join(root, subject.environment, `${subject.service}.json`);
  }
  if (subject.scope !== CONSOLE_SCOPE && !spellable(subject.scope)) {
    throw new IncidentPathError("scope", subject.scope);
  }
  return join(root, subject.scope, CONSOLE_SCOPE, `${subject.health}.json`);
}

function spellable(value: string): boolean {
  return value.length > 0 && value.length <= 64 && SESSION_ID_RE.test(value);
}

/**
 * Parse the bytes of one incident record, for the subject the caller expected.
 *
 * Returns a REFUSAL rather than throwing. The bytes are a file, and a file can be
 * hand-edited, truncated by a crash mid-write, or left behind by a build whose
 * record shape differed — none of which is a reason to end the actor's loop, and
 * all of which are reasons not to act on it.
 *
 * `expected` is what makes `subject_mismatch` decidable, and it is a REQUIRED
 * parameter rather than an optional one on `relayRecordPath`'s reasoning: the
 * caller that forgets the argument is the caller that acts on another service's
 * state, and it would compile.
 */
export function parseIncidentRecord(
  text: string,
  expected: IncidentSubject,
  path: string,
): IncidentRecordRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return {
      kind: "refused",
      code: "not_json",
      reason: `${path} is not JSON: ${(err as Error).message}`,
      issues: [],
    };
  }

  // `typeof null` is `"object"` and an array is an object, so both are spelled
  // out; a truncated write produces one or the other often enough to name them.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "refused",
      code: "not_an_object",
      reason: `${path} holds ${shapeOf(raw)} rather than a §7.6 incident record object.`,
      issues: [],
    };
  }

  const result = IncidentRecordSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.flatMap((issue): IncidentRecordIssue[] => {
      const segments = issue.path.map(String);
      if (issue.code === "unrecognized_keys") {
        return (issue as unknown as { keys: string[] }).keys.map((key) => ({
          path: [...segments, key].join("."),
          fault: "unrecognized" as const,
          message: `unrecognized key — §7.6 fixes this record's fields and ${key} is not one`,
        }));
      }
      const fault = faultAt(raw, issue.path);
      return [
        {
          path: segments.join("."),
          fault,
          /*
           * Rewritten when the key is absent, for the reason
           * `triage-document.ts` records: zod 4 answers a MISSING enum key and an
           * unknown enum value with one identical issue, and its sentence
           * ("Invalid option: expected one of …") describes a spelling mistake in
           * a field that is not there.
           */
          message:
            fault === "missing"
              ? `required by §7.6 and absent from the record — written by an older build, ` +
                `or by a write that did not finish`
              : issue.message,
        },
      ];
    });
    return {
      kind: "refused",
      code: "schema",
      reason:
        `${path} does not satisfy §7.6: ` +
        issues.map((i) => `${i.path === "" ? "(record)" : i.path}: ${i.message}`).join("; "),
      issues,
    };
  }

  /*
   * The record parsed and is about somebody else. `advanceIncident` would throw
   * on this pairing and be right to — *"continuing would write one service's
   * state into another's file"* — but the caller here is a polling actor holding
   * a path, so the same fact arrives as a value it can log and skip.
   */
  if (subjectKey(result.data.subject) !== subjectKey(expected)) {
    return {
      kind: "refused",
      code: "subject_mismatch",
      reason:
        `${path} holds the record for ${subjectKey(result.data.subject)} but was read as ` +
        `${subjectKey(expected)}. §6.8 keys a record per subject, so acting on this one would ` +
        `advance one subject's state from another subject's sweeps.`,
      issues: [],
    };
  }

  return { kind: "ok", record: result.data };
}

/**
 * Absent, or present and wrong — see {@link INCIDENT_RECORD_FAULTS}.
 *
 * Sound because the value came through `JSON.parse`, where `undefined` is not
 * representable: `undefined` at a path is a key that was never written and can be
 * nothing else, while `null` is a key that is present and carries a value this
 * contract does not accept.
 */
function faultAt(raw: unknown, path: readonly PropertyKey[]): IncidentRecordFault {
  let cursor: unknown = raw;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return "invalid";
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor === undefined ? "missing" : "invalid";
}

function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a JSON array";
  return `a JSON ${typeof value}`;
}

/** The read, and nothing but the read. `null` means the file does not exist. */
export type IncidentRecordText = (path: string) => Promise<string | null>;

export interface IncidentRecordDeps {
  readonly readText: IncidentRecordText;
}

/** The real read, taken through a ports object exactly as `TriageConfigDeps` is. */
export const DEFAULT_INCIDENT_RECORD_DEPS: IncidentRecordDeps = {
  readText: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  },
};

export interface LoadIncidentRecordOptions {
  readonly subject: IncidentSubject;
  /** Defaults to {@link incidentRecordPath} for the subject. */
  readonly path?: string;
  readonly deps?: Partial<IncidentRecordDeps>;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Read one subject's record, with a MISSING file resolving to a fresh record and a
 * MALFORMED one refusing.
 *
 * The two are the whole of §7.6's posture and they must not be collapsed. A
 * console watching nine services has nine missing files on its first sweep, which
 * is the ordinary state and costs nothing; a file that exists and cannot be read
 * is a fact about a service whose incident state is now unknown, and treating it
 * as "never seen" would silently clear it.
 *
 * The disk is reached only through {@link IncidentRecordDeps}, so every test in
 * this phase runs without one — Phase 5 *"touches no container and no network"*,
 * and `~/.pifleet` is keyed off `$HOME` rather than off the checkout.
 */
export async function loadIncidentRecord(
  opts: LoadIncidentRecordOptions,
): Promise<IncidentRecordRead> {
  const deps: IncidentRecordDeps = { ...DEFAULT_INCIDENT_RECORD_DEPS, ...opts.deps };
  const path = opts.path ?? incidentRecordPath(opts.subject, opts.env);
  const text = await deps.readText(path);
  if (text === null) return { kind: "ok", record: freshIncidentRecord(opts.subject) };
  return parseIncidentRecord(text, opts.subject, path);
}

// ── §6.8a task 5.4a — a sweep's console-level facts, as observations ─────────

/**
 * What one sweep learned about ONE environment, at the console level.
 *
 * Two of §6.8a's six kinds are environment-scoped and both are answered per
 * environment, so they travel together rather than as two parallel arrays that
 * can disagree about which environments the sweep saw.
 */
export interface ConsoleEnvironmentFacts {
  readonly environment: string;
  /** SRD-OBSERVER-001 §9.3's `status: blocked`, from that environment's observer. */
  readonly observerBlocked: boolean;
  /** False is §6.5's zero-row: no child succeeded, so nothing was collated. */
  readonly collated: boolean;
}

/**
 * A sweep's console-level facts. **A DATA shape, and that is the whole task.**
 *
 * §13 task 5.4a states its own failure condition: *"if this task finds itself
 * writing a second state machine, it has gone wrong — the whole content of §6.8a
 * is that the identity was missing and the machine was not."* So nothing below
 * decides a transition, a threshold or a notification. {@link
 * consoleHealthObservations} turns facts into {@link IncidentObservation}s and
 * `advanceIncident` does the rest, unchanged, exactly as it does for a service.
 *
 * **The `ran: false` arm is not a convenience.** §12 requires that a
 * console-health `kind` clear *"only on a positively observed good state"*, with
 * the probe being a `firing` record followed by *"a sweep that did not run at
 * all"* — and the note beside it is the reason: *"an actor that stopped counting
 * is not an actor that recovered."* Modelling a non-sweep as a variant rather
 * than as absent fields makes the recovery UNREACHABLE from it: the arm can only
 * produce `unobserved`, which carries no `evidenceRef` and therefore cannot
 * reach `onObservedClear`. It is §6.8's own asymmetry, spelled in the type that
 * feeds the machine rather than re-argued inside it.
 */
export type ConsoleHealthFacts =
  | {
      readonly ran: true;
      readonly sweepId: string;
      readonly at: number;
      /**
       * What a CLEAR cites. Required, and non-nullable for the reason
       * `IncidentSignal["observed_clear"]` makes it non-nullable: a recovery that
       * names nothing is a recovery derived from an absence.
       */
      readonly evidenceRef: string;
      readonly environments: readonly ConsoleEnvironmentFacts[];
      /** §6.4's counter as this sweep found it. */
      readonly consecutiveSkips: number;
      /** §7.8's `max_consecutive_skips`, passed rather than read, so this stays pure. */
      readonly maxConsecutiveSkips: number;
      /**
       * §6.7 rule 3. `null` when the sweep could not tell — which is NOT `false`,
       * and the distinction is the one §6.7 rule 3 exists to protect.
       */
      readonly saturated: boolean | null;
      /** §6.10's exit 5. */
      readonly budgetExhausted: boolean;
      /** §9.15. Task 5.6b is what sets it; this shape is the seam it lands on. */
      readonly reporterUndelivered: boolean;
    }
  | {
      readonly ran: false;
      readonly sweepId: string;
      readonly at: number;
      /** The environments whose records the actor holds, so each gets its silence. */
      readonly environments: readonly string[];
    };

/** `issue` or `observed_clear`, on one boolean, with the reason fixed. */
function raised(
  bad: boolean,
  reason: ConsoleHealthKind,
  evidenceRef: string,
): IncidentSignal {
  return bad
    ? { kind: "issue", reason, evidenceRef }
    : { kind: "observed_clear", evidenceRef };
}

/**
 * §6.8a's table, as a function from one sweep's facts to observations.
 *
 * One observation per `(scope, kind)` the sweep has something to say about. A
 * subject the sweep is silent on gets NO observation here — the actor (task 6.1)
 * holds the record set and is the only thing that can know a record exists for a
 * subject this sweep never mentioned. Emitting a fabricated `unobserved` for
 * every enum member on every sweep would be this module inventing the record set,
 * which it does not have.
 *
 * The order is §6.8a's table, top to bottom, then environments in the order the
 * caller supplied them — deterministic, so a test can assert by value.
 */
export function consoleHealthObservations(
  facts: ConsoleHealthFacts,
): readonly IncidentObservation[] {
  const { sweepId, at } = facts;
  const out: IncidentObservation[] = [];
  const say = (subject: IncidentSubject, signal: IncidentSignal): void => {
    out.push({ subject, sweepId, at, signal });
  };
  const console_ = (health: ConsoleHealthKind): IncidentSubject => ({
    kind: "console_health",
    scope: CONSOLE_SCOPE,
    health,
  });
  const env = (environment: string, health: ConsoleHealthKind): IncidentSubject => ({
    kind: "console_health",
    scope: environment,
    health,
  });

  /*
   * THE SWEEP THAT DID NOT RUN. Every subject the actor holds hears silence, and
   * silence is all this arm can produce — see the type's docblock. §6.4's own
   * skip counter is deliberately NOT advanced here either: this function reports
   * what a sweep saw, and a sweep that did not run saw nothing, including nothing
   * about itself.
   */
  if (!facts.ran) {
    for (const environment of facts.environments) {
      say(env(environment, "observer_blocked"), { kind: "unobserved" });
      say(env(environment, "sweep_produced_nothing"), { kind: "unobserved" });
    }
    for (const health of CONSOLE_HEALTH_KINDS) {
      if (health === "observer_blocked" || health === "sweep_produced_nothing") continue;
      say(console_(health), { kind: "unobserved" });
    }
    return out;
  }

  const ref = facts.evidenceRef;
  for (const e of facts.environments) {
    say(env(e.environment, "observer_blocked"), raised(e.observerBlocked, "observer_blocked", ref));
    say(
      env(e.environment, "sweep_produced_nothing"),
      raised(!e.collated, "sweep_produced_nothing", ref),
    );
  }

  /*
   * §6.4's threshold, and the off-by-one is DELIBERATE and lives here rather
   * than in the machine.
   *
   * §12 asks for two things at once: *"skips 4, 5 and 6 send nothing"* and
   * *"exactly one notification, at the third"*, with `max_consecutive_skips`
   * defaulting to 3. Those are only consistent if the OPEN lands on skip 3 — and
   * §6.8a inherits §6.7 rule 1, so an open needs a confirmation sweep behind it.
   * Raising at the threshold itself would put the open on skip 4 and falsify
   * both sentences.
   *
   * So the issue is raised one skip EARLY and the machine's own confirmation
   * carries it to the threshold. That is not a second rule: §6.4's number is a
   * statement about when the OPERATOR is told, and confirmation is how the
   * machine gets there. Absorbing it in the identity layer is what lets §6.8a's
   * *"the machine unchanged"* stay literally true.
   *
   * `Math.max(1, …)` guards the schema's `min(1)`: at `max_consecutive_skips: 1`
   * there is no earlier skip to raise on, so the open lands on skip 2 and the
   * knob's floor costs one sweep of latency rather than an unreachable rule.
   *
   * `>=` rather than `===` for the reason the coverage escalation carries: the
   * counter arrives from a record this module did not write, and a counter
   * already past the line must still raise.
   *
   * **Below the raise line and above zero there is NO observation, not an
   * `unobserved` one.** A skipped pass is not a sweep that ran, so it cannot
   * clear (§6.8a's table: *"cleared by a sweep that ran"*); and `unobserved`
   * would advance `consecutive_indeterminate` toward the coverage escalation,
   * announcing that the console cannot see a service when the fact is that it
   * chose not to look yet.
   */
  const raiseSkipsAt = Math.max(1, facts.maxConsecutiveSkips - 1);
  if (facts.consecutiveSkips >= raiseSkipsAt) {
    say(console_("sweeps_skipped"), {
      kind: "issue",
      reason: "sweeps_skipped",
      evidenceRef: ref,
    });
  } else if (facts.consecutiveSkips === 0) {
    say(console_("sweeps_skipped"), { kind: "observed_clear", evidenceRef: ref });
  }

  /*
   * `null` is NOT `false`. §6.7 rule 3's whole content is that a sweep which
   * could not tell whether the provider was saturated must not report that it
   * was not — that is the absence-as-evidence mistake, and here it would compose
   * a recovery.
   */
  if (facts.saturated !== null) {
    say(console_("inference_saturated"), raised(facts.saturated, "inference_saturated", ref));
  }

  say(console_("budget_exhausted"), raised(facts.budgetExhausted, "budget_exhausted", ref));
  say(
    console_("reporter_undelivered"),
    raised(facts.reporterUndelivered, "reporter_undelivered", ref),
  );
  return out;
}

// ── §9.15 task 5.6b — the seam the notifier lands on ─────────────────────────

/**
 * What a notification cannot know about itself, supplied by the caller.
 *
 * Both are the notifier's own facts rather than the machine's: `evidence` is the
 * UNTRUSTED worker prose an observer quoted — held out of every field but the
 * fenced block §6.9 requirement 1 defines — and `backlog` is §6.9 requirement 6's
 * count and window, which only the notifier's state knows. Neither is on an
 * {@link IncidentNotification}, so a translation that invented either would put a
 * value in a message that no observation produced.
 */
export interface AnnouncementExtras {
  readonly evidence?: string | null;
  readonly backlog?: NotifyBacklog | null;
  /**
   * Overrides the derivation below. §6.9 requirement 1 notes that a
   * `_console`-scoped announcement *"still has an environment worth naming"* —
   * `inference_saturated` is the case, where the subject is a provider and model
   * and the environment is only the scope of what went unobserved. That
   * environment is not on the record, so the caller that knows it says so.
   */
  readonly environment?: string | null;
}

/**
 * §13 task 5.6b(c): one {@link IncidentNotification}, translated into the
 * notifier's typed fields. Pure, total, and the ONE place the two vocabularies
 * meet.
 *
 * ## Why the translation lives here and not in the notifier
 *
 * ISC-689 asserts that `src/run/triage-notify.ts` imports nothing from this
 * module, so *"no edit in the notifier can reach the state machine, whatever it
 * intends"*. That probe is worth keeping intact, and it stays intact because the
 * coupling task 5.6b needs runs the other way: this module takes a TYPE-ONLY
 * import of {@link AnnouncementFacts} — erased at runtime, carrying data shapes
 * and never an outcome — and the notifier still takes nothing from here. §6.9
 * requirement 7's structural guarantee is therefore stronger after this task than
 * before it rather than weaker: neither module can see the other's decisions, and
 * the only thing that crosses is a value.
 *
 * ## The three mappings a reader would get wrong
 *
 *  - **`subject` is what the message NAMES**, so it is the service for a service
 *    incident and the console-health `kind` for the other arm — never the
 *    environment. §6.7 rule 3 is the whole reason those are separate fields.
 *  - **`scope` is §6.8a's identity half.** A service incident's scope is its
 *    environment; a console-health incident's scope is its own, which is either an
 *    environment token or {@link CONSOLE_SCOPE}.
 *  - **`environment` is `null` for the console itself.** Rendering
 *    {@link CONSOLE_SCOPE} into that field would show the operator `_console` in
 *    the position they read as a cluster name.
 *
 * `first_seen` is `at − firingForMs`: §6.8's *"how long it was firing"* is carried
 * on the notification as a duration, and the message wants the instant.
 */
export function announcementFacts(
  notification: IncidentNotification,
  extras: AnnouncementExtras = {},
): AnnouncementFacts {
  const subject = notification.subject;
  const derived =
    subject.kind === "service"
      ? {
          kind: "service" as const,
          scope: subject.environment,
          subject: subject.service,
          environment: subject.environment as string | null,
          service: subject.service as string | null,
        }
      : {
          kind: "console_health" as const,
          scope: subject.scope,
          subject: subject.health,
          environment: subject.scope === CONSOLE_SCOPE ? null : subject.scope,
          service: null,
        };

  return {
    ...derived,
    environment: extras.environment === undefined ? derived.environment : extras.environment,
    assessment: notification.reason,
    transition: notification.kind,
    first_seen: notification.at - notification.firingForMs,
    sweep_count: notification.sweepCount,
    evidence: extras.evidence ?? null,
    evidence_ref: notification.evidenceRef,
    backlog: extras.backlog ?? null,
  };
}

/**
 * The ONLY writer of {@link IncidentRecord.undelivered}, and it touches nothing
 * else. §7.6 declares the field; §13 task 5.6b fills it.
 *
 * §6.9 requirement 7 — *"a delivery failure never advances or clears an
 * incident"* — is a rule about code, and this is the shape that makes it
 * checkable rather than merely stated: the record is spread and exactly one key is
 * replaced, so a test can assert every other field is byte-identical without
 * enumerating them. {@link advanceIncident} never writes this field and this
 * function never writes any other; between them there is no path from a lost
 * message to a state.
 *
 * An empty list returns the caller's OWN object, so a quiet sweep cannot rewrite a
 * record it had nothing to say about — the same identity discipline
 * {@link advanceIncident} applies to a `suppressed` observation.
 *
 * The bound is {@link MAX_UNDELIVERED} and it keeps the MOST RECENT entries: an
 * operator reading a truncated backlog is looking at an outage that is happening
 * now, and dropping the newest to preserve the oldest would hide it.
 */
export function withUndelivered(
  record: IncidentRecord,
  entries: readonly string[],
): IncidentRecord {
  if (entries.length === 0) return record;
  const merged = [...record.undelivered, ...entries];
  const undelivered =
    merged.length <= MAX_UNDELIVERED ? merged : merged.slice(merged.length - MAX_UNDELIVERED);
  return { ...record, undelivered };
}
