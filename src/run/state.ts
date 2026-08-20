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
  BudgetStateSchema,
  EXIT,
  PresentationSchema,
  VerdictSchema,
  WorkerStateSchema,
  workerId,
  type BudgetState,
  type Presentation,
  type WorkerState,
} from "../contracts.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_CONCURRENT,
  type FleetConfig,
} from "../config/schema.ts";
import { writeJsonAtomic } from "../util/jsonl.ts";
import { emptyFence, type FenceSnapshot } from "../rpc/epoch.ts";
import type { RunPaths, WorkerPaths } from "./paths.ts";
import type { WorkerWorktree } from "./worktree.ts";

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

export async function readWorkerState(paths: WorkerPaths): Promise<WorkerState | null> {
  return readValidated(paths.stateJson, (v) => WorkerStateSchema.parse(v));
}

/**
 * The staleness threshold the daemon reaps by, as `up` recorded it (ISC-236).
 *
 * Deliberately forgiving: a run directory written before this field existed,
 * or assembled by hand in a test, must still start a daemon rather than fail
 * to. But the fallback is only for a MISSING value — a present one that is not
 * a positive number means the run dir disagrees with itself about how long a
 * silent supervisor may live, and silently substituting a default there would
 * hide it.
 */
export async function readRunHeartbeatIntervalMs(run: RunPaths): Promise<number> {
  const doc = await readValidated(run.runJson, (v) =>
    z
      .object({ heartbeat_interval_ms: z.number().positive().optional() })
      .loose()
      .parse(v),
  );
  return doc?.heartbeat_interval_ms ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
}

/** What `up` recorded about the harness surface, and whether it recorded anything. */
export interface RunHarnessPatterns {
  /** `undefined` = the harvester's built-in defaults apply. */
  patterns: readonly string[] | undefined;
  /** A degradation the caller must surface, or `null` when there is nothing to say. */
  note: string | null;
}

/**
 * The harness surface the run was CREATED under, as `up` recorded it (ISC-232).
 *
 * Same shape and the same reason as `readRunHeartbeatIntervalMs` above: a
 * value that decides how a run is graded has to travel WITH the run. Harvest
 * is handed a run directory and nothing else, and a run outlives the config
 * that produced it, so resolving `./fleet.yaml` at harvest time would grade a
 * months-old run against whatever file happens to sit in today's cwd — the
 * same task certifying `success` today and capping at `unknown` tomorrow with
 * no change to the run at all.
 *
 * Forgiving about ABSENCE, in the same way and for the same reason as the
 * heartbeat threshold: a run directory written before this field existed, or
 * assembled by hand in a test, must still be harvestable. A missing key and an
 * explicit `null` both mean the built-in defaults, silently — and both are
 * still reproducible, which is the property that matters, because neither
 * consults the cwd.
 *
 * Not forgiving about a value that is WRONG. An empty array disables the
 * ISC-150 cap (`touched` could never be non-empty), and the only way one
 * reaches this file is a hand-edited or corrupt `run.json`; a non-array is the
 * run dir disagreeing with itself about how it is graded. Both degrade to the
 * defaults rather than crashing a pure read, but neither does it quietly.
 */
export async function readRunHarnessPatterns(run: RunPaths): Promise<RunHarnessPatterns> {
  let doc: { harness_patterns?: readonly string[] | null } | null;
  try {
    doc = await readValidated(run.runJson, (v) =>
      z
        .object({ harness_patterns: z.array(z.string()).nullish() })
        .loose()
        .parse(v),
    );
  } catch (err) {
    return {
      patterns: undefined,
      note:
        `run.json does not record a readable harness surface (${err instanceof Error ? err.message : String(err)}); ` +
        "grading with the built-in defaults",
    };
  }
  const recorded = doc?.harness_patterns;
  if (recorded === undefined || recorded === null) return { patterns: undefined, note: null };
  if (recorded.length === 0) {
    return {
      patterns: undefined,
      note:
        "run.json records an EMPTY harness surface, which would disable the ISC-150 " +
        "cap entirely; refusing it and grading with the built-in defaults",
    };
  }
  return { patterns: recorded, note: null };
}

/**
 * What the run was launched to SPEND, as `up` recorded it (ISC-109/114/115).
 *
 * Fourth reader of `run.json` in this file and the same shape as the three
 * above, for the same reason: a value that decides what a later command DOES
 * has to travel with the run. `dispatch --auto` caps concurrency and halts on
 * a ceiling using these numbers, and re-resolving `fleet.yaml` at dispatch
 * time would budget a run against whatever config happens to sit in today's
 * cwd — the same task admitted today and refused tomorrow with no change to
 * the run at all.
 *
 * Forgiving about ABSENCE, like its neighbours: a run directory written
 * before these fields existed, or assembled by hand in a test, must still be
 * dispatchable. The two axes then default DIFFERENTLY, and the asymmetry is
 * deliberate (see `DEFAULT_MAX_CONCURRENT`): a missing cap falls back to the
 * schema's own default, because a cap only delays work; a missing ceiling
 * means UNBOUNDED, because `tokens_ceiling` is a required field with no
 * default and inventing one would refuse work nobody budgeted for.
 *
 * Not forgiving about a value that is WRONG: a non-positive cap would admit
 * nothing at all and deadlock the run, so it degrades to the default with a
 * `note` the caller puts in the ledger rather than silently.
 */
export interface RunBudgetPolicy {
  /** null = unbounded. */
  tokensCeiling: number | null;
  maxConcurrent: number;
  /** Up-front hold per admission; 0 when the operator configured none. */
  perTaskReserveTokens: number;
  /** A degradation the caller must surface, or null when there is nothing to say. */
  note: string | null;
}

/**
 * The budget half of `run.json`, as `up` writes it — the WRITER of the
 * document `readRunBudgetPolicy` below reads.
 *
 * Both halves live in this module on purpose, and it is the same rule
 * `run/paths.ts` opens with: a value spelled in two places will eventually be
 * spelled differently in two places. Here the two places would be the object
 * literal `up` builds and the zod shape `dispatch` parses it with, and a
 * divergence between them does not throw — a renamed key simply reads as
 * absent, so the run silently falls back to "unbounded, cap 2" and an
 * operator's configured ceiling stops existing. That is precisely how
 * `max_concurrent` came to be a config key with no reader at all.
 *
 * `null` for "no config was reachable", which is a real state (`up` with no
 * `fleet.yaml`) and not an error: the reader answers it with the schema's own
 * default cap and an unbounded ceiling.
 */
export function runBudgetRecord(run: FleetConfig["run"] | null): {
  max_concurrent: number | null;
  budget: { tokens_ceiling: number; per_task_reserve_tokens: number | null } | null;
} {
  if (run === null) return { max_concurrent: null, budget: null };
  return {
    max_concurrent: run.max_concurrent,
    budget: {
      tokens_ceiling: run.budget.tokens_ceiling,
      per_task_reserve_tokens: run.budget.per_task_reserve_tokens ?? null,
    },
  };
}

export async function readRunBudgetPolicy(run: RunPaths): Promise<RunBudgetPolicy> {
  const fallback: RunBudgetPolicy = {
    tokensCeiling: null,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    perTaskReserveTokens: 0,
    note: null,
  };
  let doc: {
    max_concurrent?: number | null;
    budget?: { tokens_ceiling?: number | null; per_task_reserve_tokens?: number | null } | null;
  } | null;
  try {
    doc = await readValidated(run.runJson, (v) =>
      z
        .object({
          max_concurrent: z.number().nullish(),
          budget: z
            .object({
              tokens_ceiling: z.number().nullish(),
              per_task_reserve_tokens: z.number().nullish(),
            })
            .loose()
            .nullish(),
        })
        .loose()
        .parse(v),
    );
  } catch (err) {
    return {
      ...fallback,
      note:
        `run.json does not record a readable budget policy (${err instanceof Error ? err.message : String(err)}); ` +
        `dispatching unbounded at max_concurrent ${DEFAULT_MAX_CONCURRENT}`,
    };
  }
  const cap = doc?.max_concurrent;
  let maxConcurrent = fallback.maxConcurrent;
  let note: string | null = null;
  if (typeof cap === "number") {
    if (Number.isInteger(cap) && cap > 0) maxConcurrent = cap;
    else {
      note =
        `run.json records max_concurrent ${cap}, which would admit nothing; ` +
        `dispatching at the default ${DEFAULT_MAX_CONCURRENT}`;
    }
  }
  const ceiling = doc?.budget?.tokens_ceiling;
  const reserve = doc?.budget?.per_task_reserve_tokens;
  return {
    tokensCeiling: typeof ceiling === "number" && ceiling >= 0 ? Math.floor(ceiling) : null,
    maxConcurrent,
    perTaskReserveTokens: typeof reserve === "number" && reserve > 0 ? Math.floor(reserve) : 0,
    note,
  };
}

/**
 * The run's budget accounting as the last scheduler pass left it.
 *
 * `wait` reads this to fold `budgetExitCode` into its own ladder, so a
 * dispatch-then-wait pipeline reports the same integer `--auto` did; a
 * resumed `--auto` reads it for the halt verdict alone (see `resumeBudget`).
 * Null means no scheduled run has happened yet, which is the normal state of
 * a run driven by manual `dispatch` calls — not a degradation.
 */
export async function readBudgetState(run: RunPaths): Promise<BudgetState | null> {
  return readValidated(run.budgetJson, (v) => BudgetStateSchema.parse(v));
}

/**
 * The per-worker checkouts `up` created, keyed by worker id, plus the parent
 * repository they were cloned from.
 *
 * Third reader of `run.json` in this file and the same shape as the two above,
 * for the same reason: a fact that decides what a later command DOES has to
 * travel with the run. `dispatch` names a worker's `host_workdir` and `branch`
 * in every envelope, and `down --prune` deletes directories — resolving either
 * from today's `fleet.yaml` would let a config edited after `up` send a worker
 * to a path this run never created, or point `rm -rf` at one.
 *
 * Forgiving about ABSENCE for the reason `readRunHarnessPatterns` is: a run
 * created before this field existed, a hand-assembled test fixture, and a run
 * whose workers are all `shared-ro` are the same on-disk shape, and all three
 * must stay dispatchable. An entry that is present but MALFORMED degrades to
 * "no record" rather than crashing a pure read, but never silently — `note`
 * carries the reason, and `dispatch` puts it in the ledger.
 */
export interface RunWorktrees {
  /** Empty when the run recorded none; never null, so callers need no branch. */
  byWorker: ReadonlyMap<string, WorkerWorktree>;
  /** The parent checkout, or null when the run did not record one. */
  repo: string | null;
  /**
   * The `run.branch_prefix` the run was actually launched with, or null when
   * the run predates this field. Recorded for the same reason `repo` is:
   * `fleet.yaml` can be edited after `up`, and `dispatch`'s no-record
   * fallback (a `shared-ro`/`none` worker, or one with no config entry) must
   * name the branch THIS run would have created, not whatever `branch_prefix`
   * happens to read today.
   */
  branchPrefix: string | null;
  /**
   * A degradation the caller must surface, or null when there is nothing to
   * say. Set when `run.json` itself could not be read at all — no longer set
   * for one malformed worker entry among otherwise-valid ones; see
   * `perWorkerNotes`.
   */
  note: string | null;
  /**
   * `<workerId>: <reason>` for every entry that failed its OWN schema check,
   * kept OUT of `note` deliberately: one worker's malformed record used to
   * degrade `byWorker` to empty for every worker in the run, so a single
   * future-shaped or hand-edited entry silently blinded `dispatch`'s
   * `branch_prefix` fallback and `down --prune`'s reaping for workers whose
   * OWN records were perfectly fine. Parsed per-entry instead: one bad
   * record is dropped and named here; every good one still reaches
   * `byWorker`.
   */
  perWorkerNotes: readonly string[];
}

const RunWorktreeRecordSchema = z.object({
  workerId: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseSha: z.string().min(1),
  remoteName: z.string().min(1),
  /** Defaulted for a record written before this field existed. */
  baselineStatus: z.string().default(""),
  /**
   * Defaulted to `""` for a record written before this field existed —
   * which reads as permanently dirty in `inspectCloneDirt` (an empty string
   * can never equal a real git tree SHA), the honest answer for "this
   * record does not describe a baseline", not a silent pass-through.
   */
  baselineTree: z.string().default(""),
});

export async function readRunWorktrees(run: RunPaths): Promise<RunWorktrees> {
  const empty = new Map<string, WorkerWorktree>();
  let doc: { repo?: string | null; branch_prefix?: string | null; worktrees?: unknown } | null;
  try {
    doc = await readValidated(run.runJson, (v) =>
      z
        .object({
          repo: z.string().nullish(),
          branch_prefix: z.string().nullish(),
          // `.optional()`, not bare `z.unknown()`: zod requires an object
          // schema's keys to be STRUCTURALLY PRESENT unless marked optional,
          // even when the value type is `unknown` — so a `run.json` that
          // never had a `worktrees` key at all (a run predating this field,
          // exactly the case this function's own docstring says must stay
          // dispatchable) failed this parse and fell into the catch block
          // below, `note` and all. Nothing acted on `note` before this
          // module's callers started treating it as a genuine degradation,
          // which is what turned an unnoticed latent bug into an observed
          // false refusal.
          worktrees: z.unknown().optional(),
        })
        .loose()
        .parse(v),
    );
  } catch (err) {
    return {
      byWorker: empty,
      repo: null,
      branchPrefix: null,
      note: `run.json could not be read for worker checkouts (${err instanceof Error ? err.message : String(err)})`,
      perWorkerNotes: [],
    };
  }
  const repo = doc?.repo ?? null;
  const branchPrefix = doc?.branch_prefix ?? null;
  const raw = doc?.worktrees;
  if (raw === undefined) {
    // The KEY is absent entirely — a run predating this field, a hand-built
    // test fixture, or a fleet with no `worktree`-isolation worker at all.
    // Genuinely indistinguishable from "nothing to record", and must stay
    // that way: this is the shape `readRunHarnessPatterns`'s own
    // forgiving-about-absence rule exists to keep dispatchable.
    return { byWorker: empty, repo, branchPrefix, note: null, perWorkerNotes: [] };
  }
  if (raw === null) {
    // The key is PRESENT and explicitly `null` — a different fact from
    // absence. `up.ts` writes `worktrees: null` the moment `run.json` first
    // exists and OVERWRITES it with a real array (`[]` for a legitimate
    // all-shared-ro/none fleet, or the created records otherwise) once
    // `createWorkerWorktrees` returns; see that module's own comment on
    // why the two must never collapse to the same on-disk shape. `null`
    // surviving to a READ means `up` crashed between those two writes —
    // exactly the "a clone may exist with nothing describing it" case
    // `down --prune` cannot safely read as "nothing to reap".
    return {
      byWorker: empty,
      repo,
      branchPrefix,
      note:
        "run.json records worktree creation as INCOMPLETE (worktrees: null) — 'up' did not finish; " +
        "a checkout may exist on disk with nothing describing it. Check the repository's .worktrees/ " +
        "directory by hand before assuming there is nothing to reap.",
      perWorkerNotes: [],
    };
  }
  if (!Array.isArray(raw)) {
    return {
      byWorker: empty,
      repo,
      branchPrefix,
      note: `run.json records worker checkouts in a shape this build cannot read (expected an array); treating the run as having none`,
      perWorkerNotes: [],
    };
  }

  const byWorker = new Map<string, WorkerWorktree>();
  const perWorkerNotes: string[] = [];
  for (const [i, entry] of raw.entries()) {
    const parsed = RunWorktreeRecordSchema.safeParse(entry);
    if (!parsed.success) {
      // A raw object's own `workerId`, if it happens to be a readable
      // string, names the row even though the schema that would confirm it
      // is exactly what just failed — best-effort, for a diagnosis a human
      // can act on rather than a bare array index.
      const maybeId =
        typeof entry === "object" && entry !== null && "workerId" in entry && typeof (entry as { workerId: unknown }).workerId === "string"
          ? (entry as { workerId: string }).workerId
          : `entry ${i}`;
      perWorkerNotes.push(`${maybeId}: ${parsed.error.message}`);
      continue;
    }
    byWorker.set(parsed.data.workerId, parsed.data);
  }
  return { byWorker, repo, branchPrefix, note: null, perWorkerNotes };
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
  let text = await file.text();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (firstErr) {
    /**
     * One retry, because the file on disk is whole and the READ was not.
     *
     * These files are written by `writeJsonAtomic` — tmp, fsync, rename — so
     * a reader must see either the entire previous file or the entire next
     * one. A truncated read of an untruncated file is what happens when the
     * size is taken from one inode and the bytes from its replacement: the
     * rename lands between the stat and the read, and the result is a short
     * buffer that ends mid-token. It appeared only under CI's timing, never
     * in eight local runs of the same test.
     *
     * Re-reading resolves that, and cannot hide a genuinely corrupt file:
     * a real truncation on disk fails the retry too, and the error below
     * carries the bytes either way.
     */
    text = await Bun.file(path).text();
    try {
      return parse(JSON.parse(text));
    } catch {
      // Fall through to the diagnostic, which reports the FIRST failure.
    }
    const err = firstErr;
    /**
     * Carry the bytes, because "Unterminated string" alone says nothing
     * about how a file written by `writeJsonAtomic` came to be truncated.
     * That writer is tmp + fsync + rename, so a reader should see either the
     * whole previous file or the whole next one — a torn read means the
     * premise is wrong somewhere, and CI is the only place it has appeared.
     * Guessing across CI round-trips is expensive; a failure that describes
     * itself is not.
     */
    throw new StateReadError(
      path,
      `${String(err)} — ${text.length} bytes on disk, starting ${JSON.stringify(text.slice(0, 120))}`,
    );
  }
  try {
    return parse(doc);
  } catch (err) {
    throw new StateReadError(path, err);
  }
}
