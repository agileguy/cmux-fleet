/**
 * THE CONSOLE'S ACTOR, AND THE SUPERVISION STORY THAT CAN ACTUALLY BE HONOURED
 * — SRD-REVIEW-CONSOLE §6.5, §9 Q4.
 *
 * `grep relay scripts/review` returned nothing. The console stood up four panes
 * and never started the thing that turns a collator's `dispatch-request.json`
 * into three reviews, so every part of the mechanism existed and the console did
 * not work: a collator would write a request, settle `partial`, and nothing on
 * the host would ever read it. §6.4's own failure shape, in the console built to
 * avoid it — *"a collator that dispatched three reviews is indistinguishable
 * from one that dispatched none"*.
 *
 * §6.5 offers three homes and objects to each. This module implements the
 * second — *"a new `pifleet relay` process, started by `scripts/review`"* —
 * and the whole of it is an answer to that option's stated objection: **"a fifth
 * process with no pane, no supervision, and no story for what happens when it
 * dies mid-fan-out. Nothing in this fleet is currently supervised by a shell
 * script."**
 *
 * ## THE STORY, IN FOUR PARTS, EACH OF WHICH IS HONOURED RATHER THAN CLAIMED
 *
 * 1. **A dead relay costs nothing but time, because its state is on disk.**
 *    `relay-journal.ts` owns "has parent T been fanned out", and `cli/commands/
 *    relay.ts` says it plainly: *"Idempotency IS the supervision story."* A
 *    process killed mid-fan-out has not journalled, so the next one re-dispatches
 *    rather than losing the review. That is what makes the remaining three parts
 *    sufficient rather than a fig leaf.
 * 2. **A crash inside a pass no longer ends the actor.** The loop catches, logs
 *    to stderr and continues. That is not this module's doing, and it is named
 *    here because it is what makes "started once" a viable shape at all.
 * 3. **Restarting it is one command, and it is the command the operator already
 *    runs.** `./scripts/review` is documented as the expected way to get back to
 *    the console; it is now also the way to get the actor back. The record below
 *    makes that idempotent: a live relay is left alone, a dead one is replaced.
 * 4. **It is visible and it is stoppable.** A background process nobody can name
 *    is the real content of §6.5's objection. The record carries the pid, the run
 *    it is polling, the pin it was given and where its output is going, so
 *    `pifleet down` not knowing about it is a gap an operator can close by hand
 *    rather than a mystery process.
 *
 * ## WHAT IS NOT HONOURED, SAID PLAINLY
 *
 * **Nothing restarts it automatically, and `pifleet down` is not authoritative
 * over it.** Bring the console's runs down outside this script and the relay
 * keeps polling a run that will never answer, quietly, forever — which is
 * §6.4's failure shape one more time. `scripts/review --relay-stop` and the pid
 * in the record are the remedies, and they are operator actions rather than
 * properties of the system. §9 Q4 asks for exactly this and the honest answer is
 * that a shell script cannot supply it; closing it properly means either a
 * supervisor that owns the process or a relay that watches its own run's
 * liveness, and both are larger than the wiring this change is.
 *
 * ## THE IDENTITY IS (pid, start-time) AND NEVER pid ALONE
 *
 * `registry.ts`'s own note records the measurement: a two-day-old dead run was
 * reported live because the OS recycled its pid onto a supervisor started later.
 * A pidfile carrying a bare pid has that defect by construction, and its
 * consequence here is the worse direction — `scripts/review` would find a
 * stranger's process "alive", decline to start a relay, and the console would be
 * silently actorless again.
 */

import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { isPinnedIdentity, processStartTime } from "../safety/procstart.ts";
import { writeJsonAtomic } from "../util/jsonl.ts";
import { runsRoot } from "./paths.ts";

/**
 * Where the record lives: BESIDE the runs root, not inside it.
 *
 * Inside would put a non-run file in the directory `runIdsAscending` enumerates,
 * which is how a stray filename becomes a run id and then a path segment. The
 * parent is `~/.pifleet` by default and follows `PIFLEET_RUNS_DIR` when it is
 * set, so a test never touches the operator's own.
 */
export function relayRecordPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(runsRoot(env)), "review-relay.json");
}

/** Where a detached relay's stdout and stderr go. Beside the record. */
export function relayLogPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(runsRoot(env)), "review-relay.log");
}

export const RelayRecordSchema = z.object({
  schema: z.literal("pifleet.consolerelay/v1"),
  pid: z.number().int().positive(),
  /** A `processStartTime` token. The half that survives a recycled pid. */
  started: z.string(),
  /**
   * The run this relay was pointed at — the collator's, under D4.
   *
   * **This field is what makes "a relay is already running" a COMPARISON.**
   * Without it the manager can only ask whether *a* relay exists, which answers
   * yes for one serving a console that was closed an hour ago. The documented
   * workflow reaches that in three steps: run the script, close the `review`
   * workspace by hand, run it again — four new runs, and an actor polling the
   * first console's inbox that the script reports as healthy.
   */
  run_id: z.string(),
  /** The `PIFLEET_RELAY_RUNS` value it was launched with, or `null`. */
  pinned: z.string().nullable().default(null),
  /**
   * The console's worker set, so a relay started for a DIFFERENT `--workers` set
   * is not adopted as this one's. `run_id` alone would miss it: two consoles can
   * share a collator run id only by accident, but one operator running
   * `--workers` variants would produce relays that differ in nothing else.
   */
  workers: z.array(z.string()).default([]),
  started_at: z.string(),
  log_path: z.string(),
});
export type RelayRecord = z.infer<typeof RelayRecordSchema>;

/**
 * What a record on disk means right now.
 *
 * `absent` and `stale` are deliberately different answers even though both lead
 * to "start one". A stale record is evidence that a relay ran and stopped —
 * possibly because it crashed on its first pass — and an operator who sees the
 * distinction knows to read the log. `absent` says nothing ever started.
 */
/**
 * What a record on disk means right now — FOUR verdicts, not three, and the
 * fourth is the one this repository already learned to need.
 *
 * `stale` and `unverifiable` are different facts and only one of them licenses a
 * signal. `contracts.ts` states the rule for the registry's identical field:
 * *"Empty string means 'not recorded' … `isPinnedIdentity("")` is false, so
 * `down` refuses exactly as it does for an absent registry entry. Fail-closed is
 * preserved."* `procstart.ts` exists to make the discrimination possible at all,
 * and its `IdentityReadError` is a MEASURED case — a `ps` signal-killed under
 * memory pressure reports `exitCode: null` with both pipes silent, which is
 * indistinguishable from an absent process on every channel except that one.
 *
 * Collapsing either into `stale` is the destructive direction: the caller
 * deletes the record of, and stops signalling, a process that is still running —
 * *"a background process nobody can name"*, which is the exact state this record
 * exists to prevent.
 */
export type RelayStatus =
  | { kind: "absent" }
  /** The recorded process is gone. The only verdict that licenses replacing it. */
  | { kind: "stale"; record: RelayRecord }
  /** A record we cannot parse at all. Never signalled, never deleted. */
  | { kind: "unreadable"; reason: string }
  /**
   * A record whose identity cannot be COMPARED — an unpinned `started`, or a
   * `ps` that could not be read. The process may well be alive; the caller must
   * neither adopt it as this console's nor tear it down.
   */
  | { kind: "unverifiable"; record: RelayRecord; reason: string }
  | { kind: "live"; record: RelayRecord };

/**
 * Read the record and decide whether the process it names is still ours.
 *
 * `identityAlive`'s comparison, inlined rather than imported, so this module
 * does not pull in `registry.ts` — which reaches the run enumerator, the worker
 * state reader and the verbgate collector to answer a question about one pid.
 * The inlining is also what lets the `unverifiable` arm exist here: `identityAlive`
 * returns a boolean and has nowhere to put the third answer.
 */
export async function readRelayStatus(path: string): Promise<RelayStatus> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (err) {
    // ENOENT is the ordinary state and is not an error worth a reason.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  const parsed = RelayRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "unreadable",
      reason: `${path} is not a relay record: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  const record = parsed.data;

  /**
   * THE CAPTURE-FAILED SENTINEL, RECOGNISED. `startRelay` persists `""` when
   * `processStartTime` returns null or throws, and an empty string matches no
   * real start time — so comparing it would report a live relay as stale, delete
   * its record, and leave it polling runs the operator is about to tear down.
   * `isPinnedIdentity` is the repository's own test for "is this value
   * comparable at all", and it is false for `""` and for anything written before
   * the format was pinned.
   */
  if (!isPinnedIdentity(record.started)) {
    return {
      kind: "unverifiable",
      record,
      reason:
        `the record for pid ${record.pid} carries no comparable start time ` +
        `(${record.started === "" ? "capture failed when it was written" : "an unpinned format"}), ` +
        `so whether that process is this relay cannot be established`,
    };
  }

  let started: string | null;
  try {
    started = await processStartTime(record.pid);
  } catch (err) {
    // `ps` could not be read — a MEASURED case, not a hypothetical. Never
    // `stale`: the caller must not kill or replace a process it could not
    // identify, which is `down.ts`'s posture for the same read.
    return {
      kind: "unverifiable",
      record,
      reason: `the identity of pid ${record.pid} could not be read (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  if (started === null || started !== record.started) return { kind: "stale", record };
  return { kind: "live", record };
}

/**
 * Write the record so a reader never sees half of one.
 *
 * `writeJsonAtomic`, because every other durable control-plane record in this
 * repository goes through it and the failure mode here is the worst kind of
 * sticky: a torn write leaves `readRelayStatus` answering `unreadable` forever,
 * and `unreadable` is — correctly — the one verdict that refuses to signal or
 * delete anything. The console would be permanently actorless until a human
 * deleted a file, and the refusal that made it so would be right at every step.
 */
export async function writeRelayRecord(path: string, record: RelayRecord): Promise<void> {
  await writeJsonAtomic(path, RelayRecordSchema.parse(record));
}

/**
 * THE SUPERVISION §6.5 ASSUMED AND NOBODY BUILT.
 *
 * §6.5's table gives *"dies with the console"* as a reason to prefer a process
 * started by `scripts/review`, and nothing implemented it — the relay outlived
 * every console it was ever started for. §9 Q4 asks what supervises the actor
 * and names the consequence precisely: it decides *"whether `pifleet down`
 * remains authoritative about what is running"*.
 *
 * **The objection that matters is not the one §6.5 wrote down.** It worried
 * about the actor dying mid-fan-out, and the journal answers that: nothing is
 * recorded until the children are dispatched, so a killed relay re-dispatches
 * rather than losing a review. The live failure is the opposite one — an actor
 * that does NOT die. A relay left polling a console that is gone reports nothing
 * for an empty pass, forever, and a manager that asks only "is a relay running"
 * calls it healthy. That is §6.4's own failure shape reached through the
 * mechanism built to close it.
 *
 * So the actor watches the console it was started for and exits when it is gone.
 * `pifleet down` becomes authoritative within `tolerance` passes without `down`
 * knowing this process exists, which is the property that makes a host-side
 * actor honest rather than merely convenient.
 *
 * ## Why a run of consecutive observations rather than the first `false`
 *
 * Liveness is read from the worker's state file and a `ps`, and both can fail
 * transiently — a truncated read during a supervisor's own write, a `ps` under
 * load. Exiting on the first negative would make the actor's lifetime depend on
 * a race it has no stake in. A RUN of them cannot be transient: the supervisor
 * is gone and is not coming back under the same run id.
 *
 * The count is deliberately small. Every pass the relay spends attached to a
 * dead console is a pass in which a request written into a live console's outbox
 * is not read, and the operator's remedy — re-running the script — is blocked by
 * a relay that still looks alive.
 */
export const RELAY_ABANDON_PASSES = 5;

/**
 * The watch, as a state machine with no I/O so the policy is testable without a
 * fleet. The caller supplies the observation; this decides what it means.
 */
export class ConsoleWatch {
  private consecutiveGone = 0;

  constructor(private readonly tolerance: number = RELAY_ABANDON_PASSES) {}

  /** How many consecutive negative observations have been made. */
  get streak(): number {
    return this.consecutiveGone;
  }

  /**
   * Feed one observation. Returns a reason to STOP, or `null` to keep polling.
   *
   * A single positive observation resets the streak completely: a console that
   * answered once is a console that exists, and carrying a partial count forward
   * would let a run of unrelated transient failures accumulate into an exit.
   */
  observe(collatorIsLive: boolean, opts: { worker: string; runId: string }): string | null {
    if (collatorIsLive) {
      this.consecutiveGone = 0;
      return null;
    }
    this.consecutiveGone += 1;
    if (this.consecutiveGone < this.tolerance) return null;
    return (
      `${opts.worker} has not been live in run ${opts.runId} for ${this.consecutiveGone} ` +
      `consecutive passes, so the console this relay was started for is gone. Exiting rather ` +
      `than polling an inbox that can never answer: a relay attached to a dead console reports ` +
      `nothing forever and makes the next \`scripts/review\` believe an actor is already ` +
      `serving the new one (SRD-REVIEW-CONSOLE §6.5, §9 Q4)`
    );
  }
}

/**
 * The argv for a console relay, as a pure function so the wiring is assertable
 * without spawning anything.
 *
 * `--run` is passed EXPLICITLY and never left to `resolveCollatorRun`. That
 * default resolves *"the newest live run that actually materialised a
 * collator"* by checking whether the worker's DIRECTORY exists — and
 * `productionRunSources.isLiveWorker` records why that predicate is not
 * liveness: *"`pifleet down` removes containers and leaves directories, so every
 * run this operator has ever started answered `true`"*. The script has just read
 * `status --all --json`, which carries the real `alive` flag, so it knows the
 * answer better than the fallback can and says so rather than relying on it.
 */
export function consoleRelayArgv(cliEntry: string, runId: string): string[] {
  return ["bun", "run", cliEntry, "relay", "--run", runId];
}

/**
 * Stop a relay we recorded, and say what happened.
 *
 * SIGTERM to the pid alone and never to a process group. `down.ts` signals
 * groups because it is reaping supervisors that own containers; this is one
 * `bun` process with no children, and a group signal from a record that could be
 * stale is how an unrelated shell dies. The identity check above is what makes
 * even the single signal safe, and it is the caller's job to have made it.
 */
/**
 * Does a live relay serve THIS console?
 *
 * Exported and pure so the comparison is pinned without a fleet, and separate
 * from `readRelayStatus` because the two answer different questions: that one
 * asks whether the recorded process is running, this one asks whether it is
 * OURS. Conflating them is exactly the defect this pair replaces — a manager
 * that returned early on "running" never reached the run it should have compared
 * against, so the check compared nothing.
 */
export function servesConsole(
  record: RelayRecord,
  console_: { runId: string; workers: readonly string[] },
): boolean {
  if (record.run_id !== console_.runId) return false;
  // Order-insensitive: `--workers` is a list the operator types and the pane
  // plan is what fixes the order, not this record.
  const a = [...record.workers].sort().join("");
  const b = [...console_.workers].sort().join("");
  return a === b;
}

/**
 * Take the exclusive right to start a relay, or report who holds it.
 *
 * `wx` is `O_CREAT|O_EXCL`, which is atomic on every filesystem this runs on —
 * two `scripts/review` invocations racing cannot both succeed, and the loser is
 * told rather than silently spawning a second actor. Without it the sequence is
 * read, decide, spawn, write with nothing between the read and the write, and
 * two consoles opened in quick succession leave two relays polling one run.
 *
 * The lock is a SEPARATE file from the record on purpose. The record is durable
 * state describing a process that should outlive this script; the lock describes
 * a critical section inside it, and a crash mid-section must not leave a stale
 * record behind. The caller releases it in a `finally`.
 */
export async function acquireRelayLock(path: string): Promise<{ release: () => Promise<void> } | null> {
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${process.pid}\n`);
    return {
      release: async () => {
        await handle.close().catch(() => {});
        await (await import("node:fs/promises")).rm(path, { force: true }).catch(() => {});
      },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

/** Where the start lock lives. Beside the record, and removed with it. */
export function relayLockPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(runsRoot(env)), "review-relay.lock");
}

export function signalRelay(pid: number): "signalled" | "gone" | "refused" {
  try {
    process.kill(pid, "SIGTERM");
    return "signalled";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return "refused";
  }
}
