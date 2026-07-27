/**
 * Fleet configuration schema (SRD §6).
 *
 * Everything a `fleet.yaml` may say is defined here, once, as zod. The schema
 * is strict at every level: an unknown key is a field-level error, not a
 * silently ignored typo — v1.1's worked example could not be produced from its
 * own stated merge rule precisely because nothing checked what the file said.
 *
 * Cross-field rules that survived review live in `superRefine` below so the
 * error still carries a path into the document:
 *
 *  - a worker naming an unknown role (ISC-68);
 *  - a role that claims `read_only: true` while its merged tools include
 *    `bash` (ISC-59) — a "read-only" reviewer that can `cd /` and `git push`
 *    was an actual finding against v1.1's example (SRD §6.2).
 */

import { z } from "zod";
import { workerId } from "../contracts.ts";

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

const DURATION_UNIT_S: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** Parse `25m` / `2h` / `5s` / `500ms` into seconds. Throws on anything else. */
export function parseDuration(raw: string): number {
  const m = DURATION_RE.exec(raw);
  if (!m) throw new Error(`invalid duration: ${JSON.stringify(raw)} (want e.g. "25m", "2h", "5s")`);
  return Number(m[1]) * DURATION_UNIT_S[m[2]!]!;
}

/**
 * A duration in config: `"25m"`-style string, or a bare number of seconds.
 * Always transformed to seconds so no consumer re-parses units.
 */
export const durationSeconds = z.union([
  z.number().nonnegative(),
  z.string().regex(DURATION_RE, 'invalid duration (want e.g. "25m", "2h", "5s")'),
]).transform((v) => (typeof v === "number" ? v : parseDuration(v)));

// ---------------------------------------------------------------------------
// Vocabularies pinned to Pi 0.79.6 (SRD §4.2)
// ---------------------------------------------------------------------------

/**
 * Built-in Pi tools, exactly. There is no `web_fetch` — v1.1's researcher role
 * requested it and was silently granted nothing, because Pi's `--tools` does no
 * validation (SRD §4.2). Making the tool list an enum moves that silence into a
 * loud schema error.
 */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const ToolNameSchema = z.enum(PI_BUILTIN_TOOLS);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const ToolchainSchema = z.enum(["base", "node", "python", "go", "full"]);
export type Toolchain = z.infer<typeof ToolchainSchema>;

export const IsolationSchema = z.enum(["worktree", "shared-ro", "none"]);
export type Isolation = z.infer<typeof IsolationSchema>;

const shortStr = z.string().min(1).max(4096);

// ---------------------------------------------------------------------------
// Role-level fields — shared by `defaults`, `roles.*`, and worker overrides
// ---------------------------------------------------------------------------

/**
 * Every key a role may set. `defaults` and per-worker overrides use the same
 * shape, so the merge (SRD §6.1) is a spread over one vocabulary rather than
 * three near-identical ones drifting apart.
 */
export const RoleFieldsSchema = z
  .object({
    /** May carry a `provider/` prefix and a `:thinking` suffix — see §6.1 rule 2. */
    model: z.string().min(1).max(256).optional(),
    thinking: ThinkingLevelSchema.optional(),
    toolchain: ToolchainSchema.optional(),
    tools: z.array(ToolNameSchema).max(16).optional(),
    exclude_tools: z.array(ToolNameSchema).max(16).optional(),
    /** Skill names; `pifleet-worker` is re-injected post-merge (§6.1 rule 1). */
    skills: z.array(shortStr).max(64).optional(),
    cloud_access: z.boolean().optional(),
    isolation: IsolationSchema.optional(),
    pane_mode: z.enum(["rpc", "tui"]).optional(),
    kind: z.enum(["persistent", "oneshot"]).optional(),
    /**
     * Accepted for §6.2 compatibility, but the renderer passes
     * `--no-context-files` unconditionally: repo AGENTS.md/CLAUDE.md is
     * untrusted input (SRD §12.2) and a config key must not reopen that door.
     */
    no_context_files: z.boolean().optional(),
    /** Declares intent; enforced against `tools` in `superRefine` (ISC-59). */
    read_only: z.boolean().optional(),
    /** Briefing fragment on disk, relative to the config file's directory. */
    append_system_prompt_file: shortStr.optional(),
    /** Inline briefing fragment. Fragments concatenate; the flag does not repeat. */
    append_system_prompt: z.string().min(1).max(65536).optional(),
  })
  .strict();
export type RoleFields = z.infer<typeof RoleFieldsSchema>;

export const WorkerEntrySchema = RoleFieldsSchema.extend({
  id: workerId,
  role: shortStr,
}).strict();
export type WorkerEntry = z.infer<typeof WorkerEntrySchema>;

// ---------------------------------------------------------------------------
// Top-level sections
// ---------------------------------------------------------------------------

export const BackendSchema = z
  .object({
    kind: z.enum(["cmux", "tmux", "headless"]).default("cmux"),
    workspace: shortStr.default("pifleet"),
    split: z.enum(["alternate", "columns", "rows"]).default("alternate"),
    focus_on_dispatch: z.boolean().default(false),
  })
  .strict()
  .prefault({});

export const DockerSchema = z
  .object({
    image_prefix: shortStr.default("pifleet/pi-worker"),
    /** Pinned; §4.2's protocol contract is version-specific. */
    pi_version: z.string().regex(/^\d+\.\d+\.\d+$/, "pi_version must be an exact semver pin"),
    network: shortStr.default("pifleet-egress"),
    memory: z.string().regex(/^\d+[kmg]?$/i).default("4g"),
    cpus: z.number().positive().default(2),
    pids_limit: z.number().int().positive().default(512),
    read_only_root: z.boolean().default(true),
    /** Extra OS packages appended as a final image layer (SRD §5.3). */
    apt_packages: z.array(shortStr).max(64).default([]),
  })
  .strict();

export const BudgetSchema = z
  .object({
    /** THE ceiling — local models have no price table, so there is no usd one (§5.9). */
    tokens_ceiling: z.number().int().positive(),
    per_task_reserve_tokens: z.number().int().positive().optional(),
    soft_stop_at: z.number().min(0).max(1).default(0.8),
    per_task_timeout: durationSeconds.prefault("25m"),
    run_timeout: durationSeconds.prefault("2h"),
  })
  .strict();

export const TimersSchema = z
  .object({
    ui_request_timeout: durationSeconds.prefault("5s"),
    event_stall_warn: durationSeconds.prefault("3m"),
    event_stall_kill: durationSeconds.prefault("25m"),
    heartbeat_interval: durationSeconds.prefault("5s"),
  })
  .strict()
  .prefault({});

export const RunSchema = z
  .object({
    root: shortStr.default("~/.pifleet/runs"),
    repo: shortStr,
    isolation: IsolationSchema.default("worktree"),
    branch_prefix: shortStr.default("fleet"),
    /** Bounded by measured oMLX throughput, not pane count (SRD §5.9 / F40). */
    max_concurrent: z.number().int().positive().default(2),
    budget: BudgetSchema,
    timers: TimersSchema,
  })
  .strict();

export const LlmSchema = z
  .object({
    /** Always local oMLX on the Docker host — a constraint, not a default (§5.9). */
    provider: shortStr.default("omlx"),
    base_url: z.string().url().default("http://host.docker.internal:8000/v1"),
    /** Names the env var; the value never appears in config (SRD §12.4). */
    api_key_env: shortStr.default("OMLX_API_KEY"),
    model: z.string().min(1).max(256),
    thinking: ThinkingLevelSchema.optional(),
    models_allowlist: z.array(shortStr).max(64).default([]),
    require_native_tool_calls: z.boolean().default(true),
  })
  .strict();

export const CloudSchema = z
  .object({
    adc: z.boolean().default(false),
    /** `token` is the deliberate default: a 1h token, not a refresh token (§5.8). */
    adc_mode: z.enum(["token", "file"]).default("token"),
    quota_project: shortStr.nullable().default(null),
    impersonate_service_account: shortStr.nullable().default(null),
    /** A FILTERED kubeconfig copy; never the host default (§5.5). */
    kubeconfig: shortStr.nullable().default(null),
    token_refresh: durationSeconds.prefault("45m"),
  })
  .strict()
  .prefault({});

export const SecretsSchema = z
  .object({
    /** NEVER provider keys — see SRD §12.4. */
    env_allowlist: z.array(shortStr).max(64).default([]),
  })
  .strict()
  .prefault({});

// ---------------------------------------------------------------------------
// The whole document
// ---------------------------------------------------------------------------

export const FleetConfigSchema = z
  .object({
    version: z.literal(2),
    name: shortStr,
    backend: BackendSchema,
    docker: DockerSchema,
    run: RunSchema,
    llm: LlmSchema,
    cloud: CloudSchema,
    secrets: SecretsSchema,
    defaults: RoleFieldsSchema.prefault({}),
    roles: z.record(shortStr, RoleFieldsSchema),
    workers: z.array(WorkerEntrySchema).min(1).max(64),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // ISC-68: a worker naming an unknown role fails with a named, pathed error.
    cfg.workers.forEach((w, i) => {
      if (!(w.role in cfg.roles)) {
        ctx.addIssue({
          code: "custom",
          path: ["workers", i, "role"],
          message: `unknown role "${w.role}" — defined roles: ${Object.keys(cfg.roles).join(", ")}`,
        });
      }
    });

    // Duplicate worker ids would collide on container names and session ids.
    const seen = new Set<string>();
    cfg.workers.forEach((w, i) => {
      if (seen.has(w.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["workers", i, "id"],
          message: `duplicate worker id "${w.id}"`,
        });
      }
      seen.add(w.id);
    });

    // ISC-59: `read_only: true` combined with `bash` in the MERGED tool set.
    // Checked at the level that completes the combination, so the error points
    // at the document position a human would edit.
    const defaultTools = cfg.defaults.tools;
    for (const [name, role] of Object.entries(cfg.roles)) {
      const readOnly = role.read_only ?? cfg.defaults.read_only ?? false;
      const tools = role.tools ?? defaultTools;
      if (readOnly && tools?.includes("bash")) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", name, "tools"],
          message: `role "${name}" is read_only: true but its tools include "bash" — a shell can write; drop one`,
        });
      }
    }
    cfg.workers.forEach((w, i) => {
      const role = cfg.roles[w.role];
      if (!role) return; // already reported above
      const readOnly = w.read_only ?? role.read_only ?? cfg.defaults.read_only ?? false;
      const tools = w.tools ?? role.tools ?? defaultTools;
      if (readOnly && tools?.includes("bash")) {
        ctx.addIssue({
          code: "custom",
          path: ["workers", i, "tools"],
          message: `worker "${w.id}" resolves to read_only: true with "bash" in its tools — a shell can write; drop one`,
        });
      }
    });
  });

export type FleetConfig = z.infer<typeof FleetConfigSchema>;
