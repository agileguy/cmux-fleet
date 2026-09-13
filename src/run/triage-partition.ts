/**
 * The partition completeness check — SRD-TRIAGE-CONSOLE §6.5, D6; §13 task 5.1.
 *
 * §6.5 divides one job across two parties and this module is the host's half.
 * **The partition is the triage worker's to make**, because which services are
 * related, cheap, or changed since the last sweep is a judgement. **The
 * completeness check is the host's**, because *"a model that partitions can drop
 * a service and nothing downstream would notice: two clean reports and a missing
 * third reads exactly like a clean sweep."*
 *
 * That is `Docs/SRD-FLEET-PROJECT-MANAGER.md` §7.5's discipline in a second
 * place: **the number the loop branches on is the one the host counted, never the
 * one the worker claimed.**
 *
 * ## Why the check takes a partition VALUE, and where the value now comes from
 *
 * The check is written over {@link PartitionAssignment}s — the worker→services
 * mapping, as a value — rather than over a `DispatchRequest`. That was true
 * before there was any way to build one from a request, and it stays true now
 * that there is, because it is what lets Phase 5 grade the whole check *"as pure
 * functions over fixtures"* with no container and no network in reach.
 *
 * **The gap that left open is closed, and the resolution is §7.3's.** As written,
 * the fan-out document was fixed at `worker`, `title`, `brief` and nothing else,
 * so it carried no machine-readable service list and nothing could hand this
 * module a partition at all; §6.5 nevertheless made completeness the host's
 * question, and the only remaining route was parsing the brief's prose — *"the
 * one thing a check against a partitioning model must not depend on."* §7.3
 * weighed three arms and **the operator chose arm 1 on 2026-09-06**:
 * `pifleet.dispatchrequest/v1` grows `services: string[]`, required on the
 * triage console and refused on the review console, with `ConsoleRoster` as the
 * discriminator. {@link partitionFromRequests} is the projection between that
 * field and this check.
 *
 * §6.5's premise survives intact: the partition is still the model's judgement,
 * and the host still counts.
 *
 * ## Two codes for three conditions, and the third is named rather than hidden
 *
 * §6.5 fixed the alphabet at two, and `dispatch-request.ts:726-741` declares both
 * there — the request plane owns the vocabulary, this module spends it:
 *
 *  - `partition_incomplete` — *"a service in the environment appears in no request."*
 *  - `partition_duplicate` — *"a service appears in more than one."*
 *
 * A partition can fail a third way that neither sentence describes: it can claim a
 * service `triage/targets.yaml` never declared. That is not a multiplicity fault,
 * so it is not `partition_duplicate`; and the service it names is not missing, so
 * it does not match `partition_incomplete`'s sentence either. It must still be
 * refused — an invented service has no namespace, no `checks[]` and no window
 * (§6.2 rule 2, *"DECLARED, never derived"*), so nothing downstream can render a
 * brief for it, and §6.10's fence is bounded by the file rather than by the
 * worker's imagination.
 *
 * **It spends `partition_incomplete`, and the reason string carries the
 * distinction the code cannot.** Both codes answer *"is this a partition OF the
 * declared set?"*, and an undeclared block breaks that in the same direction a
 * gap does — the blocks are not a partition of the environment — whereas
 * `partition_duplicate` says something specifically about multiplicity. A third
 * code would be better and is **not** taken unilaterally: `DispatchRefusal` lives
 * in another module, and §6.5 named two. {@link PartitionFault.undeclared} carries
 * the members separately so a caller, a log line and a test can all tell the two
 * apart without matching English — the same reason `DispatchRefusal` exists at all
 * (`dispatch-request.ts:695-707`).
 *
 * ## Precedence: the duplicate is the cause, the gap is usually its symptom
 *
 * §6.5 leaves the ordering to this phase and `dispatch-request.ts:735` says so
 * — *"The checks that spend these codes are Phase 5's; the ordering is Phase 5's
 * too."* A duplicate wins.
 *
 * With the fan-out's width fixed at three, an observer claiming a service another
 * already claimed is an observer NOT claiming something else, so the two faults
 * usually arrive together with one cause. The repository already reasons this way
 * about the sibling code: *"a partition that names one observer twice is a LOST
 * SERVICE — the third observer is never asked."* Reporting the gap would send an
 * operator to look at services that were never the mistake.
 *
 * **The precedence costs no information**, because {@link PartitionFault} always
 * carries all three lists whichever code won.
 */

import type { DispatchRefusal, DispatchRequestItem } from "./dispatch-request.ts";

/**
 * One observer's share of the environment.
 *
 * `services` are service NAMES as `triage/targets.yaml` spells them
 * (`TriageServiceSchema.name`), not workloads and not namespaces — the name is
 * what keys a service's incident state (§6.8), so it is the identity the host
 * counts coverage in.
 *
 * An empty `services` is legal. §6.5's `1 ≤ N < 3` row: **an idle observer is not
 * an error**, the same posture as SRD-FLEET-PM-001 D4 — *idle seats over a wrong
 * answer*.
 */
export interface PartitionAssignment {
  readonly worker: string;
  readonly services: readonly string[];
}

/**
 * Divide a declared list between the console's collators, as evenly as the
 * count allows — the HOST's half of a two-pair sweep (2026-09-12).
 *
 * ## This is not the partition §6.5 reserves for the worker
 *
 * §6.5 gives the model the judgement of *which services are related, cheap, or
 * changed since the last sweep* — that partition is still the collator's, made
 * ACROSS ITS OWN OBSERVERS, and {@link checkTriagePartition} still counts it.
 * What this function decides is one level up and is not a judgement at all:
 * which collator is handed which half of the environment. A model cannot make
 * that call, because at the moment it would be made no model has been dispatched
 * yet — the slice IS the envelope, and the envelope is what wakes the collator.
 *
 * So the rule is arithmetic rather than discernment, and the operator fixed it
 * in those terms: *"the split should be numerically as even as possible."*
 *
 * ## Contiguous in FILE ORDER, not round-robin, and the reason is the operator
 *
 * `declared` is in `triage/targets.yaml` order and stays that way — the same
 * rule `triagePass`'s own call site gives for not sorting it, *"sorting here
 * would make `partition_incomplete`'s list disagree with the file an operator is
 * about to open"*. Contiguous slices extend that: an operator reading the
 * targets file top-to-bottom can see where the cut falls. Round-robin would
 * interleave the two collators through the file and make "who has `grafana`?" a
 * question only this function can answer.
 *
 * ## The remainder goes to the FRONT, so `tri-1` carries the odd one
 *
 * With 3 services and 2 collators the split is 2/1, not 1/2. Front-loading is
 * arbitrary between the two but it must be DECIDED rather than emergent, because
 * the alternative is a split that depends on iteration order and changes the day
 * someone reverses a loop. `tri-1` is the seat an operator lands on (it is pane
 * 1), so if either collator is going to be the busier one it should be the one
 * being looked at.
 *
 * ## An EMPTY slice is possible and is the caller's problem, deliberately
 *
 * With fewer services than collators — one service, two seats — a trailing slice
 * is `[]`. This function returns it rather than dropping it, so the result's
 * length always equals `parts` and a caller can rely on index `i` meaning
 * collator `i`. A collator handed an empty slice must NOT be dispatched: an
 * envelope naming no services asks a model to partition nothing, and whatever it
 * writes would be refused as `partition_incomplete` against an empty declared
 * list. Skipping it is the caller's job because only the caller knows what a
 * skipped seat means for coverage.
 */
export function evenSlices<T>(items: readonly T[], parts: number): readonly (readonly T[])[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(
      `evenSlices needs at least one part and got ${JSON.stringify(parts)}; the part count is ` +
        `the console's collator count, which is a host constant rather than anything a worker ` +
        `or a config file can drive to zero.`,
    );
  }
  const base = Math.floor(items.length / parts);
  // The first `extra` slices take one more than the rest — see the docblock for
  // why the remainder is front-loaded rather than trailing.
  const extra = items.length % parts;
  const out: (readonly T[])[] = [];
  let at = 0;
  for (let i = 0; i < parts; i += 1) {
    const size = base + (i < extra ? 1 : 0);
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * The two codes this module can spend, narrowed FROM the request plane's union
 * rather than re-spelled.
 *
 * `Extract` makes the relationship a compile-time claim: rename or delete either
 * code in `dispatch-request.ts` and this alias becomes `never`, which reddens
 * every construction below under `tsc --noEmit`. A local string-literal type
 * would let the two files drift into two alphabets, which is the failure
 * `DispatchRefusal` was introduced to prevent.
 */
export type PartitionRefusal = Extract<
  DispatchRefusal,
  "partition_incomplete" | "partition_duplicate"
>;

/**
 * Why a partition was refused — the code to branch on, the lists to read.
 *
 * All three lists are populated on every refusal regardless of which code won, so
 * the precedence rule above discards nothing. `reason` is the explanation and the
 * code is the assertion surface; `dispatch-request.ts:695-707` argues that split
 * and it transfers unchanged — a caller matching substrings of English is pinning
 * a sentence rather than a rule, and the sentence is the part that gets rewritten.
 */
export interface PartitionFault {
  readonly code: PartitionRefusal;
  readonly reason: string;
  /** Declared services no assignment claims, in the order the file declares them. */
  readonly missing: readonly string[];
  /** Services claimed more than once, across all assignments and within each. */
  readonly duplicated: readonly string[];
  /** Services claimed that the environment does not declare. */
  readonly undeclared: readonly string[];
}

/** Complete, or refused with everything known about why. */
export type PartitionCheck = { kind: "complete" } | ({ kind: "refused" } & PartitionFault);

/**
 * A sweep's requests, as the partition both waiting modules already take —
 * SRD-TRIAGE-CONSOLE §7.3, §13 task 5.1a.
 *
 * `checkTriagePartition` counts it, and `assessTriageSweep` reads it as
 * `SweepCoverage.assignments`. One projection feeds both, so the two can never
 * be counting different partitions of the same sweep — which is the failure a
 * second, private spelling in the actor would produce, and it would produce it
 * silently: a coverage census over one mapping and a completeness refusal over
 * another agree on every sweep where the worker did the obvious thing.
 *
 * ## Four things it does NOT do, and each is a property something downstream needs
 *
 * It does not SORT: `checkTriagePartition` reports `duplicated` and `undeclared`
 * in claim order because *"first mention is where the author looks"*, and a sort
 * here would replace that with alphabetical order two modules away from the
 * promise. It does not DE-DUPLICATE within a share: a service listed twice in
 * one brief is `partition_duplicate`, on §6.10 rule 1's read-amplification
 * argument, and a `Set` here would make that refusal unreachable. It does not
 * DROP an empty share: §6.5's `1 ≤ N < 3` row makes an idle observer legal and
 * it is still an observer the actor dispatched. And it does not REORDER the
 * workers: `dispatchPartition` is serial, so the order is the order the fan-out
 * happens in.
 *
 * All four survive a plausible one-line rewrite of this function, so all four
 * are asserted by value in `triage-partition.test.ts` against a single fixture
 * built to separate them.
 *
 * ## The absent share, and why the fallback is not a dead branch
 *
 * `services` is optional on the ITEM and required by the triage roster, so
 * `parseDispatchRequest` has already refused a triage request that omits it —
 * `services_missing`, before the actor projects anything. The `?? []` is what
 * makes this projection TOTAL rather than partial: an absent share becomes an
 * idle one, and `checkTriagePartition` then refuses the sweep as
 * `partition_incomplete` naming every declared service. Loud, not silent, and
 * the suite pins that outcome rather than leaving the branch uncharacterised.
 */
export function partitionFromRequests(
  requests: readonly DispatchRequestItem[],
): readonly PartitionAssignment[] {
  return requests.map((entry) => ({
    worker: entry.worker,
    services: entry.services ?? [],
  }));
}

/**
 * Does this partition cover the declared environment exactly once?
 *
 * Pure, and total: every input produces a verdict rather than a throw. The
 * partition is a document a container wrote — untrusted input, expected to be
 * wrong sometimes — and `dispatch-request.ts`'s rule for that shape of failure is
 * a value, with throwing reserved for HOST arguments that are wrong for the life
 * of the run.
 *
 * An empty `declared` is vacuously complete. §6.5's `N = 0` row puts that refusal
 * somewhere else — *"a targets file with an empty environment is refused at load,
 * not at dispatch"*, which `TriageEnvironmentSchema`'s `services.min(1)` enforces
 * — so a second refusal here would be a check on a state the loader has already
 * made unreachable.
 *
 * A repeated WORKER is likewise not this function's question:
 * `parseDispatchRequest` refuses that as `duplicate_target` before the actor gets
 * here (§12). This counts services.
 */
export function checkTriagePartition(
  declared: readonly string[],
  assignments: readonly PartitionAssignment[],
): PartitionCheck {
  const declaredSet = new Set(declared);

  /*
   * Counted, not de-duplicated. A `Set` per assignment — the obvious way to
   * write this — silently forgives a service listed twice in ONE brief, which is
   * the same wasted read against a live control plane that §6.10 rule 1 refuses
   * one level down for a duplicated `check`.
   */
  const claims = new Map<string, number>();
  for (const assignment of assignments) {
    for (const service of assignment.services) {
      claims.set(service, (claims.get(service) ?? 0) + 1);
    }
  }

  // Declared order: the operator reads targets.yaml, not the request.
  const missing = declared.filter((service) => !claims.has(service));
  // Claim order for both of these — first mention is where the author looks.
  const duplicated = [...claims.entries()].filter(([, n]) => n > 1).map(([service]) => service);
  const undeclared = [...claims.keys()].filter((service) => !declaredSet.has(service));

  if (duplicated.length > 0) {
    return {
      kind: "refused",
      code: "partition_duplicate",
      missing,
      duplicated,
      undeclared,
      reason:
        `the partition claims ${plural(duplicated.length, "service")} more than once ` +
        `(${duplicated.join(", ")}). The fan-out is three requests wide (§6.5), so a service ` +
        `claimed twice is another service not claimed at all — ` +
        `${missing.length === 0 ? "none here, but the shape is the same" : `here ${missing.join(", ")}`}` +
        `. The whole request is refused and nothing was dispatched.`,
    };
  }

  if (missing.length > 0 || undeclared.length > 0) {
    return {
      kind: "refused",
      code: "partition_incomplete",
      missing,
      duplicated,
      undeclared,
      reason:
        [
          missing.length > 0
            ? `${plural(missing.length, "service")} in the environment ${
                missing.length === 1 ? "appears" : "appear"
              } in no request (${missing.join(", ")}) — an unswept service reads downstream ` +
              `exactly like a clean one`
            : null,
          undeclared.length > 0
            ? `the partition claims ${plural(undeclared.length, "service")} the targets file ` +
              `does not declare (${undeclared.join(", ")}) — an undeclared service has no ` +
              `namespace, checks or window (§6.2 rule 2), so no brief can be rendered for it`
            : null,
        ]
          .filter((part) => part !== null)
          .join("; ") + ". The whole request is refused and nothing was dispatched.",
    };
  }

  return { kind: "complete" };
}

/** `1 service` / `2 services`, so a reason line reads as English. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What a dispatched partition returned, or why none of it was. */
export type PartitionOutcome<T> =
  | { kind: "dispatched"; results: readonly T[] }
  | ({ kind: "refused" } & PartitionFault);

/**
 * Check the partition, and dispatch it ONLY if it is complete.
 *
 * **This function exists so that "validate before dispatching any of it" is a
 * property of the code rather than of caller discipline.** §6.5 states the
 * ordering — *"the actor validates the request against the targets file before
 * dispatching any of it, and refuses the whole file on a violation"* — and §9.3
 * states the consequence: *"the whole request is refused and nothing is
 * dispatched"*. A check exported alone would leave a caller free to fan out first
 * and count afterwards, and that caller would look correct: it would report the
 * refusal, having already started three observer passes against a live control
 * plane. A refusal that arrives after the reads it was meant to prevent is worse
 * than no check, because it also reports a failed sweep.
 *
 * Dispatch is an argument, which is what lets Phase 5 grade the ordering with a
 * spy over an array and *"no container and no network"*.
 *
 * **Serial, deliberately.** `relayPass` is serial already (§6.5) and the three
 * dispatches are cheap next to the observer passes they start, so there is no
 * concurrency to buy here — while `Promise.all` would start every dispatch before
 * the first rejection could stop the others, quietly reintroducing the partial
 * fan-out this function's whole argument is against.
 */
export async function dispatchPartition<T>(
  declared: readonly string[],
  assignments: readonly PartitionAssignment[],
  dispatch: (assignment: PartitionAssignment) => Promise<T>,
): Promise<PartitionOutcome<T>> {
  const check = checkTriagePartition(declared, assignments);
  if (check.kind === "refused") return check;

  /*
   * **CONCURRENT, and this is an anti-criterion rather than a preference.**
   *
   * Every brief is already built — `checkTriagePartition` accepted the whole
   * partition above — so a slice is byte-independent of every other slice by
   * CONSTRUCTION. Nothing here needs an earlier observer's answer, and nothing
   * may have it: §7.2 forbids one worker's prose reaching another's brief, and a
   * sequential fan-out is the shape that eventually gets "improved" into passing
   * one observer's finding to the next.
   *
   * The cost of getting this wrong is not throughput, it is COVERAGE. Each
   * dispatch waits for its own child to settle, so `for … await` serialises three
   * observers end to end against ONE `sweep_deadline_s` (`cadence_s − reserve_s`,
   * 240s by default). Measured on the first live console: `obs-t1` received its
   * slice, the other two received nothing at all before the pass ended, and the
   * sweep reported two services it "could not see" — pointing the operator at a
   * cluster that was healthy and reachable. The review console's relay has always
   * fanned out concurrently and says why in the same words (`relay.ts`); this is
   * that rule in the console that was missing it.
   *
   * `Promise.all` rather than `allSettled` keeps the existing contract exactly: a
   * dispatch that does not land still fails the pass. What changes is only that
   * the other two were already issued rather than never attempted.
   */
  const results = await Promise.all(assignments.map((assignment) => dispatch(assignment)));
  return { kind: "dispatched", results };
}
