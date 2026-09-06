/**
 * The verdict mapping and the freshness echo — SRD-TRIAGE-CONSOLE §6.6 layer 3,
 * §6.7 rules 1-2, §7.4, §7.5; §13 tasks 5.2 and 5.3.
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

import type { PartitionAssignment } from "../../src/run/triage-partition.ts";
import {
  ASSESSMENT_REASONS,
  assessTriageSweep,
  COVERAGE_RESULTS,
  EVIDENCE_GAPS,
  evidenceGaps,
  OBSERVER_ASSESSMENTS,
  sweepIdEcho,
  type CoverageEntry,
  type CoverageResult,
  type ObserverArtifact,
  type ObserverAssessment,
  type SweepCoverage,
  type TriageDocument,
  type TriageRow,
} from "../../src/run/triage-verdict.ts";

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

function artifact(worker: string, sweep_id: string | null = SWEEP): ObserverArtifact {
  return { worker, sweep_id };
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
   * The three lists PARTITION the dispatched set.
   *
   * `observers_total = reported + missing + stale` is what makes the census
   * readable as a denominator (§7.5, `CollationCensus`'s *"A count of readers who
   * agreed is not `3/3` without it"*). A seat that fell out of all three — an
   * observer counted as neither reporting, missing nor stale — would make the
   * arithmetic silently wrong, and every individual list assertion above would
   * still pass.
   */
  test("every dispatched observer lands in exactly one of reported, missing, stale", () => {
    const result = assessTriageSweep(
      SWEEP,
      fullCoverage({
        artifacts: [artifact(OBS[1]), artifact(OBS[2], PREVIOUS), artifact("obs-x")],
      }),
      doc([]),
    );

    const { observers_total, observers_reported, observers_missing, observers_stale } =
      result.census;
    expect(observers_total).toBe(3);
    expect(observers_reported + observers_missing.length + observers_stale.length).toBe(
      observers_total,
    );
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

  test("ASSESSMENT_REASONS is closed at seven", () => {
    expect([...ASSESSMENT_REASONS]).toEqual([
      "observed",
      "unevidenced_healthy",
      "stale_replay",
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
