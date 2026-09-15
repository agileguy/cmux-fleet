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
  DISPATCH_REQUEST_SCHEMA,
  TRIAGE_CONSOLE_ROSTER,
  parseDispatchRequest,
  type DispatchRequestItem,
} from "../../src/run/dispatch-request.ts";
import {
  checkTriagePartition,
  dispatchPartition,
  evenSlices,
  partitionFromRequests,
  type DeclaredKindGroup,
  type PartitionAssignment,
} from "../../src/run/triage-partition.ts";
import { parseTriageTargets } from "../../src/run/triage-targets.ts";

/**
 * The environment THIS SUITE declares — its own, not the operator's.
 *
 * Three real service names from the SRD's own examples (§6.2), because a fixture
 * spelled `a`/`b`/`c` makes an order-dependent bug read as an alphabetisation
 * bug. `MAX_SERVICES_PER_ENVIRONMENT` is 16 and the schema's `.min(1)` means this
 * list is never empty in production — see the vacuous-completeness test for why
 * that matters here.
 *
 * **THREE IS LOAD-BEARING, and it is why this no longer tracks the operator's
 * file.** Every fixture below is a MINIMAL adversarial construction, several of
 * them recording the exact mutation they were added to kill: the order test
 * needs exactly two missing names, because "a single-element list is
 * order-invariant, so appending `.reverse()` passed the whole file"; the
 * contiguity test separates a contiguous split from a round-robin one only
 * because 3 splits 2/1. Growing this list to whatever `triage/targets.yaml`
 * happens to declare would bury each two-name claim inside a longer one and
 * make a `.reverse()` mutation HARDER to catch, not easier.
 */
const DECLARED = ["ntfy", "prometheus", "grafana"] as const;

/**
 * `DECLARED`, grouped by kind for {@link dispatchPartition} — SRD-TRIAGE-MIXED-
 * OBSERVERS §5, D8; Phase 4 task 4.1. Every fixture above this point in the
 * file (and most below it) partitions with `OBS` (`obs-t1`/`obs-t2`), both k8s
 * seats (`TRIAGE_SEAT_KINDS`), so wrapping `DECLARED` as the single k8s group
 * reproduces exactly the one-kind console this suite predates.
 */
const K8S_DECLARED: readonly DeclaredKindGroup[] = [{ kind: "k8s", services: DECLARED }];

/**
 * `DECLARED` as a targets document — the fixture the pin at the end parses.
 *
 * Inline rather than a file under `test/fixtures/`, following
 * `triage-targets.test.ts`'s `GOOD_YAML`: the suite most about this schema reads
 * no file at all and passes a PATH STRING to `parseTriageTargets` purely so a
 * refusal carries a name. The path spelled here is that label, not a read.
 */
const FIXTURE_TARGETS = `
version: 1
environments:
  do-cluster:
    kube_context: do-cluster
    default_window: 5m
    services:
      - {name: ntfy,       namespace: ntfy,       checks: [rollout, logs]}
      - {name: prometheus, namespace: monitoring, checks: [rollout, logs]}
      - {name: grafana,    namespace: monitoring, checks: [rollout, logs]}
`;

/**
 * `TRIAGE_CONSOLE_ROSTER.reviewers`, spelled out so a roster edit is visible.
 *
 * **It went to two on 2026-09-12 and this fixture is why the change was noticed.**
 * The console grew a second pair, and the four assertions that compared a
 * ONE-assignment partition against `[...OBS]` reddened immediately. Widening this
 * back to a single id would have made them green again and disabled the tripwire
 * the comment above promises, so the assertions were corrected instead: they name
 * the worker the partition actually dispatched to.
 *
 * Most tests here still build single-observer partitions deliberately. That is a
 * legal partition, not an oversight — see *"a lopsided partition and an idle
 * observer are both legal"* below.
 */
const OBS = ["obs-t1", "obs-t2"] as const;

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
    // ONE observer, so the complete partition is one assignment covering the
    // whole environment.
    const partition = [assign(OBS[0], "ntfy", "prometheus", "grafana")];

    const outcome = await dispatchPartition(K8S_DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") return;
    expect(outcome.results).toEqual([OBS[0]]);
    expect(calls.map((c) => c.worker)).toEqual([OBS[0]]);
  });

  /**
   * §6.5's `1 ≤ N < 3` row: *"An idle observer is not an error"* — the same
   * posture as SRD-FLEET-PM-001 D4, *"idle seats over a wrong answer"*.
   *
   * Three assignments on the one observer, one of them idle, is a legal
   * partition, and a check that required exactly one assignment per seat would
   * refuse the ordinary small environment. Whether an observer with nothing to
   * look at should be handed a request at all is the actor's question (§6.3
   * step 5), not this check's: an assignment claiming no services claims
   * nothing, and claiming nothing cannot make a partition incomplete.
   */
  test("a lopsided partition and an idle observer are both legal", async () => {
    const { dispatch, calls } = spy();
    const partition = [
      assign(OBS[0], "ntfy", "prometheus"),
      assign(OBS[0], "grafana"),
      assign(OBS[0]),
    ];

    const outcome = await dispatchPartition(K8S_DECLARED, partition, dispatch);

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
  /*
   * **REVERSED 2026-09-07, by the first live console rather than by an argument.**
   *
   * This test used to assert the opposite — that a throw stopped the fan-out where
   * it failed, and that `Promise.all` "would be wrong here". That reasoning rested
   * on a premise that was true when it was written and is not true now: it assumed
   * a dispatch RETURNS once the child accepts. It does not. `SweepDispatch`
   * "returns when the task has SETTLED, not when it was accepted", so a serial
   * loop does not merely order three dispatches — it runs three observer TASKS end
   * to end against one `sweep_deadline_s`.
   *
   * Measured, not reasoned: on the first live sweep `obs-t1` received its slice and
   * `obs-t2`/`obs-t3` received nothing before the pass ended. The console then
   * reported two services it could not see, against a cluster that was healthy and
   * reachable — the §6.10 misdiagnosis this design fears most, produced by the
   * guard that was meant to prevent a half-dispatched sweep.
   *
   * The old property is genuinely lost and it is worth naming: a failing fan-out
   * now leaves the other observers RUNNING rather than unstarted. That is the trade
   * the review console already made in the same words — *"a dispatch that does not
   * land costs its own lens and nothing else"* — and a slice that runs and is
   * joined is strictly better than a slice that was never attempted, because the
   * join reports the missing one as coverage either way.
   */
  test("a throw fails the pass, and every slice was still ISSUED", async () => {
    const calls: string[] = [];
    // COVERAGE DROPPED 2026-09-07 with the move to one observer: this used to
    // prove that a failing slice does not prevent the OTHER seats being reached,
    // which is the whole reason the fan-out is concurrent. With one seat there is
    // no other to reach, so what survives here is only that the throw propagates.
    const partition = [assign(OBS[0], "ntfy", "prometheus", "grafana")];

    const dispatch = async (a: PartitionAssignment): Promise<string> => {
      calls.push(a.worker);
      throw new Error(`dispatch refused for ${a.worker}`);
    };

    await expect(dispatchPartition(K8S_DECLARED, partition, dispatch)).rejects.toThrow(
      "dispatch refused for obs-t1",
    );
    /*
     * ALL THREE, asserted by name and sorted: the failure is still surfaced — the
     * rejection above is the half that has not changed — but the two slices that
     * could have run were reached. A serial loop records exactly one here, which is
     * what made this the coverage bug rather than a throughput one.
     */
    expect([...calls].sort()).toEqual([OBS[0]].sort());
  });
});

describe("the incomplete arm — a service in the environment appears in no request", () => {
  /**
   * §12's own probe, verbatim: *"a fixture request naming two of three services;
   * assert `partition_incomplete` and that **nothing was dispatched**."*
   */
  test("two of three services is refused whole, and NOTHING is dispatched", async () => {
    const { dispatch, calls } = spy();
    const partition = [assign(OBS[0], "ntfy"), assign(OBS[0], "prometheus")];

    const outcome = await dispatchPartition(K8S_DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    // BY NAME. A count assertion passes when the wrong service is reported.
    expect(outcome.missing).toEqual(["grafana"]);
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
      assign(OBS[0], "prometheus"),
      assign(OBS[0], "grafana", "ingest"),
    ];

    const outcome = await dispatchPartition(K8S_DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.missing).toEqual(["ntfy"]);
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
      assign(OBS[0], "ntfy", "ingest"),
      assign(OBS[0], "prometheus"),
      assign(OBS[0], "grafana"),
    ];

    const outcome = await dispatchPartition(K8S_DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.missing).toEqual([]);
    expect(outcome.undeclared).toEqual(["ingest"]);
    expect(calls).toEqual([]);
  });

  /** Declared order, not claim order — the operator reads the file, not the request. */
  test("missing services are reported in the order targets.yaml declares them", async () => {
    const outcome = checkTriagePartition(DECLARED, [assign(OBS[0], "prometheus")]);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.missing).toEqual(["ntfy", "grafana"]);
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
      assign(OBS[0], "ntfy", "prometheus"),
      assign(OBS[0], "grafana"),
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
  test("a service claimed twice is partition_duplicate, and nothing is dispatched", async () => {
    const { dispatch, calls } = spy();
    const partition = [
      assign(OBS[0], "ntfy", "prometheus"),
      assign(OBS[0], "grafana"),
      assign(OBS[0], "ntfy"),
    ];

    const outcome = await dispatchPartition(K8S_DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["ntfy"]);
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
      assign(OBS[0], "ntfy", "ntfy"),
      assign(OBS[0], "prometheus"),
      assign(OBS[0], "grafana"),
    ];

    const outcome = await dispatchPartition(K8S_DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["ntfy"]);
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
      assign(OBS[0], "prometheus", "ntfy"),
      assign(OBS[0], "ntfy", "prometheus"),
      assign(OBS[0], "grafana"),
    ];

    const outcome = checkTriagePartition(DECLARED, partition);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["prometheus", "ntfy"]);
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
   * *"a partition that names one observer twice is a LOST SERVICE — it was a
   * third observer that went unasked back when this console still ran three."*
   * Reporting `partition_incomplete` here would send the operator to look at
   * `authorization` and `authentication`, neither of which is the mistake.
   *
   * **The precedence costs no information, and that is asserted rather than
   * claimed**: `missing` still names both dropped services on the refusal that
   * reports the duplicate.
   */
  test("partition_duplicate wins the code, and missing[] still names both gaps", async () => {
    const { dispatch, calls } = spy();
    // Both claims are on the one seat now — the duplicate still wins the code and
    // `missing` still names both gaps, which is what this test is about.
    const partition = [assign(OBS[0], "ntfy"), assign(OBS[0], "ntfy")];

    const outcome = await dispatchPartition(K8S_DECLARED, partition, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["ntfy"]);
    expect(outcome.missing).toEqual(["prometheus", "grafana"]);
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
      assign(OBS[0], "ntfy"),
      assign(OBS[0], "prometheus"),
      assign(OBS[0], "grafana"),
    ];

    expect(checkTriagePartition(DECLARED, partition).kind).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// SRD-TRIAGE-CONSOLE §7.3 (RESOLVED 2026-09-06, arm 1); §13 task 5.1a — the
// projection that turns a sweep's requests into the value above.
//
// The gap §7.3 closed was never in `checkTriagePartition`; it was that nothing
// could HAND it a partition. `pifleet.dispatchrequest/v1` carried no
// machine-readable service list, so the only way to recover which services a
// request covered was to parse the brief's prose — *"the one thing a check
// against a partitioning model must not depend on."* Arm 1 put `services` on
// the request; this block grades the projection between the two.
//
// **The projection is the load-bearing half and it is one `.map()`, which is
// exactly why it needs sharp fixtures.** Every property `checkTriagePartition`
// promises downstream is a property the projection can silently destroy:
//
//  - SORT the names and `duplicated`/`undeclared` stop being in claim order,
//    which is the order the docblock promises and two tests above assert;
//  - DEDUPE within a share and "a service listed twice by the SAME observer"
//    becomes complete — the fixture at line ~362 goes green for the wrong
//    reason and §6.10 rule 1's read amplification is back;
//  - DROP the empty shares and §6.5's idle observer stops being dispatched;
//  - REORDER the workers and a serial fan-out starts somewhere else.
//
// So the fixture below is asymmetric in all four directions at once, and every
// assertion is by VALUE rather than by count.
// ---------------------------------------------------------------------------

/** A request entry as `parseDispatchRequest` yields it, built without one. */
function req(worker: string, services?: readonly string[]): DispatchRequestItem {
  return {
    worker,
    title: `sweep ${worker}`,
    brief: "observe the declared services and report per service.",
    ...(services === undefined ? {} : { services: [...services] }),
  } as DispatchRequestItem;
}

/** `tri-1`'s fan-out on the wire, so a test can drive the REAL parser. */
function fanOutBody(taskId: string, entries: readonly DispatchRequestItem[]): string {
  return JSON.stringify({
    schema: DISPATCH_REQUEST_SCHEMA,
    parent_task_id: taskId,
    requests: entries,
  });
}

const SWEEP = "T-sweep-288";

describe("the projection — a sweep's requests become the partition value", () => {
  /**
   * ONE FIXTURE, FOUR MUTANTS, and every assertion is by value.
   *
   * `routing` before `ingest` is not alphabetical, so a sort is red. `mia`
   * twice in one share is red under a `Set`. `obs-t2`'s empty share is red under
   * a `filter`. And the workers are asserted in request order, so a reorder is
   * red. A fixture giving each worker one distinct alphabetical service — the
   * obvious one to write — is green under all four.
   */
  test("preserves worker order, claim order, repeats and empty shares", () => {
    // The projection is verbatim: it neither de-duplicates nor drops. Asserted on
    // one seat now; it was three when the console had three observers.
    const projected = partitionFromRequests([
      req(OBS[0], ["routing", "ingest", "ntfy", "ntfy"]),
    ]);

    expect(projected).toEqual([
      { worker: OBS[0], services: ["routing", "ingest", "ntfy", "ntfy"] },
    ]);
  });

  /**
   * The projection carries the DUPLICATE through to the code that names it.
   *
   * Asserted end to end rather than on the projection alone, because a
   * de-duplicating projection would still return a plausible-looking value and
   * only the verdict changes: `partition_duplicate` naming `mia` becomes
   * `complete`, and a service two observers both read 288 times a day is
   * reported as a clean sweep.
   */
  test("a repeat inside one share still reaches partition_duplicate, by name", () => {
    const outcome = checkTriagePartition(
      DECLARED,
      // The repeat is inside the ONE share, which is the arm this test names.
      // COVERAGE DROPPED: the same service claimed by two DIFFERENT observers no
      // longer has a second observer to be claimed by.
      partitionFromRequests([
        req(OBS[0], ["ntfy", "ntfy", "prometheus", "grafana"]),
      ]),
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["ntfy"]);
  });

  /**
   * An ABSENT list projects to an idle share, and the refusal that follows names
   * every declared service.
   *
   * **Unreachable in production and asserted anyway.** §7.3 makes `services`
   * required on the triage console, so `parseDispatchRequest` refuses this
   * document as `services_missing` before the actor ever projects it — which is
   * the whole point of the required half. The fallback exists so the projection
   * is TOTAL rather than partial, and this test is what stops it being a dead
   * branch nobody can characterise: if it ever fires, the outcome is a loud
   * refusal naming the whole environment, not a silent empty sweep.
   */
  test("an absent share projects to an idle observer, and the check then names every service", () => {
    const projected = partitionFromRequests([req(OBS[0])]);
    expect(projected).toEqual([{ worker: OBS[0], services: [] }]);

    const outcome = checkTriagePartition(DECLARED, projected);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.missing).toEqual([...DECLARED]);
  });
});

describe("parse → project → check, which is the chain §6.3 step 5 describes", () => {
  /**
   * The positive control for the whole chain, and it is FIRST.
   *
   * A chain that refused everything would satisfy the asymmetric fixture below
   * while being a console that dispatches nothing.
   */
  test("a complete partition survives the parser and dispatches every share", async () => {
    const read = parseDispatchRequest(
      // ONE observer, so a complete partition is one request naming every
      // declared service. It was one service per seat when there were three.
      fanOutBody(SWEEP, [req(OBS[0], ["ntfy", "prometheus", "grafana"])]),
      { sender: "tri-1", taskId: SWEEP, roster: TRIAGE_CONSOLE_ROSTER },
    );

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;

    const { dispatch, calls } = spy();
    const outcome = await dispatchPartition(
      K8S_DECLARED,
      partitionFromRequests(read.request.requests),
      dispatch,
    );

    expect(outcome.kind).toBe("dispatched");
    expect(calls.map((c) => c.worker)).toEqual([OBS[0]]);
    expect(calls.map((c) => c.services)).toEqual([["ntfy", "prometheus", "grafana"]]);
  });

  /**
   * THE ASYMMETRIC FIXTURE, CARRIED THROUGH THE REAL PARSER.
   *
   * declared {mia, authorization, authentication} against claimed
   * {authorization, authentication, ingest} — the fixture this file's header
   * block is about, now sourced from a document `parseDispatchRequest` accepted
   * rather than from a hand-built value. That is what makes it a test of the
   * SEAM: a projection that lost a name, sorted the claims, or dropped the
   * second share would change which half of this refusal is populated, and both
   * halves are asserted by name.
   *
   * **And nothing is dispatched**, which §12 names as the load-bearing clause:
   * a refusal that arrives after the observer pass has started against a
   * live control plane is worse than no check.
   */
  test("the asymmetric partition is refused after the parse, and nothing is dispatched", async () => {
    const read = parseDispatchRequest(
      /*
       * The asymmetry is now WITHIN one request rather than across two seats: it
       * names a service the environment does not declare and misses one it does.
       * COVERAGE DROPPED: a partition split unevenly ACROSS observers no longer
       * has a second seat to be uneven against.
       */
      fanOutBody(SWEEP, [req(OBS[0], ["prometheus", "grafana", "ingest"])]),
      { sender: "tri-1", taskId: SWEEP, roster: TRIAGE_CONSOLE_ROSTER },
    );

    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;

    const { dispatch, calls } = spy();
    const outcome = await dispatchPartition(
      K8S_DECLARED,
      partitionFromRequests(read.request.requests),
      dispatch,
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.missing).toEqual(["ntfy"]);
    expect(outcome.undeclared).toEqual(["ingest"]);
    expect(calls).toEqual([]);
  });

  /**
   * `DECLARED` IS A SERVICE LIST THE TARGETS SCHEMA WOULD ACTUALLY ADMIT.
   *
   * `DECLARED` is a bare array, and every fixture above trusts it to be
   * something `triage/targets.yaml`'s own grammar would accept. This parses it
   * through `parseTriageTargets` so that a name this suite happily partitions
   * but the schema refuses — a slash, a space, a leading dot, anything outside
   * `SESSION_ID_RE` — is a red test here rather than a live console that refuses
   * every sweep at load.
   *
   * **IT NO LONGER READS THE TRACKED FILE, and that is a trade made deliberately
   * on 2026-09-12 rather than a coupling nobody noticed.** This pin used to parse
   * `triage/targets.yaml` itself, so that renaming a service there reddened these
   * fixtures. The price was that the operator's real service list dictated the
   * SIZE of every arithmetic fixture above, and those are minimal on purpose —
   * see `DECLARED`. Expanding the console to nine services would have forced ~22
   * hand-computed assertion lists whose minimality was the thing making them
   * probes rather than scenarios.
   *
   * **The drift guard did not go away with it.** `cli-exit-codes.test.ts` copies
   * the tracked `targets.yaml` and `console.yaml` into a rig, asserts the
   * environment and the service COUNT, and proves the pair passes the kube-context
   * fence — so a rename, a retarget, or a service added and forgotten still
   * reddens a test. It is simply no longer this one, and that test is now the
   * SOLE place the shipped file is checked: do not decouple it too.
   */
  test("DECLARED is a service list the targets schema admits", () => {
    const targets = parseTriageTargets(FIXTURE_TARGETS, "triage/targets.yaml");
    const declared = targets.environments_unchecked_against_kubeconfig;

    /*
     * The fixture declares exactly one environment, a k8s one, so it is read
     * out of the document rather than named here, without spelling the token
     * a second time.
     */
    const names = Object.keys(declared);
    expect(names).toHaveLength(1);
    expect(declared[names[0]!]!.services.map((s) => s.name)).toEqual([...DECLARED]);
  });
});

// ---------------------------------------------------------------------------
// SRD-TRIAGE-MIXED-OBSERVERS §5, §10, D8 — Phase 4 task 4.1: partitioning runs
// once per kind, in the fixed order k8s, docker, vm, and the first refusal
// stops the sweep. Every fixture below keeps k8s, docker and vm service names
// DISJOINT (`ntfy`/`prometheus`/`grafana` vs `cadvisor`/`node_exporter` vs
// `vm-1`), so an implementation that checked one flat union of every kind's
// services instead of three separate kinds would accept partitions this suite
// refuses, rather than passing by coincidence.
// ---------------------------------------------------------------------------

const K8S_SERVICES = ["ntfy", "prometheus", "grafana"] as const;
const DOCKER_SERVICES = ["cadvisor", "node_exporter"] as const;
const VM_SERVICES = ["vm-1"] as const;

/** Every kind present and complete: 3 k8s + 2 docker + 1 vm seats. */
const MIXED_DECLARED: readonly DeclaredKindGroup[] = [
  { kind: "k8s", services: K8S_SERVICES },
  { kind: "docker", services: DOCKER_SERVICES },
  { kind: "vm", services: VM_SERVICES },
];

describe("per-kind partitioning (SRD-TRIAGE-MIXED-OBSERVERS §5, §10, D8)", () => {
  /**
   * THE POSITIVE CONTROL, first for the reason every other positive control in
   * this file is first: a check that refused unconditionally would satisfy
   * every refusal fixture below it while dispatching nothing to a real console.
   */
  test("a complete mixed partition dispatches every assignment across all three kinds", async () => {
    const { dispatch, calls } = spy();
    const mixed = [
      assign("obs-t1", "ntfy"),
      assign("obs-t2", "prometheus"),
      assign("obs-t3", "grafana"),
      assign("obs-td1", "cadvisor"),
      assign("obs-td2", "node_exporter"),
      assign("obs-tv1", "vm-1"),
    ];

    const outcome = await dispatchPartition(MIXED_DECLARED, mixed, dispatch);

    expect(outcome.kind).toBe("dispatched");
    expect([...calls.map((c) => c.worker)].sort()).toEqual(
      ["obs-t1", "obs-t2", "obs-t3", "obs-td1", "obs-td2", "obs-tv1"].sort(),
    );
  });

  /**
   * THE SRD'S OWN REVERT CHECK (task 4.1's acceptance). If `dispatchPartition`
   * regressed to checking one flat union of every kind's declared services
   * against every assignment, this fixture would pass silently: the union of
   * {ntfy, prometheus, grafana, cadvisor} and the union of what the five
   * assignments below claim are the SAME SET, so a flat check sees a complete
   * cover. Scoped per kind, it is not: k8s's own three seats never claim
   * `cadvisor`, so k8s's own check is missing it — refused `partition_incomplete`
   * FOR k8s, never silently accepted because the name is declared somewhere else.
   */
  test("a docker container fed into the k8s group's declared set reports partition_incomplete for k8s", async () => {
    const { dispatch, calls } = spy();
    const declared: readonly DeclaredKindGroup[] = [
      // "cadvisor" is a docker container name, misfiled under k8s's own declared set.
      { kind: "k8s", services: [...K8S_SERVICES, "cadvisor"] },
      { kind: "docker", services: DOCKER_SERVICES },
    ];
    const mixed = [
      assign("obs-t1", "ntfy"),
      assign("obs-t2", "prometheus"),
      assign("obs-t3", "grafana"),
      assign("obs-td1", "cadvisor"),
      assign("obs-td2", "node_exporter"),
    ];

    const outcome = await dispatchPartition(declared, mixed, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.missing).toEqual(["cadvisor"]);
    expect(calls).toEqual([]);
  });

  test("a k8s service claimed by a docker seat is refused as undeclared, for docker (§10)", async () => {
    const { dispatch, calls } = spy();
    const mixed = [
      assign("obs-t1", "ntfy"),
      assign("obs-t2", "prometheus"),
      assign("obs-t3", "grafana"),
      // "grafana" is a k8s service name, wrongly claimed by a docker seat.
      assign("obs-td1", "grafana"),
      assign("obs-td2", "node_exporter"),
    ];

    const outcome = await dispatchPartition(
      [{ kind: "k8s", services: K8S_SERVICES }, { kind: "docker", services: DOCKER_SERVICES }],
      mixed,
      dispatch,
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.undeclared).toEqual(["grafana"]);
    expect(calls).toEqual([]);
  });

  test("a docker container claimed by a k8s seat is refused as undeclared, for k8s (§10)", async () => {
    const { dispatch, calls } = spy();
    const mixed = [
      // "cadvisor" is a docker container name, wrongly claimed by a k8s seat.
      assign("obs-t1", "cadvisor"),
      assign("obs-t2", "prometheus"),
      assign("obs-t3", "grafana"),
      assign("obs-td1", "cadvisor"),
      assign("obs-td2", "node_exporter"),
    ];

    const outcome = await dispatchPartition(
      [{ kind: "k8s", services: K8S_SERVICES }, { kind: "docker", services: DOCKER_SERVICES }],
      mixed,
      dispatch,
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    // k8s is checked FIRST (fixed order), so k8s's own fault surfaces — the
    // docker seat's legitimate claim on "cadvisor" is never even reached.
    expect(outcome.undeclared).toEqual(["cadvisor"]);
    expect(calls).toEqual([]);
  });

  test("k8s and docker both faulty: the refusal names k8s, the fixed order's first kind", async () => {
    const { dispatch, calls } = spy();
    const declared: readonly DeclaredKindGroup[] = [
      { kind: "k8s", services: K8S_SERVICES },
      { kind: "docker", services: DOCKER_SERVICES },
    ];
    // k8s is missing "grafana"; docker is ALSO missing "node_exporter" — both
    // would refuse if checked alone, and the fixed order settles which wins.
    const mixed = [assign("obs-t1", "ntfy"), assign("obs-t2", "prometheus"), assign("obs-td1", "cadvisor")];

    const outcome = await dispatchPartition(declared, mixed, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    // k8s's own missing list ("grafana"), never docker's ("node_exporter") —
    // that is the fixed order made observable.
    expect(outcome.missing).toEqual(["grafana"]);
    expect(calls).toEqual([]);
  });

  /**
   * Covers both the width/kind naming (task 4.1's design) and the SRD's own
   * phrasing check: *"names its own width and kind, not 'three'"*. `reason` is
   * asserted deliberately here, unlike the rest of this file (see the module
   * docblock) — this test is specifically about the NEW context substitution,
   * not about re-deriving a rule the structured fields already carry.
   */
  test("only docker faulty: the refusal names docker, its own width, and not 'three'", async () => {
    const { dispatch, calls } = spy();
    const declared: readonly DeclaredKindGroup[] = [
      { kind: "k8s", services: K8S_SERVICES },
      { kind: "docker", services: DOCKER_SERVICES },
    ];
    // k8s is complete. Docker's two seats both claim "cadvisor" — a duplicate.
    const mixed = [
      assign("obs-t1", "ntfy"),
      assign("obs-t2", "prometheus"),
      assign("obs-t3", "grafana"),
      assign("obs-td1", "cadvisor"),
      assign("obs-td2", "cadvisor"),
    ];

    const outcome = await dispatchPartition(declared, mixed, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_duplicate");
    expect(outcome.duplicated).toEqual(["cadvisor"]);
    expect(outcome.reason).toContain("2 requests wide, for docker");
    expect(outcome.reason).not.toContain("three requests wide");
    expect(calls).toEqual([]);
  });

  test("any refusal dispatches nothing, including when k8s is complete and vm is not", async () => {
    const { dispatch, calls } = spy();
    const declared: readonly DeclaredKindGroup[] = [
      { kind: "k8s", services: K8S_SERVICES },
      { kind: "vm", services: VM_SERVICES },
    ];
    const mixed = [
      assign("obs-t1", "ntfy"),
      assign("obs-t2", "prometheus"),
      assign("obs-t3", "grafana"),
      // The vm seat claims nothing — "vm-1" is missing.
      assign("obs-tv1"),
    ];

    const outcome = await dispatchPartition(declared, mixed, dispatch);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.missing).toEqual(["vm-1"]);
    expect(calls).toEqual([]);
  });

  /**
   * `tri-1` is a real console worker (it is the collator) but
   * `TRIAGE_SEAT_KINDS` deliberately names no kind for it — it observes no
   * environment itself. An assignment for it, or for any other worker
   * `seatKind` does not recognise, must be refused rather than quietly
   * excluded from every kind's count — see `dispatchPartition`'s docblock.
   */
  test("an assignment for a worker with no kind is refused, not silently dropped", async () => {
    const { dispatch, calls } = spy();
    const mixed = [
      assign("obs-t1", "ntfy"),
      assign("obs-t2", "prometheus"),
      assign("obs-t3", "grafana"),
      assign("tri-1", "phantom-service"),
    ];

    const outcome = await dispatchPartition(
      [{ kind: "k8s", services: K8S_SERVICES }],
      mixed,
      dispatch,
    );

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("partition_incomplete");
    expect(outcome.undeclared).toEqual(["phantom-service"]);
    expect(calls).toEqual([]);
  });
});

/**
 * ── `evenSlices` — the HOST's split, one level above §6.5's partition ─────────
 *
 * §6.5 reserves the partition ACROSS OBSERVERS for the model. This function
 * decides something the model cannot: which collator is handed which half, at a
 * moment when no model has been dispatched yet because the slice IS the envelope.
 * So it is arithmetic, and the operator fixed the rule in those terms —
 * *"numerically as even as possible"* (2026-09-12).
 */
describe("evenSlices divides a declared list between the console's collators", () => {
  /**
   * THE POSITIVE CONTROL, and the block means nothing without it: a function
   * returning `[]` for everything would satisfy every "no service is lost" check
   * below while dispatching an empty console.
   */
  test("the union is the input, in order, with nothing lost or duplicated", () => {
    for (const parts of [1, 2, 3, 4]) {
      const slices = evenSlices([...DECLARED], parts);
      expect(slices.flat()).toEqual([...DECLARED]);
    }
  });

  /**
   * BOTH SIDES OF "as even as possible". A sizes check alone passes for a
   * function that returns the right SHAPE with the wrong contents, which is why
   * the union test above runs first and this one asserts sizes only.
   */
  test("sizes differ by at most one, and the remainder goes to the front", () => {
    // 3 services, 2 collators -> 2/1, not 1/2.
    expect(evenSlices([...DECLARED], 2).map((s) => s.length)).toEqual([2, 1]);
    // Exact division leaves every slice equal.
    expect(evenSlices(["a", "b", "c", "d"], 2).map((s) => s.length)).toEqual([2, 2]);
    // 5 across 2 is the monitoring-sized case: 3/2.
    expect(evenSlices(["a", "b", "c", "d", "e"], 2).map((s) => s.length)).toEqual([3, 2]);
    // 16 across 2 is the doubled cap: 8/8, which is what keeps each collation
    // inside TRIAGE_DOCUMENT_MAX_BYTES.
    expect(
      evenSlices(Array.from({ length: 16 }, (_, i) => `svc-${i}`), 2).map((s) => s.length),
    ).toEqual([8, 8]);
  });

  /**
   * CONTIGUOUS, NOT ROUND-ROBIN — asserted by VALUE, because both strategies
   * produce identical SIZES and a sizes-only suite could not tell them apart.
   * The operator reads `triage/targets.yaml` top to bottom; a round-robin split
   * would interleave the collators through that file.
   */
  test("slices are contiguous runs of the file's own order", () => {
    expect(evenSlices([...DECLARED], 2)).toEqual([["ntfy", "prometheus"], ["grafana"]]);
  });

  /**
   * THE EMPTY SLICE IS RETURNED, NOT DROPPED. `openSweep` relies on the result's
   * length equalling the collator count so index `i` means collator `i`, and it
   * skips an empty slice rather than dispatching an envelope that names no
   * services — which a model could only answer with a refused partition.
   */
  test("fewer services than collators leaves a trailing empty slice, kept", () => {
    const slices = evenSlices(["only"], 2);
    expect(slices).toHaveLength(2);
    expect(slices[1]).toEqual([]);
    expect(evenSlices([], 2)).toEqual([[], []]);
  });

  /**
   * A part count of zero would divide by nothing and return `[]`, silently
   * sweeping no services at all — the failure this console exists to notice,
   * caused by the console. It throws instead.
   */
  test("a part count below one is refused rather than answered", () => {
    expect(() => evenSlices([...DECLARED], 0)).toThrow(RangeError);
    expect(() => evenSlices([...DECLARED], -1)).toThrow(RangeError);
    expect(() => evenSlices([...DECLARED], 1.5)).toThrow(RangeError);
  });
});
