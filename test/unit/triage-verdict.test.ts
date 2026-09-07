/**
 * The verdict mapping and the freshness echoes — SRD-TRIAGE-CONSOLE §6.6 layer
 * 3, §6.7 rules 1-2, §7.4, §7.5; §13 tasks 5.2, 5.3, 5.3b and 5.3c.
 *
 * ## The gate is graded on FOUR separable fixtures, and that is not a stylistic choice
 *
 * §6.7 rule 2 names four conditions — *"a `healthy` whose row carries an empty
 * `coverage[]`, no named selector, no window, or an empty evidence ledger is
 * downgraded host-side to `indeterminate`"*. **A single fixture violating all
 * four at once passes against a gate that checks only one of them**, and would
 * ship a console that accepts three quarters of the unevidenced `healthy`s it was
 * built to refuse. So each condition gets a fixture that violates that condition
 * ALONE, twice over: once against `evidenceGaps` directly, and once through
 * `assessTriageSweep`, because a gate computed correctly and then spent on the
 * wrong branch is a second, separate defect.
 *
 * Each fixture asserts the failing condition BY NAME — `gaps` equals
 * `["selector"]`, never `gaps.length === 1`. A count assertion is satisfied by a
 * gate that reports the wrong member, which is the failure a count cannot see.
 *
 * ## Every set-shaped assertion here is ASYMMETRIC, and the members are named
 *
 * This branch's MEMORY carries the defect four times: *"a filter or intersection
 * survives mutation whenever every fixture makes the two sets equal"*, and one
 * recorded instance survived **reversing two output arrays** because every
 * fixture named exactly one service. This file has three set comparisons and each
 * gets a fixture where neither side contains the other:
 *
 *     declared by targets.yaml : {mia, authorization}
 *     rows in triage.json      : {authorization, ingest}
 *
 *     dispatched by the actor  : {obs-t1, obs-t2}
 *     reply files in the tree  : {obs-t2, obs-t3}
 *
 * and a third fixture makes `observers_missing`, `observers_stale` and
 * `observers_unsolicited` simultaneously non-empty and mutually DIFFERENT, so
 * swapping any two of them reddens.
 *
 * ## `stale_replay` is asserted NOT COUNTED, never merely labelled
 *
 * §7.4: *"An artifact whose value is not the dispatched one is `stale_replay` and
 * **the row is not counted**"*. A `reason: "stale_replay"` on a row that still
 * contributed to `census.counted` satisfies a criterion phrased about the label
 * and ships the defect. Every stale fixture below asserts the downstream number.
 *
 * ## What is deliberately NOT asserted, stated so the silence is not read as coverage
 *
 * **No prose.** There are no `reason` strings in this module to match — the
 * assertion surfaces are closed enums and named lists, which is
 * `dispatch-request.ts:695-707`'s rule and the reason `triage-partition.test.ts`
 * can say the same thing.
 *
 * **Confirmation, escalation, notification, saturation and console-health.** §6.7
 * rule 1's two-observation confirmation, the three-consecutive-`indeterminate`
 * coverage escalation, rule 3's saturation verdict and §6.8a's `(scope, kind)`
 * identities all live in records that span sweeps. `assessTriageSweep` sees one
 * sweep and this file grades one sweep. Tasks 5.3a, 5.4 and 5.4a own the rest.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PartitionAssignment } from "../../src/run/triage-partition.ts";
import {
  ASSESSMENT_REASONS,
  assessTriageSweep,
  COVERAGE_RESULTS,
  EVIDENCE_GAPS,
  evidenceGaps,
  inferenceSaturationProbe,
  inferenceSubject,
  OBSERVER_ASSESSMENTS,
  SATURATION_MIN_MISSING,
  SATURATION_VERDICTS,
  saturationVerdict,
  sweepIdEcho,
  sweepObservations,
  windowEcho,
  type CoverageEntry,
  type CoverageResult,
  type InferenceEndpoint,
  type ObserverArtifact,
  type ObserverAssessment,
  type SaturationOutcome,
  type SaturationProbe,
  type SaturationVerdict,
  type SweepAssessment,
  type SweepCoverage,
  type SweepWindow,
  type TriageDocument,
  type TriageRow,
} from "../../src/run/triage-verdict.ts";
import {
  advanceIncident,
  COVERAGE_THRESHOLD,
  freshIncidentRecord,
  type IncidentNotification,
  type IncidentObservation,
  type IncidentPolicy,
  type IncidentRecord,
} from "../../src/run/triage-incident.ts";
import { defaultTriageConsoleConfig } from "../../src/run/triage-config.ts";
import type {
  FetchLike,
  HostDialConfigView,
  ProbeFailure,
  ToolCallProbeResult,
} from "../../src/security/model-probe.ts";

/**
 * The environment as `triage/targets.yaml` declares it — the SRD's own example
 * names (§6.2), for `triage-partition.test.ts`'s reason: a fixture spelled
 * `a`/`b`/`c` makes an order-dependent bug read as an alphabetisation bug.
 */
const DECLARED = ["mia", "authorization", "authentication"] as const;

/** `TRIAGE_CONSOLE_ROSTER`, spelled out so a roster edit is visible here. */
const TRI = "tri-1";
const OBS = ["obs-t1", "obs-t2", "obs-t3"] as const;

/** The id the HOST minted for this sweep (§6.6 layer 2). */
const SWEEP = "T-sweep-42";
/** The id it minted for the last one — what a replaying session echoes back. */
const PREVIOUS = "T-sweep-41";

/**
 * A row carrying everything §6.7 rule 2 demands.
 *
 * The default is EVIDENCED, so every gate fixture below is this row with exactly
 * one field removed. A default that already failed the gate would make the four
 * separable fixtures indistinguishable from each other.
 */
function row(service: string, over: Partial<TriageRow> = {}): TriageRow {
  return {
    service,
    assessment: "healthy",
    coverage: [{ channel: "rollout", result: "answered" }],
    selector: `app.kubernetes.io/name=${service}`,
    window: "5m",
    evidence_ref: [`outbox/T-obs/files/observer-ops.json#${service}`],
    observer: null,
    ...over,
  };
}

function assign(worker: string, ...services: string[]): PartitionAssignment {
  return { worker, services };
}

/**
 * §7.4's bound, spelled as the two configured values and the dispatch instant.
 *
 * `300` is §7.8's `cadence_s` default expressed as §7.1's `default_window`
 * (`5m`) and `60` is §7.8's `reserve_s` default, so the legal range is the six
 * minutes ending at the dispatch. Both are spelled here rather than imported:
 * this file grades the ARITHMETIC, and a fixture that took its bound from the
 * same constant the code reads would agree with any bound at all.
 */
const DISPATCHED_AT = "2026-09-06T12:00:00.000Z";
const WINDOW: SweepWindow = {
  dispatched_at: DISPATCHED_AT,
  default_window_s: 300,
  reserve_s: 60,
};

/** `dispatched_at − default_window − reserve_s`, to the millisecond. Accepted. */
const EARLIEST = "2026-09-06T11:54:00.000Z";
/** One second before it. Refused — *"looked further back than configured"*. */
const TOO_EARLY = "2026-09-06T11:53:59.000Z";
/** One second after the dispatch. Refused — *"a window that opens in the future"*. */
const TOO_LATE = "2026-09-06T12:00:01.000Z";
/**
 * The ordinary case: STRICTLY INSIDE the range, on neither boundary.
 *
 * Every fixture that is not about a boundary uses this, so an off-by-one at
 * either edge is answered by the boundary block alone and cannot be masked by a
 * general fixture that happened to sit on the edge.
 */
const OPENED = "2026-09-06T11:56:00.000Z";

function artifact(
  worker: string,
  sweep_id: string | null = SWEEP,
  window_opened_at: string | null = OPENED,
): ObserverArtifact {
  return { worker, sweep_id, window_opened_at };
}

/** The whole environment, one service per observer, every reply present and fresh. */
function fullCoverage(over: Partial<SweepCoverage> = {}): SweepCoverage {
  return {
    declared: [...DECLARED],
    assignments: [
      assign(OBS[0], DECLARED[0]),
      assign(OBS[1], DECLARED[1]),
      assign(OBS[2], DECLARED[2]),
    ],
    artifacts: [artifact(OBS[0]), artifact(OBS[1]), artifact(OBS[2])],
    ...over,
  };
}

function doc(rows: readonly TriageRow[], over: Partial<TriageDocument> = {}): TriageDocument {
  return { worker: TRI, sweep_id: SWEEP, services: rows, unaccounted: [], ...over };
}

/** The assessment of one named service, or a failure that says which service. */
function of(result: ReturnType<typeof assessTriageSweep>, service: string) {
  const found = result.services.find((s) => s.service === service);
  if (found === undefined) throw new Error(`no assessment for ${service}`);
  return found;
}

describe("the positive control — a fresh, fully evidenced sweep", () => {
  /**
   * FIRST, and the file does not mean anything without it.
   *
   * Almost every other test here asserts a downgrade, and a mapping that
   * returned `indeterminate` unconditionally would satisfy all of them while
   * being a console that reports a coverage gap on all three services every five
   * minutes and never once says a service is fine. `triage-partition.test.ts`
   * opens on the same principle, from `review-console-relay.test.ts`:
   * *"The first assertion in that block is therefore the ACCEPTING one."*
   *
   * The three assessments are asserted BY NAME AND POSITION against three
   * DIFFERENT values, so a mapping that reversed the rows, or that returned one
   * value three times, reddens. Three identical `healthy`s would not.
   */
  test("takes each row as the observer wrote it, in declared order", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([
        row(DECLARED[0], { assessment: "healthy" }),
        row(DECLARED[1], { assessment: "degraded" }),
        row(DECLARED[2], { assessment: "unhealthy" }),
      ]),
    );

    expect(result.services.map((s) => s.service)).toEqual([...DECLARED]);
    expect(result.services.map((s) => s.assessment)).toEqual([
      "healthy",
      "degraded",
      "unhealthy",
    ]);
    expect(result.services.map((s) => s.reason)).toEqual(["observed", "observed", "observed"]);
    expect(result.services.map((s) => s.observer)).toEqual([...OBS]);
    /*
     * `claimed` is carried on the ACCEPTED path too, not only on the downgraded
     * one. **Added after a mutation dropping it here survived the first
     * battery.** It is the audit trail's record that a row existed at all, and a
     * `null` on an accepted row makes an observed verdict indistinguishable from
     * a host-supplied one in `~/.pifleet/triage.log`.
     */
    expect(result.services.map((s) => s.claimed)).toEqual(["healthy", "degraded", "unhealthy"]);
    expect(result.stale_replay).toEqual([]);
    /*
     * A row that names NO observer is not a disagreement about which observer
     * produced it. §7.5 puts the field in the contract; an absent value is an
     * observer that did not fill it in, and reporting that as a partition the
     * worker did not follow would make `misattributed` fire on every ordinary
     * sweep — the field would then be noise and the one real case invisible.
     */
    expect(result.census.misattributed).toEqual([]);
    expect(result.census.counted).toBe(3);
    expect(result.census.declared).toBe(3);
    expect(result.census.observers_reported).toBe(3);
    expect(result.census.observers_missing).toEqual([]);
  });

  /**
   * The sweep id on the outcome is the HOST's, never the document's.
   *
   * Cheap, and it pins the direction of §6.6 layer 3: a mapping that echoed the
   * document's id back would make the record agree with the replay it was
   * supposed to catch.
   */
  test("the outcome carries the dispatched id", () => {
    const result = assessTriageSweep(SWEEP, fullCoverage(), doc([row(DECLARED[0])]));
    expect(result.sweep_id).toBe(SWEEP);
  });
});

describe("§6.7 rule 2 — the structural gate, one fixture per condition", () => {
  /**
   * The accepting case for the gate itself, for the positive control's reason:
   * `evidenceGaps` returning every member unconditionally would satisfy all four
   * fixtures below.
   */
  test("a complete row has no gaps", () => {
    expect(evidenceGaps(row("mia"))).toEqual([]);
  });

  /**
   * FOUR SEPARABLE FIXTURES, and this is the block the task is graded on.
   *
   * Each removes exactly ONE of §6.7 rule 2's four conditions from an otherwise
   * complete row, and asserts the resulting gap BY NAME. A gate reading only
   * `coverage[]` — the first condition, and the one an implementer reaches for
   * first — passes fixture 1 and fails the other three. A gate ORing all four
   * into a boolean passes all four here and fails the by-name assertion.
   */
  test.each([
    ["an empty coverage[] alone", { coverage: [] }, ["coverage"]],
    ["a null selector alone", { selector: null }, ["selector"]],
    ["a null window alone", { window: null }, ["window"]],
    ["an empty evidence ledger alone", { evidence_ref: [] }, ["ledger"]],
  ] as const)("%s is the only gap reported", (_name, over, expected) => {
    expect(evidenceGaps(row("mia", over))).toEqual([...expected]);
  });

  /**
   * The same four, THROUGH the mapping.
   *
   * The block above proves `evidenceGaps` reads all four conditions. It does not
   * prove `assessTriageSweep` spends them: a mapping that computed the gaps
   * correctly and then branched on `gaps[0] === "coverage"` passes every
   * assertion above and downgrades one unevidenced `healthy` in four.
   *
   * Each asserts the DOWNGRADE (`indeterminate`), the RECORD CODE
   * (`unevidenced_healthy`), and the failing condition by name.
   */
  test.each([
    ["coverage", { coverage: [] }, ["coverage"]],
    ["selector", { selector: null }, ["selector"]],
    ["window", { window: null }, ["window"]],
    ["ledger", { evidence_ref: [] }, ["ledger"]],
  ] as const)(
    "a healthy row missing its %s alone is downgraded through the mapping",
    (_name, over, expected) => {
      const result = assessTriageSweep(
        SWEEP,
        fullCoverage(),
        doc([row(DECLARED[0], { assessment: "healthy", ...over })]),
      );

      const service = of(result, DECLARED[0]);
      expect(service.assessment).toBe("indeterminate");
      expect(service.reason).toBe("unevidenced_healthy");
      expect(service.gaps).toEqual([...expected]);
    },
  );

  /**
   * THE FIELD THE INCIDENT MACHINE READS NEVER SAYS `healthy`.
   *
   * §12: *"assert `unevidenced_healthy` and that it does **not** clear a firing
   * incident."* §6.8's recovery rule requires *"a sweep in which that service
   * returned `assessment: healthy` with the evidence §6.7's gate demands"*, so
   * the property that keeps a lazy `healthy` from closing an incident is that
   * `assessment` is not `healthy` — the raw claim survives only on `claimed`,
   * which is a different field with a different name.
   *
   * **This is the criterion that outranks the four above.** A gate that
   * downgrades correctly but publishes the worker's word on a field named
   * `assessment` sends *"a recovery notification for a service nobody could
   * see"*, which §6.8 calls the single most damaging message this console could
   * send.
   */
  test("a downgraded healthy keeps the worker's word on `claimed`, never on `assessment`", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([row(DECLARED[0], { assessment: "healthy", evidence_ref: [] })]),
    );

    const service = of(result, DECLARED[0]);
    expect(service.assessment).toBe("indeterminate");
    expect(service.claimed).toBe("healthy");
    expect(service.assessment).not.toBe("healthy");
  });

  /**
   * A DOWNGRADED `healthy` IS STILL A SERVICE THAT WAS REPORTED ON.
   *
   * **Added after a mutation decrementing `census.counted` inside the gate
   * survived the first battery** — the decision was defended in a docblock and by
   * nothing else, which is the shape this repository keeps recording.
   *
   * The two axes answer different questions. `counted` is §7.5's census with
   * services in place of lenses — *"how many independent readers reported"* — and
   * a fresh observer that wrote a row for this service reported on it. Whether
   * the report was any good is the assessment axis, three lines away.
   *
   * The consequence is not cosmetic and it lands in the next task but one: §6.7
   * rule 3's saturation verdict correlates observers that produced **no
   * artifact**. Folding a gate failure into the coverage count would make a lazy
   * observer arithmetically indistinguishable from an absent one, and 5.3a would
   * be reading a number that had already lost the distinction it turns on.
   */
  test("an unevidenced healthy still counts as covered", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([
        row(DECLARED[0], { assessment: "healthy", coverage: [] }),
        row(DECLARED[1]),
        row(DECLARED[2]),
      ]),
    );

    expect(of(result, DECLARED[0]).reason).toBe("unevidenced_healthy");
    expect(result.census.counted).toBe(3);
    expect(result.census.observers_missing).toEqual([]);
  });

  /**
   * A row failing TWO conditions reports both, in §6.7's own order.
   *
   * Asserted because every other gate fixture here has a single-member `gaps`,
   * and a single-member array cannot distinguish a list from a first-match
   * early return — nor can it catch a reversal.
   */
  test("two missing conditions are both reported, in the sentence's order", () => {
    expect(evidenceGaps(row("mia", { coverage: [], selector: null }))).toEqual([
      "coverage",
      "selector",
    ]);
  });

  /**
   * THE GATE IS SPENT ON `healthy` AND NOWHERE ELSE.
   *
   * §6.7's table gives `degraded` and `unhealthy` their own row — *"Yes, after
   * confirmation"* — and rule 2 is written about `healthy` alone. A gate applied
   * to all four values would turn an unevidenced `unhealthy` into
   * `indeterminate`, which converts a service issue into a coverage gap and is
   * the misdiagnosis direction §6.7 rule 3 spends its whole section on.
   *
   * The `gaps` are still REPORTED for these rows — the structure is a fact about
   * the row whatever the assessment — so this asserts the assessment survived
   * while the gaps were recorded, which a mutation zeroing `gaps` for non-healthy
   * rows would fail.
   */
  test.each(["degraded", "unhealthy", "indeterminate"] as const)(
    "an unevidenced %s is NOT downgraded",
    (assessment) => {
      const result = assessTriageSweep(
        SWEEP,
        fullCoverage(),
        doc([
          row(DECLARED[0], {
            assessment,
            coverage: [],
            selector: null,
            window: null,
            evidence_ref: [],
          }),
        ]),
      );

      const service = of(result, DECLARED[0]);
      expect(service.assessment).toBe(assessment);
      expect(service.reason).toBe("observed");
      expect(service.gaps).toEqual([...EVIDENCE_GAPS]);
    },
  );

  /**
   * BLANK IS ABSENT, or the gate is defeatable with a space bar.
   *
   * SRD-OBSERVER-001's own warning is that *"`kubectl logs -l` with a label
   * nothing carries exits zero and prints nothing — identical to a healthy,
   * silent service"*, and a whitespace selector is the degenerate case of
   * exactly that. A ledger holding one empty string is the same shape.
   */
  test.each([
    ["a whitespace selector", { selector: "   " }, ["selector"]],
    ["an empty-string window", { window: "" }, ["window"]],
    ["a ledger of one blank entry", { evidence_ref: ["  "] }, ["ledger"]],
  ] as const)("%s is not present", (_name, over, expected) => {
    expect(evidenceGaps(row("mia", over))).toEqual([...expected]);
  });
});

/**
 * §6.7 rule 2's FIFTH condition — §13 task 5.3b, and it is condition 1 read
 * honestly rather than a new judgement.
 *
 * §6.7's ruling: a `healthy` whose `coverage[]` is non-empty but whose every entry
 * is `not_attempted` passed the gate as written, and *"the reason it is safe to
 * say so is that **zero attempts and zero entries carry exactly the same
 * information** — the observer attempted nothing either way, and the array's
 * length is the only thing that differs."* So it spends the EXISTING `coverage`
 * gap rather than minting a fifth name, and it needs no threshold.
 *
 * ## What is NOT built here, said plainly so the silence is not read as an omission
 *
 * *"Were these channels ENOUGH"* has a threshold in it, is the judgement §6.7's
 * opening sentence removes from the host, and stays refused. This gate cannot tell
 * one answered channel from five; it can only tell the difference between an
 * observer that tried and one that did not.
 *
 * ## THE ASYMMETRIC FIXTURE IS THE TEST
 *
 * This is a quantifier over a set, and this branch's MEMORY records the same
 * defect six times: *"a subset, filter or intersection check survives mutation
 * whenever every fixture makes the two sets equal"*. Two ways to get it wrong, and
 * each needs its own fixture pointed at it:
 *
 *  - a gate failing EVERY non-empty `coverage[]` passes both the all-`not_attempted`
 *    fixture and the empty one — **the mixed fixture with one `answered` entry is
 *    what fails it**;
 *  - a gate spelled `some(e => e.result === "answered")` passes the mixed fixture
 *    and quietly downgrades every `healthy` whose channels came back `unreachable`
 *    or `forbidden` — which are ATTEMPTS, and are the observer telling the truth
 *    about what it found. **The per-result fixtures below are what fail that one**,
 *    and without them the condition is satisfiable by the wrong predicate.
 */
describe("§6.7 rule 2's fifth condition — zero attempts and zero entries (task 5.3b)", () => {
  const chan = (result: CoverageResult, channel: string): CoverageEntry => ({ channel, result });

  /** The three real channel names SRD-OBSERVER-001 §9.2a asks a `healthy` to carry. */
  const CHANNELS = ["rollout", "restarts", "freshness"] as const;

  /**
   * The split this condition turns on, asserted BY NAME against the closed set.
   *
   * Not by count: the point is which members are ATTEMPTS, and a count assertion
   * survives a fifth member landing on either side of the line.
   */
  test("the attempt axis divides COVERAGE_RESULTS by name", () => {
    expect(COVERAGE_RESULTS.filter((r) => r !== "not_attempted")).toEqual([
      "answered",
      "unreachable",
      "forbidden",
    ]);
    expect([...COVERAGE_RESULTS]).toContain("not_attempted");
  });

  /**
   * THE RULING, as an equality between two fixtures rather than as two separate
   * expectations: §13 task 5.3b's acceptance is that the two *"reach the same
   * assessment and the same gap by name"*.
   */
  test("an all-not_attempted coverage[] reports the same gap as an empty one", () => {
    const emptyArray = evidenceGaps(row("mia", { coverage: [] }));
    const noAttempts = evidenceGaps(
      row("mia", { coverage: CHANNELS.map((c) => chan("not_attempted", c)) }),
    );

    expect(noAttempts).toEqual(["coverage"]);
    expect(noAttempts).toEqual(emptyArray);
  });

  /**
   * **THE ANTI-CRITERION.** One `answered` among two `not_attempted`s is an
   * observer that looked, and the gate must let it through.
   *
   * Without this fixture the change is satisfiable by a gate that fails every
   * coverage array, which would downgrade every evidenced `healthy` in the fleet
   * to `indeterminate` and turn the whole console into a coverage alarm.
   */
  test("ANTI: one answered entry among not_attempted is NOT a gap", () => {
    expect(
      evidenceGaps(
        row("mia", {
          coverage: [
            chan("not_attempted", CHANNELS[0]),
            chan("answered", CHANNELS[1]),
            chan("not_attempted", CHANNELS[2]),
          ],
        }),
      ),
    ).toEqual([]);
  });

  /**
   * **THE SECOND ANTI-CRITERION, and it is the one a plausible implementation
   * fails.** `unreachable` and `forbidden` are ATTEMPTS.
   *
   * SRD-OBSERVER-001 §9.1 puts all three beside `not_attempted` on one axis, and
   * an observer that tried a channel and was refused by RBAC has told the operator
   * something true about the cluster. Downgrading that `healthy` would be the host
   * deciding the channel set was insufficient — the *"were these channels enough"*
   * judgement §6.7 refuses — and it would arrive as a coverage gap naming the
   * environment, which is the misdiagnosis direction §6.7 rule 3 spends a section
   * on.
   */
  test.each([["unreachable"], ["forbidden"], ["answered"]] as const)(
    "a lone %s entry is an attempt and closes the gap",
    (result) => {
      expect(evidenceGaps(row("mia", { coverage: [chan(result, CHANNELS[0])] }))).toEqual([]);
      // And mixed with attempts that were never made, which is the shape a real
      // partial observation has.
      expect(
        evidenceGaps(
          row("mia", {
            coverage: [chan("not_attempted", CHANNELS[0]), chan(result, CHANNELS[1])],
          }),
        ),
      ).toEqual([]);
    },
  );

  /**
   * THROUGH THE MAPPING, because a gap computed correctly and spent on the wrong
   * branch is a second, separate defect — the reason the four original conditions
   * are each graded twice.
   *
   * The two fixtures are asserted EQUAL on all three fields, which is task 5.3b's
   * acceptance sentence executed rather than paraphrased.
   */
  test("an all-not_attempted healthy is downgraded exactly as an empty one is", () => {
    const graded = (coverage: readonly CoverageEntry[]) => {
      const result = assessTriageSweep(
        SWEEP,
        fullCoverage(),
        doc([row(DECLARED[0], { assessment: "healthy", coverage })]),
      );
      const service = of(result, DECLARED[0]);
      return {
        assessment: service.assessment,
        reason: service.reason,
        gaps: [...service.gaps],
        claimed: service.claimed,
      };
    };

    const noAttempts = graded(CHANNELS.map((c) => chan("not_attempted", c)));
    expect(noAttempts).toEqual({
      assessment: "indeterminate",
      reason: "unevidenced_healthy",
      gaps: ["coverage"],
      claimed: "healthy",
    });
    expect(noAttempts).toEqual(graded([]));
  });

  /** The mixed row survives the mapping too, and keeps the observer's own word. */
  test("ANTI: a healthy with one answered channel survives the mapping", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([
        row(DECLARED[0], {
          assessment: "healthy",
          coverage: [chan("not_attempted", CHANNELS[0]), chan("answered", CHANNELS[1])],
        }),
      ]),
    );

    const service = of(result, DECLARED[0]);
    expect(service.assessment).toBe("healthy");
    expect(service.reason).toBe("observed");
    expect(service.gaps).toEqual([]);
  });

  /**
   * The gate is still spent on `healthy` ALONE — the fifth condition did not
   * widen it.
   *
   * An `unhealthy` whose channels were all `not_attempted` stays `unhealthy`:
   * downgrading it would convert a service issue into a coverage gap, which is
   * §6.7 rule 3's misdiagnosis direction arriving through the gate instead of
   * through saturation. The gap is still REPORTED, because the structure is a
   * fact about the row whatever the assessment.
   */
  test("an unhealthy row with no attempts is not downgraded, and its gap is still named", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([
        row(DECLARED[0], {
          assessment: "unhealthy",
          coverage: CHANNELS.map((c) => chan("not_attempted", c)),
        }),
      ]),
    );

    const service = of(result, DECLARED[0]);
    expect(service.assessment).toBe("unhealthy");
    expect(service.reason).toBe("observed");
    expect(service.gaps).toEqual(["coverage"]);
  });

  /**
   * A row that attempted nothing was still REPORTED ON — the count and the
   * quality are different axes, and 5.3a's saturation verdict reads the count.
   *
   * The same property the empty-`coverage[]` fixture asserts, restated for the
   * new shape: folding this gate failure into `census.counted` would make a lazy
   * observer arithmetically indistinguishable from an absent one.
   */
  test("a healthy that attempted nothing still counts as covered", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([
        row(DECLARED[0], {
          assessment: "healthy",
          coverage: CHANNELS.map((c) => chan("not_attempted", c)),
        }),
        row(DECLARED[1]),
        row(DECLARED[2]),
      ]),
    );

    expect(of(result, DECLARED[0]).reason).toBe("unevidenced_healthy");
    expect(result.census.counted).toBe(3);
    expect(result.census.observers_missing).toEqual([]);
  });

  /**
   * The fifth condition did not become a fifth GAP NAME. §13 task 5.3b:
   * *"spending the existing `coverage` gap rather than a new one"*.
   */
  test("EVIDENCE_GAPS did not grow a fifth member", () => {
    expect([...EVIDENCE_GAPS]).toEqual(["coverage", "selector", "window", "ledger"]);
  });
});

describe("§6.6 layer 3 — the sweep_id echo (task 5.3)", () => {
  /** Three states, asserted as three, because the module keeps them apart. */
  test.each([
    [SWEEP, "fresh"],
    [PREVIOUS, "stale"],
    [null, "absent"],
    ["", "absent"],
  ] as const)("an echo of %p is %s", (echoed, expected) => {
    expect(sweepIdEcho(SWEEP, echoed)).toBe(expected);
  });

  /**
   * THE ROW IS NOT COUNTED, and that is the half a label satisfies without
   * fixing.
   *
   * §7.4: *"An artifact whose value is not the dispatched one is `stale_replay`
   * and **the row is not counted**"*. So this asserts three things: the
   * assessment fell to `indeterminate`, the outcome NAMES the replaying seat, and
   * `census.counted` excludes it.
   *
   * **The fixture is asymmetric across observers on purpose.** `obs-t1` replays
   * and `obs-t2` and `obs-t3` do not, so an implementation that discarded the
   * whole sweep on one stale artifact reddens on the two survivors, and one that
   * discarded nothing reddens on `mia`. The stale observer's row claims
   * `healthy` **with full evidence** — a replay is a well-formed answer to last
   * sweep's question, and a check that only refused malformed rows would pass a
   * fixture whose stale row was also unevidenced.
   */
  test("a stale observer artifact takes its own services down and no others", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        artifacts: [artifact(OBS[0], PREVIOUS), artifact(OBS[1]), artifact(OBS[2])],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(of(result, DECLARED[0]).assessment).toBe("indeterminate");
    expect(of(result, DECLARED[0]).reason).toBe("stale_replay");
    expect(of(result, DECLARED[0]).claimed).toBeNull();
    expect(of(result, DECLARED[1]).assessment).toBe("healthy");
    expect(of(result, DECLARED[2]).assessment).toBe("healthy");

    expect(result.stale_replay).toEqual([OBS[0]]);
    expect(result.census.observers_stale).toEqual([OBS[0]]);
    // NOT COUNTED — two of the three rows the document wrote survived.
    expect(result.census.declared).toBe(3);
    expect(result.census.counted).toBe(2);
    expect(result.census.observers_reported).toBe(2);
  });

  /**
   * An artifact that omitted the required field is `stale_replay` too.
   *
   * §7.4 makes the field required and gives one code for *"not the dispatched
   * one"*; an absent value is not the dispatched one. Separated from the stale
   * fixture because an implementation using `!==` against `undefined` would treat
   * a missing echo as a mismatch by luck rather than by rule, and one using
   * optional chaining could treat it as a pass.
   */
  test("an artifact echoing no sweep id at all is stale_replay", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        artifacts: [artifact(OBS[0], null), artifact(OBS[1]), artifact(OBS[2])],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(of(result, DECLARED[0]).reason).toBe("stale_replay");
    expect(result.census.observers_stale).toEqual([OBS[0]]);
    expect(result.census.counted).toBe(2);
  });

  /**
   * A STALE COLLATOR TAKES THE WHOLE SWEEP, and this is the widest replay
   * available.
   *
   * §7.5 requires the echo on `triage.json` as well, and §2.3a says why it is not
   * redundant: the session is per `(run, worker)` and nothing rotates it, and
   * `tri-1` is dispatched twice per sweep where an observer is dispatched once.
   * A replaying `tri-1` returns last sweep's verdict for every service at once —
   * three well-formed, fully evidenced `healthy` rows about a cluster nobody
   * looked at this sweep.
   *
   * `stale_replay` names the collator FIRST and the observers after, and the
   * observers here are clean, so this fixture also separates
   * `SweepAssessment.stale_replay` from `census.observers_stale`: a mutation
   * returning one where the other belongs reddens.
   */
  test("a stale triage.json discards every row and counts nothing", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])], { sweep_id: PREVIOUS }),
    );

    expect(result.services.map((s) => s.assessment)).toEqual([
      "indeterminate",
      "indeterminate",
      "indeterminate",
    ]);
    expect(result.services.map((s) => s.reason)).toEqual([
      "stale_replay",
      "stale_replay",
      "stale_replay",
    ]);
    expect(result.services.map((s) => s.claimed)).toEqual([null, null, null]);

    /*
     * THE OUTCOME'S OWN ID IS THE HOST'S, on the one fixture where the two
     * differ. **Added after a mutation reading it out of the document survived
     * the first battery** — every other fixture here has the document echoing the
     * dispatched id, so the two values were equal everywhere the assertion was
     * made and the mutation was invisible. A record that took the replay's id
     * would file this sweep's incident state under the previous sweep and print
     * the wrong id in `~/.pifleet/triage.log`, which is a replay covering its own
     * tracks.
     */
    expect(result.sweep_id).toBe(SWEEP);
    expect(result.sweep_id).not.toBe(PREVIOUS);

    expect(result.stale_replay).toEqual([TRI]);
    expect(result.census.observers_stale).toEqual([]);
    // NOT COUNTED — the document declared three rows and the host accepted none.
    expect(result.census.declared).toBe(3);
    expect(result.census.counted).toBe(0);
  });

  /**
   * Both levels stale at once: the collator is named FIRST and the observer after.
   *
   * A two-member `stale_replay` with members drawn from two different sources is
   * what makes the order assertable at all; every other fixture in this block has
   * one member and could not tell a reversal from a correct list.
   */
  test("a stale collator and a stale observer are both named, collator first", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        artifacts: [artifact(OBS[0]), artifact(OBS[1]), artifact(OBS[2], PREVIOUS)],
      }),
      doc([row(DECLARED[0])], { sweep_id: PREVIOUS }),
    );

    expect(result.stale_replay).toEqual([TRI, OBS[2]]);
    expect(result.census.observers_stale).toEqual([OBS[2]]);
    expect(result.census.counted).toBe(0);
  });

  /**
   * A DOCUMENT CANNOT SUPPLY ITS OWN COMPARAND.
   *
   * §6.6: *"A worker cannot forge it into correctness by accident: the value is
   * minted host-side, per sweep."* Here the document and every artifact agree
   * with each other on `T-sweep-41` and disagree with the host — which is exactly
   * what a whole console replaying one sweep late looks like, and it is
   * internally consistent. An implementation comparing the document's id to the
   * artifacts' ids, rather than both to the host's, passes every other fixture in
   * this file and returns three fresh `healthy`s here.
   */
  test("a wholly self-consistent previous sweep is still stale", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        artifacts: [
          artifact(OBS[0], PREVIOUS),
          artifact(OBS[1], PREVIOUS),
          artifact(OBS[2], PREVIOUS),
        ],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])], { sweep_id: PREVIOUS }),
    );

    expect(result.services.every((s) => s.assessment === "indeterminate")).toBe(true);
    expect(result.census.counted).toBe(0);
    expect(result.stale_replay).toEqual([TRI, ...OBS]);
  });
});

/**
 * ── §7.4's SECOND ECHO — `window_opened_at` (task 5.3c) ────────────────────
 *
 * §6.6 layer 3's *other* half, and §7.4 says in as many words why it is not a
 * duplicate of the first: *"An observer can echo the correct sweep id, name a
 * window in every row, and have queried six hours against a five-minute
 * configuration — **reporting stale data as fresh, which is the exact failure
 * layer 3 exists to prevent**."*
 *
 * ## THE PAIR AT THE BOTTOM IS THE BLOCK, AND THE BOUNDARIES ARE THE REST
 *
 * Two checks that both discard an artifact are two checks a suite cannot tell
 * apart on any fixture where both are wrong. So the two fixtures that matter
 * most here are the ASYMMETRIC ones — a correct `sweep_id` with a bad window,
 * and a bad `sweep_id` with a good window — and each asserts the reason BY NAME.
 * Without that pair either check can be deleted whole and every other test in
 * this file stays green, which is this branch's recorded defect arriving in the
 * one shape §7.4 invites.
 *
 * The four boundary instants are spelled as literals and their arithmetic is
 * asserted one test EARLIER, against `dispatched_at − default_window −
 * reserve_s` computed from the same two numbers the policy carries. A
 * hand-typed instant that was not actually the boundary would make two of the
 * four cases vacuous, and no assertion inside them could see it.
 *
 * ## WHAT IS NOT ASSERTED, so the silence is not read as coverage
 *
 * **`triage.json` has no window.** §7.4 puts `window_opened_at` on
 * `observer-ops.json`; §7.5 does not put it on the collator's document, so
 * `stale_window` never names `tri-1` the way `stale_replay` does. That is the
 * contract's asymmetry rather than an omission here, and the census test below
 * asserts the collator's absence rather than leaving it unstated.
 */
describe("§7.4 — the window_opened_at echo (task 5.3c)", () => {
  /**
   * THE PREMISE, one step earlier than the fixtures that rest on it.
   *
   * `EARLIEST` is a string this file typed by hand. If it is not exactly
   * `dispatched_at − default_window − reserve_s` then the accepted-boundary case
   * below is testing some other instant, the refused one is testing a second
   * other instant, and both pass against an implementation with the bound in the
   * wrong place. A comment claiming the arithmetic cannot go red; this can.
   */
  test("the fixture instants are the boundary §7.4's table names", () => {
    const dispatched = Date.parse(DISPATCHED_AT);
    expect(Date.parse(EARLIEST)).toBe(
      dispatched - (WINDOW.default_window_s + WINDOW.reserve_s) * 1_000,
    );
    expect(Date.parse(TOO_EARLY)).toBe(Date.parse(EARLIEST) - 1_000);
    expect(Date.parse(TOO_LATE)).toBe(dispatched + 1_000);
    // And the ordinary fixture is INSIDE, touching neither edge.
    expect(Date.parse(OPENED)).toBeGreaterThan(Date.parse(EARLIEST));
    expect(Date.parse(OPENED)).toBeLessThan(dispatched);
  });

  /** §7.4's table, one row at a time, asserted BY VALUE at each boundary. */
  test.each([
    [EARLIEST, "fresh"],
    [TOO_EARLY, "out_of_range"],
    [DISPATCHED_AT, "fresh"],
    [TOO_LATE, "out_of_range"],
    [OPENED, "fresh"],
    [null, "absent"],
    ["", "absent"],
    ["   ", "absent"],
  ] as const)("a window opened at %p is %s", (openedAt, expected) => {
    expect(windowEcho(DISPATCHED_AT, openedAt, WINDOW)).toBe(expected);
  });

  /**
   * An artifact that omitted the field entirely, which is what `undefined` is.
   *
   * Separate from the `null` row because they arrive from different readers — a
   * schema that maps a missing key to `null` and a value read straight off a
   * parsed object are both real, and a check that handled one would silently
   * accept the other.
   */
  test("an omitted field is absent, not fresh", () => {
    expect(windowEcho(DISPATCHED_AT, undefined, WINDOW)).toBe("absent");
  });

  /**
   * A string that is not an instant is `absent` rather than `out_of_range`.
   *
   * Three states and no fourth, so the question is which existing one it spends.
   * `out_of_range` means *"the observer looked at the wrong stretch of time"* and
   * a garbage value says nothing of the kind; `absent` is the honest one — the
   * artifact carries no usable window instant, which is the same thing to go and
   * fix. **Both refuse**, so nothing turns on the choice except the log line.
   */
  test("a value that is not an instant is absent", () => {
    expect(windowEcho(DISPATCHED_AT, "yesterday", WINDOW)).toBe("absent");
    expect(windowEcho(DISPATCHED_AT, "2026-13-45T99:00:00Z", WINDOW)).toBe("absent");
  });

  /**
   * A HOST bound that is not a number THROWS, and this is the arm that stops the
   * check failing open.
   *
   * `Date.parse` answers `NaN` for a malformed instant, and every comparison
   * against `NaN` is false — so a `windowEcho` that shrugged at its own bound
   * would find no artifact earlier than the earliest and none later than the
   * dispatch, and would return `fresh` for **every** artifact in every sweep.
   * A check that accepts everything when its own configuration is malformed is
   * precisely the silent pass this console exists to catch, and it is invisible
   * in the outcome: `stale_window` would simply never appear again.
   *
   * Throwing is also the module's own rule for this class — *"a value, with
   * throwing reserved for host arguments that are wrong for the life of the
   * run"*. The dispatch instant and the two knobs are host values; the artifact's
   * echo is the container's, and that one is answered with a state.
   */
  test("a host bound that is not a number throws instead of accepting everything", () => {
    expect(() => windowEcho("not-an-instant", OPENED, WINDOW)).toThrow(RangeError);
    expect(() => windowEcho(DISPATCHED_AT, OPENED, { ...WINDOW, default_window_s: NaN })).toThrow(
      RangeError,
    );
    expect(() => windowEcho(DISPATCHED_AT, OPENED, { ...WINDOW, reserve_s: NaN })).toThrow(
      RangeError,
    );
  });

  /**
   * THE POSITIVE CONTROL for the whole block.
   *
   * Every other test here asserts a discard, and a mapping that returned
   * `stale_window` whenever a policy was supplied would satisfy all of them —
   * a console that reports a stale window on all three services every five
   * minutes and never once accepts a sweep.
   */
  test("a sweep whose windows are all in range is observed, and counted", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({ window: WINDOW }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(result.services.map((s) => s.reason)).toEqual(["observed", "observed", "observed"]);
    expect(result.stale_window).toEqual([]);
    expect(result.census.counted).toBe(3);
    expect(result.census.observers_reported).toBe(3);
    expect(result.window_checked).toBe(true);
  });

  /**
   * ── THE PAIR §13 CALLS *"the criterion that matters most"* ─────────────────
   *
   * *"A correct `sweep_id` with a bad window still discards, and a bad
   * `sweep_id` with a good window still discards, so neither check can be
   * satisfied by the other."*
   *
   * Both arms are in ONE test on purpose: the claim is about the two together,
   * and a reader who deleted one of two adjacent tests would not be told the
   * pair had stopped being a pair. Each names its reason, so an implementation
   * that spent both echoes as one code passes neither arm.
   */
  test("a good id with a bad window discards, and a bad id with a good window discards", () => {
    const goodIdBadWindow = assessTriageSweep(
      SWEEP,
      fullCoverage({
        window: WINDOW,
        artifacts: [artifact(OBS[0], SWEEP, TOO_EARLY), artifact(OBS[1]), artifact(OBS[2])],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(of(goodIdBadWindow, DECLARED[0]).assessment).toBe("indeterminate");
    expect(of(goodIdBadWindow, DECLARED[0]).reason).toBe("stale_window");
    expect(of(goodIdBadWindow, DECLARED[0]).claimed).toBeNull();
    // The id check had nothing to say about it, and says nothing.
    expect(goodIdBadWindow.stale_replay).toEqual([]);
    expect(goodIdBadWindow.stale_window).toEqual([OBS[0]]);

    const badIdGoodWindow = assessTriageSweep(
      SWEEP,
      fullCoverage({
        window: WINDOW,
        artifacts: [artifact(OBS[0], PREVIOUS, OPENED), artifact(OBS[1]), artifact(OBS[2])],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(of(badIdGoodWindow, DECLARED[0]).assessment).toBe("indeterminate");
    expect(of(badIdGoodWindow, DECLARED[0]).reason).toBe("stale_replay");
    expect(badIdGoodWindow.stale_replay).toEqual([OBS[0]]);
    expect(badIdGoodWindow.stale_window).toEqual([]);

    // And in BOTH, the two clean observers survive — an implementation that
    // discarded the sweep on one bad artifact reddens here rather than passing
    // on the half of the fixture it got right.
    for (const result of [goodIdBadWindow, badIdGoodWindow]) {
      expect(of(result, DECLARED[1]).reason).toBe("observed");
      expect(of(result, DECLARED[2]).reason).toBe("observed");
      expect(result.census.counted).toBe(2);
    }
  });

  /**
   * ARTIFACT-LEVEL, and that is the half a per-row check would satisfy.
   *
   * §7.4: *"It is an ARTIFACT-level check, so it discards the artifact rather
   * than gapping a row … a wrong window applies to every row the document
   * carries."* So the observer with the bad window is given TWO services and
   * both fall, while the third observer's service stands. A check that
   * downgraded only the row whose own `window` field disagreed would pass a
   * one-service fixture and fail this one.
   *
   * The discarded rows claim `healthy` **with full evidence**: a window six
   * hours wide is a well-formed answer to the wrong question, and a check that
   * only refused malformed rows would never fire on the failure §7.4 describes.
   */
  test("one bad window takes every service that observer covered, and no others", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        window: WINDOW,
        assignments: [assign(OBS[0], DECLARED[0], DECLARED[1]), assign(OBS[1], DECLARED[2])],
        artifacts: [artifact(OBS[0], SWEEP, TOO_EARLY), artifact(OBS[1])],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(of(result, DECLARED[0]).reason).toBe("stale_window");
    expect(of(result, DECLARED[1]).reason).toBe("stale_window");
    expect(of(result, DECLARED[2]).reason).toBe("observed");
    expect(result.census.counted).toBe(1);
    expect(result.census.observers_reported).toBe(1);
    expect(result.census.observers_stale_window).toEqual([OBS[0]]);
  });

  /** §7.4's first table row: absent is refused, like every other artifact echo. */
  test("an artifact that omitted the field discards its services", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        window: WINDOW,
        artifacts: [{ worker: OBS[0], sweep_id: SWEEP }, artifact(OBS[1]), artifact(OBS[2])],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(of(result, DECLARED[0]).reason).toBe("stale_window");
    expect(result.stale_window).toEqual([OBS[0]]);
    expect(result.census.counted).toBe(2);
  });

  /**
   * THE FOUR LISTS ARE MUTUALLY DIFFERENT AND NEITHER CONTAINS THE OTHER.
   *
   * This branch's MEMORY carries the defect four times: a set-shaped assertion
   * survives mutation whenever every fixture makes the two sets equal, and one
   * recorded instance survived REVERSING two output arrays. So one sweep makes
   * `observers_missing`, `observers_stale`, `observers_stale_window` and the
   * reported count simultaneously non-empty and different, and swapping any two
   * of them reddens.
   */
  test("stale-id and stale-window are different lists, and a fixture separates them", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        window: WINDOW,
        assignments: [
          assign(OBS[0], DECLARED[0]),
          assign(OBS[1], DECLARED[1]),
          assign(OBS[2], DECLARED[2]),
          assign("obs-t4", "ingest"),
        ],
        declared: [...DECLARED, "ingest"],
        artifacts: [
          artifact(OBS[0], PREVIOUS, OPENED), // stale id, good window
          artifact(OBS[1], SWEEP, TOO_LATE), // good id, bad window
          artifact(OBS[2]), // clean
          // obs-t4 wrote nothing at all.
        ],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2]), row("ingest")]),
    );

    expect(result.census.observers_stale).toEqual([OBS[0]]);
    expect(result.census.observers_stale_window).toEqual([OBS[1]]);
    expect(result.census.observers_missing).toEqual(["obs-t4"]);
    expect(result.census.observers_reported).toBe(1);
    expect(result.stale_replay).toEqual([OBS[0]]);
    expect(result.stale_window).toEqual([OBS[1]]);

    // The four exhaust the dispatched set, so a seat cannot fall out of all of
    // them — the same arithmetic the three-way partition asserted before the
    // fourth class existed.
    const c = result.census;
    expect(c.observers_total).toBe(4);
    expect(
      c.observers_reported +
        c.observers_missing.length +
        c.observers_stale.length +
        c.observers_stale_window.length,
    ).toBe(c.observers_total);
  });

  /**
   * THE COLLATOR IS NOT IN THIS LIST, and the contract is why.
   *
   * §7.4 puts `window_opened_at` on `observer-ops.json`; §7.5's `triage.json`
   * carries the sweep id and no window. So `stale_replay` names `tri-1` when the
   * document is stale and `stale_window` never can. Asserted rather than left
   * implicit: a later reader adding a window to the document contract should
   * find a test that says where the boundary was, not silence.
   */
  test("a stale document names the collator; a bad window names only observers", () => {
    const staleDoc = assessTriageSweep(
      SWEEP,
      fullCoverage({ window: WINDOW }),
      doc([row(DECLARED[0])], { sweep_id: PREVIOUS }),
    );
    expect(staleDoc.stale_replay).toContain(TRI);
    expect(staleDoc.stale_window).toEqual([]);

    const badWindow = assessTriageSweep(
      SWEEP,
      fullCoverage({
        window: WINDOW,
        artifacts: [artifact(OBS[0], SWEEP, TOO_EARLY), artifact(OBS[1]), artifact(OBS[2])],
      }),
      doc([row(DECLARED[0])]),
    );
    expect(badWindow.stale_window).not.toContain(TRI);
  });

  /**
   * A stale id and a bad window on the SAME artifact resolves to `stale_replay`.
   *
   * Both are true and the row is discarded either way, so the only question is
   * which fact the operator is handed. The id is the narrower and more
   * actionable one — a replaying session returns last sweep's answer entire, and
   * last sweep's window comes with it, so the window fault is a CONSEQUENCE
   * rather than a second finding. `no_artifact` sits above `stale_replay` for
   * the same reason and the module's docblock states it.
   */
  test("a stale id and a bad window together report the id", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        window: WINDOW,
        artifacts: [artifact(OBS[0], PREVIOUS, TOO_EARLY), artifact(OBS[1]), artifact(OBS[2])],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(of(result, DECLARED[0]).reason).toBe("stale_replay");
    expect(result.census.observers_stale).toEqual([OBS[0]]);
    expect(result.census.observers_stale_window).toEqual([]);
  });

  /**
   * A SWEEP ASSESSED WITH NO POLICY SAYS SO, IN THE OUTCOME.
   *
   * `SweepCoverage.window` is optional, which means a caller can leave the check
   * unrun. That is a fact about the sweep and the only place it would otherwise
   * appear is nowhere — the same argument `observers_unsolicited` is published
   * under. `window_checked` is the fact, and asserting BOTH values is what makes
   * it a claim rather than a constant: an implementation that hardcoded `true`
   * passes the first arm and fails the second.
   */
  test("window_checked is false without a policy and true with one", () => {
    const unchecked = assessTriageSweep(
      SWEEP,
      fullCoverage({
        artifacts: [artifact(OBS[0], SWEEP, TOO_EARLY), artifact(OBS[1]), artifact(OBS[2])],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );
    expect(unchecked.window_checked).toBe(false);
    // And with nothing to check against, the out-of-range window is not spent.
    expect(of(unchecked, DECLARED[0]).reason).toBe("observed");
    expect(unchecked.stale_window).toEqual([]);

    const checked = assessTriageSweep(
      SWEEP,
      fullCoverage({ window: WINDOW }),
      doc([row(DECLARED[0])]),
    );
    expect(checked.window_checked).toBe(true);
  });
});

describe("§6.7 — coverage is counted host-side, never from triage.json's claim", () => {
  /**
   * §12's ANTI-CRITERION, verbatim: *"a fixture where `triage.json` claims three
   * services observed while the journal holds three `children[]` and two reply
   * files; assert the missing service is `indeterminate`. A gate reading the
   * worker's claim passes this fixture and is exactly the defect being pinned."*
   *
   * The missing observer's row is a fully evidenced `healthy`, because that is
   * the row that makes the difference visible: a mapping that read the document
   * would report a clean sweep, and *"two clean reports and a missing third reads
   * exactly like a clean sweep"* (§6.5).
   */
  test("a service whose observer wrote no reply file is indeterminate whatever its row says", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({ artifacts: [artifact(OBS[0]), artifact(OBS[1])] }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2], { assessment: "healthy" })]),
    );

    expect(of(result, DECLARED[2]).assessment).toBe("indeterminate");
    expect(of(result, DECLARED[2]).reason).toBe("no_artifact");
    expect(of(result, DECLARED[2]).claimed).toBeNull();
    expect(of(result, DECLARED[0]).assessment).toBe("healthy");
    expect(of(result, DECLARED[1]).assessment).toBe("healthy");

    expect(result.census.observers_missing).toEqual([OBS[2]]);
    expect(result.census.observers_total).toBe(3);
    // The claim and the count disagree in public — §7.5's whole argument.
    expect(result.census.declared).toBe(3);
    expect(result.census.counted).toBe(2);
  });

  /**
   * THE ASYMMETRIC SERVICE FIXTURE. Neither set contains the other:
   *
   *     declared : {mia, authorization}
   *     rows     : {authorization, ingest}
   *
   * This one fixture separates four implementations at once:
   *
   *  - a mapping that returns the document's rows → `ingest` appears in the
   *    output and `mia` does not;
   *  - a mapping comparing SIZES sees 2 against 2 and reports nothing;
   *  - a mapping asking only `rows ⊆ declared` finds `ingest` and never looks for
   *    `mia`;
   *  - a mapping asking only `declared ⊆ rows` finds `mia` and never looks for
   *    `ingest`.
   *
   * Asserted by NAME throughout. `undeclared_rows` and the `services` list are
   * asserted against DIFFERENT contents, so swapping them reddens.
   */
  test("a row for an undeclared service is named and never assessed; a declared service with no row is unreported", () => {
    const result = assessTriageSweep(
      SWEEP,
      {
        declared: ["mia", "authorization"],
        assignments: [assign(OBS[0], "mia", "authorization")],
        artifacts: [artifact(OBS[0])],
      },
      doc([row("authorization"), row("ingest")]),
    );

    expect(result.services.map((s) => s.service)).toEqual(["mia", "authorization"]);
    expect(of(result, "mia").assessment).toBe("indeterminate");
    expect(of(result, "mia").reason).toBe("unreported");
    expect(of(result, "authorization").assessment).toBe("healthy");
    expect(result.census.undeclared_rows).toEqual(["ingest"]);
    expect(result.census.declared).toBe(2);
    expect(result.census.counted).toBe(1);
  });

  /**
   * THE ASYMMETRIC OBSERVER FIXTURE, and it makes three lists simultaneously
   * non-empty and mutually different:
   *
   *     dispatched : {obs-t1, obs-t2, obs-t3}
   *     artifacts  : {obs-t2 fresh, obs-t3 stale, obs-x unsolicited}
   *
   * so `observers_missing` is `[obs-t1]`, `observers_stale` is `[obs-t3]` and
   * `observers_unsolicited` is `[obs-x]`. Swapping any two of the three reddens,
   * which no fixture with a single populated list can catch.
   *
   * `obs-x` was never dispatched — a reply file from a seat this sweep did not
   * ask, which is either a run-tree read that crossed a sweep boundary or a
   * roster that moved under the actor. It must not conjure coverage: `obs-x`
   * holds no assignment, so nothing it wrote can reach a service.
   */
  test("missing, stale and unsolicited observers are three different named lists", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        artifacts: [artifact(OBS[1]), artifact(OBS[2], PREVIOUS), artifact("obs-x")],
      }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(result.census.observers_missing).toEqual([OBS[0]]);
    expect(result.census.observers_stale).toEqual([OBS[2]]);
    expect(result.census.observers_unsolicited).toEqual(["obs-x"]);

    expect(of(result, DECLARED[0]).reason).toBe("no_artifact");
    expect(of(result, DECLARED[1]).reason).toBe("observed");
    expect(of(result, DECLARED[2]).reason).toBe("stale_replay");
    expect(result.census.counted).toBe(1);
  });

  /**
   * The lists PARTITION the dispatched set.
   *
   * `observers_total = reported + missing + stale + stale_window` is what makes
   * the census readable as a denominator (§7.5, `CollationCensus`'s *"A count of
   * readers who agreed is not `3/3` without it"*). A seat that fell out of all
   * of them — an observer counted as neither reporting, missing, stale nor
   * out-of-window — would make the arithmetic silently wrong, and every
   * individual list assertion above would still pass.
   *
   * **The fourth term is zero in THIS fixture**, which supplies no window policy
   * and so cannot separate it; §7.4's block carries the version where all four
   * are non-empty and mutually different. Both are kept: this one is the sweep
   * an actor without a policy produces, and the arithmetic has to hold there too.
   */
  test("every dispatched observer lands in exactly one of the census's classes", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        artifacts: [artifact(OBS[1]), artifact(OBS[2], PREVIOUS), artifact("obs-x")],
      }),
      doc([]),
    );

    const {
      observers_total,
      observers_reported,
      observers_missing,
      observers_stale,
      observers_stale_window,
    } = result.census;
    expect(observers_total).toBe(3);
    expect(observers_stale_window).toEqual([]);
    expect(
      observers_reported +
        observers_missing.length +
        observers_stale.length +
        observers_stale_window.length,
    ).toBe(observers_total);
  });

  /**
   * A declared service the partition assigned to nobody.
   *
   * `checkTriagePartition` refuses this as `partition_incomplete` before dispatch
   * (§6.5), so it is unreachable through `dispatchPartition`. It is answered
   * rather than assumed away because the alternative for a total function is
   * returning the worker's row for a service nobody was asked about — a `healthy`
   * derived from nothing at all, which is the worst single output this module
   * could produce. The row here IS a fully evidenced `healthy`, so a mapping that
   * fell through to the document reddens.
   */
  test("a declared service in no assignment is indeterminate, not the row's claim", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({ assignments: [assign(OBS[0], DECLARED[0]), assign(OBS[1], DECLARED[1])] }),
      doc([row(DECLARED[0]), row(DECLARED[1]), row(DECLARED[2])]),
    );

    expect(of(result, DECLARED[2]).assessment).toBe("indeterminate");
    expect(of(result, DECLARED[2]).reason).toBe("unassigned");
    expect(of(result, DECLARED[2]).observer).toBeNull();
    expect(result.census.counted).toBe(2);
  });

  /**
   * `triage.json`'s own `unaccounted` list is RECORDED and branched on nowhere.
   *
   * §7.5 puts it in the contract, so refusing to accept the field would leave a
   * contract field with no reader; §6.7 says the host counts, so believing it
   * would put the worker's claim back on the branch. Here the worker says it
   * could not account for `authorization` while its observer replied freshly with
   * an evidenced row for it — and the host's answer is the row.
   *
   * The reverse direction is asserted in the same test: `authentication` IS
   * unaccounted for by the host's count, and does not appear in
   * `claimed_unaccounted`, so the two lists have different members and a mutation
   * sourcing one from the other reddens.
   */
  test("the worker's unaccounted list is recorded and decides nothing", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({ artifacts: [artifact(OBS[0]), artifact(OBS[1])] }),
      doc([row(DECLARED[0]), row(DECLARED[1])], { unaccounted: [DECLARED[1]] }),
    );

    expect(result.census.claimed_unaccounted).toEqual([DECLARED[1]]);
    expect(of(result, DECLARED[1]).assessment).toBe("healthy");
    expect(of(result, DECLARED[1]).reason).toBe("observed");
    expect(of(result, DECLARED[2]).reason).toBe("no_artifact");
    expect(result.census.observers_missing).toEqual([OBS[2]]);
  });

  /**
   * A row naming an observer other than the assigned one is READ, and NAMED.
   *
   * The host's assignment decides coverage and the row's `observer` field decides
   * nothing — otherwise a worker could move a service between observers by
   * writing a different string, which is the claim-over-count inversion §6.7
   * exists to prevent. But a partition the worker did not follow is a fact about
   * the sweep, and `misattributed` is the only place it would appear.
   *
   * Two services and two different lists: `misattributed` names `mia` while
   * `undeclared_rows` names `ingest`, so a mutation returning one for the other
   * reddens.
   */
  test("a misattributed row is still read, and the disagreement is named", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([
        row(DECLARED[0], { observer: OBS[1] }),
        row(DECLARED[1], { observer: OBS[1] }),
        row("ingest", { observer: OBS[1] }),
      ]),
    );

    expect(result.census.misattributed).toEqual([DECLARED[0]]);
    expect(result.census.undeclared_rows).toEqual(["ingest"]);
    expect(of(result, DECLARED[0]).assessment).toBe("healthy");
    expect(of(result, DECLARED[0]).observer).toBe(OBS[0]);
  });

  /**
   * TWO ROWS FOR ONE SERVICE IS REFUSED, AND THE ORDER OF THEM DOES NOT MATTER.
   *
   * **This whole behaviour exists because of a mutation.** The first
   * implementation took the first row and dropped the rest; swapping it for
   * last-wins survived the entire opening battery, because no fixture gave a
   * service two rows. Probing the survivor found that neither rule is defensible:
   * `triage.json` is a document a container wrote, nothing stops it repeating a
   * service, and an `unhealthy` followed by a `healthy` **flips the verdict**
   * under one rule and not the other. Either way a worker can overturn its own
   * finding by appending to its output, which is the claim-over-count inversion
   * §6.7 exists to prevent arriving through a door the host held open.
   *
   * §12 D12 says a single `assessment` covering a batch is a schema violation;
   * two assessments covering one service is that rule inverted. So the host
   * declines, and the run of this test in BOTH orders is what says the decline is
   * about the multiplicity rather than about which value happened to be last.
   */
  test.each([
    ["unhealthy then healthy", ["unhealthy", "healthy"]],
    ["healthy then unhealthy", ["healthy", "unhealthy"]],
  ] as const)("a service given two rows (%s) is indeterminate and not counted", (_n, pair) => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([
        row(DECLARED[0], { assessment: pair[0] as ObserverAssessment }),
        row(DECLARED[0], { assessment: pair[1] as ObserverAssessment }),
        row(DECLARED[1]),
        row(DECLARED[2]),
      ]),
    );

    expect(of(result, DECLARED[0]).assessment).toBe("indeterminate");
    expect(of(result, DECLARED[0]).reason).toBe("duplicate_rows");
    expect(of(result, DECLARED[0]).claimed).toBeNull();
    expect(result.census.duplicate_rows).toEqual([DECLARED[0]]);
    // NOT COUNTED, and the two survivors are.
    expect(result.census.declared).toBe(4);
    expect(result.census.counted).toBe(2);
    expect(of(result, DECLARED[1]).assessment).toBe("healthy");
  });

  /**
   * `undeclared_rows` and `duplicate_rows` are DIFFERENT lists with different
   * members, and each names a service once however many rows carried it.
   *
   * **Added after a mutation deduplicating `undeclared_rows` survived**: the
   * original fixture named one undeclared service once, so listing-as-written and
   * listing-once were the same output. Here `ingest` appears twice and
   * `billing` once, in that order, so a dedup that lost the ORDER or the second
   * member reddens — and `duplicate_rows` holds `mia` and `ingest` while
   * `undeclared_rows` holds `ingest` and `billing`, so the two overlap without
   * either containing the other and a mutation returning one for the other
   * cannot pass.
   */
  test("undeclared and duplicate rows are two overlapping lists, each named once", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage(),
      doc([
        row(DECLARED[0]),
        row(DECLARED[0]),
        row("ingest"),
        row("ingest"),
        row("billing"),
      ]),
    );

    expect(result.census.undeclared_rows).toEqual(["ingest", "billing"]);
    expect(result.census.duplicate_rows).toEqual([DECLARED[0], "ingest"]);
    expect(result.services.map((s) => s.service)).toEqual([...DECLARED]);
  });

  /**
   * A service claimed by two observers takes the FIRST assignment.
   *
   * `checkTriagePartition` refuses this as `partition_duplicate` before dispatch
   * (§6.5), so the case is unreachable through `dispatchPartition` and the choice
   * is documented rather than load-bearing. It is asserted anyway, because a
   * decision defended only in a docblock is a decision the next reader reverses
   * for a perfectly good reason — `triage-partition.test.ts` added a whole test
   * for that after a `Promise.all` mutation survived its own prose.
   *
   * The two candidate observers hold DIFFERENT reply states — `obs-t1` replied
   * freshly and `obs-t2` did not — so first-wins and last-wins produce different
   * assessments here rather than only a different `observer` string.
   */
  test("a service in two assignments takes the first", () => {
    const result = assessTriageSweep(
      SWEEP,
      {
        declared: ["mia"],
        assignments: [assign(OBS[0], "mia"), assign(OBS[1], "mia")],
        artifacts: [artifact(OBS[0])],
      },
      doc([row("mia")]),
    );

    expect(of(result, "mia").observer).toBe(OBS[0]);
    expect(of(result, "mia").assessment).toBe("healthy");
    expect(result.census.observers_missing).toEqual([OBS[1]]);
  });

  /**
   * The empty environment, and it is vacuous rather than clean.
   *
   * `TriageEnvironmentSchema`'s `services.min(1)` makes this unreachable from a
   * loaded targets file, the same place `checkTriagePartition` puts its own
   * `N = 0` row. Asserted so a mapping that special-cased emptiness into a
   * synthetic all-clear would redden.
   */
  test("no declared services yields no assessments and counts nothing", () => {
    const result = assessTriageSweep(
      SWEEP,
      { declared: [], assignments: [], artifacts: [] },
      doc([]),
    );
    expect(result.services).toEqual([]);
    expect(result.census.counted).toBe(0);
    expect(result.census.observers_total).toBe(0);
  });
});

describe("the closed sets, asserted by name", () => {
  /**
   * §12's console-health criterion states the rule for every closed set in this
   * console — *"assert the enum's members by name … not by count"*, from
   * `test/unit/monitor-readonly.test.ts:363-369`'s lesson *"that naming the
   * permitted set is what makes a seventh member fail."*
   *
   * `OBSERVER_ASSESSMENTS` is the one that matters most: §6.7's opening sentence
   * is *"derived from the observer's own fields, never judged fresh"*, and a
   * fifth member here would be this host inventing a verdict. `unevidenced_healthy`
   * and `stale_replay` are on the REASON axis for exactly that reason, and the
   * two assertions below are what say they did not migrate.
   */
  test("OBSERVER_ASSESSMENTS is SRD-OBSERVER-001 §9.1's four values and no fifth", () => {
    expect([...OBSERVER_ASSESSMENTS]).toEqual([
      "healthy",
      "degraded",
      "unhealthy",
      "indeterminate",
    ]);
    const invented: readonly string[] = OBSERVER_ASSESSMENTS;
    expect(invented).not.toContain("unevidenced_healthy");
    expect(invented).not.toContain("stale_replay");
  });

  test("COVERAGE_RESULTS is SRD-OBSERVER-001 §9.1's four channel results", () => {
    expect([...COVERAGE_RESULTS]).toEqual([
      "answered",
      "unreachable",
      "forbidden",
      "not_attempted",
    ]);
  });

  test("EVIDENCE_GAPS is §6.7 rule 2's four conditions, in the sentence's order", () => {
    expect([...EVIDENCE_GAPS]).toEqual(["coverage", "selector", "window", "ledger"]);
  });

  test("ASSESSMENT_REASONS is closed at eight", () => {
    expect([...ASSESSMENT_REASONS]).toEqual([
      "observed",
      "unevidenced_healthy",
      "stale_replay",
      "stale_window",
      "no_artifact",
      "unreported",
      "duplicate_rows",
      "unassigned",
    ]);
  });

  /**
   * Every reason the mapping can produce is a declared member.
   *
   * Drives the enum rather than asserting it a second time: a reason string
   * constructed inline in `assessTriageSweep` and never added to
   * `ASSESSMENT_REASONS` would compile — the field is typed by the enum — but
   * this walks the union and pins that the two agree at runtime, which is what a
   * `as never` escape hatch would break.
   */
  test("every assessment this module returns carries a declared reason", () => {
    const reasons: readonly string[] = ASSESSMENT_REASONS;
    const seen = new Set<string>();
    const cases: ReturnType<typeof assessTriageSweep>[] = [
      assessTriageSweep(SWEEP, fullCoverage(), doc([row(DECLARED[0])])),
      assessTriageSweep(SWEEP, fullCoverage(), doc([row(DECLARED[0], { evidence_ref: [] })])),
      assessTriageSweep(SWEEP, fullCoverage(), doc([], { sweep_id: PREVIOUS })),
      assessTriageSweep(SWEEP, fullCoverage({ artifacts: [] }), doc([])),
      assessTriageSweep(SWEEP, fullCoverage(), doc([])),
      assessTriageSweep(SWEEP, fullCoverage({ assignments: [] }), doc([])),
      assessTriageSweep(SWEEP, fullCoverage(), doc([row(DECLARED[0]), row(DECLARED[0])])),
      assessTriageSweep(
        SWEEP,
        fullCoverage({
          window: WINDOW,
          artifacts: [artifact(OBS[0], SWEEP, TOO_EARLY), artifact(OBS[1]), artifact(OBS[2])],
        }),
        doc([row(DECLARED[0])]),
      ),
    ];
    for (const result of cases) for (const s of result.services) seen.add(s.reason);

    for (const reason of seen) expect(reasons).toContain(reason);
    expect([...seen].sort()).toEqual([...ASSESSMENT_REASONS].sort());
  });
});

/**
 * The assessment values this module can put on `assessment`, as a compile-time
 * claim rather than a runtime one.
 *
 * `ObserverAssessment` is imported as a type and used here so a widening of the
 * union — a fifth member added to `OBSERVER_ASSESSMENTS` — reddens `tsc --noEmit`
 * on this line as well as the by-name test above. The runtime test catches an
 * added member; this catches the union being replaced by `string`, which the
 * runtime test cannot see.
 */
const _assessmentsAreExhaustive: readonly ObserverAssessment[] = [
  "healthy",
  "degraded",
  "unhealthy",
  "indeterminate",
];
void _assessmentsAreExhaustive;

// ───────────────────────────────────────────────────────────────────────────
// §6.7 rule 3, D15, §9.16 — the saturation verdict (§13 task 5.3a)
// ───────────────────────────────────────────────────────────────────────────

/**
 * ## The one criterion the rest of this block is graded on
 *
 * §13 task 5.3a: *"§12's Saturation block passes, **including the two-of-three
 * fixture that must not saturate**. That anti-fixture is the criterion the rest of
 * the task is graded on — a rule that saturates whenever anything is indeterminate
 * passes every positive fixture and fails only that one."*
 *
 * So every fixture below is built to break the coincidence that would make the
 * rule indistinguishable from `some(s => s.assessment === "indeterminate")`. Four
 * fixtures do it, and each names its premise one step earlier so it cannot go
 * degenerate in silence:
 *
 * | fixture | indeterminate services | observers with no artifact | verdict |
 * |---|---|---|---|
 * | one artifact of three | 2 | **2** | `saturated` |
 * | two artifacts of three | 1 | **1** | `uncorrelated` |
 * | one observer holding all three, silent | **3** | 1 | `uncorrelated` |
 * | two observers silent, third reports `healthy` | 2 of 3 | **2** | `saturated` |
 *
 * Rows three and four are the asymmetric pair: a rule counting indeterminate
 * SERVICES saturates on row three and is uncorrelated on row four, and both
 * answers are wrong. §6.7 rule 3's own sentence is why — *"two or more observers
 * producing no artifact in one sweep is a statement about what they have in
 * common"* — and what an observer's three services have in common is the observer,
 * not the provider.
 *
 * A fifth pair separates `observers_missing` from `observers_stale`, because
 * *"produced no artifact **at all**"* is not *"produced nothing usable"*: a stale
 * artifact is a file, which means that seat got an answer out of the model, which
 * is evidence against saturation rather than for it.
 *
 * ## No fixture here reaches the network, and the fence is structural
 *
 * The probe is a required parameter with no default (`saturationVerdict.length` is
 * asserted), the factory that builds the real one takes a required `FetchLike`
 * (its arity is asserted too), and the module's own source is read below and
 * asserted to contain no bare `fetch(`. Fixtures that are NOT saturation
 * candidates are handed `NEVER`, which throws if it is called at all — a stronger
 * statement than a call count, because it fails at the call site.
 */

/** The environment, deliberately sharing no substring with the provider or model. */
const ENV = "cni-dev";

/**
 * §6.10's endpoint: *"every seat resolves to `gpt-oss-20b-MXFP4-Q8` on `omlx`"*.
 *
 * Provider, model and environment are pairwise distinct and non-substring, and a
 * premise test below asserts it. ISC-681's lesson: a fixture where the tokens
 * coincide makes a swap invisible.
 */
const ENDPOINT: InferenceEndpoint = { provider: "omlx", model: "gpt-oss-20b-MXFP4-Q8" };

const AT = Date.UTC(2026, 8, 6, 12, 0, 0);
const EVIDENCE = "outbox/T-sweep-42/files/triage.json";
const CTX = { environment: ENV, at: AT, evidenceRef: EVIDENCE };

/** The shipped defaults, read from the schema rather than re-typed (§7.8). */
const POLICY: IncidentPolicy = defaultTriageConsoleConfig();

function probeResult(failure: ProbeFailure | null): ToolCallProbeResult {
  return {
    model: ENDPOINT.model,
    ok: failure === null,
    failure,
    detail: `fixture probe: ${failure ?? "answered"}`,
  };
}

/** A probe double that counts its calls. It cannot reach anything. */
function stubProbe(failure: ProbeFailure | null): { probe: SaturationProbe; calls: () => number } {
  let n = 0;
  return {
    probe: () => {
      n += 1;
      return Promise.resolve(probeResult(failure));
    },
    calls: () => n,
  };
}

/**
 * The probe for every sweep that is NOT a saturation candidate.
 *
 * §6.7 rule 3: the probe runs *"once per saturation candidate and never per
 * sweep"*, and §6.10 is why it matters — the resource being probed is the one this
 * console is accused of starving, so a completion request on all 288 sweeps a day
 * would manufacture the condition the verdict exists to report. Throwing is a
 * harder assertion than a call count: it fails at the offending line.
 */
const NEVER: SaturationProbe = () => {
  throw new Error("the confirming probe ran on a sweep that is not a saturation candidate");
};

/** `assessTriageSweep` over a coverage and a document, at the dispatched id. */
function assess(coverage: SweepCoverage, document: TriageDocument): SweepAssessment {
  return assessTriageSweep(SWEEP, coverage, document);
}

/** One evidenced `healthy` row per named service. */
function healthyRows(...services: string[]): TriageRow[] {
  return services.map((s) => row(s, { assessment: "healthy" }));
}

/**
 * Advance one record per service through one sweep's observations.
 *
 * Returns the next records and every notification, so a criterion phrased about
 * *"no coverage issue was composed"* is asserted on the notifications rather than
 * inferred from a state.
 */
function advanceAll(
  records: ReadonlyMap<string, IncidentRecord>,
  observations: readonly IncidentObservation[],
): { records: Map<string, IncidentRecord>; notifications: IncidentNotification[] } {
  const next = new Map(records);
  const notifications: IncidentNotification[] = [];
  for (const observation of observations) {
    if (observation.subject.kind !== "service") throw new Error("service observations only");
    const service = observation.subject.service;
    const held = next.get(service) ?? freshIncidentRecord(observation.subject);
    const step = advanceIncident(held, observation, POLICY);
    next.set(service, step.record);
    notifications.push(...step.notifications);
  }
  return { records: next, notifications };
}

/**
 * Two ordinary blind sweeps that are NOT saturation candidates, leaving the named
 * service at `consecutive_indeterminate: 2`.
 *
 * Every artifact is present and fresh; the blindness comes from `unreported` —
 * the observer answered this sweep and its document carries no row. So
 * `observers_missing` is empty, the verdict is `clear`, nothing is suppressed, and
 * the counter advances for real. **Building the runway out of missing artifacts
 * instead would make the runway itself a saturation candidate**, and the fixture
 * would be testing the suppression against a sweep that was already suppressed.
 */
function runway(blind: string): {
  records: Map<string, IncidentRecord>;
  notifications: IncidentNotification[];
} {
  const reported = DECLARED.filter((s) => s !== blind);
  let records = new Map<string, IncidentRecord>();
  const notifications: IncidentNotification[] = [];
  for (let n = 0; n < 2; n += 1) {
    const assessment = assess(fullCoverage(), doc(healthyRows(...reported)));
    const outcome: SaturationOutcome = {
      verdict: "clear",
      saturated: false,
      suppressed: false,
      subject: inferenceSubject(ENDPOINT),
      correlated: [],
      probe: null,
    };
    const step = advanceAll(records, sweepObservations(assessment, outcome, { ...CTX, at: AT + n }));
    records = step.records;
    notifications.push(...step.notifications);
  }
  return { records, notifications };
}

describe("§6.7 rule 3 — the correlation, and what it is a statement about", () => {
  /**
   * §12: *"**Anti: two observers producing no artifact in one sweep is
   * `saturated`, not a coverage gap.** Probe: a fixture sweep with one artifact of
   * three."*
   *
   * The premise is asserted first: two observers missing, and the probe is called
   * exactly once. A verdict reached without consulting the probe would satisfy the
   * verdict assertion alone.
   */
  test("one artifact of three is SATURATED, on a probe that timed out", async () => {
    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0])] }),
      doc(healthyRows(DECLARED[0])),
    );
    expect(assessment.census.observers_missing).toEqual([OBS[1], OBS[2]]);

    const probe = stubProbe("timeout");
    const outcome = await saturationVerdict(assessment, ENDPOINT, probe.probe);

    expect(outcome.verdict).toBe("saturated");
    expect(outcome.saturated).toBe(true);
    expect(outcome.suppressed).toBe(true);
    expect(outcome.correlated).toEqual([OBS[1], OBS[2]]);
    expect(probe.calls()).toBe(1);
  });

  /**
   * **THE ANTI-FIXTURE §13 names, and the one this task is graded on.**
   *
   * *"One observer missing is **not** saturation. Probe: a fixture sweep with two
   * artifacts of three; assert the normal `indeterminate` path and that
   * `consecutive_indeterminate` **did** advance."*
   *
   * The probe is `NEVER`, so a rule that consulted it here — and any rule that
   * saturates on one missing observer must — throws rather than merely returning a
   * wrong verdict.
   */
  test("two artifacts of three is NOT saturation, and the probe is never asked", async () => {
    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0]), artifact(OBS[1])] }),
      doc(healthyRows(DECLARED[0], DECLARED[1])),
    );
    // The premise, one step earlier: exactly one observer silent, and exactly one
    // service blind. A fixture that drifted to two of either would stop testing
    // the boundary and start testing the positive case again.
    expect(assessment.census.observers_missing).toEqual([OBS[2]]);
    expect(assessment.services.filter((s) => s.assessment === "indeterminate")).toHaveLength(1);

    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    expect(outcome.verdict).toBe("uncorrelated");
    expect(outcome.saturated).toBeNull();
    expect(outcome.suppressed).toBe(false);
    expect(outcome.probe).toBeNull();
  });

  /**
   * **The asymmetric fixture that separates observers from services.**
   *
   * One observer holds all three services and produces nothing: THREE services are
   * `indeterminate` and ONE observer is silent. A rule written over the service
   * verdicts saturates here, and it is wrong — three services behind one stalled
   * seat is a worker to restart, not a provider to wait for.
   *
   * Both halves of the asymmetry are asserted as premises. Without them a later
   * edit that gave the fixture a second observer would silently turn it into the
   * positive case and this test would keep passing.
   */
  test("one silent observer holding THREE services is a coverage gap, not saturation", async () => {
    const assessment = assess(
      fullCoverage({ assignments: [assign(OBS[0], ...DECLARED)], artifacts: [] }),
      doc([]),
    );
    expect(assessment.services.map((s) => s.assessment)).toEqual([
      "indeterminate",
      "indeterminate",
      "indeterminate",
    ]);
    expect(assessment.census.observers_missing).toEqual([OBS[0]]);

    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    expect(outcome.verdict).toBe("uncorrelated");
    expect(outcome.suppressed).toBe(false);
  });

  /**
   * **Its mirror**, and the reason both are needed: a rule requiring EVERY service
   * to be blind passes the fixture above and fails this one.
   *
   * Two observers silent, and the third reports an evidenced `healthy`. Two of
   * three services are `indeterminate` — not all — and the sweep is saturated.
   */
  test("two silent observers saturate even though one service came back healthy", async () => {
    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0])] }),
      doc(healthyRows(DECLARED[0])),
    );
    // The premise: the healthy service is genuinely healthy, so the set of
    // indeterminate services is a STRICT subset of the declared set.
    expect(of(assessment, DECLARED[0]).assessment).toBe("healthy");
    expect(assessment.services.filter((s) => s.assessment === "indeterminate")).toHaveLength(2);

    const probe = stubProbe("timeout");
    const outcome = await saturationVerdict(assessment, ENDPOINT, probe.probe);
    expect(outcome.verdict).toBe("saturated");
    expect(probe.calls()).toBe(1);
  });

  /**
   * **`observers_missing` is not `observers_stale`, and the fixture makes the two
   * counts fall on opposite sides of the threshold.**
   *
   * Four seats: one produced nothing, two echoed the previous sweep's id, one
   * answered cleanly. A rule reading the stale list, or reading
   * `observers_total − observers_reported`, counts two or three and saturates. The
   * right answer is one, because a stale artifact IS an artifact — that seat got
   * an answer out of the model, which is evidence against saturation.
   */
  test("two STALE artifacts and one missing is not saturation — a stale file is a file", async () => {
    const fourth = "obs-t4";
    const assessment = assess(
      fullCoverage({
        declared: [...DECLARED, "ingest"],
        assignments: [
          assign(OBS[0], DECLARED[0]),
          assign(OBS[1], DECLARED[1]),
          assign(OBS[2], DECLARED[2]),
          assign(fourth, "ingest"),
        ],
        artifacts: [artifact(OBS[0]), artifact(OBS[1], PREVIOUS), artifact(OBS[2], PREVIOUS)],
      }),
      doc(healthyRows(DECLARED[0])),
    );
    // Asymmetric and named: the two lists are non-empty, disjoint, and of
    // DIFFERENT lengths that fall on opposite sides of the threshold.
    expect(assessment.census.observers_missing).toEqual([fourth]);
    expect(assessment.census.observers_stale).toEqual([OBS[1], OBS[2]]);
    expect(assessment.census.observers_total - assessment.census.observers_reported).toBe(3);

    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    expect(outcome.verdict).toBe("uncorrelated");
    expect(outcome.correlated).toEqual([fourth]);
  });

  /**
   * The mirror of the same pair: two missing and one stale DOES saturate, so the
   * test above cannot be satisfied by a rule that never saturates.
   */
  test("two MISSING and one stale does saturate", async () => {
    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0], PREVIOUS)] }),
      doc(healthyRows(DECLARED[0])),
    );
    expect(assessment.census.observers_missing).toEqual([OBS[1], OBS[2]]);
    expect(assessment.census.observers_stale).toEqual([OBS[0]]);

    const probe = stubProbe("timeout");
    expect((await saturationVerdict(assessment, ENDPOINT, probe.probe)).verdict).toBe("saturated");
  });

  /**
   * `clear` is the ONLY verdict that reports `saturated: false`, and §6.8a fixes
   * what earns it: *"a sweep in which every observer produced an artifact"*.
   */
  test("every observer producing an artifact clears, and the probe is not asked", async () => {
    const assessment = assess(fullCoverage(), doc(healthyRows(...DECLARED)));
    expect(assessment.census.observers_missing).toEqual([]);

    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    expect(outcome.verdict).toBe("clear");
    expect(outcome.saturated).toBe(false);
    expect(outcome.suppressed).toBe(false);
  });

  /**
   * The twin that matters: every artifact present but every one of them STALE
   * still clears, because §6.8a's clause is about producing a file and not about
   * the file being usable. `observers_reported` is zero on that sweep, so a rule
   * reading the report count instead would refuse to clear a saturation incident
   * on a sweep where the provider demonstrably answered three times.
   */
  test("artifacts that are all STALE still clear — the clause is about producing a file", async () => {
    const assessment = assess(
      fullCoverage({
        artifacts: [
          artifact(OBS[0], PREVIOUS),
          artifact(OBS[1], PREVIOUS),
          artifact(OBS[2], PREVIOUS),
        ],
      }),
      doc(healthyRows(...DECLARED)),
    );
    expect(assessment.census.observers_missing).toEqual([]);
    expect(assessment.census.observers_reported).toBe(0);

    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    expect(outcome.verdict).toBe("clear");
    expect(outcome.saturated).toBe(false);
  });

  /**
   * A sweep that dispatched nobody is `unconfirmed`, never `clear`.
   *
   * `observers_missing` is empty in both cases and only one of them is *"every
   * observer produced an artifact"*. ISC-675's rule applied at the one place an
   * empty set means two different things: clearing a saturation incident out of an
   * absence is the mistake, and it would arrive here through arithmetic rather
   * than through a boolean.
   */
  test("a sweep that dispatched nobody says NOTHING — not `clear`", async () => {
    const assessment = assess(fullCoverage({ assignments: [], artifacts: [] }), doc([]));
    expect(assessment.census.observers_missing).toEqual([]);
    expect(assessment.census.observers_total).toBe(0);

    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    expect(outcome.verdict).toBe("unconfirmed");
    expect(outcome.saturated).toBeNull();
    expect(outcome.probe).toBeNull();
  });

  /** The threshold is `SATURATION_MIN_MISSING`, and §6.7 rule 3's number is two. */
  test("the threshold is two, and it is the module's own constant", () => {
    expect(SATURATION_MIN_MISSING).toBe(2);
  });

  /** §6.2 rule 4's closed-set discipline: members by NAME, never by count. */
  test("the verdict vocabulary is closed, asserted by name", () => {
    expect([...SATURATION_VERDICTS]).toEqual([
      "clear",
      "uncorrelated",
      "saturated",
      "endpoint_down",
      "unconfirmed",
    ]);
  });
});

describe("§6.7 rule 3's confirming probe — and its two failure classes stay apart", () => {
  /**
   * *"A `timeout` verdict is saturation. An `unreachable` verdict is the server
   * being down, which is a different sentence on the operator's screen and a
   * different thing for them to go and do."* `probeNativeToolCalls` carries the
   * incident report for conflating them (S1).
   *
   * The `Record` is exhaustive over `ProbeFailure` BY CONSTRUCTION: a seventh
   * member added to that union is a `tsc --noEmit` error on this literal, so a new
   * probe class cannot silently default into saturation.
   */
  const EXPECTED: Record<ProbeFailure, SaturationVerdict> = {
    timeout: "saturated",
    unreachable: "endpoint_down",
    prose: "unconfirmed",
    "model-not-found": "unconfirmed",
    malformed: "unconfirmed",
    inconclusive: "unconfirmed",
  };

  const candidate = (): SweepAssessment =>
    assess(fullCoverage({ artifacts: [artifact(OBS[0])] }), doc(healthyRows(DECLARED[0])));

  test("every probe class maps to its own verdict, and only two of six suppress", async () => {
    const seen: Record<string, [SaturationVerdict, boolean | null, boolean]> = {};
    for (const failure of Object.keys(EXPECTED) as ProbeFailure[]) {
      const probe = stubProbe(failure);
      const outcome = await saturationVerdict(candidate(), ENDPOINT, probe.probe);
      expect(probe.calls()).toBe(1);
      expect(outcome.verdict).toBe(EXPECTED[failure]);
      seen[failure] = [outcome.verdict, outcome.saturated, outcome.suppressed];
    }

    // By full value, so the three fields cannot drift apart. `endpoint_down`
    // suppresses WITHOUT setting `saturated`: the coverage escalation must not
    // point the operator at their cluster over a process on their own machine,
    // and `inference_saturated` must not announce a saturation that is not
    // happening. One boolean could not hold both answers.
    expect(seen).toEqual({
      timeout: ["saturated", true, true],
      unreachable: ["endpoint_down", null, true],
      prose: ["unconfirmed", null, false],
      "model-not-found": ["unconfirmed", null, false],
      malformed: ["unconfirmed", null, false],
      inconclusive: ["unconfirmed", null, false],
    });
  });

  /**
   * A probe that ANSWERS is `unconfirmed`, never `clear`.
   *
   * One small completion answering promptly, seconds after the sweep ended, is not
   * evidence the endpoint was answering during it — and `clear` is the value that
   * CLEARS an `inference_saturated` incident. The result is still carried, so a
   * reader can tell this from the sweep that never asked.
   */
  test("a probe that succeeds settles nothing, and does not clear", async () => {
    const probe = stubProbe(null);
    const outcome = await saturationVerdict(candidate(), ENDPOINT, probe.probe);
    expect(outcome.verdict).toBe("unconfirmed");
    expect(outcome.saturated).toBeNull();
    expect(outcome.suppressed).toBe(false);
    expect(outcome.probe?.ok).toBe(true);
    expect(probe.calls()).toBe(1);
  });

  /**
   * **The probe has NO DEFAULT, and the arity is how that is graded.**
   *
   * A defaulted parameter does not count toward `Function.length`, so a default
   * added here — the one omitted argument between this suite and a real POST to
   * the operator's own inference server — reddens. It is ISC-260's rule applied to
   * the mirror hazard: *"Removing the default is the load-bearing half of that
   * change."*
   */
  test("neither the verdict nor the factory carries a defaulted dependency", () => {
    expect(saturationVerdict.length).toBe(3);
    // Five, because `Function.length` counts every parameter up to the first
    // one carrying an initialiser, and `timeoutMs?: number` has none. That is
    // what makes the number load-bearing rather than incidental: a default on
    // `fetchImpl` — the parameter this criterion is about — drops it to 3.
    expect(inferenceSaturationProbe.length).toBe(5);
  });

  /**
   * And the fence the arities cannot see: the module names no `fetch` of its own.
   *
   * Read from the source, because the property is *"there is no path from this
   * module to the network that a caller did not supply"* and no runtime call can
   * observe a path that is never taken.
   */
  test("the module reaches the network only through a value a caller handed it", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "run", "triage-verdict.ts"),
      "utf8",
    );
    // Comments are stripped rather than matched around. A probe over the raw
    // text fails the moment a docblock QUOTES the pattern it is looking for —
    // which this one did on its first run — and the repair a hurried reader
    // would reach for is to reword the prose, leaving a probe that any future
    // comment can redden. `test/unit/fresh-dispatch.test.ts` reached the same
    // conclusion for the seat-list probe (ISC-696).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // The premise, because `not.toMatch` against an empty string passes: a
    // stripper that ate the module would make every assertion below vacuous.
    expect(code).toContain("export async function saturationVerdict");
    expect(code).toContain("export function inferenceSaturationProbe");

    expect(code).not.toMatch(/(?<![A-Za-z])fetch\s*\(/);
    expect(code).not.toContain("globalThis.fetch");
    expect(code).not.toContain("XMLHttpRequest");
    // §13 names both functions by file and line; this is the assertion that the
    // sentence is true of the code rather than only of the brief.
    expect(code).toContain("probeNativeToolCalls");
    expect(code).toContain("hostReachableBaseUrl");
  });

  /**
   * The factory dials `hostReachableBaseUrl`, not `llm.base_url`.
   *
   * This probe runs in the ACTOR's process, on the host, and `base_url` is what a
   * WORKER dials — on the shipped default it names the relay's bridge alias, which
   * the host cannot resolve at all (ISC-291). A factory that dialled it would
   * report the endpoint unreachable on a healthy machine and turn every saturation
   * candidate into an `endpoint_down`, which is rule 3's own misdiagnosis arriving
   * through the confirming probe.
   *
   * The injected `fetchImpl` records and answers; nothing leaves the process.
   */
  test("the real probe dials the HOST-reachable target, never the worker-facing one", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = (input) => {
      seen.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {} }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    const config: HostDialConfigView = {
      llm: {
        base_url: "http://omlx.pifleet.internal:10240/v1",
        relay_upstream: "192.168.7.9:10240",
      },
    };

    const probe = inferenceSaturationProbe(config, "", ENDPOINT.model, fetchImpl, 1_000);
    const result = await probe();

    expect(seen).toEqual(["http://192.168.7.9:10240/v1/chat/completions"]);
    expect(seen[0]).not.toContain("omlx.pifleet.internal");
    // The result is a real `ToolCallProbeResult` rather than a shape this file
    // invented, so the mapping above is graded against the function the console
    // will actually be handed.
    expect(result.failure).toBe("prose");
    expect(result.model).toBe(ENDPOINT.model);
  });
});

describe("§6.7 rule 3's ORDERING — the suppression, driven through the machine", () => {
  /**
   * §12's saturation criterion, end to end and in full: *"a fixture sweep with one
   * artifact of three; assert the outcome is `saturated`, that each service's
   * `consecutive_indeterminate` did **not** advance, and that no coverage issue
   * was composed."*
   *
   * The runway is what makes it bite. Two ordinary blind sweeps leave the blind
   * service at `consecutive_indeterminate: 2`, one short of `COVERAGE_THRESHOLD`,
   * so the saturated third sweep is the one that WOULD escalate under a verdict
   * that reported saturation and let the counter advance anyway. §13: *"a
   * saturation verdict that does not stop `consecutive_indeterminate` advancing is
   * a console that reports both findings and lets the operator pick the wrong
   * one."*
   *
   * Asserted by OBJECT IDENTITY, the incident suite's own discipline: a
   * field-by-field comparison silently stops covering any field added later.
   */
  test("a saturated sweep advances no counter and composes no coverage issue", async () => {
    const before = runway(DECLARED[2]);
    expect(before.notifications).toEqual([]);
    expect(before.records.get(DECLARED[2])!.consecutive_indeterminate).toBe(COVERAGE_THRESHOLD - 1);

    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0])] }),
      doc(healthyRows(DECLARED[0])),
    );
    const outcome = await saturationVerdict(assessment, ENDPOINT, stubProbe("timeout").probe);
    expect(outcome.verdict).toBe("saturated");

    const step = advanceAll(before.records, sweepObservations(assessment, outcome, CTX));
    expect(step.notifications).toEqual([]);
    for (const service of DECLARED) {
      expect(step.records.get(service)).toBe(before.records.get(service));
    }
  });

  /**
   * **The anti-fixture's other half**, and the reason the test above is not
   * satisfied by a machine that never escalates: the same runway plus a
   * TWO-artifact sweep does reach the threshold, on the third gap, as a coverage
   * issue.
   *
   * Only the blind service escalates. The two whose observers reported an
   * evidenced `healthy` clear instead, which is what makes this a fixture about
   * the correlation rather than about the machine being alive.
   */
  test("the two-of-three sweep DOES escalate, and only for the blind service", async () => {
    const before = runway(DECLARED[2]);
    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0]), artifact(OBS[1])] }),
      doc(healthyRows(DECLARED[0], DECLARED[1])),
    );
    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    expect(outcome.suppressed).toBe(false);

    const step = advanceAll(before.records, sweepObservations(assessment, outcome, CTX));
    expect(step.notifications).toHaveLength(1);
    expect(step.notifications[0]!.kind).toBe("opened");
    expect(step.notifications[0]!.reason).toBe("coverage");
    expect(step.notifications[0]!.subject).toEqual({
      kind: "service",
      environment: ENV,
      service: DECLARED[2],
    });
    expect(step.records.get(DECLARED[2])!.consecutive_indeterminate).toBe(COVERAGE_THRESHOLD);
  });

  /**
   * And the sweep AFTER a suppressed one escalates on the third real gap rather
   * than the second — the ordering's whole point, which a suppression that merely
   * skipped the notification would fail.
   */
  test("a suppressed sweep costs the escalation one cadence, and no more", async () => {
    const before = runway(DECLARED[2]);
    const saturated = assess(
      fullCoverage({ artifacts: [artifact(OBS[0])] }),
      doc(healthyRows(DECLARED[0])),
    );
    const suppressedOutcome = await saturationVerdict(
      saturated,
      ENDPOINT,
      stubProbe("timeout").probe,
    );
    const held = advanceAll(before.records, sweepObservations(saturated, suppressedOutcome, CTX));

    const real = assess(
      fullCoverage({ artifacts: [artifact(OBS[0]), artifact(OBS[1])] }),
      doc(healthyRows(DECLARED[0], DECLARED[1])),
    );
    const realOutcome = await saturationVerdict(real, ENDPOINT, NEVER);
    const step = advanceAll(held.records, sweepObservations(real, realOutcome, CTX));

    expect(step.notifications.map((n) => n.kind)).toEqual(["opened"]);
    expect(step.notifications[0]!.reason).toBe("coverage");
  });

  /**
   * **The suppression is uniform, and this is the fixture that says why.**
   *
   * A firing service whose observer WAS the one that got through, reporting a
   * fully evidenced `healthy` on a sweep the console has just declared it could
   * not see. Suppressing only the blind rows would let that recovery through — *"a
   * recovery notification for a service nobody could see"*, which §6.8 calls the
   * single most damaging message this console could send, composed here on one
   * third of the evidence.
   */
  test("a healthy row on a saturated sweep does NOT recover a firing service", async () => {
    // Drive DECLARED[0] to `firing` on two observed `unhealthy` sweeps.
    let records = new Map<string, IncidentRecord>();
    for (let n = 0; n < 2; n += 1) {
      const sick = assess(
        fullCoverage(),
        doc([
          row(DECLARED[0], { assessment: "unhealthy" }),
          ...healthyRows(DECLARED[1], DECLARED[2]),
        ]),
      );
      const outcome = await saturationVerdict(sick, ENDPOINT, NEVER);
      records = advanceAll(records, sweepObservations(sick, outcome, { ...CTX, at: AT + n })).records;
    }
    expect(records.get(DECLARED[0])!.state).toBe("firing");

    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0])] }),
      doc(healthyRows(DECLARED[0])),
    );
    // The premise: the row really is an accepted, evidenced `healthy`, so the
    // recovery is available to any implementation that reads the service row.
    expect(of(assessment, DECLARED[0]).assessment).toBe("healthy");
    expect(of(assessment, DECLARED[0]).gaps).toEqual([]);

    const outcome = await saturationVerdict(assessment, ENDPOINT, stubProbe("timeout").probe);
    const observations = sweepObservations(assessment, outcome, CTX);
    expect(observations.map((o) => o.signal.kind)).toEqual([
      "suppressed",
      "suppressed",
      "suppressed",
    ]);

    const step = advanceAll(records, observations);
    expect(step.notifications).toEqual([]);
    expect(step.records.get(DECLARED[0])).toBe(records.get(DECLARED[0]));
  });

  /**
   * An `endpoint_down` sweep suppresses too, and that is a decision rather than a
   * consequence.
   *
   * §6.7 rule 3's argument for the ordering — *"the operator reads the one that
   * names their cluster"* — is about the inference path being the fault, and the
   * probe has just said it is. What `endpoint_down` does NOT do is set
   * `saturated`: the sweep announces no saturation, because the endpoint is not
   * saturated, it is down.
   */
  test("an endpoint that is DOWN suppresses without claiming saturation", async () => {
    const before = runway(DECLARED[2]);
    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0])] }),
      doc(healthyRows(DECLARED[0])),
    );
    const outcome = await saturationVerdict(assessment, ENDPOINT, stubProbe("unreachable").probe);
    expect(outcome.verdict).toBe("endpoint_down");
    expect(outcome.saturated).toBeNull();

    const step = advanceAll(before.records, sweepObservations(assessment, outcome, CTX));
    expect(step.notifications).toEqual([]);
    expect(step.records.get(DECLARED[2])).toBe(before.records.get(DECLARED[2]));
  });

  /**
   * **The suppression cannot be skipped, because the verdict is a required
   * parameter.**
   *
   * `triage-partition.ts`'s move — *"ordering stopped being caller discipline"* —
   * and the arity is the assertion. A defaulted `saturation` would let task 6.1
   * build observations without ever computing a verdict, which is §13's *"reports
   * both findings and lets the operator pick the wrong one"* arriving through an
   * omitted argument.
   */
  test("there is no path to a service signal that skips the verdict", () => {
    expect(sweepObservations.length).toBe(3);
  });
});

describe("the unsuppressed mapping, and what §6.7 rule 2 has already done to it", () => {
  /**
   * All four assessments in ONE sweep and ONE value comparison, so a mapping that
   * returned the same signal twice reddens. Four services, four different
   * observers, four different answers.
   */
  test("healthy clears, degraded and unhealthy raise, indeterminate is blindness", async () => {
    const fourth = "obs-t4";
    const assessment = assess(
      fullCoverage({
        declared: [...DECLARED, "ingest"],
        assignments: [
          assign(OBS[0], DECLARED[0]),
          assign(OBS[1], DECLARED[1]),
          assign(OBS[2], DECLARED[2]),
          assign(fourth, "ingest"),
        ],
        artifacts: [artifact(OBS[0]), artifact(OBS[1]), artifact(OBS[2]), artifact(fourth)],
      }),
      doc([
        row(DECLARED[0], { assessment: "healthy" }),
        row(DECLARED[1], { assessment: "degraded" }),
        row(DECLARED[2], { assessment: "unhealthy" }),
        // No row for `ingest`: `unreported`, hence `indeterminate`.
      ]),
    );
    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    expect(outcome.suppressed).toBe(false);

    expect(sweepObservations(assessment, outcome, CTX)).toEqual([
      {
        subject: { kind: "service", environment: ENV, service: DECLARED[0] },
        sweepId: SWEEP,
        at: AT,
        signal: { kind: "observed_clear", evidenceRef: EVIDENCE },
      },
      {
        subject: { kind: "service", environment: ENV, service: DECLARED[1] },
        sweepId: SWEEP,
        at: AT,
        signal: { kind: "issue", reason: "degraded", evidenceRef: EVIDENCE },
      },
      {
        subject: { kind: "service", environment: ENV, service: DECLARED[2] },
        sweepId: SWEEP,
        at: AT,
        signal: { kind: "issue", reason: "unhealthy", evidenceRef: EVIDENCE },
      },
      {
        subject: { kind: "service", environment: ENV, service: "ingest" },
        sweepId: SWEEP,
        at: AT,
        signal: { kind: "unobserved" },
      },
    ]);
  });

  /**
   * §6.7 rule 2 composes with this and needs no code here: an unevidenced
   * `healthy` has already been downgraded to `indeterminate` by the time a signal
   * is built, so it arrives as `unobserved` and cannot clear anything.
   *
   * The premise names the gate that did it, so a fixture that stopped tripping the
   * gate would redden rather than quietly assert the trivial case.
   */
  test("an unevidenced `healthy` reaches the machine as blindness, never as a clear", async () => {
    const assessment = assess(
      fullCoverage(),
      doc([
        row(DECLARED[0], { assessment: "healthy", evidence_ref: [] }),
        ...healthyRows(DECLARED[1], DECLARED[2]),
      ]),
    );
    expect(of(assessment, DECLARED[0]).reason).toBe("unevidenced_healthy");
    expect(of(assessment, DECLARED[0]).claimed).toBe("healthy");

    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    const observations = sweepObservations(assessment, outcome, CTX);
    expect(observations[0]!.signal).toEqual({ kind: "unobserved" });
    expect(observations[1]!.signal).toEqual({ kind: "observed_clear", evidenceRef: EVIDENCE });
  });

  /** The sweep id on every observation is the HOST's, carried from the assessment. */
  test("every observation carries the dispatched sweep id", async () => {
    const assessment = assess(fullCoverage(), doc(healthyRows(...DECLARED)));
    const outcome = await saturationVerdict(assessment, ENDPOINT, NEVER);
    const ids = new Set(sweepObservations(assessment, outcome, CTX).map((o) => o.sweepId));
    expect([...ids]).toEqual([SWEEP]);
  });
});

describe("ISC-681's naming, from the verdict's side", () => {
  /**
   * The premise, one step earlier and in its own test: the tokens this criterion
   * is about are pairwise distinct and non-substring, so a swap cannot pass by
   * coincidence. ISC-681 records the same guard on the composed title.
   */
  test("provider, model and environment share no substring", () => {
    const tokens = [ENDPOINT.provider, ENDPOINT.model, ENV];
    for (const a of tokens) {
      for (const b of tokens) {
        if (a === b) continue;
        expect(a).not.toContain(b);
      }
    }
  });

  /**
   * *"§6.7 rule 3's announcement names the PROVIDER as its subject and the
   * environment only as scope."* The verdict is upstream of the composer, so what
   * it owes that sentence is a `subject` that already IS the provider/model pair —
   * asserted by full value, because a subject that merely CONTAINED the provider
   * would be satisfied by a string that also contained the environment.
   */
  test("the outcome's subject is the provider and model, and never the environment", async () => {
    const assessment = assess(
      fullCoverage({ artifacts: [artifact(OBS[0])] }),
      doc(healthyRows(DECLARED[0])),
    );
    const outcome = await saturationVerdict(assessment, ENDPOINT, stubProbe("timeout").probe);

    expect(outcome.subject).toBe("omlx/gpt-oss-20b-MXFP4-Q8");
    expect(outcome.subject).toBe(inferenceSubject(ENDPOINT));
    expect(outcome.subject).not.toContain(ENV);
  });

  /** The join has one home, and the halves cannot be swapped in one place only. */
  test("the subject joins provider then model, in that order", () => {
    expect(inferenceSubject({ provider: "left", model: "right" })).toBe("left/right");
  });

  /**
   * The subject is on EVERY outcome, not only the saturated one — a `--status`
   * line or a log entry about an `endpoint_down` names the same endpoint, and a
   * field populated only on the announcing path is a field the other paths would
   * have to re-derive.
   */
  test("every verdict carries the subject", async () => {
    const outcome = await saturationVerdict(
      assess(fullCoverage(), doc(healthyRows(...DECLARED))),
      ENDPOINT,
      NEVER,
    );
    expect(outcome.subject).toBe(inferenceSubject(ENDPOINT));
  });
});
