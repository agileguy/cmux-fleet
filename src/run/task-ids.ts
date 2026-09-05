/**
 * THE ID GRAMMAR OF THE REVIEW CONSOLE — the derived task ids, the aspect seats,
 * and the one error a bad aspect table raises.
 *
 * **EXTRACTED FROM `relay.ts` FOR ONE REASON, AND IT IS A STRUCTURAL ONE.**
 * `run/collation.ts` must consult `collationTaskId` and `isCollationTaskId` —
 * the first to check that a collation is filed against its own parent, the
 * second to guard `collationCeiling` so it cannot be aimed at a task that
 * legitimately has no collation. Importing them from `relay.ts` made
 * `run/collation.ts` reach `relay.ts`, and `relay.ts` names
 * `cli/commands/relay.ts` in a type import and `import()`s
 * `cli/commands/dispatch.ts` inside `loadEffectModules`.
 *
 * That is an edge onto the CLI command registry, and it broke ISC-468 the
 * moment the harvester began grading collations: the monitor reaches
 * `harvest/index.ts` through view 4's `report/collect.ts`, so
 * `monitor -> read/report -> report/collect -> harvest/index -> run/collation ->
 * run/relay -> cli/commands/*` put all 27 CLI command modules inside the
 * monitor's import closure. **ISC-468 is what keeps the monitor a read-only view
 * of the fleet**, and the correct repair is to move the seam rather than to
 * weaken the pin or to allowlist a module past it.
 *
 * So the ids live HERE, in a leaf whose only relative import is none at all —
 * it needs `SESSION_ID_RE` from `contracts.ts` and nothing else — and both
 * `relay.ts` and `collation.ts` import them from one place. Nothing is spelled
 * twice, which is the property `relay.ts` was protecting when it imported them
 * in the first place, and `relay.ts` re-exports every name so no existing caller
 * or test changes.
 *
 * **The rule this file exists to keep: nothing here may import a module that
 * reaches `cli/`.** A future edge added to this file is an edge added to the
 * monitor.
 */

import { SESSION_ID_RE } from "../contracts.ts";

/**
 * The longest a derived task id may be.
 *
 * **Deliberately a local constant rather than an import, and the test is what
 * keeps it honest.** `dispatch-request.ts` must consult `isCollationTaskId` to
 * close T5's depth hole, so a runtime import in the other direction would make
 * these two modules a cycle — and a cycle whose correctness depends on which
 * one node happens to evaluate first is worse than a duplicated number.
 *
 * `collator-relay.test.ts` asserts this equals `MAX_DISPATCH_ID_CHARS`, which
 * turns the drift this would otherwise invite into a red test. That is the same
 * trade `REVIEW_CONSOLE_ROSTER` makes against `DEFAULT_REVIEW_WORKERS`: spell
 * both, pin them together, and let the failure be a test rather than a console
 * that starts four healthy workers and refuses every dispatch.
 *
 * (`replies.ts:144` spells this same 64 a third time, inline, and is outside
 * this change. It is the reason the pin exists rather than an argument against
 * it.)
 */
export const MAX_RELAY_TASK_ID_CHARS = 64;

/**
 * The trailing segment that marks a collation task.
 *
 * It is a whole SEGMENT and the predicate below matches it as one, because the
 * obvious spelling — `id.includes("collate")` — refuses every task an operator
 * named for collating anything, and a depth bound that fires on first-round
 * fan-outs is a bound that gets deleted.
 */
export const COLLATION_ASPECT = "collate";

/**
 * A host-side argument that makes this module's guarantees unmeanable.
 *
 * **THROWN, not refused**, and the asymmetry is `ConsoleRosterError`'s, taken
 * without amendment: every refusal in the request plane answers a document a
 * container wrote, which is untrusted, expected, and answered with a value. An
 * aspect table is written by the author of the actor, is identical on every tick
 * for the life of the run, and is therefore either wrong from the first poll or
 * never. Answering it with a refusal would put a programming error into the same
 * channel a worker's mistake arrives on and let the poll loop run around it
 * forever, dispatching nothing and reporting nothing.
 *
 * The derived-id failures throw for a narrower reason: an id that cannot be
 * spelled becomes a `join` on the host in a run directory that also holds
 * `control-auth.json`, and a builder that can silently produce a path outside
 * the subtree it names is a hole at every call site, including the ones that do
 * not exist yet. `relayFanOut` never reaches those throws, because it derives
 * every id up front and answers a REFUSAL — a value a polling actor can act on.
 */
export class RelayAspectError extends Error {
  constructor(problem: string) {
    super(`the review console's aspect assignment is not usable: ${problem}`);
    this.name = "RelayAspectError";
  }
}

/**
 * One lens: the worker that holds it and the name it is known by.
 *
 * The aspect is not decoration. It is the segment the child's task id is derived
 * from, so it is the thing that makes `T-arch` legible, and it is the word the
 * collation brief uses when it has to say a lens is missing.
 */
export interface AspectSeat {
  /** The reviewer that holds this lens. Fixed in config (D11). */
  readonly worker: string;
  /** The lens' name, and the suffix of its derived task id. */
  readonly aspect: string;
}

/**
 * The `review` console's lenses, as they ship — §6.6's `T-arch`, `T-context`,
 * `T-lang`.
 *
 * **This is D11 as a data structure.** §6.9's three arguments are why it is here
 * and not reachable from a request: the aspect determines the model and the
 * model was validated against `models_allowlist` at `up`, an hour before any
 * request exists; a collator that could assign lenses could send the same lens
 * twice and report the resulting `2/2` as corroboration; and a task should mean
 * the same thing twice, which a runtime-chosen lens set cannot.
 *
 * It stays a PARAMETER of `relayFanOut` (defaulting here) for `resolveRoster`'s
 * reason: a required argument with exactly one right answer is an invitation to
 * COMPUTE it, and the plausible computation — derive the seats from the request
 * — is precisely the capability D11 exists to deny.
 */
export const REVIEW_CONSOLE_ASPECTS: readonly AspectSeat[] = [
  { worker: "rev-arch-1", aspect: "arch" },
  { worker: "rev-ctx-1", aspect: "context" },
  { worker: "rev-lang-1", aspect: "lang" },
];

/** An id that can be a path segment, on the grammar every host path is held to. */
export function spellable(id: string): boolean {
  return id.length > 0 && id.length <= MAX_RELAY_TASK_ID_CHARS && SESSION_ID_RE.test(id);
}

function derive(parentTaskId: string, suffix: string): string {
  if (!spellable(parentTaskId)) {
    throw new RelayAspectError(
      `parent task id ${JSON.stringify(parentTaskId)} is not a legal id, so no child id was ` +
        `derived from it. Every derived id becomes a path segment — a reply file under the ` +
        `/replies mount and a task record under a worker's run — and \`join\` resolves ".." ` +
        `rather than refusing it.`,
    );
  }
  if (!spellable(suffix)) {
    throw new RelayAspectError(
      `${JSON.stringify(suffix)} is not a legal id segment, so it cannot name an aspect or a ` +
        `collation. Aspects are config, so this is an actor-side mistake with an actor-side fix.`,
    );
  }
  const id = `${parentTaskId}-${suffix}`;
  if (id.length > MAX_RELAY_TASK_ID_CHARS) {
    throw new RelayAspectError(
      `the derived id "${id}" is ${id.length} characters and the bound is ` +
        `${MAX_RELAY_TASK_ID_CHARS}. It is REFUSED rather than truncated: two parents whose ` +
        `names differ only past the cut would derive one child id, and the second fan-out would ` +
        `replay the first one's task instead of running.`,
    );
  }
  return id;
}

/**
 * A child's task id — `T` and `arch` give `T-arch` (§6.6).
 *
 * **Derived, never minted, and D5 is the whole reason.** Under D5 the parent
 * task SETTLES when the fan-out is issued rather than when the review is done,
 * so a reader asking "what came of `T`?" has to follow a link. The mitigation is
 * that the link is ARITHMETIC: the ids are in `T`'s envelope, `report` can print
 * the chain, and anyone holding the parent id can recompute every child id
 * without a lookup against a record that may not exist. A random id would make
 * D5's cost unpayable — which §6.6 says plainly is the point on which D5 is put
 * to the owner as open.
 */
export function childTaskId(parentTaskId: string, aspect: string): string {
  return derive(parentTaskId, aspect);
}

/** The collation's task id — `T` gives `T-collate` (§6.6). */
export function collationTaskId(parentTaskId: string): string {
  return derive(parentTaskId, COLLATION_ASPECT);
}

/**
 * Whether a task id is one `collationTaskId` produced.
 *
 * **This is T5's depth bound, and it is consumed by `dispatch-request.ts`.** D7
 * bounds the fan-out's BREADTH — a collator may not name a collator, itself, or
 * anyone outside the console. Nothing bounded its DEPTH over time, and the hole
 * is reachable rather than theoretical: on the collation turn the collator holds
 * all three replies AND its `write` grant, so it can write
 * `/outbox/T-collate/dispatch-request.json` naming the same three reviewers with
 * reviewer A's findings pasted into reviewer B's brief. Every check passes —
 * sender is a collator, targets are reviewers, no duplicates, parent id matches
 * the directory, no forbidden fields — and the actor fans out a second time.
 * That reopens exactly what D7 exists to prevent, and it defeats §6.6's
 * concurrency anti-criterion on round two, which §10's probe only covers on
 * round one.
 *
 * **The suffix is matched as a whole trailing segment.** `includes("collate")`
 * was the cheap spelling and it refuses `collate-findings`, `T-collated` and
 * every task an operator named after the word — a bound that fires on legitimate
 * first-round fan-outs is a bound someone deletes.
 *
 * **What it costs, stated rather than buried.** An operator task genuinely named
 * `something-collate` cannot fan out. That is a false RED, it names the field
 * and the rule, and the operator resolves it by renaming — which is the correct
 * side to err on for a bound whose false GREEN is an unbounded dispatch tree.
 */
export function isCollationTaskId(taskId: string): boolean {
  return taskId.endsWith(`-${COLLATION_ASPECT}`);
}
