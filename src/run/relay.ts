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
 * - `dispatch` is `controlCall(run, workerId, msg)`, which resolves a unix
 *   socket path and reads the per-run control secret off disk.
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
   * failure shapes into a rejection: `controlCall` throws `SocketRequestError`
   * on an unreachable socket, and answers `{accepted: false, reason: ...}` for a
   * refusal — including `pane_mode_tui_has_no_rpc_dispatch`, which D13 makes
   * reachable, since the implementation §0.7 records makes all four panes `tui`.
   * A rejection here costs one lens, not the fan-out.
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
  /** Why this lens is missing, in a form the collation brief can print. */
  readonly note: string;
}

export type RelayRefusal = "run_unresolved" | "underivable_id";

export type RelayOutcome =
  | { kind: "refused"; code: RelayRefusal; reason: string }
  | { kind: "not_collated"; reason: string; children: readonly RelayChild[] }
  | {
      kind: "collated";
      collation: RelayDispatch;
      /** What the collator is told to claim: §6.6's table. */
      claim: "success" | "partial";
      children: readonly RelayChild[];
      /** The seats that produced no review. Empty exactly when `claim` is `success`. */
      missing: readonly AspectSeat[];
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
        note: "it was dispatched but could not be harvested",
      };
    }
    return {
      worker: seat.worker,
      aspect: seat.aspect,
      taskId: plan.taskId,
      verdict: harvested.verdict,
      succeeded: harvested.verdict === "success",
      note:
        harvested.verdict === "success"
          ? ""
          : `it settled \`${harvested.verdict}\` and produced no report`,
    };
  });

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
  await transport.dispatch(collatorRun, collation);

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
export interface RelayEffects {
  /** `controlCall(run, workerId, msg)` — supervisor/launch.ts. */
  controlCall(
    run: RunPaths,
    workerId: string,
    msg: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** The `pifleet.task/v1` envelope this dispatch travels in. */
  buildEnvelope(
    run: RunPaths,
    worker: string,
    dispatch: RelayDispatch,
  ): Promise<Record<string, unknown>>;
  /** `writeJsonAtomic(inboxTaskPath(run, taskId), envelope)` — SRD §7.1. */
  recordInbox(run: RunPaths, taskId: string, envelope: Record<string, unknown>): Promise<void>;
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
 * That is the wedge, and it is the same shape as the FIFO defect Phase 1 nearly
 * shipped: not a crash, not an error, just an actor that stops. §6.5's argument
 * for a restartable host-side process is worth nothing if the process can hang.
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
 * `controlCall` throws `SocketRequestError` for an unreachable socket, which no
 * implementation gets wrong. It also RESOLVES with `{accepted: false, reason}`
 * for a refusal, and an adapter written as `await controlCall(...)` treats that
 * as a delivered prompt. The console then joins, waits and harvests a task no
 * worker was ever told about — every lens reports `unknown`, and the failure is
 * reported against the reviewers rather than against the dispatch.
 *
 * `refusal` is the supervisor's own reason string, kept as a FIELD rather than
 * only in the message, because the one that matters —
 * `pane_mode_tui_has_no_rpc_dispatch` — is a condition an operator fixes by
 * changing a pane mode, and a caller that had to match English to tell it apart
 * would be pinning a sentence rather than a rule.
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
    async dispatch(run: RunPaths, d: RelayDispatch): Promise<void> {
      const envelope = await effects.buildEnvelope(run, d.worker, d);
      let reply: Record<string, unknown>;
      try {
        reply = await effects.controlCall(run, d.worker, {
          cmd: "dispatch",
          envelope,
          attempt_id: relayAttemptId(d.worker, d),
          /**
           * `null`, always. The supervisor is the sole epoch allocator (§7.5),
           * and a relay that requested one would be allocating on the caller's
           * side of a fence whose whole purpose is that it has one writer.
           */
          requested_epoch: null,
        });
      } catch (err) {
        // Shape one: the socket. `SocketRequestError` and anything else that
        // escaped the transport land here together — from the join's point of
        // view an unreachable supervisor and a broken one cost the same lens.
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          null,
          err instanceof Error ? err.message : String(err),
        );
      }

      // Shape two, and the one that reads as success: a RESOLVED refusal.
      if (reply["accepted"] !== true) {
        const refusal = typeof reply["reason"] === "string" ? reply["reason"] : "rejected";
        const detail = typeof reply["error"] === "string" ? reply["error"] : refusal;
        throw new RelayDispatchError(d.worker, d.taskId, refusal, `${refusal} (${detail})`);
      }

      /**
       * THE INBOX RECORD, and it is not bookkeeping.
       *
       * `harvestTask` reads `<run>/inbox/<task>.json` first and answers
       * `unavailableHarvest` when it is absent — "no dispatch record at
       * inbox/<id>.json". Without this write every child of every fan-out
       * would harvest `unknown`, every lens would be reported missing, and the
       * console would blame three reviewers that had each done the work. It is
       * written AFTER acceptance and carries the ASSIGNED epoch, exactly as
       * `dispatch.ts` writes it, because an inbox record for a dispatch that
       * was refused is a record of a task that does not exist.
       */
      await effects.recordInbox(run, d.taskId, { ...envelope, epoch: reply["epoch"] });
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
export async function resolveConsoleRuns(input: {
  readonly collator: string;
  readonly collatorRun: RunPaths;
  readonly workers: readonly string[];
  /** Candidate runs, newest first. */
  listRuns(): Promise<readonly RunPaths[]>;
  hasWorker(run: RunPaths, worker: string): Promise<boolean>;
}): Promise<Map<string, RunPaths>> {
  const runs = new Map<string, RunPaths>();
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
      for (const run of candidates) {
        if (await input.hasWorker(run, worker)) {
          runs.set(worker, run);
          break;
        }
      }
    }
  }
  return runs;
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
  if (outcome.kind === "refused") {
    return { kind: "not_dispatched", reason: outcome.reason };
  }
  /**
   * Nulls dropped — a `null` `taskId` is a seat the request never named, and an
   * id nothing can be looked up by is not evidence of a dispatch. The COLLATION
   * id is deliberately absent too: `children` is the list a reader reconciles
   * against the collator's own envelope, and the collation is the host's own
   * follow-up rather than something the request bought.
   */
  const children = outcome.children.map((c) => c.taskId).filter((id): id is string => id !== null);
  return { kind: "dispatched", children };
}

/**
 * The adapter, over injected composition. `consoleFanOut` is this with the real
 * effects bound; the seam is here so the mapping above can be tested against a
 * fan-out driven by closures rather than by a fleet.
 */
export function makeConsoleFanOut(deps: {
  resolveRuns(input: RelayFanOutInput): Promise<ReadonlyMap<string, RunPaths>>;
  transport(collator: string): RelayTransport<RunPaths>;
  aspects?: readonly AspectSeat[];
}): (input: RelayFanOutInput) => Promise<RelayFanOutResult> {
  return async (input: RelayFanOutInput): Promise<RelayFanOutResult> => {
    const outcome = await relayFanOut<RunPaths>({
      request: input.request,
      sender: input.sender,
      runs: await deps.resolveRuns(input),
      transport: deps.transport(input.sender),
      ...(deps.aspects === undefined ? {} : { aspects: deps.aspects }),
    });
    return toFanOutResult(outcome);
  };
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
  launch: typeof import("../supervisor/launch.ts");
  harvest: typeof import("../harvest/index.ts");
  state: typeof import("./state.ts");
  paths: typeof import("./paths.ts");
  replies: typeof import("./replies.ts");
  jsonl: typeof import("../util/jsonl.ts");
  contracts: typeof import("../contracts.ts");
  schema: typeof import("../config/schema.ts");
}> | null = null;

function loadEffectModules(): NonNullable<typeof effectModules> {
  effectModules ??= (async () => ({
    launch: await import("../supervisor/launch.ts"),
    harvest: await import("../harvest/index.ts"),
    state: await import("./state.ts"),
    paths: await import("./paths.ts"),
    replies: await import("./replies.ts"),
    jsonl: await import("../util/jsonl.ts"),
    contracts: await import("../contracts.ts"),
    schema: await import("../config/schema.ts"),
  }))();
  return effectModules;
}

/**
 * The `pifleet.task/v1` envelope for a relayed child, filled the way
 * `sendTaskEnvelope` fills one.
 *
 * **The fields are copied from THE dispatch path rather than invented, and the
 * two that matter are `host_workdir` and `base_ref`.** §8.2 grades a task on
 * `git diff <base>...HEAD` in the worktree the envelope names, so an envelope
 * carrying the schema's placeholders — `"unset"` and forty zeroes — produces a
 * harvest with `repository: false` for a reviewer that has a checkout, and the
 * lens comes back `unknown` for a reason that has nothing to do with the
 * review. `readRunWorktrees` is the same record `dispatch.ts` reads, and it is
 * the only source that can be right: the branch git actually checked out and
 * the branch the envelope names are the same string, or the diff is graded
 * against a ref that does not exist.
 *
 * `deadline_s` is NOT taken from the request — D11 refuses both spellings of it
 * in the document, on the grounds that a request that could set it "can pin
 * three of the largest models in the catalogue open against the operator's API
 * key". 1500 is `dispatch.ts`'s own default for a task with no opinion.
 */
async function buildRelayEnvelope(
  run: RunPaths,
  worker: string,
  d: RelayDispatch,
): Promise<Record<string, unknown>> {
  const m = await loadEffectModules();
  const recorded = await m.state.readRunWorktrees(run);
  const wt = recorded.byWorker.get(worker);
  return m.contracts.TaskEnvelopeSchema.parse({
    schema: "pifleet.task/v1",
    task_id: d.taskId,
    run_id: run.runId,
    // A placeholder the supervisor replaces with its allocation before
    // anything durable records it — `dispatch.ts`'s comment, and its value.
    epoch: 0,
    attempt: 1,
    worker,
    dispatched_at: new Date().toISOString(),
    title: d.title,
    brief: d.brief,
    repo: recorded.repo ?? "unset",
    host_workdir: wt?.path ?? "unset",
    container_workdir: "/workspace",
    branch:
      wt?.branch ??
      m.paths.workerBranch(
        recorded.branchPrefix ?? m.schema.DEFAULT_BRANCH_PREFIX,
        run.runId,
        worker,
      ),
    base_ref: wt?.baseSha ?? "0".repeat(40),
    inputs: [],
    acceptance: [],
    constraints: [],
    outbox: `/outbox/${d.taskId}`,
    cloud_allow: [],
    deadline_s: 1500,
    depends_on: [],
  }) as unknown as Record<string, unknown>;
}

/**
 * The four host effects, for real.
 *
 * Every path in the console is derived HERE and nowhere else, which is what
 * lets the module above stay free of `paths.ts` — the property its docblock
 * calls load-bearing for the unit suite.
 */
export const productionRelayEffects: RelayEffects = {
  async controlCall(run, workerId, msg) {
    const m = await loadEffectModules();
    return m.launch.controlCall(run, workerId, msg);
  },
  buildEnvelope: buildRelayEnvelope,
  async recordInbox(run, taskId, envelope) {
    const m = await loadEffectModules();
    await m.jsonl.writeJsonAtomic(m.paths.inboxTaskPath(run, taskId), envelope);
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
export const consoleFanOut: (input: RelayFanOutInput) => Promise<RelayFanOutResult> =
  makeConsoleFanOut({
    async resolveRuns(input) {
      const m = await loadEffectModules();
      const root = m.paths.runsRoot();
      return resolveConsoleRuns({
        collator: input.sender,
        collatorRun: input.run,
        // The sender plus every seat on the console. Seats the request did not
        // name cost one `existsSync` each and buy a map that does not depend on
        // which lenses this particular request happened to ask for.
        workers: [input.sender, ...REVIEW_CONSOLE_ASPECTS.map((s) => s.worker)],
        // Newest first: a console restarted after a crash has an older run
        // holding the same worker id, and the dead one must not win.
        listRuns: async () => {
          const ids = await m.paths.runIdsAscending(root);
          return ids.reverse().map((id) => m.paths.runPaths(id, root));
        },
        /**
         * The worker's DIRECTORY, which `up` creates, and not its `state.json`,
         * which its supervisor writes. The two differ exactly while a console
         * is still coming up — the window in which this question is asked most
         * — and requiring the state file would leave a worker unresolvable for
         * as long as its supervisor takes to write one. `run_unresolved` is a
         * retry, so the cheaper predicate costs a tick and the stricter one
         * costs a fan-out that never happens.
         */
        hasWorker: async (run, worker) => existsSync(m.paths.workerPaths(run, worker).dir),
      });
    },
    transport: (collator) => consoleTransport(collator, productionRelayEffects),
  });
