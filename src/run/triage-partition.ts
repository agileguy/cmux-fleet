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
 * ## Why this takes a partition VALUE and not a `DispatchRequest`
 *
 * §7.3 fixes the fan-out document at `worker`, `title`, `brief`, **and nothing
 * else** — a request naming any other field is refused whole. So the document
 * carries no machine-readable service list, and this module cannot be handed one
 * and asked to count. It takes {@link PartitionAssignment}s instead: the
 * worker→services mapping, as a value.
 *
 * **Recovering that mapping from what the worker actually wrote is not settled by
 * the SRD and is deliberately not settled here.** §6.5 says the actor *"validates
 * the request against the targets file before dispatching any of it"*, and
 * §6.3 step 4 has `tri-1` write the partition into a `dispatch-request.json` whose
 * schema has nowhere to put it. Whatever closes that gap — a structured field, or
 * the actor assigning the services itself and the worker returning only an
 * ordering — is Phase 6/7's, and it changes the CALLER of this function and not
 * this function. Keeping the check over a value is what makes that true, and is
 * why Phase 5 can grade it *"as pure functions over fixtures"* with no container
 * and no network in reach.
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

import type { DispatchRefusal } from "./dispatch-request.ts";

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

  const results: T[] = [];
  for (const assignment of assignments) results.push(await dispatch(assignment));
  return { kind: "dispatched", results };
}
