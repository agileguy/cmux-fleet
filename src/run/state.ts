/**
 * Durable per-worker state (SRD §7.6) and its satellites.
 *
 * Everything here goes through `writeJsonAtomic` — tmp + fsync + rename +
 * directory fsync — because a torn `state.json` read by `status` mid-crash is
 * worse than a stale one.
 *
 * Two rules with recorded failures behind them:
 *
 * - `session_path` is recorded VERBATIM from `get_state`, never computed and
 *   never globbed (ISC-95). The timestamp prefix is unknowable in advance and
 *   the file is created lazily on the first assistant message, so any computed
 *   path is a guess that happens to work until it doesn't.
 *
 * - The absent→present transition of the session file is recorded
 *   (`session_present`), so "never started" is distinguishable from "wrong
 *   path" (ISC-96). A path that never transitions is a worker that never
 *   produced an assistant message; a missing file at a path that WAS present
 *   is a harvest bug.
 *
 * Presentation identifiers live in a sibling `presentation.json`, never in
 * `state.json`, so a lost cmux cannot invalidate control-plane state.
 */

import { z } from "zod";
import {
  EXIT,
  PresentationSchema,
  VerdictSchema,
  WorkerStateSchema,
  workerId,
  type Presentation,
  type WorkerState,
} from "../contracts.ts";
import { writeJsonAtomic } from "../util/jsonl.ts";
import { emptyFence, type FenceSnapshot } from "../rpc/epoch.ts";
import type { WorkerPaths } from "./paths.ts";

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

export async function readWorkerState(paths: WorkerPaths): Promise<WorkerState | null> {
  return readValidated(paths.stateJson, (v) => WorkerStateSchema.parse(v));
}

export async function writeWorkerState(paths: WorkerPaths, state: WorkerState): Promise<void> {
  await writeJsonAtomic(paths.stateJson, WorkerStateSchema.parse(state));
}

/** A fresh state file for a supervisor that has just started. */
export function initialWorkerState(args: {
  worker: string;
  runId: string;
  pid: number;
  pgid: number;
  startedAt: string;
}): WorkerState {
  return WorkerStateSchema.parse({
    schema: "pifleet.state/v1",
    worker: args.worker,
    run_id: args.runId,
    pid: args.pid,
    pgid: args.pgid,
    started_at: args.startedAt,
    phase: "starting",
    epoch: 0,
  });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export async function readPresentation(paths: WorkerPaths): Promise<Presentation | null> {
  return readValidated(paths.presentationJson, (v) => PresentationSchema.parse(v));
}

export async function writePresentation(paths: WorkerPaths, p: Presentation): Promise<void> {
  await writeJsonAtomic(paths.presentationJson, PresentationSchema.parse(p));
}

// ---------------------------------------------------------------------------
// Epoch fence (rpc/epoch.ts) — durable BEFORE dispatch, by contract.
// ---------------------------------------------------------------------------

const FenceLiveSchema = z.object({
  task_id: z.string(),
  attempt_id: z.string(),
  epoch: z.number().int().nonnegative(),
  started: z.boolean(),
  abort_requested: z.boolean(),
  timed_out: z.boolean(),
});

export const FenceFileSchema = z.object({
  schema: z.literal("pifleet.fence/v1"),
  worker: workerId,
  last_accepted_epoch: z.number().int().nonnegative(),
  ack_seq: z.number().int().nonnegative().nullable(),
  last_seq: z.number().int().nonnegative(),
  live: FenceLiveSchema.nullable(),
  completed: z.array(
    z.object({
      task_id: z.string(),
      attempt_id: z.string(),
      epoch: z.number().int().nonnegative(),
      verdict: VerdictSchema,
      settled_at: z.string(),
    }),
  ),
  attempts: z.record(z.string(), z.number().int().nonnegative()),
});
export type FenceFile = z.infer<typeof FenceFileSchema>;

export async function readFence(paths: WorkerPaths): Promise<FenceSnapshot> {
  const file = await readValidated(paths.fenceJson, (v) => FenceFileSchema.parse(v));
  if (file === null) return emptyFence();
  const { schema: _schema, worker: _worker, ...fence } = file;
  return fence;
}

export async function writeFence(
  paths: WorkerPaths,
  worker: string,
  fence: FenceSnapshot,
): Promise<void> {
  const file: FenceFile = FenceFileSchema.parse({
    schema: "pifleet.fence/v1",
    worker,
    ...fence,
  });
  await writeJsonAtomic(paths.fenceJson, file);
}

// ---------------------------------------------------------------------------
// Terminal per-task record — what `wait` polls for.
// ---------------------------------------------------------------------------

export const TaskRecordSchema = z.object({
  schema: z.literal("pifleet.taskrecord/v1"),
  task_id: z.string(),
  attempt_id: z.string(),
  worker: workerId,
  run_id: z.string(),
  epoch: z.number().int().nonnegative(),
  verdict: VerdictSchema,
  reason: z.string().default(""),
  settled_at: z.string(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export async function readTaskRecord(path: string): Promise<TaskRecord | null> {
  return readValidated(path, (v) => TaskRecordSchema.parse(v));
}

export async function writeTaskRecord(path: string, record: TaskRecord): Promise<void> {
  await writeJsonAtomic(path, TaskRecordSchema.parse(record));
}

// ---------------------------------------------------------------------------
// Shared read helper
// ---------------------------------------------------------------------------

/**
 * A state file that is truncated, or valid JSON of the wrong shape, is a
 * diagnosable condition — not a crash. Both failures used to escape as raw
 * `SyntaxError` / `ZodError` stack traces with exit 1, which is not on the
 * §10 ladder, and they landed on `status` and `down` — the commands you reach
 * for precisely when a run is in a bad state.
 */
export class StateReadError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    // A ZodError's `message` is a pretty-printed JSON array, so its first line
    // is a bare "[". Summarise the issues instead — the field path is the
    // whole diagnostic value here.
    const issues = (cause as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
    const detail = Array.isArray(issues)
      ? issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ")
      : cause instanceof Error
        ? (cause.message.split("\n")[0] ?? cause.message)
        : String(cause);
    super(`unreadable state file ${path}: ${detail}`);
    this.name = "StateReadError";
  }
}

async function readValidated<T>(path: string, parse: (v: unknown) => T): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = await file.text();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new StateReadError(path, err);
  }
  try {
    return parse(doc);
  } catch (err) {
    throw new StateReadError(path, err);
  }
}
