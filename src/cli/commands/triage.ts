/**
 * `pifleet triage` — the triage console's ACTOR (SRD-TRIAGE-CONSOLE §6.4).
 *
 * §6.4 settles the clock as *"a host-side actor, `pifleet triage`, started last by
 * `scripts/triage`, that is both the console's clock and its fan-out
 * performer"*, and gives the reason one process holds both jobs: *"The tick must
 * dispatch into a run, and the fan-out must dispatch into the same run. Two
 * processes that must agree about a run id is a new failure mode with no
 * observable."*
 *
 * ## THIS MODULE IS THE ADAPTER, AND THAT IS ITS WHOLE JOB
 *
 * `triagePass` (task 6.1) names no path, no container and no task file — it takes
 * a {@link SweepDriver} with nine members and an {@link IncidentStore} with two,
 * *"so a test drives it with no timer"* (§12's first clock criterion). Somebody
 * has to know the run-tree paths, the control socket and the incident-record
 * root. **That somebody is here**, one layer below the verb an operator types and
 * one layer above every module that holds a decision, which is why §12 asks for
 * the mirror-image anti-criterion on `scripts/triage`: *"no decision lives in
 * `scripts/triage` … assert the roster, the pane plan and the cadence default are
 * all `src/` exports. §3.3 — `scripts/` is untypechecked and uncovered."*
 *
 * ## `--once` IS THE REAL COMMAND, THE LOOP IS THE WRAPPER, AND THE ASYMMETRY IS
 * ## DELIBERATE
 *
 * `relay.ts:82-88`'s pattern, copied for its stated reason: *"a poller written as
 * an infinite loop can only be tested by starting it and killing it, which is a
 * test that measures its own timeout"*. So `--once` calls one pass and `--poll`
 * hands the same pass to {@link runTriageActor}.
 *
 * The one thing that is NOT symmetric between them is the catch, and §6.4 states
 * it as a decision rather than an omission: the loop *"catches a thrown pass and
 * continues"* (`relay.ts:700-723` — the version without it meant *"any throw
 * ENDED the actor"*, and nothing restarts one); **`--once` deliberately does not
 * get the catch, because a single pass is somebody's command and its exit code
 * should mean something.**
 *
 * That asymmetry is the half of §12's *"a thrown pass does not end the actor, and
 * `--once` still exits nonzero"* that lives in THIS file. The loop's half lives in
 * `run/triage-actor.ts` and is already asserted there. Here the load-bearing fact
 * is a negative — that nothing wraps the `--once` call — and a negative is exactly
 * what a later edit adds a `try` to without noticing, so it is asserted by driving
 * a throwing pass through both entry points in one test.
 *
 * ## `--status` REPORTS THREE FIELDS AND MUST NEVER REPORT A FOURTH THAT SUMS THEM
 *
 * §6.9 requirement 7, quoted in §12 as an anti-criterion: *"The absence of
 * notifications is never evidence of health, and `--status` must not be readable
 * that way. It reports sweeps completed, incidents by state, and the undelivered
 * count as three distinct fields."* A single `ok` line is precisely how *"quiet"*
 * and *"could not speak"* become one row.
 *
 * `reporterStatus` (ISC-709) already refuses an aggregate for the CHANNEL, and its
 * own docblock records that it claims one of the three: *"The other two of §12's
 * three distinct fields — sweeps completed, and incidents by state — belong to the
 * actor, which holds the sweep counter and the record set."* Both of those are
 * assembled here, and neither had a producer before this module:
 *
 *  - **Sweeps completed** is §7.7's `sweep_cursor`, off the actor record.
 *  - **Incidents by state** is a census of §7.6's record SET, which nothing walked.
 *
 * ### An absent actor record is not zero sweeps, and an unreadable incident record
 * ### is not a clear one
 *
 * Both are the same mistake in two places, and both are the mistake this whole
 * console exists to refuse: reading an absence as health. So
 * {@link TriageStatus.sweeps_completed} is `number | null` and the `null` means
 * *"no actor record on disk"*, which is a different fact from a console that
 * started and has not yet completed a sweep; and a record the schema refuses is
 * counted in {@link IncidentCensus.refused} and in NO state bucket, because
 * folding it into `clear` would let a truncated write present as good news.
 *
 * ### The census derives its console-health names from the exported enum
 *
 * `CONSOLE_HEALTH_KINDS` is imported and membership-tested rather than re-spelled.
 * The set grew from six to seven on 2026-09-06 (task 5.4d, `inference_unreachable`)
 * and §6.8a's table is the kind of thing that grows again; a second hand-written
 * copy here would silently start reporting a live incident kind as an unrecognised
 * file.
 *
 * ## WHAT THIS MODULE MAY NOT REACH
 *
 * §12's read-only block: *"no mutating verb, control-socket client or ledger
 * writer is reachable from the triage console's own modules"*, with **one** named
 * exception — the dispatch path — and the 2026-09-06 RULING that the abandonment
 * reason goes to §7.7's own append-only log rather than the fleet ledger, because
 * `cli/commands/relay.ts`'s `ledger.append("relay_console_gone", …)` *"is the
 * review console's answer and is exactly the reachability this block forbids"*.
 * So this file writes the actor's own log and never a `LedgerWriter`, and it must
 * not import `cli/commands/relay.ts`, which holds one.
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import {
  inboxTaskPath,
  runIdsAscending,
  runPaths,
  runsRoot,
  taskRecordPath,
  workerPaths,
  type RunPaths,
} from "../../run/paths.ts";
import { readTaskRecord } from "../../run/state.ts";
import { collationTaskId, sweepNumber, sweepTaskId } from "../../run/task-ids.ts";
import {
  TRIAGE_CONSOLE_ROSTER,
  readDispatchRequest,
} from "../../run/dispatch-request.ts";
import { partitionFromRequests } from "../../run/triage-partition.ts";
import {
  sweepProducers,
  type SweepProducerDeps,
  type SweepProducers,
} from "../../run/triage-envelope.ts";
import { triagePass, type InFlightSweep, type SweepDriver, type TriagePassOutcome } from "../../run/triage-pass.ts";
import {
  CONSOLE_HEALTH_KINDS,
  CONSOLE_SCOPE,
  INCIDENT_STATES,
  incidentRecordRoot,
  parseIncidentRecord,
  type ConsoleHealthKind,
  type IncidentState,
  type IncidentSubject,
} from "../../run/triage-incident.ts";
import {
  TRIAGE_COLLATOR,
  readTriageActorRecord,
  runTriageActor,
  triageActorLogPath,
  type TriageActorExit,
  type TriageActorRecordRead,
} from "../../run/triage-actor.ts";

// ---------------------------------------------------------------------------
// The census — §12's second `--status` field, which had no producer
// ---------------------------------------------------------------------------

/**
 * A record on disk the census could not read, kept OUT of every state bucket.
 *
 * `parseIncidentRecord` returns a refusal rather than throwing *"because the bytes
 * are a file, and a file can be hand-edited, truncated by a crash mid-write, or
 * left behind by a build whose record shape differed"*. The census inherits that
 * posture and adds the reporting half: a refusal is published as its own row, so
 * an operator reading `--status` sees that the console has state it cannot
 * account for rather than seeing a smaller, tidier, wrong table.
 */
export interface CensusRefusal {
  readonly path: string;
  readonly reason: string;
}

/**
 * §12's *"incidents by state"*, plus the two things a bare histogram would hide.
 *
 * `by_state` names **every** member of {@link INCIDENT_STATES} whether or not any
 * record is in it, on `monitor-readonly.test.ts`'s rule that naming the permitted
 * set is what makes a missing member fail. A sparse object would let `firing: 0`
 * and *"the key was never emitted"* look the same to a caller doing `?? 0`.
 */
export interface IncidentCensus {
  readonly by_state: Readonly<Record<IncidentState, number>>;
  /** Records read and understood. Equals the sum of `by_state`'s values. */
  readonly records: number;
  /** §7.6's `undelivered[]`, summed. §12's THIRD field. Never merged with a state. */
  readonly undelivered: number;
  /** Records on disk this census declined to count. Never folded into `clear`. */
  readonly refused: readonly CensusRefusal[];
}

/** Every state at zero — the shape a census starts from and never departs from. */
function emptyByState(): Record<IncidentState, number> {
  const out = {} as Record<IncidentState, number>;
  for (const state of INCIDENT_STATES) out[state] = 0;
  return out;
}

const HEALTH_KINDS: ReadonlySet<string> = new Set<string>(CONSOLE_HEALTH_KINDS);

/**
 * Reconstruct the subject a file at this location claims to be about.
 *
 * `parseIncidentRecord` takes the `expected` subject as a REQUIRED parameter —
 * *"the caller that forgets the argument is the caller that acts on another
 * service's state, and it would compile"* — so a census that walks paths must be
 * able to say what it expected before it reads. §7.6's `<env>/<service>.json` and
 * §6.8a's `<scope>/_console/<kind>.json` are the only two layouts
 * {@link incidentRecordPath} produces, and they cannot collide because
 * `CONSOLE_SCOPE` is unspellable as an environment name.
 *
 * Returning `null` for a name that is not a live `ConsoleHealthKind` is what makes
 * a stale record from a build whose enum differed show up as a refusal rather than
 * as a subject that no longer exists. The kinds come from the exported tuple, so a
 * file named for a member added after this line was written is read, not rejected.
 */
function subjectForPath(scope: string, rest: readonly string[]): IncidentSubject | null {
  if (rest.length === 1) {
    const name = rest[0]!;
    if (!name.endsWith(".json")) return null;
    return { kind: "service", environment: scope, service: name.slice(0, -".json".length) };
  }
  if (rest.length === 2 && rest[0] === CONSOLE_SCOPE) {
    const name = rest[1]!;
    if (!name.endsWith(".json")) return null;
    const health = name.slice(0, -".json".length);
    if (!HEALTH_KINDS.has(health)) return null;
    return { kind: "console_health", scope, health: health as ConsoleHealthKind };
  }
  return null;
}

/** How the census reads bytes, injected so a fixture needs no temp directory. */
export interface CensusDeps {
  /** Directory entries, or `null` when the directory is absent. */
  readonly list: (dir: string) => Promise<readonly string[] | null>;
  /** File bytes, or `null` when the file is absent. */
  readonly read: (path: string) => Promise<string | null>;
}

export const DEFAULT_CENSUS_DEPS: CensusDeps = {
  list: async (dir) => {
    try {
      return await readdir(dir);
    } catch {
      // An absent root is the ordinary state before the first incident, and it
      // is not a refusal: `--status` on a console that has never fired anything
      // must report an empty table rather than an error.
      return null;
    }
  },
  read: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  },
};

/**
 * Walk §7.6's record root and count what is there.
 *
 * **Two levels deep and no deeper, by construction rather than by a depth
 * counter.** `incidentRecordPath` produces exactly two shapes and this reads
 * exactly those two; a directory that matches neither is reported as a refusal
 * rather than descended into, so a stray tree under the records root cannot turn
 * a status call into an unbounded walk of the operator's home directory.
 */
export async function incidentCensus(
  env: Record<string, string | undefined> = process.env,
  deps: CensusDeps = DEFAULT_CENSUS_DEPS,
): Promise<IncidentCensus> {
  const root = incidentRecordRoot(env);
  const by_state = emptyByState();
  const refused: CensusRefusal[] = [];
  let undelivered = 0;
  let records = 0;

  const scopes = await deps.list(root);
  if (scopes === null) return { by_state, records, undelivered, refused };

  for (const scope of [...scopes].sort()) {
    const scopeDir = join(root, scope);
    const entries = await deps.list(scopeDir);
    if (entries === null) continue;
    for (const entry of [...entries].sort()) {
      // `_console` is the one nested layout; everything else at this level is a
      // service record, and anything that is neither is reported rather than
      // walked.
      const rests: readonly string[][] =
        entry === CONSOLE_SCOPE
          ? ((await deps.list(join(scopeDir, entry))) ?? []).slice().sort().map((n) => [entry, n])
          : [[entry]];
      for (const rest of rests) {
        const path = join(scopeDir, ...rest);
        const subject = subjectForPath(scope, rest);
        if (subject === null) {
          refused.push({
            path,
            reason:
              `${path} is not a §7.6 \`<env>/<service>.json\` or a §6.8a ` +
              `\`<scope>/_console/<kind>.json\` record, so no subject could be expected of ` +
              `it and it is counted in no state.`,
          });
          continue;
        }
        const text = await deps.read(path);
        if (text === null) continue;
        const read = parseIncidentRecord(text, subject, path);
        if (read.kind !== "ok") {
          refused.push({ path, reason: read.reason });
          continue;
        }
        records += 1;
        by_state[read.record.state] += 1;
        undelivered += read.record.undelivered.length;
      }
    }
  }

  return { by_state, records, undelivered, refused };
}

// ---------------------------------------------------------------------------
// §12's three fields
// ---------------------------------------------------------------------------

export const TRIAGE_STATUS_SCHEMA = "pifleet.triagestatus/v1";

/**
 * What `--status` prints, and **there is deliberately no field here that
 * summarises any other field.**
 *
 * §12: *"Anti: `--status` cannot be read as an all-clear. Probe: assert sweeps
 * completed, incidents by state, and the undelivered count are three distinct
 * fields. A single 'OK' line is how 'quiet' and 'could not speak' become one
 * row."* `ReporterStatus` makes the same refusal for the channel (ISC-709) and its
 * `Object.keys` are asserted by full sorted value there for the same reason they
 * are asserted here: a field cannot be added or removed silently.
 */
export interface TriageStatus {
  readonly schema: typeof TRIAGE_STATUS_SCHEMA;
  /**
   * Whether §7.7's record was there at all, and its verdict when it was not
   * readable — three states, because `absent` and `refused` are different things
   * for an operator to go and do.
   */
  readonly actor: "present" | "absent" | "refused";
  /** Why, when `actor` is `refused`. `null` otherwise. */
  readonly actor_reason: string | null;
  /** The pid §7.7 names, for an operator who wants to `ps` it. `null` with no record. */
  readonly pid: number | null;
  /** The cadence the actor is RUNNING at, which §7.7 notes is not always the file's. */
  readonly cadence_s: number | null;
  /**
   * §12's FIRST field. `null` is *"no actor record"* and is not `0`.
   *
   * A console that has never started and a console that started and has not yet
   * completed a sweep are different conditions, and defaulting the absence to `0`
   * would make the first wear the second's costume — the absence-as-evidence
   * mistake §6.8 spends its longest paragraph refusing.
   */
  readonly sweeps_completed: number | null;
  /** §6.4's skip counter, notified at `max_consecutive_skips`. Not a sweep count. */
  readonly consecutive_skips: number | null;
  /** §12's SECOND field. Every state named, whether or not it holds a record. */
  readonly incidents: Readonly<Record<IncidentState, number>>;
  /** §12's THIRD field. §7.6's `undelivered[]` summed across the record set. */
  readonly undelivered: number;
  /** Records the census declined to count. Never folded into `incidents`. */
  readonly refused: readonly CensusRefusal[];
  /** §7.7's log, so an operator is told where the reasons are. */
  readonly log_path: string;
}

/**
 * Assemble §12's three fields from the two durable sources.
 *
 * **The undelivered count comes from the RECORD SET and not from a
 * `DeliveryState`**, and that is forced rather than chosen. §6.9 decides that
 * `DeliveryState` *"has no on-disk contract … it stays in memory"*, so a
 * `--status` typed into a second terminal has no access to the running actor's
 * backoff at all. What survives is §7.6's `undelivered[]` — §6.9's own sentence:
 * *"retained in the record, visible in `pifleet triage --status`, and never
 * replayed"* — which is exactly what the census sums.
 *
 * That also means `--status` and `reporterStatus` answer two different questions
 * about the same channel: this one answers *"what was lost"*, durably; ISC-709's
 * answers *"what is the channel doing right now"*, in the actor's own memory.
 * Merging them would require persisting the countdown §6.9 refuses to persist.
 */
export async function triageStatus(
  env: Record<string, string | undefined> = process.env,
  deps: CensusDeps = DEFAULT_CENSUS_DEPS,
  readRecord: (
    e: Record<string, string | undefined>,
  ) => Promise<TriageActorRecordRead> = readTriageActorRecord,
): Promise<TriageStatus> {
  const record = await readRecord(env);
  const census = await incidentCensus(env, deps);
  const common = {
    schema: TRIAGE_STATUS_SCHEMA,
    incidents: census.by_state,
    undelivered: census.undelivered,
    refused: census.refused,
    log_path: triageActorLogPath(env),
  } as const;

  if (record.kind === "ok") {
    return {
      ...common,
      actor: "present",
      actor_reason: null,
      pid: record.record.pid,
      cadence_s: record.record.cadence_s,
      sweeps_completed: record.record.sweep_cursor,
      consecutive_skips: record.record.consecutive_skips,
    };
  }
  return {
    ...common,
    actor: record.kind === "absent" ? "absent" : "refused",
    actor_reason: record.kind === "refused" ? record.reason : null,
    pid: null,
    cadence_s: null,
    sweeps_completed: null,
    consecutive_skips: null,
  };
}

/**
 * §12's three fields as three LINES, for the operator who is reading rather than
 * parsing.
 *
 * Exported for the unit suite on `renderOutcome`'s precedent one file over —
 * *"pure classification, exported so the unit suite can pin the boundary"*. The
 * boundary worth pinning is the same negative the type pins: no line here
 * combines two of the three numbers, and none of them says "ok".
 */
export function renderStatus(status: TriageStatus): string {
  const lines: string[] = [];
  const sweeps =
    status.sweeps_completed === null
      ? "sweeps completed: unknown (no actor record — the console has never started)"
      : `sweeps completed: ${status.sweeps_completed}`;
  lines.push(`actor: ${status.actor}${status.pid === null ? "" : ` (pid ${status.pid})`}`);
  if (status.actor_reason !== null) lines.push(`actor record refused: ${status.actor_reason}`);
  lines.push(sweeps);
  if (status.consecutive_skips !== null) {
    lines.push(`consecutive skips: ${status.consecutive_skips}`);
  }
  lines.push(
    `incidents by state: ${INCIDENT_STATES.map((s) => `${s}=${status.incidents[s]}`).join(" ")}`,
  );
  lines.push(`undelivered notifications: ${status.undelivered}`);
  for (const r of status.refused) lines.push(`unreadable record: ${r.reason}`);
  lines.push(`log: ${status.log_path}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The run-tree half of §6.4's driver
// ---------------------------------------------------------------------------

/**
 * The four {@link SweepDriver} members this module does not derive from the run
 * tree — **and as of task 6.1a they have a producer.**
 *
 * §7.2's sweep envelope, §7.4's `observer-ops.json` reader, SRD-OBSERVER-001
 * §9.3's `blocked` extractor and a path-reading wrapper around
 * `parseTriageDocument` (which takes text only, deliberately) existed nowhere in
 * `src/` when task 6.2 walked every export of `triage-targets.ts`,
 * `triage-document.ts` and `triage-verdict.ts`. They now live in
 * `run/triage-envelope.ts`, and {@link sweepProducers} assembles all four.
 *
 * **An ALIAS of {@link SweepProducers} rather than a second interface with the
 * same four members.** Two structurally identical types in two files are one
 * type that nothing keeps identical: the day `SweepDriver` grows a member, a
 * separate spelling here would still compile against a producer that had not
 * grown it, and the failure would be a member silently supplied by neither. The
 * alias makes that a `tsc` error at the assignment below.
 *
 * §7.2's security contract is the reason the envelope is not improvised in this
 * file — no credential, no absolute host path, no raw command, and above all
 * *"the contents of a previous worker's report as instruction"*, which §12.6
 * makes a criterion — and an envelope written in a CLI command is an envelope
 * with no test of its own. §12's mirror anti-criterion for `scripts/triage`
 * states the same layering rule one level down: a decision belongs in an `src/`
 * export something can pin, not in the layer that types the verb.
 *
 * **What still has no producer is the one EFFECT the four are built over**, and
 * it is the read-only block that stops it living here. §12 permits this console
 * exactly ONE mutating exception — `run/dispatch-request.ts` — and the
 * 2026-09-06 RULING says *"a second entry would be the tell that this ruling was
 * quietly reversed"*. The production dispatch is `sendTaskEnvelope`, which sits
 * in `cli/commands/dispatch.ts` and takes a `LedgerWriter`; both are banned from
 * this console's subtree by name in `test/unit/triage-readonly.test.ts`, and this
 * file is in that subtree. So `SweepDispatch` stays injected, this module's
 * import closure still reaches no mutating verb and no ledger writer, and who
 * constructs the production effect is recorded against §13 rather than answered
 * by widening the allowlist. See {@link SWEEP_NOT_WIRED}.
 */
export type SweepBriefing = SweepProducers;

/**
 * §6.6 layer 2's counter, re-derived from the run tree.
 *
 * The inbox is the HOST's own directory — `relay.ts` spends a section on why the
 * outbox is the wrong source, *"the directory the WORKER owns … enumerating
 * attacker-chosen names and then building host paths out of them"* — so the set
 * of task ids that could carry a sweep is exactly the set the host dispatched.
 *
 * `sweepNumber` is anchored, so `T-sweep-7-slice2` and `T-sweep-7-collate` answer
 * `null` and only the parent id counts. An empty or absent inbox is `0`, which is
 * the ordinary state of a console that has never swept and is not an error.
 */
export async function highestSweepNumber(run: RunPaths): Promise<number> {
  let names: string[];
  try {
    names = await readdir(run.inboxDir);
  } catch {
    return 0;
  }
  let highest = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const n = sweepNumber(name.slice(0, -".json".length));
    if (n !== null && n > highest) highest = n;
  }
  return highest;
}

/**
 * §6.4's D12 read — *"a sweep whose parent task exists and whose `-collate` task
 * has not settled is in flight"*, with the one case that sentence gets wrong.
 *
 * ## THE ZERO-ROW SWEEP WEDGES THE LITERAL PREDICATE, AND IT IS HANDLED HERE
 *
 * §6.5's zero-row is a sweep in which no child succeeded, **so no collation is
 * dispatched at all** — that is what `sweep_produced_nothing` is for. Applied to
 * such a sweep, *"the `-collate` task has not settled"* is true, is true for the
 * same reason forever, and can never become false. So an actor reading §6.4's
 * sentence literally skips every subsequent tick, counts consecutive skips up to
 * `max_consecutive_skips`, notifies once that it has stopped triaging, and then
 * never sweeps again — silently, because a skip is not an error.
 *
 * The discrimination is the PARENT's own record. A collation task that was never
 * dispatched means one of two things and they are distinguishable: the parent has
 * not settled, so the collator is still working and the sweep really is in
 * flight; or the parent HAS settled without a collation, which is the zero-row,
 * and the sweep is over. Only the first is in flight.
 *
 * Recorded as a defect against §6.4 rather than resolved quietly — see the
 * round's report — because the sentence is quoted in §12's skip criterion too.
 */
export async function inFlightSweep(run: RunPaths): Promise<InFlightSweep | null> {
  const n = await highestSweepNumber(run);
  if (n === 0) return null;
  const parent = sweepTaskId(n);
  if (!existsSync(inboxTaskPath(run, parent))) return null;

  const collator = workerPaths(run, TRIAGE_COLLATOR);
  const collate = collationTaskId(parent);
  if (!existsSync(inboxTaskPath(run, collate))) {
    const parentRecord = await readTaskRecord(taskRecordPath(collator, parent));
    return parentRecord === null ? { sweepId: parent, waitingOn: parent } : null;
  }
  const settled = await readTaskRecord(taskRecordPath(collator, collate));
  return settled === null ? { sweepId: parent, waitingOn: collate } : null;
}

/**
 * §6.6 layer 4's per-seat pins, re-derived every pass because recycling moves
 * them.
 *
 * The NEWEST run that materialised each seat, which is `resolveCollatorRun`'s
 * rule generalised from one seat to four: recency alone is the wrong predicate
 * here for the reason that function records — under D4 a console is four runs and
 * the newest is not the collator's — so each seat is resolved against its own
 * directory rather than all four being assumed to share one run.
 *
 * A seat that resolves to nothing is ABSENT from the map rather than present with
 * an empty string, which is what `TriageActorCursor.runs`' own docblock asks for:
 * *"A seat absent from it has no resolved pin."*
 */
export async function resolveSeatRuns(
  seats: readonly string[] = [
    ...TRIAGE_CONSOLE_ROSTER.collators,
    ...TRIAGE_CONSOLE_ROSTER.reviewers,
  ],
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  const root = runsRoot(env);
  const ids = (await runIdsAscending(root)).reverse();
  const out: Record<string, string> = {};
  for (const id of ids) {
    const run = runPaths(id, root);
    for (const seat of seats) {
      if (out[seat] === undefined && existsSync(workerPaths(run, seat).dir)) out[seat] = id;
    }
  }
  return out;
}

/**
 * §6.3 step 4's read, projected by `partitionFromRequests`.
 *
 * The roster is `TRIAGE_CONSOLE_ROSTER` and passing it is not optional in
 * practice: `resolveRoster` defaults to the REVIEW console's, whose `services`
 * rule is `"refused"` — so a triage request carrying the `services[]` this whole
 * partition depends on would be refused as a field the console does not allow,
 * and the symptom would be a sweep that dispatched nobody.
 */
export async function readSweepPartition(
  run: RunPaths,
  sweepId: string,
): Promise<ReturnType<typeof partitionFromRequests>> {
  const read = await readDispatchRequest({
    runRoot: run.root,
    sender: TRIAGE_COLLATOR,
    taskId: sweepId,
    roster: TRIAGE_CONSOLE_ROSTER,
  });
  // A missing or refused request is an EMPTY partition rather than a throw:
  // `checkTriagePartition` inside the pass then answers `partition_incomplete`
  // naming every declared service, which is §6.5's *"refused whole"* with the
  // reason an operator can act on. A throw here would reach the loop's catch and
  // be reported as a fault instead, losing the distinction §6.8a draws between a
  // console that malfunctioned and a worker that answered badly.
  return read.kind === "ok" ? partitionFromRequests(read.request.requests) : [];
}

/** The run-tree half, plus the four members {@link SweepBriefing} supplies. */
export function buildSweepDriver(
  run: RunPaths,
  briefing: SweepBriefing,
  env: Record<string, string | undefined> = process.env,
): SweepDriver {
  return {
    inFlight: () => inFlightSweep(run),
    highestSweepNumber: () => highestSweepNumber(run),
    runs: () => resolveSeatRuns(undefined, env),
    readPartition: (sweepId) => readSweepPartition(run, sweepId),
    openSweep: briefing.openSweep,
    dispatchObserver: briefing.dispatchObserver,
    join: briefing.join,
    collate: briefing.collate,
  };
}

/**
 * All nine members, from one dep set — the composition point a production
 * `--once` needs and the ONE argument it is still missing.
 *
 * **The run is taken from `producers.run` rather than as a second parameter**,
 * and that is §6.4's own argument at a smaller scale. Two values that must agree
 * about a run id is *"a new failure mode with no observable"*: a caller handed
 * both could pin the run-tree half to one run and the producers to another, and
 * the symptom would be a sweep that dispatches into a run nothing joins from.
 * One run, one source, no way to spell the disagreement.
 */
export function buildTriageSweepDriver(
  producers: SweepProducerDeps,
  env: Record<string, string | undefined> = process.env,
): SweepDriver {
  return buildSweepDriver(producers.run, sweepProducers(producers), env);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * How `pifleet triage` reaches everything that is not itself.
 *
 * A THUNK is registered rather than a value, so importing this module builds no
 * driver, opens no socket and reads no file — `cli/index.ts` loads every command
 * module under one `Promise.all`, and a command whose registration touched the
 * fleet would make `pifleet --help` do so too.
 */
export interface TriageCommandDeps {
  /**
   * ONE pass. `--once` calls this exactly once and **does not catch what it
   * throws**; the loop below catches. See the header.
   */
  readonly pass: () => Promise<TriagePassOutcome>;
  /**
   * The loop. `runTriageActor` in production, which is where the
   * catch-and-continue lives (`relay.ts:700-723`, measured).
   */
  readonly loop: (
    pass: () => Promise<TriagePassOutcome>,
    opts: { readonly cadenceS: number; readonly signal?: AbortSignal },
  ) => Promise<TriageActorExit>;
  readonly status: () => Promise<TriageStatus>;
}

/**
 * The sentence a `--once` or `--poll` gets, NARROWED by task 6.1a from four
 * missing producers to one missing effect.
 *
 * Named producers and named SRD sections, because the operator reading it is the
 * person who has to decide whether the console is broken or unfinished, and those
 * are different things to go and do. The narrowing matters for the same reason:
 * *"four members have no producer"* sent a reader to Phase 5, and the one thing
 * actually missing is a wiring decision §12's read-only ruling constrains.
 */
export const SWEEP_NOT_WIRED =
  "pifleet triage cannot sweep yet, and exactly one thing is missing. SRD-TRIAGE-CONSOLE §7.2's " +
  "sweep-envelope renderer, §7.4's observer-ops.json reader, SRD-OBSERVER-001 §9.3's blocked " +
  "extractor and the path-reading wrapper around parseTriageDocument now all live in " +
  "src/run/triage-envelope.ts, and sweepProducers assembles all four of SweepDriver's remaining " +
  "members out of them (task 6.1a). What has no producer is the single EFFECT those four are " +
  "built over: the per-observer dispatch. sendTaskEnvelope lives in cli/commands/dispatch.ts and " +
  "takes a ledger writer, and §12's read-only block bans both from this console's own subtree with " +
  "exactly ONE permitted exception, run/dispatch-request.ts, which the 2026-09-06 ruling says must " +
  "not gain a second entry. So the effect has to be constructed outside src/run/triage-* and " +
  "outside this file, and §13 assigns that to no task. --status is fully wired and reads the actor " +
  "record and the incident record set. Refusing rather than sweeping nothing and reporting " +
  "success: a console that dispatched nothing must not be indistinguishable from one with nothing " +
  "to dispatch (§6.4).";

/**
 * The loop, wired to {@link runTriageActor} exactly as production wires it.
 *
 * Exported and separate from {@link productionTriageDeps} so the wiring can be
 * driven with an injected `sleep` and an `AbortSignal` — `runTriageActor` checks
 * `isStopped` immediately after `sleep`, which is what lets a test exercise the
 * shipped loop and still terminate. A loop only reachable through the production
 * thunk could be tested only by starting it and killing it, which is
 * `relay.ts:82-88`'s named anti-pattern: *"a test that measures its own timeout"*.
 */
export function productionLoop(
  deps: Omit<Parameters<typeof runTriageActor>[0], "pass">,
): TriageCommandDeps["loop"] {
  return async (pass, opts) =>
    await runTriageActor(
      { ...deps, pass: async () => (await pass()).cursor },
      { cadenceS: opts.cadenceS, runId: "", ...(opts.signal ? { signal: opts.signal } : {}) },
    );
}

/**
 * The production deps. Lazy in every member, so `--status` works with no fleet.
 *
 * **`--poll` refuses UP FRONT rather than entering a loop around a pass that
 * cannot work**, and that is the whole of §6.4's supervision argument applied to
 * this half-built state. The loop catches a thrown pass and continues — by
 * design, `relay.ts:700-723` — so a production `--poll` wired to a refusing pass
 * would log the same refusal every five minutes, for days, in a file nobody
 * reads, while the actor record said an actor was armed. That is exactly *"a
 * console that dispatched nothing is indistinguishable from one with nothing to
 * dispatch"*, manufactured by the resilience mechanism rather than prevented by
 * it. One refusal an operator reads beats 288 a day nobody does.
 */
export function productionTriageDeps(): TriageCommandDeps {
  const refuse = async (): Promise<never> => {
    throw new CliError(SWEEP_NOT_WIRED, EXIT.USAGE);
  };
  return {
    pass: refuse,
    loop: refuse,
    status: async () => await triageStatus(),
  };
}

interface TriageCommandOptions {
  once?: boolean;
  poll?: string;
  status?: boolean;
  json?: boolean;
}

/**
 * §7.8 keeps the cadence in `triage/console.yaml`; `--poll` is *"an override for a
 * hand-run"* and this is only its fallback when the file has not been read.
 */
const DEFAULT_POLL_S = 300;

export function register(
  program: Command,
  deps: () => TriageCommandDeps = productionTriageDeps,
): void {
  program
    .command("triage")
    .description(
      "The triage console's ACTOR (SRD-TRIAGE-CONSOLE §6.4): its clock and its fan-out performer " +
        "(--once does a single sweep and exits; --status reports sweeps, incidents and undelivered)",
    )
    .option("--once", "make a single pass and exit, rather than polling")
    .option("--poll <seconds>", `seconds between sweeps (default: ${DEFAULT_POLL_S})`)
    .option("--status", "report sweeps completed, incidents by state, and the undelivered count")
    .option("--json", "emit machine-readable output")
    .action(async (opts: TriageCommandOptions) => {
      const d = deps();

      if (opts.status === true) {
        const status = await d.status();
        process.stdout.write(
          opts.json === true ? `${JSON.stringify(status)}\n` : `${renderStatus(status)}\n`,
        );
        return;
      }

      const pollS = opts.poll === undefined ? DEFAULT_POLL_S : Number(opts.poll);
      if (!Number.isFinite(pollS) || pollS <= 0) {
        throw new CliError(
          `--poll must be a positive number of seconds, not ${JSON.stringify(opts.poll)}`,
          EXIT.USAGE,
        );
      }

      if (opts.once === true) {
        /*
         * NO `try` HERE, AND THAT IS THE DECISION.
         *
         * §6.4: *"`--once` deliberately does not get the catch, because a single
         * pass is somebody's command and its exit code should mean something."*
         * `cli/index.ts` catches at `main` and turns the throw into a ladder
         * code, which is exactly the behaviour wanted — swallowing it here would
         * make the exit code lie about a sweep that did not happen.
         *
         * A later edit that "hardens" this by wrapping it is the failure this
         * comment exists to make visible, and `triage-command.test.ts` drives a
         * throwing pass through both entry points in one test so that edit is
         * red rather than merely regrettable.
         */
        const outcome = await d.pass();
        process.stdout.write(
          opts.json === true
            ? `${JSON.stringify({ schema: "pifleet.triagepass/v1", ...outcome })}\n`
            : `${renderPassOutcome(outcome)}\n`,
        );
        return;
      }

      const exit = await d.loop(d.pass, { cadenceS: pollS });
      if (exit.kind === "console_gone") {
        // stderr, not stdout: `--json` consumers parse stdout line by line and a
        // diagnostic in that stream is a parse error at the caller.
        process.stderr.write(`pifleet triage: ${exit.reason}\n`);
      }
    });
}

/**
 * One line for the operator who ran a single sweep by hand.
 *
 * Exported on `renderOutcome`'s precedent one file over. The boundary worth
 * pinning is that a `skipped` pass NAMES what it is waiting on — §12 asks the skip
 * to *"name the in-flight sweep"*, and a renderer that dropped it would leave an
 * operator with a console that says it did nothing and will not say why.
 */
export function renderPassOutcome(outcome: TriagePassOutcome): string {
  const id = outcome.sweepId ?? "(no sweep)";
  switch (outcome.kind) {
    case "skipped":
      return `${id}: skipped — a sweep is still in flight, waiting on ${outcome.waitingOn ?? "(unnamed)"}`;
    case "budget_exhausted":
      return `${id}: budget exhausted — admission refused on the run's ceiling (§6.10 exit 5)`;
    case "partition_refused":
      return `${id}: partition refused — ${outcome.partition?.reason ?? "no reason given"}`;
    default:
      return `${id}: swept ${outcome.dispatched.length} observers, ${outcome.notifications.length} notifications composed`;
  }
}
