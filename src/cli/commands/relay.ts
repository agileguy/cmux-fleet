/**
 * `pifleet relay` — the ACTOR (SRD-REVIEW-CONSOLE §6.5, §6.6).
 *
 * §6.5 offers three homes for the thing that turns a collator's
 * `dispatch-request.json` into real dispatches, and calls the choice BLOCKING.
 * It is settled in favour of the second: **a host-side process started by
 * `scripts/review`, which watches the console it serves and exits when that
 * console is gone.**
 *
 * ## THE SUPERVISION STORY, AND THE ONE THIS FILE USED TO TELL
 *
 * It used to say *"Idempotency IS the supervision story"* — that a process
 * deriving its state from the run tree needs no supervision beyond being started
 * again. **That answered the wrong objection.** §6.5 worried about an actor
 * dying mid-fan-out, and the journal does answer that: nothing is recorded until
 * the children are dispatched, so a killed relay re-dispatches rather than losing
 * a review.
 *
 * The failure that actually occurred is the opposite one — an actor that does
 * NOT die. A relay left polling a console whose runs are gone reports nothing for
 * an empty pass, forever, and a manager asking only *"is a relay running"* calls
 * it healthy and starts none for the console that has no actor. That is §6.4's
 * own failure shape reached through the idempotency mechanism built to close it.
 *
 * So the owner settled §9 Q4 as SUPERVISION rather than restartability, and it
 * is two halves in two files. Here: the loop watches its collator through
 * `ConsoleWatch` and exits when the console is gone, which is what makes
 * `pifleet down` authoritative over a process it has never heard of. In
 * `scripts/review`: the record names the console it serves, so *"already
 * running"* is a comparison rather than a head-count. Idempotency is still true
 * and still lives in `run/relay-journal.ts`; it is no longer asked to be the
 * whole story.
 *
 * ## What a pass does, and what it refuses to do
 *
 * One pass reads the host's own record of what was dispatched, asks
 * `readDispatchRequest` about each collator task, asks the journal whether it has
 * already acted, and hands the survivors to the fan-out core. It performs no
 * dispatch itself and holds no policy about who may be dispatched to — those
 * live in `dispatch-request.ts`, which already refuses a target outside the
 * console, a target that is a collator, a sender that is not a collator, a
 * duplicate target, and every field D11 forbids. A second copy of any of those
 * rules here would be a second thing to keep correct.
 *
 * ## The candidate tasks come from the HOST'S inbox, not from listing the outbox
 *
 * The obvious implementation is `readdir(<run>/outbox/<collator>)` — the request
 * lives there, so look there. **It is the wrong source and the reason is the one
 * `dispatch-request.ts` spends its header on:** `/outbox` is the directory the
 * WORKER owns. Listing it means enumerating attacker-chosen names and then
 * building host paths out of them, which is how `harvest/outbox.ts` ends up
 * needing `O_NOFOLLOW`, `O_NONBLOCK` and a validate-then-hold discipline just to
 * walk a directory safely.
 *
 * `<run>/inbox/<task-id>.json` is the same information from the other side, and
 * the host wrote it. `dispatch` records every envelope it sends there
 * (`inboxTaskPath`, SRD §7.1), so the set of task ids that could possibly carry
 * a request is exactly the set of tasks the OPERATOR dispatched — a set the
 * worker cannot add to. A task directory a collator invents inside its own
 * outbox is not a task, and under this design it is never even looked at.
 *
 * That also makes the sender check structural twice over. The envelope names the
 * worker the task went to, so a request is only ever read out of the outbox of a
 * worker the host itself addressed; `checkSender` then judges that worker
 * against the roster.
 *
 * ## The fan-out core is NOT in this file and must not be
 *
 * §6.6's fan-out, join and partial-collation logic is `src/run/relay.ts`, on a
 * sibling branch. This module depends on it through `RelayFanOut` — a type,
 * three fields wide — and resolves the implementation by a dynamic import
 * INSIDE the action rather than at registration, so a tree without it still has
 * a working `pifleet --help` and a `relay` that refuses with a sentence naming
 * the missing module instead of failing to load the CLI.
 *
 * **There is deliberately no fallback implementation.** A stub that dispatched
 * nothing and returned success would be indistinguishable from a working relay
 * on every observable this console has, which is the exact failure shape §6.4
 * describes for a request nobody reads: *"a collator that dispatched three
 * reviews is indistinguishable from one that dispatched none"*.
 *
 * ## `--once` is the real command and the loop is the wrapper
 *
 * `relayPass` is one pass, exported, and takes its fan-out as an argument. The
 * loop is `setTimeout` around it. That ordering is a testability decision made
 * deliberately: a poller written as an infinite loop can only be tested by
 * starting it and killing it, which is a test that measures its own timeout, and
 * `scripts/` will want a single pass anyway for a console that is driven by hand.
 */

import type { Command } from "commander";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import {
  REVIEW_CONSOLE_ROSTER,
  TRIAGE_CONSOLE_ROSTER,
  type ConsoleRoster,
  type DispatchRequest,
  readDispatchRequest,
} from "../../run/dispatch-request.ts";
/*
 * The aspect tables come from `run/task-ids.ts` DIRECTLY and not through
 * `run/relay.ts`'s re-export block, which that block's own header now states as
 * a rule: names added to `task-ids.ts` after the extraction are addressed at
 * `task-ids.ts`. `REVIEW_CONSOLE_ASPECTS` predates it and would be reachable
 * either way; spelling both imports from one place is what stops the next
 * console's table from being the reason the block is widened.
 */
import {
  REVIEW_CONSOLE_ASPECTS,
  TRIAGE_CONSOLE_ASPECTS,
  type AspectSeat,
} from "../../run/task-ids.ts";
import { ConsoleWatch } from "../../run/console-relay.ts";
import { classifyRequest, recordDispatch } from "../../run/relay-journal.ts";
import { consoleFanOut } from "../../run/relay.ts";
/*
 * A SECOND STATEMENT from the same module, deliberately.
 * `collator-relay-adapter.test.ts` pins the exact text
 * `import { consoleFanOut } from "../../run/relay.ts"` — the agreement between
 * this file and the adapter is spelled in two places that cannot see each other,
 * and that pin is what turns a rename into a red test instead of a console that
 * polls forever and dispatches nothing. Widening the existing statement would
 * have broken the pin while changing nothing it is about.
 */
import { productionRunSources } from "../../run/relay.ts";
/*
 * A THIRD statement from that module, on the SECOND one's precedent and for its
 * reason. `collator-relay-adapter.test.ts` pins the exact text
 * `import { consoleFanOut } from "../../run/relay.ts"`, so widening the first
 * statement to carry `consoleFanOutFor` would have broken a pin that is not
 * about this change at all — it is about the CLI depending on that symbol by
 * name. Adding a statement leaves the pin saying what it was written to say.
 */
import { consoleFanOutFor } from "../../run/relay.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import {
  inboxTaskPath,
  runIdsAscending,
  runPaths,
  runsRoot,
  workerPaths,
  type RunPaths,
} from "../../run/paths.ts";
import { resolveRunPaths } from "../worker-preflight.ts";

/**
 * What the fan-out core is handed. **Three fields, and the narrowness is the
 * point** — every one of them is something this module already had to know to
 * find the request at all, so the interface adds no coupling that the poll did
 * not already carry.
 *
 * `run` is the COLLATOR's run. In this console every worker is its own run (each
 * `pane_mode: tui` pane runs `pifleet up --attach-here`), so the reviewers the
 * fan-out has to reach are in OTHER runs and `controlCall` needs their
 * `RunPaths`. That worker→run map is deliberately NOT threaded through here: it
 * is a property of the CONSOLE rather than of any one request, it is the same on
 * every tick, and putting it in this interface would make the poll's signature
 * depend on a decision that belongs to the module doing the dispatching.
 * **That is the one place these two halves have still to agree, and it is named
 * here rather than assumed.**
 */
export interface RelayFanOutInput {
  /** The run whose outbox held the request. */
  run: RunPaths;
  /** The worker whose outbox it was. Structural identity, never a claim. */
  sender: string;
  /** The task directory it sat in; equals `request.parent_task_id`, checked. */
  taskId: string;
  /** The validated request. Every §6.4 and D11 refusal has already run. */
  request: DispatchRequest;
}

/**
 * What the fan-out core reports back, in the only two shapes the JOURNAL has to
 * tell apart.
 *
 * **The `not_dispatched` arm is not symmetry, it is the durability decision
 * again.** `src/run/relay.ts`'s own `RelayOutcome` has three arms, and one of
 * them — `refused`, with codes `run_unresolved` and `underivable_id` — means
 * NOTHING was dispatched. Journalling that as done would mark a fan-out complete
 * that never happened, and under D5 the collator has already settled and named
 * three child ids, so nothing would ever notice. That is the silent-loss outcome
 * the write ordering was chosen to avoid, arriving through the return value
 * instead of through a crash.
 *
 * `not_collated` maps to `dispatched`, and the distinction is worth stating
 * because it reads backwards: under §6.6's table a fan-out where zero children
 * succeeded dispatches no COLLATION, but it did dispatch the three children. The
 * work happened; the journal must record it, or the relay reissues three reviews
 * on the next tick for a request that already consumed them.
 *
 * `children` carries only the ids that were actually issued —
 * `RelayChild.taskId` is `string | null`, and `null` is a seat the request never
 * named. The adapter drops the nulls; a null in the journal would be an id
 * nothing can be looked up by.
 */
export type RelayFanOutResult =
  | {
      kind: "dispatched";
      children: readonly string[];
      /**
       * Present ONLY when the fan-out completed but its last hop did not — the
       * reviews ran, the replies were published, and the collation could not be
       * delivered (`relay.ts`'s `collation_failed`).
       *
       * **Optional rather than always-present, and the absence is load-bearing.**
       * A completed pass and a failed collation carry the same `kind` and the
       * same children, because in both cases the same three reviews really were
       * dispatched and must never be dispatched again. This field is the only
       * thing that separates them, so a value here has to mean something went
       * wrong — which it cannot if it is also populated on the happy path.
       */
      reason?: string;
    }
  | { kind: "not_dispatched"; reason: string };

/**
 * The seam between the poll and §6.6's fan-out.
 *
 * The implementation is an ADAPTER over `relayFanOut` in `src/run/relay.ts`
 * rather than that function itself, and the gap is exactly two values that
 * function requires and this one does not have:
 *
 * - **`runs: ReadonlyMap<string, R>`** — worker → run. In this console every
 *   worker is its own run, so reaching a reviewer means holding its `RunPaths`.
 *   That map is a property of the CONSOLE, identical on every tick, so it
 *   belongs to whatever composes the relay rather than to a per-request poll.
 * - **`transport: RelayTransport<R>`** — the four host effects (`dispatch`,
 *   `awaitSettled`, `harvest`, `publishReply`). `relay.ts` injects them
 *   deliberately; the production implementation over `controlCall`,
 *   `harvestTask` and `writeReply` is neither in that module nor in this one.
 *
 * **Both are named here rather than assumed, because they are the whole of what
 * is left before this command can run.**
 */
export type RelayFanOut = (input: RelayFanOutInput) => Promise<RelayFanOutResult>;

/**
 * A CONSOLE, as the actor needs to know it — SRD-TRIAGE-CONSOLE §13 task 2.2.
 *
 * **A roster plus an aspect table, which is D5's definition and not a new one.**
 * `TRIAGE_CONSOLE_ASPECTS`' own docblock states it: *"A console is a roster plus
 * an aspect table, and a second console is therefore two values rather than a
 * branch on which console is being served."* This interface is that sentence
 * given a name, so the two values travel together and cannot be selected apart.
 *
 * ## Why the registry is HERE and not in `run/relay.ts`
 *
 * The rosters are `dispatch-request.ts`'s and the aspect tables are
 * `task-ids.ts`'s, and `run/relay.ts` cannot import the first as a VALUE:
 * `dispatch-request.ts:124` already imports `isCollationTaskId` from
 * `run/relay.ts`, so a value edge back would be a runtime cycle whose
 * correctness depends on evaluation order — the hazard `task-ids.ts` duplicates
 * `MAX_RELAY_TASK_ID_CHARS` rather than risk. This module imports both halves
 * already and nothing imports it back except as a type, so it is the lowest
 * place both values are legal at once.
 *
 * ## The two fields that look redundant, and why both are spelled
 *
 * `fanOut` is built from `aspects` — `consoleFanOutFor(aspects)` is its whole
 * definition — so a spec whose two fields disagree is constructible. They are
 * spelled anyway, on `REVIEW_CONSOLE_ROSTER`'s own trade against
 * `DEFAULT_REVIEW_WORKERS`: *"Spelling both halves and testing the union is the
 * version whose failure is a red test rather than a working console that does
 * nothing."* `relay-console.test.ts` pins the pairing for every registered
 * console, so a mismatch is red rather than a fan-out into the wrong seats.
 *
 * The review console's `fanOut` is the module-level `consoleFanOut` binding
 * rather than a fresh `consoleFanOutFor(REVIEW_CONSOLE_ASPECTS)`, and that is
 * deliberate: `collator-relay-adapter.test.ts` pins the CLI's dependence on that
 * exact symbol, and a shipped console whose live fan-out stopped being the
 * pinned binding would leave the pin passing on text while testing nothing.
 */
export interface ConsoleSpec {
  /** The `--console` value. */
  readonly name: string;
  /** Who may ask, and who may be asked — `dispatch-request.ts`'s two questions. */
  readonly roster: ConsoleRoster;
  /** Which seats exist, and therefore which runs the fan-out looks for. */
  readonly aspects: readonly AspectSeat[];
  /** The production fan-out bound to `aspects`. */
  readonly fanOut: RelayFanOut;
}

/**
 * Every console this actor can serve.
 *
 * An array rather than a `Record`, so the refusal below can list the names in a
 * fixed order and the default can be named as a member rather than as a string
 * that happens to match a key.
 */
export const CONSOLES: readonly ConsoleSpec[] = [
  {
    name: "review",
    roster: REVIEW_CONSOLE_ROSTER,
    aspects: REVIEW_CONSOLE_ASPECTS,
    fanOut: consoleFanOut,
  },
  {
    name: "triage",
    roster: TRIAGE_CONSOLE_ROSTER,
    aspects: TRIAGE_CONSOLE_ASPECTS,
    fanOut: consoleFanOutFor(TRIAGE_CONSOLE_ASPECTS),
  },
];

/**
 * The console served when `--console` is not given.
 *
 * `review` because it is the console that exists today and the one
 * `scripts/review` starts without the flag; a default that changed under a
 * shipped script would be this change breaking the thing it was careful not to
 * touch.
 */
export const DEFAULT_CONSOLE = "review";

/**
 * `--console <name>` → the two values that name selects, or a refusal.
 *
 * **AN UNKNOWN NAME IS REFUSED, NEVER DEFAULTED, and that is the whole reason
 * this is a function rather than a `find(...) ?? CONSOLES[0]`.**
 *
 * The tempting spelling falls back to the review console on anything it does not
 * recognise, and it is wrong in a way that only shows up in production: the
 * operator who types `--console triage-console` gets a process that starts
 * cleanly, prints the same lines a working actor prints, and runs the TRIAGE
 * CLOCK against the REVIEW console's roster — polling `col-1`, refusing every
 * observer's request as `worker_not_in_console`, and dispatching a five-minute
 * cadence of nothing. There is no observable that separates it from a healthy
 * triage actor, which is §6.4's own failure shape (*"a collator that dispatched
 * three reviews is indistinguishable from one that dispatched none"*) reached
 * through a typo.
 *
 * `EXIT.USAGE`, because it is: the argument is wrong and no amount of retrying
 * fixes it. The known names are listed rather than merely counted, so the
 * operator's next command is the corrected one.
 */
export function resolveConsole(name: string | undefined): ConsoleSpec {
  const wanted = name ?? DEFAULT_CONSOLE;
  const spec = CONSOLES.find((c) => c.name === wanted);
  if (spec !== undefined) return spec;
  throw new CliError(
    `unknown console ${JSON.stringify(wanted)}. This actor serves ` +
      `${CONSOLES.map((c) => c.name).join(", ")}, and an unrecognised name is refused rather ` +
      `than defaulted: falling back would run one console's clock against another console's ` +
      `roster, which starts cleanly, logs like a healthy actor and dispatches nothing.`,
    EXIT.USAGE,
  );
}

/** What one request did on one pass. The code is the assertion surface, not the prose. */
export type RelayPassOutcomeKind =
  /** Fanned out and journalled. */
  | "dispatched"
  /** Journalled already, content unchanged. The normal answer on almost every tick. */
  | "already_done"
  /** Journalled, but the request file's content has changed. Refused, loudly. */
  | "rewritten"
  /** The journal could not be trusted. Refused, and deliberately not retried as fresh. */
  | "journal_unreadable"
  /** `readDispatchRequest` said no. `reason` carries its sentence verbatim. */
  | "refused"
  /**
   * The fan-out core declined, so nothing was dispatched and nothing was
   * journalled. Retried on the next pass, which is correct: `run_unresolved` is
   * exactly the state a console that is still coming up is in.
   */
  | "fan_out_declined";

export interface RelayPassOutcome {
  worker: string;
  task_id: string;
  kind: RelayPassOutcomeKind;
  /** The refusing module's OWN sentence, never a reconstruction of it. */
  reason?: string;
  children?: readonly string[];
}

export interface RelayPassResult {
  run_id: string;
  /** Inbox records considered — the denominator, so "found nothing" is legible. */
  tasks_seen: number;
  outcomes: RelayPassOutcome[];
}

/**
 * Task id → the worker its envelope names, memoised for the life of the process.
 *
 * Safe to cache because the inbox record is written ONCE by `dispatch` and never
 * rewritten, and it is host-owned. Without the cache every tick re-reads every
 * envelope in the run, which is O(tasks) file reads per poll interval for an
 * answer that cannot have changed.
 *
 * Not a module-level singleton: it is created per pass-set by `register`, so two
 * relays in one process (a test, most likely) cannot see each other's.
 */
export type InboxWorkerCache = Map<string, string | null>;

/**
 * The worker an envelope names, or `null` when the record cannot say.
 *
 * `null` on anything unreadable — a missing file, a truncated one, a record with
 * no `worker` — and the caller SKIPS rather than guessing. This is `unstage.ts`'s
 * `workerFromInbox` derivation and the same reasoning applies with more force
 * here: a guess aims a fan-out at the wrong outbox, and a fan-out is three
 * dispatches rather than one cancel.
 */
async function workerForTask(
  run: RunPaths,
  taskId: string,
  cache: InboxWorkerCache,
): Promise<string | null> {
  const hit = cache.get(taskId);
  if (hit !== undefined) return hit;
  let worker: string | null = null;
  try {
    const envelope = JSON.parse(await Bun.file(inboxTaskPath(run, taskId)).text()) as {
      worker?: unknown;
    };
    if (typeof envelope.worker === "string" && envelope.worker !== "") worker = envelope.worker;
  } catch {
    worker = null;
  }
  cache.set(taskId, worker);
  return worker;
}

/**
 * The task ids the HOST dispatched in this run.
 *
 * An absent inbox directory is an empty list rather than an error: a run whose
 * operator has dispatched nothing yet is the state every run starts in, and a
 * relay that refused to start until someone had dispatched would be unstartable
 * at exactly the moment it is meant to be waiting.
 *
 * `.json` suffix stripped rather than matched loosely, so a stray file cannot
 * become a task id that then becomes a path segment. The grammar check that
 * really guards that is in `readDispatchRequest` and the journal, which both
 * refuse an unspellable id — this is the cheap filter, not the guard.
 */
async function inboxTaskIds(run: RunPaths): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(run.inboxDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -".json".length));
}

/**
 * ONE PASS. The whole command, minus the loop and the printing.
 *
 * The order inside the loop is a contract rather than an arrangement:
 *
 *   1. **The task must be one the host dispatched, to a collator.** Cheapest
 *      check, and the one that means no worker-chosen name ever becomes a path.
 *   2. **The request must validate** — `readDispatchRequest`, which resolves the
 *      path exactly once and carries every §6.4/D7/D11 refusal.
 *   3. **The journal must say `fresh`.** After validation, because a request that
 *      is not valid is not a request and must not create a journal question; and
 *      before the fan-out, because that is the whole point.
 *   4. **Fan out, THEN journal.** Never the other way round —
 *      `run/relay-journal.ts` argues the ordering at length, and the short form
 *      is that journalling first turns a crash into a review that silently never
 *      happens, while journalling last turns it into one that happens twice.
 *
 * A throw from the fan-out core propagates and the journal is NOT written, which
 * is the same choice made once more: an aborted fan-out is retried on the next
 * pass rather than recorded as done.
 */
export async function relayPass(opts: {
  run: RunPaths;
  fanOut: RelayFanOut;
  roster?: ConsoleRoster;
  cache?: InboxWorkerCache;
  /**
   * Optional so the unit suite can drive a pass without a run directory to
   * write into. The command always supplies one; a pass without it still
   * journals and still reports, and only loses the durable copy of a reason it
   * has already returned to its caller.
   */
  ledger?: LedgerWriter;
}): Promise<RelayPassResult> {
  const roster = opts.roster ?? REVIEW_CONSOLE_ROSTER;
  const cache = opts.cache ?? new Map<string, string | null>();
  const outcomes: RelayPassOutcome[] = [];
  const taskIds = await inboxTaskIds(opts.run);

  /**
   * EVERY worker on the console, not only the collators — and the wider set is
   * `dispatch-request.ts`'s design rather than this file's generosity.
   *
   * Filtering to collators here would be cheaper and would make `checkSender`
   * DEAD CODE: no non-collator's request would ever reach it, so §6.10's rule
   * would be enforced by an omission in the poll rather than by the module that
   * states it, and the evidence a reviewer actually attempted a dispatch would
   * be discarded before anything could record it. That module chose the other
   * arrangement explicitly and said why — a reviewer that has written nothing is
   * `missing` and silent, while a reviewer that wrote one is a loud refusal, and
   * "the one refusal that means something would be indistinguishable from the
   * noise it was buried in" is its own sentence about the ordering.
   *
   * Still bounded by the ROSTER, so this is not a scan of every worker in the
   * fleet: a task dispatched to `eng-1` is not this console's business, and its
   * outbox is not read.
   *
   * ## `sender_not_collator` REACHES PRODUCTION ON THE TRIAGE CONSOLE, and the
   * widening is what makes that free
   *
   * **This paragraph used to say the refusal was unreachable and that the fix
   * waited on `--console`. `--console` has landed, and the reachability changed
   * with it rather than the loop.**
   *
   * On the REVIEW console the old reading still holds exactly: D4 makes it four
   * runs, this pass reads ONE of them, and it is the collator's — so the only
   * senders it can enumerate are the workers that run holds, which is `col-1`
   * alone. A reviewer's outbox lives in a run this pass never opens, so
   * `checkSender` cannot fire here no matter what a reviewer writes.
   *
   * On the TRIAGE console it is live on the first tick. SRD-TRIAGE-CONSOLE D3
   * puts all four seats in **one run** (`rpc`, no keyboard, §6.1), so the three
   * observers share the collator's inbox — `onConsole` enumerates them, an
   * observer that writes `dispatch-request.json` IS read, and `checkSender`
   * refuses it as `sender_not_collator`. That is §4.2's rule (*"an agent may not
   * dispatch"*) becoming an enforced refusal instead of an unreachable one, and
   * it is enforced by the module that states it rather than by an omission here.
   * **This is the payoff the widening was kept for**, and it arrived without a
   * line of change in this loop.
   *
   * ## What `--console` solved, and the one thing it deliberately did not
   *
   * It solved the worker→run scoping problem ONCE, where the SRD said to: in the
   * fan-out. `consoleFanOutFor` threads the selected console's aspect table to
   * `consoleRunResolution`, so the scan looks for the seats the selected console
   * actually has. There is no second scan here and there must not be one — the
   * ingredients are now in scope (`opts.roster` is the selected console's), and
   * that is precisely the state in which a second, differently-shaped map gets
   * written by accident.
   *
   * **This pass still reads exactly one run's inbox, on every console.** Making
   * a REVIEW-console reviewer's request observable would still mean enumerating
   * other runs' outboxes, and that is still not this loop's job; it is the
   * fan-out's map, or it is nothing. Stated as a boundary that is kept rather
   * than as a gap that is pending.
   */
  const onConsole = new Set([...roster.collators, ...roster.reviewers]);

  for (const taskId of taskIds) {
    const worker = await workerForTask(opts.run, taskId, cache);
    if (worker === null || !onConsole.has(worker)) continue;

    const read = await readDispatchRequest({
      runRoot: opts.run.root,
      sender: worker,
      taskId,
      roster,
    });
    // `missing` is the normal state and is deliberately not an outcome: a
    // collator that has asked for nothing on this tick must produce no row, or
    // the one row that means something is buried in thousands that do not.
    if (read.kind === "missing") continue;
    if (read.kind === "refused") {
      outcomes.push({ worker, task_id: taskId, kind: "refused", reason: read.reason });
      continue;
    }

    const verdict = await classifyRequest(opts.run.root, worker, taskId, read.request);
    if (verdict.kind === "done") {
      outcomes.push({ worker, task_id: taskId, kind: "already_done", children: verdict.entry.children });
      continue;
    }
    if (verdict.kind === "rewritten") {
      outcomes.push({
        worker,
        task_id: taskId,
        kind: "rewritten",
        reason:
          `the request in ${worker}'s outbox for ${taskId} has CHANGED since it was acted on ` +
          `(journalled ${verdict.entry.request_sha256.slice(0, 12)}, now ` +
          `${verdict.digest.slice(0, 12)}). It is not dispatched again: the outbox is writable by ` +
          `the worker, so a content-keyed journal would let a collator buy three more reviewer ` +
          `dispatches per rewrite. The journal records what was actually dispatched; the file on ` +
          `disk is a claim its own author was free to edit afterwards.`,
        children: verdict.entry.children,
      });
      continue;
    }
    if (verdict.kind === "unreadable") {
      outcomes.push({ worker, task_id: taskId, kind: "journal_unreadable", reason: verdict.reason });
      continue;
    }

    const result = await opts.fanOut({
      run: opts.run,
      sender: worker,
      taskId,
      request: read.request,
    });
    // NOT journalled when nothing was dispatched. See `RelayFanOutResult`: a
    // record written here would mark a fan-out complete that never happened,
    // and under D5 nothing downstream would ever notice.
    if (result.kind === "not_dispatched") {
      outcomes.push({ worker, task_id: taskId, kind: "fan_out_declined", reason: result.reason });
      continue;
    }
    await recordDispatch(opts.run.root, worker, taskId, read.request, result.children);
    /**
     * D3: THE REASON IS MADE DURABLE, because printing it once is not recording
     * it.
     *
     * `RelayJournalEntry` has no reason field, and the staged refusal that
     * produces one throws before `sendTaskEnvelope` reaches its own ledger
     * append — so after the pass that printed this line, NOTHING in the run tree
     * said the collation never landed. The next tick answers `already_done,
     * unchanged`, three 0444 replies sit in the collator's mount with nothing
     * telling it to read them, and no row anywhere says why. That is precisely
     * the state `collation_failed`'s docblock says a reader must never be left
     * in, and the arm was only half-delivering on it.
     *
     * The LEDGER and not the journal, deliberately. The journal answers one
     * question — has parent T been fanned out — and `relay-journal.ts` argues
     * that its narrowness is what makes it trustworthy; widening its schema to
     * carry prose would give it a second job. The ledger is already the durable
     * per-run channel for "something happened that an operator will want later"
     * (`stage_trigger_deferred` is the same shape, appended by the same failure
     * one layer down), and it is written to a run-dir path nothing mounts.
     *
     * Appended AFTER `recordDispatch` for the ordering reason that governs this
     * whole file: the journal is what stops the reviews being re-run, so it goes
     * first and a failure to write the ledger row cannot cost the fan-out.
     */
    if (result.reason !== undefined) {
      await opts.ledger?.append("relay_collation_failed", {
        worker,
        task_id: taskId,
        detail: { children: [...result.children], reason: result.reason },
      });
    }
    // The reason rides along when there is one. It never changes whether the
    // journal is written — the children happened either way — it changes only
    // whether anybody is told the collation did not.
    outcomes.push({
      worker,
      task_id: taskId,
      kind: "dispatched",
      children: result.children,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    });
  }

  return { run_id: opts.run.runId, tasks_seen: taskIds.length, outcomes };
}

/**
 * THE FAN-OUT CORE, STATICALLY IMPORTED — and the dynamic import that used to
 * stand here is DELETED rather than repaired.
 *
 * It resolved `src/run/relay.ts` inside the action and caught the failure, so
 * that *"a tree in which `src/run/relay.ts` has not landed still loads the CLI
 * — a static import would make `pifleet --help` fail for every command"*. That
 * premise was true when it was written and `f39722f` destroyed it silently:
 * closing T5's depth hole required `dispatch-request.ts` to consult
 * `isCollationTaskId`, so that module now imports `./relay.ts` AT RUNTIME, this
 * module imports `dispatch-request.ts` statically for `readDispatchRequest`, and
 * `cli/index.ts` loads every command module under one `Promise.all`. A tree
 * without `relay.ts` therefore already takes down `pifleet --help` for every
 * command, three imports before this one is reached.
 *
 * **So the catch could not fire, and a defence that cannot fire is worse than
 * none** — it reads as protection, it is untested (neither branch had a test),
 * and it costs a reader the time to work out why it is there. The honest
 * options were to restore the premise, which means unpicking the depth bound's
 * import in a module that is not this change's to touch, or to delete the
 * guard. Deleted.
 *
 * The static import is also strictly stronger than what it replaces. The old
 * `typeof fanOut !== "function"` check existed because a dynamic import returns
 * a bag of unknowns and the two modules had to agree on a NAME across a boundary
 * the compiler could not see. Importing the binding makes that agreement a
 * compile error instead of a runtime refusal — the same trade
 * `MAX_RELAY_TASK_ID_CHARS` makes one file over, and the reason the constant
 * that spelled the name is gone too.
 */
/**
 * How long to wait between passes, in seconds.
 *
 * 2 s, and it is `TUI_QUIET_MS`'s number for a related reason: a collator's turn
 * is settled two seconds after it stops emitting (§3.3), so the request file
 * cannot appear sooner than that after the turn ends, and polling faster buys
 * re-reads of a file that cannot have changed. The other side of the interval is
 * a fan-out that takes minutes (§6.7), so a second either way is not a latency
 * anybody is measuring.
 */
const DEFAULT_POLL_S = 2;

/**
 * The run to poll when the operator names none — the COLLATOR's, never merely
 * the newest.
 *
 * **`resolveRunPaths(undefined)` is the wrong default here and the failure is
 * silent.** It answers the newest LIVE run, which is right for `shell`, `abort`
 * and `exec` — verbs aimed at whatever the operator is working on now. This
 * command is aimed at one specific run: `relayPass` reads a single run's inbox,
 * and only the collator's inbox can hold a task whose outbox carries a dispatch
 * request. Under D4 the console is four runs and the collator is pane 1, created
 * FIRST, so the newest live run is a reviewer's — and a relay pointed there
 * enumerates its inbox, finds no collator task, and reports nothing. In loop
 * mode `emit` prints nothing for an empty pass, so it does that forever, in
 * silence, looking exactly like a relay with no work to do.
 *
 * That is §6.4's failure shape occurring inside the command written to prevent
 * it: a console that dispatched nothing is indistinguishable from one with
 * nothing to dispatch.
 *
 * So the default is derived from the ROSTER rather than from recency: the newest
 * live run that actually materialised a collator. Refusing when there is none
 * beats polling a run that cannot answer — the operator is told which ids were
 * looked for, and `--run` remains the override for anything unusual.
 */
async function resolveCollatorRun(roster: ConsoleRoster): Promise<RunPaths> {
  const root = runsRoot();
  const ids = (await runIdsAscending(root)).reverse();
  for (const id of ids) {
    const run = runPaths(id, root);
    for (const collator of roster.collators) {
      if (existsSync(workerPaths(run, collator).dir)) return run;
    }
  }
  throw new CliError(
    `no run under ${root} holds a collator (${roster.collators.join(", ")}), so there is no ` +
      `inbox that could carry a dispatch request. \`relay\` polls ONE run and only a collator's ` +
      `run can hold a request — the newest live run is a reviewer's under D4, and polling it ` +
      `would report nothing forever rather than failing. Start the console, or name the run ` +
      `explicitly with --run.`,
    EXIT.USAGE,
  );
}

/**
 * One line per outcome, for the operator who is watching rather than parsing.
 *
 * **Exported for the unit suite**, on `classifyWorker`'s precedent one directory
 * over — "pure classification, exported so the unit suite can pin the boundary
 * ... without a filesystem". The boundary worth pinning here is narrow and easy
 * to lose: a `dispatched` row that carries a reason must PRINT it. The reason
 * exists precisely so a failed collation is not silent, and a renderer that
 * dropped it would restore the silence one layer below the fix.
 */
export function renderOutcome(o: RelayPassOutcome): string {
  switch (o.kind) {
    case "dispatched": {
      const line = `${o.worker} ${o.task_id}: dispatched ${o.children?.length ?? 0} children (${(o.children ?? []).join(", ")})`;
      return o.reason === undefined ? line : `${line} — ${o.reason}`;
    }
    case "already_done":
      return `${o.worker} ${o.task_id}: already dispatched, unchanged`;
    default:
      return `${o.worker} ${o.task_id}: ${o.kind} — ${o.reason ?? "no reason given"}`;
  }
}

/**
 * `relay`'s flags, named rather than inlined at `.action`.
 *
 * Inline was fine at four fields and stops being fine at five: the inline
 * annotation pushed the callback onto its own lines, which re-indented the
 * entire action body and would have buried a twenty-line change in a
 * hundred-and-thirty-line diff. The type is the same type; only its address
 * changed.
 */
interface RelayCommandOptions {
  run?: string;
  console?: string;
  once?: boolean;
  poll?: string;
  json?: boolean;
}

export function register(program: Command): void {
  program
    .command("relay")
    .description(
      "Poll collators' dispatch requests and perform the fan-out host-side " +
        "(the review console's actor; --once does a single pass and exits)",
    )
    .option("-r, --run <id>", "run id (defaults to the most recent live run)")
    .option(
      "--console <name>",
      `which console to serve: ${CONSOLES.map((c) => c.name).join(" | ")} (default: ${DEFAULT_CONSOLE})`,
    )
    .option("--once", "make a single pass and exit, rather than polling")
    .option("--poll <seconds>", `seconds between passes (default: ${DEFAULT_POLL_S})`)
    .option("--json", "emit machine-readable output")
    .action(async (opts: RelayCommandOptions) => {
      /**
       * THE CONSOLE IS RESOLVED FIRST, before `--poll` and before any run
       * lookup, because it is the argument every later step is relative to.
       *
       * An unknown name refused here costs nothing; the same name refused after
       * `resolveCollatorRun` would have already scanned the runs root for a
       * roster the operator did not ask for and reported its absence in that
       * roster's terms — a second, wrong sentence in front of the right one.
       */
      const spec = resolveConsole(opts.console);

      const pollS = opts.poll === undefined ? DEFAULT_POLL_S : Number(opts.poll);
      if (!Number.isFinite(pollS) || pollS <= 0) {
        throw new CliError(
          `--poll must be a positive number of seconds, not ${JSON.stringify(opts.poll)}`,
          EXIT.USAGE,
        );
      }

      const run =
        opts.run === undefined
          ? await resolveCollatorRun(spec.roster)
          : await resolveRunPaths(opts.run);
      /**
       * The fan-out comes from the SPEC, so the aspect table that decides which
       * runs are looked for is the same one that decides which seats are
       * dispatched to. Reading `consoleFanOut` here instead would have made
       * `--console triage` a flag that changed the roster and nothing else: the
       * pass would accept `tri-1`'s request and the fan-out would then resolve a
       * map of three reviewers this console does not have.
       */
      const fanOut: RelayFanOut = spec.fanOut;
      const cache: InboxWorkerCache = new Map();
      const ledger = new LedgerWriter(run, `cli-relay-${process.pid}`);

      /**
       * The exit code is about the PASS, not about any request in it.
       *
       * `harvest`'s posture, adopted deliberately: it "exits 0 whenever it
       * emitted valid output, and the trustworthiness of the harvest travels in
       * `harvest_status`, not in the exit code". A refused request is DATA — it
       * is the console working, refusing something a collator asked for — and an
       * orchestrator that treated it as a failed poll would restart a relay that
       * is doing exactly its job.
       */
      /**
       * D2: `already_done` IS PRINTED ONCE PER REQUEST, NOT ONCE PER POLL.
       *
       * `relayPass` pushes an outcome for every journalled request on every
       * pass, and a non-empty list is printed — so at a 2 s interval a console
       * with three settled requests emitted three lines every two seconds,
       * forever. That defeats this module's own rule: `missing` is deliberately
       * NOT an outcome so that *"the one row that means something"* is not
       * buried in thousands that do not, and `already_done` then buried it
       * anyway. It is also the mechanism by which a `collation_failed` reason,
       * printed exactly once, scrolls out of reach within seconds — which is
       * half of why that reason is now also written to the ledger.
       *
       * Suppression is per (worker, task) and lives in the COMMAND rather than
       * in `relayPass`, because the pass's return value is an API — `--json` and
       * `--once` still carry every outcome — and only the human-facing stream is
       * noisy. A row that CHANGES (a rewrite, a fresh dispatch) is a different
       * kind and prints normally.
       */
      const quiet = new Set<string>();
      const emit = (result: RelayPassResult): void => {
        if (opts.json === true) {
          process.stdout.write(`${JSON.stringify({ schema: "pifleet.relaypass/v1", ...result })}\n`);
          return;
        }
        if (result.outcomes.length === 0) {
          // Printed rather than silent, and only in `--once`: a pass that found
          // nothing is the answer to "is it working?" and a command that printed
          // nothing at all is indistinguishable from one that failed to run.
          if (opts.once === true) {
            process.stdout.write(
              `run ${result.run_id}: ${result.tasks_seen} tasks seen, no dispatch requests\n`,
            );
          }
          return;
        }
        const worth = result.outcomes.filter((o) => {
          if (o.kind !== "already_done") return true;
          const key = `${o.worker}\u0000${o.task_id}`;
          if (quiet.has(key)) return false;
          quiet.add(key);
          return true;
        });
        if (worth.length === 0) return;
        process.stdout.write(`${worth.map(renderOutcome).join("\n")}\n`);
      };

      if (opts.once === true) {
        emit(await relayPass({ run, fanOut, cache, ledger, roster: spec.roster }));
        return;
      }

      /**
       * D1: THE LOOP SURVIVES A THROWN PASS, because nothing restarts it.
       *
       * This was `for(;;) { emit(await relayPass(...)) }` with no catch, and
       * `cli/index.ts` catches at `main` and returns an exit code — so any throw
       * ENDED the actor. §6.5 chose a restartable host-side process on the
       * argument that *"a process that derives its state from the run tree needs
       * no supervision beyond being started again"*, and that argument holds
       * only where something starts it again. Nothing does: it has no pane, no
       * supervisor, and `scripts/review` does not mention it.
       *
       * The throws are not exotic. The missing-`/replies` diagnosis says in its
       * own docblock *"Nothing was journalled; the pass retries"* — it did not;
       * the process died. Any non-ENOENT `writeReply`, any fs failure inside
       * `recordDispatch`, and every `RelayAspectError` did the same.
       *
       * So a failed pass is logged and the loop continues. That is the same
       * judgement the pass makes internally about one request — a refusal is
       * data, not a reason to stop — applied to the pass itself.
       *
       * **`--once` deliberately does NOT get this.** A single pass is somebody
       * asking a question, and swallowing the answer would make the exit code
       * lie. The resilience belongs to the daemon shape, not to the verb.
       */
      /**
       * THE WATCH — §6.5's *"dies with the console"*, which was a claim in a
       * table and is now a loop condition (§9 Q4).
       *
       * The relay exits when the collator it was started for stops being live.
       * That is what makes `pifleet down` authoritative over a process it has
       * never heard of: down kills the supervisor, the worker stops answering,
       * and the actor reaps itself within `RELAY_ABANDON_PASSES` passes.
       *
       * `isLiveWorker` is the SAME predicate the fan-out's own run scan uses, so
       * "this console is gone" means here exactly what it means there. The
       * alternative — checking whether the run DIRECTORY exists — is the
       * predicate `productionRunSources` documents as not liveness at all:
       * *"`pifleet down` removes containers and leaves directories"*, so it
       * would answer `true` forever and the watch would never fire.
       */
      /**
       * The watched collator is the SELECTED console's, so a triage actor reaps
       * itself when `tri-1` goes away rather than when `col-1` does — §6.4's
       * *"The triage actor watches `tri-1` for the same reason the relay watches
       * its collator."* Left hard-coded, a triage actor would have exited the
       * moment the unrelated review console came down, and would have run
       * forever after its own console was gone.
       */
      const watch = new ConsoleWatch();
      const collator =
        spec.roster.collators.find((c) => existsSync(workerPaths(run, c).dir)) ??
        spec.roster.collators[0]!;

      for (;;) {
        try {
          emit(await relayPass({ run, fanOut, cache, ledger, roster: spec.roster }));
          const live = await productionRunSources.isLiveWorker(run, collator);
          const abandon = watch.observe(live, { worker: collator, runId: run.runId, console: "review" });
          if (abandon !== null) {
            process.stderr.write(`pifleet relay: ${abandon}\n`);
            await ledger
              .append("relay_console_gone", {
                worker: collator,
                detail: { run_id: run.runId, passes: watch.streak },
              })
              .catch(() => {});
            return;
          }
        } catch (err) {
          // stderr, not stdout: `--json` consumers parse stdout line by line and
          // a diagnostic in that stream is a parse error at the caller.
          process.stderr.write(
            `pifleet relay: pass failed, continuing: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        await new Promise((r) => setTimeout(r, pollS * 1_000));
      }
    });
}
