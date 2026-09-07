/**
 * THE TRIAGE ACTOR'S RECORD, LOG, LOCK, WATCH AND RECYCLE — SRD-TRIAGE-CONSOLE
 * §7.7, §6.4, §6.6 layer 4, §13 tasks 6.3, 6.3b and 6.5.
 *
 * ## WHAT ROUND 16 ADDED, AND WHY IT IS ALL IN THE LOOP RATHER THAN BESIDE IT
 *
 * §2.3a calls layer 4 *"what makes an unattended console possible at all"*, and
 * unattended is the whole of it: nobody is watching, so every property has to be
 * a property of the loop rather than of an operator's judgement. Three of them,
 * and each closes a failure the console would otherwise CAUSE:
 *
 * 1. **A lock (§13 task 6.3b).** {@link acquireTriageActorLock} shipped with task
 *    6.3 and nothing called it, so two `pifleet triage --poll` processes would
 *    both sweep the same run — §6.4's *"two concurrent sweeps against one control
 *    plane"* reached from the other side, the console causing the overload it
 *    exists to notice by being started twice. It is taken before the first pass
 *    and released in a `finally`, and a lock left by a DEAD pid does not refuse.
 * 2. **A per-seat, RESUMABLE recycle (§6.6 layer 4, §13 task 6.5).** Four `down`s
 *    and four `up`s between sweeps, decided seat by seat, because *"a four-run
 *    recycle can half-succeed where a one-run recycle could not"* and there is no
 *    transaction across four `up`s. See {@link seatsDueForRecycle}.
 * 3. **A gate.** *"No sweep is admitted while any seat's pin is unresolved"* —
 *    Constraint B, because a pinned worker the relay cannot resolve refuses every
 *    fan-out, so a sweep into a half-recycled console fails four times and reads
 *    as a model problem rather than a console one.
 *
 * The privileged half of (2) — the `down` and the `up` themselves — is NOT here
 * and structurally cannot be: see {@link TriageConsolePorts}.
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
  /**
   * §6.6 layer 4's PER-SEAT CLOCK — the sweep at which each seat's run was last
   * minted, or first seen. The field the boundary condition is computed from.
   *
   * **OPTIONAL because the PASS does not mint runs and the ACTOR does.** Task
   * 6.1's `triagePass` re-derives `runs`, `sweep_cursor` and `consecutive_skips`
   * every pass and returns a fresh cursor; it has no way to know when a seat was
   * recycled, because recycling happens BETWEEN passes and it is this module's
   * effect. So the pass returns a cursor without this field and
   * {@link runTriageActor} folds its own answer back in before persisting. The
   * split is the reason the field is optional rather than a hole: the one writer
   * is the one thing that knows.
   */
  readonly recycled_at?: Readonly<Record<string, number>>;
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
  /**
   * §6.6 layer 4's per-seat clock.
   *
   * **`.optional()` rather than `.default({})`, and the difference is a cross-file
   * pin rather than taste.** A `.default({})` makes the field required on the
   * PARSED type, which turns every hand-built `TriageActorRecordRead` literal in
   * the console's other test files into a `tsc` error — a contract change
   * arriving as breakage in files this task does not own. Optional keeps a record
   * written before recycling existed readable (it means *"no seat has been
   * recycled"*), keeps {@link triageActorRecord} the one writer that always emits
   * it, and leaves every reader spelling the absence once.
   */
  recycled_at: z.record(z.string(), z.number().int().nonnegative()).optional(),
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
   * The stamps are checked against the SEATS and deliberately NOT against
   * `runs`.
   *
   * A seat may carry a stamp while carrying no run: that pair is exactly §6.6's
   * half-recycled console, where `down` succeeded and `up` had not run when the
   * actor died. Requiring the keys to be a subset of `runs` would make the one
   * state the resumable recycle exists to recover unrepresentable, which is the
   * failure the record's `runs` field was widened for one paragraph up.
   */
  for (const seat of Object.keys(rec.recycled_at ?? {})) {
    if (!rec.workers.includes(seat)) {
      ctx.addIssue({
        code: "custom",
        path: ["recycled_at", seat],
        message:
          `${seat} is not one of this console's seats (${rec.workers.join(", ")}), so this actor ` +
          `could not have recycled it (§6.6 layer 4)`,
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
    recycled_at: { ...(cursor.recycled_at ?? {}) },
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
  "actor_refused",
  "actor_unsupervised",
  "pass_completed",
  "pass_failed",
  "record_write_failed",
  "console_unobservable",
  "console_gone",
  "boundary_unreadable",
  "seat_recycled",
  "recycle_failed",
  "sweep_withheld",
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
  /** §6.3b: somebody else holds {@link TriageConsolePorts.lockPath}. Nothing ran. */
  | { kind: "actor_refused"; reason: string }
  /** No {@link TriageConsolePorts}: no lock, no recycle, no gate. See its docblock. */
  | { kind: "actor_unsupervised" }
  | { kind: "pass_completed"; sweep_cursor: number; consecutive_skips: number }
  | { kind: "pass_failed"; reason: string }
  | { kind: "record_write_failed"; reason: string }
  | { kind: "console_unobservable"; worker: string; reason: string }
  | { kind: "console_gone"; worker: string; run_id: string; passes: number }
  /** The two reads that decide the boundary. Nothing torn down, no sweep admitted. */
  | { kind: "boundary_unreadable"; reason: string }
  /** §6.6 layer 4: one seat went down and came back up, at this sweep. */
  | { kind: "seat_recycled"; worker: string; sweep_cursor: number }
  | { kind: "recycle_failed"; worker: string; reason: string }
  /** §6.6 layer 4's gate: these seats had no resolved pin, so no sweep was dispatched. */
  | { kind: "sweep_withheld"; seats: readonly string[] }
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
      case "actor_unsupervised":
        return "ports=absent";
      case "pass_completed":
        return `sweep=${event.sweep_cursor} skips=${event.consecutive_skips}`;
      case "actor_refused":
      case "pass_failed":
      case "record_write_failed":
      case "boundary_unreadable":
        return reason(event.reason);
      case "console_unobservable":
      case "recycle_failed":
        return `worker=${event.worker} ${reason(event.reason)}`;
      case "console_gone":
        return `worker=${event.worker} run=${event.run_id} passes=${event.passes}`;
      case "seat_recycled":
        return `worker=${event.worker} sweep=${event.sweep_cursor}`;
      /*
       * The seat list goes through `sanitizeToken` even though every value in it
       * is host-minted from the roster. The log never shrinks, so the question
       * is not whether today's ids are safe but whether a newline has anywhere
       * to sit — and one inside a seat id would forge a second record in the one
       * file an operator greps after a half-recycle.
       */
      case "sweep_withheld":
        return `seats=${sanitizeToken(event.seats.join(","), ACTOR_LOG_REASON_MAX_BYTES)}`;
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

// ---------------------------------------------------------------------------
// §6.6 layer 4 and §6.3b — what an UNATTENDED actor needs that a pass does not
// ---------------------------------------------------------------------------

/**
 * The exclusion that stops two actors, and the four things a recycle is made of.
 *
 * ## WHY THESE ARRIVE AS FUNCTIONS AND NOT AS IMPORTS
 *
 * §6.6 layer 4's recycle is **four `down`s and four `up`s**, and `pifleet down`
 * and `pifleet up` are the fleet's control plane. `test/unit/triage-readonly.ts`
 * bans `cli/commands/up.ts`, `cli/commands/down.ts` and `Bun.spawn` from this
 * console's whole subtree BY NAME, and §12 grants the console exactly one
 * permitted exception (`run/dispatch-request.ts`) which is not this one. So the
 * privileged effect belongs at the composition root, exactly as task 6.1b decided
 * for the dispatch effect, and reaches this module as a port. That is a
 * structural fact rather than a taste: an implementation that imported the verbs
 * instead would go red in that file naming itself.
 *
 * ## WHY IT IS ONE OBJECT AND NOT EIGHT MEMBERS ON {@link TriageActorDeps}
 *
 * So that "this actor is unattended" is ONE fact with ONE answer. A caller either
 * supplies the console's ports or it does not; there is no half-ported actor that
 * holds a lock and never recycles, or recycles without exclusion — and the second
 * of those is §6.4's *"two concurrent sweeps against one control plane"* with a
 * `down` in its hand.
 */
export interface TriageConsolePorts {
  /**
   * §7.7's lock. {@link acquireTriageActorLock} in production.
   *
   * `null` means somebody holds it — **and a lock left by a DEAD pid is not
   * somebody**: `acquireRelayLock`'s `(pid, start time)` takeover already answers
   * that, which is why this port is that function rather than an `exists` check.
   * Without the takeover *"the remedy for a crash becomes an operator deleting a
   * file nobody documented"*.
   */
  readonly acquireLock: () => Promise<{ release: () => Promise<void> } | null>;
  /** Where that lock is, so the refusal names the file rather than describing it. */
  readonly lockPath: string;
  /** Every seat this console has. The recycle's domain and the gate's. */
  readonly seats: readonly string[];
  /** §7.8's `recycle_after_sweeps`. `0` stops the clock; see {@link seatsDueForRecycle}. */
  readonly recycleAfterSweeps: number;
  /** §9.11: *"A recycle is due while a sweep is in flight → the recycle waits."* */
  readonly sweepInFlight: () => Promise<boolean>;
  /** The per-seat pins, re-derived from the run tree. D12 makes this the authority. */
  readonly seatRuns: () => Promise<Readonly<Record<string, string>>>;
  /** Tear ONE seat down. Must be a no-op on a seat that is already down. */
  readonly downSeat: (seat: string) => Promise<void>;
  /** Bring ONE seat back up in a NEW run. The run id is read back, never returned. */
  readonly upSeat: (seat: string) => Promise<void>;
  /**
   * §7.7's record at start, for the per-seat clock the first boundary needs.
   *
   * A resumed actor may WITHHOLD its first sweep — that is the half-recycled case
   * — so it cannot wait for a pass to hand it the stamps. Without this read the
   * resume degrades into a restart, which is the one outcome §6.6's resolution
   * names as wrong.
   */
  readonly resume: () => Promise<TriageActorCursor | null>;
}

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
  /**
   * §6.6 layer 4's recycle, §6.6's sweep gate and §6.3b's lock.
   *
   * **REQUIRED as of §13 task 6.5b, and the arity is the guard.** It was
   * optional for exactly one round, as a reported residue: making it required
   * was a `tsc` error at `cli/commands/triage.ts`'s `productionLoop` call, and
   * that file belonged to another task. While it was optional an un-ported actor
   * announced `actor_unsupervised` on §7.7's log on every start — the loud tell
   * that the wiring had not landed. The tell is now the COMPILER, which is
   * strictly better: `actor_unsupervised` could only report the omission after a
   * console had already been started without a lock, 288 times a day, with
   * nobody watching.
   *
   * The `ports === undefined` branches below are therefore unreachable through
   * this type and are kept as the one thing a required field cannot express: a
   * caller that is not TypeScript. They cost three comparisons per pass and they
   * are why {@link triageActorLoop} still takes `TriageConsolePorts | undefined`.
   */
  readonly ports: TriageConsolePorts;
}

/**
 * §6.6 layer 4's BOUNDARY CONDITION — *"is this seat's run older than
 * `recycle_after_sweeps`, or absent"*, asked of each seat and never of the
 * console.
 *
 * ## Why per-seat, in the SRD's own words
 *
 * *"A four-run recycle can half-succeed where a one-run recycle could not — three
 * seats up, one down, and a console that fans out to nobody. There is no
 * transaction available across four `up`s, so the answer is re-entrancy
 * instead."* A console-wide *"have N sweeps elapsed since the last full
 * recycle"* reads a crash between the second seat and the third **as done**. This
 * predicate reads it as two seats still owed, which is what makes the next
 * boundary finish the job rather than start it over.
 *
 * ## The three clauses, and the one that is derived rather than chosen
 *
 * 1. **Absent ⇒ due.** The seat has no pin: it is either mid-recycle or gone, and
 *    both are repaired the same way.
 * 2. **Pinned and unstamped ⇒ stamped here, NOT due.** The other reading —
 *    *"unknown age means recycle"* — makes every actor restart tear the whole
 *    console down, which is precisely the *"restarted rather than completed"*
 *    outcome §6.6's resolution rules out. The cost of this clause is that an age
 *    the actor never witnessed is under-counted by at most one window.
 * 3. **Pinned and older than the window ⇒ due.**
 *
 * ## `recycle_after_sweeps: 0` stops the CLOCK and not the repair
 *
 * §7.8 says `0` disables recycling, *"the setting to use while measuring Q5"*.
 * Read as disabling clause 1 as well, it turns the knob into a deadlock: §6.6
 * admits no sweep while a pin is unresolved, so a console that lost a seat under
 * `0` would withhold every sweep forever with nothing permitted to repair it.
 * Clause 1 is not a freshness decision and does not answer to the freshness knob.
 */
export function seatsDueForRecycle(input: {
  readonly seats: readonly string[];
  readonly runs: Readonly<Record<string, string>>;
  readonly stamps: Readonly<Record<string, number>>;
  readonly sweepCursor: number;
  readonly recycleAfterSweeps: number;
}): { readonly due: readonly string[]; readonly stamps: Readonly<Record<string, number>> } {
  const stamps: Record<string, number> = { ...input.stamps };
  const due: string[] = [];
  for (const seat of input.seats) {
    if (input.runs[seat] === undefined) {
      due.push(seat);
      continue;
    }
    const stamp = stamps[seat];
    if (stamp === undefined) {
      stamps[seat] = input.sweepCursor;
      continue;
    }
    if (input.recycleAfterSweeps <= 0) continue;
    if (input.sweepCursor - stamp >= input.recycleAfterSweeps) due.push(seat);
  }
  return { due, stamps };
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
  | { kind: "stopped"; passes: number }
  /**
   * §6.3b: another actor holds §7.7's lock, so this one started nothing.
   *
   * It carries `reason` under the same name `console_gone` does, so a caller can
   * report both from one field.
   *
   * **The two do NOT share the command's stderr line, and §13 task 6.5b decided
   * why**: `console_gone` exits `0` — that actor ran, and its console ending is
   * the end of a life — while `refused` exits `EXIT.BACKEND_UNAVAILABLE`, because
   * a `--poll` that returns success having never polled is indistinguishable,
   * over the only channel a machine caller has, from one that ran all day. A
   * nonzero exit is a `CliError`, and `main()` writes a `CliError`'s message to
   * stderr itself, so sharing the line would print the same sentence twice. See
   * `cli/commands/triage.ts`'s action.
   */
  | { kind: "refused"; reason: string; passes: 0 };

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
  /*
   * The stop check runs before the lock, so an actor asked to stop before it
   * began takes nothing — and cannot leave a lock behind if the release path
   * were ever to change.
   */
  if (isStopped(opts.signal)) {
    await deps.log({ kind: "actor_stopped", passes: 0 });
    return { kind: "stopped", passes: 0 };
  }

  const ports = deps.ports;
  let lock: { release: () => Promise<void> } | null = null;
  if (ports !== undefined) {
    lock = await ports.acquireLock();
    if (lock === null) {
      /*
       * §6.3b: *"two `pifleet triage --poll` processes would both sweep the same
       * run"*, which is §6.4's *"two concurrent sweeps against one control
       * plane"* reached from the other side. The refusal NAMES the lock, because
       * the only thing an operator can do about it is look at that file.
       */
      const reason =
        `another ${TRIAGE_CONSOLE} actor holds ${ports.lockPath}; this one started nothing ` +
        `(§6.3b — two sweeps against one control plane is the overload the console exists to notice)`;
      await deps.log({ kind: "actor_refused", reason });
      return { kind: "refused", reason, passes: 0 };
    }
  }
  try {
    return await triageActorLoop(deps, opts, ports);
  } finally {
    // A lock this process holds past its own exit is a console nothing can
    // restart, so the release is a `finally` and not a line after the loop.
    if (lock !== null) await lock.release();
  }
}

async function triageActorLoop(
  deps: TriageActorDeps,
  opts: TriageActorOptions,
  ports: TriageConsolePorts | undefined,
): Promise<TriageActorExit> {
  const watch = new ConsoleWatch(opts.tolerance ?? RELAY_ABANDON_PASSES);
  let runId = opts.runId;
  let passes = 0;

  await deps.log({
    kind: "actor_started",
    pid: opts.pid ?? process.pid,
    run_id: runId,
    cadence_s: opts.cadenceS,
  });
  if (ports === undefined) await deps.log({ kind: "actor_unsupervised" });

  /*
   * §7.7's record at start. The per-seat clock has to be here before the first
   * boundary because that boundary may be the one finishing an interrupted
   * recycle, and a resumed actor that started from an empty clock would stamp
   * every surviving seat fresh and read the half-recycle as done.
   */
  let cursor: TriageActorCursor | null = null;
  if (ports !== undefined) {
    try {
      cursor = await ports.resume();
    } catch (err) {
      // The clock is a HINT (D12), so a record that cannot be read degrades the
      // resume into a restart rather than ending the actor — but it says so,
      // because a silent degrade here is a whole console recycled for nothing.
      await deps.log({ kind: "boundary_unreadable", reason: why(err) });
    }
  }
  let stamps: Record<string, number> = { ...(cursor?.recycled_at ?? {}) };

  for (;;) {
    passes += 1;

    /*
     * THE BOUNDARY, and it is BEFORE the pass rather than after it. §6.6 says
     * "between sweeps" and both edges qualify; this edge is the one that lets a
     * half-recycled console be repaired and swept within a single cadence
     * instead of two, and it is the edge at which "no sweep is in flight" is a
     * fact about the sweep this iteration is about to decide on.
     */
    let pins: Readonly<Record<string, string>> | null = null;
    if (ports !== undefined) {
      let inFlight = true;
      try {
        pins = await ports.seatRuns();
        inFlight = await ports.sweepInFlight();
      } catch (err) {
        /*
         * A BOUNDARY THE ACTOR CANNOT READ WITHHOLDS, which is the OPPOSITE of
         * the watch's rule three functions down — and deliberately, because the
         * two answer different questions. The watch's `unverifiable` posture
         * protects a healthy actor from being reaped by a broken `ps`. Here the
         * costs are reversed: withholding costs one cadence, and dispatching
         * into a console whose pins may be half-recycled costs four refused
         * fan-outs that §6.6 says "read as a model problem".
         */
        pins = null;
        await deps.log({ kind: "boundary_unreadable", reason: why(err) });
      }
      if (pins !== null && !inFlight) {
        const decision = seatsDueForRecycle({
          seats: ports.seats,
          runs: pins,
          stamps,
          sweepCursor: cursor?.sweep_cursor ?? 0,
          recycleAfterSweeps: ports.recycleAfterSweeps,
        });
        stamps = { ...decision.stamps };
        if (decision.due.length > 0) {
          const at = cursor?.sweep_cursor ?? 0;
          for (const seat of decision.due) {
            try {
              await ports.downSeat(seat);
              await ports.upSeat(seat);
              /*
               * Stamped only after the `up` RESOLVES. A seat whose `up` threw
               * minted no run, and stamping it would tell the next boundary the
               * seat is fresh when it is not even present.
               */
              stamps[seat] = at;
              await deps.log({ kind: "seat_recycled", worker: seat, sweep_cursor: at });
            } catch (err) {
              /*
               * The loop CONTINUES to the seats after this one. A recycle that
               * stopped at the first fault would leave the console more broken
               * than the one it was repairing, and the next boundary finds this
               * seat again anyway — it has no pin.
               */
              await deps.log({ kind: "recycle_failed", worker: seat, reason: why(err) });
            }
          }
          /*
           * §6.6: *"The gate is four pins RE-DERIVED, not four containers
           * running — those are different moments and only the later one is
           * safe."* This is the later one.
           */
          try {
            pins = await ports.seatRuns();
          } catch (err) {
            pins = null;
            await deps.log({ kind: "boundary_unreadable", reason: why(err) });
          }
          if (cursor !== null && pins !== null) {
            cursor = { ...cursor, runs: { ...pins }, recycled_at: { ...stamps } };
            runId = cursor.runs[TRIAGE_COLLATOR] ?? runId;
            try {
              await deps.saveCursor(cursor);
            } catch (err) {
              await deps.log({ kind: "record_write_failed", reason: why(err) });
            }
          }
        }
      }
    }

    /*
     * THE GATE. §6.6: *"No sweep is admitted while any seat's pin is
     * unresolved"*, because Constraint B says a pinned worker the relay cannot
     * resolve refuses every fan-out — so a sweep into a half-recycled console
     * fails four times and reads as a model problem rather than as a console one.
     */
    const unresolved =
      ports === undefined
        ? []
        : pins === null
          ? [...ports.seats]
          : ports.seats.filter((seat) => pins[seat] === undefined);

    if (unresolved.length > 0) {
      await deps.log({ kind: "sweep_withheld", seats: [...unresolved] });
    } else {
      try {
        const passed = await deps.pass();
        /*
         * The pass owns three of the cursor's fields and the actor owns the
         * fourth (see {@link TriageActorCursor.recycled_at}), so the clock is
         * folded back in here and nowhere else. With no ports there is no clock
         * and the pass's cursor reaches the record byte for byte.
         */
        const next: TriageActorCursor =
          ports === undefined ? passed : { ...passed, recycled_at: { ...stamps } };
        cursor = next;
        /*
         * A recycle (task 6.5) mints new runs mid-life, so the run the actor was
         * STARTED for stops being the run it is watching. Following the cursor is
         * what keeps the abandonment message naming a run that exists.
         */
        runId = next.runs[TRIAGE_COLLATOR] ?? runId;
        try {
          await deps.saveCursor(next);
          await deps.log({
            kind: "pass_completed",
            sweep_cursor: next.sweep_cursor,
            consecutive_skips: next.consecutive_skips,
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
