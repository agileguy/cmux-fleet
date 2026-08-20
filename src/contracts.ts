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
  /**
   * The supervisor's LAUNCH-TIME process identity, in the pinned `utc1 …`
   * rendering `registry.ts` produces (`IDENTITY_FORMAT`).
   *
   * Distinct from `started_at`, and the distinction is the whole point:
   * `started_at` is `new Date().toISOString()`, a wall-clock stamp of when the
   * supervisor got around to writing its state, which is not comparable to
   * `ps -o lstart=` and never could anchor an identity check.
   *
   * It exists because registry registration is deliberately BEST-EFFORT
   * (`supervisor/index.ts`: "The supervisor must also work alone (integration
   * tests, daemon crash)"). Anchoring `down` solely on the registry therefore
   * made every daemon-less run unstoppable — the kill ladder refused
   * `identity_unrecorded` for a supervisor whose identity was known at launch
   * and simply had nowhere daemon-independent to live. This field is that
   * place: written once by the process it describes, from the same value the
   * registry call carries.
   *
   * Empty string means "not recorded" — a state file written by a build
   * before this field existed. It is NOT a weak anchor: `isPinnedIdentity("")`
   * is false, so `down` refuses exactly as it does for an absent registry
   * entry. Fail-closed is preserved; what changes is how often the closed case
   * is reached for a run whose identity was never actually in doubt.
   */
  proc_started: z.string().default(""),
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
 * The launch record: how this worker's process is started (SRD §5.6).
 *
 * Written once by `materializeWorkerInputs` and read by the supervisor, which
 * runs `argv` VERBATIM. That word is the contract and it is load-bearing: the
 * rendered argv already ends with a complete Pi flag list built for CONTAINER
 * paths (`--mode rpc --session-dir /sessions --session-id <id>`, from
 * `buildPiArgv`), while the `PIFLEET_PI_COMMAND` path appends the same three
 * flags with HOST paths. Appending the host spelling to a container argv would
 * not fail — `pi` would take the last `--session-dir` and write sessions to a
 * path that does not exist inside the container, and the run would look alive
 * while harvesting nothing. So the supervisor appends to one and not the
 * other, and the presence of this record is what tells it which.
 */
export const WorkerLaunchSchema = z
  .object({
    /**
     * `container` today. Named rather than implied by argv[0] so a future
     * launch mode is a new value here, not a string comparison against
     * `"docker"` scattered across the supervisor and `down`.
     */
    kind: z.literal("container"),
    /** The complete command line. The supervisor adds nothing to it. */
    argv: z.array(z.string()).min(1).max(MAX_ITEMS),
    /** `--name` — how `down` finds the container without parsing argv. */
    container: shortStr,
    image: shortStr,
  })
  .strict();

export type WorkerLaunch = z.infer<typeof WorkerLaunchSchema>;

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
  /**
   * sha256 over the canonical form of the fact bundle the verdict was reached
   * from (ISC-153) — the replay key.
   *
   * "Hashed AND RECORDED" is the criterion; the hash was being computed and
   * dropped on the floor, which satisfies neither half of what it is for. An
   * operator disputing a verdict needs to know whether the facts have since
   * changed, and a verdict whose evidence cannot be identified is not
   * reviewable. Nullable because a task with no dispatch record has no facts
   * to hash.
   */
  facts_hash: shortStr.nullable().default(null),
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
  // Defensive against a null/scalar record: the caller is a stream reader and
  // a dereference here escapes as an unhandled rejection rather than a
  // protocol error. The type says this cannot happen; the wire disagrees.
  return typeof m === "object" && m !== null && (m as RpcResponse).type === "response";
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
  /**
   * A failure pifleet could not diagnose — a bug in pifleet itself.
   *
   * Not in the SRD §10 ladder, and deliberately outside it: every code above
   * describes something that happened to the RUN, and this one describes the
   * tool breaking. The entry point used to report it as `USAGE`, which made a
   * crash indistinguishable from a typo'd flag over the only channel a machine
   * caller has — so an orchestrator would answer it by rewriting its arguments
   * and trying again, forever (ISC-216).
   */
  INTERNAL: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Any error carrying a numeric `exitCode` is a *diagnosed* failure: the CLI
 * prints its message and exits with that code, rather than letting a stack
 * trace reach the user.
 *
 * This is a structural protocol rather than a base class on purpose. A missing
 * config file threw a `ConfigError` the entry point's catch did not recognise,
 * so a one-character typo in a path produced a TypeScript stack trace and exit
 * 1 instead of a one-line message and exit 2. Any module can opt in without
 * importing the CLI, and a module that forgets is the only thing that regresses.
 */
export interface ExitCoded {
  readonly exitCode: ExitCode;
  readonly message: string;
}

export function isExitCoded(e: unknown): e is ExitCoded {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as ExitCoded).exitCode === "number" &&
    typeof (e as ExitCoded).message === "string"
  );
}

/** Severity order for `wait --all`, which can legitimately trip several at once. */
const EXIT_SEVERITY: readonly ExitCode[] = [
  // Above the §10 ladder: if pifleet itself broke, nothing it reports about
  // the run is trustworthy enough to outrank that.
  EXIT.INTERNAL,
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

// ---------------------------------------------------------------------------
// Acceptance execution (SRD §8.2; ISC-148..152)
// ---------------------------------------------------------------------------

/**
 * One acceptance command, as RESOLVED — not as the worker reported it.
 *
 * The distinction is the whole point. §8.2 makes the repository authoritative
 * "and the exit codes of acceptance commands *the harvester re-runs itself*".
 * A worker that can edit the file the commands are read from can otherwise
 * write its own exam, so `source` records where the text came from and
 * `resolved_from` pins the SHA it was read at (ISC-148).
 */
export const AcceptanceRunSchema = z.object({
  cmd: text,
  /** The envelope's `acceptance[]` is authored at dispatch; `tree` is read from the repo. */
  source: z.enum(["envelope", "tree"]),
  /** SHA the command text was resolved from. Never the worker's HEAD (ISC-148). */
  resolved_from: sha40,
  /**
   * `timed_out` is NOT `failed` (ISC-152). A command that ran out of wall clock
   * proves nothing about the code; collapsing it into failure invents evidence.
   */
  outcome: z.enum(["passed", "failed", "timed_out", "not_run"]),
  exit_code: z.number().int().nullable().default(null),
  duration_ms: z.number().int().nonnegative().default(0),
  excerpt: text.default(""),
});
export type AcceptanceRun = z.infer<typeof AcceptanceRunSchema>;

/**
 * Where the acceptance commands actually executed.
 *
 * ISC-149 requires a fresh clone by SHA, outside the worker's worktree, with no
 * inherited environment — so that a worker cannot pre-seed a node_modules, a
 * cache, or an env var that makes a red suite green. Recording the clone path
 * and the env-inheritance flag makes that auditable after the fact rather than
 * a property of code nobody re-reads.
 */
export const AcceptanceContextSchema = z.object({
  clone_path: shortStr,
  clone_sha: sha40,
  inherited_env: z.boolean(),
  image: shortStr.nullable().default(null),
  timeout_s: z.number().int().positive(),
});
export type AcceptanceContext = z.infer<typeof AcceptanceContextSchema>;

/**
 * Files whose modification makes the acceptance result self-certified.
 *
 * ISC-150: a diff touching the test-harness surface caps the verdict at
 * `blocked`/`unknown` and can NEVER yield `success` — a worker that edits the
 * test that grades it has produced an unfalsifiable claim, and the correct
 * response is to refuse to grade rather than to trust or to fail.
 */
export const HarnessSurfaceSchema = z.object({
  /** Repo-relative globs, from config; the defaults live in the config schema. */
  patterns: z.array(shortStr).max(MAX_ITEMS).default([]),
  /** Which of the worker's changed files matched. Empty means the cap did not fire. */
  touched: z.array(shortStr).max(MAX_ITEMS).default([]),
  /**
   * Files `DEFAULT_HARNESS_PATTERNS` would have caught that the CONFIGURED
   * `patterns` did not — recorded only when that difference switched the
   * ISC-150 cap off, i.e. when `touched` is empty and the defaults' surface
   * was not (ISC-232).
   *
   * The narrow condition is the whole point. Config REPLACES the defaults, so
   * any `patterns` list that happens to match nothing in a given diff disables
   * the cap for that diff — and the dangerous shape is not a hostile
   * `patterns: []` (the schema already refuses that) but an ordinary, honest
   * `patterns: ["ci/**"]` written by an operator who only cared about CI
   * files and did not realize it cost them all ~91 built-in globs. `Bun.Glob`
   * accepts malformed patterns and simply matches nothing, so a typo is
   * indistinguishable from a deliberate narrowing by any check on the list
   * itself; only comparing the two SURFACES over a real diff tells them apart.
   *
   * Empty when config narrowed nothing away, when the cap fired anyway
   * (`touched` non-empty — the verdict is capped either way, so the
   * difference is not load-bearing), or when no config was in play at all.
   */
  defaults_missed: z.array(shortStr).max(MAX_ITEMS).default([]),
});
export type HarnessSurface = z.infer<typeof HarnessSurfaceSchema>;

// ---------------------------------------------------------------------------
// Derived-fact bundle (ISC-153) — an adjudication that can be replayed.
// ---------------------------------------------------------------------------

/**
 * Everything the adjudicator was allowed to look at, plus a hash of it.
 *
 * A verdict is only trustworthy if you can re-derive it. The hash covers the
 * canonical JSON of the facts — NOT the verdict — so a replay that produces a
 * different verdict from the same hash is a bug in the adjudicator, and a
 * replay whose hash differs is a bug in the harvester. Those are different
 * failures and the bundle is what tells them apart.
 */
export const DerivedFactsSchema = z.object({
  branch: shortStr.nullable(),
  base_ref: sha40.nullable(),
  head_ref: sha40.nullable(),
  /** ISC-151: false when `git merge-base --is-ancestor base HEAD` failed. */
  base_is_ancestor: z.boolean(),
  commits: z.array(sha40).max(MAX_ITEMS).default([]),
  files_changed: z.array(FileChangeSchema).max(MAX_ITEMS).default([]),
  diff_bytes: z.number().int().nonnegative().default(0),
  acceptance: z.array(AcceptanceRunSchema).max(MAX_ITEMS).default([]),
  acceptance_context: AcceptanceContextSchema.nullable().default(null),
  harness: HarnessSurfaceSchema,
  /**
   * ISC-154: the worktree hash at quiesce and at harvest end. Differing values
   * mean something kept writing after the worker was supposed to be done, so
   * every fact above may describe a tree that no longer exists → `unknown`.
   */
  tree_hash_quiesce: shortStr.nullable().default(null),
  tree_hash_harvest: shortStr.nullable().default(null),
});
export type DerivedFacts = z.infer<typeof DerivedFactsSchema>;

/** Stable-key JSON, so the bundle hash does not depend on property order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const body = Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",");
  return `{${body}}`;
}

// ---------------------------------------------------------------------------
// Harvest status (SRD §8.4)
// ---------------------------------------------------------------------------

/**
 * Whether the harvest itself is trustworthy — orthogonal to the verdict.
 *
 * §8.4: `artifacts` is a pure read that "exits 0 whenever it emitted valid
 * JSON". A machine consumer must never distinguish "no artifacts" from "tool
 * broke" by exit code, so the distinction has to live in the payload.
 */
export const HarvestStatusSchema = z.enum(["complete", "partial", "unavailable"]);
export type HarvestStatus = z.infer<typeof HarvestStatusSchema>;

// ---------------------------------------------------------------------------
// Budget (ISC-114, ISC-115, ISC-193)
// ---------------------------------------------------------------------------

/**
 * A token/cost ceiling and the reservation held against it.
 *
 * ISC-115 is the load-bearing one: the ceiling must halt a run whose reported
 * cost is 0 throughout, because local models have no price table (SRD §5.9).
 * Budgeting on dollars alone therefore never trips locally — tokens are the
 * primary axis and `usd` is advisory.
 *
 * `reserved` exists because dispatch and accounting are not simultaneous: a
 * task admitted at 99% of the ceiling would otherwise be allowed to run to
 * completion and blow through it. Admission subtracts a reservation up front
 * and reconciles against actuals when the task settles.
 */
export const BudgetStateSchema = z.object({
  schema: z.literal("pifleet.budget/v1"),
  run_id: shortStr,
  tokens_ceiling: z.number().int().nonnegative().nullable().default(null),
  usd_ceiling: z.number().nonnegative().nullable().default(null),
  tokens_spent: z.number().int().nonnegative().default(0),
  usd_spent: z.number().nonnegative().default(0),
  /** Per-task up-front holds, keyed by task id; released on settle. */
  reserved: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Set once, when a ceiling is first crossed. Dispatch refuses from here on. */
  halted_at: z.string().nullable().default(null),
  halted_reason: shortStr.nullable().default(null),
});
export type BudgetState = z.infer<typeof BudgetStateSchema>;

/** Why admission refused. `ok` carries the reservation the caller now holds. */
export type AdmissionDecision =
  | { ok: true; reserved: number }
  | { ok: false; reason: "budget_halted" | "would_exceed" | "max_concurrent"; detail: string };

// ---------------------------------------------------------------------------
// Process identity (ISC-191) — the kill ladder's unit.
// ---------------------------------------------------------------------------

/**
 * A pid plus the start time that disambiguates it.
 *
 * A pid alone is not an identity: pids are reused, and a kill ladder that
 * escalates on a pid it has not re-validated will eventually SIGKILL an
 * innocent process that inherited the number. `started` is read from the OS at
 * the same instant the pid is, and every rung of the ladder re-checks the pair.
 */
export const ProcIdSchema = z.object({
  pid: z.number().int().positive(),
  /** Opaque, platform-specific, compared only for equality. */
  started: shortStr,
});
export type ProcId = z.infer<typeof ProcIdSchema>;

export function sameProc(a: ProcId | null, b: ProcId | null): boolean {
  return a !== null && b !== null && a.pid === b.pid && a.started === b.started;
}

// ---------------------------------------------------------------------------
// Phase 3 seam — security and cloud identity (SRD §5.8, §5.10, §12)
//
// Written before the phase's engineers are dispatched and READ-ONLY to them.
// Four subsystems meet here — credential injection, egress policy, hostile-repo
// neutralization and control-socket auth — and a type that two of them each
// define locally is how a phase ends up with two incompatible halves that both
// pass their own tests.
// ---------------------------------------------------------------------------

/**
 * How a container is given Google identity (§5.8).
 *
 * `token` is the default and the safe one: a ~1h ACCESS token, which expires
 * on its own. `file` writes credentials the container can read, and a
 * credentials file that contains a `refresh_token` is a permanent grant — the
 * container could mint new access tokens forever, long after the run ended,
 * and the blast radius of one escaped worker stops being time-boxed.
 *
 * The mode therefore appears in the injected record, so a probe can assert
 * which one was actually used rather than which one was configured.
 */
export const AdcModeSchema = z.enum(["token", "file"]);
export type AdcMode = z.infer<typeof AdcModeSchema>;

/**
 * One credential injection into a running container.
 *
 * `expires_at` is a wall-clock LABEL from the issuer, not a timer: it is what
 * Google said, and the refresh loop's own scheduling runs on the monotonic
 * clock (ISC-155). Recording both lets a probe answer "was this refreshed
 * before it expired" without either clock being asked to do the other's job.
 *
 * The token VALUE is deliberately absent. This record is written to the run
 * directory and read by `status` and `report`, and a credential that lands in
 * a durable artifact has escaped the container it was scoped to.
 */
export const CredentialInjectionSchema = z.object({
  schema: z.literal("pifleet.credential/v1"),
  worker: workerId,
  mode: AdcModeSchema,
  /** Identity the token actually carries — the SA when impersonating (§5.8). */
  identity: shortStr,
  /** Issuer's expiry label. Never subtracted from a local clock to decide. */
  expires_at: z.string(),
  injected_at: z.string(),
  /** Monotonic ms at injection; the refresh loop schedules from this. */
  injected_mono: z.number().nonnegative(),
  /** Which refresh this was; 0 is the initial injection. */
  generation: z.number().int().nonnegative().default(0),
  /** True only when the injected material provably carries no refresh_token. */
  refresh_token_absent: z.boolean(),
});
export type CredentialInjection = z.infer<typeof CredentialInjectionSchema>;

/**
 * Egress verdict for one destination (§12, deny-all default).
 *
 * `reason` carries the matched rule so a refusal is diagnosable — "denied" on
 * its own sends an operator to read the policy source to learn what happened,
 * which is the moment they start disabling the policy to make progress.
 */
export const EgressDecisionSchema = z.object({
  allowed: z.boolean(),
  host: shortStr,
  port: z.number().int().positive(),
  /** The rule that decided, or `default-deny` when nothing matched. */
  rule: shortStr,
});
export type EgressDecision = z.infer<typeof EgressDecisionSchema>;

/**
 * A repository artifact that would change what the agent does, found and
 * neutralized (§12.2).
 *
 * A hostile repo does not need an exploit: `.pi/extensions/` and `AGENTS.md`
 * are read by the agent as INSTRUCTIONS, so a checkout can rewrite the
 * behaviour of the thing grading it. `neutralized` and `detected` are separate
 * booleans because "we saw it and left it" and "we saw it and defused it" are
 * different security postures and must not both read as handled.
 */
export const RepoHazardSchema = z.object({
  /** Repo-relative path of the hazard. */
  path: shortStr,
  kind: z.enum(["pi_extension", "agents_md", "hooks_path", "mcp_config", "other"]),
  /**
   * Always `true`, and a literal rather than a defaulted boolean so the type
   * says so. A `RepoHazard` exists BECAUSE something was found; `detected:
   * false` describes a record that should not have been created, and
   * `z.boolean().default(true)` accepted exactly that — `parse({detected:
   * false, …})` returned `false` and the field read as an invariant while
   * behaving as a suggestion. The pairing that carries meaning is
   * detected-and-not-neutralized ("we saw it and left it live"), which
   * `neutralized` alone expresses.
   */
  detected: z.literal(true).default(true),
  neutralized: z.boolean(),
  detail: text.default(""),
});
export type RepoHazard = z.infer<typeof RepoHazardSchema>;

/**
 * Control-socket authentication (§12).
 *
 * The socket is filesystem-permission protected today, which is sufficient
 * against another user and insufficient against another PROCESS of the same
 * user — including a worker that escaped its container. A per-run secret makes
 * the caller prove it was told, rather than prove it can reach.
 *
 * Compared with a timing-safe equality, and never logged: an auth token in the
 * supervisor log is the same failure as the credential above.
 */
export const ControlAuthSchema = z.object({
  schema: z.literal("pifleet.controlauth/v1"),
  run_id: shortStr,
  /** 256-bit, hex. Generated per run, never derived from the run id. */
  secret: z.string().regex(/^[0-9a-f]{64}$/, "control secret must be 64 hex chars"),
  created_at: z.string(),
});
export type ControlAuth = z.infer<typeof ControlAuthSchema>;

// ---------------------------------------------------------------------------
// Orchestration (SRD §14) — the Phase 5 seam.
//
// Three schemas, written before any Phase 5 work is dispatched, because the
// scheduler and the reporter are built against each other: the scheduler
// decides what ran and in what order, and the reporter has to describe that
// decision to an operator who was not watching. An interface neither owns is
// how a phase produces two halves that do not meet.
// ---------------------------------------------------------------------------

/**
 * A task as an operator AUTHORS it, before the run exists.
 *
 * Deliberately not a `TaskEnvelope`: an envelope carries `run_id`, `epoch`,
 * `attempt`, `worker`, `dispatched_at` and a resolved `base_ref`, none of
 * which an author can know — they are facts the scheduler produces at
 * dispatch time. Conflating the two would force whoever writes a task list to
 * invent an epoch, which is exactly the kind of field that then goes stale
 * and fences a live worker out of its own run.
 *
 * `id` is task-list-local. It is what `depends_on` names, and the scheduler
 * maps it to a `task_id` when it builds the envelope.
 */
export const TaskSpecSchema = z.object({
  id: shortStr,
  title: text,
  brief: text,
  /** Task-list-local ids, NOT `task_id`s: nothing has been dispatched yet. */
  depends_on: z.array(shortStr).max(MAX_ITEMS).default([]),
  /** Which briefing the worker runs under; `null` means the fleet default. */
  role: z.enum(["sre", "investigator", "verifier"]).nullable().default(null),
  /** Pin to one worker. Null lets the scheduler choose any idle worker. */
  worker: workerId.nullable().default(null),
  acceptance: z.array(text).max(MAX_ITEMS).default([]),
  constraints: z.array(text).max(MAX_ITEMS).default([]),
  inputs: z.array(TaskInputSchema).max(MAX_ITEMS).default([]),
  cloud_allow: z.array(shortStr).max(MAX_ITEMS).default([]),
  deadline_s: z.number().int().positive().default(1800),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const TaskListSchema = z.object({
  schema: z.literal("pifleet.tasklist/v1"),
  tasks: z.array(TaskSpecSchema).max(MAX_ITEMS),
});
export type TaskList = z.infer<typeof TaskListSchema>;

/**
 * Why a task is not running yet.
 *
 * A scheduler that only reports "pending" makes a stalled fleet unreadable:
 * an operator cannot tell a task waiting on a dependency from one waiting on
 * a free worker from one that will never run because a dependency failed.
 * `blocked` is terminal, `waiting` and `ready` are not.
 */
export const TaskSchedStateSchema = z.enum([
  "waiting", // a dependency has not finished
  "ready", // dependencies met, no idle worker yet
  "dispatched",
  "done",
  "blocked", // a dependency failed; this task will never be dispatched
]);
export type TaskSchedState = z.infer<typeof TaskSchedStateSchema>;

/**
 * One task's place in the schedule, as `dispatch --auto` and `report` both
 * see it. `blocked_by` names the dependency that failed, so the operator gets
 * the cause rather than a cascade of identical "blocked" lines.
 */
export const ScheduledTaskSchema = z.object({
  id: shortStr,
  state: TaskSchedStateSchema,
  worker: workerId.nullable().default(null),
  task_id: shortStr.nullable().default(null),
  depends_on: z.array(shortStr).max(MAX_ITEMS).default([]),
  blocked_by: shortStr.nullable().default(null),
  verdict: VerdictSchema.nullable().default(null),
});
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

/**
 * Whether one worker's branch can be merged, checked WITHOUT merging.
 *
 * `conflicts_with` carries sibling worker ids rather than file names alone,
 * because the operator's next action is a conversation with whoever owns the
 * other branch — or a decision about which to land first. A pre-check that
 * says only "conflict" sends them to re-derive that by hand.
 *
 * `clean: true` is a statement about the merge-base at the time of the check
 * and nothing more. It must never be read as "merged" — the same distinction
 * `down` got wrong when it printed `clean: true` over a leaked session.
 */
export const MergePrecheckSchema = z.object({
  worker: workerId,
  branch: shortStr,
  base_ref: sha40,
  clean: z.boolean(),
  conflicts_with: z.array(workerId).max(MAX_ITEMS).default([]),
  conflicting_paths: z.array(shortStr).max(MAX_ITEMS).default([]),
  detail: text.default(""),
});
export type MergePrecheck = z.infer<typeof MergePrecheckSchema>;

/**
 * `pifleet report` (SRD §10, §14.2): the whole run, for someone who was not
 * watching it.
 *
 * Derived facts only. Every field here is computed from the ledger, the
 * harvest records and git — never from a worker's self-report, which §8.2
 * treats as untrusted input that may downgrade a verdict but never upgrade
 * one.
 */
export const RunReportSchema = z.object({
  schema: z.literal("pifleet.report/v1"),
  run_id: shortStr,
  generated_at: z.string(),
  schedule: z.array(ScheduledTaskSchema).max(MAX_ITEMS).default([]),
  merge: z.array(MergePrecheckSchema).max(MAX_ITEMS).default([]),
  /** Counts by verdict, so a caller need not re-derive them from `schedule`. */
  totals: z
    .object({
      tasks: z.number().int().nonnegative().default(0),
      done: z.number().int().nonnegative().default(0),
      blocked: z.number().int().nonnegative().default(0),
      failed: z.number().int().nonnegative().default(0),
    })
    .default({ tasks: 0, done: 0, blocked: 0, failed: 0 }),
});
export type RunReport = z.infer<typeof RunReportSchema>;

// ---------------------------------------------------------------------------
// Attended mode (SRD §13, §16 Phase 6) — the Phase 6 seam.
//
// One table, written before any Phase 6 work is dispatched, because the two
// halves of attended mode disagree about it otherwise: the pane that puts a
// human in the loop and the report that has to describe what a run means
// afterwards must name the SAME set of voided guarantees.
// ---------------------------------------------------------------------------

/**
 * How a worker's pane is being driven.
 *
 * `viewer` is the default and the only mode the rest of this system reasons
 * about: the pane is a read-only follower and every control-plane guarantee
 * holds. `tui` hands the pane to a person, which is useful and which quietly
 * invalidates several of those guarantees — so the mode is recorded rather
 * than inferred, and `report` says which one a run was in.
 */
export const PaneModeSchema = z.enum(["viewer", "tui"]);
export type PaneMode = z.infer<typeof PaneModeSchema>;

/**
 * A guarantee that does NOT hold once a human is typing into the pane.
 *
 * This exists because the honest failure of an attended mode is silent: the
 * run still produces a result envelope, a verdict and a diff, and none of
 * them mean quite what they mean unattended. Enumerating the voided
 * requirements makes that difference readable instead of folklore — the
 * operator gets told, in the report, which claims to stop trusting.
 *
 * `voided` is deliberately a criterion ID plus prose. An ID alone would rot
 * silently when a criterion is renumbered; prose alone could not be checked
 * against the ISA.
 */
export const VoidedRequirementSchema = z.object({
  /** The ISC this attended session stops guaranteeing, e.g. "ISC-87". */
  isc: z.string().regex(/^ISC-\d+(\.\d+)?$/, "voided requirement must name an ISC"),
  /** What no longer holds, in one sentence an operator can act on. */
  because: text,
});
export type VoidedRequirement = z.infer<typeof VoidedRequirementSchema>;

/**
 * The record that a worker was, at some point, driven by hand.
 *
 * Written once when a pane enters `tui` and never removed, because the point
 * is that the RUN is affected, not the current state: a worker returned to
 * `viewer` mode after a human intervened still produced work a human touched.
 * A flag that cleared itself would let an attended run present as unattended.
 */
export const AttendedRecordSchema = z.object({
  schema: z.literal("pifleet.attended/v1"),
  worker: workerId,
  mode: PaneModeSchema,
  entered_at: z.string(),
  /** Null until the operator hands the pane back. */
  left_at: z.string().nullable().default(null),
  voided: z.array(VoidedRequirementSchema).max(MAX_ITEMS).default([]),
});
export type AttendedRecord = z.infer<typeof AttendedRecordSchema>;
