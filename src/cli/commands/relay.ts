/**
 * `pifleet relay` — the ACTOR (SRD-REVIEW-CONSOLE §6.5, §6.6).
 *
 * §6.5 offers three homes for the thing that turns a collator's
 * `dispatch-request.json` into real dispatches, and calls the choice BLOCKING.
 * It is settled in favour of the second: **a restartable host-side process whose
 * state is derived entirely from the run tree.** That answer also answers the
 * objection §6.5 raises against it — *"a fifth process with no pane, no
 * supervision, and no story for what happens when it dies mid-fan-out"* —
 * because a process that derives its state from the run tree needs no
 * supervision beyond being started again. **Idempotency IS the supervision
 * story**, and it lives in `run/relay-journal.ts` rather than here. This file is
 * deliberately the thin half.
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

import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import {
  REVIEW_CONSOLE_ROSTER,
  type ConsoleRoster,
  type DispatchRequest,
  readDispatchRequest,
} from "../../run/dispatch-request.ts";
import { classifyRequest, recordDispatch } from "../../run/relay-journal.ts";
import { inboxTaskPath, type RunPaths } from "../../run/paths.ts";
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
 * The name the fan-out ADAPTER is expected under, in `src/run/relay.ts`.
 *
 * The adapter rather than `relayFanOut` itself, because `relayFanOut` cannot be
 * called with what a poll has: it needs `runs` (worker → run, which this console
 * has four of) and `transport` (the four host effects over `controlCall`,
 * `harvestTask` and `writeReply`). It lives in `relay.ts` rather than in a
 * module of this file's invention because `RelayTransport` is declared there,
 * and the adapter's whole job is to satisfy that interface — splitting a type
 * from its only implementation across two modules is how they drift.
 *
 * A CONSTANT because it is a name two branches have to agree on and only one of
 * them can see this file. Spelled once here and quoted in the refusal below, so
 * an operator who hits the refusal is told the exact symbol that is missing.
 */
const FAN_OUT_EXPORT = "consoleFanOut";

/**
 * The fan-out core, resolved at ACTION time.
 *
 * Dynamic so that a tree in which `src/run/relay.ts` has not landed still loads
 * the CLI — a static import would make `pifleet --help` fail for every command —
 * and so that the failure, when it comes, names the module rather than arriving
 * as a resolution error from the loader.
 *
 * **There is deliberately no fallback.** A stub that dispatched nothing and
 * returned success would be indistinguishable from a working relay on every
 * observable this console has, which is §6.4's own failure shape: *"a collator
 * that dispatched three reviews is indistinguishable from one that dispatched
 * none"*. Refusing loudly is the only behaviour here that cannot be mistaken for
 * working.
 *
 * `EXIT.INTERNAL` and not `EXIT.USAGE`: nothing the operator typed can cause it
 * and nothing they can type will fix it. Reporting a build gap as a usage error
 * tells a machine caller to rewrite its arguments and try again, forever
 * (ISC-216).
 */
async function loadFanOut(): Promise<RelayFanOut> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("../../run/relay.ts")) as Record<string, unknown>;
  } catch (err) {
    throw new CliError(
      `the relay's fan-out core (src/run/relay.ts) is not present in this build: ${String(err)}. ` +
        `\`relay\` polls, validates and journals, and deliberately performs no dispatch of its own.`,
      EXIT.INTERNAL,
    );
  }
  const fanOut = mod[FAN_OUT_EXPORT];
  if (typeof fanOut !== "function") {
    throw new CliError(
      `src/run/relay.ts does not export \`${FAN_OUT_EXPORT}\`, so this build has a fan-out core ` +
        `(\`relayFanOut\`) with nothing to drive it. That function takes two values a poll does ` +
        `not have — \`runs\` (worker -> run; this console is four runs) and \`transport\` (the ` +
        `four host effects over controlCall, harvestTask and writeReply) — and supplying them is ` +
        `what \`${FAN_OUT_EXPORT}\` is for. \`relay\` refuses rather than dispatching nothing ` +
        `quietly, because those two outcomes are indistinguishable from the outside.`,
      EXIT.INTERNAL,
    );
  }
  return fanOut as RelayFanOut;
}

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

export function register(program: Command): void {
  program
    .command("relay")
    .description(
      "Poll collators' dispatch requests and perform the fan-out host-side " +
        "(the review console's actor; --once does a single pass and exits)",
    )
    .option("-r, --run <id>", "run id (defaults to the most recent live run)")
    .option("--once", "make a single pass and exit, rather than polling")
    .option("--poll <seconds>", `seconds between passes (default: ${DEFAULT_POLL_S})`)
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; once?: boolean; poll?: string; json?: boolean }) => {
      const pollS = opts.poll === undefined ? DEFAULT_POLL_S : Number(opts.poll);
      if (!Number.isFinite(pollS) || pollS <= 0) {
        throw new CliError(
          `--poll must be a positive number of seconds, not ${JSON.stringify(opts.poll)}`,
          EXIT.USAGE,
        );
      }

      const run = await resolveRunPaths(opts.run);
      const fanOut = await loadFanOut();
      const cache: InboxWorkerCache = new Map();

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
        process.stdout.write(`${result.outcomes.map(renderOutcome).join("\n")}\n`);
      };

      if (opts.once === true) {
        emit(await relayPass({ run, fanOut, cache }));
        return;
      }

      // The loop, and it is the whole of it. Everything that could be wrong is
      // in `relayPass`, which is why this is `while (true)` and not a state
      // machine: a poller whose loop has interesting logic has two places where
      // a pass can be skipped.
      for (;;) {
        emit(await relayPass({ run, fanOut, cache }));
        await new Promise((r) => setTimeout(r, pollS * 1_000));
      }
    });
}
