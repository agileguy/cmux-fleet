/**
 * RunReport assembly (SRD §10, §14.2): describe a whole run to someone who
 * was not watching it.
 *
 * DERIVED FACTS ONLY. Every field is computed from the ledger, the inbox
 * dispatch records, the harvest, the supervisor's task records and git —
 * never from a worker's self-report. The one place a worker's claim enters is
 * inside `harvestTask`, whose adjudication lattice can lower a derived verdict
 * and never raise it (§8.2, §7.2). Nothing in this module reads an envelope's
 * `status` field, and nothing here may start to: a reporter that trusts the
 * actor it reports on stops being a report.
 *
 * The other rule: `report` is what an operator runs when things went WRONG. A
 * run with no workers, a corrupt state file, a missing harvest or a deleted
 * branch must all produce a report — degraded and saying so, never a crash.
 * Failures of collection are findings (`notes`), not exceptions.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_ITEMS,
  RunReportSchema,
  TaskEnvelopeSchema,
  ScheduledTaskSchema,
  type RunReport,
  type ScheduledTask,
  type TaskEnvelope,
  type Verdict,
} from "../contracts.ts";
import type { AttendedRecord } from "../contracts.ts";
import { mergeLedger } from "../run/ledger.ts";
import { taskRecordPath, workerPaths, type RunPaths } from "../run/paths.ts";
import { readTaskRecord, readWorkerState } from "../run/state.ts";
import { readAttended } from "../attended/mode.ts";
import { harvestTask } from "../harvest/index.ts";
import { precheckMerges, type MergeCheckInput } from "./merge.ts";
import type { MergePrecheck } from "../contracts.ts";

export interface CollectOptions {
  /**
   * The merge pre-check, injectable so collection can be tested without a
   * repository. Defaults to the real `git merge-tree` check.
   */
  precheck?: (inputs: readonly MergeCheckInput[]) => Promise<MergePrecheck[]>;
  /**
   * Harness globs from `fleet.yaml` (ISC-232), forwarded verbatim to every
   * `harvestTask` below.
   *
   * The report and `artifacts` must reach the same verdict for the same task
   * — they read the same run and both route through the same adjudicator, so
   * a divergence here is not a difference of opinion, it is one of the two
   * being wrong. Leaving `report` on the built-in defaults while `artifacts`
   * honoured config would do exactly that: a task whose diff touches an
   * operator-declared harness path would be capped by one command and
   * certified by the other, and which answer an operator got would depend on
   * which one they happened to run.
   */
  harnessPatterns?: readonly string[];
}

export interface CollectedReport {
  report: RunReport;
  /**
   * Findings about the COLLECTION itself — corrupt ledger shards, unreadable
   * state files, harvests that threw. Kept beside the report rather than
   * inside it because RunReportSchema is the wire contract and a consumer
   * validating against it must not need to know our failure vocabulary.
   */
  notes: string[];
  /**
   * Every worker a person drove by hand (SRD §3.5 `tui` mode), with the
   * guarantees their keystrokes voided. Beside the report for the same reason
   * `notes` is — the wire schema is frozen — but this one is not a
   * degradation of collection, it is a fact about the run that changes what
   * every verdict above means. An attended run that presents as unattended is
   * the failure the attended subsystem exists to prevent, so an unreadable
   * record is a NOTE, never a silent skip.
   */
  attended: AttendedRecord[];
  /**
   * Workers the ledger says a person touched whose record cannot be produced
   * — missing, unreadable, or schema-invalid.
   *
   * A separate array rather than a note, because `attended: []` is an
   * AFFIRMATIVE claim that nobody drove this run, and a consumer keying on
   * that field read a tampered or crash-truncated run as autonomous while
   * the warning sat in `collection_notes`. That array's own contract is
   * "findings about the COLLECTION", and whether a human edited the branch
   * is not a fact about collection. This is the non-empty signal.
   */
  attendedUnverified: Array<{ worker: string; reason: string }>;
}

/** One dispatched task's durable facts, as far as they could be recovered. */
interface DispatchedTask {
  taskId: string;
  envelope: TaskEnvelope | null;
  verdict: Verdict;
  settled: boolean;
}

/** Build the full RunReport for a run directory. Degrades; does not throw. */
export async function collectRunReport(
  run: RunPaths,
  opts: CollectOptions = {},
): Promise<CollectedReport> {
  const notes: string[] = [];

  // Ledger first: its merge already treats a corrupt shard as a finding
  // rather than a reason to lose the other writers' history, and the report
  // inherits that stance verbatim.
  const ledger = await mergeLedger(run);
  for (const e of ledger.errors) notes.push(`ledger: ${e}`);

  const dispatched = await collectDispatched(run, notes, opts.harnessPatterns);

  // Cross-check the ledger against the inbox: a `dispatched` event whose
  // envelope is missing means the durable dispatch record was lost, and the
  // task would otherwise silently vanish from the report.
  const inboxIds = new Set(dispatched.map((d) => d.taskId));
  for (const rec of ledger.records) {
    if (rec.event === "dispatched" && rec.task_id !== undefined && !inboxIds.has(rec.task_id)) {
      notes.push(`ledger records dispatch of ${rec.task_id} but inbox has no envelope for it`);
      dispatched.push({ taskId: rec.task_id, envelope: null, verdict: "unknown", settled: false });
      inboxIds.add(rec.task_id);
    }
  }

  const schedule = await buildSchedule(run, dispatched, notes);
  await noteLiveWorkers(run, notes);
  /**
   * Which workers the LEDGER says were handed to a person. Read here rather
   * than inside `collectAttended` because the merged ledger is already in
   * hand and re-reading it would be a second source of truth for the same
   * fact.
   */
  const attendedInLedger = new Set<string>(
    ledger.records
      .filter(
        (r) =>
          // `steer` writes a record too, and a steer is equally a human
          // reaching into a run — cross-checking only `tui_entered` would
          // leave the steer record deletable without trace.
          (r.event === "tui_entered" || r.event === "steer_sent") &&
          typeof r.worker === "string",
      )
      .map((r) => r.worker as string),
  );
  const { attended, unverified: attendedUnverified } = await collectAttended(run, notes, attendedInLedger);

  // Merge pre-check: one entry per (worker, branch), because several tasks on
  // one worker share its branch and checking it N times reports N times.
  const seen = new Set<string>();
  const mergeInputs: MergeCheckInput[] = [];
  for (const d of dispatched) {
    if (d.envelope === null) continue;
    const env = d.envelope;
    const key = `${env.worker}\0${env.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The worker's OWN checkout is preferred, not the parent — the opposite
    // of what this line used to do, and used to be right FOR THE MECHANISM
    // THAT USED TO EXIST: a `git worktree add` linked worktree shares the
    // parent's `.git`, so the branch really did "outlive a pruned worktree"
    // there. Isolation is now `git clone --no-hardlinks` per worker (SRD
    // §9.2 erratum): the branch is created with `git switch -c` INSIDE the
    // worker's own, independent clone, `origin` is stripped, and the parent
    // gains only a `worker-<id>` REMOTE — not a fetched ref — so a bare
    // `git -C <parent> rev-parse <branch>` can never resolve it. Preferring
    // `env.repo` here once `dispatch` started populating it with the parent
    // path (rather than the literal `"unset"`) silently degraded this
    // pre-check to "branch does not resolve; nothing was checked" for every
    // worktree-isolated worker — reachable on every ordinary run, and no
    // test drove `report` against a real worktree-isolated dispatch to catch
    // it. `env.repo` is the fallback, for a mode with no checkout of its own
    // to prefer (`shared-ro`, `none`) or an envelope predating this field.
    const repo = env.host_workdir !== "" && env.host_workdir !== "unset" ? env.host_workdir : env.repo;
    mergeInputs.push({ worker: env.worker, branch: env.branch, base_ref: env.base_ref, repo });
  }
  const precheck = opts.precheck ?? precheckMerges;
  let merge: MergePrecheck[] = [];
  try {
    merge = await precheck(mergeInputs);
  } catch (err) {
    // A pre-check that cannot run is a degraded report, not a failed one.
    notes.push(`merge pre-check failed: ${String(err)}`);
  }

  /**
   * Parsing must not be able to fail the whole report.
   *
   * `RunReportSchema` caps its arrays at MAX_ITEMS (1000), so a fleet with
   * more than a thousand tasks made `collectRunReport` THROW — no report at
   * all, on precisely the run where an operator most needs one, and in
   * direct contradiction of this module's stated contract that a degraded
   * report is always produced. The cap is a sane wire limit; treating it as
   * an assertion about reality was the mistake.
   */
  const capped = capForSchema(schedule, merge, notes);
  const report = RunReportSchema.parse({
    schema: "pifleet.report/v1",
    run_id: run.runId,
    generated_at: new Date().toISOString(),
    schedule: capped.schedule,
    merge: capped.merge,
    totals: {
      tasks: schedule.length,
      done: schedule.filter((s) => s.state === "done").length,
      blocked: schedule.filter((s) => s.state === "blocked").length,
      failed: schedule.filter((s) => s.verdict === "failed").length,
    },
  });
  return { report, notes, attended, attendedUnverified };
}

/**
 * Attended records for every worker that has one (SRD §3.5, Phase 6).
 *
 * The record is written once at `tui` entry and never removed, so its mere
 * presence means a person was in this worker's container at some point — even
 * if `--leave` has long since returned the pane to the viewer. A record that
 * cannot be read is reported as a note AND as a degraded row here: dropping
 * it silently would let an attended run present as unattended, which is
 * precisely what the record exists to make impossible.
 */
/**
 * Attended records, corroborated against the ledger.
 *
 * `attended.json` was the only evidence, which made "was this run driven by a
 * person" a question one `rm` could change the answer to: deleting the file
 * made the run present as fully autonomous, and every verdict in the report
 * regained a meaning it had not earned. An unreadable record already failed
 * safe; an ABSENT one failed open.
 *
 * `tui` also appends `tui_entered` to the ledger, which is append-only and
 * sharded per writer, so the two would have to be tampered with together.
 * When the ledger says a worker was attended and no record survives, the
 * report says so rather than staying quiet — a missing record is itself the
 * finding, and the operator needs to know the run was touched even though
 * the detail of how is gone.
 */
async function collectAttended(
  run: RunPaths,
  notes: string[],
  attendedInLedger: ReadonlySet<string>,
): Promise<{ attended: AttendedRecord[]; unverified: Array<{ worker: string; reason: string }> }> {
  let workers: string[];
  try {
    workers = await readdir(run.workersDir);
  } catch {
    return { attended: [], unverified: [] }; // no workers; nothing could have been attended
  }
  const out: AttendedRecord[] = [];
  const unverified: Array<{ worker: string; reason: string }> = [];
  for (const id of workers.sort()) {
    if (id.startsWith(".")) continue;
    try {
      const record = await readAttended(run, id);
      if (record !== null) {
        out.push(record);
      } else if (attendedInLedger.has(id)) {
        unverified.push({
          worker: id,
          reason: "the ledger records a human session but the attended record is missing",
        });
      }
    } catch (err) {
      // The case where the run is MOST certainly attended, so it must not be
      // the one demoted to a footnote.
      unverified.push({
        worker: id,
        reason: `the attended record cannot be read (${firstLine(err)})`,
      });
    }
  }
  return { attended: out, unverified };
}

/** Every task the inbox has a durable dispatch envelope for, harvested. */
async function collectDispatched(
  run: RunPaths,
  notes: string[],
  harnessPatterns: readonly string[] | undefined,
): Promise<DispatchedTask[]> {
  let entries: string[];
  try {
    entries = await readdir(run.inboxDir);
  } catch {
    return []; // a run that dispatched nothing still gets a report
  }
  const out: DispatchedTask[] = [];
  for (const e of entries.sort()) {
    if (!e.endsWith(".json") || e.startsWith(".")) continue;
    const taskId = e.slice(0, -".json".length);

    let envelope: TaskEnvelope | null = null;
    try {
      envelope = TaskEnvelopeSchema.parse(await Bun.file(join(run.inboxDir, e)).json());
    } catch (err) {
      notes.push(`inbox/${e} is unreadable: ${firstLine(err)}`);
    }

    // The verdict comes from the harvester — the ONLY door a worker's claim
    // may enter through, because adjudication there can never upgrade.
    let verdict: Verdict = "unknown";
    try {
      const t = await harvestTask(run, taskId, { harnessPatterns });
      verdict = t.harvest.verdict;
    } catch (err) {
      // One task that cannot be harvested is one degraded row, not the loss
      // of the whole report (the same stance harvestAll takes).
      notes.push(`harvest of ${taskId} failed: ${firstLine(err)}`);
    }

    // Settle is the supervisor's word, not the worker's: the terminal task
    // record is written at settle and carries the epoch it settled.
    let settled = false;
    if (envelope !== null) {
      try {
        const rec = await readTaskRecord(
          taskRecordPath(workerPaths(run, envelope.worker), taskId),
        );
        settled = rec !== null && rec.epoch === envelope.epoch;
      } catch (err) {
        notes.push(`task record for ${taskId} is unreadable: ${firstLine(err)}`);
      }
    }
    out.push({ taskId, envelope, verdict, settled });
  }
  return out;
}

/**
 * The schedule: the scheduler's snapshot where one exists, extended with every
 * dispatched task the inbox proves happened.
 *
 * The snapshot contributes what only the scheduler knows — undispatched tasks
 * and WHY they are not running (`waiting`/`ready`/`blocked`, `blocked_by`).
 * It never contributes a verdict: a scheduler-recorded verdict could have been
 * copied from a worker's self-report, and laundering a claim through a second
 * file must not let it bypass adjudication. Dispatched rows take the harvest
 * verdict; undispatched rows have none to take.
 */
async function buildSchedule(
  run: RunPaths,
  dispatched: DispatchedTask[],
  notes: string[],
): Promise<ScheduledTask[]> {
  const byTaskId = new Map<string, DispatchedTask>();
  for (const d of dispatched) byTaskId.set(d.taskId, d);

  const rows: ScheduledTask[] = [];
  const covered = new Set<string>();

  for (const entry of await readScheduleSnapshot(run, notes)) {
    const d = entry.task_id !== null ? byTaskId.get(entry.task_id) : undefined;
    if (d !== undefined) {
      covered.add(d.taskId);
      rows.push({
        ...entry,
        state: d.settled ? "done" : "dispatched",
        verdict: d.verdict,
      });
    } else {
      /**
       * Undispatched: refuse the verdict AND `done`.
       *
       * Refusing only the verdict left the one state the snapshot must not
       * be able to assert. A `schedule.json` row of
       * `{state:"done", task_id:null}` produced "1 done" in `totals` and a
       * `done` line in the rendering, with no collection note, for a task the
       * inbox cannot show was ever dispatched — the file donating a fact
       * about work rather than about scheduling. Same laundering shape §8.2
       * closes for self-reports, one file over.
       *
       * Every other state is genuinely the scheduler's to know: `waiting`,
       * `ready` and `blocked` are statements about the graph, and nothing
       * else in the run records them.
       */
      const donated = entry.state === "done" || entry.state === "dispatched";
      if (donated) {
        notes.push(
          `schedule.json claims task '${entry.id}' is ${entry.state}, but no dispatch record ` +
            `exists for it; reported as ready`,
        );
      }
      rows.push({ ...entry, state: donated ? "ready" : entry.state, verdict: null });
    }
  }

  for (const d of dispatched) {
    if (covered.has(d.taskId)) continue;
    rows.push(
      ScheduledTaskSchema.parse({
        id: d.taskId,
        state: d.settled ? "done" : "dispatched",
        worker: d.envelope?.worker ?? null,
        task_id: d.taskId,
        depends_on: d.envelope?.depends_on ?? [],
        blocked_by: null,
        verdict: d.verdict,
      }),
    );
  }

  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

/**
 * The scheduler's snapshot, read tolerantly from `run.scheduleJson`.
 *
 * The path comes from `runPaths()` rather than being rebuilt here. It was
 * rebuilt here, against a filename this module invented, while the scheduler
 * wrote no snapshot at all -- two halves of one phase that did not meet. The
 * path is now part of the seam, and `run/paths.ts` is the single source for
 * every run-dir path.
 *
 * This is a seam with `dispatch --auto`, which is owned elsewhere and may not
 * have run at all (manual dispatch). Absence is normal; a malformed file is a
 * note. Accepts either a bare array or `{tasks: [...]}` so the snapshot's
 * envelope shape is not something two modules must agree on to interoperate.
 */
async function readScheduleSnapshot(run: RunPaths, notes: string[]): Promise<ScheduledTask[]> {
  const path = run.scheduleJson;
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  let doc: unknown;
  try {
    doc = await file.json();
  } catch (err) {
    notes.push(`schedule.json is unreadable: ${firstLine(err)}`);
    return [];
  }
  const list = Array.isArray(doc)
    ? doc
    : typeof doc === "object" && doc !== null && Array.isArray((doc as { tasks?: unknown }).tasks)
      ? ((doc as { tasks: unknown[] }).tasks)
      : null;
  if (list === null) {
    notes.push("schedule.json has neither a task array nor a tasks field; ignored");
    return [];
  }
  const out: ScheduledTask[] = [];
  for (const [i, raw] of list.entries()) {
    const parsed = ScheduledTaskSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
    else notes.push(`schedule.json entry ${i} is malformed; skipped`);
  }
  return out;
}

/**
 * Workers still mid-flight make the whole report provisional — a "failed"
 * verdict over a live worktree describes a diff still in motion. Said once,
 * up front, rather than asking the reader to infer it from phase names.
 */
async function noteLiveWorkers(run: RunPaths, notes: string[]): Promise<void> {
  let workers: string[];
  try {
    workers = await readdir(run.workersDir);
  } catch {
    return; // no workers ever started; the empty report stands
  }
  for (const id of workers.sort()) {
    if (id.startsWith(".")) continue;
    try {
      const state = await readWorkerState(workerPaths(run, id));
      if (state !== null && state.phase !== "dead" && state.phase !== "idle") {
        notes.push(`worker ${id} was ${state.phase} at collection time; its rows may still move`);
      }
    } catch (err) {
      notes.push(`worker ${id} state is unreadable: ${firstLine(err)}`);
    }
  }
}

function firstLine(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.split("\n")[0] ?? s;
}

/**
 * Fit the report to the wire schema, saying so when anything is dropped.
 *
 * `RunReportSchema` caps its arrays at `MAX_ITEMS`, and `parse` throws rather
 * than truncating — so a run with more than a thousand tasks produced no
 * report at all. Truncating silently would be no better: a report that says
 * "1000 tasks" when there were 1200 is worse than one that crashes, because
 * it is believed. `totals` is computed from the FULL arrays and the note
 * names exactly what was cut, so the counts stay true even when the rows do
 * not fit.
 *
 * Rows are kept from the front: `schedule` is in task-list order, so the
 * retained ones are the ones an operator reads first.
 */
function capForSchema(
  schedule: ScheduledTask[],
  merge: MergePrecheck[],
  notes: string[],
): { schedule: ScheduledTask[]; merge: MergePrecheck[] } {
  if (schedule.length > MAX_ITEMS) {
    notes.push(
      `schedule has ${schedule.length} tasks; only the first ${MAX_ITEMS} are listed ` +
        `(totals count all ${schedule.length})`,
    );
  }
  if (merge.length > MAX_ITEMS) {
    notes.push(
      `merge pre-check has ${merge.length} rows; only the first ${MAX_ITEMS} are listed`,
    );
  }
  return { schedule: schedule.slice(0, MAX_ITEMS), merge: merge.slice(0, MAX_ITEMS) };
}
