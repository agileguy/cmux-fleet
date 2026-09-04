/**
 * The fan-out, the join, and the collation decision — SRD-REVIEW-CONSOLE §6.6,
 * D4, D5, D6, D11.
 *
 * `dispatch-request.ts` decides whether a collator's file may be ACTED ON. This
 * module is what acting on it means: three reviewers dispatched concurrently,
 * joined, harvested, their replies published, and a collation task dispatched
 * back to the collator carrying an honest account of how many lenses actually
 * reported.
 *
 * **Nothing here performs I/O.** Every side effect is a method on an injected
 * `RelayTransport`, and the reason is not testability in the abstract — it is
 * that each of the four effects is unreachable from a unit test for a DIFFERENT
 * reason, so no single trick would have substituted for the seam:
 *
 * - `dispatch` is `sendTaskEnvelope`, which reads the worker's launch record to
 *   decide whether the prompt travels by RPC or is STAGED into an attended
 *   pane, builds the envelope from the run's worktree record, and writes the
 *   durable inbox entry. (It was `controlCall` here until the adapter landed,
 *   and that was wrong: `controlCall(…, {cmd: "dispatch"})` is the RPC half of
 *   a two-plane decision, and every pane on this console is `tui`.)
 * - `awaitSettled` **has no implementation in this repository to import.** There
 *   is no `waitForTerminal` helper: `pifleet wait` polls
 *   `readTaskRecord(taskRecordPath(...))` in a private closure at 100 ms, and
 *   `SchedulerIO.readSettled` is an interface the scheduler's caller supplies.
 *   Whoever owns the poll interval owns this, and that is the process of §6.5 —
 *   which is BLOCKING and unanswered. A module that imported a poller would have
 *   picked the answer to Q4 by accident.
 * - `harvest` is `harvestTask`, which clones a repository and may run acceptance
 *   commands in a container.
 * - `publishReply` writes a `0444` file into the `:ro` `/replies` mount (D6).
 *
 * So §6.5 changes where this is CALLED and changes nothing about what it
 * decides — the same property `dispatch-request.ts` was built for, and the
 * reason both modules can land while Q4 is open.
 *
 * ## The run handle is a type parameter because relay must never read one
 *
 * D4: the console is FOUR runs, not one. `up --attach-here` is the only way to
 * hand a terminal to a worker and it *creates* the run, so every `pane_mode: tui`
 * pane runs its own `pifleet up` and the actor holds a worker→run MAP. The
 * production handle is `RunPaths`; relay never opens it, never reads a secret
 * out of it, and never joins a path from it — it only routes it back to the
 * transport that handed it over.
 *
 * Making that a type parameter rather than importing `RunPaths` is not
 * abstraction for its own sake. It is the difference between a convention and a
 * compile error: a later edit that reached into a run for a socket or a task
 * record would fail to typecheck here, rather than work in production and take
 * the unit suite with it. It also keeps this module free of `paths.ts`, which is
 * what lets a test drive the whole join with three strings.
 *
 * ## Where the idempotency decision goes, and why it is not here
 *
 * **`relayFanOut` fans out every time it is called and holds no memory of having
 * done so. That is the contract, not an omission.**
 *
 * `readDispatchRequest` is idempotent-unfriendly by design: an accepted request
 * stays `ok` on every poll tick, and the file lives in a directory the WORKER
 * owns — so "delete the file after acting on it" and "remember the task id"
 * both fail against a hostile or confused collator, the first because the worker
 * can rewrite it and the second because the actor can restart. The fact that
 * matters ("has parent T already been fanned out?") is durable state with
 * exactly one correct writer, and that writer is `relay-journal.ts`.
 *
 * **The seam is the CALL SITE.** The caller asks the journal, and only enters
 * this function if the answer is no. A private `seen` set in this module would
 * be a second writer of that fact, which is how two components come to disagree
 * about whether a fan-out happened — and the disagreement is silent, because
 * both are individually consistent. `collator-relay.test.ts` pins the absence.
 *
 * ## What this module does NOT bound, so the silence is not read as coverage
 *
 * §6.10's "at most one unsettled fan-out per collator" is the journal's, for the
 * same reason. This module closes the DEPTH arm of that hazard (`isCollationTaskId`,
 * consumed by `dispatch-request.ts`) and leaves the REPEAT arm — a collator
 * rewriting `/outbox/T/dispatch-request.json` under the same parent on a later
 * tick — entirely to the journal. The two are complementary and neither implies
 * the other: the depth bound is a property of an ID and needs no state, and the
 * repeat bound is a property of HISTORY and cannot be had without it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { runsRoot as runsRootEager, runPaths as runPathsEager } from "./paths.ts";

import { SESSION_ID_RE, type Verdict } from "../contracts.ts";
import { replyMountPath } from "./replies.ts";
import type { DispatchRequest } from "./dispatch-request.ts";
import type { RunPaths } from "./paths.ts";
import type { RelayFanOutInput, RelayFanOutResult } from "../cli/commands/relay.ts";

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
function spellable(id: string): boolean {
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

/**
 * The table's checks, each closing a hole that reads as obviously correct.
 *
 * Empty is the degenerate one: a console with no lenses dispatches nothing and
 * reports nothing, forever, and looks healthy. Duplicate WORKERS would derive
 * two task ids for one seat holder; duplicate ASPECTS would derive one task id
 * for two workers, so the second dispatch would replay the first's task rather
 * than run — and the consensus arithmetic would then count one reader twice,
 * which is the exact fabrication `duplicate_target` refuses in the request.
 *
 * The collation collision is the subtle one: a seat named `collate` derives a
 * child id `isCollationTaskId` answers `true` for, so T5's depth bound would
 * refuse a legitimate first-round fan-out from that child. Two rules that are
 * each correct, composing into a console that cannot review anything.
 */
function resolveAspects(aspects: readonly AspectSeat[] | undefined): readonly AspectSeat[] {
  const seats = aspects ?? REVIEW_CONSOLE_ASPECTS;
  if (seats.length === 0) throw new RelayAspectError("it names no aspects");

  const workers = new Set<string>();
  const names = new Set<string>();
  for (const seat of seats) {
    if (!spellable(seat.worker)) {
      throw new RelayAspectError(`${JSON.stringify(seat.worker)} is not a legal worker id`);
    }
    if (!spellable(seat.aspect)) {
      throw new RelayAspectError(
        `${JSON.stringify(seat.aspect)} is not a legal aspect name — an aspect becomes a segment ` +
          `of every task id derived for it`,
      );
    }
    if (seat.aspect === COLLATION_ASPECT) {
      throw new RelayAspectError(
        `"${seat.worker}" holds an aspect named "${COLLATION_ASPECT}", which is the suffix a ` +
          `COLLATION id is derived with. Its child id would be indistinguishable from a ` +
          `collation, and the depth bound in dispatch-request.ts would refuse a legitimate ` +
          `first-round fan-out from it`,
      );
    }
    if (workers.has(seat.worker)) {
      throw new RelayAspectError(`"${seat.worker}" holds two aspects`);
    }
    if (names.has(seat.aspect)) {
      throw new RelayAspectError(
        `the aspect "${seat.aspect}" is held by two workers, so both would derive the SAME child ` +
          `task id — the second dispatch would replay the first's task rather than run, and the ` +
          `console would count one reader twice`,
      );
    }
    workers.add(seat.worker);
    names.add(seat.aspect);
  }
  return seats;
}

/** A task, addressed. */
export interface RelayTaskRef {
  readonly worker: string;
  readonly taskId: string;
}

/** A task, addressed and briefed. */
export interface RelayDispatch extends RelayTaskRef {
  readonly title: string;
  readonly brief: string;
}

/** What a settled child turned out to be. */
export interface RelayHarvest {
  /**
   * The harvester's verdict — `harvestTask(...).harvest.verdict`.
   *
   * `TaskHarvest` also carries `harvestStatus`, which is ORTHOGONAL: it says
   * whether the harvest is trustworthy, not what the task did. It is not needed
   * here, because an untrustworthy harvest already yields `verdict: "unknown"`,
   * and `unknown` is not `success` — so a lens whose harvest was unavailable is
   * a missing lens by the same rule as one that failed, with no second test.
   */
  readonly verdict: Verdict;
  /** The bytes published to `/replies/<child>.json` for the collator to read. */
  readonly reply: unknown;
}

/**
 * The four host effects, injected.
 *
 * `R` is the run handle and relay never inspects it — see the module docblock.
 * The transport closes over whatever `controlCall` and `harvestTask` need.
 *
 * **`publishReply` is on this interface rather than left to the caller, and the
 * ordering is why.** D6's cost is that the collation brief carries three PATHS,
 * so a brief naming a file that is not on disk yet is a collator reading
 * `ENOENT` and reporting a lens as missing that was never missing. That ordering
 * is a correctness property of the JOIN, so it lives where the join lives.
 * Returning the payloads and trusting a caller to write them before dispatching
 * would put a race in a docstring.
 */
export interface RelayTransport<R> {
  /**
   * Dispatch a task into a worker's own run.
   *
   * REJECTS if the dispatch did not land. The production adapter turns both
   * failure shapes into a rejection: the dispatch path THROWS for an
   * unreachable worker or a terminal that has gone, and RESOLVES with
   * `{accepted: false, reason: ...}` for a supervisor-side refusal. A rejection
   * here costs one lens, not the fan-out.
   *
   * **`pane_mode_tui_has_no_rpc_dispatch` is NOT one of those refusals**, and
   * the correction is worth recording because this docblock used to say it was.
   * D13 makes all four panes `tui`, so if it were, the adapter would be refused
   * for every seat and the console would journal three children it never
   * dispatched. An attended worker simply has no RPC dispatch surface: its
   * envelope is STAGED, and `via: "staged"` is a success. The adapter delegates
   * that choice to `sendTaskEnvelope` and examines only `accepted`.
   */
  dispatch(run: R, dispatch: RelayDispatch): Promise<void>;
  /** Resolve once the task has reached a terminal state, however that is observed. */
  awaitSettled(run: R, task: RelayTaskRef): Promise<void>;
  /** Harvest a settled task. */
  harvest(run: R, task: RelayTaskRef): Promise<RelayHarvest>;
  /** Write `<child>.json` into the collator's `/replies` mount. */
  publishReply(collatorRun: R, childTaskId: string, reply: unknown): Promise<void>;
}

/** One lens after the join. Every seat appears, whether or not it was asked. */
export interface RelayChild {
  readonly worker: string;
  readonly aspect: string;
  /** The derived id, or `null` for a seat the request never named. */
  readonly taskId: string | null;
  /**
   * The harvester's or supervisor's verdict, VERBATIM.
   *
   * `unknown` for a seat that was never dispatched, which is the lattice
   * identity and the honest value: nothing was learned about that lens.
   * `timed_out` and `aborted` are carried unchanged rather than folded to
   * `failed` — see `succeeded`.
   */
  readonly verdict: Verdict;
  readonly succeeded: boolean;
  /**
   * Whether a dispatch for this lens ACTUALLY LANDED.
   *
   * **Distinct from `taskId !== null`, and the distinction is what makes the
   * journal honest.** `taskId` is the id this lens was PLANNED under: it is
   * populated the moment the fan-out decides to ask for the lens, and it
   * survives a dispatch that was refused, so a reader using it as evidence of a
   * dispatch records three reviews for a fan-out that issued none.
   * `relay-journal.ts` documents its `children` as "the child task ids the
   * fan-out issued … written by the thing that actually performed the
   * dispatches", and this is the field that makes that sentence true.
   */
  readonly issued: boolean;
  /** Why this lens is missing, in a form the collation brief can print. */
  readonly note: string;
}

export type RelayRefusal = "run_unresolved" | "underivable_id";

export type RelayOutcome =
  | { kind: "refused"; code: RelayRefusal; reason: string }
  | { kind: "not_collated"; reason: string; children: readonly RelayChild[] }
  /**
   * Lenses were asked for and NOT ONE dispatch landed.
   *
   * **Split out of `not_collated` because the two shared a `kind` and a child
   * count while meaning opposite things, and the shared one was journalled.**
   * §6.6's `not_collated` is "every lens reported and none survived" — real work
   * happened, three tasks exist, and the journal must record them or the next
   * tick runs them again. This is "nothing was ever started", and journalling it
   * marks a fan-out complete that never occurred: `already_done` on every later
   * tick, the reviews never run, and the operator's row says
   * `dispatched 3 children`. Permanent, silent, and the exact defect class the
   * wrong-verb fix closed once already.
   *
   * **Reachable without anything being broken.** A second review requested while
   * round one's reviewers are mid-turn: every `stage` reaches
   * `EpochManager.allocate`, which answers `busy` while a fence is live
   * (`rpc/epoch.ts`), `stageForAdoptedTerminal` throws on a refused stage, and
   * all three dispatches reject. Three closed reviewer terminals reach it too,
   * through `terminalRefusal`.
   *
   * `children` is carried so the notes survive — each one says why its lens
   * never left the host — and the caller retries, because a busy console is a
   * console that will be free later.
   */
  | { kind: "none_landed"; reason: string; children: readonly RelayChild[] }
  | {
      kind: "collated";
      collation: RelayDispatch;
      /** What the collator is told to claim: §6.6's table. */
      claim: "success" | "partial";
      children: readonly RelayChild[];
      /** The seats that produced no review. Empty exactly when `claim` is `success`. */
      missing: readonly AspectSeat[];
    }
  /**
   * Everything happened EXCEPT the last hop: the reviews ran, the replies are on
   * disk, and the collation could not be delivered.
   *
   * **A third arm rather than a throw, and the journal is the whole argument.**
   * A throw propagates through `relayPass`, which deliberately does not journal
   * on a throw — correct for a fan-out that aborted early, and exactly wrong
   * here, because by this point three reviews have been dispatched and three
   * `0444` replies published. The next tick would re-read the same request and
   * do it all again, every tick, forever. That is the unbounded repeat the
   * journal exists to prevent, reached through the one dispatch the fan-out did
   * not guard.
   *
   * **And a third arm rather than folding into `collated`**, because the two are
   * different facts and only one of them needs an operator. `collated` means the
   * collator holds a brief; this means it does not, and that the reports are
   * sitting in its `/replies` mount with nothing telling it to read them. A
   * reader that could not tell those apart would see a console that reviewed
   * everything and concluded nothing, with no row anywhere saying why.
   *
   * `missing` is carried unchanged and is usually EMPTY here — every lens can
   * have reported perfectly. The failure is the host's last hop, not any
   * reviewer's, and the shape says so.
   */
  | {
      kind: "collation_failed";
      /** The dispatch that did not land, so a caller need not parse the reason. */
      collation: RelayDispatch;
      claim: "success" | "partial";
      children: readonly RelayChild[];
      missing: readonly AspectSeat[];
      reason: string;
    };

export interface RelayInput<R> {
  /** A request `readDispatchRequest` already answered `ok` for. */
  readonly request: DispatchRequest;
  /** The collator. Structural identity from the outbox directory, never a claim. */
  readonly sender: string;
  /** worker → run. D4: this console is four runs, so this is a map and not a run. */
  readonly runs: ReadonlyMap<string, R>;
  readonly transport: RelayTransport<R>;
  /** Defaults to `REVIEW_CONSOLE_ASPECTS`; see that constant for why it is a parameter. */
  readonly aspects?: readonly AspectSeat[];
}

/** A seat the request actually named, with its derived id and its brief. */
interface Planned {
  readonly seat: AspectSeat;
  readonly taskId: string;
  readonly title: string;
  readonly brief: string;
}

/**
 * §6.6's whole exchange: fan out, join, decide, collate.
 *
 * **Synchronous on its aspect table and asynchronous on everything else.** The
 * table is validated before the returned promise exists, so a malformed one
 * throws at the call rather than rejecting later — a console whose lenses are
 * unusable must not dispatch AT ALL, and an actor that discovers this inside a
 * `.catch` has already been running for an hour.
 */
export function relayFanOut<R>(input: RelayInput<R>): Promise<RelayOutcome> {
  const seats = resolveAspects(input.aspects);
  return fanOut(input, seats);
}

async function fanOut<R>(
  input: RelayInput<R>,
  seats: readonly AspectSeat[],
): Promise<RelayOutcome> {
  const { request, sender, runs, transport } = input;
  const parent = request.parent_task_id;

  // ── Plan, entirely, before anything is dispatched ──────────────────────────
  //
  // Every id is derived and every run resolved up front, because §6.6's "in one
  // pass" is not a property of a pass abandoned partway. A fan-out that issued
  // two of three and then discovered the third worker had no run would leave two
  // reviews running that nobody joins, nobody harvests and nobody reaps.
  //
  // The seats are walked in TABLE order and the request is consulted only to ask
  // whether a seat was named. That is D11 in the control flow: walking
  // `request.requests` instead would let the collator choose the order lenses
  // are reported in, and one refactor later, which lenses exist.
  let collationId: string;
  const planned: Planned[] = [];
  try {
    collationId = collationTaskId(parent);
    for (const seat of seats) {
      const entry = request.requests.find((r) => r.worker === seat.worker);
      if (entry === undefined) continue;
      planned.push({
        seat,
        taskId: childTaskId(parent, seat.aspect),
        title: entry.title,
        brief: entry.brief,
      });
    }
  } catch (err) {
    return {
      kind: "refused",
      code: "underivable_id",
      reason:
        `no child id could be derived from parent task "${parent}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const collatorRun = runs.get(sender);
  if (collatorRun === undefined) {
    return {
      kind: "refused",
      code: "run_unresolved",
      reason:
        `the collator "${sender}" has no run in the worker→run map, and the /replies mount that ` +
        `carries every reply back to it lives in that run (D6). Under D4 this console is FOUR ` +
        `runs — each tui pane runs its own \`pifleet up --attach-here\` — so a missing entry here ` +
        `is a console that was only partly built, not a worker that died.`,
    };
  }

  const routed: Array<Planned & { run: R }> = [];
  for (const p of planned) {
    const run = runs.get(p.seat.worker);
    if (run === undefined) {
      return {
        kind: "refused",
        code: "run_unresolved",
        reason:
          `reviewer "${p.seat.worker}" (aspect "${p.seat.aspect}") has no run in the worker→run ` +
          `map, so no socket could be reached for it. Nothing was dispatched: issuing the other ` +
          `lenses first would leave reviews running that no join is waiting on.`,
      };
    }
    routed.push({ ...p, run });
  }

  // ── Fan out, CONCURRENTLY, in one pass (§6.6, §1.3) ───────────────────────
  //
  // This is an anti-criterion rather than a preference. Every brief is built
  // above, from the request alone, before a single dispatch is issued — so a
  // child's brief is byte-independent of every other child's result by
  // CONSTRUCTION, not by care. And `allSettled`, not `all`: a fan-out that
  // rejected on the first failed dispatch would abandon two perfectly good
  // reviews, so a dispatch that does not land costs its own lens and nothing
  // else.
  //
  // §1.3 is why this must not be relaxed into a loop that reads better: the
  // skill's consensus bands are arithmetic over INDEPENDENT readers, so a
  // sequential fan-out that handed rev-arch's report to rev-ctx would produce a
  // 3/3 that is one reader with three transcripts. It would look like a smarter
  // design and nothing downstream would notice.
  const issued = await Promise.allSettled(
    routed.map((p) =>
      transport.dispatch(p.run, {
        worker: p.seat.worker,
        taskId: p.taskId,
        title: p.title,
        brief: p.brief,
      }),
    ),
  );

  const landed = routed.filter((_, i) => issued[i]?.status === "fulfilled");
  const failedDispatch = new Map<string, string>();
  routed.forEach((p, i) => {
    const outcome = issued[i];
    if (outcome === undefined || outcome.status !== "rejected") return;
    const err: unknown = outcome.reason;
    failedDispatch.set(
      p.seat.aspect,
      `its dispatch never landed (${err instanceof Error ? err.message : String(err)})`,
    );
  });

  // ── Join ──────────────────────────────────────────────────────────────────
  //
  // Concurrently as well, and only over the tasks that exist: waiting on a task
  // whose dispatch was refused is polling for a record that cannot appear.
  await Promise.allSettled(
    landed.map((p) => transport.awaitSettled(p.run, { worker: p.seat.worker, taskId: p.taskId })),
  );

  const harvests = await Promise.allSettled(
    landed.map((p) => transport.harvest(p.run, { worker: p.seat.worker, taskId: p.taskId })),
  );

  const result = new Map<string, RelayHarvest>();
  landed.forEach((p, i) => {
    const h = harvests[i];
    if (h?.status === "fulfilled") result.set(p.seat.aspect, h.value);
  });

  // ── The lattice, and what is NOT put into it ──────────────────────────────
  //
  // `contracts.ts:71-79` is `failed < blocked < partial < success` and `rank()`
  // answers -1 outside it. `timed_out` and `aborted` are SUPERVISOR verdicts —
  // they describe the worker, not the task — so `min` is undefined over them and
  // no comparison here is made against them. The partition is on `success`
  // alone, and every other verdict is carried through VERBATIM.
  //
  // Folding a supervisor verdict to `failed` on the way in is the tempting bug:
  // it makes the value a lattice member and it reads as conservative. What it
  // actually does is record that a reviewer produced a failing review, when what
  // happened is that it never reported at all — and those are different facts
  // for anyone reading the console's output afterwards.
  const children: RelayChild[] = seats.map((seat) => {
    const plan = planned.find((p) => p.seat.aspect === seat.aspect);
    if (plan === undefined) {
      return {
        worker: seat.worker,
        aspect: seat.aspect,
        taskId: null,
        verdict: "unknown",
        succeeded: false,
        issued: false,
        note: "the request never named this reviewer, so the lens was not applied",
      };
    }
    const dispatchNote = failedDispatch.get(seat.aspect);
    if (dispatchNote !== undefined) {
      return {
        worker: seat.worker,
        aspect: seat.aspect,
        taskId: plan.taskId,
        verdict: "unknown",
        succeeded: false,
        // PLANNED but never issued — see `RelayChild.issued`. The id is kept so
        // an operator can correlate the refusal; it is not evidence of a dispatch.
        issued: false,
        note: dispatchNote,
      };
    }
    const harvested = result.get(seat.aspect);
    if (harvested === undefined) {
      return {
        worker: seat.worker,
        aspect: seat.aspect,
        taskId: plan.taskId,
        verdict: "unknown",
        succeeded: false,
        issued: true,
        note: "it was dispatched but could not be harvested",
      };
    }
    return {
      worker: seat.worker,
      aspect: seat.aspect,
      taskId: plan.taskId,
      verdict: harvested.verdict,
      succeeded: harvested.verdict === "success",
      issued: true,
      note:
        harvested.verdict === "success"
          ? ""
          : `it settled \`${harvested.verdict}\` and produced no report`,
    };
  });

  // ── Nothing left the host ─────────────────────────────────────────────────
  //
  // Checked BEFORE the survivor count, because `survived.length === 0` is true
  // of both this and an honest `not_collated` and only one of them may be
  // journalled. `routed.length > 0` is the discriminator that keeps them apart:
  // it says lenses were ASKED FOR. When it is zero the request named no seat
  // this console holds — nothing was attempted and nothing failed, which is a
  // valid no-op that SHOULD be journalled rather than re-evaluated forever.
  if (routed.length > 0 && landed.length === 0) {
    return {
      kind: "none_landed",
      reason:
        `${routed.length} lens/lenses were dispatched and NOT ONE landed, so nothing is running ` +
        `and nothing may be journalled — a record here would mark this fan-out done and the ` +
        `reviews would never run. The pass retries. Per lens: ` +
        children
          .filter((c) => c.taskId !== null)
          .map((c) => `${c.aspect} — ${c.note}`)
          .join("; "),
      children,
    };
  }

  const survived = children.filter((c) => c.succeeded);
  const missing = children.filter((c) => !c.succeeded);

  // ── Zero succeeded: nothing to collate (§6.6) ─────────────────────────────
  //
  // No replies are published either. Three `0444` files in a `:ro` mount that no
  // brief names are three files nothing reads and nothing reaps, and the next
  // fan-out under a different parent would find them still there.
  if (survived.length === 0) {
    return {
      kind: "not_collated",
      reason:
        `no child succeeded, so there is nothing to collate and no collation task was ` +
        `dispatched (SRD-REVIEW-CONSOLE §6.6). The collator's own result for "${parent}" ` +
        `stands. Per lens: ` +
        children.map((c) => `${c.aspect} — ${c.note}`).join("; "),
      children,
    };
  }

  // ── Publish, THEN collate (D6) ────────────────────────────────────────────
  //
  // Ordering, not convention: the brief carries paths, so every path in it names
  // a file already on disk. Only surviving lenses get a reply — a file at a
  // reply path IS a lens as far as the collator can tell, so publishing an empty
  // one for a reviewer that timed out would hand it a fourth thing to read and a
  // reason to believe three lenses reported.
  for (const child of survived) {
    const harvested = result.get(child.aspect);
    if (harvested === undefined || child.taskId === null) continue;
    await transport.publishReply(collatorRun, child.taskId, harvested.reply);
  }

  const missingSeats = missing.map((c) => ({ worker: c.worker, aspect: c.aspect }));
  const claim = missing.length === 0 ? "success" : "partial";
  const collation: RelayDispatch = {
    worker: sender,
    taskId: collationId,
    title: `Collate the review of ${parent}`,
    brief: collationBrief(parent, children, claim),
  };

  // The collation is dispatched to a COLLATOR, which D7 forbids a REQUEST from
  // naming. There is no tension: D7 bounds what a container may ask the host to
  // do, and this is the host completing an exchange it started. The collator
  // cannot cause it — it can only cause the fan-out that leads here, once, which
  // is what `isCollationTaskId` above bounds.
  //
  // CAUGHT, and `collation_failed` explains why at length. The short form: a
  // throw from here discards the record of three reviews that actually ran, and
  // the next pass runs them again.
  try {
    await transport.dispatch(collatorRun, collation);
  } catch (err) {
    return {
      kind: "collation_failed",
      collation,
      claim,
      children,
      missing: missingSeats,
      reason:
        `every lens was dispatched and ${survived.length} reply/replies were published, but the ` +
        `collation "${collation.taskId}" could not be delivered to "${sender}": ` +
        `${err instanceof Error ? err.message : String(err)}. The reviews are NOT re-run — the ` +
        `children are journalled because they happened — so the reports stand in the collator's ` +
        `/replies mount with nothing yet telling it to read them.`,
    };
  }

  return { kind: "collated", collation, claim, children, missing: missingSeats };
}

/**
 * The collation brief — and the missing-lens clause is the load-bearing part.
 *
 * §6.6: *"The collator must be told in its brief which aspects are missing,
 * because a collator that does not know it is missing a lens will write a
 * confident three-lens conclusion from two — and `report` has no way to detect
 * that."*
 *
 * So the missing lenses are named on their own lines, in a form that is ABSENT
 * for the lenses that reported. A brief that listed all three unconditionally
 * would satisfy "the brief names the aspect" and communicate nothing, which is
 * why `collator-relay.test.ts` asserts the negative alongside the positive.
 *
 * The claimed status is stated rather than implied for the same reason it
 * matters at all: because the lattice combines by `min`, an honest `partial` can
 * never be lifted back to `success` by anything downstream
 * (`adjudicate.ts:14`) — and equally, a `success` claimed over two lenses can
 * never be corrected. There is one chance to say this and it is here.
 */
function collationBrief(
  parent: string,
  children: readonly RelayChild[],
  claim: "success" | "partial",
): string {
  const survived = children.filter((c) => c.succeeded);
  const missing = children.filter((c) => !c.succeeded);
  const lines: string[] = [];

  lines.push(`Collate the reviews dispatched from task ${parent}.`);
  lines.push("");
  lines.push(
    `This console has ${children.length} review lenses. ${survived.length} produced a report; ` +
      `${missing.length} did not.`,
  );
  lines.push("");
  lines.push("REPORTS — read each of these files. They are the only reports that exist:");
  for (const c of survived) {
    if (c.taskId === null) continue;
    lines.push(`  - ${c.aspect} (${c.worker}): ${replyMountPath(c.taskId)}`);
  }

  if (missing.length > 0) {
    lines.push("");
    for (const c of missing) {
      lines.push(`MISSING ASPECT: ${c.aspect} (${c.worker}) — ${c.note}.`);
    }
    lines.push("");
    lines.push(
      `You are collating WITHOUT ${missing.map((c) => c.aspect).join(", ")}. Do not write a ` +
        `conclusion that implies ${missing.length === 1 ? "that lens was" : "those lenses were"} ` +
        `applied, and say in your findings which lenses each one rests on.`,
    );
  }

  lines.push("");
  lines.push(`Write your result envelope with status: ${JSON.stringify(claim)}.`);
  return lines.join("\n");
}

// ===========================================================================
// THE PRODUCTION ADAPTER — `consoleFanOut` and the four host effects.
// ===========================================================================
//
// Everything above this line is pure and holds the run as an opaque type
// parameter. Everything below it is the half that touches the host, and it is
// in THIS file rather than a module of its own for the reason
// `src/cli/commands/relay.ts` gives when it names the symbol it looks up:
// `RelayTransport` is declared here, and splitting an interface from its only
// implementation across two modules is how the two drift.
//
// ## Why the four real modules are imported LAZILY and not at the top
//
// The module docblock says relay is kept free of `paths.ts`, and that "is what
// lets a test drive the whole join with three strings". That property is
// load-bearing for `collator-relay.test.ts`, which imports this file: a static
// import of `harvest/index.ts` would pull the repository-cloning, container-
// running half of the codebase into the import graph of a suite whose whole
// point is that it needs none of it.
//
// So the four production effects are resolved by a memoised dynamic import on
// FIRST USE. The types come in through `import type`, which is erased, so the
// compile-time coupling is complete and the runtime coupling is zero until
// somebody actually dispatches something. `import type { RelayFanOutInput }`
// from the CLI is the same trick doing something sharper: that module
// dynamically imports THIS one, so a value import would be a genuine cycle.

/**
 * A task record, as much of it as the poll needs.
 *
 * Structural rather than `TaskRecord` itself, so nothing here depends on
 * `state.ts` at runtime. The real record satisfies it by having a `verdict`,
 * and the production wiring below is where that is checked by the compiler.
 */
export interface RelayTaskRecordView {
  readonly verdict: Verdict;
}

/** A harvest bundle, likewise — `TaskHarvest` satisfies it. */
export interface RelayHarvestView {
  readonly harvest: { readonly verdict: Verdict };
}

/**
 * The host effects, one level below `RelayTransport`.
 *
 * `RelayTransport` is what the JOIN needs; this is what the transport needs.
 * The extra layer earns itself twice. It is where the injectable clock lives —
 * without which the deadline below could only be tested by waiting half an hour
 * for it — and it is what keeps every path derivation out of this module: each
 * method takes a run and a worker and resolves its own path, so `paths.ts` is
 * named in the production wiring and nowhere else.
 */
/**
 * What one dispatch attempt turned out to be — `SendOutcome`, narrowed to the
 * fields the join can act on.
 *
 * **`via` is carried even though nothing here branches on it, and that is the
 * point.** `rpc`, `pane` and `staged` are three different claims about how a
 * prompt reached a worker, and all three can arrive with `accepted: true`. A
 * shape that dropped the field would make a staged dispatch and an RPC one
 * literally indistinguishable to a test — which is precisely how an adapter
 * that could only speak RPC passed a suite that thought it covered dispatch.
 */
/**
 * How a prompt reaches a worker — and the only classification the relay makes.
 *
 * `"typed"` is not a plane `dispatch.ts` names; it is this module's word for
 * `planDispatch`'s `pane` with `adopted_terminal: false`, because from here the
 * interesting property is not which pane it is but that DELIVERY IS A KEYSTROKE
 * STREAM CARRYING THE PAYLOAD.
 */
export type RelayDeliveryPlane = "rpc" | "staged" | "typed" | "unknown";

export interface RelaySendOutcome {
  readonly accepted: boolean;
  readonly via: "rpc" | "pane" | "staged";
  readonly reason: string | null;
  readonly error: string | null;
  readonly epoch: number | null;
}

export interface RelayEffects {
  /**
   * Send one task to one worker, by whatever plane that worker actually has.
   *
   * **This is `sendTaskEnvelope` and it must not be anything narrower.** The
   * seam used to be `controlCall`, which is the RPC half of a two-plane
   * decision — and choosing the plane is not this module's to make. See
   * `consoleTransport`'s `dispatch` for what that cost.
   */
  sendTask(run: RunPaths, worker: string, dispatch: RelayDispatch): Promise<RelaySendOutcome>;
  /**
   * How a prompt would reach this worker, asked BEFORE anything is sent.
   *
   * **A preflight and not a post-check, because on the typed plane the damage is
   * done by the time `sendTask` returns.** `sendViaPane`'s non-adopted branch
   * builds a keystroke plan from the whole rendered prompt and types it line by
   * line, then presses Enter; the `via: "pane"` in its answer is a report of
   * what already happened. Reading it after the fact would name the hazard, not
   * prevent it.
   *
   * `"typed"` is the non-adopted `tui` pane. `"staged"` is the adopted one —
   * safe, because only `STAGED_TRIGGER_LINE` reaches the surface. `"rpc"` is the
   * control socket. `"unknown"` is a launch record whose marks disagree, which
   * `planDispatch` already refuses to guess about, and which this refuses too.
   */
  deliveryPlane(run: RunPaths, worker: string): Promise<RelayDeliveryPlane>;
  /** `readTaskRecord(taskRecordPath(workerPaths(run, worker), taskId))`. */
  readTaskRecord(
    run: RunPaths,
    worker: string,
    taskId: string,
  ): Promise<RelayTaskRecordView | null>;
  /** `harvestTask(run, taskId)` — harvest/index.ts. */
  harvestTask(run: RunPaths, taskId: string): Promise<RelayHarvestView>;
  /** `writeReply(workerRepliesDir(run.root, collator), childTaskId, reply)`. */
  writeReply(run: RunPaths, collator: string, childTaskId: string, reply: unknown): Promise<void>;
  /** Milliseconds. Injected so the deadline below needs no wall clock to test. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The poll interval, and it is `wait.ts:25`'s number deliberately.
 *
 * §6.5 records that `pifleet wait` polls `readTaskRecord` in a private closure
 * at 100 ms and that there is no helper to import — which is the whole reason
 * `awaitSettled` is a seam rather than a call. Spelling the same interval is
 * the honest way to reuse a decision that cannot be imported: two pollers over
 * the same file at different rates would be two answers to a question nobody
 * knew had been asked twice.
 */
export const RELAY_SETTLE_POLL_MS = 100;

/**
 * How long the join waits before it stops believing a child will settle.
 *
 * **§6.7's `deadline_s`, which defaults to 1800 (`contracts.ts:1770`) — but
 * armed HERE, at the call, and that difference is the entire reason this bound
 * exists at all.** The supervisor's own deadline is armed at the TRIGGER rather
 * than at stage, which `supervisor/index.ts` defends because "setting
 * `deadlineMs` at stage time would make a 20-minute task `timed_out` before it
 * begins". For a `pane_mode: tui` worker the trigger is a person typing in a
 * pane this process cannot see or reach — so under D13's implementation, where
 * all four panes are `tui`, the supervisor's deadline may never arm, no task
 * record may ever be written, and a poll with no bound of its own never
 * returns.
 *
 * **That premise was overstated and is corrected here.** On the staged route the
 * trigger IS normally typed, the turn starts, and the supervisor's deadline arms
 * like any other — so "the deadline may never arm" is the exception, not the
 * ordinary case. The exception is real but now handled one layer up: a stage
 * whose trigger could not be sent comes back `accepted: true` with an `error`,
 * and `dispatch` rejects it rather than letting the join wait out a keystroke
 * that is not coming.
 *
 * What this bound actually covers is therefore narrower and still worth having:
 * a supervisor that dies mid-turn, a turn that never settles, a task record that
 * never appears for a reason nobody predicted. It is a backstop against an actor
 * that stops, which is the same shape as the FIFO defect Phase 1 nearly shipped.
 *
 * **The ordering against the child's own deadline is what keeps it a backstop.**
 * The envelope this relay sends carries `deadline_s: 1500` — `dispatch.ts`'s
 * default for a task that names none, and the relay names none because D11
 * refuses the field in the request. 1800 > 1500, so the child settles
 * `timed_out` on its own clock first and the join observes a real record. If
 * either number moves, that ordering is the property to re-check.
 *
 * **On expiry this REJECTS rather than resolving, and the caller is why it
 * matters less than it looks.** `fanOut` joins with `Promise.allSettled` and
 * discards the outcomes, so a rejection here does NOT cost the lens directly —
 * the harvest still runs, finds no task record, and the lens goes missing by
 * the ordinary route with `verdict: "unknown"`. What rejecting buys is honesty
 * at this seam: resolving would assert a terminal state was observed, and the
 * next reader to build on `awaitSettled` would inherit that lie. What the bound
 * itself buys is that the actor gets to the harvest at all.
 */
export const RELAY_SETTLE_DEADLINE_MS = 1_800_000;

/**
 * A dispatch that did not land — and it exists because ONE of the two ways to
 * not land looks exactly like success.
 *
 * The dispatch path THROWS for an unreachable worker or a terminal that has
 * gone, which no implementation gets wrong. It also RESOLVES with
 * `{accepted: false, reason}` for a supervisor-side refusal, and an adapter
 * written as `await send(...)` treats that as a delivered prompt. The console
 * then joins, waits and harvests a task no worker was ever told about — every
 * lens reports `unknown`, and the failure is reported against the reviewers
 * rather than against the dispatch.
 *
 * `refusal` is the supervisor's own reason string, kept as a FIELD rather than
 * only in the message, because a caller — or a test — that had to match English
 * to tell one refusal from another would be pinning a sentence rather than a
 * rule.
 *
 * **`pane_mode_tui_has_no_rpc_dispatch` is NOT among the reasons this can now
 * carry, and that is a fix rather than an omission.** It was, when this
 * adapter spoke `cmd: "dispatch"` directly; see `consoleTransport`.
 */
export class RelayDispatchError extends Error {
  constructor(
    readonly worker: string,
    readonly taskId: string,
    /** The supervisor's refusal code, or `null` when the socket itself failed. */
    readonly refusal: string | null,
    detail: string,
  ) {
    super(`dispatch of ${taskId} to ${worker} did not land: ${detail}`);
    this.name = "RelayDispatchError";
  }
}

/** The join gave up on a child. See `RELAY_SETTLE_DEADLINE_MS`. */
export class RelaySettleTimeoutError extends Error {
  constructor(
    readonly worker: string,
    readonly taskId: string,
    readonly waitedMs: number,
  ) {
    super(
      `no task record for ${taskId} appeared under ${worker} within ${waitedMs} ms, so the join ` +
        `stopped waiting. Under §6.7 the supervisor's own deadline_s is armed at the TRIGGER, and ` +
        `a tui worker's trigger is a keystroke — so a task nobody started never settles and an ` +
        `unbounded wait here would wedge the actor rather than fail it.`,
    );
    this.name = "RelaySettleTimeoutError";
  }
}

/**
 * The attempt id for a relayed dispatch — DERIVED from the content, not minted.
 *
 * `dispatch.ts:139` spells this same construction as `attemptIdFor`, and it is
 * respelled here rather than imported for `MAX_RELAY_TASK_ID_CHARS`'s reason
 * one file over: that symbol lives in a commander command module, and importing
 * it would drag the CLI into the runtime graph of a module the CLI dynamically
 * imports.
 *
 * **Derived rather than random because the journal is written LAST.** That
 * ordering is `relay-journal.ts`'s and it is right — journalling first turns a
 * crash into a review that silently never happens — but its cost is that a
 * crash between the dispatch and the journal entry makes the next pass fan out
 * again. With a random attempt id that is three reviews run twice. With a
 * derived one the supervisor recognises the pair and REPLAYS, so the cost of
 * the safe ordering drops from a duplicate review to a no-op.
 *
 * **It does NOT match the staged route's own `attemptIdFor(JSON.stringify(partial))`
 * and an earlier version of this comment claimed it did.** The two strings
 * differ — different inputs, different prefixes. The replay property survives
 * anyway, and for a reason worth stating rather than assuming: `EpochManager`
 * keys attempts on `attemptKey(taskId, attemptId)`, and the task id is derived,
 * stable, and in the key. So each route replays against ITS OWN previous
 * attempt, which is all either of them needs; what would break is a task
 * re-dispatched across two different planes, which this console never does.
 */
function relayAttemptId(worker: string, dispatch: RelayDispatch): string {
  const content = JSON.stringify([worker, dispatch.taskId, dispatch.title, dispatch.brief]);
  return `relay:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

/**
 * The four host effects, satisfied.
 *
 * `collator` is closed over rather than passed, and that is what makes
 * `publishReply(collatorRun, childTaskId, reply)` implementable at all: the
 * reply belongs in the collator's own replies directory, the signature carries
 * the run but not the worker, and the collator is a property of the REQUEST —
 * one per fan-out — rather than of the console. Inverting the worker→run map to
 * recover it would give the wrong answer the moment two workers share a run.
 */
export function consoleTransport(
  collator: string,
  effects: RelayEffects,
  opts: { deadlineMs?: number; pollMs?: number } = {},
): RelayTransport<RunPaths> {
  const deadlineMs = opts.deadlineMs ?? RELAY_SETTLE_DEADLINE_MS;
  const pollMs = opts.pollMs ?? RELAY_SETTLE_POLL_MS;

  return {
    /**
     * **THE PLANE IS NOT THIS MODULE'S TO CHOOSE, AND CHOOSING IT WAS A BUG.**
     *
     * This method used to call `controlCall(run, worker, {cmd: "dispatch", …})`
     * directly. That is the RPC half of a two-plane decision, and the decision
     * belongs to `planDispatch`, which reads the launch record `up` actually
     * wrote. An attended worker has NO RPC dispatch surface — the supervisor
     * answers `pane_mode_tui_has_no_rpc_dispatch`, correctly, because the
     * question is wrong. Its envelope is STAGED instead: written into its
     * read-only policy plane with the allocated epoch, recorded in the inbox,
     * and followed by a one-line trigger at the surface. `via: "staged"` is a
     * success, and a third distinct claim rather than a weaker `pane`.
     *
     * **D13 makes all four review-console panes `tui`, so the old spelling was
     * refused for every seat on the console — not merely for the collation.**
     * Every lens would come back `unknown`, the fan-out would journal three
     * children it never dispatched, and the console would be indistinguishable
     * from a working one on every observable it has. That is §6.4's own failure
     * shape — "a collator that dispatched three reviews is indistinguishable
     * from one that dispatched none" — reached from the host's side.
     *
     * So the effect is `sendTaskEnvelope`, which is THE dispatch path: it reads
     * the launch record, routes, builds the envelope from the worktree record,
     * writes the durable inbox entry on BOTH planes, and appends the ledger
     * row. Nothing about which plane a worker has is decided here, and nothing
     * about an envelope is spelled here twice.
     */
    async dispatch(run: RunPaths, d: RelayDispatch): Promise<void> {
      /**
       * ── PREFLIGHT: is this delivery SAFE? ────────────────────────────────
       *
       * **`d.brief` is written by a container and this is the one plane that
       * TYPES it.** `dispatch-request.ts` says outright that it does not
       * sanitize `title` or `brief` — deliberately, because the staged drop's
       * contract is byte-identity with the RPC route. That is sound while the
       * payload is written to a file. `sendViaPane`'s non-adopted branch instead
       * splits the rendered prompt on newlines and types every line into the
       * surface, then presses Enter. `assertPaneTypeableLine` bounds length and
       * refuses C0/DEL and embedded newlines; it permits every shell
       * metacharacter there is.
       *
       * And the surface is not reliably the agent. `docker attach
       * --detach-keys=ctrl-]` makes detach a single keypress pifleet cannot
       * observe, and after it — or after the container exits — the pane hosts
       * the operator's own shell. `stageForAdoptedTerminal`'s safety argument
       * says this in as many words: what may land in a shell is
       * `STAGED_TRIGGER_LINE`, which begins `#` and cannot execute, *"rather
       * than a markdown brief delivered line by line"*. On this branch it is
       * exactly the markdown brief, delivered line by line.
       *
       * So it is refused, before a byte is sent, and refused for the run rather
       * than the fleet: one lens is lost and the collation says so.
       *
       * ## Why this is not the mistake the previous docblock warned about
       *
       * That docblock said to examine `accepted` and nothing else, because a
       * guard requiring a particular plane is how the console came to refuse
       * every `tui` worker. It was right about the question it was answering and
       * too broad for the question it was not. There are THREE questions here
       * and only the first is about preference:
       *
       *   1. **Which plane should the relay PREFER?** None. `sendTaskEnvelope`
       *      reads the launch record and decides; the relay must not.
       *   2. **Is this delivery SAFE for container-authored text?** Not on the
       *      typed plane, whatever the launch record prefers. Refusing one plane
       *      because its delivery mechanism is a keystroke stream is not a
       *      preference between planes.
       *   3. **Did it actually HAPPEN?** `accepted` alone does not answer this
       *      either — see the deferred trigger below.
       */
      const plane = await effects.deliveryPlane(run, d.worker);
      if (plane === "typed" || plane === "unknown") {
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          plane === "typed" ? "pane_delivery_types_the_brief" : "delivery_plane_unknown",
          plane === "typed"
            ? `"${d.worker}" is a tui pane with no adopted terminal, so its prompt is DELIVERED BY ` +
              `TYPING — every line of the brief, then Enter. This brief was written by a container ` +
              `and is not sanitized, and a detached or exited pane hosts the operator's shell. ` +
              `Nothing was sent. Give the worker an adopted terminal (\`up --attach-here\`) so its ` +
              `dispatches are STAGED, where only a comment line reaches the surface.`
            : `the launch record for "${d.worker}" names neither a consistent rpc nor a consistent ` +
              `tui shape, so how its prompt would be delivered is unknown. Nothing was sent — a ` +
              `guess here is a guess about whether a container's brief gets typed into a shell.`,
        );
      }

      let outcome: RelaySendOutcome;
      try {
        outcome = await effects.sendTask(run, d.worker, d);
      } catch (err) {
        // Shape one: it threw. An unreachable supervisor, a launch record that
        // names neither plane, a terminal that has gone — from the join's point
        // of view they all cost the same one lens.
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          null,
          err instanceof Error ? err.message : String(err),
        );
      }

      // Shape two, and the one that reads as success: a RESOLVED refusal.
      if (!outcome.accepted) {
        const refusal = outcome.reason ?? "rejected";
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          refusal,
          `${refusal} (${outcome.error ?? refusal})`,
        );
      }

      /**
       * BACKSTOP for the preflight. Reached only if the launch record and the
       * route disagree, which the preflight cannot rule out because they are two
       * reads at two moments. It is too late to prevent the typing — that is
       * what the preflight is for — but a lens whose brief was typed into a
       * surface must not then be counted, waited on and collated as though it
       * were a review.
       */
      if (outcome.via === "pane") {
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          "pane_delivery_types_the_brief",
          `the dispatch to "${d.worker}" was delivered by TYPING the brief into its pane. The ` +
            `preflight is meant to make this unreachable; reaching it means the launch record ` +
            `changed under the pass. The lens is dropped rather than collated.`,
        );
      }

      /**
       * ── Shape three: ACCEPTED, and it still did not happen. ──────────────
       *
       * `stageForAdoptedTerminal` returns `accepted: true` with
       * `error: trigger.reason` when the drop is durable but the trigger line
       * could not be typed — which is every adopted terminal that announces no
       * pane id: Terminal.app, ssh, a bare tmux pane. The envelope is on disk and
       * a person can run the task; nothing is running now.
       *
       * **Counting that as landed is a thirty-minute stall and then a lost
       * lens.** `awaitSettled` would poll for a task record that cannot appear
       * until a human types the line, for the full deadline, and `relayPass` is
       * serial — three of them stop the actor for an hour and a half.
       *
       * So it is a rejection, and the trigger instruction travels in the message
       * because it is the one thing that lets the operator rescue the review.
       * The refusal code is the supervisor's own ledger event name, so a caller
       * matches a rule rather than a sentence. On the next pass the derived
       * attempt id makes the re-stage a REPLAY, so retrying costs nothing and
       * may find the trigger has since been typed.
       */
      if (outcome.error !== null) {
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          "stage_trigger_deferred",
          `"${d.taskId}" was STAGED for "${d.worker}" but its turn was never triggered, so no task ` +
            `record can appear and the join would wait out its whole deadline for a keystroke: ` +
            `${outcome.error}`,
        );
      }
    },

    async awaitSettled(run: RunPaths, task: RelayTaskRef): Promise<void> {
      const started = effects.now();
      for (;;) {
        const record = await effects.readTaskRecord(run, task.worker, task.taskId);
        if (record !== null) return;
        // Checked BEFORE the sleep and against the time already spent, so the
        // bound is the deadline rather than the deadline plus one interval —
        // and so a zero deadline gives up immediately instead of polling once.
        if (effects.now() - started >= deadlineMs) {
          throw new RelaySettleTimeoutError(task.worker, task.taskId, effects.now() - started);
        }
        await effects.sleep(pollMs);
      }
    },

    async harvest(run: RunPaths, task: RelayTaskRef): Promise<RelayHarvest> {
      const bundle = await effects.harvestTask(run, task.taskId);
      return {
        /**
         * VERBATIM. `timed_out` and `aborted` are supervisor verdicts and are
         * carried through unchanged — folding them to `failed` would make the
         * record say a reviewer produced a failing review when what happened is
         * that it never reported, and it reddens `RelayChild`'s tests one layer
         * up. `harvestStatus` is deliberately not consulted: an untrustworthy
         * harvest already yields `unknown`, so a second test would be a second
         * rule for one fact.
         */
        verdict: bundle.harvest.verdict,
        /**
         * The WHOLE bundle is the reply, not the verdict. `replies.ts` pretty-
         * prints on the argument that "the reader is a model with the file's
         * whole contents in one gulp" and names "a nested harvest record" as
         * the thing it is formatting — this is that record.
         */
        reply: bundle,
      };
    },

    async publishReply(collatorRun: RunPaths, child: string, reply: unknown): Promise<void> {
      // `writeReply` and never a reimplementation of it: it owns the
      // chmod-0644 → truncate-in-place → chmod-0444 recipe, and the recipe is
      // truncate-in-place because a bind mount pins the INODE. A write-and-
      // rename would leave the collator's mount showing the old file forever.
      await effects.writeReply(collatorRun, collator, child, reply);
    },
  };
}

/**
 * worker → run, for D4's four runs.
 *
 * Every input is injected, so this is testable without a runs directory — and
 * more importantly, so the SEARCH ORDER is testable, which is the part with a
 * wrong answer that works most of the time.
 *
 * The collator's own run is used for the collator without a search, and is
 * tried first for everyone else. That is not an optimisation: a console
 * assembled as one run (a fixture, a `scripts/` driver, any future single-run
 * arrangement) resolves entirely from it, and a console assembled as four
 * resolves the collator from the run the request was READ from — which is the
 * only run in the whole set this process can be certain about.
 *
 * **A worker no run holds is left OUT of the map rather than defaulted.** The
 * core answers a missing entry with `run_unresolved`, which the poll declines
 * to journal and retries on the next tick — and "the console is still coming
 * up" is exactly the state that produces it. The plausible fallback, using the
 * collator's run, is the one that must not be written: the collator's
 * supervisor would ACCEPT a reviewer's task, and three lenses would be one
 * worker with three transcripts.
 */
/**
 * The map, plus the workers it REFUSED to resolve and why.
 *
 * Ambiguity is returned rather than swallowed so the fan-out's refusal can name
 * the competing runs. A worker that is merely absent and one that matched three
 * runs are both missing from `runs`, and only the second is an operator's
 * problem to disambiguate.
 */
export interface ConsoleRunMap {
  readonly runs: ReadonlyMap<string, RunPaths>;
  /** worker → the run ids that all hold it. Never has a single-element entry. */
  readonly ambiguous: ReadonlyMap<string, readonly string[]>;
}

export async function resolveConsoleRuns(input: {
  readonly collator: string;
  readonly collatorRun: RunPaths;
  readonly workers: readonly string[];
  /** Candidate runs. ORDER IS NOT A TIEBREAK — see the scan below. */
  listRuns(): Promise<readonly RunPaths[]>;
  hasWorker(run: RunPaths, worker: string): Promise<boolean>;
}): Promise<ConsoleRunMap> {
  const runs = new Map<string, RunPaths>();
  const ambiguous = new Map<string, readonly string[]>();
  const unresolved: string[] = [];

  for (const worker of input.workers) {
    if (worker === input.collator) {
      runs.set(worker, input.collatorRun);
      continue;
    }
    if (await input.hasWorker(input.collatorRun, worker)) {
      runs.set(worker, input.collatorRun);
      continue;
    }
    unresolved.push(worker);
  }

  // The scan happens at most once, and only if something is actually missing.
  // Listing the runs root per worker would re-stat every run in the fleet three
  // times per tick for an answer that cannot differ between them.
  if (unresolved.length > 0) {
    const candidates = await input.listRuns();
    for (const worker of unresolved) {
      /**
       * EVERY match, then refuse if there is more than one — never "the newest
       * wins".
       *
       * **This is an authority decision wearing the clothes of a lookup.** Worker
       * ids are not unique across runs; two consoles stand side by side and are
       * told apart by run, not by worker id. So a scan that takes the newest
       * candidate resolves `rev-arch-1` to whichever run most recently
       * materialised that id — including an unrelated fleet a colleague brought
       * up a minute ago, and including a dead run, since `down` removes
       * containers and not directories.
       *
       * What follows a wrong answer is not a failed dispatch. It is a review
       * dispatched into ANOTHER run's worker: that run's control secret, that
       * run's tool grant, that run's model, that run's repository graded — and
       * the reply harvested back into this console and collated as this
       * console's lens. D11's whole argument is that the model and the grant
       * were validated at `up`, and that validation is per-run. Nothing
       * downstream can detect the crossing.
       *
       * A refusal costs a tick and names both runs. Picking one costs the
       * property the console exists to provide, silently. The operator's fix is
       * to say which run they meant.
       */
      const matches: RunPaths[] = [];
      for (const run of candidates) {
        if (await input.hasWorker(run, worker)) matches.push(run);
      }
      if (matches.length === 1) {
        runs.set(worker, matches[0]!);
        continue;
      }
      if (matches.length > 1) {
        ambiguous.set(
          worker,
          matches.map((r) => r.runId),
        );
      }
    }
  }
  return { runs, ambiguous };
}

/**
 * `relayFanOut`'s three outcomes, in the two shapes the JOURNAL tells apart.
 *
 * `not_collated` maps to `dispatched` and the direction reads backwards until
 * you hold it against the journal's purpose: a fan-out where zero children
 * succeeded dispatched no COLLATION, but it did dispatch the three children.
 * Recording it as `not_dispatched` would have the relay reissue three reviews
 * on the next tick for a request that already consumed them.
 *
 * `refused` maps to `not_dispatched` for the mirror reason: nothing was
 * issued, so a journal entry would mark a fan-out complete that never happened
 * — and under D5 the collator has already settled, so nothing downstream would
 * ever notice.
 */
function toFanOutResult(outcome: RelayOutcome): RelayFanOutResult {
  /**
   * `none_landed` joins `refused` here, and it is the whole of the fix.
   *
   * Both mean NOTHING IS RUNNING, which is the only question the journal is
   * entitled to ask. `not_collated` reads as their neighbour and is their
   * opposite: three tasks exist and must not be re-issued. Before this arm
   * existed the three shared one code path, and the case that must never be
   * journalled was journalled — `already_done` forever, reviews never run.
   */
  if (outcome.kind === "refused" || outcome.kind === "none_landed") {
    return { kind: "not_dispatched", reason: outcome.reason };
  }
  /**
   * ISSUED ONLY — and filtering on `issued` rather than on `taskId !== null` is
   * the correction, not a tidy-up.
   *
   * `taskId` is populated when a lens is PLANNED and survives a dispatch that
   * was refused, so the null filter alone recorded the ids the fan-out INTENDED.
   * `relay-journal.ts` describes this list as "the child task ids the fan-out
   * issued … written by the thing that actually performed the dispatches" — the
   * host's independent copy of what really happened, and the whole point of
   * having it is that it was produced by the party that did the work rather than
   * by the model that asked for it. A planned id in that slot makes it a second
   * copy of the request.
   *
   * The COLLATION id is deliberately absent too: the collation is the host's own
   * follow-up rather than something the request bought.
   */
  const children = outcome.children
    .filter((c) => c.issued)
    .map((c) => c.taskId)
    .filter((id): id is string => id !== null);
  /**
   * `collation_failed` is `dispatched` PLUS a reason, and both halves matter.
   *
   * `dispatched` is what journals the three children, which is the point of the
   * arm. The reason is what stops that being a silent success: a pass whose last
   * hop failed and a pass that completed are otherwise identical rows — same
   * kind, same children — so without this field the distinction exists in the
   * core and dies at the boundary.
   *
   * `not_collated` deliberately does NOT get one. Zero survivors means there was
   * nothing to collate, which is §6.6 working; attaching a reason there would
   * make the field mean "something went wrong" in one case and "nothing needed
   * doing" in the other, and a field with two meanings is read as neither.
   */
  if (outcome.kind === "collation_failed") {
    return { kind: "dispatched", children, reason: outcome.reason };
  }
  return { kind: "dispatched", children };
}

/**
 * The adapter, over injected composition. `consoleFanOut` is this with the real
 * effects bound; the seam is here so the mapping above can be tested against a
 * fan-out driven by closures rather than by a fleet.
 */
export function makeConsoleFanOut(deps: {
  resolveRuns(input: RelayFanOutInput): Promise<ConsoleRunMap>;
  transport(collator: string): RelayTransport<RunPaths>;
  aspects?: readonly AspectSeat[];
}): (input: RelayFanOutInput) => Promise<RelayFanOutResult> {
  return async (input: RelayFanOutInput): Promise<RelayFanOutResult> => {
    const { runs, ambiguous } = await deps.resolveRuns(input);

    /**
     * FAIL CLOSED on any ambiguity, before a single dispatch.
     *
     * Not "only if this request needs the ambiguous seat": a console in which
     * one worker id resolves to two live runs is a console whose identity is
     * unsettled, and dispatching the seats that happen to be unambiguous would
     * produce a review whose lenses came from two different fleets — with a
     * consensus count that reads as corroboration.
     *
     * `not_dispatched`, so nothing is journalled and the pass retries: the
     * operator's remedy is to say which runs are theirs (`PIFLEET_RELAY_RUNS`),
     * or to bring the other console down.
     */
    if (ambiguous.size > 0) {
      const detail = [...ambiguous.entries()]
        .map(([worker, ids]) => `"${worker}" is held by ${ids.join(", ")}`)
        .join("; ");
      return {
        kind: "not_dispatched",
        reason:
          `the worker→run map is ambiguous, so nothing was dispatched: ${detail}. Worker ids are ` +
          `not unique across runs and this console is four of them (D4), so choosing one would ` +
          `dispatch a review into another fleet's worker — its control secret, its tool grant, ` +
          `its model, its repository — and collate the reply here as though it were this ` +
          `console's lens. Pin the map with PIFLEET_RELAY_RUNS=worker=runId,... or stop the ` +
          `other console.`,
      };
    }

    const outcome = await relayFanOut<RunPaths>({
      request: input.request,
      sender: input.sender,
      runs,
      transport: deps.transport(input.sender),
      ...(deps.aspects === undefined ? {} : { aspects: deps.aspects }),
    });
    return toFanOutResult(outcome);
  };
}

/**
 * Where the production map comes from, as four injected reads.
 *
 * **Extracted from `consoleFanOut`'s closure because that closure was
 * unexecuted by every test in the suite.** The only case touching
 * `consoleFanOut` asserts `typeof === "function"`, which CONSTRUCTS the closure
 * and never calls it — so `runsRoot()`, the run listing, the newest-first
 * ordering and the liveness probe were all unreachable from a unit test while
 * looking covered by association with `resolveConsoleRuns`, which is a
 * different function taking those same things as parameters.
 *
 * That is the producer half of the scan hazard: `resolveConsoleRuns` was well
 * tested on the CONSUMER side (given these candidates, what does it decide) and
 * the side that decides what the candidates ARE had no test at all.
 */
export interface ConsoleRunSources {
  runsRoot(): string;
  /** Run ids, OLDEST first — `runIdsAscending`'s order, reversed below. */
  listRunIds(root: string): Promise<readonly string[]>;
  runPathsFor(runId: string, root: string): RunPaths;
  /** Is this worker LIVE in this run — a supervisor actually holding the seat. */
  isLiveWorker(run: RunPaths, worker: string): Promise<boolean>;
  /** `PIFLEET_RELAY_RUNS`, or undefined. */
  pinnedRuns(): string | undefined;
}

/**
 * The console's worker→run map, from the host.
 *
 * **Newest first, and what that is FOR has changed — so the comment has
 * changed with it.** It used to be the tiebreak: the newest run holding an id
 * won, which is how an unrelated fleet captured a seat. Ambiguity is now
 * REFUSED, so ordering decides nothing about resolution — a worker resolves
 * only when exactly one live run holds it, and one is one in any order.
 *
 * It is kept because it orders the REFUSAL: the operator reading "held by X, Y"
 * sees the most recently started run first, which is almost always the one they
 * just brought up and were thinking of. That is a real property and it is
 * asserted rather than asserted-in-prose — `collator-relay-adapter.test.ts`
 * pins the order of the reported ids, so deleting the `reverse()` reddens.
 */
export async function consoleRunResolution(
  input: RelayFanOutInput,
  src: ConsoleRunSources,
): Promise<ConsoleRunMap> {
  const root = src.runsRoot();
  const workers = [input.sender, ...REVIEW_CONSOLE_ASPECTS.map((s) => s.worker)];

  /**
   * AN EXPLICIT MAP WINS, and it is the shape the SRD actually asked for.
   *
   * §6.5's preferred home is "a new `pifleet relay --console review` process,
   * started by `scripts/review`" whose merit is that it "holds the worker→run
   * map THE SCRIPT ALREADY COMPUTES". The scan below exists because that flag
   * does not, and it is strictly the weaker answer: the script knows which four
   * runs it created, and the scan can only infer from what is on disk.
   */
  const pinned = relayRunPins(src.pinnedRuns());
  if (pinned !== null) {
    const runs = new Map<string, RunPaths>();
    for (const worker of workers) {
      if (worker === input.sender) {
        runs.set(worker, input.run);
        continue;
      }
      const runId = pinned.get(worker);
      if (runId !== undefined) runs.set(worker, src.runPathsFor(runId, root));
    }
    return { runs, ambiguous: new Map<string, readonly string[]>() };
  }

  return resolveConsoleRuns({
    collator: input.sender,
    collatorRun: input.run,
    workers,
    listRuns: async () => {
      const ids = [...(await src.listRunIds(root))].reverse();
      return ids.map((id) => src.runPathsFor(id, root));
    },
    hasWorker: (run, worker) => src.isLiveWorker(run, worker),
  });
}

/**
 * `PIFLEET_RELAY_RUNS` — `worker=runId` pairs, comma separated, or `null` when
 * unset.
 *
 * The escape hatch §6.5 wanted and the shipped CLI has no flag for. A malformed
 * entry is ignored rather than fatal for one reason only: this is a hint that
 * REPLACES a guess, and a typo that fell back to the host-wide scan would be
 * worse than one that leaves a worker unresolved. An unresolved worker refuses
 * loudly; a silent fallback is the defect this whole mechanism exists to close.
 */
function relayRunPins(raw: string | undefined): Map<string, string> | null {
  if (raw === undefined || raw.trim() === "") return null;
  const pins = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const worker = pair.slice(0, at).trim();
    const runId = pair.slice(at + 1).trim();
    if (worker !== "" && runId !== "") pins.set(worker, runId);
  }
  return pins;
}

/**
 * The real modules, resolved ONCE on first use.
 *
 * Dynamic and memoised for the reason the section header gives: a static import
 * of `harvest/index.ts` and `supervisor/launch.ts` would put the container- and
 * git-driving half of the repository into the import graph of every test that
 * imports this file — including `collator-relay.test.ts`, whose stated property
 * is that it drives the whole join with three strings.
 *
 * The promise is cached rather than the modules, so two concurrent first calls
 * share one resolution instead of racing to build two.
 */
let effectModules: Promise<{
  dispatch: typeof import("../cli/commands/dispatch.ts");
  harvest: typeof import("../harvest/index.ts");
  state: typeof import("./state.ts");
  paths: typeof import("./paths.ts");
  replies: typeof import("./replies.ts");
  ledger: typeof import("./ledger.ts");
  registry: typeof import("./registry.ts");
  interrupt: typeof import("../container/interrupt.ts");
}> | null = null;

function loadEffectModules(): NonNullable<typeof effectModules> {
  effectModules ??= (async () => ({
    dispatch: await import("../cli/commands/dispatch.ts"),
    harvest: await import("../harvest/index.ts"),
    state: await import("./state.ts"),
    paths: await import("./paths.ts"),
    replies: await import("./replies.ts"),
    ledger: await import("./ledger.ts"),
    registry: await import("./registry.ts"),
    interrupt: await import("../container/interrupt.ts"),
  }))();
  return effectModules;
}

/**
 * The four host effects, for real.
 *
 * Every path in the console is derived HERE and nowhere else, which is what
 * lets the module above stay free of `paths.ts` — the property its docblock
 * calls load-bearing for the unit suite.
 */
export const productionRelayEffects: RelayEffects = {
  /**
   * `sendTaskEnvelope` — THE dispatch path, and the whole of the plane
   * decision.
   *
   * Its own docblock is the argument for calling it rather than reproducing
   * it: *"the single-task command and the `--auto` scheduler both come through
   * it, so envelope defaults, the inbox record and the ledger row cannot drift
   * between them"*. The relay is now the third caller and inherits that
   * property instead of becoming the exception to it — which matters most for
   * the two envelope fields a hand-rolled copy gets wrong quietly:
   * `host_workdir` and `base_ref` come from the worktree record, and an
   * envelope carrying the schema's `"unset"` and forty zeroes harvests
   * `repository: false` for a reviewer that has a perfectly good checkout.
   *
   * It also writes the durable inbox entry on BOTH planes. Without that,
   * `harvestTask` finds no envelope and answers `unavailableHarvest`, so every
   * lens of every fan-out comes back `unknown`.
   *
   * `requestedEpoch: null` always — the supervisor is the sole epoch allocator
   * (§7.5). `attemptId` is derived rather than random so a pass that crashed
   * between the dispatch and the journal REPLAYS instead of running the review
   * twice; on the staged plane `sendTaskEnvelope` derives its own for the same
   * reason, and the two agree by construction.
   */
  async sendTask(run, worker, d) {
    const m = await loadEffectModules();
    const out = await m.dispatch.sendTaskEnvelope({
      run,
      worker,
      taskId: d.taskId,
      // Title and brief ONLY. Every other field is host-side, and `deadline_s`
      // especially so: D11 refuses both spellings of it in the request document
      // because "a request that could set it can pin three of the largest
      // models in the catalogue open against the operator's API key".
      partial: { title: d.title, brief: d.brief },
      attemptId: relayAttemptId(worker, d),
      requestedEpoch: null,
      ledger: new m.ledger.LedgerWriter(run, `relay-${process.pid}`),
    });
    return {
      accepted: out.accepted,
      via: out.via,
      reason: out.reason,
      error: out.error,
      epoch: out.epoch,
    };
  },
  /**
   * The two reads `sendViaPane` makes, made one moment earlier.
   *
   * `launchPaneMode` is imported rather than reproduced — it owns the
   * field-plus-two-marks agreement rule, and a second copy here is how this
   * module and `dispatch.ts` would come to disagree about which plane a worker
   * has. `launch === null` is the `PIFLEET_PI_COMMAND` double, which `planDispatch`
   * and the supervisor both call `rpc`; this agrees with them rather than
   * re-deriving it.
   *
   * The `adopted_terminal` read is the one that matters: it is the exact
   * predicate `sendViaPane` branches on, so "staged" here means "that function
   * will take the staged fork" rather than a guess about it.
   */
  async deliveryPlane(run, worker) {
    const m = await loadEffectModules();
    const wp = m.paths.workerPaths(run, worker);
    const launch = await m.state.readWorkerLaunch(wp);
    if (launch === null) return "rpc";
    const mode = m.interrupt.launchPaneMode(launch);
    if (mode === "rpc") return "rpc";
    if (mode === "unknown") return "unknown";
    const presentation = await m.state.readPresentation(wp);
    return presentation?.adopted_terminal === true ? "staged" : "typed";
  },
  async readTaskRecord(run, worker, taskId) {
    const m = await loadEffectModules();
    return m.state.readTaskRecord(
      m.paths.taskRecordPath(m.paths.workerPaths(run, worker), taskId),
    );
  },
  async harvestTask(run, taskId) {
    const m = await loadEffectModules();
    return m.harvest.harvestTask(run, taskId);
  },
  async writeReply(run, collator, childTaskId, reply) {
    const m = await loadEffectModules();
    const dir = m.paths.workerRepliesDir(run.root, collator);
    try {
      await m.replies.writeReply(dir, childTaskId, reply);
    } catch (err) {
      /**
       * A MISSING REPLIES DIRECTORY IS DIAGNOSED, NOT CREATED — and the
       * distinction is the whole of D6's failure mode.
       *
       * `createRepliesDir` is `materialize.ts`'s, called BEFORE `docker run`,
       * and its docblock says why the ordering rather than the mkdir is the
       * point: "Docker CREATES a missing bind-mount source instead of refusing,
       * so a `-v` whose host directory nobody made comes up as an empty
       * `/replies` that can never gain content". So if this directory is absent
       * NOW, the collator's container was never started against it — and an
       * adapter that helpfully created one would write three reports into a
       * directory nothing is mounted from. The host would record a delivered
       * fan-out, the collator would read an empty `/replies`, and the console
       * would collate from nothing while every observable said it worked. That
       * is the silent-empty-mount failure arriving through the repair rather
       * than through the fault.
       *
       * So it propagates. `fanOut` does not catch `publishReply`, `relayPass`
       * lets a throw through without journalling, and the next pass retries —
       * which is the correct handling for a console that is not built yet. All
       * that is added here is a sentence saying which directory and whose job
       * it is, because a bare ENOENT on a path an operator never typed sends
       * them looking in the wrong place.
       */
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `the collator "${collator}" has no replies directory at ${dir}, so the report for ` +
            `"${childTaskId}" could not be delivered (SRD-REVIEW-CONSOLE D6). That directory is ` +
            `created by \`pifleet up\` before the container starts, and it is NOT created here on ` +
            `purpose: Docker makes a missing bind-mount source rather than refusing, so a run ` +
            `that reached this point has a collator mounted on a different directory — writing ` +
            `here would deliver three reports nothing can read. Nothing was journalled; the pass ` +
            `retries. Rebuild the run with \`pifleet up\`.`,
          { cause: err },
        );
      }
      throw err;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * **THE EXPORT `src/cli/commands/relay.ts` LOOKS UP BY NAME.**
 *
 * That module does `mod["consoleFanOut"]` inside its action and refuses with
 * `EXIT.INTERNAL` when it is not a function, naming the missing symbol. The
 * string is spelled in two files that cannot see each other, so
 * `collator-relay-adapter.test.ts` pins the pair — a rename on either side is a
 * red test rather than a console that comes up, polls forever and dispatches
 * nothing.
 *
 * The composition is the whole of it: resolve the worker→run map for this
 * console (D4 — four runs), build a transport bound to THIS request's collator,
 * hand both to the pure core, and translate its three outcomes into the two the
 * journal tells apart. Every decision is one file up or one file down; none of
 * them is here.
 */
/**
 * The real reads. Every path in the console is derived HERE and nowhere else.
 *
 * `isLiveWorker` is a LIVE worker, not merely a directory that once existed.
 * `existsSync(workerPaths(run, worker).dir)` was the predicate and it is why the
 * scan could capture a stranger: `pifleet down` removes containers and leaves
 * directories, so every run this operator has ever started answered `true` for
 * every worker it ever materialised, and the candidate set was "every run on the
 * host". Liveness narrows it to runs with a supervisor actually holding the
 * seat. It does NOT make the answer unique — two live consoles still collide —
 * which is what the ambiguity refusal is for; the two together are the fix and
 * either alone is not.
 */
export const productionRunSources: ConsoleRunSources = {
  runsRoot: () => {
    // Synchronous by contract, so the lazily-loaded module cannot be used here.
    // `runsRoot` reads one env var and joins a path; duplicating that would be a
    // second definition of where runs live, so it is imported eagerly instead —
    // `paths.ts` pulls in nothing heavy, which is why it is the one exception.
    return runsRootEager();
  },
  listRunIds: async (root) => {
    const m = await loadEffectModules();
    return m.paths.runIdsAscending(root);
  },
  runPathsFor: (runId, root) => runPathsEager(runId, root),
  isLiveWorker: async (run, worker) => {
    const m = await loadEffectModules();
    const wp = m.paths.workerPaths(run, worker);
    if (!existsSync(wp.dir)) return false;
    try {
      const state = await m.state.readWorkerState(wp);
      if (state === null || state.phase === "dead") return false;
      return (await m.registry.processStartTime(state.pid)) !== null;
    } catch {
      return false;
    }
  },
  pinnedRuns: () => process.env["PIFLEET_RELAY_RUNS"],
};

export const consoleFanOut: (input: RelayFanOutInput) => Promise<RelayFanOutResult> =
  makeConsoleFanOut({
    resolveRuns: (input) => consoleRunResolution(input, productionRunSources),
    transport: (collator) => consoleTransport(collator, productionRelayEffects),
  });
