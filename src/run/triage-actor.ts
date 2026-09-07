/**
 * THE TRIAGE ACTOR'S RECORD, LOG, LOCK AND WATCH — SRD-TRIAGE-CONSOLE §7.7,
 * §6.4, §6.6 layer 4, §13 task 6.3.
 *
 * §6.4 decides the console's clock: *"a host-side actor, `pifleet triage`,
 * started last by `scripts/triage`, that is both the console's clock and its
 * fan-out performer"*. This module holds the four things that actor needs which
 * are not the pass itself — its record, its append-only log, its lock, and the
 * watch that ends it. Task 6.1 writes the pass; task 6.2 writes the command.
 *
 * ## WHY THIS FILE IS THIN, AND WHAT IT DELIBERATELY DOES NOT REINVENT
 *
 * §6.4 says it in one line — *"Supervision, taken from the relay rather than
 * reinvented"* — and Phase 2.3 already did the parameterising: `console-relay.ts`
 * owns the four-verdict status, the `(pid, start time)` identity, the
 * write-then-`link` lock claim with its `rename`-decided takeover, and
 * `ConsoleWatch` itself. Every one of those has a docblock recording a defect it
 * was written to close, and re-deriving any of them here would be re-deriving the
 * bug first. So this module BINDS that machinery to the triage console and adds
 * the three things it cannot supply: §7.7's extra record fields, an event log,
 * and the loop that turns an observation into an exit.
 *
 * ## TWO PLACES WHERE §7.7 AND THE SHIPPED CODE DISAGREE, AND HOW EACH IS SETTLED
 *
 * **1. The filenames.** §7.7 names `~/.pifleet/triage.json`, `triage.log` and
 * `triage.lock`. §6.4 is the operative sentence and says something else — *"so
 * `relayRecordPath`/`relayLogPath`/`relayLockPath` gain a console argument"* —
 * and Phase 2.3 built that, producing `triage-relay.{json,log,lock}` beside the
 * runs root, matching `Workflows/Consoles.md:64-66`'s `review-relay.*` convention
 * that §7.7 itself says it is copying. The shipped paths win: they are what
 * `scripts/triage --actor-stop` will read, §12's own probe is phrased in terms of
 * those three functions, and a second spelling would mean a stop that signals
 * nobody. §7.7's literal wording is a document defect and is reported rather than
 * implemented.
 *
 * **2. `run_id` versus `runs`.** §6.6 layer 4's resolution says *"§7.7's `run_id`
 * is wrong and becomes `runs`"* — a per-seat map, because the console is four
 * runs (§6.1's correction) and a recycle is four `down`s and four `up`s. But
 * `RelayRecordSchema` shipped with `run_id` and `servesConsole` compares it, so
 * deleting it would make every triage record unadoptable by the fleet's own
 * reader. Both are kept and their relationship is PINNED: `run_id` is derived
 * from `runs[tri-1]`, so "the record has two answers to which run" is
 * unrepresentable rather than merely discouraged. A seat absent from `runs` is a
 * seat whose pin is unresolved — §6.6's half-recycled console, which must be
 * representable or the next boundary reads a partial recycle as done — and an
 * unpinned collator gives `run_id: ""`, which names no run and is therefore
 * adopted by nobody. The same fail-closed posture `console: ""` already gets.
 *
 * ## THE RECORD KEEPS `pifleet.consolerelay/v1`, AND THAT IS LOAD-BEARING
 *
 * It is a `RelayRecord` PLUS §7.7's four fields, not a private shape. D12 makes
 * the run tree authoritative and the record a cursor, so the record's only jobs
 * are (a) letting a manager decide whether the recorded process is alive and (b)
 * making the in-flight state cheap to find. Job (a) goes through
 * `readRelayStatus`, and a record it answers `unreadable` for is one that —
 * correctly — *"never licenses a signal"*: a private schema literal would make
 * every triage actor unstoppable by the fleet's own reader while looking, from
 * inside this module, entirely fine.
 *
 * ## THE LOG IS APPEND-ONLY FOREVER, WHICH IS WHY THE EVENT TYPE IS CLOSED
 *
 * §7.7: *"appended never truncated"*. ISC-710 records what that costs — **a
 * credential written there is a credential forever** — so {@link appendActorLog}
 * takes an EVENT rather than a string, and the event union has no field a
 * credential could travel in: no headers, no request, no url, no token. The one
 * free-text field on the whole union is an exception message, and it goes through
 * `sanitizeToken`, so it is flattened to a single line of printable ASCII and
 * capped. That is a property of the type rather than of the next author's care,
 * which is the only kind of guarantee worth having about a file that never
 * shrinks.
 *
 * ## READ-ONLY BY CONSTRUCTION (§6.10, task 6.6)
 *
 * This module imports `node:fs/promises`, `console-relay.ts`, `paths.ts`,
 * `jsonl.ts` and `triage-notify.ts` for one sanitizer. It deliberately does NOT
 * import `dispatch-request.ts` — that module reaches `relay.ts` for
 * `isCollationTaskId`, which would drag the whole fan-out into the actor's import
 * closure, and §12's read-only guard is written against exactly that. The price
 * is that {@link TRIAGE_COLLATOR} is named here as well as in the roster; the
 * agreement is closed by a test asserting equality against
 * `TRIAGE_CONSOLE_ROSTER`, which is `console-relay.ts`'s own answer to two lists
 * that must agree and `task-ids.ts`'s reason for duplicating a constant rather
 * than importing one.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { writeJsonAtomic } from "../util/jsonl.ts";
import {
  ConsoleWatch,
  RELAY_ABANDON_PASSES,
  RelayRecordSchema,
  acquireRelayLock,
  relayLockPath,
  relayLogPath,
  relayRecordPath,
} from "./console-relay.ts";
import { sanitizeToken } from "./triage-notify.ts";

/** The console this module keeps books for, bound once so no caller can pass the other. */
export const TRIAGE_CONSOLE = "triage" as const;

/**
 * The seat the actor watches — `TRIAGE_CONSOLE_ROSTER.collators[0]`, named here
 * rather than imported (see the header's read-only note) and held to that value
 * by `triage-actor.test.ts`.
 *
 * §6.4: *"The triage actor watches `tri-1`"* for the same reason the relay
 * watches its collator. `cli/commands/relay.ts:940-947` records what the
 * alternative costs — left hard-coded to `col-1`, *"a triage actor would have
 * exited the moment the unrelated review console came down, and would have run
 * forever after its own console was gone"*.
 */
export const TRIAGE_COLLATOR = "tri-1";

// ---------------------------------------------------------------------------
// The three paths, bound to this console
// ---------------------------------------------------------------------------

/**
 * §7.7's record, at the path Phase 2.3 parameterised.
 *
 * The console argument is bound here rather than left to each caller for the
 * reason `relayRecordPath`'s own docblock gives about defaulting it: *"the caller
 * that forgets the argument is the one that claims somebody else's lock, and it
 * compiles"*. A caller that reaches for this function cannot name the review
 * console at all.
 */
export function triageActorRecordPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return relayRecordPath(TRIAGE_CONSOLE, env);
}

/** §7.7's log — appended, never truncated. */
export function triageActorLogPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return relayLogPath(TRIAGE_CONSOLE, env);
}

/** §7.7's lock. §9.13: a host-wide one is a deadlock between two consoles, not exclusion. */
export function triageActorLockPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return relayLockPath(TRIAGE_CONSOLE, env);
}

/**
 * Take the exclusive right to start the triage actor, or report that somebody
 * holds it.
 *
 * `acquireRelayLock` unchanged — its write-then-`link` claim and `rename`-decided
 * takeover are §6.4's *"taken unchanged"* list, and its docblock records that the
 * obvious `open(path, "wx")` spelling left a zero-byte lock that *"refused
 * forever and the console was permanently actorless"*.
 */
export async function acquireTriageActorLock(
  env: Record<string, string | undefined> = process.env,
): Promise<{ release: () => Promise<void> } | null> {
  return await acquireRelayLock(triageActorLockPath(env));
}

// ---------------------------------------------------------------------------
// §7.7's record
// ---------------------------------------------------------------------------

/**
 * What one pass leaves behind for the next actor to find — §7.7's three mutable
 * fields, and nothing else.
 *
 * Task 6.1's `triagePass` produces this. It is defined here rather than there
 * because the RECORD's shape is this task's, and a pass that returned some other
 * shape would be a compile error at the one call site rather than a field that
 * silently stops being written.
 */
export interface TriageActorCursor {
  /** §6.6: a per-seat map. A seat absent from it has no resolved pin. */
  readonly runs: Readonly<Record<string, string>>;
  /** §6.6 layer 2's monotonic counter, behind `T-sweep-<n>`. */
  readonly sweep_cursor: number;
  /** §6.4's skip count, notified at `max_consecutive_skips`. */
  readonly consecutive_skips: number;
}

/** The half of the record that does not change between passes. */
export interface TriageActorIdentity {
  readonly pid: number;
  /** A `processStartTime` token. The half that survives a recycled pid. */
  readonly started: string;
  readonly started_at: string;
  readonly log_path: string;
  readonly pinned: string | null;
  /**
   * The cadence this actor is RUNNING at, which is not necessarily the file's.
   *
   * §7.8 keeps `--cadence` as *"an override for a hand-run"*, so re-applying
   * `TriageConsoleConfigSchema`'s `[60, 3600]` bounds here would refuse a
   * legitimate override — and the record's job is to say what is happening, not
   * to re-validate what an operator was already allowed to ask for. Positive is
   * the only bound that belongs to the record itself.
   */
  readonly cadence_s: number;
  /** The console's full roster — every seat, pinned or not. */
  readonly workers: readonly string[];
}

export const TriageActorRecordSchema = RelayRecordSchema.extend({
  runs: z.record(z.string(), z.string()).default({}),
  cadence_s: z.number().int().positive(),
  sweep_cursor: z.number().int().nonnegative().default(0),
  consecutive_skips: z.number().int().nonnegative().default(0),
}).superRefine((rec, ctx) => {
  if (rec.console !== TRIAGE_CONSOLE) {
    ctx.addIssue({
      code: "custom",
      path: ["console"],
      message:
        `names console ${JSON.stringify(rec.console)}; this is the ${TRIAGE_CONSOLE} actor's ` +
        `record and a record naming another console must not be adopted as it — §9.13's ` +
        `symptom is the silent one, "the review console silently stops fanning out"`,
    });
  }
  for (const seat of Object.keys(rec.runs)) {
    if (!rec.workers.includes(seat)) {
      ctx.addIssue({
        code: "custom",
        path: ["runs", seat],
        message:
          `${seat} is not one of this console's seats (${rec.workers.join(", ")}), so no pass ` +
          `could have resolved a run for it`,
      });
    }
  }
  /**
   * THE ONE INVARIANT THAT MAKES `runs` AND `run_id` ONE FACT.
   *
   * `servesConsole` compares `run_id`; the fan-out uses `runs`. A record in which
   * they disagree is one where a manager adopts an actor that is dispatching
   * somewhere else, and nothing downstream can see it.
   */
  const expected = rec.runs[TRIAGE_COLLATOR] ?? "";
  if (rec.run_id !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["run_id"],
      message:
        `run_id is ${JSON.stringify(rec.run_id)} but runs[${TRIAGE_COLLATOR}] is ` +
        `${JSON.stringify(expected)}; the two are one fact and run_id is derived from the map ` +
        `(§6.6 layer 4)`,
    });
  }
});
export type TriageActorRecord = z.infer<typeof TriageActorRecordSchema>;

/**
 * Build the record from its two halves, deriving the fields that are not free.
 *
 * `run_id` is DERIVED rather than passed, which is what makes the invariant above
 * unreachable from the writing side: a caller cannot supply a disagreeing pair
 * because it cannot supply the pair at all.
 */
export function triageActorRecord(
  identity: TriageActorIdentity,
  cursor: TriageActorCursor,
): TriageActorRecord {
  return {
    schema: "pifleet.consolerelay/v1",
    pid: identity.pid,
    started: identity.started,
    console: TRIAGE_CONSOLE,
    run_id: cursor.runs[TRIAGE_COLLATOR] ?? "",
    pinned: identity.pinned,
    workers: [...identity.workers],
    started_at: identity.started_at,
    log_path: identity.log_path,
    runs: { ...cursor.runs },
    cadence_s: identity.cadence_s,
    sweep_cursor: cursor.sweep_cursor,
    consecutive_skips: cursor.consecutive_skips,
  };
}

export type TriageActorRecordRead =
  | { kind: "ok"; record: TriageActorRecord }
  /** No file. The ordinary state before the first start, and not an error. */
  | { kind: "absent" }
  | { kind: "refused"; reason: string };

/**
 * Parse the bytes of the record, returning a REFUSAL rather than throwing.
 *
 * `parseIncidentRecord`'s posture, taken rather than re-argued: the bytes are a
 * file, and a file can be hand-edited, truncated by a crash mid-write, or left by
 * a build whose record shape differed — *"none of which is a reason to end the
 * actor's loop, and all of which are reasons not to act on it"*.
 */
export function parseTriageActorRecord(text: string, path: string): TriageActorRecordRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return { kind: "refused", reason: `${path} is not JSON: ${(err as Error).message}` };
  }
  // `typeof null` is `"object"` and an array is an object, so both are spelled
  // out; a truncated write produces one or the other often enough to name them.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "refused", reason: `${path} does not hold a §7.7 actor record object.` };
  }
  const parsed = TriageActorRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length === 0 ? "(record)" : i.path.map(String).join(".")}: ${i.message}`)
      .join("; ");
    return { kind: "refused", reason: `${path} does not satisfy §7.7: ${issues}` };
  }
  return { kind: "ok", record: parsed.data };
}

/** Read the record off disk. A missing file is `absent`, never a refusal. */
export async function readTriageActorRecord(
  env: Record<string, string | undefined> = process.env,
  path: string = triageActorRecordPath(env),
): Promise<TriageActorRecordRead> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { kind: "absent" };
  return parseTriageActorRecord(await file.text(), path);
}

/**
 * Write the record so a reader never sees half of one.
 *
 * `writeJsonAtomic`, and a THROW rather than a refusal on a record the schema
 * rejects: reading a bad file is history, writing one is a bug. `writeRelayRecord`
 * makes the same split for the same reason.
 */
export async function writeTriageActorRecord(
  path: string,
  record: TriageActorRecord,
): Promise<void> {
  const parsed = TriageActorRecordSchema.parse(record);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, parsed);
}

// ---------------------------------------------------------------------------
// §7.7's log — appended, never truncated
// ---------------------------------------------------------------------------

export const TRIAGE_ACTOR_EVENT_KINDS = [
  "actor_started",
  "pass_completed",
  "pass_failed",
  "record_write_failed",
  "console_unobservable",
  "console_gone",
  "actor_stopped",
] as const;
export type TriageActorEventKind = (typeof TRIAGE_ACTOR_EVENT_KINDS)[number];

/**
 * Everything the actor may say on the one surface guaranteed to work — §9.15
 * surface 2, *"a file on the machine the actor is already running on"*.
 *
 * **A CLOSED union with no credential-shaped field, and that is the whole of
 * ISC-710's guarantee here.** The log never shrinks, so the question is not
 * whether a caller remembers to redact but whether a credential has anywhere to
 * sit. It does not: there is no `headers` arm, no `request` arm, no `url`, no
 * `token`. `reason` is an exception message and goes through `sanitizeToken`.
 */
export type TriageActorEvent =
  | { kind: "actor_started"; pid: number; run_id: string; cadence_s: number }
  | { kind: "pass_completed"; sweep_cursor: number; consecutive_skips: number }
  | { kind: "pass_failed"; reason: string }
  | { kind: "record_write_failed"; reason: string }
  | { kind: "console_unobservable"; worker: string; reason: string }
  | { kind: "console_gone"; worker: string; run_id: string; passes: number }
  | { kind: "actor_stopped"; passes: number };

/**
 * The budget for the one free-text field, and it is small on purpose.
 *
 * A stack trace or a serialized response body in an append-only file is a file
 * that grows without bound for a fault the operator will diagnose from the
 * process's stderr anyway. The cap makes the line a pointer rather than a copy.
 */
export const ACTOR_LOG_REASON_MAX_BYTES = 512;

/**
 * One event, one line. `key=value` throughout, on `deliveryLogLine`'s pattern.
 *
 * The free text is quoted AND sanitized: quoting alone would leave a newline
 * inside the quotes, which is a forged second record in a file whose whole
 * purpose is to be greppable after the fact.
 */
export function actorLogLine(event: TriageActorEvent, at: number): string {
  const reason = (raw: string): string =>
    `reason="${sanitizeToken(raw, ACTOR_LOG_REASON_MAX_BYTES)}"`;
  const rest = ((): string => {
    switch (event.kind) {
      case "actor_started":
        return `pid=${event.pid} run=${event.run_id} cadence_s=${event.cadence_s}`;
      case "pass_completed":
        return `sweep=${event.sweep_cursor} skips=${event.consecutive_skips}`;
      case "pass_failed":
      case "record_write_failed":
        return reason(event.reason);
      case "console_unobservable":
        return `worker=${event.worker} ${reason(event.reason)}`;
      case "console_gone":
        return `worker=${event.worker} run=${event.run_id} passes=${event.passes}`;
      case "actor_stopped":
        return `passes=${event.passes}`;
    }
  })();
  return `${new Date(at).toISOString()} triage-actor kind=${event.kind} ${rest}`;
}

/**
 * Append one event. **`appendFile`, never `writeFile`** — §7.7's *"appended never
 * truncated"* is a property of the syscall (`O_APPEND`) rather than of a claim,
 * and the difference is invisible in a one-line fixture.
 *
 * It takes the EVENT and not a rendered line, so there is no way to append
 * arbitrary text to this file at all. That is the structural half of ISC-710's
 * guarantee; the closed union is the other half.
 */
export async function appendActorLog(
  path: string,
  event: TriageActorEvent,
  at: number = Date.now(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${actorLogLine(event, at)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// The loop — §12's exit-when-the-console-is-gone, and its streak-reset mirror
// ---------------------------------------------------------------------------

export interface TriageActorDeps {
  /** Task 6.1's `triagePass`, injected so no test starts a clock or a fleet. */
  readonly pass: () => Promise<TriageActorCursor>;
  /** `productionRunSources.isLiveWorker` bound to this console's collator. */
  readonly isCollatorLive: () => Promise<boolean>;
  /** Persist §7.7's record. D12: a hint, not the authority. */
  readonly saveCursor: (cursor: TriageActorCursor) => Promise<void>;
  /** §7.7's append-only log. */
  readonly log: (event: TriageActorEvent) => Promise<void>;
  /** The wait between passes, injected so the cadence is assertable by value. */
  readonly sleep: (ms: number) => Promise<void>;
}

export interface TriageActorOptions {
  readonly cadenceS: number;
  /** The collator's run at start. Superseded by each pass's own `runs` map. */
  readonly runId: string;
  /** Stops the loop between passes. `scripts/triage --actor-stop`'s in-process twin. */
  readonly signal?: AbortSignal;
  readonly tolerance?: number;
  readonly pid?: number;
}

export type TriageActorExit =
  | {
      kind: "console_gone";
      worker: string;
      run_id: string;
      passes: number;
      /** `ConsoleWatch`'s sentence, for the caller's stderr. */
      reason: string;
    }
  | { kind: "stopped"; passes: number };

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Has the caller asked us to stop?
 *
 * A FUNCTION rather than an inline `opts.signal?.aborted === true`, and the
 * reason is the compiler rather than taste: control-flow analysis narrows
 * `signal.aborted` to `false` after the first inline check and then rejects the
 * second one as *"this comparison appears to be unintentional"* — TS reads a
 * `readonly boolean` as immutable within the function, which is precisely the
 * assumption an `AbortSignal` violates. Reading it through a call is what keeps
 * the second check honest instead of deleting it to satisfy the typechecker.
 */
function isStopped(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * THE ACTOR'S LOOP — three properties, each already argued somewhere else and
 * none of them invented here (§6.4, *"Supervision, taken from the relay rather
 * than reinvented"*).
 *
 * 1. **A thrown pass is logged and the loop continues.** `relay.ts:700-723` is
 *    the measured version: without it *"any throw ENDED the actor"*, and nothing
 *    restarts one. `--once` deliberately does not get this — that is task 6.2's,
 *    because a single pass is somebody's command and its exit code should mean
 *    something.
 * 2. **The watch ends it when its console is gone**, which is what makes
 *    `pifleet down` authoritative over a process it has never heard of.
 * 3. **A run of negatives, never one**, because liveness is read from a state file
 *    and a `ps` and both fail transiently.
 *
 * ## ONE DELIBERATE DIVERGENCE FROM `cli/commands/relay.ts`, AND IT IS THE POINT
 *
 * That loop observes liveness INSIDE the `try` that wraps the pass, so a pass
 * that throws skips the observation entirely. Here the observation happens
 * whether the pass threw or not — because a console that has gone away is among
 * the likeliest reasons for the pass to throw, and a watch that only runs after a
 * healthy pass cannot reap the actor whose console death is what broke it. That
 * is §6.4's own failure shape reached through the mechanism built to close it, one
 * layer further in.
 *
 * ## A BROKEN INSTRUMENT IS NOT A NEGATIVE OBSERVATION
 *
 * `readRelayStatus`'s `unverifiable` posture, applied to the watch: a probe that
 * THROWS leaves the streak exactly where it is. Both alternatives are wrong in a
 * way the criterion names — mapping a throw to `false` reaps a healthy actor after
 * five broken `ps` calls, which is the mirror's *"transient read failures must not
 * reap a healthy actor"* violated at the seam rather than in the counter; mapping
 * it to `true` makes an actor with a permanently broken probe immortal. The
 * production probe swallows its own errors and answers `false`
 * (`relay.ts:3432-3444`), so this arm is unreachable through it TODAY — but the
 * probe is injected, and the arm costs three lines.
 */
export async function runTriageActor(
  deps: TriageActorDeps,
  opts: TriageActorOptions,
): Promise<TriageActorExit> {
  const watch = new ConsoleWatch(opts.tolerance ?? RELAY_ABANDON_PASSES);
  let runId = opts.runId;
  let passes = 0;

  if (isStopped(opts.signal)) {
    await deps.log({ kind: "actor_stopped", passes });
    return { kind: "stopped", passes };
  }
  await deps.log({
    kind: "actor_started",
    pid: opts.pid ?? process.pid,
    run_id: runId,
    cadence_s: opts.cadenceS,
  });

  for (;;) {
    passes += 1;
    try {
      const cursor = await deps.pass();
      /*
       * A recycle (task 6.5) mints new runs mid-life, so the run the actor was
       * STARTED for stops being the run it is watching. Following the cursor is
       * what keeps the abandonment message naming a run that exists.
       */
      runId = cursor.runs[TRIAGE_COLLATOR] ?? runId;
      try {
        await deps.saveCursor(cursor);
        await deps.log({
          kind: "pass_completed",
          sweep_cursor: cursor.sweep_cursor,
          consecutive_skips: cursor.consecutive_skips,
        });
      } catch (err) {
        // D12: the run tree is authoritative and the record is a cursor, so a
        // record that cannot be written is not a reason to end the actor — but
        // it is a reason to say so on the surface guaranteed to work.
        await deps.log({ kind: "record_write_failed", reason: why(err) });
      }
    } catch (err) {
      await deps.log({ kind: "pass_failed", reason: why(err) });
    }

    let live: boolean | null = null;
    try {
      live = await deps.isCollatorLive();
    } catch (err) {
      await deps.log({ kind: "console_unobservable", worker: TRIAGE_COLLATOR, reason: why(err) });
    }
    if (live !== null) {
      const abandon = watch.observe(live, { worker: TRIAGE_COLLATOR, runId, console: "triage" });
      if (abandon !== null) {
        await deps.log({
          kind: "console_gone",
          worker: TRIAGE_COLLATOR,
          run_id: runId,
          passes,
        });
        return {
          kind: "console_gone",
          worker: TRIAGE_COLLATOR,
          run_id: runId,
          passes,
          reason: abandon,
        };
      }
    }

    await deps.sleep(opts.cadenceS * 1_000);
    if (isStopped(opts.signal)) {
      await deps.log({ kind: "actor_stopped", passes });
      return { kind: "stopped", passes };
    }
  }
}
