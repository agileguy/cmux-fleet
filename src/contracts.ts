/**
 * Wire contracts shared by every module.
 *
 * This file is the seam. Everything that crosses a process boundary — the task
 * envelope the CLI writes and the worker reads, the result envelope the worker
 * writes and the harvester reads, the state file the supervisor owns — is
 * defined exactly once, here, as a zod schema. The inferred TypeScript type is
 * derived from the schema rather than declared alongside it, so a schema change
 * cannot silently diverge from the type.
 *
 * Envelopes authored outside this process are untrusted input (SRD §12.5):
 * every string is length-bounded and every path is validated before it is
 * dereferenced.
 */

import { z } from "zod";

/** Longest accepted value for a free-text envelope field. */
export const MAX_TEXT = 65_536;
/** Longest accepted value for a short scalar (ids, paths, refs). */
export const MAX_SHORT = 4_096;
/** Longest accepted array length for any envelope collection. */
export const MAX_ITEMS = 1_000;

const shortStr = z.string().max(MAX_SHORT);
const text = z.string().max(MAX_TEXT);
const sha40 = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-char SHA");

/**
 * Pi's session-id grammar, verified against 0.79.6. Worker ids are used as
 * session ids, so they inherit it.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const workerId = z.string().max(64).regex(SESSION_ID_RE, "invalid worker id");

// ---------------------------------------------------------------------------
// Vocabularies (SRD §7.3) — three, not one.
// ---------------------------------------------------------------------------

/** Authored by the worker. Advisory: may downgrade a verdict, never upgrade one. */
export const StatusSchema = z.enum(["success", "partial", "blocked", "failed"]);
export type Status = z.infer<typeof StatusSchema>;

/** Authored by the harvester. The value callers act on. */
export const VerdictSchema = z.enum([
  "success",
  "partial",
  "blocked",
  "failed",
  "aborted",
  "timed_out",
  "unknown",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Authored by the supervisor. Describes the worker, not the task. */
export const PhaseSchema = z.enum(["starting", "idle", "busy", "settling", "stalled", "dead"]);
export type WorkerPhase = z.infer<typeof PhaseSchema>;

/**
 * Adjudication lattice: failed < blocked < partial < success.
 *
 * `unknown` is deliberately absent — it is the identity element, not the
 * bottom. A task with a clean diff and green acceptance commands must not be
 * downgraded merely because the worker forgot to write an envelope (SRD §7.3).
 */
const LATTICE: readonly Status[] = ["failed", "blocked", "partial", "success"];

/** Rank of a lattice member; -1 for values outside the lattice. */
export function rank(v: Verdict): number {
  return LATTICE.indexOf(v as Status);
}

/**
 * Combine a derived verdict with the worker's claim.
 *
 * `aborted` and `timed_out` are terminal and set by the supervisor, so they win
 * outright. `unknown` on either side yields the other side.
 */
export function adjudicate(derived: Verdict, claimed: Verdict | undefined): Verdict {
  if (derived === "aborted" || derived === "timed_out") return derived;
  if (claimed === undefined || claimed === "unknown") return derived;
  if (derived === "unknown") return claimed;
  const d = rank(derived);
  const c = rank(claimed);
  if (d < 0) return derived;
  if (c < 0) return derived;
  return LATTICE[Math.min(d, c)]!;
}

// ---------------------------------------------------------------------------
// Task dispatch envelope (SRD §7.1)
// ---------------------------------------------------------------------------

export const TaskInputSchema = z.object({
  path: shortStr,
  why: text.optional(),
});

export const TaskEnvelopeSchema = z.object({
  schema: z.literal("pifleet.task/v1"),
  task_id: shortStr,
  run_id: shortStr,
  /** Mandatory. v1.1 of the design omitted it and every envelope would have been stale. */
  epoch: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  worker: workerId,
  dispatched_at: z.string().datetime(),
  title: text,
  brief: text,
  repo: shortStr,
  host_workdir: shortStr,
  container_workdir: shortStr,
  branch: shortStr,
  /** Resolved SHA, never a symbolic ref: §8.2 grades against `git diff <base>...HEAD`. */
  base_ref: sha40,
  inputs: z.array(TaskInputSchema).max(MAX_ITEMS).default([]),
  acceptance: z.array(text).max(MAX_ITEMS).default([]),
  constraints: z.array(text).max(MAX_ITEMS).default([]),
  outbox: shortStr,
  /** Normalized mutating-verb prefixes this task may run (SRD §5.10). */
  cloud_allow: z.array(shortStr).max(MAX_ITEMS).default([]),
  deadline_s: z.number().int().positive(),
  depends_on: z.array(shortStr).max(MAX_ITEMS).default([]),
});
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Result envelope (SRD §7.2) — advisory, and untrusted input.
// ---------------------------------------------------------------------------

export const FileChangeSchema = z.object({
  /** Repo-relative. Compared against `git diff --name-status` after both sides normalize. */
  path: shortStr,
  change: z.enum(["added", "modified", "deleted", "renamed"]),
  lines_added: z.number().int().nonnegative().optional(),
  lines_removed: z.number().int().nonnegative().optional(),
});

export const CommandRunSchema = z.object({
  cmd: text,
  exit_code: z.number().int(),
  excerpt: text.optional(),
});

export const AcceptanceClaimSchema = z.object({
  criterion: text,
  met: z.boolean(),
  evidence: text.optional(),
});

export const ArtifactRefSchema = z.object({
  kind: z.enum(["file", "diff", "log", "note"]),
  path: shortStr,
});

export const ResultEnvelopeSchema = z.object({
  schema: z.literal("pifleet.result/v1"),
  task_id: shortStr,
  epoch: z.number().int().nonnegative(),
  worker: workerId,
  status: StatusSchema,
  summary: text.default(""),
  files_changed: z.array(FileChangeSchema).max(MAX_ITEMS).default([]),
  commits: z.array(sha40).max(MAX_ITEMS).default([]),
  branch: shortStr.optional(),
  commands_run: z.array(CommandRunSchema).max(MAX_ITEMS).default([]),
  acceptance: z.array(AcceptanceClaimSchema).max(MAX_ITEMS).default([]),
  artifacts: z.array(ArtifactRefSchema).max(MAX_ITEMS).default([]),
  blockers: z.array(text).max(MAX_ITEMS).default([]),
  notes: text.default(""),
});
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Worker state file (SRD §7.6)
// ---------------------------------------------------------------------------

export const WorkerStateSchema = z.object({
  schema: z.literal("pifleet.state/v1"),
  worker: workerId,
  run_id: shortStr,
  pid: z.number().int().nonnegative(),
  pgid: z.number().int().nonnegative(),
  started_at: z.string(),
  container: z
    .object({ name: shortStr, id: shortStr, image: shortStr })
    .nullable()
    .default(null),
  phase: PhaseSchema,
  epoch: z.number().int().nonnegative(),
  completed_epochs: z.array(z.number().int().nonnegative()).max(MAX_ITEMS).default([]),
  task_id: shortStr.nullable().default(null),
  /**
   * Recorded verbatim from `get_state`. Never computed and never globbed: the
   * timestamp prefix is unknowable in advance and the file is created lazily on
   * the first assistant message (SRD §4.2).
   */
  session_path: shortStr.nullable().default(null),
  session_present: z.boolean().default(false),
  last_event: shortStr.nullable().default(null),
  last_event_at: z.string().nullable().default(null),
  heartbeat_at: z.string().nullable().default(null),
  turns: z.number().int().nonnegative().default(0),
  tool_calls: z.number().int().nonnegative().default(0),
  tool_errors: z.number().int().nonnegative().default(0),
  ui_requests: z
    .object({ answered: z.number().int().nonnegative(), denied: z.number().int().nonnegative() })
    .default({ answered: 0, denied: 0 }),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      /** Always 0 for local models, which have no price table (SRD §5.9). */
      usd: z.number().nonnegative(),
      priced: z.boolean(),
    })
    .default({ input_tokens: 0, output_tokens: 0, usd: 0, priced: false }),
  compactions: z.number().int().nonnegative().default(0),
  retries: z.number().int().nonnegative().default(0),
  /** Distinguishes SIGKILL from a clean exit — Pi exits 0 in every case. */
  exit: z
    .object({ code: z.number().int().nullable(), signal: z.string().nullable() })
    .default({ code: null, signal: null }),
});
export type WorkerState = z.infer<typeof WorkerStateSchema>;

/**
 * Presentation identifiers live beside state, never inside it, so a lost cmux
 * cannot invalidate control-plane state (SRD §7.6).
 */
export const PresentationSchema = z.object({
  schema: z.literal("pifleet.presentation/v1"),
  worker: workerId,
  backend: z.enum(["cmux", "tmux", "headless"]),
  workspace_ref: shortStr.nullable().default(null),
  surface_ref: shortStr.nullable().default(null),
  window_ref: shortStr.nullable().default(null),
});
export type Presentation = z.infer<typeof PresentationSchema>;

// ---------------------------------------------------------------------------
// Ledger (SRD §7.7) — sharded per writer, merged at report time.
// ---------------------------------------------------------------------------

export const LedgerRecordSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  actor: shortStr,
  run_id: shortStr,
  event: shortStr,
  worker: workerId.optional(),
  task_id: shortStr.optional(),
  epoch: z.number().int().nonnegative().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type LedgerRecord = z.infer<typeof LedgerRecordSchema>;

// ---------------------------------------------------------------------------
// Harvested artifact (SRD §8.4) — what `pifleet artifacts --json` returns.
// ---------------------------------------------------------------------------

export const HarvestSchema = z.object({
  schema: z.literal("pifleet.artifacts/v1"),
  task_id: shortStr,
  worker: workerId,
  epoch: z.number().int().nonnegative(),
  verdict: VerdictSchema,
  /** Why the harvester reached that verdict, in order of evidence considered. */
  reasons: z.array(text).max(MAX_ITEMS).default([]),
  claimed: ResultEnvelopeSchema.nullable().default(null),
  derived: z.object({
    branch: shortStr.nullable(),
    base_ref: shortStr.nullable(),
    commits: z.array(sha40).max(MAX_ITEMS).default([]),
    files_changed: z.array(FileChangeSchema).max(MAX_ITEMS).default([]),
    diff: text.nullable().default(null),
    acceptance: z.array(AcceptanceClaimSchema).max(MAX_ITEMS).default([]),
  }),
  /** Claims contradicted by derived facts, e.g. a file the worker did not touch. */
  discrepancies: z.array(text).max(MAX_ITEMS).default([]),
  session_path: shortStr.nullable().default(null),
});
export type Harvest = z.infer<typeof HarvestSchema>;

// ---------------------------------------------------------------------------
// Pi RPC framing (SRD §4.2) — verified against 0.79.6.
// ---------------------------------------------------------------------------

/** A response always carries `data`; v1.1 of the design claimed it did not. */
export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [k: string]: unknown;
}

export type RpcMessage = RpcResponse | RpcEvent;

export function isRpcResponse(m: RpcMessage): m is RpcResponse {
  return (m as RpcResponse).type === "response";
}

/** `agent_end` carries the retry discriminator that makes completion detectable. */
export interface AgentEndEvent extends RpcEvent {
  type: "agent_end";
  willRetry: boolean;
}

/** Shape of `get_state`'s `data` payload, narrowed to the fields completion needs. */
export interface RpcSessionState {
  isStreaming: boolean;
  pendingMessageCount: number;
  sessionFile?: string | null;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Exit codes (SRD §10) — a strict severity ladder; highest severity wins.
// ---------------------------------------------------------------------------

export const EXIT = {
  SUCCESS: 0,
  USAGE: 2,
  BACKEND_UNAVAILABLE: 3,
  TIMEOUT: 4,
  BUDGET: 5,
  WORKER_DIED: 6,
  PARTIAL: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Severity order for `wait --all`, which can legitimately trip several at once. */
const EXIT_SEVERITY: readonly ExitCode[] = [
  EXIT.USAGE,
  EXIT.BACKEND_UNAVAILABLE,
  EXIT.BUDGET,
  EXIT.WORKER_DIED,
  EXIT.TIMEOUT,
  EXIT.PARTIAL,
  EXIT.SUCCESS,
];

/** Highest-severity code among those observed; `SUCCESS` when none were. */
export function worstExit(codes: readonly ExitCode[]): ExitCode {
  for (const c of EXIT_SEVERITY) if (codes.includes(c)) return c;
  return EXIT.SUCCESS;
}
