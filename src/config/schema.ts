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
import { MAX_ITEMS, SESSION_ID_RE, workerId } from "../contracts.ts";
import { ruleHostError } from "../security/egress.ts";
import { relayUpstreamError } from "../security/relay.ts";

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
    /**
     * OPTIONAL, not defaulted, and that is load-bearing (ISC-271).
     *
     * `up`'s precedence is `explicit --backend > backend.kind > DEFAULT_BACKEND`,
     * and the middle term can only exist if an ABSENT block is distinguishable
     * from a block that says `cmux`. With `.default("cmux")` these three parse
     * to byte-identical objects, all carrying `kind: "cmux"`:
     *
     *     (no backend: block at all)
     *     backend: {}
     *     backend: {kind: cmux}
     *
     * Consuming that would not honour the configs that SET `kind` — it would
     * force cmux onto every `fleet.yaml` in existence, including the ones that
     * say nothing, turning every run on a cmux-less host into exit 3. An absent
     * block means UNSET; inferring cmux from it relocates the silent-override
     * defect rather than removing it.
     */
    kind: z.enum(["cmux", "tmux", "headless"]).optional(),
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
    /*
     * `soft_stop_at` was REMOVED here, deliberately — see ISC-280.
     *
     * It was the last key in this block still in the shape `max_concurrent`
     * was in before ISC-235: it shipped in `fleet.example.yaml`, it validated,
     * and it was read by nothing. The criterion was a disjunction — give it a
     * production reader, or delete it from the schema and the example config
     * together — and deleting is the arm that was taken, because what a soft
     * stop DOES (refuse new admissions, warn once, warn per admission, shrink
     * `max_concurrent`) is a product decision, and inventing one to close a
     * criterion buys a reader that does the wrong thing INVISIBLY. That is
     * strictly worse than no reader.
     *
     * This schema is `.strict()`, so an existing config carrying the key is
     * now a hard validation error rather than a silently ignored line. That is
     * the intended behaviour and `REMOVED_KEYS` in `load.ts` gives it a
     * message that says so, instead of a bare "unrecognized key" that reads
     * like a typo.
     */
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

/**
 * The heartbeat interval a run gets when no config is reachable, in ms.
 *
 * Derived from the schema rather than restated, so the fallback the daemon
 * reaps by can never drift from the default a config that omits the key
 * actually gets. A literal `5_000` here would be correct today and silently
 * wrong the first time the default moves.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = TimersSchema.parse({}).heartbeat_interval * 1000;

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

/**
 * The branch prefix a run gets when no config is reachable.
 *
 * Derived from the schema for the same reason `DEFAULT_HEARTBEAT_INTERVAL_MS`
 * above is: `dispatch` must name a worker's branch even for the no-config
 * Phase 1 path, and a literal `"fleet"` there would be correct today and
 * silently wrong the first time the default moves — which is precisely the
 * class of drift that left `branch_prefix` unread in the first place.
 *
 * Read off the FIELD rather than by parsing a whole `RunSchema` object, which
 * is how the first version of this line was written and why it is worth a
 * comment: `RunSchema` has two members with no default (`repo` and `budget`),
 * so `RunSchema.parse({ repo: "." })` throws — at module load, out of a file
 * every command imports, taking 274 tests down with it. A default is a
 * property of one field and asking that field for it needs no valid
 * neighbours.
 */
export const DEFAULT_BRANCH_PREFIX: string = RunSchema.shape.branch_prefix.parse(undefined);

/**
 * The in-flight cap a run gets when no config is reachable.
 *
 * Same construction and the same reason as `DEFAULT_BRANCH_PREFIX` above:
 * `dispatch --auto` has to cap concurrency even for a run directory that `up`
 * built with no config (or that a test assembled by hand), and a literal `2`
 * there would be correct today and silently wrong the first time the default
 * moves. `max_concurrent` sat in this schema with no reader at all until the
 * budget was wired to the dispatch path — the same dead-field shape
 * `branch_prefix` and `models_allowlist` were each caught in, and the reason
 * the default is derived rather than restated.
 *
 * Note the asymmetry with `tokens_ceiling`, which deliberately has NO
 * equivalent: it is a required field with no default, so a run that recorded
 * none is UNBOUNDED. Inventing a ceiling for it would refuse work no operator
 * ever budgeted for; inventing a concurrency cap only delays work.
 */
export const DEFAULT_MAX_CONCURRENT: number = RunSchema.shape.max_concurrent.parse(undefined);

/**
 * `llm.relay_upstream` is validated HERE, with the predicate the relay itself
 * uses, for the same reason `egressRuleHost` below is: a value the relay will
 * refuse must be a field-level `config validate` error, not a throw from inside
 * `up` after containers already exist.
 */
const relayUpstream = shortStr.superRefine((raw, ctx) => {
  const err = relayUpstreamError(raw);
  if (err !== null) ctx.addIssue({ code: "custom", message: err });
});

export const LlmSchema = z
  .object({
    /** oMLX — on the Docker host, or on a trusted LAN peer (§5.9). */
    provider: shortStr.default("omlx"),
    /**
     * What a WORKER dials, from inside the egress bridge — NOT necessarily
     * where the model server is. The host component must stay
     * `host.docker.internal`, the relay's listen-side alias on that bridge
     * (§5.9). To move the server itself, set `relay_upstream`.
     */
    base_url: z.string().url().default("http://host.docker.internal:8000/v1"),
    /**
     * Where the RELAY dials — `host:port`, explicit port required (§5.9; ISC-259).
     *
     * `null` (the default) means `host.docker.internal:<port from base_url>` —
     * exactly the pre-ISC-259 behaviour, so every existing `fleet.yaml` keeps
     * working untouched. The default is `null` rather than a literal because it
     * depends on ANOTHER field's value; a static default here would be a
     * second, drifting derivation of that port.
     *
     * A separate key rather than more meaning loaded onto `base_url`, and the
     * separation is load-bearing rather than tidy: it is what lets the relay's
     * `decide()` gate judge the dial target against a policy the target was not
     * derived from (`relay.ts:relayGatePolicy`). Overloading `base_url` — which
     * already serves both the worker's URL and the egress policy's LLM rule —
     * is precisely what kept that check circular and therefore vacuous (ISC-253).
     *
     * Any value other than the Docker-host default ALSO requires a matching
     * `egress.allow` entry. That second edit is the security decision, and it is
     * deliberately not derivable from this one.
     */
    relay_upstream: relayUpstream.nullable().default(null),
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
// Egress (SRD §5.9, §12.4; ISC-57) — additive block owned by the Phase 3
// egress subsystem; the matcher lives in src/security/egress.ts.
// ---------------------------------------------------------------------------

/**
 * Rule hosts are validated HERE, at `config validate` time, with the same
 * predicate the matcher uses. A pattern the matcher can never match (interior
 * wildcard, bare `*`, TLD-wide suffix) must be a loud field-level error — a
 * dead allow rule silently denies the destination it was written for, and the
 * operator's next move is widening the policy until it means nothing.
 */
const egressRuleHost = shortStr.superRefine((host, ctx) => {
  const err = ruleHostError(host);
  if (err !== null) ctx.addIssue({ code: "custom", message: err });
});

export const EgressRuleSchema = z
  .object({
    /** Exact host, IP literal, or a single leading `*.` wildcard. */
    host: egressRuleHost,
    /** Part of the rule, never an afterthought: allowed-host-any-port is a tunnel. */
    port: z.number().int().min(1).max(65535),
  })
  .strict();

export const EgressSchema = z
  .object({
    /**
     * Google endpoints ADC + GKE auth need, always on 443 (§12.4). The oMLX
     * rule is NOT listed here — it is derived from `llm.base_url` so a
     * reconfigured fleet is never silently denied its own model server.
     */
    google_hosts: z
      .array(egressRuleHost)
      .max(64)
      .default(["oauth2.googleapis.com", "*.googleapis.com", "accounts.google.com"]),
    /** Extra explicit rules. Empty by default — deny-all does the rest. */
    allow: z.array(EgressRuleSchema).max(64).default([]),
  })
  .strict()
  .prefault({});

// ---------------------------------------------------------------------------
// Harness surface (SRD §8.2; ISC-150, ISC-232) — the globs that decide which
// of a worker's changed files count as the exam rather than the answer.
// ---------------------------------------------------------------------------

/**
 * Which repo-relative globs are the TEST HARNESS: the files an acceptance
 * command's MEANING resolves through, as opposed to the code it grades. A
 * worker whose diff touches one has produced an unfalsifiable claim — even a
 * fresh clone at its head runs harness code the worker wrote — so
 * `harvest/adjudicate.ts` caps the verdict. The matcher and the shipped
 * defaults live in `harvest/acceptance.ts`; this key decides which list it
 * runs with.
 *
 * `patterns` REPLACES `DEFAULT_HARNESS_PATTERNS`; it does not extend them
 * (ISC-232). The defaults are what a config that stays SILENT gets, not a
 * floor every config is measured on top of. Replacement is also what
 * `harnessSurface()`'s second argument has always meant, and a second merge
 * rule invented here would leave the effective surface as something no
 * reader could compute from the document in front of them.
 *
 * The price of replacement is that a config can NARROW the surface, and a
 * narrowed surface is a weakened ISC-150 cap. That is a legitimate operator
 * decision — a repo whose suites do not live under `test/` needs it — but it
 * is only defensible while it is deliberate, which is why an empty list is a
 * validation error instead of "match nothing". `patterns: []` reads like "no
 * opinion" and would silently switch the cap off entirely: `touched` could
 * never be non-empty, and the one control standing between a rewritten exam
 * and a certified success would be disabled by a key that looks like it says
 * nothing. To mean "no opinion", omit the key.
 *
 * Capped at `MAX_ITEMS` rather than the 64 used by the other lists here,
 * because these strings flow into `HarnessSurfaceSchema`, which caps at
 * `MAX_ITEMS`: a config that validates must not then fail inside the
 * harvester. 64 would also be below the ~90 globs the defaults already
 * carry, so a config could not even restate what it was overriding.
 */
export const HarnessSchema = z
  .object({
    // The message carries the reasoning because the stock one ("expected
    // array to have >=1 items") reads as a formatting nit, and the obvious
    // way to satisfy a formatting nit is to put SOMETHING in the list — which
    // is the more dangerous move, not the safe one: any list that matches
    // nothing narrows the surface just as an empty one does. Naming the
    // consequence and the actual escape hatch is the point of the override.
    patterns: z
      .array(shortStr)
      .min(
        1,
        "harness.patterns cannot be empty: it REPLACES the built-in defaults, " +
          "so an empty list would disable the ISC-150 test-harness cap entirely " +
          "rather than mean 'no opinion'. Omit the harness key to get the defaults.",
      )
      .max(MAX_ITEMS)
      .optional(),
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
    egress: EgressSchema,
    harness: HarnessSchema,
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

    // A role name is a MOUNT PATH SEGMENT, not merely a label. `roleSkillsDir`
    // joins it into the host directory mounted read-only at `/skills` in every
    // worker of that role (SRD §5.5), and nothing between this document and the
    // `-v` flag inspected it — so a role named `../../../../../../etc` resolved
    // to the host's `/etc`, and both `render` and `up` mounted it into the
    // container. The name is refused here, where it enters the system, rather
    // than sanitized at the join: a name that cannot be spelled cannot escape.
    //
    // Constrained to the grammar worker ids already use: one segment, no
    // separator, and — because it must both begin and end alphanumeric —
    // unable to spell `.` or `..`.
    for (const name of Object.keys(cfg.roles)) {
      if (!SESSION_ID_RE.test(name) || name.length > 64) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", name],
          message: `invalid role name "${name}" — a role name becomes a mount path segment (it is joined into the host /skills directory), so it must be 1-64 characters of letters, digits, ".", "_" or "-", beginning and ending alphanumeric`,
        });
      }
    }

    // A SKILL name is a mount path segment for exactly the same reason, and it
    // was left unchecked while the role beside it was fixed. `run/materialize.ts`
    // joins the name into the host SOURCE root (`<repo>/skills/<name>`) and
    // into the destination bundle (`<run>/skills/<role>/<name>`), then mkdirs,
    // chmods and writes through both — so `skills: ["../../../../victim"]`
    // walks out of the run directory and reopens the permissions of whatever
    // it lands on. Refused here, where the name enters the system, under the
    // grammar worker ids and role names already use: one segment, no
    // separator, and unable to spell `.` or `..`.
    //
    // Checked at all three levels because the merge (§6.1 rule 1) can take the
    // list from any of them — a name refused only under `roles:` would walk
    // straight in through a per-worker override.
    const checkSkillNames = (
      skills: readonly string[] | undefined,
      at: Array<string | number>,
    ): void => {
      if (skills === undefined) return;
      skills.forEach((name, i) => {
        if (SESSION_ID_RE.test(name) && name.length <= 64) return;
        ctx.addIssue({
          code: "custom",
          path: [...at, i],
          message: `invalid skill name "${name}" — a skill name becomes a mount path segment (it is joined into the host /skills directory), so it must be 1-64 characters of letters, digits, ".", "_" or "-", beginning and ending alphanumeric`,
        });
      });
    };
    checkSkillNames(cfg.defaults?.skills, ["defaults", "skills"]);
    for (const [name, fields] of Object.entries(cfg.roles)) {
      checkSkillNames(fields?.skills, ["roles", name, "skills"]);
    }
    cfg.workers.forEach((w, i) => checkSkillNames(w.skills, ["workers", i, "skills"]));

    // ISC-59: `read_only: true` combined with `bash` in the MERGED tool set.
    // Checked at the level that completes the combination, so the error points
    // at the document position a human would edit.
    // Omitting `tools` is NOT "no tools" — pifleet then passes no `--tools`
    // flag and Pi grants every builtin, `bash` among them. Resolving the
    // omission to the builtin set before the check is what makes the guard
    // catch the default case; testing `tools?.includes` let the most common
    // shape of the violation through silently.
    const defaultTools = cfg.defaults.tools;
    const effective = (declared: readonly ToolName[] | undefined): readonly ToolName[] =>
      declared ?? PI_BUILTIN_TOOLS;
    for (const [name, role] of Object.entries(cfg.roles)) {
      const readOnly = role.read_only ?? cfg.defaults.read_only ?? false;
      const tools = effective(role.tools ?? defaultTools);
      if (readOnly && tools.includes("bash")) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", name, "tools"],
          message:
            (role.tools ?? defaultTools) === undefined
              ? `role "${name}" is read_only: true with no explicit tools — Pi then grants every builtin, "bash" included; declare a tools list without "bash"`
              : `role "${name}" is read_only: true but its tools include "bash" — a shell can write; drop one`,
        });
      }
    }
    cfg.workers.forEach((w, i) => {
      const role = cfg.roles[w.role];
      if (!role) return; // already reported above
      const readOnly = w.read_only ?? role.read_only ?? cfg.defaults.read_only ?? false;
      const declared = w.tools ?? role.tools ?? defaultTools;
      const tools = effective(declared);
      if (readOnly && tools.includes("bash")) {
        ctx.addIssue({
          code: "custom",
          path: ["workers", i, "tools"],
          message:
            declared === undefined
              ? `worker "${w.id}" resolves to read_only: true with no explicit tools — Pi then grants every builtin, "bash" included; declare a tools list without "bash"`
              : `worker "${w.id}" resolves to read_only: true with "bash" in its tools — a shell can write; drop one`,
        });
      }
    });
  });

export type FleetConfig = z.infer<typeof FleetConfigSchema>;
