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
  RunReportSchema,
  TaskEnvelopeSchema,
  ScheduledTaskSchema,
  type RunReport,
  type ScheduledTask,
  type TaskEnvelope,
  type Verdict,
} from "../contracts.ts";
import { mergeLedger } from "../run/ledger.ts";
import { taskRecordPath, workerPaths, type RunPaths } from "../run/paths.ts";
import { readTaskRecord, readWorkerState } from "../run/state.ts";
import { harvestTask } from "../harvest/index.ts";
import { precheckMerges, type MergeCheckInput } from "./merge.ts";
import type { MergePrecheck } from "../contracts.ts";

export interface CollectOptions {
  /**
   * The merge pre-check, injectable so collection can be tested without a
   * repository. Defaults to the real `git merge-tree` check.
   */
  precheck?: (inputs: readonly MergeCheckInput[]) => Promise<MergePrecheck[]>;
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

  const dispatched = await collectDispatched(run, notes);

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
    // The parent repository is preferred: worktrees share its refs, so the
    // branch outlives a pruned worktree there. The worktree is the fallback
    // for envelopes that never recorded a parent.
    const repo = env.repo !== "" && env.repo !== "unset" ? env.repo : env.host_workdir;
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

  const report = RunReportSchema.parse({
    schema: "pifleet.report/v1",
    run_id: run.runId,
    generated_at: new Date().toISOString(),
    schedule,
    merge,
    totals: {
      tasks: schedule.length,
      done: schedule.filter((s) => s.state === "done").length,
      blocked: schedule.filter((s) => s.state === "blocked").length,
      failed: schedule.filter((s) => s.verdict === "failed").length,
    },
  });
  return { report, notes };
}

/** Every task the inbox has a durable dispatch envelope for, harvested. */
async function collectDispatched(run: RunPaths, notes: string[]): Promise<DispatchedTask[]> {
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
      const t = await harvestTask(run, taskId);
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
      // Undispatched: keep the scheduler's state, refuse its verdict.
      rows.push({ ...entry, verdict: null });
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
 * The scheduler's snapshot at `<run-dir>/schedule.json`, read tolerantly.
 *
 * This is a seam with `dispatch --auto`, which is owned elsewhere and may not
 * have run at all (manual dispatch). Absence is normal; a malformed file is a
 * note. Accepts either a bare array or `{tasks: [...]}` so the snapshot's
 * envelope shape is not something two modules must agree on to interoperate.
 */
async function readScheduleSnapshot(run: RunPaths, notes: string[]): Promise<ScheduledTask[]> {
  const path = join(run.root, "schedule.json");
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
