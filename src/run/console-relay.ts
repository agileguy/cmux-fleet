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
 * Every console that has an actor, and therefore a set of bookkeeping files.
 *
 * This is a FILENAME NAMESPACE, not a second console registry: the rosters and
 * aspect tables live in `cli/commands/relay.ts`'s `CONSOLES`, which this module
 * cannot import — `cli/commands/relay.ts` imports `ConsoleWatch` from here, so a
 * value import the other way is a runtime cycle, which is the same reason that
 * file gives for owning the registry in the first place.
 *
 * Two lists that must agree is a shape this repository already distrusts, so it
 * is closed the way `ConsoleSpec`'s two fields are: `console-relay.test.ts`
 * asserts SET EQUALITY against `CONSOLES`, so a console registered without
 * bookkeeping paths — or a name here with no console — is a red test rather than
 * an actor writing a file no manager reads.
 */
export const CONSOLE_NAMES = ["review", "triage"] as const;
export type ConsoleName = (typeof CONSOLE_NAMES)[number];

/**
 * The basename stem for one console's bookkeeping, and the ONLY place the
 * console name becomes part of a path.
 *
 * ## The membership check is not defensive programming against the type system
 *
 * `tsconfig.json` includes `src/**` and `test/**` and nothing else, and
 * `scripts/review` cannot be pulled in transitively either — it runs `main()` at
 * import, which is why `review-console-relay.test.ts`'s own header says *"nothing
 * in it can be imported by a test"*. So **the only production caller of these
 * three functions is a file the compiler never opens.** `ConsoleName` disciplines
 * `src/` and `test/`; this check is what disciplines the console scripts, and
 * without it a `scripts/triage` that passed a name nobody registered would
 * quietly bookkeep into a fourth set of files while the real triage actor used
 * the first — two actors, one console, no lock between them.
 *
 * It also refuses the traversal shape for free. The argument is interpolated into
 * a basename beside `~/.pifleet`, so `"../.."` would name a path outside it; a
 * `join` that silently escapes its directory is worth a throw rather than a
 * comment.
 */
function consoleStem(console_: ConsoleName): string {
  if (!(CONSOLE_NAMES as readonly string[]).includes(console_)) {
    throw new Error(
      `${JSON.stringify(console_)} is not a console this actor keeps books for ` +
        `(${CONSOLE_NAMES.join(", ")}). The name becomes a filename beside the runs root, so an ` +
        `unrecognised one is refused rather than joined: it would give a second actor its own ` +
        `record and lock, which is exactly the mutual exclusion those files exist to provide.`,
    );
  }
  return `${console_}-relay`;
}

/**
 * Where the record lives: BESIDE the runs root, not inside it, and PER CONSOLE.
 *
 * Inside would put a non-run file in the directory `runIdsAscending` enumerates,
 * which is how a stray filename becomes a run id and then a path segment. The
 * parent is `~/.pifleet` by default and follows `PIFLEET_RUNS_DIR` when it is
 * set, so a test never touches the operator's own.
 *
 * ## Why the console is a REQUIRED first parameter and not an optional last one
 *
 * These three basenames were `review-relay.{json,log,lock}`, host-wide, and
 * `pifleet relay --console triage` shipped before this did — so a triage actor
 * started today would write the review console's record and take the review
 * console's lock. §9.13 names the symptom and it is the silent one: *"the review
 * console silently stops fanning out"*.
 *
 * The tempting fix is `relayRecordPath(env, console = "review")`, and it is the
 * bug rather than the fix. A defaulted console is precisely the copy-paste
 * hazard: the caller that forgets the argument is the one that claims somebody
 * else's lock, and it compiles. Required makes the omission a type error at every
 * call site the compiler can see.
 *
 * **Console FIRST is then forced, not chosen.** TypeScript will not let a
 * required parameter follow an optional one, and `env` must stay optional —
 * it is the seam every hermetic test in this repository uses to point the whole
 * module at a temp directory. Console-first also makes the old spelling loud
 * rather than merely wrong: `relayRecordPath(env)` fails to compile because a
 * `Record` is not a `ConsoleName`, where `relayRecordPath(env)` under the
 * defaulted shape would have kept compiling and kept meaning "review".
 *
 * The review console's three basenames are UNCHANGED by the parameterisation.
 * That is deliberate: an operator upgrading has a relay running right now, and a
 * rename would orphan its record — leaving a live actor nothing on disk names,
 * which is the *"background process nobody can name"* this file's header calls
 * the real content of §6.5's objection.
 */
export function relayRecordPath(
  console_: ConsoleName,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dirname(runsRoot(env)), `${consoleStem(console_)}.json`);
}

/** Where a detached relay's stdout and stderr go. Beside the record, per console. */
export function relayLogPath(
  console_: ConsoleName,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dirname(runsRoot(env)), `${consoleStem(console_)}.log`);
}

export const RelayRecordSchema = z.object({
  schema: z.literal("pifleet.consolerelay/v1"),
  pid: z.number().int().positive(),
  /** A `processStartTime` token. The half that survives a recycled pid. */
  started: z.string(),
  /**
   * WHICH CONSOLE THIS ACTOR SERVES — the coarsest half of the identity, and the
   * one whose absence `servesConsole` could not see.
   *
   * `run_id` and `workers` below discriminate two REVIEW consoles from each
   * other. Neither discriminates a review console from a triage one, and after
   * `--console <name>` shipped that is a live pair rather than a hypothetical.
   *
   * ## Tolerant on read, strict on write, and the asymmetry is the whole design
   *
   * `.default("")` rather than a required field, on this schema's own precedent:
   * `workers` was added to a shipped record exactly this way, with a default
   * whose value matches NOTHING, so an older record parses and is adopted by
   * nobody. `contracts.ts` states the idiom for the registry's identical field —
   * *"Empty string means 'not recorded' … Fail-closed is preserved."*
   *
   * Making it required instead would turn every record written before this change
   * into `unreadable`, and `unreadable` is — correctly — the one verdict that
   * refuses to signal or delete anything. A running review relay would become a
   * process the script declines to touch and a file only a human can clear. The
   * default costs one relay restart on upgrade instead, automatically: `""` names
   * no console, `servesConsole` refuses it, and `scripts/review` replaces it.
   *
   * The write side gets no such tolerance — see `writeRelayRecord`. A record
   * SAVED without a console is a copy-paste bug, not history.
   *
   * `z.string()` and not `z.enum(CONSOLE_NAMES)`: a record naming a console this
   * build has never heard of must be READABLE and unadoptable, not `unreadable`.
   * Refusing to parse it is the direction that leaves an actor running with no
   * record any manager will look at.
   */
  console: z.string().default(""),
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
 *
 * ## AND THE CONSOLE IS CHECKED HERE, WHERE THE SCHEMA'S TOLERANCE STOPS
 *
 * `console` defaults to `""` so a record written before it existed still parses.
 * That tolerance is about HISTORY and must not extend to new writes: `.parse`
 * would fill `""` in silently for a caller that simply forgot the field, and the
 * result is a live actor whose record no console will ever adopt — a relay that
 * gets stopped and respawned on every run of the script, forever, for a reason
 * nothing prints.
 *
 * The caller that would forget is not hypothetical. `RelayRecord` is the schema's
 * OUTPUT type, so `console` is required on it and `src/` and `test/` callers get
 * a type error — but the only production writer is `scripts/review`, which
 * `tsconfig.json` does not include and no test can import. This throw is the
 * check that reaches it, and the next console's script is the one it is for.
 */
export async function writeRelayRecord(path: string, record: RelayRecord): Promise<void> {
  const parsed = RelayRecordSchema.parse(record);
  // Reuses the path validator so "a name that may be written" and "a name that
  // may be a filename" cannot drift into two different answers.
  consoleStem(parsed.console as ConsoleName);
  await writeJsonAtomic(path, parsed);
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
 * Which script an operator re-runs, and which document explains why, per console.
 *
 * **This table exists because the sentence was wrong for a year of one console
 * and then shipped to a second.** The abandonment reason named `scripts/review`
 * and `SRD-REVIEW-CONSOLE` unconditionally, so a triage actor that reaped itself
 * told the operator to re-run the wrong script and read the wrong document —
 * cosmetic, in that the structured log fields were right either way, and exactly
 * the kind of cosmetic that wastes somebody's evening at 3 a.m.
 *
 * A `Record<ConsoleName, …>` rather than a `switch`: a third console is a
 * `tsc --noEmit` error on this literal rather than a silent fall-through to
 * whichever arm was written first, which is the failure this table is repairing.
 */
const ABANDON_PROSE: Record<ConsoleName, { script: string; srd: string }> = {
  review: { script: "scripts/review", srd: "SRD-REVIEW-CONSOLE §6.5, §9 Q4" },
  triage: { script: "scripts/triage", srd: "SRD-TRIAGE-CONSOLE §6.4, §9 Q4" },
};

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
  observe(
    collatorIsLive: boolean,
    opts: { worker: string; runId: string; console: ConsoleName },
  ): string | null {
    if (collatorIsLive) {
      this.consecutiveGone = 0;
      return null;
    }
    this.consecutiveGone += 1;
    if (this.consecutiveGone < this.tolerance) return null;
    const { script, srd } = ABANDON_PROSE[opts.console];
    return (
      `${opts.worker} has not been live in run ${opts.runId} for ${this.consecutiveGone} ` +
      `consecutive passes, so the console this actor was started for is gone. Exiting rather ` +
      `than polling an inbox that can never answer: an actor attached to a dead console reports ` +
      `nothing forever and makes the next \`${script}\` believe an actor is already ` +
      `serving the new one (${srd})`
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
  // `process.execPath` and NOT the word `bun`, measured 2026-09-12: cmux is a
  // launchd-launched GUI app carrying PATH=/usr/bin:/bin:/usr/sbin:/sbin, so a
  // bare `bun` is `command not found` in every pane it spawns while `which bun`
  // succeeds in any terminal an operator would check it in. A relay is spawned
  // when nobody is watching, so the failure would surface as a console that
  // polls nothing rather than as an error anyone reads. Same idiom and reason as
  // `src/supervisor/launch.ts:39` and `operations-plan.ts`'s fourth host fact.
  return [process.execPath, "run", cliEntry, "relay", "--run", runId];
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
 *
 * ## THE NAME IS COMPARED FIRST, AND UNTIL NOW IT WAS NOT COMPARED AT ALL
 *
 * This function is called `servesConsole` and asked about a run id and a worker
 * set. Both discriminate one review console from another review console; neither
 * can tell a review console from a triage one, so the question in the name was
 * the one question it did not answer. That was harmless while `review` was the
 * only console with an actor and stopped being harmless when `--console <name>`
 * shipped.
 *
 * First, because it is the coarsest and because a mismatch here means the
 * comparison below is meaningless rather than merely negative: two consoles'
 * worker sets are disjoint by construction, so `false` from the worker arm would
 * be RIGHT for the wrong reason, and a fixture in which the rosters happened to
 * overlap would make it wrong outright.
 *
 * A record whose `console` is `""` — written before the field existed — matches
 * no console and is adopted by none. Fail-closed, and the same posture the `""`
 * start-time sentinel gets from `readRelayStatus`.
 */
export function servesConsole(
  record: RelayRecord,
  console_: { name: ConsoleName; runId: string; workers: readonly string[] },
): boolean {
  if (record.console !== console_.name) return false;
  if (record.run_id !== console_.runId) return false;
  /**
   * CONTAINMENT, NOT EQUALITY — the record must SERVE every worker the caller
   * needs, and may serve more. This is ISC-1057's decision about §6.4's
   * adoption rule, and the equality it replaces is why that criterion was filed.
   *
   * Equality asks *"were you configured exactly as I would configure you"*, and
   * on the triage console that question has no reachable yes. `pifleet triage`
   * takes `--once`, `--poll`, `--status` and `--json` and **no `--workers`**; its
   * record is written from the constant `TRIAGE_CONSOLE_ROSTER`
   * (`cli/commands/triage.ts:1375-1378`). `scripts/triage` compares that against
   * `opts.workers ?? DEFAULT_TRIAGE_WORKERS`. Those spell the same pair today —
   * `["tri-1", "obs-t1"]` — so the DEFAULT adopts, and every `--workers`
   * override is permanently unequal. `./scripts/triage --workers …` therefore
   * stopped a healthy actor and started an identical one on EVERY invocation,
   * quietly, on a console nobody watches.
   *
   * **The argument for containment rather than a narrower equality is that a
   * restart cannot change the thing being compared.** The replacement actor
   * reads the same constant and writes the same roster, so refusing to adopt
   * buys no convergence at all — it only pays the restart again next time. An
   * actor whose roster CONTAINS the caller's seats does serve those seats, which
   * is the question this function is named for.
   *
   * It does not weaken the review console. There the set IS an input —
   * `startRelay` passes the same list it built the panes from — so
   * `record.workers` equals the caller's and equality implies containment. What
   * the arm stops being is a way to fail permanently on a console where the
   * caller's set was never an input to the thing it is compared against.
   *
   * A caller naming a seat the record does NOT serve is still refused: that is
   * an operator asking for a console this actor cannot cover.
   *
   * **The U+0001 join this replaces is gone, and with it the hazard its comment
   * documented at length.** Joining a sorted set on `""` made `["ab", "c"]` and
   * `["a", "bc"]` compare equal, and the escape was the fix. A `Set` and
   * `every` compare elements as elements, so there is no separator to choose
   * and no encoding to get wrong — the collision is unrepresentable rather than
   * escaped around.
   */
  const served = new Set(record.workers);
  return console_.workers.every((w) => served.has(w));
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
  const { link, rename, rm, unlink, writeFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");

  /**
   * THE LOCK IS PUBLISHED WHOLE OR NOT AT ALL, and `open(path, "wx")` could not
   * do that.
   *
   * The previous version created the file and then wrote its identity into it,
   * which leaves a window where the lock EXISTS and is EMPTY. A crash there —
   * and a crash is the only reason this recovery path exists — left a zero-byte
   * lock that the takeover below cannot parse, so it refused forever and the
   * console was permanently actorless: the exact failure the takeover was
   * written to end, reintroduced by its own guard. Found by this repository's
   * review console reading this function hours after it was written.
   *
   * Writing to a temp name and `link`ing it into place fixes both halves at
   * once. `link` fails with EEXIST when the target exists, so it is the same
   * atomic exclusion `wx` gave, and the content is already in the inode before
   * the name appears — there is no moment at which a reader can see an
   * incomplete lock. Nothing holds a file descriptor afterwards either, so the
   * descriptor leak on a failed write is gone by construction rather than by a
   * `finally`.
   */
  const claim = async (): Promise<{ release: () => Promise<void> } | null> => {
    const started = await processStartTime(process.pid).catch(() => null);
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmp, `${process.pid}\n${started ?? ""}\n`);
    try {
      await link(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    } finally {
      await unlink(tmp).catch(() => {});
    }
    return {
      release: async () => {
        await rm(path, { force: true }).catch(() => {});
      },
    };
  };

  const first = await claim();
  if (first !== null) return first;

  /**
   * A LOCK WHOSE HOLDER IS GONE IS TAKEN OVER, and refusing to look was a
   * defect this module's own header describes.
   *
   * Before this, `EEXIST` was answered with `null` and the file was never
   * opened — so the pid written above was read by nobody, and ONE hard crash
   * left the lock behind forever until a person deleted it by hand.
   *
   * **The identity is `(pid, start time)`**, for the reason the relay RECORD
   * already carries that pair: pids are recycled, and a lock broken because an
   * unrelated process inherited the number is worse than the stale lock it
   * replaces. **UNREADABLE IS NOT STALE** — a lock we cannot parse, or a `ps`
   * we cannot run, leaves the refusal where it was, which is
   * `readRelayRecord`'s posture and `down.ts`'s before it.
   */
  let holder: { pid: number; started: string } | null = null;
  let empty = false;
  try {
    const text = await (await import("node:fs/promises")).readFile(path, "utf8");
    /**
     * AN EMPTY LOCK RECORDS NO HOLDER, WHICH IS NOT THE SAME AS ONE WE CANNOT
     * READ — and collapsing the two is what made a zero-byte lock permanent.
     *
     * "Unreadable is not stale" protects a holder we cannot identify. A file of
     * zero bytes identifies nobody and never did: it is the residue of a claim
     * that died between creating the name and writing into it, which older
     * builds of this function could produce and any interrupted copy still can.
     * There is no process whose lock we would be breaking, so the refusal
     * protected nothing and cost the console its actor permanently.
     *
     * Non-empty and unparseable stays refused. That one names SOMETHING, and
     * not understanding it is exactly the case where guessing is unsafe.
     */
    if (text.trim() === "") empty = true;
    else {
      const [pidLine = "", startedLine = ""] = text.split("\n");
      const pid = Number.parseInt(pidLine.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) holder = { pid, started: startedLine.trim() };
    }
  } catch {
    return null;
  }
  if (!empty && holder === null) return null;

  let live: string | null = null;
  try {
    if (holder !== null) live = await processStartTime(holder.pid);
  } catch {
    // The measuring instrument is broken; say nothing about the holder.
    return null;
  }
  if (holder !== null && live !== null) {
    // Present. Stale only if this is a DIFFERENT process wearing the pid, and
    // that is answerable only when both sides are comparable.
    if (!isPinnedIdentity(holder.started) || !isPinnedIdentity(live)) return null;
    if (holder.started === live) return null;
  }

  /**
   * THE TAKEOVER IS DECIDED BY `rename`, AND THE PREVIOUS COMMENT CLAIMING THE
   * KERNEL DECIDED WAS FALSE.
   *
   * That version did `rm(path)` and then re-claimed. Two starters that both
   * judge the lock stale then interleave as: A removes, A claims, B removes A's
   * FRESH lock, B claims — and both believe they hold it, which is the
   * concurrent-actor bug the lock exists to prevent, reached through its
   * recovery path. Re-reading the file afterwards does not fix it either: each
   * side can read its own token before the other overwrites.
   *
   * Moving the stale lock ASIDE is the atomic step. `rename` succeeds for
   * exactly one caller and every later one gets ENOENT, because the source name
   * is gone — so the right to replace the lock is won once, by the kernel, and
   * the claim that follows is an ordinary uncontended `link`.
   */
  const sidelined = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, sidelined);
  } catch {
    // Someone else won the takeover, or the holder released it in the meantime.
    return null;
  }
  await rm(sidelined, { force: true }).catch(() => {});
  return await claim();
}

/**
 * Where the start lock lives. Beside the record, per console, and removed with it.
 *
 * **This is the file §9.13 is about.** The lock is what makes "one starter at a
 * time" true, and a host-wide lock makes it true across CONSOLES as well — so a
 * triage actor starting while the review console holds it is told *"another
 * ./scripts/review is starting the relay right now"* and starts nothing, or wins
 * the race and leaves the review console's starter refusing instead. Per-console
 * is not a tidiness change: it is the difference between mutual exclusion between
 * two starters of the SAME actor, which is what the lock is for, and mutual
 * exclusion between two different consoles, which is a deadlock dressed as one.
 */
export function relayLockPath(
  console_: ConsoleName,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dirname(runsRoot(env)), `${consoleStem(console_)}.lock`);
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
