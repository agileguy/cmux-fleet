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
 * So this file writes the actor's own log and never the fleet ledger, and it must
 * not import `cli/commands/relay.ts`, which holds a writer for it.
 *
 * **This module utters neither banned spelling anywhere — comments included** —
 * so §13 task 6.1b's anti-criterion can be checked against the raw bytes rather
 * than against the guard's own comment-stripped view. The point is not that the
 * guard would fail on prose (it strips comments first, deliberately); it is that
 * a docblock naming the capability is how the next reader learns that reaching
 * for it here is normal. The one privileged effect this console needs arrives
 * through {@link TriageProductionEffects}, built by `src/cli/index.ts`.
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
import { readBudgetState, readTaskRecord } from "../../run/state.ts";
import { processStartTime } from "../../run/registry.ts";
import { collationTaskId, sweepNumber, sweepTaskId } from "../../run/task-ids.ts";
import {
  TRIAGE_CONSOLE_ROSTER,
  readDispatchRequest,
} from "../../run/dispatch-request.ts";
import { partitionFromRequests } from "../../run/triage-partition.ts";
import {
  readTriageDocumentAt,
  sweepProducers,
  triageDocumentPath,
  type SweepDispatch,
  type SweepProducerDeps,
  type SweepProducers,
} from "../../run/triage-envelope.ts";
import { loadTriagePair, sweepDeadlineS } from "../../run/triage-config.ts";
import type { TriageEnvironment, TriageFileNames } from "../../run/triage-targets.ts";
import type { InferenceEndpoint, SaturationProbe, TriageDocument } from "../../run/triage-verdict.ts";
import {
  freshDeliveryState,
  type DeliveryState,
  type NotifyTransport,
} from "../../run/triage-notify.ts";
import {
  freshSaturationMemo,
  triagePass,
  type InFlightSweep,
  type IncidentStore,
  type ResumableSweep,
  type SaturationMemo,
  type SweepDriver,
  type TriagePassOutcome,
} from "../../run/triage-pass.ts";
import {
  DEFAULT_CENSUS_DEPS,
  INCIDENT_STATES,
  incidentCensus,
  loadIncidentRecord,
  saveIncidentRecord,
  type CensusDeps,
  type CensusRefusal,
  type IncidentState,
} from "../../run/triage-incident.ts";
import {
  TRIAGE_COLLATOR,
  acquireTriageActorLock,
  appendActorLog,
  readTriageActorRecord,
  runTriageActor,
  triageActorLockPath,
  triageActorLogPath,
  triageActorRecord,
  triageActorRecordPath,
  writeTriageActorRecord,
  type TriageActorCursor,
  type TriageActorEvent,
  type TriageActorExit,
  type TriageActorIdentity,
  type TriageActorRecordRead,
  type TriageConsolePorts,
} from "../../run/triage-actor.ts";

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
 * **The one EFFECT the four are built over is INJECTED, and task 6.1b settled
 * where it comes from.** §12 permits this console exactly ONE mutating exception
 * — `run/dispatch-request.ts`, the request BUILDER — and the 2026-09-06 RULING
 * says *"a second entry would be the tell that this ruling was quietly
 * reversed"*. The production per-observer dispatch is a privileged EFFECT: it
 * lives in a command module this console's subtree may not import and takes a
 * fleet-ledger writer this console's subtree may not name, both banned by
 * `test/unit/triage-readonly.test.ts`, and **this file is in that subtree** — a
 * dynamic `await import` included, because the ban is a substring check over
 * comment-stripped source.
 *
 * So it is built at the COMPOSITION ROOT, where `src/cli/index.ts` already
 * assembles every command, and handed in through
 * {@link TriageProductionEffects.dispatchFor} as a plain function. The console's
 * own modules stay read-only **by construction** rather than by a second
 * allowlist entry: ISC-826's one-entry list is untouched, which is the point.
 * **This file names neither of the two banned spellings AT ALL — comments
 * included** — so the anti-criterion can be checked against the raw bytes rather
 * than against the guard's own comment-stripped view.
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
 * §13 task 6.4a's missing read — *does `T-sweep-<n>-collate` exist* — beside the
 * one that could not answer it. ISC-868.
 *
 * ## The two sweeps that look identical to {@link inFlightSweep}, and this is one of them
 *
 * §6.4's corrected predicate collapses *"parent settled, no collation"* into
 * `null` so a §6.5 zero-row cannot wedge the actor (ISC-805), and that same
 * `null` is what an ABANDONED sweep reads — an actor that died between the join
 * and the collation dispatch. Both have a settled parent and no `-collate` task,
 * and no amount of looking at the in-flight port separates them, because
 * separating them is not what that port is for.
 *
 * This function narrows the run tree to exactly those two and stops there. The
 * fact that tells them apart — whether any observer produced an artifact — is
 * `SweepDriver.join`'s, and the pass asks it, so this module does not grow a
 * second artifact reader beside `triage-envelope.ts`'s.
 *
 * ## Three refusals, and each one is a hazard rather than tidiness
 *
 *  - **A `-collate` task that EXISTS.** Then the collation was dispatched and
 *    {@link inFlightSweep} owns the sweep: either the collator still owes it, or
 *    it settled and the sweep is over. Resuming here would race `tri-1` to write
 *    the same document.
 *  - **A parent that has NOT settled.** The worker owes the sweep, and neither
 *    the join nor the collation is a step the host may take.
 *  - **An envelope whose `dispatched_at` cannot be read.** §7.4's echo is
 *    computed against that instant, so a resumed sweep dated from `now` would
 *    report every observer that answered correctly as `stale_window`. A sweep
 *    that cannot be dated is not resumed, and the cost of that refusal is the one
 *    wasted cadence the whole task is arguing about — which is the cheap side.
 */
export async function resumableSweep(run: RunPaths): Promise<ResumableSweep | null> {
  const n = await highestSweepNumber(run);
  if (n === 0) return null;
  const parent = sweepTaskId(n);
  const envelope = inboxTaskPath(run, parent);
  if (!existsSync(envelope)) return null;
  if (existsSync(inboxTaskPath(run, collationTaskId(parent)))) return null;

  const collator = workerPaths(run, TRIAGE_COLLATOR);
  if ((await readTaskRecord(taskRecordPath(collator, parent))) === null) return null;

  const dispatchedAt = await dispatchedAtOf(envelope);
  return dispatchedAt === null ? null : { sweepId: parent, dispatchedAt };
}

/**
 * The `dispatched_at` the HOST wrote into its own inbox envelope, or `null`.
 *
 * The envelope is `pifleet.task/v1` and the field is filled by the dispatcher
 * rather than by an author, so it is the one durable record of when this sweep's
 * observation window opened. It is read as an unvalidated shape on
 * `relay.ts:421`'s pattern — the file is in the HOST's own directory but it is
 * still a file, and a truncated or hand-edited one must answer *"cannot be
 * dated"* rather than throw a pass that would otherwise have swept.
 *
 * `Date.parse` gates it because a non-timestamp string would reach `windowEcho`,
 * which throws on a bound that is not a number — turning a resumable sweep into
 * a thrown pass, which is the loudest possible version of the wrong answer.
 */
async function dispatchedAtOf(path: string): Promise<string | null> {
  try {
    const envelope = JSON.parse(await Bun.file(path).text()) as { dispatched_at?: unknown };
    const at = envelope.dispatched_at;
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
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
    resumableSweep: () => resumableSweep(run),
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

// ---------------------------------------------------------------------------
// §13 task 6.1b — what the COMPOSITION ROOT supplies, and why each member is there
// ---------------------------------------------------------------------------

/**
 * The things `pifleet triage` cannot build for itself, supplied by
 * `src/cli/index.ts`.
 *
 * ## The membership rule, so an eleventh member has to justify itself
 *
 * A member belongs here when building it inside this console's subtree is
 * either FORBIDDEN or LIVE, and nowhere else:
 *
 *   - **Forbidden.** {@link dispatchFor}, {@link isCollatorLive},
 *     {@link downRun} and {@link upSeat} are reached only through modules
 *     `test/unit/triage-readonly.test.ts` bans from this subtree by name. That
 *     ban is the design working (§12's read-only block), so the capability
 *     arrives by INJECTION and the one-entry permitted-exception list (ISC-826)
 *     is untouched.
 *   - **Live.** {@link probe} and {@link transport} each perform a real POST —
 *     §6.7 rule 3's saturation probe against the operator's own inference
 *     server, and §6.9's webhook. `saturationVerdict` already refuses to give
 *     the probe a default for exactly this reason (*"a default would leave every
 *     fixture in the suite one omitted argument away from a real POST … 288
 *     times a day in CI"*), and this record inherits the posture rather than
 *     re-arguing it.
 *   - **The fleet config's answers.** {@link triageFiles}, {@link kubeconfigPath}
 *     and {@link endpoint} all come from `fleet.yaml`, which is loaded ONCE at
 *     the root. Re-loading it here would be a second reading of `loaded.dir` —
 *     the drift `config/load.ts` states its standing rule against: *"a config
 *     that renders differently depending on where the command was typed is not a
 *     config."*
 *
 * Everything that is merely a READ of the run tree, the two tracked triage files
 * or `~/.pifleet` is deliberately NOT here: that is the console's own job, it is
 * what the read-only block permits, and moving it to the root would make the
 * root the second place those paths are decided.
 */
export interface TriageProductionEffects {
  /**
   * §6.3 step 5's per-observer dispatch — **the privileged effect, and the whole
   * subject of §13 task 6.1b.**
   *
   * A FACTORY over the run rather than a bare {@link SweepDispatch}, because
   * §6.4's argument applies to the pair: *"two processes that must agree about a
   * run id is a new failure mode with no observable"*. The console resolves the
   * run (a read it is allowed to make); the root supplies the capability; there
   * is no spelling in which the two disagree.
   *
   * `settleDeadlineMs` travels with it because the BOUND is a decision and the
   * dispatch is a capability. §7.8 computes `sweep_deadline_s` as
   * `cadence_s − reserve_s` and this console is the only thing that knows it; a
   * root that picked its own would be a second home for a tuning value
   * `TriageConsoleConfigSchema` already defines.
   */
  readonly dispatchFor: (
    run: RunPaths,
    opts: { readonly settleDeadlineMs: number },
  ) => SweepDispatch;
  /**
   * §12's exit-when-the-console-is-gone predicate, for `--poll`.
   *
   * Injected for the same structural reason as the dispatch: the production
   * answer is a run-source read that lives in a module the read-only block bans
   * from this subtree by name.
   */
  readonly isCollatorLive: (run: RunPaths) => Promise<boolean>;
  /**
   * §6.6 layer 4's teardown — **and it takes a RUN, not a seat.**
   *
   * The asymmetry with {@link upSeat} is `pifleet`'s and not this console's
   * invention: `down` is a run verb (`--run <id>`) and `up` is a worker verb
   * (`--workers <ids>`). Spelling the root's member as `downSeat(seat)` would
   * have made it resolve the seat's run for itself — a run-tree READ, which the
   * membership rule above puts on the console's side of the line and which
   * {@link resolveSeatRuns} already performs and already has tests. So the
   * console resolves and the root tears down, and there is no second reading of
   * the run tree to disagree with the first.
   *
   * `TriageConsolePorts.downSeat`'s *"must be a no-op on a seat that is already
   * down"* is therefore satisfied structurally: a seat with no pin never reaches
   * this function.
   */
  readonly downRun: (runId: string) => Promise<void>;
  /**
   * §6.6 layer 4's other half — one seat, a NEW run, and no terminal.
   *
   * The run id is deliberately not returned; D12 makes the run tree the
   * authority and `TriageConsolePorts.seatRuns` is how it is read back.
   */
  readonly upSeat: (seat: string) => Promise<void>;
  /** §7.1 and §7.8's two tracked files, resolved against the fleet config's dir. */
  readonly triageFiles: TriageFileNames;
  /** The fleet's `cloud.kubeconfig`, resolved, or `null` when it is unset. */
  readonly kubeconfigPath: string | null;
  /** §6.7 rule 3's announcement subject — the provider and model a seat resolves to. */
  readonly endpoint: InferenceEndpoint;
  /** §6.7 rule 3's confirming probe. See the membership rule: it dials for real. */
  readonly probe: SaturationProbe;
  /** §6.9's delivery. Same reason. */
  readonly transport: NotifyTransport;
  /** `PIFLEET_RUNS_DIR` and `HOME`; every path this console reads hangs off them. */
  readonly env: Record<string, string | undefined>;
}

/**
 * The effects, as a THUNK the command only calls when it is about to sweep.
 *
 * `--status` must work with no fleet, no `fleet.yaml` and no network — it is the
 * surface an operator reads when the sweep half is broken — and the root's
 * builder loads the fleet config and resolves a worker, either of which can
 * throw a `ConfigError` on a machine that has not run task 6.11's config edits.
 * A value here would make `--status` fail for a reason that has nothing to do
 * with it; a thunk makes that structurally impossible.
 */
export type TriageEffectsFor = () => Promise<TriageProductionEffects>;

/**
 * The run the sweep is dispatched INTO, and it is the collator's own.
 *
 * `resolveCollatorRun` in `relay.ts` generalised to this console's roster —
 * recency alone is the wrong predicate (§6.6 layer 4, D4: a console is four runs
 * and the newest is not necessarily the collator's), so the run is the newest one
 * that materialised `tri-1` and nothing else.
 *
 * **A refusal rather than a `null`.** Every one of `SweepDriver`'s nine members
 * is pinned to this run; with no run there is no inbox to count sweeps in, no
 * outbox to join from and nowhere to dispatch. A `null` would have to be handled
 * nine times and would eventually be handled as *"no sweeps yet"*, which is
 * §6.4's own indistinguishability defect.
 */
export const NO_COLLATOR_RUN =
  `pifleet triage found no run holding ${TRIAGE_COLLATOR}, so there is nothing to sweep into. ` +
  `Start the console first (scripts/triage, or pifleet up --workers ` +
  `${[...TRIAGE_CONSOLE_ROSTER.collators, ...TRIAGE_CONSOLE_ROSTER.reviewers].join(",")}), then ` +
  `run this again. --status works without a run and reports the actor record and the incident ` +
  `record set (SRD-TRIAGE-CONSOLE §6.4).`;

export async function resolveCollatorRun(
  env: Record<string, string | undefined> = process.env,
): Promise<RunPaths> {
  const runs = await resolveSeatRuns([TRIAGE_COLLATOR], env);
  const runId = runs[TRIAGE_COLLATOR];
  if (runId === undefined) throw new CliError(NO_COLLATOR_RUN, EXIT.USAGE);
  return runPaths(runId, runsRoot(env));
}

/**
 * §7.1's inventory projected onto the ONE environment a sweep is.
 *
 * `triage-pass.ts` states the limit and this is where it becomes a refusal:
 * *"ONE SWEEP IS ONE ENVIRONMENT, and that is a limit rather than a law …
 * `ConsoleHealthFacts` takes a LIST of environments, which is the seam a
 * multi-environment console would grow into; nothing in Phase 6 asks for it and
 * nothing here forecloses it."*
 *
 * **Refused by NAME on both sides**, because the two failures need different
 * answers: a targets file with no environments is one an operator has not
 * finished writing, and a file with two is one that outgrew a console this
 * design does not build yet. A loader that silently took the first would sweep
 * one environment and report health for a fleet, which is the most damaging
 * shape a message from this console can have.
 */
export function soleEnvironment(environments: Readonly<Record<string, TriageEnvironment>>): {
  readonly name: string;
  readonly environment: TriageEnvironment;
} {
  const names = Object.keys(environments);
  if (names.length !== 1) {
    throw new CliError(
      `triage/targets.yaml declares ${names.length} environments (${
        names.length === 0 ? "none" : names.join(", ")
      }) and one sweep is ONE environment (SRD-TRIAGE-CONSOLE §12). A multi-environment console ` +
        `is a seam this design leaves open and does not build: declare exactly one environment, ` +
        `or run one console per environment.`,
      EXIT.USAGE,
    );
  }
  const name = names[0]!;
  return { name, environment: environments[name]! };
}

/**
 * §6.10 exit 5, read BEFORE every dispatch rather than discovered after one.
 *
 * *"The one hard ceiling that does bind is `run.budget.tokens_ceiling`, which is
 * **per run** … so the console has a hard lifetime measured in tokens, after
 * which `up`'s budget refuses admission and the run ends on exit 5. **Nothing
 * announces that today**, so this design makes it a notification."* This is the
 * producer for that notification: `SweepDispatchOutcome`'s `budget_exhausted` arm
 * has no other source, and `triagePass` turns it into §6.8a's console-health
 * issue.
 *
 * **A pure READ, and deliberately not a reservation.** `BudgetManager.admit`
 * subtracts a hold and writes the file back; that is a scheduler's job and this
 * console is not one. Reading `halted_at` answers the only question a dispatcher
 * needs — *has this run already crossed its ceiling* — and answering it here
 * rather than inside the injected effect keeps the gate a DECISION in `src/`,
 * which is what §12 asks of `scripts/triage` one layer down.
 *
 * **What this does NOT close, stated rather than left to be discovered:**
 * `run.budgetJson` is written by exactly one thing in this repository — the
 * `--auto` scheduler's `onChange` — so on a console run started by `scripts/triage`
 * the file is absent, this gate is permanently false, and §6.10's notification
 * cannot fire. That is a gap in the BUDGET's own wiring rather than in this
 * mapping, it is reported against §6.10, and the mapping is written now so that
 * closing it is a writer and not a second decision about what `halted_at` means.
 */
export function refuseOnExhaustedBudget(run: RunPaths, dispatch: SweepDispatch): SweepDispatch {
  return async (args) => {
    const budget = await readBudgetState(run);
    if (budget !== null && budget.halted_at !== null) {
      return {
        kind: "budget_exhausted",
        reason:
          `${budget.halted_reason ?? "the run's token ceiling was crossed"} ` +
          `(spent ${budget.tokens_spent} of ${budget.tokens_ceiling ?? "unbounded"} tokens in ` +
          `run ${budget.run_id}, halted at ${budget.halted_at})`,
      };
    }
    return await dispatch(args);
  };
}

/**
 * §7.6's records, as {@link IncidentStore}'s two functions.
 *
 * `saveIncidentRecord` resolves to the PATH it wrote and the port returns
 * `void`; the discard is explicit here rather than at nine call sites.
 */
export function productionIncidentStore(
  env: Record<string, string | undefined> = process.env,
): IncidentStore {
  return {
    load: async (subject) => await loadIncidentRecord({ subject, env }),
    save: async (record) => {
      await saveIncidentRecord({ record, env });
    },
  };
}

/**
 * §6.6 layer 3's *"the previous sweep's document"*, fetched lazily and PROJECTED.
 *
 * The highest sweep the run tree holds is the previous one by construction — the
 * pass mints `n+1` after reading it — so this needs no cursor and cannot
 * disagree with one. An absent, unreadable or schema-refused document is `null`,
 * which is the value `renderSweepEnvelope` treats as *"there is no previous
 * state"*; a refusal is NOT escalated, because a worker's malformed document must
 * not stop the next sweep being dispatched.
 *
 * **`projectPreviousState` is what consumes this, never the raw prose**, which is
 * §12.6's anti-criterion — the contents of a previous worker's report must not
 * reach the next sweep's brief as instruction. Nothing here reads a string out of
 * the document; it is handed over whole and the envelope renderer projects it.
 */
export async function previousSweepDocument(run: RunPaths): Promise<TriageDocument | null> {
  const n = await highestSweepNumber(run);
  if (n === 0) return null;
  const collateTaskId = collationTaskId(sweepTaskId(n));
  const path = triageDocumentPath(run, collateTaskId);
  const read = await readTriageDocumentAt(path, { worker: TRIAGE_COLLATOR, path });
  return read.kind === "ok" ? read.document : null;
}

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
 * §7.7's `started` token, captured with **both** of its failure shapes handled.
 *
 * ## ISC-272's writer claim, and why `??` alone is the defect it names
 *
 * `(await processStartTime(process.pid)) ?? ""` reads as a degrade and is not
 * one. Since ISC-192 `processStartTime` **THROWS** an `IdentityReadError` on a
 * read it cannot trust — a `ps` that is not on PATH, one that exits nonzero with
 * a diagnostic, one signal-killed under memory pressure — so `??` never sees the
 * failure, the exception escapes, and the writer dies instead of degrading. It
 * was measured: `supervisor/index.ts` died at startup before writing any state
 * file, and on a host with no procps `pifleet up` could not start a run at all.
 * The form is banned by name in `test/support/isa-claims.ts`, deliberately
 * including its appearance in PROSE, *"because a comment that teaches the broken
 * spelling is how it comes back"*.
 *
 * ## What a failed capture MEANS for this console, which is why it degrades here
 *
 * `""` is the recorded capture-failed sentinel and every reader already knows it:
 * `isPinnedIdentity("")` is false, so `readRelayStatus` answers `unverifiable`
 * rather than `stale`, and nothing adopts or tears down the process this record
 * names. That is fail-closed in the direction that matters and it is the OPPOSITE
 * trade from `up`'s, on purpose. `up` may abort, because a run whose every
 * identity is the sentinel is a run no later `down` can stop. This actor is
 * unattended and sweeps 288 times a day; refusing to start because `ps` is
 * missing would take the console down over a diagnostic tool, and the thing the
 * token protects — telling a live actor from a recycled pid — degrades to
 * *"cannot tell"*, which every consumer already handles.
 *
 * **It is not silent.** The reason goes to §7.7's append-only log — §9.15 surface
 * 2, *"the only surface that is guaranteed to work"* — as `record_write_failed`,
 * which is that event's own subject: the record is about to be written degraded.
 */
async function capturedStartToken(
  pid: number,
  log: (event: TriageActorEvent) => Promise<void>,
): Promise<string> {
  try {
    const token = await processStartTime(pid);
    // `null` is the OTHER shape and means "no such process", which cannot be
    // true of `process.pid` — but it is spelled rather than asserted, because a
    // non-null assertion here would be a crash on a case that costs a sentinel.
    return token ?? "";
  } catch (err) {
    await log({
      kind: "record_write_failed",
      reason:
        `the process start time for pid ${pid} could not be read, so the actor record's ` +
        `identity is the capture-failed sentinel and this console cannot be told from a ` +
        `recycled pid: ${err instanceof Error ? err.message : String(err)}`,
    });
    return "";
  }
}

/**
 * The production deps — **and as of §13 task 6.1b they SWEEP rather than refuse.**
 *
 * ## The parameter is REQUIRED, and that is the structural half of the task
 *
 * There is no `productionTriageDeps()`. The effects §12's read-only block will
 * not let this console build are a compulsory argument, so the compiler — not a
 * reviewer, and not a refusing default — is what guarantees that no path
 * produces a console without its dispatch. A defaulted parameter would put the
 * refusal back one level down and leave the hole exactly where ISC-830 found the
 * last one: in the wiring layer, which §3.3 records as *"the layer the coverage
 * gate keeps catching"*. `saturationVerdict` makes the same move for the same
 * reason and pins it the same way — its arity is asserted in the suite, because
 * *"a default would drop the arity and redden"*.
 *
 * ## Lazy in every member, so `--status` still works with no fleet
 *
 * `effectsFor` is a thunk and nothing calls it until a sweep is actually about
 * to happen. Registering this module therefore still builds no driver, opens no
 * socket and reads no file — the property {@link TriageCommandDeps}' own
 * docblock calls load-bearing, because `cli/index.ts` loads every command module
 * under one `Promise.all` and a command whose registration touched the fleet
 * would make `pifleet --help` do so too.
 *
 * ## The three values carried BETWEEN passes, and why they live in this closure
 *
 * `cursor`, `delivery` and `saturationMemo` are inputs to a pass and outputs of
 * it. §6.9 decides deliberately that `DeliveryState` *"stays in memory"* — a
 * restarted actor retries the channel rather than continuing a countdown it can
 * no longer justify — and the memo is §6.7 rule 3's cross-sweep probe answer,
 * which exists precisely so 288 sweeps a day do not become 288 probes. Holding
 * them here is what makes `--poll` a sequence of passes rather than a sequence
 * of first passes.
 *
 * The cursor is seeded from §7.7's record ONCE and carried thereafter, which is
 * D12's split stated in code: the record is a hint, the run tree is the
 * authority, and `triagePass` re-derives `sweep_cursor` from the run tree on
 * every exit anyway (`resumedCursor`).
 */
export function productionTriageDeps(effectsFor: TriageEffectsFor): TriageCommandDeps {
  let cursor: TriageActorCursor | null = null;
  let delivery: DeliveryState = freshDeliveryState();
  let saturationMemo: SaturationMemo = freshSaturationMemo();

  const seedCursor = async (
    env: Record<string, string | undefined>,
  ): Promise<TriageActorCursor> => {
    if (cursor !== null) return cursor;
    const record = await readTriageActorRecord(env);
    /*
     * An ABSENT or REFUSED record is a fresh cursor rather than a throw, and the
     * two collapse here on purpose. §7.7's record is a hint; a console that has
     * never run has no file, and one whose file was truncated by a crash has a
     * file nothing should act on. Both mean *"this process knows nothing yet"*,
     * and both are safe because `highestSweepNumber` re-derives the counter from
     * the run tree before the pass mints anything (§6.6 layer 2, D12).
     */
    cursor =
      record.kind === "ok"
        ? {
            runs: record.record.runs,
            sweep_cursor: record.record.sweep_cursor,
            consecutive_skips: record.record.consecutive_skips,
          }
        : { runs: {}, sweep_cursor: 0, consecutive_skips: 0 };
    return cursor;
  };

  const pass = async (): Promise<TriagePassOutcome> => {
    const e = await effectsFor();
    const run = await resolveCollatorRun(e.env);
    const pair = await loadTriagePair({
      paths: e.triageFiles,
      kubeconfigPath: e.kubeconfigPath,
    });
    const { name: environment, environment: target } = soleEnvironment(pair.targets.environments);

    const outcome = await triagePass({
      environment,
      /*
       * FILE order, which `TriageEnvironment.services` preserves and
       * `checkTriagePartition` compares against. Sorting here would make
       * `partition_incomplete`'s list disagree with the file an operator is
       * about to open.
       */
      declared: target.services.map((s) => s.name),
      /*
       * §7.4's legal window range, assembled from the two files that fix it —
       * the targets file supplies `default_window` (already seconds) and §7.8
       * supplies `reserve_s`. The two field NAMES differ deliberately and this
       * is the one join site.
       */
      windowPolicy: {
        default_window_s: target.default_window,
        reserve_s: pair.console.reserve_s,
      },
      config: pair.console,
      notify: pair.console.notify,
      endpoint: e.endpoint,
      probe: e.probe,
      transport: e.transport,
      cursor: await seedCursor(e.env),
      delivery,
      saturationMemo,
      sweep: buildTriageSweepDriver(
        {
          run,
          environment,
          services: target.services,
          defaultWindowS: target.default_window,
          previousDocument: () => previousSweepDocument(run),
          /*
           * The injected effect, gated on §6.10's ceiling. The ORDER is the
           * point: the budget read is the console's decision and wraps the
           * root's capability, so a dispatch cannot happen on a halted run no
           * matter what the root handed in.
           */
          dispatch: refuseOnExhaustedBudget(
            run,
            e.dispatchFor(run, { settleDeadlineMs: sweepDeadlineS(pair.console) * 1_000 }),
          ),
        },
        e.env,
      ),
      records: productionIncidentStore(e.env),
      /*
       * Called once per pass by `triagePass` itself, so a pass's timestamps
       * agree with each other. Not memoised here: two passes must not share an
       * instant.
       */
      now: () => Date.now(),
    });

    cursor = outcome.cursor;
    delivery = outcome.delivery;
    saturationMemo = outcome.saturationMemo;
    return outcome;
  };

  return {
    pass,
    /**
     * The loop, assembled the moment `--poll` is typed and not before.
     *
     * `isCollatorLive` is bound to the run resolved HERE rather than re-resolved
     * inside the predicate, which is what makes §12's exit-when-the-console-is-
     * gone criterion mean what it says: the actor watches the seat it is
     * sweeping, so a `tri-1` that comes back in a NEW run is a console that went
     * away — correctly — rather than one that silently followed it.
     */
    loop: async (p, opts) => {
      const e = await effectsFor();
      /**
       * **The run the WATCH observes, and it is a `let` because §6.6 layer 4
       * moves it — but only when this actor moves it itself.**
       *
       * §12's criterion reads *"a `tri-1` that comes back in a NEW run is a
       * console that went away — correctly — rather than one that silently
       * followed it"*, and that sentence was written before the actor could mint
       * a run. Left alone it is now a self-terminating console, and the numbers
       * are not marginal: the first recycle of `tri-1` (four hours in, at
       * §7.8's defaults) replaces the collator's run, `isLiveWorker` reads the
       * OLD run's dead state file, and `RELAY_ABANDON_PASSES` (5) negatives
       * later — twenty-five minutes — the actor exits `console_gone` on a console
       * it had just successfully repaired.
       *
       * So the watch follows exactly one thing: a run **this actor minted**,
       * re-derived inside {@link TriageConsolePorts.upSeat} at the moment the
       * `up` resolves. Every other way `tri-1` can appear in a newer run — an
       * operator's `pifleet down` and `up`, a second console, a stray fleet — is
       * still an abandonment, because nothing else runs this line. §12's
       * distinction survives with its subject narrowed from *"a new run"* to
       * *"a new run somebody else minted"*, which is what it always meant.
       */
      let watched = await resolveCollatorRun(e.env);
      /**
       * §7.8's knobs, read ONCE for the actor's life.
       *
       * `recycle_after_sweeps` joins `cadence_s` in being fixed at start rather
       * than per pass: `TriageConsolePorts.recycleAfterSweeps` is a number and
       * not a reader, deliberately, so that a boundary cannot change its mind
       * about the window halfway through a recycle it has already begun. An
       * operator who edits the file restarts the actor, which is already true of
       * the cadence.
       */
      const pair = await loadTriagePair({
        paths: e.triageFiles,
        kubeconfigPath: e.kubeconfigPath,
      });
      const logPath = triageActorLogPath(e.env);
      const log = async (event: TriageActorEvent): Promise<void> =>
        await appendActorLog(logPath, event);
      const identity: TriageActorIdentity = {
        pid: process.pid,
        // See {@link capturedStartToken}: this read has TWO failure shapes and
        // only one of them is a `null` (ISC-272).
        started: await capturedStartToken(process.pid, log),
        started_at: new Date().toISOString(),
        log_path: logPath,
        pinned: e.env["PIFLEET_RELAY_RUNS"] ?? null,
        cadence_s: opts.cadenceS,
        workers: [
          ...TRIAGE_CONSOLE_ROSTER.collators,
          ...TRIAGE_CONSOLE_ROSTER.reviewers,
        ],
      };
      /**
       * §13 task 6.5b — **the ports, and the split down the middle of them.**
       *
       * Seven of the nine are READS this console is allowed to make and already
       * has functions for; two are the privileged effect §12's read-only block
       * forbids it to hold, and those two arrive from the composition root. The
       * boundary is the same one task 6.1b drew for the dispatch, and drawing it
       * again here is what keeps ISC-826's permitted-exception list at ONE entry.
       *
       * They are assembled here rather than at the root for the reason
       * {@link TriageProductionEffects}' own membership rule gives: a root that
       * built `seatRuns` or `sweepInFlight` would be the second place this
       * console's paths are decided.
       */
      const ports: TriageConsolePorts = {
        acquireLock: async () => await acquireTriageActorLock(e.env),
        lockPath: triageActorLockPath(e.env),
        seats: identity.workers,
        recycleAfterSweeps: pair.console.recycle_after_sweeps,
        sweepInFlight: async () => (await inFlightSweep(watched)) !== null,
        seatRuns: async () => await resolveSeatRuns(identity.workers, e.env),
        downSeat: async (seat) => {
          /*
           * The seat's run, resolved by the SAME function `seatRuns` above uses,
           * so the actor's boundary decision and this teardown cannot be looking
           * at different run trees. A seat with no pin is already down and the
           * port's contract is that this is a no-op — which it is, structurally,
           * because there is nothing to hand `downRun`.
           */
          const runId = (await resolveSeatRuns([seat], e.env))[seat];
          if (runId === undefined) return;
          await e.downRun(runId);
        },
        upSeat: async (seat) => {
          try {
            await e.upSeat(seat);
          } finally {
            /*
             * In a `finally` rather than after the await: an `up` that minted
             * the run and then failed later still moved the collator, and a
             * watch left pointing at the old run would reap this actor for the
             * recycle's own success. The re-derivation cannot throw usefully
             * here — with no run holding `tri-1` at all there is nothing to
             * follow — so the watch stays where it was and the existing
             * five-negative abandonment answers it.
             */
            if (seat === TRIAGE_COLLATOR) {
              try {
                watched = await resolveCollatorRun(e.env);
              } catch {
                /* no run holds the collator: leave the watch, let it abandon */
              }
            }
          }
        },
        /*
         * §7.7's record as the per-seat clock's seed. A separate read from
         * `seedCursor`'s, and deliberately: that one seeds the PASS and drops
         * `recycled_at` (the pass does not own it), this one seeds the ACTOR's
         * boundary and is only about that field. `null` for an absent or
         * unreadable record is the port's own spelling of "nothing to resume" —
         * D12 makes the record a hint, and a hint that is not there is not an
         * error.
         */
        resume: async () => {
          const record = await readTriageActorRecord(e.env);
          if (record.kind !== "ok") return null;
          return {
            runs: record.record.runs,
            sweep_cursor: record.record.sweep_cursor,
            consecutive_skips: record.record.consecutive_skips,
            ...(record.record.recycled_at === undefined
              ? {}
              : { recycled_at: record.record.recycled_at }),
          };
        },
      };
      return await productionLoop({
        isCollatorLive: () => e.isCollatorLive(watched),
        saveCursor: async (next) =>
          await writeTriageActorRecord(
            triageActorRecordPath(e.env),
            triageActorRecord(identity, next),
          ),
        log,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        ports,
      })(p, opts);
    },
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

/**
 * **`deps` is REQUIRED, and that is what keeps the composition root honest**
 * (§13 task 6.1b).
 *
 * It defaulted to `productionTriageDeps` while that function took no arguments.
 * It cannot now: the production deps need effects only `src/cli/index.ts` may
 * build, so a default here would have to be a REFUSING deps object — and a
 * refusing default is a hole that a `register(program)` somewhere quietly falls
 * into, in exactly the layer §3.3 says the coverage gate keeps catching.
 * Required, the omission is a `tsc` error and `main()`'s uniform registration
 * loop cannot register this command at all — which is why `cli/index.ts`
 * registers it by name, one line below that loop.
 */
export function register(program: Command, deps: () => TriageCommandDeps): void {
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
        return;
      }
      /**
       * §6.3b's lock refusal, and **the exit code is a POLICY CALL made here.**
       *
       * `refused` exits NONZERO — `EXIT.BACKEND_UNAVAILABLE`, on `up`'s own
       * stated reading of that code: *"nothing is wrong with the command line,
       * the host is busy"*. The host already has a triage actor; that is a fact
       * about the machine, not a mistake by the caller, and it is the same class
       * as `up`'s MLX-training and egress refusals.
       *
       * **Why not `0`.** A `--poll` that returns success having never polled is
       * indistinguishable, over the only channel a machine caller has, from a
       * `--poll` that ran all day and stopped cleanly — which is this
       * repository's own recorded anti-pattern (*"a stub that dispatched nothing
       * and returned success would be indistinguishable from a working relay"*)
       * and the exact confusion ISC-216 closed one ladder rung over. The cost is
       * real and is stated rather than hidden: a supervisor configured
       * `Restart=on-failure` will retry against a healthy held lock. It retries
       * against a *healthy* console, `acquireRelayLock` takes over a lock left by
       * a DEAD pid, and the alternative is a console that reports it is polling
       * when it is not.
       *
       * **Why not the shared stderr line `console_gone` uses.** `TriageActorExit`
       * carries `reason` under the same name so the two *could* share it, and
       * they would if this exited `0`. They do not, because `main()` writes a
       * `CliError`'s message to stderr itself — so writing the line here as well
       * would print the same sentence twice. One reason, one stream, one code.
       */
      if (exit.kind === "refused") {
        throw new CliError(exit.reason, EXIT.BACKEND_UNAVAILABLE);
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
