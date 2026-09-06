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

import {
  ADVANCE_READS_NO_ISSUE_REASON,
  ADVANCE_READS_NO_SUBJECT_FIELD,
  COVERAGE_THRESHOLD,
  advanceIncident,
  freshIncidentRecord,
  subjectKey,
  type IncidentAdvance,
  type IncidentNotification,
  type IncidentPolicy,
  type IncidentRecord,
  type IncidentSignal,
  type IncidentSubject,
  type ObservedIssueReason,
} from "../../src/run/triage-incident.ts";
import { defaultTriageConsoleConfig } from "../../src/run/triage-config.ts";

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

  test("a second consecutive unhealthy notifies exactly once", () => {
    const { record, notifications } = drive(2, () => issue("unhealthy"), NO_RENOTIFY);
    expect(kinds(notifications)).toEqual(["opened"]);
    expect(record.state).toBe("firing");
    expect(record.sweep_count).toBe(2);
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
      expect({ ...stepB.record, subject: SERVICE }).toEqual(stepA.record);
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
