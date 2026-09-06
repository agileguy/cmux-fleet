/**
 * The partition completeness check — SRD-TRIAGE-CONSOLE §6.5, D6; §13 task 5.1.
 *
 * §6.5 splits the work in two: *"The partition is the triage worker's to make"*,
 * because it is a judgement, and *"the completeness check is the host's"*,
 * because *"a model that partitions can drop a service and nothing downstream
 * would notice: two clean reports and a missing third reads exactly like a clean
 * sweep."* This file grades the host's half.
 *
 * ## Every fixture here is ASYMMETRIC, and that is the whole point
 *
 * A completeness check is a set comparison, and this repository's MEMORY carries
 * the defect that makes a set comparison untestable: *"a filter or intersection
 * survives mutation whenever every fixture makes the two sets equal"*. It has
 * cost this branch real cycles twice, and `triage-targets.test.ts` opens with the
 * same warning about §6.10's kubeconfig fence.
 *
 * So the load-bearing fixture below names three declared services against a
 * partition claiming three, and the sets OVERLAP WITHOUT EITHER CONTAINING THE
 * OTHER:
 *
 *     declared by targets.yaml : {mia, authorization, authentication}
 *     claimed by the partition : {authorization, authentication, ingest}
 *
 * That one fixture separates five implementations at once:
 *
 *  - a check that always passes → RED, `mia` goes unmentioned;
 *  - a check that always refuses → RED, because the missing service is asserted
 *    BY NAME and never by count — "one refusal" is reachable by refusing the
 *    wrong element, which is the failure mode a count assertion cannot see;
 *  - a check comparing SIZES sees 3 against 3 and passes → RED;
 *  - a check asking only `claimed ⊆ declared` finds `ingest` and never looks for
 *    `mia` → RED on the missing half;
 *  - a check asking only `declared ⊆ claimed` finds `mia` and never looks for
 *    `ingest` → RED on the undeclared half.
 *
 * ## The two arms are DISTINGUISHED, never collapsed into "not equal"
 *
 * §6.5 makes `partition_incomplete` and `partition_duplicate` different failures
 * with different operator responses — *"a service nobody looked at, versus a
 * service two observers both claimed"* — so a check answering "these sets differ"
 * with one code would satisfy a naive test while destroying the only information
 * the two codes carry. Each arm is therefore asserted on its own code AND on the
 * named member that produced it, and the precedence between them is asserted on a
 * fixture where BOTH hold.
 *
 * ## Nothing is dispatched on a refusal, and it is asserted rather than reasoned
 *
 * §12: *"assert `partition_incomplete` and that **nothing was dispatched**"* —
 * and the second clause is the load-bearing half, because a check that refuses
 * after dispatching is worse than no check: it reports a failed sweep while three
 * observers are already running against a live control plane. `dispatchPartition`
 * takes the dispatch effect as an argument and every refusal fixture asserts the
 * spy recorded ZERO calls. A pure `checkTriagePartition` alone could not express
 * that, because ordering would then be the caller's discipline rather than a
 * property of the code.
 *
 * Phase 5 *"touches no container and no network"*, and this file honours that: the
 * dispatch effect is a spy over an array, and no fixture reads a cluster, a run
 * tree or a file.
 *
 * ## What is deliberately NOT asserted, stated so the silence is not read as coverage
 *
 * **The `reason` strings.** A mutation inverting the singular/plural helper
 * survives this whole file, and that is the intended outcome rather than a gap:
 * `dispatch-request.ts:695-707` fixes the rule — the code is the assertion
 * surface and `reason` is the explanation, because *"a caller — or a test — that
 * had to tell those apart by matching substrings of English would be pinning a
 * sentence rather than a rule, and the sentence is the part that gets
 * rewritten."* The structured `missing` / `duplicated` / `undeclared` lists exist
 * precisely so nothing here has to read the prose, and they are asserted by name
 * throughout.
 */

import { describe, expect, test } from "bun:test";

import {
  checkTriagePartition,
  dispatchPartition,
  type PartitionAssignment,
} from "../../src/run/triage-partition.ts";

/**
 * The environment as `triage/targets.yaml` declares it.
 *
 * Three real service names from the SRD's own examples (§6.2), because a fixture
 * spelled `a`/`b`/`c` makes an order-dependent bug read as an alphabetisation
 * bug. `MAX_SERVICES_PER_ENVIRONMENT` is 64 and the schema's `.min(1)` means this
 * list is never empty in production — see the vacuous-completeness test for why
 * that matters here.
 */
const DECLARED = ["mia", "authorization", "authentication"] as const;

/** `TRIAGE_CONSOLE_ROSTER.reviewers`, spelled out so a roster edit is visible. */
const OBS = ["obs-t1", "obs-t2", "obs-t3"] as const;

function assign(worker: string, ...services: string[]): PartitionAssignment {
  return { worker, services };
}

/**
 * A dispatch effect that records rather than performs.
 *
 * Returns the worker id so the positive control can assert that the results come
 * back in assignment order — a gate that dispatched everything but returned
 * nothing would otherwise pass every test in this file.
 */
function spy(): {
  dispatch: (a: PartitionAssignment) => Promise<string>;
  calls: PartitionAssignment[];
} {
  const calls: PartitionAssignment[] = [];
  return {
    calls,
    dispatch: async (a: PartitionAssignment) => {
      calls.push(a);
      return a.worker;
    },
  };
}

describe("the positive control — a partition that covers the environment exactly once", () => {
  /**
   * FIRST, and the file does not mean anything without it.
   *
   * Every other test here asserts a refusal, and a check that refused
   * unconditionally would satisfy all of them while being a console that sweeps
   * nothing 288 times a day and reports a partition error every five minutes.
   * `review-console-relay.test.ts` opens on the same principle for the adoption
   * guard: *"The first assertion in that block is therefore the ACCEPTING one."*
   */
  test("is complete, and dispatches every assignment in order", async () => {
    const { dispatch, calls } = spy();
    const partition = [
      assign(OBS[0], "mia"),
      assign(OBS[1], "authorization"),
      assign(OBS[2], "authentication"),
    ];

    const outcome = await dispatchPartition(DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") return;
    expect(outcome.results).toEqual([...OBS]);
    expect(calls.map((c) => c.worker)).toEqual([...OBS]);
  });

  /**
   * §6.5's `1 ≤ N < 3` row: *"An idle observer is not an error"* — the same
   * posture as SRD-FLEET-PM-001 D4, *"idle seats over a wrong answer"*.
   *
   * Two observers covering three services is a legal partition, and a check that
   * required one assignment per seat would refuse the ordinary small environment.
   * Whether an observer with nothing to look at should be handed a request at all
   * is the actor's question (§6.3 step 5), not this check's: an assignment
   * claiming no services claims nothing, and claiming nothing cannot make a
   * partition incomplete.
   */
  test("a lopsided partition and an idle observer are both legal", async () => {
    const { dispatch, calls } = spy();
    const partition = [
      assign(OBS[0], "mia", "authorization"),
      assign(OBS[1], "authentication"),
      assign(OBS[2]),
    ];

    const outcome = await dispatchPartition(DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("dispatched");
    expect(calls).toHaveLength(3);
  });

  /**
   * THE FAN-OUT IS SERIAL, AND THIS IS WHAT SAYS SO.
   *
   * **Added because a mutation survived.** `dispatchPartition`'s docblock argues
   * that `Promise.all` would be wrong here — it invokes every dispatch before the
   * first rejection can stop the rest — and swapping the serial loop for
   * `Promise.all(assignments.map(dispatch))` passed every other test in this
   * file. A decision defended only in prose is a decision the next reader may
   * reverse for the usual good reason ("these are independent, parallelise
   * them"), and the suite would have agreed with them.
   *
   * The property is the one §6.5 cares about everywhere else: a fan-out that
   * fails partway must not have started the observers it had not reached, because
   * a half-dispatched sweep is three observer passes the join will wait on and a
   * sweep that reports a failure it did not cleanly cause.
   */
  test("a dispatch that throws stops the fan-out where it failed", async () => {
    const calls: string[] = [];
    const partition = [
      assign(OBS[0], "mia"),
      assign(OBS[1], "authorization"),
      assign(OBS[2], "authentication"),
    ];

    const dispatch = async (a: PartitionAssignment): Promise<string> => {
      calls.push(a.worker);
      throw new Error(`dispatch refused for ${a.worker}`);
    };

    await expect(dispatchPartition(DECLARED, partition, dispatch)).rejects.toThrow(
      "dispatch refused for obs-t1",
    );
    // BY NAME, and exactly one: `Promise.all` records all three here.
    expect(calls).toEqual([OBS[0]]);
  });
});

describe("the incomplete arm — a service in the environment appears in no request", () => {
  /**
   * §12's own probe, verbatim: *"a fixture request naming two of three services;
   * assert `partition_incomplete` and that **nothing was dispatched**."*
   */
  test("two of three services is refused whole, and NOTHING is dispatched", async () => {
    const { dispatch, calls } = spy();
    const partition = [assign(OBS[0], "mia"), assign(OBS[1], "authorization")];

    const outcome = await dispatchPartition(DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    // BY NAME. A count assertion passes when the wrong service is reported.
    expect(outcome.missing).toEqual(["authentication"]);
    expect(calls).toEqual([]);
  });

  /**
   * THE ASYMMETRIC FIXTURE — the one the header block is about.
   *
   * declared {mia, authorization, authentication} against claimed
   * {authorization, authentication, ingest}. Neither set contains the other and
   * both have three members, so a size comparison and both single-direction
   * subset checks pass or half-pass. Both halves are asserted by name.
   *
   * `ingest` is a service the worker invented — a name `targets.yaml` never
   * declared, which therefore has no namespace, no `checks[]` and no window
   * (§6.2 rule 2, *"DECLARED, never derived"*), so no brief can even be rendered
   * for it. See the module docblock for why it spends `partition_incomplete`
   * rather than a code of its own.
   */
  test("overlapping sets with neither containing the other: both halves, by name", async () => {
    const { dispatch, calls } = spy();
    const partition = [
      assign(OBS[0], "authorization"),
      assign(OBS[1], "authentication", "ingest"),
    ];

    const outcome = await dispatchPartition(DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.missing).toEqual(["mia"]);
    expect(outcome.undeclared).toEqual(["ingest"]);
    expect(outcome.duplicated).toEqual([]);
    expect(calls).toEqual([]);
  });

  /**
   * The undeclared half ALONE, because the fixture above could be satisfied by an
   * implementation that only ever looks for missing services and happens to
   * report `undeclared` as a side effect of something else.
   *
   * Here every declared service is claimed exactly once and the partition is
   * still refused, so `missing` is empty and the refusal rests entirely on
   * `ingest`. An implementation checking only `declared ⊆ claimed` is GREEN on
   * every other fixture in this file and RED here.
   */
  test("a full cover plus one invented service is still refused", async () => {
    const { dispatch, calls } = spy();
    const partition = [
      assign(OBS[0], "mia", "ingest"),
      assign(OBS[1], "authorization"),
      assign(OBS[2], "authentication"),
    ];

    const outcome = await dispatchPartition(DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.missing).toEqual([]);
    expect(outcome.undeclared).toEqual(["ingest"]);
    expect(calls).toEqual([]);
  });

  /** Declared order, not claim order — the operator reads the file, not the request. */
  test("missing services are reported in the order targets.yaml declares them", async () => {
    const outcome = checkTriagePartition(DECLARED, [assign(OBS[0], "authorization")]);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.missing).toEqual(["mia", "authentication"]);
  });

  /**
   * TWO undeclared services, because one cannot have an order.
   *
   * **Added because a mutation survived.** Every undeclared fixture above names a
   * single service, and a single-element list is order-invariant — so appending
   * `.reverse()` to the `undeclared` computation passed the whole file. That is
   * the degenerate-fixture defect this file's header warns about, in miniature
   * and in my own fixtures: a list whose order is claimed in prose and whose every
   * fixture has one element is a claim with no probe.
   */
  test("undeclared services are reported in the order the partition claims them", () => {
    const partition = [
      assign(OBS[0], "ingest", "routing"),
      assign(OBS[1], "mia", "authorization"),
      assign(OBS[2], "authentication"),
    ];

    const outcome = checkTriagePartition(DECLARED, partition);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.undeclared).toEqual(["ingest", "routing"]);
    expect(outcome.missing).toEqual([]);
  });
});

describe("the duplicate arm — a service appears in more than one request", () => {
  /**
   * The duplicate arm on its own code, with NOTHING missing.
   *
   * This is the fixture that stops the two arms collapsing into "not equal": the
   * declared set is fully covered, so an implementation testing set equality of
   * DISTINCT members sees {mia, authorization, authentication} on both sides and
   * returns complete. The multiplicity is the only signal, and `mia` is named.
   */
  test("a service claimed by two observers is partition_duplicate, and nothing is dispatched", async () => {
    const { dispatch, calls } = spy();
    const partition = [
      assign(OBS[0], "mia", "authorization"),
      assign(OBS[1], "authentication"),
      assign(OBS[2], "mia"),
    ];

    const outcome = await dispatchPartition(DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["mia"]);
    expect(outcome.missing).toEqual([]);
    expect(calls).toEqual([]);
  });

  /**
   * The same service twice inside ONE assignment.
   *
   * An implementation that de-duplicates each worker's list into a `Set` before
   * counting — the obvious way to write this, and how `consoleRunPins` builds its
   * holders — is GREEN on the fixture above and RED here. §6.10 rule 1 already
   * refuses a duplicated CHECK on read-amplification grounds (*"every check is a
   * read against a live control plane on every sweep"*); a duplicated service in
   * one brief is the same waste one level up.
   */
  test("a service listed twice by the SAME observer is a duplicate too", async () => {
    const { dispatch, calls } = spy();
    const partition = [
      assign(OBS[0], "mia", "mia"),
      assign(OBS[1], "authorization"),
      assign(OBS[2], "authentication"),
    ];

    const outcome = await dispatchPartition(DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["mia"]);
    expect(calls).toEqual([]);
  });

  /**
   * TWO duplicated services, for the reason the undeclared block above gives.
   *
   * **Added because a mutation survived.** Reversing `duplicated` passed every
   * fixture, because each named exactly one service. Claim order is what the
   * docblock promises — first mention is where the author looks — so it is
   * asserted on a fixture that can tell the two orders apart.
   *
   * `authorization` is claimed before `mia` here and is therefore reported first,
   * even though `mia` comes first in the DECLARED list. That is the distinction
   * between the two orderings this module keeps: `missing` follows the file,
   * `duplicated` and `undeclared` follow the request.
   */
  test("duplicated services are reported in the order the partition claims them", () => {
    const partition = [
      assign(OBS[0], "authorization", "mia"),
      assign(OBS[1], "mia", "authorization"),
      assign(OBS[2], "authentication"),
    ];

    const outcome = checkTriagePartition(DECLARED, partition);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["authorization", "mia"]);
  });
});

describe("precedence, when both faults hold at once", () => {
  /**
   * The duplicate is the CAUSE and the gap is usually its SYMPTOM, so the code
   * names the cause.
   *
   * With width fixed at three (§6.5), an observer claiming a service that another
   * already claimed is an observer NOT claiming something else — which is the
   * reasoning `dispatch-request.test.ts` already records for `duplicate_target`:
   * *"a partition that names one observer twice is a LOST SERVICE — the third
   * observer is never asked."* Reporting `partition_incomplete` here would send
   * the operator to look at `authorization` and `authentication`, neither of which
   * is the mistake.
   *
   * **The precedence costs no information, and that is asserted rather than
   * claimed**: `missing` still names both dropped services on the refusal that
   * reports the duplicate.
   */
  test("partition_duplicate wins the code, and missing[] still names both gaps", async () => {
    const { dispatch, calls } = spy();
    const partition = [assign(OBS[0], "mia"), assign(OBS[1], "mia")];

    const outcome = await dispatchPartition(DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["mia"]);
    expect(outcome.missing).toEqual(["authorization", "authentication"]);
    expect(calls).toEqual([]);
  });
});

describe("what this check does NOT answer", () => {
  /**
   * §6.5's `N = 0` row: *"a targets file with an empty environment is refused at
   * load, not at dispatch"* — `TriageEnvironmentSchema`'s `services.min(1)`.
   *
   * So an empty declared set is unreachable from a validated targets file, and
   * this check treats it as vacuously complete rather than growing a second
   * refusal for a state the loader already forbids. Asserted so the behaviour is
   * a decision on the record rather than an accident of the loop bounds.
   */
  test("an empty environment is vacuously complete — the loader refuses it, not this", () => {
    expect(checkTriagePartition([], []).kind).toBe("complete");
  });

  /**
   * A repeated WORKER is `duplicate_target`'s question, answered in the request
   * plane before this check ever runs (§12: *"the existing `duplicate_target`
   * code, driven through the triage roster"*).
   *
   * This check is about SERVICES, so a partition that names one observer twice
   * while covering the environment exactly once passes HERE. That is the layering
   * working, not a hole: `parseDispatchRequest` has already refused the document.
   * The test exists so a future edit that duplicates the worker check in this
   * module reddens — two modules answering one question is how the two disagree.
   */
  test("a repeated worker is not this module's refusal", () => {
    const partition = [
      assign(OBS[0], "mia"),
      assign(OBS[0], "authorization"),
      assign(OBS[1], "authentication"),
    ];

    expect(checkTriagePartition(DECLARED, partition).kind).toBe("complete");
  });
});
