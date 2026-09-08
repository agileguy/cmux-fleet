/**
 * The incident state machine — SRD-TRIAGE-CONSOLE §6.7 rule 1, §6.8, §7.6; §13
 * task 5.4.
 *
 * §12 calls this block *"the highest-value criteria in this document"*, and the
 * reason is arithmetic: this console sweeps 288 times a day, so every rule below
 * is the difference between one message and two hundred and eighty-eight, or
 * between an operator acting on a recovery and an operator acting on a silence.
 *
 * ## THE LITERAL NUMBERS, because "few" passes a design that sends twelve
 *
 * §12 says so outright — *"**The literal number, because the commission's
 * implicit failure is 288 and a criterion asserting 'few' would pass a design
 * that sends twelve**"* — and it has a twin failure this file guards against just
 * as hard: **a machine that emits ZERO passes every "not more than one"
 * assertion.** So the two headline fixtures assert `=== 1` and then assert the
 * `kind` of that one notification by name, because "one notification" is also
 * reachable by sending the WRONG one.
 *
 * ## ASYMMETRY, on this branch's most expensive recorded lesson
 *
 * MEMORY: *"a filter or intersection survives mutation whenever every fixture
 * makes the two sets equal"*, recorded four times on this branch and twice inside
 * batteries written by engineers who had been warned. The set-shaped thing in
 * this module is `flap_transitions[]`, which is a WINDOW FILTER, and a fixture
 * whose transitions all sit inside the window — or all outside it — cannot tell
 * `filter(t => t > at - window)` from `filter(() => true)`.
 *
 * `describe("the flap window is a filter, and the fixture straddles it")` is the
 * answer: four timestamps, two inside and two outside, and the survivors are
 * asserted **by value** rather than by count. A count assertion is satisfied by
 * keeping the wrong two.
 *
 * ## Nothing here reads a clock, a file or a cluster
 *
 * Phase 5 *"touches no worker and reads no cluster"*. `at` is a literal in every
 * fixture, the policy is a literal, and the record is a value in and a value out.
 * `T0` and `CADENCE_MS` exist so that a fixture reads as a timeline rather than
 * as arithmetic.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_CENSUS_DEPS,
  incidentCensus,
  type CensusDeps,
  announcementFacts,
  consoleHealthObservations,
  saveIncidentRecord,
  withUndelivered,
  DEFAULT_INCIDENT_RECORD_DEPS,
  type ConsoleHealthFacts,
  type IncidentObservation,
  ADVANCE_READS_NO_ISSUE_REASON,
  ADVANCE_READS_NO_SUBJECT_FIELD,
  CONSOLE_HEALTH_KINDS,
  CONSOLE_SCOPE,
  COVERAGE_THRESHOLD,
  INCIDENT_RECORD_FAULTS,
  INCIDENT_STATES,
  MAX_FLAP_TRANSITIONS,
  MAX_UNDELIVERED,
  IncidentPathError,
  ISSUE_REASONS,
  OBSERVED_ISSUE_REASONS,
  advanceIncident,
  freshIncidentRecord,
  incidentRecordPath,
  incidentRecordRoot,
  loadIncidentRecord,
  parseIncidentRecord,
  subjectKey,
  type IncidentAdvance,
  type IncidentNotification,
  type IncidentPolicy,
  type IncidentRecord,
  type IncidentRecordRead,
  type IncidentSignal,
  type IncidentSubject,
  type ObservedIssueReason,
} from "../../src/run/triage-incident.ts";
import { defaultTriageConsoleConfig } from "../../src/run/triage-config.ts";
import { stripComments } from "../support/source-structure.ts";
import { TRIAGE_DOCUMENT_FAULTS } from "../../src/run/triage-document.ts";
import {
  SATURATION_PAIR,
  SATURATION_VERDICTS,
  type SaturationVerdict,
} from "../../src/run/triage-verdict.ts";
import {
  ANNOUNCEMENT_ASSESSMENTS,
  ANNOUNCEMENT_TRANSITIONS,
  CONSOLE_HEALTH_ASSESSMENTS,
} from "../../src/run/triage-notify.ts";

/** A round wall-clock start, so every timestamp below reads as an offset. */
const T0 = Date.UTC(2026, 8, 6, 0, 0, 0);
/** §7.8's `cadence_s` default, in ms. 288 of these is a day. */
const CADENCE_MS = 300_000;
const HOUR_MS = 3_600_000;

const SERVICE: IncidentSubject = {
  kind: "service",
  environment: "cni-prod",
  service: "authorization",
};

/**
 * The SHIPPED defaults, read from the schema rather than re-typed.
 *
 * §12: *"The shipped defaults are the documented ones"*, and a fixture that
 * spelled `flap_threshold: 3` itself would keep passing after the schema moved —
 * which is the *"second copy of the defaults"* §7.8 exists to prevent. Every
 * fixture that means "at the defaults" uses this.
 */
const DEFAULTS: IncidentPolicy = defaultTriageConsoleConfig();

/** The same policy with the re-notify floor off, for the fixtures that isolate it. */
const NO_RENOTIFY: IncidentPolicy = { ...DEFAULTS, renotify_after_s: 0 };

const issue = (reason: ObservedIssueReason, ref: string | null = "a/1"): IncidentSignal => ({
  kind: "issue",
  reason,
  evidenceRef: ref,
});
const clear = (ref = "clean/1"): IncidentSignal => ({ kind: "observed_clear", evidenceRef: ref });
const unobserved: IncidentSignal = { kind: "unobserved" };
const suppressed: IncidentSignal = { kind: "suppressed" };

/** One sweep, at `T0 + n * cadence`. */
function sweep(
  record: IncidentRecord,
  n: number,
  signal: IncidentSignal,
  policy: IncidentPolicy = DEFAULTS,
  subject: IncidentSubject = SERVICE,
): IncidentAdvance {
  return advanceIncident(
    record,
    { subject, sweepId: `s-${n}`, at: T0 + n * CADENCE_MS, signal },
    policy,
  );
}

/**
 * Drive a whole timeline and collect EVERY notification it produced.
 *
 * `signalFor(n)` decides what sweep `n` saw. Returning the accumulated list
 * rather than a count is deliberate: every assertion below names kinds, and a
 * count alone cannot tell one `opened` from one `recovered`.
 */
function drive(
  sweeps: number,
  signalFor: (n: number) => IncidentSignal,
  policy: IncidentPolicy = DEFAULTS,
): { record: IncidentRecord; notifications: IncidentNotification[] } {
  let record = freshIncidentRecord(SERVICE);
  const notifications: IncidentNotification[] = [];
  for (let n = 0; n < sweeps; n += 1) {
    const step = sweep(record, n, signalFor(n), policy);
    record = step.record;
    notifications.push(...step.notifications);
  }
  return { record, notifications };
}

const kinds = (ns: readonly IncidentNotification[]): string[] => ns.map((n) => n.kind);

describe("288 consecutive sweeps of one unhealthy service", () => {
  /**
   * §12's first dedup criterion, and the one the whole console is arranged
   * around: *"**Anti: a service firing for 288 consecutive sweeps produces one
   * notification.** Probe: drive 288 fixture sweeps through the machine and
   * assert `notifications.length === 1`."*
   *
   * The re-notify floor is DISABLED here so the number is exactly one and not
   * one-plus-a-reminder-schedule. §7.8 documents `0` as the disabling value, and
   * the floor gets its own block below where its instants are asserted rather
   * than approximated.
   *
   * **`kind` is asserted, not just the count.** A machine that never opened an
   * incident and sent a single stray `reminder` would satisfy `length === 1`.
   */
  test("produce exactly ONE notification, and it is the open", () => {
    const { record, notifications } = drive(288, () => issue("unhealthy"), NO_RENOTIFY);

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.kind).toBe("opened");
    expect(notifications[0]!.reason).toBe("unhealthy");
    // The confirmation sweep, not the first: §6.7 rule 1.
    expect(notifications[0]!.at).toBe(T0 + CADENCE_MS);
    expect(notifications[0]!.sweepId).toBe("s-1");

    expect(record.state).toBe("firing");
    // Every sweep saw it, so every sweep counts. 288 sweeps is 24h at the
    // 300s default and it is the number the commission's failure is made of.
    expect(record.sweep_count).toBe(288);
    expect(record.last_seen).toBe(T0 + 287 * CADENCE_MS);
    expect(record.consecutive_indeterminate).toBe(0);
  });

  /**
   * The re-notify floor, asserted as INSTANTS rather than as a total.
   *
   * §12 says *"fixture sweeps spanning 24h at the 6h default; assert 4
   * reminders, not 288"*, while §6.8a's own arithmetic for the same rule says
   * *"**4 messages** in 24h at the 6h default"*. Those are two different numbers
   * — one open plus four reminders is five messages — and the difference is
   * entirely where the clock starts: §12 counts 24h of FIRING, §6.8a counts 24h
   * of sweeping, and the incident does not begin firing until the confirmation
   * sweep. **The SRD is inconsistent by one here and it is reported rather than
   * quietly resolved.**
   *
   * So this asserts the RULE instead of either arithmetic: a reminder lands
   * exactly `renotify_after` after the previous message and nowhere else. Both
   * readings then follow from the instants, and a machine that sent reminders
   * every sweep, or every second reminder, fails on the offsets rather than on a
   * total that could be right by accident.
   */
  test("the 6h floor puts reminders on the boundary and nowhere else", () => {
    const renotifyMs = DEFAULTS.renotify_after_s * 1_000;
    expect(renotifyMs).toBe(6 * HOUR_MS);

    // 24h of FIRING: the incident opens on sweep 1, so drive to sweep 289.
    const { notifications } = drive(290, () => issue("unhealthy"), DEFAULTS);

    expect(kinds(notifications)).toEqual([
      "opened",
      "reminder",
      "reminder",
      "reminder",
      "reminder",
    ]);

    const opened = notifications[0]!;
    expect(opened.at).toBe(T0 + CADENCE_MS);
    // Each reminder is exactly one `renotify_after` past the message before it.
    // `>` instead of `>=` on the floor slips every one of these by a cadence;
    // dropping the floor's `last_notified_at` update collapses them onto one.
    for (const [i, reminder] of notifications.slice(1).entries()) {
      expect(reminder.kind).toBe("reminder");
      expect(reminder.at).toBe(opened.at + (i + 1) * renotifyMs);
      expect(reminder.reason).toBe("unhealthy");
    }

    // §6.8a's reading, stated in the same test so the two cannot drift: the
    // first 288 sweeps carry FOUR messages in total, not 288.
    const withinFirst288 = notifications.filter((n) => n.at < T0 + 288 * CADENCE_MS);
    expect(withinFirst288.length).toBe(4);
  });

  /**
   * ANTI-DEGENERACY for the block above. A machine that emitted nothing at all
   * satisfies "exactly one notification in 288 sweeps" only because 288 sweeps
   * of silence and 288 sweeps of one message look the same to a `<= 1`
   * assertion. This fixture is the same 288 sweeps of a service that is FINE,
   * and it is the one that must be silent.
   */
  test("288 sweeps of a healthy service produce none at all", () => {
    const { record, notifications } = drive(288, () => clear(), DEFAULTS);
    expect(notifications).toEqual([]);
    expect(record.state).toBe("clear");
    expect(record.sweep_count).toBe(0);
  });
});

describe("confirmation — §6.7 rule 1, one observation is not a finding", () => {
  test("a first unhealthy observation notifies nothing and records provisional", () => {
    const step = sweep(freshIncidentRecord(SERVICE), 0, issue("unhealthy"));
    expect(step.notifications).toEqual([]);
    expect(step.record.state).toBe("provisional");
    expect(step.record.reason).toBe("unhealthy");
    expect(step.record.since).toBe(T0);
    expect(step.record.sweep_count).toBe(1);
    // Nothing was composed, so nothing may have moved the re-notify clock.
    expect(step.record.last_notified_at).toBeNull();
  });

  /**
   * The `evidenceRef` assertion was added after a mutation survived: dropping it
   * from the `opened` notification changed nothing any fixture could see.
   *
   * It is load-bearing rather than decorative. §6.9's composer renders the
   * evidence into the fenced block that is the ONLY place worker prose is
   * allowed to appear (§4.3), so an `opened` carrying none announces an incident
   * with nothing behind it — which is SRD-OBSERVER-001 §11.2's dominant failure
   * inverted: *"you told me it was broken but didn't say what you saw."*
   */
  test("a second consecutive unhealthy notifies exactly once, carrying its evidence", () => {
    const { record, notifications } = drive(2, () => issue("unhealthy"), NO_RENOTIFY);
    expect(kinds(notifications)).toEqual(["opened"]);
    expect(notifications[0]!.evidenceRef).toBe("a/1");
    expect(record.state).toBe("firing");
    expect(record.sweep_count).toBe(2);
    expect(record.last_artifact_ref).toBe("a/1");
  });

  /**
   * And the asymmetric half: an issue observed with NO artifact still opens, and
   * says so by carrying `null` rather than inventing a reference. Without this
   * the assertion above is satisfied by a composer that hard-codes a string.
   */
  test("an issue with no artifact still opens, and cites nothing", () => {
    const { notifications } = drive(2, () => issue("unhealthy", null), NO_RENOTIFY);
    expect(kinds(notifications)).toEqual(["opened"]);
    expect(notifications[0]!.evidenceRef).toBeNull();
  });

  /**
   * `degraded` is §6.7's second row — *"same axis, lower amplitude"* — and it
   * confirms and notifies on exactly the same terms. Asserted because a machine
   * that only handled `unhealthy` would pass every other fixture in this file.
   */
  test("degraded confirms and opens on the same terms as unhealthy", () => {
    const { record, notifications } = drive(2, () => issue("degraded"), NO_RENOTIFY);
    expect(kinds(notifications)).toEqual(["opened"]);
    expect(notifications[0]!.reason).toBe("degraded");
    expect(record.reason).toBe("degraded");
  });

  /**
   * §6.8: *"`provisional → clear` … the thing resolved before it was confirmed;
   * **recorded, not announced**"*. Both halves asserted — the silence, and that
   * the record moved.
   */
  test("an unconfirmed issue that resolves is recorded and not announced", () => {
    const first = sweep(freshIncidentRecord(SERVICE), 0, issue("unhealthy"));
    const second = sweep(first.record, 1, clear("clean/7"));
    expect(second.notifications).toEqual([]);
    expect(second.record.state).toBe("clear");
    expect(second.record.reason).toBeNull();
    expect(second.record.last_artifact_ref).toBe("clean/7");
    // An unannounced transition must not move the re-notify clock: doing so
    // would delay the first real reminder of the NEXT incident by six hours.
    expect(second.record.last_notified_at).toBeNull();
  });
});

describe("recovery must be OBSERVED — the most damaging message this console could send", () => {
  /** A record that is already firing, as every fixture in this block starts. */
  function firing(): IncidentRecord {
    const { record, notifications } = drive(2, () => issue("unhealthy"), NO_RENOTIFY);
    expect(kinds(notifications)).toEqual(["opened"]);
    expect(record.state).toBe("firing");
    return record;
  }

  /**
   * §12: *"**Anti: `unhealthy → indeterminate` is NOT a recovery.** Probe: a
   * firing record followed by a sweep in which that service is `indeterminate`;
   * assert the record stays `firing` and no recovery notification is composed.
   * **This is the most damaging message this console could send and the
   * criterion that stops it.**"*
   *
   * Asserted three ways, because "no recovery" has three failure shapes: the
   * state could clear silently, a `recovered` could be composed, or the reason
   * could be dropped so a later message says nothing useful.
   */
  test("a firing service that goes indeterminate does NOT recover", () => {
    const step = sweep(firing(), 2, unobserved, NO_RENOTIFY);

    expect(step.notifications).toEqual([]);
    expect(kinds(step.notifications)).not.toContain("recovered");
    expect(step.record.state).toBe("firing");
    expect(step.record.reason).toBe("unhealthy");
    // The gap is RECORDED — §6.8: *"the record stays `firing` with its coverage
    // gap recorded"*.
    expect(step.record.consecutive_indeterminate).toBe(1);
    // And no blind sweep is counted as an observation of the issue.
    expect(step.record.sweep_count).toBe(2);
    expect(step.record.last_seen).toBe(T0 + CADENCE_MS);
  });

  /**
   * The same rule for the case §6.7's structural gate produces. A `healthy` row
   * with an empty `coverage[]` is downgraded host-side to `indeterminate` and
   * recorded as `unevidenced_healthy` (§6.7 rule 2, task 5.2's), which means it
   * reaches this machine as `unobserved` — and §12 requires that it *"does
   * **not** clear a firing incident"*.
   *
   * The load-bearing observation is that this file **cannot construct the
   * counter-example**: `unobserved` carries no `evidenceRef` field, so there is
   * no way to express "healthy, but with nothing behind it" as a clear. The rule
   * is enforced by the type rather than by a branch a later edit could delete.
   */
  test("a downgraded unevidenced healthy reaches here as a silence, not a clear", () => {
    const step = sweep(firing(), 2, unobserved, NO_RENOTIFY);
    expect(step.record.state).toBe("firing");

    // The type-level half, spelled out: an `observed_clear` REQUIRES a ref.
    // @ts-expect-error — a clear with no evidence is not constructible.
    const impossible: IncidentSignal = { kind: "observed_clear" };
    expect(impossible).toBeDefined();
  });

  /**
   * §12's mirror: *"A recovery requires an observed `healthy` with evidence.
   * Probe: the same fixture with a healthy row carrying `coverage[]` and a
   * ledger; assert exactly one recovery notification naming the duration and the
   * sweep count."*
   *
   * Without this arm the fixture above is satisfied by a machine that never
   * recovers anything, which would be just as broken in the other direction.
   */
  test("an observed healthy with evidence recovers exactly once, naming duration and sweeps", () => {
    const step = sweep(firing(), 2, clear("evidence/ledger-9"), NO_RENOTIFY);

    expect(kinds(step.notifications)).toEqual(["recovered"]);
    const note = step.notifications[0]!;
    // §6.8: *"how long it was firing, how many sweeps, and the evidence that
    // closed it"*. Firing began on the confirmation sweep, one cadence in.
    expect(note.firingForMs).toBe(CADENCE_MS);
    expect(note.sweepCount).toBe(2);
    expect(note.evidenceRef).toBe("evidence/ledger-9");
    expect(note.reason).toBe("unhealthy");

    expect(step.record.state).toBe("clear");
    expect(step.record.reason).toBeNull();
    expect(step.record.sweep_count).toBe(0);
  });

  /**
   * A firing incident that stays invisible for a long time still does not
   * recover, and does not silently escalate into a second incident either. The
   * coverage escalation is scoped to records that are not already open — §6.8:
   * *"the record stays `firing`"* — so twenty blind sweeps produce zero
   * notifications and one very large gap counter.
   */
  test("twenty blind sweeps on a firing record change the state not at all", () => {
    let record = firing();
    for (let n = 2; n < 22; n += 1) {
      const step = sweep(record, n, unobserved, NO_RENOTIFY);
      expect(step.notifications).toEqual([]);
      record = step.record;
    }
    expect(record.state).toBe("firing");
    expect(record.reason).toBe("unhealthy");
    expect(record.consecutive_indeterminate).toBe(20);
  });
});

describe("the coverage escalation — §6.7 row 5", () => {
  /**
   * §12: *"Three consecutive `indeterminate` on one service is an issue. Probe:
   * three fixture sweeps; assert the third notifies as a coverage issue **and
   * not as a service issue**."*
   *
   * The second clause is the one worth the most. A machine that escalated with
   * `reason: "unhealthy"` would notify at the right moment and tell the operator
   * their cluster is broken when the truth is that nobody could see it —
   * §6.7's own words for the cost of that mistake are *"the console
   * misdiagnosing itself, in the direction that costs the most"*.
   */
  test("the third blind sweep notifies, as coverage and not as a service issue", () => {
    const { record, notifications } = drive(3, () => unobserved, NO_RENOTIFY);

    expect(kinds(notifications)).toEqual(["opened"]);
    expect(notifications[0]!.reason).toBe("coverage");
    expect(notifications[0]!.at).toBe(T0 + 2 * CADENCE_MS);
    // Nothing was seen, so nothing is cited.
    expect(notifications[0]!.evidenceRef).toBeNull();

    expect(record.state).toBe("firing");
    expect(record.reason).toBe("coverage");
    expect(record.consecutive_indeterminate).toBe(COVERAGE_THRESHOLD);
  });

  /** One and two blind sweeps are §6.7's *"recorded as a coverage gap"* and silent. */
  test("one and two blind sweeps say nothing", () => {
    expect(drive(1, () => unobserved, NO_RENOTIFY).notifications).toEqual([]);
    expect(drive(2, () => unobserved, NO_RENOTIFY).notifications).toEqual([]);
    expect(drive(2, () => unobserved, NO_RENOTIFY).record.state).toBe("clear");
  });

  /**
   * And the escalation fires ONCE. `=== COVERAGE_THRESHOLD` rather than `>=` is
   * what makes a service invisible for a day one notification instead of 286,
   * and this is the fixture that separates the two spellings.
   */
  test("blind sweeps four through twenty add nothing", () => {
    const { record, notifications } = drive(20, () => unobserved, NO_RENOTIFY);
    expect(kinds(notifications)).toEqual(["opened"]);
    expect(record.consecutive_indeterminate).toBe(20);
  });

  /**
   * A record that arrives ALREADY past the threshold still escalates.
   *
   * **This fixture exists because a mutation survived.** `===` and `>=` are
   * indistinguishable on any record this machine wrote — the state guard fires
   * the escalation at exactly three and then blocks every later sweep — so
   * changing one to the other passed the whole file. They are not
   * indistinguishable on a record task 5.5 READ FROM DISK: an older build, a
   * partial write or a hand edit can produce `state: "clear"` with the counter
   * already past three, and `===` steps over it forever. A service that is
   * permanently invisible and permanently silent is the exact failure this
   * console exists to prevent, so the comparison fails in the other direction and
   * this is what says so.
   */
  test("a record read back with the counter already past three escalates anyway", () => {
    const stale: IncidentRecord = {
      ...freshIncidentRecord(SERVICE),
      consecutive_indeterminate: COVERAGE_THRESHOLD + 4,
    };
    const step = sweep(stale, 0, unobserved, NO_RENOTIFY);
    expect(kinds(step.notifications)).toEqual(["opened"]);
    expect(step.notifications[0]!.reason).toBe("coverage");
    expect(step.record.state).toBe("firing");

    // And it still fires ONCE: the next blind sweep finds it already open.
    const next = sweep(step.record, 1, unobserved, NO_RENOTIFY);
    expect(next.notifications).toEqual([]);
  });

  /** Any sweep that could see the service resets the counter, either way round. */
  test("a sighting resets the gap counter, whichever way it went", () => {
    const blind = drive(2, () => unobserved, NO_RENOTIFY).record;
    expect(blind.consecutive_indeterminate).toBe(2);

    expect(sweep(blind, 2, clear(), NO_RENOTIFY).record.consecutive_indeterminate).toBe(0);
    expect(sweep(blind, 2, issue("degraded"), NO_RENOTIFY).record.consecutive_indeterminate).toBe(0);
  });
});

describe("flap damping — §6.8, and the case a pure edge-trigger fails", () => {
  /**
   * §12: *"**Anti: a service alternating every sweep does not notify every
   * sweep.** Probe: 20 alternating fixture sweeps; assert the machine reaches
   * `flapping`, emits once, and then goes quiet."*
   *
   * Note what strict alternation does to the confirmation rule: a single bad
   * sweep only reaches `provisional`, so the record never reaches `firing` and a
   * machine counting only `firing → clear → firing` round trips would emit
   * **zero** here — passing "does not notify every sweep" while failing "reaches
   * flapping" in the same sentence. That is why a round trip is counted from any
   * issue-side state.
   *
   * Exactly one, and its kind is asserted: a lone `opened` or a lone `recovered`
   * would also be "one".
   */
  test("twenty alternating sweeps reach flapping and emit exactly one notification", () => {
    const { record, notifications } = drive(
      20,
      (n) => (n % 2 === 0 ? issue("unhealthy") : clear()),
      NO_RENOTIFY,
    );

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.kind).toBe("flapping");
    expect(record.state).toBe("flapping");

    // The fourth round trip is what trips it — `> flap_threshold`, not `>=`.
    expect(DEFAULTS.flap_threshold).toBe(3);
    expect(notifications[0]!.at).toBe(T0 + 7 * CADENCE_MS);
  });

  /**
   * The boundary, both sides, because `>` and `>=` differ by exactly one round
   * trip and every other fixture in this block is satisfied by either.
   */
  test("flap_threshold round trips do NOT flap; one more does", () => {
    // Three round trips: six sweeps of alternation.
    const three = drive(6, (n) => (n % 2 === 0 ? issue("unhealthy") : clear()), NO_RENOTIFY);
    expect(three.record.state).toBe("clear");
    expect(kinds(three.notifications)).toEqual([]);
    expect(three.record.flap_transitions.length).toBe(DEFAULTS.flap_threshold);

    const four = drive(8, (n) => (n % 2 === 0 ? issue("unhealthy") : clear()), NO_RENOTIFY);
    expect(four.record.state).toBe("flapping");
    expect(kinds(four.notifications)).toEqual(["flapping"]);
  });

  /**
   * The `firing → clear → firing` shape §6.8 actually describes — two bad sweeps
   * then a good one, repeated — which DOES reach `firing` and so DOES send an
   * open and a recovery on every cycle until the damping catches it.
   *
   * This is the fixture that shows what the state is worth: without it the cycle
   * costs two notifications every three sweeps forever.
   */
  test("confirmed round trips are damped too, and the flapping notice replaces the recovery", () => {
    // n % 3: 0 and 1 are bad, 2 is good. Each cycle is one confirmed round trip.
    const { record, notifications } = drive(
      18,
      (n) => (n % 3 === 2 ? clear() : issue("unhealthy")),
      NO_RENOTIFY,
    );

    // Cycles 1-3 each open and recover; cycle 4's recovery is REPLACED by the
    // one flapping notice, and cycles 5-6 are silent.
    expect(kinds(notifications)).toEqual([
      "opened",
      "recovered",
      "opened",
      "recovered",
      "opened",
      "recovered",
      "opened",
      "flapping",
    ]);
    expect(record.state).toBe("flapping");
  });

  /**
   * §6.8: a `flapping` record *"goes quiet until the service has been stable for
   * a full `flap_window`"*.
   *
   * The clock is `last_seen`. **A machine measuring stability from
   * `flap_transitions[]` instead passes every fixture above and fails this one**
   * — its entries age out of the window on their own, so a still-alternating
   * record empties the list and reads as stable, composing a recovery for a
   * service that never recovered. That failure is one sweep away from the
   * twenty-sweep fixture above.
   */
  test("a flapping service clears only after a full window with nothing bad seen", () => {
    let record = drive(8, (n) => (n % 2 === 0 ? issue("unhealthy") : clear()), NO_RENOTIFY).record;
    expect(record.state).toBe("flapping");

    const flappedAt = 7;
    const windowSweeps = DEFAULTS.flap_window_s / (CADENCE_MS / 1_000);
    expect(windowSweeps).toBe(12);
    /*
     * The window is measured from the last BAD sweep — sweep 6 — and NOT from
     * the sweep the record went `flapping` on. That distinction is the whole
     * fixture: measuring from `since` would put the boundary one sweep later and
     * pass a machine that waits on the wrong clock.
     */
    const stableAt = 6 + windowSweeps;

    // Every good sweep short of a full window is silent and stays `flapping`.
    for (let n = flappedAt + 1; n < stableAt; n += 1) {
      const step = sweep(record, n, clear(), NO_RENOTIFY);
      expect(step.notifications, `sweep ${n} spoke too early`).toEqual([]);
      expect(step.record.state).toBe("flapping");
      record = step.record;
    }

    // `last_seen` is the last BAD sweep, which was sweep 6.
    expect(record.last_seen).toBe(T0 + 6 * CADENCE_MS);
    const done = sweep(record, stableAt, clear("clean/final"), NO_RENOTIFY);
    expect(kinds(done.notifications)).toEqual(["recovered"]);
    expect(done.record.state).toBe("clear");
    // The finished episode's oscillations are dropped, so one later round trip
    // cannot re-trip a threshold four round trips earned.
    expect(done.record.flap_transitions).toEqual([]);
  });

  /** While flapping, a bad sweep is silent — that is what "goes quiet" means. */
  test("a bad sweep on a flapping record says nothing and refreshes the clock", () => {
    const record = drive(8, (n) => (n % 2 === 0 ? issue("unhealthy") : clear()), NO_RENOTIFY)
      .record;
    const step = sweep(record, 8, issue("unhealthy"), NO_RENOTIFY);
    expect(step.notifications).toEqual([]);
    expect(step.record.state).toBe("flapping");
    expect(step.record.last_seen).toBe(T0 + 8 * CADENCE_MS);
  });
});

/**
 * THE ASYMMETRIC FIXTURE, and the reason this block has a header of its own.
 *
 * `flap_transitions[]` is a window FILTER — §7.6: *"timestamps inside
 * `flap_window`"* — and this branch's MEMORY records the defect a filter invites
 * four separate times: *"a filter or intersection survives mutation whenever
 * every fixture makes the two sets equal"*. Every fixture above happens to keep
 * every transition, because twenty sweeps at a 300s cadence is 100 minutes and
 * the window is 60.
 *
 * So this fixture straddles the boundary deliberately: two timestamps outside
 * the window, one exactly ON it, one inside. **The survivors are asserted by
 * value.** A count assertion is satisfied by keeping the wrong two, and
 * `filter(() => true)` is satisfied by any fixture where nothing should have been
 * dropped.
 */
describe("the flap window is a filter, and the fixture straddles it", () => {
  const now = T0 + 4 * HOUR_MS;
  const windowMs = DEFAULTS.flap_window_s * 1_000;

  /** Two stale, one exactly on the boundary, one live. Named, not counted. */
  const OUTSIDE_OLD = now - 3 * windowMs;
  const OUTSIDE_RECENT = now - 2 * windowMs;
  const ON_THE_BOUNDARY = now - windowMs;
  const INSIDE = now - windowMs / 2;

  function withTransitions(state: IncidentRecord["state"]): IncidentRecord {
    return {
      ...freshIncidentRecord(SERVICE),
      state,
      reason: "unhealthy",
      since: OUTSIDE_OLD,
      last_seen: now - CADENCE_MS,
      sweep_count: 4,
      flap_transitions: [OUTSIDE_OLD, OUTSIDE_RECENT, ON_THE_BOUNDARY, INSIDE],
    };
  }

  test("stale transitions are dropped and live ones kept, by value", () => {
    const step = advanceIncident(
      withTransitions("firing"),
      { subject: SERVICE, sweepId: "s-x", at: now, signal: clear("clean/x") },
      NO_RENOTIFY,
    );

    // The boundary is EXCLUSIVE — `t > at - window` — so a transition exactly one
    // window old has aged out. `>=` keeps it and this is the assertion that says so.
    expect(step.record.flap_transitions).toEqual([INSIDE, now]);
    expect(step.record.flap_transitions).not.toContain(ON_THE_BOUNDARY);
    expect(step.record.flap_transitions).not.toContain(OUTSIDE_OLD);
    expect(step.record.flap_transitions).not.toContain(OUTSIDE_RECENT);
  });

  /**
   * The consequence, which is what makes the filter load-bearing rather than
   * cosmetic: four recorded transitions would be `> flap_threshold` and flap,
   * and two survivors plus this sweep is exactly three and must not.
   *
   * A machine that never pruned reads this fixture as `flapping`. A machine that
   * pruned with the wrong comparison reads it as `flapping` too — the boundary
   * entry is the third survivor. Both are RED here and green everywhere else in
   * this file.
   */
  test("the pruned count is what the threshold is applied to", () => {
    const step = advanceIncident(
      withTransitions("firing"),
      { subject: SERVICE, sweepId: "s-x", at: now, signal: clear("clean/x") },
      NO_RENOTIFY,
    );
    expect(step.record.state).toBe("clear");
    expect(kinds(step.notifications)).toEqual(["recovered"]);
  });

  /** The mirror: with the boundary entry INSIDE, the same sweep does flap. */
  test("one more live transition and the same sweep flaps instead", () => {
    const record: IncidentRecord = {
      ...withTransitions("firing"),
      flap_transitions: [ON_THE_BOUNDARY + 1, INSIDE, INSIDE + 1],
    };
    const step = advanceIncident(
      record,
      { subject: SERVICE, sweepId: "s-x", at: now, signal: clear("clean/x") },
      NO_RENOTIFY,
    );
    expect(step.record.state).toBe("flapping");
    expect(kinds(step.notifications)).toEqual(["flapping"]);
  });
});

/**
 * `flapping → firing` — §6.8's row added 2026-09-06, and §13 task 5.4b.
 *
 * **The hole this closes is the worst shape a notifier has.** A service that
 * flaps and then goes hard down was silent INDEFINITELY: it is not stable, so
 * `flapping → clear` never fires, and it is not `firing`, so the re-notify floor
 * never reaches it. §6.8: *"The service that most needs attention is the one that
 * goes quiet"*.
 *
 * ## The anti-twin is the whole test, and it is asserted first
 *
 * §13 task 5.4b names the trap outright: a machine that RE-OPENS ON EVERY SWEEP
 * satisfies *"flaps then goes down notifies exactly once more"* just as well as a
 * correct one, because that fixture only ever looks at one open. So the
 * still-flapping twin — 288 sweeps of strict alternation, twenty-four full
 * `flap_window`s — must still produce **exactly one notification in total**, and
 * it is the fixture that fails a machine which fires the new edge on the strength
 * of an empty list it never refreshes.
 *
 * ## Instants BY VALUE, never counts
 *
 * §12's re-notify criterion was rewritten this way — *"assert the message
 * instants are exactly `[t0, t0+6h, …]` **BY VALUE**"* — because *"a criterion
 * whose literal count depends on an unstated inclusivity makes a correct
 * implementation red"* (§6.8a). The same applies twice as hard here: *"restarts
 * the re-notify floor"* is a claim about WHERE the first reminder lands, and a
 * count cannot see the difference between a floor restarted at the open and a
 * floor still running from the flapping notice.
 */
describe("flapping → firing — the service that flaps and then goes hard down", () => {
  /** `flap_window` measured in sweeps at the shipped cadence: 3600s / 300s. */
  const WINDOW_SWEEPS = DEFAULTS.flap_window_s / (CADENCE_MS / 1_000);
  /** Four round trips of strict alternation trip the damping on sweep 7. */
  const FLAPPED_AT = 7;
  /** One unbroken window later, and the arithmetic is asserted rather than assumed. */
  const SETTLED_AT = FLAPPED_AT + WINDOW_SWEEPS;

  const alternating = (n: number): IncidentSignal =>
    n % 2 === 0 ? issue("unhealthy") : clear();

  /** Flap through sweep 7, then never recover and never be seen clear again. */
  const flapThenHardDown = (n: number): IncidentSignal =>
    n <= FLAPPED_AT ? alternating(n) : issue("unhealthy");

  test("the fixture's arithmetic is the shipped window, not a hand-picked number", () => {
    expect(WINDOW_SWEEPS).toBe(12);
    expect(SETTLED_AT).toBe(19);
  });

  /**
   * THE EDGE. One more notification, one `flap_window` after the flapping
   * notice, and its instant is asserted by value.
   */
  test("it opens exactly once more, one full window after the flapping notice", () => {
    const { record, notifications } = drive(288, flapThenHardDown, NO_RENOTIFY);

    expect(kinds(notifications)).toEqual(["flapping", "opened"]);
    expect(notifications.map((n) => n.at)).toEqual([
      T0 + FLAPPED_AT * CADENCE_MS,
      T0 + SETTLED_AT * CADENCE_MS,
    ]);
    expect(notifications[1]!.reason).toBe("unhealthy");
    // The sweep's own artifact, not the last clear's: an `opened` that cited the
    // evidence which closed the previous episode would be citing a good report.
    expect(notifications[1]!.evidenceRef).toBe("a/1");
    expect(record.state).toBe("firing");

    /*
     * §6.8's *"how many sweeps"*, and §7.6's definition of the field: sweeps the
     * issue was OBSERVED in. Every sweep from the one after the flapping notice
     * through the settling sweep saw it, which is exactly the window's length —
     * and stating it as the difference rather than as `12` is what keeps the
     * assertion meaningful if the cadence or the window moves.
     */
    expect(notifications[1]!.sweepCount).toBe(SETTLED_AT - FLAPPED_AT);
    expect(record.sweep_count).toBe(287 - FLAPPED_AT);
  });

  /**
   * **THE ANTI-TWIN, and §13 task 5.4b says it is what the edge is graded on.**
   *
   * The same 288 sweeps — twenty-four full `flap_window`s — of a service that
   * never stops flapping. A machine that fires the new edge whenever its pruned
   * transition list is empty, without recording the clears it keeps seeing,
   * re-opens here every window and produces twenty-five notifications. A machine
   * that fires it on every sweep produces two hundred and sixty-nine.
   */
  test("ANTI: a service that keeps flapping still notifies exactly once in total", () => {
    const { record, notifications } = drive(288, alternating, NO_RENOTIFY);

    expect(kinds(notifications)).toEqual(["flapping"]);
    expect(notifications.map((n) => n.at)).toEqual([T0 + FLAPPED_AT * CADENCE_MS]);
    expect(record.state).toBe("flapping");
  });

  /**
   * *"and the re-notify floor restarts"* — §6.8's own words for this row, and the
   * half a count cannot check.
   *
   * The floor runs from `last_notified_at`. If the edge does not stamp it, the
   * clock is still the FLAPPING notice's instant and the first reminder lands
   * twelve sweeps early, at `T0 + 7·cadence + 6h`. Both readings produce three
   * reminders in 288 sweeps, so **only the instants separate them**.
   */
  test("the re-notify floor restarts AT the open, not at the flapping notice", () => {
    const renotifyMs = DEFAULTS.renotify_after_s * 1_000;
    const openedAt = T0 + SETTLED_AT * CADENCE_MS;
    const { notifications } = drive(288, flapThenHardDown, DEFAULTS);

    expect(kinds(notifications)).toEqual([
      "flapping",
      "opened",
      "reminder",
      "reminder",
      "reminder",
    ]);
    expect(notifications.map((n) => n.at)).toEqual([
      T0 + FLAPPED_AT * CADENCE_MS,
      openedAt,
      openedAt + renotifyMs,
      openedAt + 2 * renotifyMs,
      openedAt + 3 * renotifyMs,
    ]);
  });

  /**
   * THE MECHANISM, asserted directly: a clear observed while `flapping` is
   * recorded as a transition.
   *
   * This is what the edge rests on, and it is the line that separates the two
   * fixtures above. §6.8's condition is *"no transitions, and no observed
   * clear"*, and `flap_transitions[]` is already *"timestamps inside
   * `flap_window`"* (§7.6) — so the window being EMPTY is exactly the condition,
   * **provided a clear seen while flapping goes into it.** Without this append
   * the list only ever ages out, and a still-alternating service empties it and
   * gets re-opened as though it had settled.
   *
   * Asserted BY VALUE. A length assertion cannot tell an appended `now` from a
   * survivor that should have been pruned.
   */
  test("a clear observed while flapping is recorded as a transition, by value", () => {
    const now = T0 + 4 * HOUR_MS;
    const windowMs = DEFAULTS.flap_window_s * 1_000;
    const record: IncidentRecord = {
      ...freshIncidentRecord(SERVICE),
      state: "flapping",
      reason: "unhealthy",
      since: now - 3 * windowMs,
      // Recent enough that the stability window is NOT met, so this clear holds
      // the record in `flapping` rather than resolving it.
      last_seen: now - CADENCE_MS,
      sweep_count: 9,
      flap_transitions: [now - 2 * windowMs],
      last_notified_at: now - 3 * windowMs,
    };

    const step = advanceIncident(
      record,
      { subject: SERVICE, sweepId: "s-c", at: now, signal: clear("clean/c") },
      NO_RENOTIFY,
    );

    expect(step.record.state).toBe("flapping");
    expect(step.notifications).toEqual([]);
    // The stale entry aged out and THIS clear went in. Both halves, by value.
    expect(step.record.flap_transitions).toEqual([now]);
  });

  /**
   * THE ASYMMETRIC FIXTURE for the edge's own set test.
   *
   * The condition is the emptiness of a WINDOW-FILTERED list, and this branch's
   * MEMORY records six times that *"a filter survives mutation whenever every
   * fixture makes the two sets equal"*. So the two records below differ in
   * exactly one entry's timestamp, on opposite sides of the boundary, and the
   * survivors are named by value:
   *
   *     fires  : [now − 3·window, now − 2·window]   → nothing inside
   *     silent : [now − 3·window, now − window/2]   → one inside, named
   *
   * `filter(() => true)` fails the first; `filter(() => false)` fails the second.
   */
  describe("the window is a filter here too, and the fixture straddles it", () => {
    const now = T0 + 4 * HOUR_MS;
    const windowMs = DEFAULTS.flap_window_s * 1_000;
    const STALE_OLD = now - 3 * windowMs;
    const STALE_RECENT = now - 2 * windowMs;
    const ON_THE_BOUNDARY = now - windowMs;
    const INSIDE = now - windowMs / 2;

    function flappingWith(transitions: readonly number[]): IncidentRecord {
      return {
        ...freshIncidentRecord(SERVICE),
        state: "flapping",
        reason: "unhealthy",
        since: STALE_OLD,
        last_seen: now - CADENCE_MS,
        sweep_count: 9,
        flap_transitions: [...transitions],
        last_notified_at: STALE_OLD,
      };
    }

    function step(transitions: readonly number[]): IncidentAdvance {
      return advanceIncident(
        flappingWith(transitions),
        { subject: SERVICE, sweepId: "s-x", at: now, signal: issue("unhealthy", "a/x") },
        NO_RENOTIFY,
      );
    }

    test("nothing inside the window settles the record into firing", () => {
      const settled = step([STALE_OLD, STALE_RECENT]);
      expect(kinds(settled.notifications)).toEqual(["opened"]);
      expect(settled.record.state).toBe("firing");
      expect(settled.record.flap_transitions).toEqual([]);
      expect(settled.record.last_notified_at).toBe(now);
      expect(settled.record.since).toBe(now);

      /*
       * `firingForMs` is `0`, on `provisional → firing`'s rule: the state being
       * announced began on THIS sweep. This record's `since` is three windows
       * old, so a machine reporting `at - since` here — the plausible reading,
       * and the one the `recovered` notifications use — says twelve hours and is
       * red. That is why the assertion lives in this fixture and not in one where
       * the two happen to coincide.
       */
      expect(settled.notifications[0]!.firingForMs).toBe(0);
    });

    test("ONE live transition and the same sweep stays flapping and silent", () => {
      const held = step([STALE_OLD, INSIDE]);
      expect(held.notifications).toEqual([]);
      expect(held.record.state).toBe("flapping");
      // The survivor by name, so a filter keeping the wrong entry reddens.
      expect(held.record.flap_transitions).toEqual([INSIDE]);
    });

    /**
     * The boundary itself, both sides. `t > at - window` is exclusive, so a
     * transition exactly one window old has aged out and the record settles;
     * one millisecond later it has not. `>=` swaps both of these.
     */
    test("the boundary is exclusive, on both sides of it", () => {
      expect(kinds(step([ON_THE_BOUNDARY]).notifications)).toEqual(["opened"]);
      expect(step([ON_THE_BOUNDARY + 1]).notifications).toEqual([]);
    });
  });

  /**
   * A flapping record that goes BLIND for a full window also settles, and it
   * settles to `firing`.
   *
   * §6.8's condition column is *"no transitions, and no observed clear"*, and a
   * window of blindness is both. **This is the conservative direction and the
   * only one available**: the record already holds an issue, §6.8 keeps a
   * `firing` record firing through blindness for the same reason, and the
   * alternative — requiring the settling sweep to have SEEN something — leaves a
   * service that flaps and then goes invisible silent forever, which is a hole of
   * the identical shape to the one this edge closes.
   *
   * Nothing was seen, so nothing is cited: `evidenceRef` is `null`, on the
   * coverage escalation's rule that *"a coverage issue that named an artifact
   * would be naming one that does not exist"*.
   */
  /**
   * TASK 5.4c. A flapping service that goes blind escalates as COVERAGE, and it
   * does so through `onUnobserved`'s threshold rather than through the settle
   * edge.
   *
   * This test replaces one that asserted the opposite, and the reason is the
   * WORD in the notification rather than its existence. `settleFlappingIntoFiring`
   * carries the record's last observed reason, so the previous behaviour
   * announced `unhealthy` for a service whose true state was *"we could not see
   * it"* — §6.7 rule 3's misdiagnosis family, in the one console built to tell
   * those apart.
   *
   * It also fires SOONER, and that is worth asserting rather than merely noting:
   * `COVERAGE_THRESHOLD` sweeps against a full `flap_window` is fifteen minutes
   * against an hour at the shipped defaults. **Removing the blind settle closed
   * no hole**, which is the whole argument for removing it.
   */
  test("a flapping record that goes blind escalates as COVERAGE, not as its old reason", () => {
    const { record, notifications } = drive(
      24,
      (n) => (n <= FLAPPED_AT ? alternating(n) : unobserved),
      NO_RENOTIFY,
    );

    expect(kinds(notifications)).toEqual(["flapping", "opened"]);
    expect(notifications[1]!.reason).toBe("coverage");
    expect(notifications[1]!.evidenceRef).toBe(null);
    expect(record.state).toBe("firing");
    expect(record.reason).toBe("coverage");

    /*
     * The instant, BY VALUE, and it is the assertion that separates the two
     * designs. The blind settle fired at `SETTLED_AT`, one `flap_window` after
     * the flapping notice; the escalation fires `COVERAGE_THRESHOLD` blind sweeps
     * after the last observed one. A test asserting only "an opened arrives"
     * passes under both.
     */
    expect(notifications[1]!.at).toBe(T0 + (FLAPPED_AT + COVERAGE_THRESHOLD) * CADENCE_MS);

    /*
     * ZERO OBSERVED SWEEPS, and it is the twin of the hard-down fixture's twelve.
     * §7.6: `sweep_count` counts the sweeps the issue was OBSERVED in, so a
     * settle reached entirely through blindness reports none — *"observed in 40
     * sweeps"* being true of an incident nobody looked at is the same
     * absence-as-evidence mistake §6.8 spends its longest paragraph on.
     */
    expect(notifications[1]!.sweepCount).toBe(0);

    /*
     * The finished episode's timestamps are dropped, on `flapping → clear`'s own
     * rule: carrying them would let one later round trip re-trip a threshold that
     * four round trips earned.
     */
    expect(record.flap_transitions).toEqual([]);
  });

  /**
   * THE ASYMMETRIC FIXTURE, and it exists because the test above could not see
   * the property it asserted.
   *
   * That test ends its alternation at `FLAPPED_AT` and then goes blind, so by the
   * time the escalation fires its `flap_transitions[]` is empty for reasons that
   * have nothing to do with the code under test — and `toEqual([])` passes
   * whether the episode is dropped or carried. **Measured: the mutation
   * `flap_transitions: transitions` survived it.** A fixture in which the two
   * arms agree grades nothing, which is the defect this branch has now recorded
   * seven times.
   *
   * Here the alternation continues four sweeps PAST the flapping notice, so
   * clears keep being appended by §6.8's not-yet-stable branch and the list is
   * genuinely live when the blindness starts. The blind stretch is
   * `COVERAGE_THRESHOLD` sweeps, far inside the twelve-sweep window, so nothing
   * ages out on its own either.
   */
  test("the finished episode is DROPPED, on a fixture where the list is live", () => {
    const ALTERNATE_UNTIL = FLAPPED_AT + 4;
    const timeline = (n: number): IncidentSignal =>
      n <= ALTERNATE_UNTIL ? alternating(n) : unobserved;
    /** `drive`'s first sweep is the zeroth, so the escalating sweep is one past. */
    const ESCALATES_AT = ALTERNATE_UNTIL + COVERAGE_THRESHOLD + 1;
    const { record, notifications } = drive(ESCALATES_AT, timeline, NO_RENOTIFY);

    /*
     * THE PREMISE, ASSERTED RATHER THAN ASSUMED, and it is the half that makes
     * this fixture different from the one it supplements: one sweep before the
     * escalation the record is still `flapping` and its window is genuinely
     * NON-EMPTY. Without this line the test could pass by the same accident —
     * an empty list compared against an empty expectation.
     */
    const before = drive(ESCALATES_AT - 1, timeline, NO_RENOTIFY).record;
    expect(before.state).toBe("flapping");
    expect(before.flap_transitions.length).toBeGreaterThan(0);

    expect(kinds(notifications)).toEqual(["flapping", "opened"]);
    expect(notifications[1]!.reason).toBe("coverage");
    expect(record.state).toBe("firing");
    expect(record.flap_transitions).toEqual([]);
  });

  /**
   * ANTI, and it is what makes the test above mean something. The escalation must
   * not fire on ONE blind sweep — a machine that escalated any blind flapping
   * record immediately passes every assertion above except the instant.
   */
  test("ANTI: fewer than COVERAGE_THRESHOLD blind sweeps compose nothing", () => {
    const { record, notifications } = drive(
      FLAPPED_AT + COVERAGE_THRESHOLD - 1,
      (n) => (n <= FLAPPED_AT ? alternating(n) : unobserved),
      NO_RENOTIFY,
    );
    expect(kinds(notifications)).toEqual(["flapping"]);
    expect(record.state).toBe("flapping");
  });

  /**
   * THE REASON IS THE RECORD'S, and this fixture is the only one that can tell.
   *
   * Every other timeline in this block flaps on `unhealthy`, so a settle that
   * hard-coded the string would be indistinguishable from one that copied the
   * field — a mutation to `const reason: IssueReason = "unhealthy"` survived the
   * first battery for exactly that reason. §6.7 puts `degraded` and `unhealthy`
   * on one axis, and an incident that opened at one amplitude must not be
   * announced at the other.
   */
  test("the settled incident carries the reason it was flapping about", () => {
    const { record, notifications } = drive(
      24,
      (n) => (n <= FLAPPED_AT ? (n % 2 === 0 ? issue("degraded") : clear()) : issue("degraded")),
      NO_RENOTIFY,
    );

    expect(kinds(notifications)).toEqual(["flapping", "opened"]);
    expect(notifications.map((n) => n.reason)).toEqual(["degraded", "degraded"]);
    expect(record.reason).toBe("degraded");
  });

  /**
   * ANTI: the edge does not resurrect a record that recovered.
   *
   * A flapping service that goes stable clears through `flapping → clear`, and
   * `flap_transitions[]` is emptied on the way out (*"one later round trip cannot
   * re-trip a threshold four round trips earned"*). An edge keyed on emptiness
   * alone, evaluated without the state guard, would re-open the incident on the
   * next sweep of a service that is FINE — a false open, which is the direction
   * this console cannot afford twice.
   */
  test("ANTI: a service that recovered is not re-opened by the empty window", () => {
    const { record, notifications } = drive(
      60,
      (n) => (n <= FLAPPED_AT ? alternating(n) : clear()),
      NO_RENOTIFY,
    );

    expect(kinds(notifications)).toEqual(["flapping", "recovered"]);
    expect(record.state).toBe("clear");
    expect(record.flap_transitions).toEqual([]);
  });
});

/**
 * THE RE-NOTIFY FLOOR IS SCOPED TO `firing`, and this block exists because a
 * mutation survived the first battery.
 *
 * §6.8 scopes the floor in three words — *"While `firing`"* — and every fixture
 * above either disables the floor or holds a record `firing` for its whole
 * timeline, so widening the guard to "anything that is not clear" changed nothing
 * any of them could see. Two states are reachable with an old
 * `last_notified_at` and neither may speak:
 *
 *  - **`provisional`**, which would announce an UNCONFIRMED issue — §6.7 rule 1
 *    is that a notification fires on confirmation and never on a first
 *    observation, and a reminder for something never confirmed is that rule
 *    broken by the one mechanism designed to work around silence.
 *  - **`flapping`**, which §6.8 says *"goes quiet"*. A reminder there is the
 *    damping undone six hours at a time.
 */
describe("the re-notify floor speaks only while firing", () => {
  const OLD = T0 - 24 * HOUR_MS;

  /**
   * Reachable with nothing constructed: ninety sweeps of strict alternation at
   * the SHIPPED defaults, floor included. It is the §12 alternating criterion
   * run long enough for the floor to reach, and against the policy the console
   * actually runs rather than a disabled one.
   */
  test("ninety alternating sweeps at the shipped defaults still emit exactly one", () => {
    const { record, notifications } = drive(
      90,
      (n) => (n % 2 === 0 ? issue("unhealthy") : clear()),
      DEFAULTS,
    );
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.kind).toBe("flapping");
    expect(record.state).toBe("flapping");
    // Long enough for the 6h floor to have fired had it applied here: the
    // flapping notice landed on sweep 7 and this timeline runs to sweep 89.
    expect(T0 + 89 * CADENCE_MS - notifications[0]!.at).toBeGreaterThan(
      DEFAULTS.renotify_after_s * 1_000,
    );
  });

  /**
   * `provisional` cannot be held for six hours by sweeping — the coverage
   * escalation takes it at three blind sweeps — so this is a record as task
   * 5.5's validated read would hand one back. That is the whole reason the
   * machine is a pure function over a record rather than over a timeline.
   */
  test("a provisional record with an old notification says nothing", () => {
    const stale: IncidentRecord = {
      ...freshIncidentRecord(SERVICE),
      state: "provisional",
      reason: "unhealthy",
      since: OLD,
      last_seen: OLD,
      sweep_count: 1,
      last_notified_at: OLD,
    };
    expect(sweep(stale, 0, unobserved, DEFAULTS).notifications).toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL, and without it the two assertions above are satisfied
   * by a floor that never fires at all. The same record, the same stale
   * timestamp, the same sweep — differing only in the state — DOES remind.
   */
  test("the same record, firing, does remind — so the silences above are the scope", () => {
    const firing: IncidentRecord = {
      ...freshIncidentRecord(SERVICE),
      state: "firing",
      reason: "unhealthy",
      since: OLD,
      last_seen: OLD,
      sweep_count: 40,
      last_notified_at: OLD,
    };
    const step = sweep(firing, 0, unobserved, DEFAULTS);
    expect(kinds(step.notifications)).toEqual(["reminder"]);
    expect(step.record.last_notified_at).toBe(T0);

    /*
     * The flapping mirror needs a LIVE transition, and the reason is task 5.4b's
     * edge rather than a convenience.
     *
     * §6.8's `flapping → firing` row fires when a full `flap_window` passes with
     * no observed clear, and a record with an EMPTY `flap_transitions[]` is one
     * that has already served that window — so it settles, correctly, and the
     * notification it composes is an `opened`. That is a different rule from the
     * one this block is about. A still-FLAPPING record is one that has seen a
     * clear inside the window, and that is the record this assertion needs.
     *
     * The claim under test is unchanged and is now asserted precisely: while
     * flapping, the six-hour floor composes NOTHING, and in particular no
     * `reminder`. §6.8's *"goes quiet"* would otherwise be undone six hours at a
     * time.
     */
    const flapping: IncidentRecord = {
      ...firing,
      state: "flapping",
      flap_transitions: [T0 - CADENCE_MS],
    };
    const held = sweep(flapping, 0, unobserved, DEFAULTS);
    expect(held.notifications).toEqual([]);
    expect(kinds(held.notifications)).not.toContain("reminder");
    expect(held.record.state).toBe("flapping");

    /*
     * And the twin, so the silence above is the FLOOR being scoped rather than
     * the edge swallowing everything: the same record with nothing live in its
     * window settles, and what it composes is an `opened` — never a `reminder`,
     * which would be the floor reaching a state §6.8 says it does not reach.
     *
     * The settling sweep is an OBSERVED issue, because after task 5.4c that is
     * the only route to `flapping → firing`. A blind sweep here now escalates
     * through the coverage threshold instead, and using one would test the wrong
     * edge while looking identical.
     */
    const settled = sweep(
      { ...flapping, flap_transitions: [] },
      0,
      issue("unhealthy"),
      DEFAULTS,
    );
    expect(kinds(settled.notifications)).toEqual(["opened"]);
    expect(settled.record.state).toBe("firing");
  });
});

describe("saturation suppression — §6.7 rule 3's ordering", () => {
  /**
   * §12's saturation block requires that on a sweep marked saturated *"each
   * service's `consecutive_indeterminate` did **not** advance"*. The verdict that
   * marks a sweep saturated is task 5.3a's; the counter is this module's, and
   * this is the arm that makes the suppression reachable.
   *
   * Asserted by OBJECT IDENTITY. A field-by-field comparison would silently stop
   * covering any field added later; `toBe` cannot.
   */
  test("a suppressed sweep returns the record unchanged, identity included", () => {
    const record = drive(2, () => unobserved, NO_RENOTIFY).record;
    expect(record.consecutive_indeterminate).toBe(2);

    const step = sweep(record, 2, suppressed, NO_RENOTIFY);
    expect(step.record).toBe(record);
    expect(step.notifications).toEqual([]);
  });

  /**
   * And the ordering it exists for: a suppressed third sweep must not escalate
   * to coverage, and the sweep after it must escalate on the third real gap
   * rather than the second. Without the suppression the console tells the
   * operator their cluster is invisible when the fault is one process on their
   * own machine.
   */
  test("a suppressed sweep does not carry a service to the coverage threshold", () => {
    let record = drive(2, () => unobserved, NO_RENOTIFY).record;

    const saturated = sweep(record, 2, suppressed, NO_RENOTIFY);
    expect(saturated.notifications).toEqual([]);
    record = saturated.record;
    expect(record.state).toBe("clear");

    const real = sweep(record, 3, unobserved, NO_RENOTIFY);
    expect(kinds(real.notifications)).toEqual(["opened"]);
    expect(real.notifications[0]!.reason).toBe("coverage");
  });

  /** A suppressed sweep on a firing record is silent, reminder floor included. */
  test("a suppressed sweep neither recovers nor reminds", () => {
    const firing = drive(2, () => issue("unhealthy"), DEFAULTS).record;
    const long = { ...firing, last_notified_at: T0 - 24 * HOUR_MS };
    const step = sweep(long, 2, suppressed, DEFAULTS);
    expect(step.record).toBe(long);
    expect(step.notifications).toEqual([]);
  });
});

describe("one machine — §13 task 5.4a's premise, asserted rather than promised", () => {
  /**
   * Task 5.4a: *"**If this task finds itself writing a second state machine, it
   * has gone wrong**"*. What makes that true is that nothing here reads the
   * identity or the reason — so §6.8a's `(scope, kind)` is a union member and six
   * more tokens, and no function body changes.
   *
   * The claim is stated in the module as an exported constant so a reader of the
   * module meets it, and driven here so it is a test rather than a comment.
   */
  test("the machine's output does not vary with the subject", () => {
    expect(ADVANCE_READS_NO_SUBJECT_FIELD).toContain("never inspects");

    const other: IncidentSubject = {
      kind: "service",
      environment: "saas-dev",
      service: "mia",
    };
    const timeline = (n: number): IncidentSignal =>
      n % 3 === 2 ? clear() : n % 5 === 0 ? unobserved : issue("unhealthy");

    let a = freshIncidentRecord(SERVICE);
    let b = freshIncidentRecord(other);
    for (let n = 0; n < 40; n += 1) {
      const stepA = sweep(a, n, timeline(n), DEFAULTS, SERVICE);
      const stepB = sweep(b, n, timeline(n), DEFAULTS, other);
      expect(kinds(stepB.notifications)).toEqual(kinds(stepA.notifications));
      // Every notification names ITS OWN subject, copied through untouched.
      for (const note of stepB.notifications) expect(note.subject).toEqual(other);
      const rebased: IncidentRecord = { ...stepB.record, subject: SERVICE };
      expect(rebased).toEqual(stepA.record);
      a = stepA.record;
      b = stepB.record;
    }
    expect(a.state).toBe(b.state);
  });

  test("the machine's output does not vary with the issue reason", () => {
    expect(ADVANCE_READS_NO_ISSUE_REASON).toContain("never branches on it");

    const reasons: ObservedIssueReason[] = ["unhealthy", "degraded"];
    const timeline = (n: number): boolean => n % 3 !== 2;

    const runs = reasons.map((reason) => {
      let record = freshIncidentRecord(SERVICE);
      const notes: IncidentNotification[] = [];
      for (let n = 0; n < 24; n += 1) {
        const step = sweep(record, n, timeline(n) ? issue(reason) : clear(), NO_RENOTIFY);
        record = step.record;
        notes.push(...step.notifications);
      }
      return { record, notes };
    });

    expect(kinds(runs[1]!.notes)).toEqual(kinds(runs[0]!.notes));
    expect(runs[1]!.record.state).toBe(runs[0]!.record.state);
    // The reason is CARRIED, not ignored: each run's notifications name its own.
    for (const [i, reason] of reasons.entries()) {
      for (const note of runs[i]!.notes) {
        if (note.reason === "coverage") continue;
        expect(note.reason).toBe(reason);
      }
    }
  });

  /**
   * A record and an observation for different subjects is a HOST bug — the
   * caller loaded the wrong file — and continuing would write one service's
   * state into another's record. `triage-partition.ts` draws the same line: a
   * value for untrusted container output, a throw for a host argument that is
   * wrong for the life of the run.
   */
  test("a record advanced with another subject's observation throws", () => {
    const record = freshIncidentRecord(SERVICE);
    const foreign: IncidentSubject = {
      kind: "service",
      environment: "cni-prod",
      service: "authentication",
    };
    expect(() =>
      advanceIncident(
        record,
        { subject: foreign, sweepId: "s-0", at: T0, signal: issue("unhealthy") },
        DEFAULTS,
      ),
    ).toThrow(/authorization/);
    expect(subjectKey(foreign)).not.toBe(subjectKey(SERVICE));
  });
});

describe("the record's own shape", () => {
  /** Two fresh records must not share an array; zod's by-reference default bug. */
  test("freshIncidentRecord hands out no shared arrays", () => {
    const a = freshIncidentRecord(SERVICE);
    const b = freshIncidentRecord(SERVICE);
    expect(a.flap_transitions).not.toBe(b.flap_transitions);
    expect(a.undelivered).not.toBe(b.undelivered);
  });

  /**
   * §6.9 requirement 7 in advance: *"a delivery failure never advances or clears
   * an incident"*, which is only checkable if the transition and the delivery
   * touch different fields. This module must never write `undelivered[]`, and a
   * long mixed timeline is where a stray write would show up.
   */
  test("no transition writes undelivered[] — that is 5.6b's field", () => {
    const seeded: IncidentRecord = {
      ...freshIncidentRecord(SERVICE),
      undelivered: ["n-1", "n-2"],
    };
    let record = seeded;
    for (let n = 0; n < 30; n += 1) {
      record = sweep(
        record,
        n,
        n % 4 === 3 ? clear() : n % 7 === 0 ? unobserved : issue("unhealthy"),
        DEFAULTS,
      ).record;
      expect(record.undelivered).toEqual(["n-1", "n-2"]);
    }
  });

  /**
   * The three knobs this module spends are the SCHEMA's, not a second copy. §12:
   * *"no `src/` module reads a triage tuning value that
   * `TriageConsoleConfigSchema` does not define"*.
   */
  test("the policy is the console config's own defaults", () => {
    const shipped = defaultTriageConsoleConfig();
    expect(DEFAULTS.flap_threshold).toBe(shipped.flap_threshold);
    expect(DEFAULTS.flap_window_s).toBe(shipped.flap_window_s);
    expect(DEFAULTS.renotify_after_s).toBe(shipped.renotify_after_s);
    // And the escalation threshold is NOT one of them — §7.8 names nine values
    // and this is not among them, so it lives here as a named constant.
    expect(COVERAGE_THRESHOLD).toBe(3);
    expect(shipped).not.toHaveProperty("coverage_threshold");
  });
});

// ---------------------------------------------------------------------------
// §7.6 — the record on disk, and the validated read (§13 task 5.5)
// ---------------------------------------------------------------------------

/**
 * The runs-root seam every hermetic test in this repository uses, so no
 * assertion below can name a path under the operator's own `~/.pifleet`.
 *
 * ISC-614's rule stated as a fixture: `~/.pifleet` is keyed off `$HOME` rather
 * than off the checkout, so isolating the TREE isolates nothing here.
 */
const ENV = { PIFLEET_RUNS_DIR: "/tmp/pifleet-fixture/runs" };

/** A `_console`-scoped console-health subject, and an environment-scoped one. */
const SKIPS: IncidentSubject = {
  kind: "console_health",
  scope: CONSOLE_SCOPE,
  health: "sweeps_skipped",
};
const BLOCKED: IncidentSubject = {
  kind: "console_health",
  scope: "cni-prod",
  health: "observer_blocked",
};

const PATH = "/tmp/pifleet-fixture/triage/cni-prod/authorization.json";

/** A record as JSON, the way a previous run left it. */
const onDisk = (record: unknown): string => JSON.stringify(record);

/** Parse, and fail loudly rather than silently skipping when it refuses. */
function parsedOk(text: string, expected: IncidentSubject = SERVICE): IncidentRecord {
  const read = parseIncidentRecord(text, expected, PATH);
  if (read.kind !== "ok") throw new Error(`expected ok, got ${read.code}: ${read.reason}`);
  return read.record;
}

function refused(
  text: string,
  expected: IncidentSubject = SERVICE,
): Extract<IncidentRecordRead, { kind: "refused" }> {
  const read = parseIncidentRecord(text, expected, PATH);
  if (read.kind !== "refused") throw new Error(`expected a refusal, got ${read.kind}`);
  return read;
}

describe("the record class this task exists to make reachable — §13 task 5.5", () => {
  /**
   * **THE test for this task**, and the reason §7.6's schema is not hygiene.
   *
   * A mutation battery found `blind >= COVERAGE_THRESHOLD` and
   * `blind === COVERAGE_THRESHOLD` indistinguishable on every record the machine
   * itself wrote, because the counter advances by one per sweep and is reset by
   * any observation — so it passes THROUGH the threshold and never over it. The
   * two spellings part company on exactly one input: a record read from disk
   * whose counter is already past it, where `===` steps over forever and leaves
   * a service permanently invisible and permanently silent.
   *
   * Nothing could construct that record before this task, because nothing read
   * one. The premise is asserted rather than assumed: the fixture is only
   * meaningful if the NEXT counter value overshoots the threshold, and that is
   * the assertion `===` fails on.
   */
  test("a clear record whose counter is already past the threshold escalates on the next sweep", () => {
    const stale = {
      ...freshIncidentRecord(SERVICE),
      // An older build, a half-written file, or an operator's editor. All three
      // produce a record the machine's own arithmetic cannot.
      consecutive_indeterminate: COVERAGE_THRESHOLD + 2,
    };
    const record = parsedOk(onDisk(stale));

    // PREMISE, one step earlier and in an assertion rather than a comment: this
    // record OVERSHOOTS the threshold on its next blind sweep. A fixture landing
    // exactly on it would make `===` and `>=` agree and prove nothing.
    expect(record.state).toBe("clear");
    expect(record.consecutive_indeterminate + 1).toBeGreaterThan(COVERAGE_THRESHOLD);
    expect(record.consecutive_indeterminate + 1).not.toBe(COVERAGE_THRESHOLD);

    const step = sweep(record, 0, unobserved);
    expect(step.notifications).toHaveLength(1);
    expect(step.notifications[0]!.kind).toBe("opened");
    expect(step.notifications[0]!.reason).toBe("coverage");
    expect(step.notifications[0]!.evidenceRef).toBeNull();
    expect(step.record.state).toBe("firing");
  });

  /**
   * The anti-twin, and it is what says the fixture above HAD to come off disk.
   *
   * Driven from a fresh record the machine wrote itself, the counter lands on the
   * threshold exactly — so `===` and `>=` agree here, and every fixture that
   * starts from `freshIncidentRecord` is blind to the difference between them.
   */
  test("a record the machine wrote reaches the threshold exactly, where === and >= agree", () => {
    const { record, notifications } = drive(COVERAGE_THRESHOLD, () => unobserved);

    expect(record.consecutive_indeterminate).toBe(COVERAGE_THRESHOLD);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.reason).toBe("coverage");
  });

  /**
   * And the same record, blind again the sweep after: `firing` on `coverage` is
   * not re-announced. The state guard is what turns a day of invisibility into
   * one notification, and it must survive a record arriving from disk too.
   */
  test("a firing coverage record read back from disk does not re-open", () => {
    const first = parsedOk(
      onDisk({
        ...freshIncidentRecord(SERVICE),
        consecutive_indeterminate: COVERAGE_THRESHOLD + 2,
      }),
    );
    const opened = sweep(first, 0, unobserved);
    // Round-tripped through JSON, as the actor would: write, then read next sweep.
    const reread = parsedOk(onDisk(opened.record));
    expect(reread).toEqual(opened.record);

    const next = sweep(reread, 1, unobserved, NO_RENOTIFY);
    expect(next.notifications).toEqual([]);
    expect(next.record.state).toBe("firing");
  });
});

describe("every record the machine can write is a record the schema accepts", () => {
  /**
   * The property that stops this console refusing its OWN files.
   *
   * A schema derived from the record type can still disagree with the values the
   * machine produces — a `.min(1)`, a missing nullable, an enum that lost a
   * member. So a long mixed timeline is round-tripped through `JSON.stringify`
   * and the parser after EVERY sweep, which is the only way to cover the states
   * and field combinations the machine actually reaches rather than the ones a
   * fixture author thought of.
   */
  test("a 60-sweep mixed timeline round-trips at every step", () => {
    let record = freshIncidentRecord(SERVICE);
    const seen = new Set<string>();
    for (let n = 0; n < 60; n += 1) {
      const signal =
        n % 11 === 0
          ? unobserved
          : n % 3 === 2
            ? clear()
            : n % 7 === 5
              ? issue("degraded")
              : issue("unhealthy");
      record = sweep(record, n, signal).record;
      seen.add(record.state);
      expect(parsedOk(onDisk(record))).toEqual(record);
    }
    /*
     * PREMISE: the timeline actually visited more than one state. A round-trip
     * assertion over a record that never left `clear` would be satisfied by a
     * schema that only knew about `clear`, which is the degenerate shape of this
     * whole family of test.
     */
    expect(seen.size).toBeGreaterThan(2);
    expect(seen.has("firing")).toBe(true);
    expect(seen.has("flapping")).toBe(true);
  });

  test("a fresh record of each subject kind round-trips", () => {
    for (const subject of [SERVICE, SKIPS, BLOCKED]) {
      const fresh = freshIncidentRecord(subject);
      expect(parsedOk(onDisk(fresh), subject)).toEqual(fresh);
    }
  });
});

describe("what a malformed record does — §7.6's 'refuses rather than being acted on'", () => {
  /**
   * Every fixture below is {@link freshIncidentRecord} with EXACTLY ONE thing
   * changed, and the premise is asserted rather than commented: the unmutated
   * record must parse, or a refusal proves nothing about the mutation.
   */
  const base = (): Record<string, unknown> => ({ ...freshIncidentRecord(SERVICE) });

  function refusalFor(mutate: (r: Record<string, unknown>) => void) {
    expect(parseIncidentRecord(onDisk(base()), SERVICE, PATH).kind).toBe("ok");
    const record = base();
    mutate(record);
    return refused(onDisk(record));
  }

  test("bytes that are not JSON refuse as not_json", () => {
    expect(parseIncidentRecord(onDisk(base()), SERVICE, PATH).kind).toBe("ok");
    const read = refused('{"state": ');
    expect(read.code).toBe("not_json");
    expect(read.reason).toContain(PATH);
  });

  test.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "7"],
  ])("a record that is %s refuses as not_an_object", (_label, text) => {
    expect(parseIncidentRecord(onDisk(base()), SERVICE, PATH).kind).toBe("ok");
    const read = refused(text);
    expect(read.code).toBe("not_an_object");
    expect(read.code).not.toBe("schema");
  });

  test("a missing field refuses at its path as missing", () => {
    const read = refusalFor((r) => {
      delete r.sweep_count;
    });
    expect(read.code).toBe("schema");
    expect(read.issues).toHaveLength(1);
    expect(read.issues[0]!.path).toBe("sweep_count");
    expect(read.issues[0]!.fault).toBe("missing");
  });

  test("a state outside INCIDENT_STATES refuses as invalid, at the same kind of path", () => {
    const read = refusalFor((r) => {
      r.state = "degraded";
    });
    expect(read.code).toBe("schema");
    expect(read.issues[0]!.path).toBe("state");
    expect(read.issues[0]!.fault).toBe("invalid");
  });

  /**
   * The SECOND closed domain, and it needs its own fixture.
   *
   * A battery found `reason: z.enum(ISSUE_REASONS)` → `z.string()` SURVIVING while
   * the identical mutation on `state` died: the suite pinned one enum and left the
   * other to be assumed from it. Two closed sets on one object are two claims, and
   * a reader who saw the `state` test would have believed both.
   *
   * `degraded` is a deliberate choice for the state fixture above and `firing` for
   * this one: each is a legal member of the OTHER field's domain, so a schema that
   * had crossed the two enums fails both tests rather than passing both.
   */
  test("a reason outside ISSUE_REASONS refuses as invalid", () => {
    const read = refusalFor((r) => {
      r.reason = "firing";
    });
    expect(read.code).toBe("schema");
    expect(read.issues[0]!.path).toBe("reason");
    expect(read.issues[0]!.fault).toBe("invalid");

    // And the domain is populated as well as closed: every member parses.
    for (const reason of ISSUE_REASONS) {
      expect(parsedOk(onDisk({ ...freshIncidentRecord(SERVICE), reason }))).toHaveProperty(
        "reason",
        reason,
      );
    }
  });

  /**
   * The arrays are BOUNDED, and the bound is not zero.
   *
   * A refusal-only assertion would pass a schema with `.max(0)`, which refuses
   * every record a flapping service produces — so the premise is asserted one step
   * earlier: a list AT the cap parses. That pair is what makes the bound
   * load-bearing rather than merely present.
   */
  test("flap_transitions and undelivered are bounded, and the bounds admit a full list", () => {
    const atCap: IncidentRecord = {
      ...freshIncidentRecord(SERVICE),
      flap_transitions: Array.from({ length: MAX_FLAP_TRANSITIONS }, (_, i) => T0 + i),
      undelivered: Array.from({ length: MAX_UNDELIVERED }, (_, i) => `n-${i}`),
    };
    expect(parsedOk(onDisk(atCap)).flap_transitions).toHaveLength(MAX_FLAP_TRANSITIONS);
    expect(parsedOk(onDisk(atCap)).undelivered).toHaveLength(MAX_UNDELIVERED);

    expect(
      refused(onDisk({ ...atCap, flap_transitions: [...atCap.flap_transitions, T0] })).issues[0]!
        .path,
    ).toBe("flap_transitions");
    expect(
      refused(onDisk({ ...atCap, undelivered: [...atCap.undelivered, "n"] })).issues[0]!.path,
    ).toBe("undelivered");
  });

  /**
   * The two above are DISTINGUISHABLE, asserted directly. Zod answers a missing
   * `z.enum` key and an unknown `z.enum` value with one identical issue — same
   * code, same path, same message — so without this module's own classification
   * these two faults would be one fault, and an operator whose record lost a
   * field would be told to check the spelling of a field that is not there.
   */
  test("a missing state and a bad state are two faults, not one", () => {
    const absent = refusalFor((r) => {
      delete r.state;
    });
    const wrong = refusalFor((r) => {
      r.state = "degraded";
    });
    expect(absent.issues[0]!.path).toBe(wrong.issues[0]!.path);
    expect(absent.issues[0]!.fault).not.toBe(wrong.issues[0]!.fault);
    expect(absent.issues[0]!.message).not.toContain("Invalid option");
  });

  test("an unrecognized key refuses and is named", () => {
    const read = refusalFor((r) => {
      r.acknowledged = true;
    });
    expect(read.issues[0]!.path).toBe("acknowledged");
    expect(read.issues[0]!.fault).toBe("unrecognized");
  });

  test("a non-integer or negative timestamp refuses", () => {
    expect(
      refusalFor((r) => {
        r.since = 1.5;
      }).issues[0]!.path,
    ).toBe("since");
    expect(
      refusalFor((r) => {
        r.last_seen = -1;
      }).issues[0]!.path,
    ).toBe("last_seen");
    expect(
      refusalFor((r) => {
        r.sweep_count = -2;
      }).issues[0]!.path,
    ).toBe("sweep_count");
  });

  /**
   * **`subject_mismatch` is its own code and is reachable on its own.** The
   * record is otherwise perfect — this is a file that was copied, moved, or read
   * from a path built for another subject, and it is the failure
   * `advanceIncident` throws on when the actor gets it wrong.
   */
  test("a well-formed record about another subject refuses as subject_mismatch", () => {
    const other: IncidentSubject = { kind: "service", environment: "cni-prod", service: "mia" };
    // PREMISE: the record itself is clean — it parses when read as its own subject.
    expect(parseIncidentRecord(onDisk(freshIncidentRecord(other)), other, PATH).kind).toBe("ok");

    const read = refused(onDisk(freshIncidentRecord(other)), SERVICE);
    expect(read.code).toBe("subject_mismatch");
    expect(read.issues).toEqual([]);
    expect(read.reason).toContain("mia");
    expect(read.reason).toContain("authorization");
  });

  /** And across the two record KINDS, which is the mismatch a path bug produces. */
  test("a console-health record read as a service record refuses as subject_mismatch", () => {
    const read = refused(onDisk(freshIncidentRecord(SKIPS)), SERVICE);
    expect(read.code).toBe("subject_mismatch");
  });

  /**
   * The four codes are distinct and each is reachable by exactly one fault, so a
   * suite cannot satisfy one of them with a fixture that is wrong in three ways.
   */
  test("the four refusal codes are four", () => {
    const codes = new Set([
      refused('{"state": ').code,
      refused("[]").code,
      refusalFor((r) => {
        delete r.state;
      }).code,
      refused(onDisk(freshIncidentRecord(SKIPS)), SERVICE).code,
    ]);
    expect([...codes].sort()).toEqual(["not_an_object", "not_json", "schema", "subject_mismatch"]);
  });

  /**
   * **A record that is internally inconsistent but well TYPED still parses**, and
   * this is a decision rather than an omission.
   *
   * `state: "clear"` with a non-null reason, or with a live counter, is exactly
   * the class of record this task exists to admit — see the block at the top of
   * this section. A `.superRefine` that refused it would put the validator in the
   * business of deciding what the machine should have written, and would delete
   * the only input that distinguishes `>=` from `===`.
   */
  test("an internally inconsistent but well-typed record parses", () => {
    const odd: IncidentRecord = {
      ...freshIncidentRecord(SERVICE),
      state: "clear",
      reason: "unhealthy",
      consecutive_indeterminate: 40,
      sweep_count: 12,
      last_notified_at: T0,
    };
    expect(parsedOk(onDisk(odd))).toEqual(odd);
  });
});

describe("the record's path — §7.6, §6.8a, and the traversal argument", () => {
  test("a service record is <root>/<env>/<service>.json", () => {
    const path = incidentRecordPath(SERVICE, ENV);
    expect(path).toBe(join(incidentRecordRoot(ENV), "cni-prod", "authorization.json"));
    // And the literal spelling §7.6 fixes, so a derived-equality assertion alone
    // cannot pass a builder that changed the layout on both sides.
    expect(path.endsWith("/cni-prod/authorization.json")).toBe(true);
  });

  test("a console-health record is <root>/<scope>/_console/<kind>.json", () => {
    expect(incidentRecordPath(SKIPS, ENV).endsWith("/_console/_console/sweeps_skipped.json")).toBe(
      true,
    );
    expect(
      incidentRecordPath(BLOCKED, ENV).endsWith("/cni-prod/_console/observer_blocked.json"),
    ).toBe(true);
  });

  test("the root is beside the runs root and follows PIFLEET_RUNS_DIR", () => {
    expect(incidentRecordRoot(ENV)).toBe("/tmp/pifleet-fixture/triage");
    expect(incidentRecordRoot({ PIFLEET_RUNS_DIR: "/other/runs" })).toBe("/other/triage");
  });

  /**
   * `join` resolves `..` rather than refusing it, so the check belongs in the
   * BUILDER — `dispatchRequestPath`'s measured argument, where an unchecked id
   * returned `/etc/dispatch-request.json` without a word.
   */
  test.each([["../../etc/passwd"], ["a/b"], [".."], [""], ["with space"]])(
    "a service named %p throws rather than joining",
    (service) => {
      expect(() =>
        incidentRecordPath({ kind: "service", environment: "cni-prod", service }, ENV),
      ).toThrow(IncidentPathError);
    },
  );

  test("an environment or scope that cannot be spelled throws too", () => {
    expect(() =>
      incidentRecordPath({ kind: "service", environment: "../..", service: "mia" }, ENV),
    ).toThrow(IncidentPathError);
    expect(() =>
      incidentRecordPath({ kind: "console_health", scope: "../..", health: "sweeps_skipped" }, ENV),
    ).toThrow(IncidentPathError);
  });

  /**
   * **The two record kinds cannot name the same file**, and it is structural
   * rather than lucky: `CONSOLE_SCOPE` begins with `_`, and `SESSION_ID_RE`
   * requires an alphanumeric first character — so no environment and no service
   * can ever be called `_console`. Asserted from both ends: the grammar refuses
   * the name, and the schema refuses a record carrying it.
   */
  /**
   * **This test was DEGENERATE when first written, and a mutation battery said
   * so.** The schema half read the smuggled record as `SERVICE`'s, so
   * `subject_mismatch` refused it before the token grammar was ever consulted —
   * and `expect(read.kind).toBe("refused")` was green whether `recordToken`
   * carried its regex or was a bare `z.string()`. Two refusals, one assertion,
   * and the wrong one doing the work: the seventh-appearance defect, in the
   * repair for it.
   *
   * The fix is to read the record as ITS OWN subject, so the subject comparison
   * cannot fire and only the grammar can refuse — and then to assert the CODE
   * rather than the kind, so which refusal answered is part of the claim.
   */
  test("no environment or service can be named _console, so the two layouts cannot collide", () => {
    const asConsole: IncidentSubject = {
      kind: "service",
      environment: CONSOLE_SCOPE,
      service: "mia",
    };
    expect(() => incidentRecordPath(asConsole, ENV)).toThrow(IncidentPathError);

    // PREMISE: read as its own subject, `subject_mismatch` is unreachable — the
    // identical record with a LEGAL environment parses through this same call.
    const legal: IncidentSubject = { kind: "service", environment: "cni-prod", service: "mia" };
    expect(parseIncidentRecord(onDisk(freshIncidentRecord(legal)), legal, PATH).kind).toBe("ok");

    const smuggled = { ...freshIncidentRecord(legal), subject: asConsole };
    const read = parseIncidentRecord(onDisk(smuggled), asConsole, PATH);
    if (read.kind !== "refused") throw new Error("expected a refusal");
    expect(read.code).toBe("schema");
    expect(read.code).not.toBe("subject_mismatch");
    expect(read.issues[0]!.path).toBe("subject.environment");

    // And the paths differ for every pair of subjects this console can hold.
    const paths = [SERVICE, SKIPS, BLOCKED].map((s) => incidentRecordPath(s, ENV));
    expect(new Set(paths).size).toBe(paths.length);
  });

  /**
   * The same grammar on the other three subject fields, each read as its own
   * subject for the reason above. `service` and `scope` are separate members of
   * separate union arms, so one fixture cannot stand for the others.
   */
  test("a traversal in any subject field is refused by the SCHEMA, not only by the builder", () => {
    const bad: IncidentSubject[] = [
      { kind: "service", environment: "../..", service: "mia" },
      { kind: "service", environment: "cni-prod", service: "../../etc/passwd" },
      { kind: "console_health", scope: "a/b", health: "sweeps_skipped" },
    ];
    for (const subject of bad) {
      const record = { ...freshIncidentRecord(SERVICE), subject };
      const read = parseIncidentRecord(onDisk(record), subject, PATH);
      if (read.kind !== "refused") throw new Error(`expected a refusal for ${JSON.stringify(subject)}`);
      expect(read.code).toBe("schema");
      expect(read.issues[0]!.path.startsWith("subject.")).toBe(true);
    }
  });
});

describe("loadIncidentRecord — a missing file is not a malformed one", () => {
  const readingNothing = { readText: async () => null };

  test("a missing file resolves to a fresh record for the subject", async () => {
    const read = await loadIncidentRecord({ subject: SERVICE, deps: readingNothing, env: ENV });
    if (read.kind !== "ok") throw new Error(read.reason);
    expect(read.record).toEqual(freshIncidentRecord(SERVICE));
  });

  /**
   * **The two must not be collapsed, and this pair is what says so.** A console
   * watching nine services has nine missing files on its first sweep; a file that
   * exists and cannot be read is a service whose incident state is now unknown,
   * and reading it as "never seen" would silently clear a firing incident and
   * swallow its recovery notification.
   */
  test("a malformed file refuses and does NOT fall back to a fresh record", async () => {
    const read = await loadIncidentRecord({
      subject: SERVICE,
      deps: { readText: async () => "{ not json" },
      env: ENV,
    });
    expect(read.kind).toBe("refused");
    // There is no `record` on the refused arm — the fallback is unavailable
    // rather than merely unused.
    expect(read).not.toHaveProperty("record");
  });

  test("it reads the path the subject derives, and takes an override", async () => {
    const seen: string[] = [];
    const deps = {
      readText: async (path: string) => {
        seen.push(path);
        return null;
      },
    };
    await loadIncidentRecord({ subject: BLOCKED, deps, env: ENV });
    await loadIncidentRecord({ subject: BLOCKED, deps, env: ENV, path: "/elsewhere/x.json" });
    expect(seen[0]).toBe(incidentRecordPath(BLOCKED, ENV));
    expect(seen[1]).toBe("/elsewhere/x.json");
  });
});

/**
 * §13 task 6.1's widened *Touches* line — the writer, beside its reader.
 *
 * §13's argument for the placement, verbatim: §7.6's record *"is per-SUBJECT with
 * its own schema and its own path helpers, all of which live in
 * `triage-incident.ts`, so a writer that does not sit beside its reader becomes a
 * second definition of where those files are"*.
 *
 * **The property that matters is the ROUND TRIP**, and it is only checkable at
 * the byte boundary — which is why the port is typed `(path, text)` rather than
 * `(path, record)`. Every test below writes through a spy and then feeds the
 * captured bytes to `parseIncidentRecord`, which is the function that will
 * actually read them back on the next sweep.
 */
describe("saveIncidentRecord — the writer §7.6 was missing", () => {
  function spy(): {
    readonly deps: { writeText: (p: string, t: string) => Promise<void> };
    readonly writes: Array<{ path: string; text: string }>;
  } {
    const writes: Array<{ path: string; text: string }> = [];
    return {
      writes,
      deps: {
        writeText: async (path: string, text: string) => {
          writes.push({ path, text });
        },
      },
    };
  }

  /** A record with every field at a non-default value, so a dropped one shows. */
  function populated(): IncidentRecord {
    return {
      subject: SERVICE,
      state: "flapping",
      reason: "degraded",
      since: T0,
      last_seen: T0 + 1_000,
      sweep_count: 7,
      consecutive_indeterminate: 2,
      flap_transitions: [T0 - 3_000, T0 - 1_000],
      last_notified_at: T0 + 2_000,
      undelivered: ["triage: mia degraded (opened) [cni-prod]"],
      last_artifact_ref: "T-sweep-9/observer-ops.json",
    };
  }

  test("what it writes is what parseIncidentRecord reads back, field for field", async () => {
    const wire = spy();
    const record = populated();
    const path = await saveIncidentRecord({ record, deps: wire.deps, env: ENV });
    expect(wire.writes).toHaveLength(1);
    const read = parseIncidentRecord(wire.writes[0]!.text, SERVICE, path);
    if (read.kind !== "ok") throw new Error(read.reason);
    expect(read.record).toEqual(record);
  });

  test("it writes the path the subject derives, follows PIFLEET_RUNS_DIR, and takes an override", async () => {
    const wire = spy();
    const written = await saveIncidentRecord({
      record: { ...freshIncidentRecord(BLOCKED), subject: BLOCKED },
      deps: wire.deps,
      env: ENV,
    });
    expect(written).toBe(incidentRecordPath(BLOCKED, ENV));
    expect(wire.writes[0]!.path).toBe(incidentRecordPath(BLOCKED, ENV));

    const elsewhere = await saveIncidentRecord({
      record: freshIncidentRecord(SERVICE),
      deps: wire.deps,
      env: ENV,
      path: "/elsewhere/x.json",
    });
    expect(elsewhere).toBe("/elsewhere/x.json");
  });

  /**
   * **Reading a bad file is history; writing one is a bug** —
   * `writeTriageActorRecord`'s split, and it is load-bearing rather than tidy
   * here: `parseIncidentRecord` has NO fallback from a refusal to a fresh record,
   * so a file this function was allowed to write badly would be unreadable for
   * the life of the console.
   *
   * The pair is asserted, not just the throw: **nothing was written**. A
   * validator that ran after the write would satisfy a bare `expect(...).toThrow`
   * and would still have left the bad bytes on disk.
   */
  test("a record the schema rejects THROWS and writes nothing", async () => {
    const wire = spy();
    const broken = { ...freshIncidentRecord(SERVICE), sweep_count: -1 } as IncidentRecord;
    await expect(saveIncidentRecord({ record: broken, deps: wire.deps, env: ENV })).rejects.toThrow();
    expect(wire.writes).toEqual([]);
  });

  test("an unrecognized key THROWS and writes nothing — §7.6 fixes the fields", async () => {
    const wire = spy();
    const extra = { ...freshIncidentRecord(SERVICE), notes: "hand-added" } as unknown as IncidentRecord;
    await expect(saveIncidentRecord({ record: extra, deps: wire.deps, env: ENV })).rejects.toThrow();
    expect(wire.writes).toEqual([]);
  });

  /**
   * The two gates agree by construction — both are `SESSION_ID_RE` — and the
   * ORDER decides which message the caller gets. Validation runs first, so a
   * traversal is refused as a VALUE naming the field rather than as an
   * `IncidentPathError` naming a path that was never built.
   */
  test("a traversal subject is refused by the schema BEFORE a path is derived", async () => {
    const wire = spy();
    const subject: IncidentSubject = { kind: "service", environment: "../..", service: "mia" };
    const record = { ...freshIncidentRecord(SERVICE), subject };
    await expect(saveIncidentRecord({ record, deps: wire.deps, env: ENV })).rejects.toThrow();
    expect(wire.writes).toEqual([]);
    // And the builder would have refused it too, so neither gate is the only one.
    expect(() => incidentRecordPath(subject, ENV)).toThrow(IncidentPathError);
  });

  test("the default deps carry a writer as well as a reader", () => {
    expect(typeof DEFAULT_INCIDENT_RECORD_DEPS.readText).toBe("function");
    expect(typeof DEFAULT_INCIDENT_RECORD_DEPS.writeText).toBe("function");
  });

  /**
   * The ONE test in this file that touches a disk, and it is isolated by
   * `PIFLEET_RUNS_DIR` under a temporary directory rather than by hope.
   *
   * MEMORY, and task 6.3 found a leaked record from an earlier round by doing
   * exactly this: `~/.pifleet` is keyed off `$HOME`, so a test that exercised the
   * default writer without an override would write the operator's own console
   * state. Both variables are set and the tree is removed afterwards.
   */
  test("the DEFAULT writer round-trips through a real file, under a temp runs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-incident-"));
    try {
      const env = { HOME: root, PIFLEET_RUNS_DIR: join(root, ".pifleet", "runs") };
      const record = populated();
      const path = await saveIncidentRecord({ record, env });
      expect(path).toBe(incidentRecordPath(SERVICE, env));
      expect(path.startsWith(root)).toBe(true);
      const back = await loadIncidentRecord({ subject: SERVICE, env });
      if (back.kind !== "ok") throw new Error(back.reason);
      expect(back.record).toEqual(record);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
// ---------------------------------------------------------------------------
// §13 task 6.2a — the census, tested beside the function it now lives with
// ---------------------------------------------------------------------------

/**
 * §13 task 6.2a's structural half — the census moved, and **nothing was left
 * behind**, asserted on COMMENT-STRIPPED source so the docblock that explains
 * the move cannot redden its own probe.
 *
 * Task 6.1's recorded argument is the criterion: *"a writer that does not sit
 * beside its reader becomes a second definition of where those files are."* A
 * re-export left in the command would be exactly that second definition — one
 * more place a caller can learn the layout from, and one more place that stops
 * agreeing the day `incidentRecordPath` grows a third shape. The command is a
 * CONSUMER now, and the import edge is what says so.
 */
describe("§13 task 6.2a: the census lives beside its readers, and nowhere else", () => {
  const commandSource = stripComments(
    readFileSync(join(import.meta.dir, "../../src/cli/commands/triage.ts"), "utf8"),
  );

  test("cli/commands/triage.ts declares no census — it imports one", () => {
    // The walk and its two record layouts are spelled in ONE file.
    expect(commandSource).not.toContain("export async function incidentCensus");
    expect(commandSource).not.toContain("export const DEFAULT_CENSUS_DEPS");
    expect(commandSource).not.toContain("export interface CensusDeps");
    expect(commandSource).not.toContain("export interface CensusRefusal");
    expect(commandSource).not.toContain("export interface IncidentCensus");
    // …and the command reaches it the way every other consumer does.
    expect(commandSource).toContain('from "../../run/triage-incident.ts"');
    expect(commandSource).toContain("incidentCensus");
  });

  test("the census and the two functions it reads with are one module", () => {
    const home = stripComments(
      readFileSync(join(import.meta.dir, "../../src/run/triage-incident.ts"), "utf8"),
    );
    for (const declaration of [
      "export async function incidentCensus",
      "export function incidentRecordPath",
      "export function parseIncidentRecord",
    ]) {
      expect(home).toContain(declaration);
    }
  });
});

/**
 * An env that resolves nowhere real, for the tests that reach no disk.
 *
 * `incidentRecordRoot` takes `dirname` of the runs root, so this puts the record
 * root at `/nonexistent-pifleet-fixture/triage` — a path the census only ever
 * hands to an injected `CensusDeps`, never to `readdir`. **`HOME` is set as well
 * as `PIFLEET_RUNS_DIR`**, because `runsRoot` falls back to `$HOME/.pifleet/runs`
 * and a fixture that set only one of the two would resolve to the operator's own.
 */
const CENSUS_ENV: Record<string, string | undefined> = {
  PIFLEET_RUNS_DIR: "/nonexistent-pifleet-fixture/runs",
  HOME: "/nonexistent-pifleet-fixture",
};

/** Bytes keyed by absolute path, listed the way `readdir` would list them. */
function censusOver(files: ReadonlyMap<string, string>): CensusDeps {
  return {
    list: async (dir) => {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const cut = rest.indexOf("/");
        names.add(cut === -1 ? rest : rest.slice(0, cut));
      }
      return names.size === 0 ? null : [...names];
    },
    read: async (path) => files.get(path) ?? null,
  };
}

/** A valid §7.6 record, produced by the PRODUCTION writer so it must parse back. */
async function recordBytes(
  subject: IncidentSubject,
  patch: Partial<IncidentRecord> = {},
  env: Record<string, string | undefined> = CENSUS_ENV,
): Promise<string> {
  let written = "";
  await saveIncidentRecord({
    record: { ...freshIncidentRecord(subject), ...patch },
    env,
    deps: {
      writeText: async (_path, text) => {
        written = text;
      },
    },
  });
  return written;
}

async function fixtureFiles(
  entries: readonly (readonly [IncidentSubject, Partial<IncidentRecord>])[],
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const [subject, patch] of entries) {
    files.set(incidentRecordPath(subject, CENSUS_ENV), await recordBytes(subject, patch));
  }
  return files;
}

describe("the incident census (§12's 'incidents by state')", () => {
  test("an absent record root is an empty table, not an error", async () => {
    const census = await incidentCensus(CENSUS_ENV, censusOver(new Map()));
    expect(census.records).toBe(0);
    expect(census.refused).toEqual([]);
    // Every state named, so a caller doing `?? 0` cannot confuse "zero" with
    // "the key was never emitted".
    expect(Object.keys(census.by_state).sort()).toEqual([...INCIDENT_STATES].sort());
  });

  test("counts both record layouts by state and sums undelivered separately", async () => {
    const files = await fixtureFiles([
      [{ kind: "service", environment: "cni-dev", service: "alpha" }, { state: "firing" }],
      [
        { kind: "service", environment: "cni-dev", service: "beta" },
        { state: "firing", undelivered: ["lost one", "lost two"] },
      ],
      [{ kind: "service", environment: "cni-dev", service: "gamma" }, { state: "clear" }],
      [
        { kind: "console_health", scope: CONSOLE_SCOPE, health: "sweeps_skipped" },
        { state: "flapping", undelivered: ["lost three"] },
      ],
    ]);
    const census = await incidentCensus(CENSUS_ENV, censusOver(files));
    expect(census.by_state).toEqual({ clear: 1, provisional: 0, firing: 2, flapping: 1 });
    expect(census.records).toBe(4);
    // The undelivered count is its OWN number and is not any state's count.
    expect(census.undelivered).toBe(3);
    expect(census.refused).toEqual([]);
  });

  /**
   * **An unreadable record is not a clear one**, and the direction matters: a
   * truncated write folded into `clear` presents as good news, which is the
   * absence-as-evidence failure the whole console is against.
   */
  test("a record the schema refuses is counted in NO state", async () => {
    const subject: IncidentSubject = {
      kind: "service",
      environment: "cni-dev",
      service: "alpha",
    };
    const files = new Map<string, string>([
      [incidentRecordPath(subject, CENSUS_ENV), '{"subject":{"kind":"service"'],
    ]);
    const census = await incidentCensus(CENSUS_ENV, censusOver(files));
    expect(census.records).toBe(0);
    expect(census.by_state).toEqual({ clear: 0, provisional: 0, firing: 0, flapping: 0 });
    expect(census.refused).toHaveLength(1);
    expect(census.refused[0]!.reason).toContain("is not JSON");
  });

  test("a file that is no record layout at all is refused, never descended into", async () => {
    const root = "/nonexistent-pifleet-fixture/triage";
    const files = new Map<string, string>([[join(root, "cni-dev", "notes.txt"), "hello"]]);
    const census = await incidentCensus(CENSUS_ENV, censusOver(files));
    expect(census.records).toBe(0);
    expect(census.refused).toHaveLength(1);
    expect(census.refused[0]!.path).toContain("notes.txt");
    /*
     * **Refused for its LAYOUT, before the bytes were read** — and the reason is
     * asserted because the count is not enough. Found by mutation
     * `census-descends-a-stray-tree-instead-of-refusing`, which deleted the
     * layout gate and SURVIVED: the file was then read and refused by
     * `parseIncidentRecord` instead, one refusal either way. The two are not the
     * same thing. `parseIncidentRecord` takes the expected subject as a REQUIRED
     * parameter — *"the caller that forgets the argument is the caller that acts
     * on another service's state"* — so a census that reads first hands it a
     * subject it has no expectation for, and a WELL-FORMED record under a stray
     * path would then be graded against nothing.
     */
    expect(census.refused[0]!.reason).toContain("no subject could be expected of");
  });

  /**
   * The console-health names come from the EXPORTED tuple, so a member added
   * after this line was written is read rather than rejected. The set grew from
   * six to seven on 2026-09-06 (`inference_unreachable`, task 5.4d) and §6.8a's
   * table is the kind of thing that grows again; a hand-written copy here would
   * start reporting a live incident kind as an unrecognised file.
   */
  test("every CONSOLE_HEALTH_KINDS member is a countable record, whatever the set holds", async () => {
    const files = await fixtureFiles(
      CONSOLE_HEALTH_KINDS.map(
        (health) =>
          [{ kind: "console_health", scope: CONSOLE_SCOPE, health }, { state: "firing" }] as const,
      ),
    );
    const census = await incidentCensus(CENSUS_ENV, censusOver(files));
    expect(census.records).toBe(CONSOLE_HEALTH_KINDS.length);
    expect(census.by_state.firing).toBe(CONSOLE_HEALTH_KINDS.length);
    expect(census.refused).toEqual([]);
  });

  test("a health name outside the enum is refused rather than counted", async () => {
    const root = "/nonexistent-pifleet-fixture/triage";
    const files = new Map<string, string>([
      [join(root, CONSOLE_SCOPE, CONSOLE_SCOPE, "not_a_kind.json"), "{}"],
    ]);
    const census = await incidentCensus(CENSUS_ENV, censusOver(files));
    expect(census.records).toBe(0);
    expect(census.refused).toHaveLength(1);
    // ISC-804's other side, and the reason matters here for the same argument as
    // the layout case above: the NAME is what failed, before any byte was read.
    expect(census.refused[0]!.reason).toContain("no subject could be expected of");
  });

  /**
   * The ONE census test that touches a disk, and it carries its OWN temporary
   * root rather than inheriting one.
   *
   * **This is the isolation task 6.2a had to re-establish rather than move.** In
   * `triage-command.test.ts` this case read `process.env` and was safe only
   * because a `beforeEach` in that file redirected `HOME` and `PIFLEET_RUNS_DIR`
   * for every test in it. This file has no such hook — and the first run after
   * the move wrote a record into the operator's real `~/.pifleet/triage/cni-dev`,
   * which is ISC-614's hazard exactly: `incidentRecordRoot` is
   * `dirname(runsRoot(env))/triage` and `runsRoot` falls back to
   * `$HOME/.pifleet/runs`, so **isolating the checkout isolates nothing**. Both
   * variables are set here, from one `mkdtemp`, and the tree is removed in a
   * `finally`.
   */
  test("the default deps read a real directory and leave ~/.pifleet alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-census-"));
    try {
      const env = { HOME: root, PIFLEET_RUNS_DIR: join(root, ".pifleet", "runs") };
      const subject: IncidentSubject = {
        kind: "service",
        environment: "cni-dev",
        service: "alpha",
      };
      const path = incidentRecordPath(subject, env);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await recordBytes(subject, { state: "provisional" }, env));
      const census = await incidentCensus(env, DEFAULT_CENSUS_DEPS);
      expect(census.by_state.provisional).toBe(1);
      // Under the temp root this test made, so it cannot have been the
      // operator's own tree — asserted by VALUE, not by the absence of a crash.
      expect(path.startsWith(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});



describe("the two record kinds are one machine — §6.8a, and 5.5's half of it", () => {
  /**
   * §6.8a's table, by name. §12: *"assert the enum's members by name against
   * §6.8a's table, not by count — naming the permitted set is what makes a
   * seventh member fail"*.
   */
  test("CONSOLE_HEALTH_KINDS is exactly §6.8a's seven", () => {
    expect([...CONSOLE_HEALTH_KINDS]).toEqual([
      "observer_blocked",
      "sweep_produced_nothing",
      "sweeps_skipped",
      "inference_saturated",
      "inference_unreachable",
      "budget_exhausted",
      "reporter_undelivered",
    ]);
  });

  test("the state and reason vocabularies are closed and derived from each other", () => {
    expect([...INCIDENT_STATES]).toEqual(["clear", "provisional", "firing", "flapping"]);
    // The six kinds are reasons as well as identities, and `coverage` is minted
    // by the machine and by nothing else.
    expect([...ISSUE_REASONS]).toEqual([...OBSERVED_ISSUE_REASONS, "coverage"]);
    for (const kind of CONSOLE_HEALTH_KINDS) {
      expect(OBSERVED_ISSUE_REASONS).toContain(kind);
    }
    expect(OBSERVED_ISSUE_REASONS).not.toContain("coverage");
  });

  /**
   * §7.5's reader and §7.6's reader spend ONE fault alphabet, so an actor can log
   * and count a refusal without knowing which file produced it —
   * `dispatch-request.ts`'s rule for refusal vocabularies. The two
   * implementations are deliberately not shared (importing §7.5's reader here
   * would pull the targets and verdict modules into this module's transitive
   * closure, which §12's read-only criterion walks), so this assertion is what
   * keeps them in step instead of a comment.
   */
  test("the fault vocabulary is the one triage-document.ts spends", () => {
    expect([...INCIDENT_RECORD_FAULTS]).toEqual([...TRIAGE_DOCUMENT_FAULTS]);
  });

  /**
   * 5.4a's premise, extended to the identity 5.5 had to add: the machine's output
   * does not vary with the subject KIND either, so §6.8a really is a data
   * addition and not a second machine.
   */
  test("a console-health subject drives the same machine to the same states", () => {
    const timeline = (n: number): IncidentSignal =>
      n % 3 === 2 ? clear() : n % 5 === 0 ? unobserved : issue("unhealthy");

    let service = freshIncidentRecord(SERVICE);
    let health = freshIncidentRecord(SKIPS);
    for (let n = 0; n < 40; n += 1) {
      const a = sweep(service, n, timeline(n), DEFAULTS, SERVICE);
      const b = sweep(health, n, timeline(n), DEFAULTS, SKIPS);
      expect(kinds(b.notifications)).toEqual(kinds(a.notifications));
      for (const note of b.notifications) expect(note.subject).toEqual(SKIPS);
      const rebased: IncidentRecord = { ...b.record, subject: SERVICE };
      expect(rebased).toEqual(a.record);
      service = a.record;
      health = b.record;
    }
    expect(service.state).toBe(health.state);
    // PREMISE: the timeline moved. Two records that both sat in `clear` would
    // agree for reasons that have nothing to do with the machine.
    expect(service.state).not.toBe("clear");
  });

  /** And a console-health reason is carried through untouched, like any other. */
  test.each([...CONSOLE_HEALTH_KINDS])("the reason %s survives a confirmation", (reason) => {
    let record = freshIncidentRecord(BLOCKED);
    record = sweep(record, 0, issue(reason), DEFAULTS, BLOCKED).record;
    const confirmed = sweep(record, 1, issue(reason), DEFAULTS, BLOCKED);
    expect(confirmed.notifications).toHaveLength(1);
    expect(confirmed.notifications[0]!.reason).toBe(reason);
    expect(confirmed.record.reason).toBe(reason);
  });

  /** `subjectKey` separates the two kinds, which is what keys the two layouts. */
  test("subjectKey never collides across the two kinds", () => {
    const keys = [SERVICE, SKIPS, BLOCKED].map(subjectKey);
    expect(new Set(keys).size).toBe(3);
    expect(subjectKey(SKIPS)).toContain("console_health");
    expect(subjectKey(SERVICE)).toContain("service");
  });
});


// ── §12's Console-health block (D13), task 5.4a ─────────────────────────────

describe("console-health deduplication — §6.8a's identity on §6.8's machine", () => {
  const ENV = "cni-dev";
  /*
   * The FULL config, because `IncidentPolicy` is a `Pick` and
   * `max_consecutive_skips` is §6.4's knob rather than §6.8's. Read from the
   * shipped defaults rather than spelled, so the fixture moves when the knob does.
   */
  const CONFIG = defaultTriageConsoleConfig();
  const BLOCKED: IncidentSubject = {
    kind: "console_health",
    scope: ENV,
    health: "observer_blocked",
  };
  const SKIPS: IncidentSubject = {
    kind: "console_health",
    scope: CONSOLE_SCOPE,
    health: "sweeps_skipped",
  };

  /** `drive`, for a subject that is not the service fixture. */
  function driveSubject(
    subject: IncidentSubject,
    sweeps: number,
    signalFor: (n: number) => IncidentSignal | null,
    policy: IncidentPolicy = DEFAULTS,
  ): { record: IncidentRecord; notifications: IncidentNotification[] } {
    let record = freshIncidentRecord(subject);
    const notifications: IncidentNotification[] = [];
    for (let n = 0; n < sweeps; n += 1) {
      const signal = signalFor(n);
      // `null` is "this sweep said nothing about this subject" — not `unobserved`.
      if (signal === null) continue;
      const step = advanceIncident(
        record,
        { subject, sweepId: `s-${n}`, at: T0 + n * CADENCE_MS, signal },
        policy,
      );
      record = step.record;
      notifications.push(...step.notifications);
    }
    return { record, notifications };
  }

  /** The facts a sweep hands `consoleHealthObservations`, with one knob moved. */
  const ranWith = (over: Partial<Extract<ConsoleHealthFacts, { ran: true }>>) =>
    consoleHealthObservations({
      ran: true,
      sweepId: "s-1",
      at: T0,
      evidenceRef: "sweep/1",
      environments: [{ environment: ENV, observerBlocked: false, collated: true }],
      consecutiveSkips: 0,
      maxConsecutiveSkips: CONFIG.max_consecutive_skips,
      saturated: false,
      budgetExhausted: false,
      reporterUndelivered: false,
      ...over,
    });

  const forSubject = (
    obs: readonly IncidentObservation[],
    health: string,
    scope: string,
  ): IncidentObservation | undefined =>
    obs.find(
      (o) => o.subject.kind === "console_health" && o.subject.health === health && o.subject.scope === scope,
    );

  /**
   * §12: *"an observer reporting `blocked` on 288 consecutive sweeps produces one
   * notification"*. This is the 288-a-day hole §6.8a was written to close, and
   * §12 says asserting it on the service path alone would leave it open.
   *
   * Instants BY VALUE, on §6.8a's own correction: a bare count inherits the
   * inclusivity ambiguity that made the re-notify number wrong once already.
   */
  test("288 sweeps of `blocked` produce one open and its reminders, at their instants", () => {
    const { record, notifications } = driveSubject(BLOCKED, 288, () =>
      issue("observer_blocked", "obs-t1/1"),
    );

    expect(kinds(notifications)).toEqual(["opened", "reminder", "reminder", "reminder"]);
    expect(notifications[0]!.reason).toBe("observer_blocked");
    expect(record.state).toBe("firing");

    /*
     * The open lands on the CONFIRMATION sweep — §6.7 rule 1, inherited
     * unchanged — and each reminder is exactly one `renotify_after` past the
     * message before it. Both are asserted from the instants rather than
     * restated as literals.
     */
    const opened = T0 + 1 * CADENCE_MS;
    const step = DEFAULTS.renotify_after_s * 1_000;
    expect(notifications.map((n) => n.at)).toEqual([
      opened,
      opened + step,
      opened + 2 * step,
      opened + 3 * step,
    ]);
  });

  /**
   * ANTI, and without it the test above is satisfied by a machine that opens once
   * and never reminds — or by one that never notifies at all.
   */
  test("ANTI: 288 sweeps of a NON-blocked observer notify nothing", () => {
    const { record, notifications } = driveSubject(BLOCKED, 288, () => clear("obs-t1/ok"));
    expect(notifications).toEqual([]);
    expect(record.state).toBe("clear");
  });

  /**
   * §12: *"skips 4, 5 and 6 send nothing. Probe: six consecutive fixture passes
   * each finding a sweep in flight; assert exactly one notification, at the
   * third."*
   *
   * Driven through `consoleHealthObservations` rather than through hand-built
   * signals, because the off-by-one that makes both of §12's sentences true lives
   * in that mapping and a hand-built fixture would test around it.
   */
  test("six skipped passes notify exactly once, on the third", () => {
    let record = freshIncidentRecord(SKIPS);
    const at: number[] = [];
    const seen: string[] = [];
    for (let pass = 1; pass <= 6; pass += 1) {
      const obs = forSubject(
        ranWith({ consecutiveSkips: pass, sweepId: `s-${pass}`, at: T0 + pass * CADENCE_MS }),
        "sweeps_skipped",
        CONSOLE_SCOPE,
      );
      if (obs === undefined) continue;
      const step = advanceIncident(record, obs, DEFAULTS);
      record = step.record;
      for (const n of step.notifications) {
        seen.push(n.kind);
        at.push(n.at);
      }
    }
    expect(seen).toEqual(["opened"]);
    expect(at).toEqual([T0 + 3 * CADENCE_MS]);
    expect(CONFIG.max_consecutive_skips).toBe(3);
  });

  /**
   * §12: a console-health `kind` clears *"only on a positively observed good
   * state"* — *"an actor that stopped counting is not an actor that recovered"*.
   *
   * The `ran: false` arm can only produce `unobserved`, which carries no
   * `evidenceRef` and therefore cannot reach the recovery path. Asserted on the
   * SIGNAL as well as on the outcome, so the property is visible where it is
   * enforced.
   */
  test("a sweep that did not run at all composes no recovery", () => {
    const firing = driveSubject(BLOCKED, 2, () => issue("observer_blocked", "obs-t1/1"));
    expect(firing.record.state).toBe("firing");

    const silent = consoleHealthObservations({
      ran: false,
      sweepId: "s-99",
      at: T0 + 99 * CADENCE_MS,
      environments: [ENV],
    });
    for (const o of silent) expect(o.signal.kind).toBe("unobserved");

    const obs = forSubject(silent, "observer_blocked", ENV)!;
    const after = advanceIncident(firing.record, obs, NO_RENOTIFY);
    expect(after.notifications).toEqual([]);
    expect(after.record.state).toBe("firing");
  });

  /**
   * The mirror, so the silence above is the RULE and not a machine that never
   * recovers anything: an observed non-blocked sweep does clear it, once.
   */
  test("an observed non-blocked sweep DOES recover it, exactly once", () => {
    const firing = driveSubject(BLOCKED, 2, () => issue("observer_blocked", "obs-t1/1"));
    const obs = forSubject(ranWith({ at: T0 + 5 * CADENCE_MS, sweepId: "s-5" }), "observer_blocked", ENV)!;
    expect(obs.signal.kind).toBe("observed_clear");
    const after = advanceIncident(firing.record, obs, NO_RENOTIFY);
    expect(kinds(after.notifications)).toEqual(["recovered"]);
    expect(after.record.state).toBe("clear");
  });

  /**
   * §6.7 rule 3's distinction, on the one field where `null` and `false` are
   * different facts: a sweep that could not tell whether the provider was
   * saturated must not compose a recovery for it.
   */
  test("`saturated: null` says NOTHING; `false` says it is fine", () => {
    expect(forSubject(ranWith({ saturated: null }), "inference_saturated", CONSOLE_SCOPE)).toBeUndefined();
    const said = forSubject(ranWith({ saturated: false }), "inference_saturated", CONSOLE_SCOPE);
    expect(said?.signal.kind).toBe("observed_clear");
    const bad = forSubject(ranWith({ saturated: true }), "inference_saturated", CONSOLE_SCOPE);
    expect(bad?.signal.kind).toBe("issue");
  });

  /*
   * ── TASK 5.4d — §6.7 rule 3's TWO halves, and they do not collapse ─────────
   *
   * ISC-731 keeps `timeout` and `unreachable` apart inside `saturationVerdict`.
   * Until this task the separation died one layer later: §6.8a's `kind` enum was
   * closed at six with no member for an outage, so an `endpoint_down` sweep
   * composed NOTHING and the distinction the probe had just made reliably was
   * thrown away at the composer. The seventh member is what carries it, and the
   * ANTI-TWIN below is the assertion that matters — a `timeout` must still
   * compose `inference_saturated` and must still say nothing about the new kind,
   * because a growth that merged the two would pass every positive fixture here
   * while announcing an outage for a server that is merely slow.
   */

  /**
   * The signal kind each half composes for one verdict, or `undefined` for
   * silence — driven off the PRODUCTION table.
   *
   * **This block held its own copy of that table until §13 task 6.4b** — a
   * `Record<SaturationVerdict, …>` const named `VERDICT_PAIR`, spelling the same
   * five rows `unreachableFrom` spelled in `triage-pass.ts`, with nothing pinning
   * the two equal. ISC-869 filed it as ISC-804's shape one file over, and this
   * paragraph is why the probe that forbids a second spelling reads
   * comment-stripped source: a raw scan for that name reddens here, on the
   * sentence that explains the removal. The fixture now
   * reads `SATURATION_PAIR`, which is what makes these tests grade the composer
   * against the pairs production actually produces rather than against a second
   * opinion that happened to agree — and what makes a wrong cell in that table
   * redden HERE as well as in the pass's own suite.
   */
  const composedFor = (verdict: SaturationVerdict) => {
    const obs = ranWith(SATURATION_PAIR[verdict]);
    return {
      saturated: forSubject(obs, "inference_saturated", CONSOLE_SCOPE)?.signal.kind,
      unreachable: forSubject(obs, "inference_unreachable", CONSOLE_SCOPE)?.signal.kind,
    };
  };

  /**
   * PREMISE, on the degenerate-fixture lesson: the table has to be able to TELL
   * the two halves apart. A table in which every verdict gave both fields the
   * same value would pass every assertion below against a composer that read one
   * field for both kinds.
   *
   * It grades the SHIPPED table now, so it is no longer a statement about a
   * fixture this file controls — it is a standing guard on `triage-verdict.ts`.
   */
  test("premise: the pair disagrees on the two verdicts the whole task is about", () => {
    expect(SATURATION_PAIR.saturated).not.toEqual(SATURATION_PAIR.endpoint_down);
    expect(SATURATION_PAIR.saturated.saturated).not.toBe(SATURATION_PAIR.endpoint_down.saturated);
    expect(SATURATION_PAIR.saturated.unreachable).not.toBe(
      SATURATION_PAIR.endpoint_down.unreachable,
    );
    // And the table covers the real vocabulary, entire — not a subset of it.
    expect(Object.keys(SATURATION_PAIR).sort()).toEqual([...SATURATION_VERDICTS].sort());
  });

  /** The task's first acceptance clause: an `endpoint_down` sweep composes. */
  test("an `endpoint_down` sweep composes an issue on the seventh kind", () => {
    const said = forSubject(
      ranWith(SATURATION_PAIR.endpoint_down),
      "inference_unreachable",
      CONSOLE_SCOPE,
    );
    expect(said?.signal.kind).toBe("issue");
    expect(said?.signal).toEqual({
      kind: "issue",
      reason: "inference_unreachable",
      evidenceRef: "sweep/1",
    });
    expect(said?.subject).toEqual({
      kind: "console_health",
      scope: CONSOLE_SCOPE,
      health: "inference_unreachable",
    });
  });

  /**
   * **THE ANTI-TWIN, and it is the reason this task is a growth rather than a
   * rename.** A `timeout` sweep still says the provider is saturated and still
   * says NOTHING about reachability. A composer that fed one field to both kinds
   * — or that treated "not clear" as "down" — passes the test above and fails
   * here, which is the only way to tell the two implementations apart.
   */
  test("ANTI-TWIN: a `timeout` sweep composes `inference_saturated` and NOT the new kind", () => {
    expect(composedFor("saturated")).toEqual({ saturated: "issue", unreachable: undefined });
    // And the mirror, so the silence above is a RULE and not a composer that
    // never speaks about the new kind at all.
    expect(composedFor("endpoint_down")).toEqual({ saturated: undefined, unreachable: "issue" });
  });

  /**
   * All five verdicts by full value, so a verdict whose row nobody thought about
   * cannot pass by being absent from a narrower assertion.
   *
   * **Only `clear` clears either half.** §6.8a reserves recovery for *"a sweep in
   * which every observer produced an artifact"*, and a probe result is not that
   * fact — clearing an outage on the strength of a request that never came back
   * is ISC-675's absence-as-evidence mistake wearing a different fault.
   */
  test("every saturation verdict composes its own pair, and only `clear` clears", () => {
    const composed = Object.fromEntries(SATURATION_VERDICTS.map((v) => [v, composedFor(v)]));
    expect(composed).toEqual({
      clear: { saturated: "observed_clear", unreachable: "observed_clear" },
      uncorrelated: { saturated: undefined, unreachable: undefined },
      saturated: { saturated: "issue", unreachable: undefined },
      endpoint_down: { saturated: undefined, unreachable: "issue" },
      unconfirmed: { saturated: undefined, unreachable: undefined },
    });
  });

  /**
   * The optional field's whole contract, stated rather than left to `??`. A
   * caller that has not been taught about reachability yet is a caller that could
   * not tell, and could not tell composes nothing — never a false clear.
   *
   * `false` is asserted beside it so the silence is attributable to ABSENCE and
   * not to the composer ignoring the field.
   */
  test("an absent `unreachable` is `null`, not `false`", () => {
    expect(forSubject(ranWith({}), "inference_unreachable", CONSOLE_SCOPE)).toBeUndefined();
    expect(
      forSubject(ranWith({ unreachable: null }), "inference_unreachable", CONSOLE_SCOPE),
    ).toBeUndefined();
    expect(
      forSubject(ranWith({ unreachable: false }), "inference_unreachable", CONSOLE_SCOPE)?.signal.kind,
    ).toBe("observed_clear");
  });

  /**
   * The seventh kind inherits §6.8's machine untouched, like the other six: two
   * consecutive `endpoint_down` sweeps are one notification, not two.
   */
  test("the seventh kind dedups on the same machine", () => {
    const DOWN: IncidentSubject = {
      kind: "console_health",
      scope: CONSOLE_SCOPE,
      health: "inference_unreachable",
    };
    const { record, notifications } = driveSubject(
      DOWN,
      12,
      () => issue("inference_unreachable", "sweep/1"),
      NO_RENOTIFY,
    );
    expect(kinds(notifications)).toEqual(["opened"]);
    expect(notifications[0]!.reason).toBe("inference_unreachable");
    expect(record.state).toBe("firing");
  });

  /**
   * A skipped pass BELOW the raise line says nothing at all — not `unobserved`,
   * which would advance `consecutive_indeterminate` toward the coverage
   * escalation and announce that the console cannot SEE a service when the fact
   * is that it chose not to look yet; and not `observed_clear`, because a skipped
   * pass is not §6.8a's *"a sweep that ran"*.
   */
  test("a skip below the raise line is neither a clear nor an unobserved", () => {
    expect(forSubject(ranWith({ consecutiveSkips: 1 }), "sweeps_skipped", CONSOLE_SCOPE)).toBeUndefined();
    expect(forSubject(ranWith({ consecutiveSkips: 0 }), "sweeps_skipped", CONSOLE_SCOPE)?.signal.kind).toBe(
      "observed_clear",
    );
    expect(forSubject(ranWith({ consecutiveSkips: 2 }), "sweeps_skipped", CONSOLE_SCOPE)?.signal.kind).toBe(
      "issue",
    );
  });

  /**
   * The environment-scoped kinds are keyed BY ENVIRONMENT, so two environments
   * dedup independently. Asserted on an asymmetric fixture — one blocked, one
   * not — because a mapping that keyed both to `CONSOLE_SCOPE` passes every
   * single-environment fixture above.
   */
  test("two environments carry two records, asserted by scope", () => {
    const obs = ranWith({
      environments: [
        { environment: "cni-dev", observerBlocked: true, collated: true },
        { environment: "saas-dev", observerBlocked: false, collated: false },
      ],
    });
    expect(forSubject(obs, "observer_blocked", "cni-dev")?.signal.kind).toBe("issue");
    expect(forSubject(obs, "observer_blocked", "saas-dev")?.signal.kind).toBe("observed_clear");
    expect(forSubject(obs, "sweep_produced_nothing", "cni-dev")?.signal.kind).toBe("observed_clear");
    expect(forSubject(obs, "sweep_produced_nothing", "saas-dev")?.signal.kind).toBe("issue");
  });
});

// ── §13 task 5.6b — the seam the notifier lands on ───────────────────────────

/**
 * The translation, and the ONE field on a record a delivery may write.
 *
 * §13 task 5.6b names four things that cross between this module and the
 * notifier, and two of them are here: `AnnouncementFacts` is the translation
 * target, and `IncidentRecord.undelivered[]` is the field §7.6 declares and this
 * module's own docblock says *"5.6b fills"*.
 *
 * **The direction of the dependency is the design.** This module takes a
 * TYPE-ONLY import from the notifier and the notifier takes nothing from here, so
 * ISC-689's structural claim — no edit in the notifier can reach the state
 * machine — survives task 5.6b unchanged rather than being narrowed to fit it.
 * The last test in this block is the other half of that: this module may see the
 * announcement VOCABULARY and may never see a delivery RESULT.
 */
describe("§13 task 5.6b — a notification becomes announcement facts", () => {
  const AT = T0 + 9 * CADENCE_MS;
  const FIRING_FOR = 4 * CADENCE_MS;

  const REPORTER: IncidentSubject = {
    kind: "console_health",
    scope: CONSOLE_SCOPE,
    health: "reporter_undelivered",
  };
  const ENV_SCOPED: IncidentSubject = {
    kind: "console_health",
    scope: "cni-prod",
    health: "observer_blocked",
  };

  function notification(over: Partial<IncidentNotification> = {}): IncidentNotification {
    return {
      kind: "opened",
      subject: SERVICE,
      reason: "unhealthy",
      at: AT,
      sweepId: "s-9",
      firingForMs: FIRING_FOR,
      sweepCount: 7,
      evidenceRef: "art/authz-7",
      ...over,
    };
  }

  /**
   * The premise the whole translation rests on, and it is asserted rather than
   * assumed: `IssueReason` and `AnnouncementAssessment` are two independently
   * spelled tuples in two modules, and the translation assigns one to the other.
   * The day a seventh console-health kind is added to one and not the other, this
   * goes red HERE rather than producing an announcement whose assessment is a
   * string no adapter has a tag for.
   */
  test("premise: the two vocabularies this translation joins have the same members", () => {
    expect([...ISSUE_REASONS].sort()).toEqual([...ANNOUNCEMENT_ASSESSMENTS].sort());
    expect([...CONSOLE_HEALTH_KINDS]).toEqual([...CONSOLE_HEALTH_ASSESSMENTS]);
    expect([...ANNOUNCEMENT_TRANSITIONS].sort().join(",")).toBe("flapping,opened,recovered,reminder");
  });

  test("a service notification names the SERVICE, and its scope is its environment", () => {
    expect(announcementFacts(notification())).toEqual({
      kind: "service",
      scope: "cni-prod",
      subject: "authorization",
      environment: "cni-prod",
      service: "authorization",
      assessment: "unhealthy",
      transition: "opened",
      first_seen: AT - FIRING_FOR,
      sweep_count: 7,
      evidence: null,
      evidence_ref: "art/authz-7",
      backlog: null,
    });
  });

  /**
   * §13 task 5.6b(c) spells this mapping out: *"`first_seen` from `at −
   * firingForMs`"*. Asserted by VALUE against a fixture whose two operands are
   * different non-zero numbers, because `at`, `at - 0` and `0` are all plausible
   * wrong answers that a `toBeNumber()` cannot separate.
   */
  test("first_seen is `at − firingForMs`, by value", () => {
    expect(FIRING_FOR).toBeGreaterThan(0);
    expect(announcementFacts(notification()).first_seen).toBe(AT - FIRING_FOR);
    expect(announcementFacts(notification({ firingForMs: 0 })).first_seen).toBe(AT);
  });

  /**
   * §6.9 requirement 1: *"`scope` is not `environment` either"*. A `_console`
   * incident is about the console, so it has no environment — and rendering the
   * scope token there would put the string `_console` in a field an operator
   * reads as a cluster name.
   */
  test("a `_console`-scoped console-health notification has NO environment", () => {
    const facts = announcementFacts(notification({ subject: REPORTER, reason: "reporter_undelivered" }));
    expect(facts.kind).toBe("console_health");
    expect(facts.scope).toBe(CONSOLE_SCOPE);
    expect(facts.subject).toBe("reporter_undelivered");
    expect(facts.environment).toBeNull();
    expect(facts.service).toBeNull();
    expect(facts.assessment).toBe("reporter_undelivered");
  });

  test("an ENVIRONMENT-scoped console-health notification keeps its environment", () => {
    const facts = announcementFacts(notification({ subject: ENV_SCOPED, reason: "observer_blocked" }));
    expect(facts.scope).toBe("cni-prod");
    expect(facts.environment).toBe("cni-prod");
    expect(facts.subject).toBe("observer_blocked");
    expect(facts.service).toBeNull();
  });

  /**
   * Every member of both closed sets, driven through the translation. A mapping
   * that special-cased one reason — or that dropped `coverage`, the one this
   * module MINTS rather than receives — passes any single-fixture test above.
   */
  test("every transition and every reason round-trip, with none dropped", () => {
    for (const kind of ANNOUNCEMENT_TRANSITIONS) {
      expect(announcementFacts(notification({ kind })).transition).toBe(kind);
    }
    for (const reason of ISSUE_REASONS) {
      expect(announcementFacts(notification({ reason })).assessment).toBe(reason);
    }
  });

  /**
   * Anti: the translation invents nothing. `evidence` is untrusted worker prose
   * and `backlog` is the notifier's own count — neither is on an
   * `IncidentNotification`, and a translation that fabricated either would put a
   * value in the message that no observation produced.
   */
  test("Anti: evidence and backlog are null unless the caller supplies them", () => {
    const bare = announcementFacts(notification());
    expect(bare.evidence).toBeNull();
    expect(bare.backlog).toBeNull();
    const withProse = announcementFacts(notification(), { evidence: "line one\nline two" });
    expect(withProse.evidence).toBe("line one\nline two");
    expect(withProse.evidence_ref).toBe("art/authz-7");
  });

  /**
   * §6.9 requirement 7, as a shape rather than as a discipline: the only writer of
   * `undelivered[]` is a function that cannot touch anything else, because it
   * spreads the record and replaces exactly one key.
   */
  test("`undelivered[]` is filled by a writer that touches NOTHING else", () => {
    const firing = drive(4, () => issue("unhealthy")).record;
    expect(firing.state).toBe("firing");
    const after = withUndelivered(firing, ["triage: a", "triage: b"]);
    expect(after.undelivered).toEqual(["triage: a", "triage: b"]);
    expect(after.state).toBe("firing");
    expect({ ...after, undelivered: [] }).toEqual({ ...firing, undelivered: [] });
  });

  test("recording nothing returns the SAME object, so a quiet sweep cannot rewrite a record", () => {
    const firing = drive(4, () => issue("unhealthy")).record;
    expect(withUndelivered(firing, [])).toBe(firing);
  });

  /**
   * The bound is `MAX_UNDELIVERED` and it keeps the MOST RECENT, because an
   * operator reading a truncated backlog wants the losses nearest the outage they
   * are looking at. The premise — that the fixture actually overflows — is
   * asserted, so a cap that never engaged could not pass this.
   */
  test("the list is bounded and keeps the most recent", () => {
    const seed = Array.from({ length: MAX_UNDELIVERED }, (_, i) => `old-${i}`);
    const base = { ...freshIncidentRecord(SERVICE), undelivered: seed };
    expect(base.undelivered.length).toBe(MAX_UNDELIVERED);
    const after = withUndelivered(base, ["newest-1", "newest-2"]);
    expect(after.undelivered.length).toBe(MAX_UNDELIVERED);
    expect(after.undelivered.at(-1)).toBe("newest-2");
    expect(after.undelivered.at(-2)).toBe("newest-1");
    expect(after.undelivered).not.toContain("old-0");
    expect(after.undelivered[0]).toBe("old-2");
  });

  /**
   * Anti: this module may see the announcement VOCABULARY and may never see a
   * delivery RESULT.
   *
   * ISC-689 states the notifier's half — *"no edit in the notifier can reach the
   * state machine"* — and stays true because the notifier still imports nothing
   * from here. This is the half task 5.6b adds: the coupling that now exists runs
   * the other way, it is TYPE-ONLY, and it carries data shapes rather than
   * outcomes. A module that could name an outcome type could branch on one, and
   * §6.9 requirement 7's whole content is that it must not.
   */
  test("Anti: this module can see the announcement vocabulary and never a delivery RESULT", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "run", "triage-incident.ts"),
      "utf8",
    );
    for (const forbidden of [
      "NotifyOutcome",
      "DeliveryState",
      "deliverAnnouncement",
      "deliverySweep",
      "reportSweep",
      "NotifyTransport",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // Exactly one reference to the notifier, and it is erased at runtime.
    const refs = source.split('from "./triage-notify.ts"').length - 1;
    expect(refs).toBe(1);
    expect(source).toContain(
      'import type { AnnouncementFacts, NotifyBacklog } from "./triage-notify.ts";',
    );
  });
});
