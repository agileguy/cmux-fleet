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
 *    was an actual finding against v1.1's example (SRD §6.2);
 *  - a worker that resolves to `pane_mode: tui` in a shape that has no pane:
 *    the `oneshot` lifecycle, or a `headless` backend (SRD §3.5).
 */

import { z } from "zod";
import { MAX_ITEMS, SESSION_ID_RE, workerId } from "../contracts.ts";
import { ruleHostError } from "../security/egress.ts";
import { relayUpstreamError } from "../security/relay.ts";
import { KNOWN_THEMES, knownTheme } from "./themes.ts";

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
    /**
     * The ROUTE, split off from the GRANT (SRD §5.9, §12.4).
     *
     * `cloud_access` used to mean two things at once, because one `if` carried
     * both: "holds a Google identity" and "may reach an allowed host through
     * the CONNECT proxy". Nothing needs those welded together — a worker that
     * must fetch a package index or call a ticketing API needs the second and
     * has no business with the first — and welding them meant the only way to
     * grant the route was to grant an identity with it. That is the more
     * expensive half being handed out to buy the cheaper one.
     *
     * This key buys the route alone. It does NOT widen `egress.allow`: the
     * proxy's policy is fleet-wide and unchanged, so this decides whether a
     * worker is TOLD about a proxy that already refuses everything the fleet
     * did not list. A worker with `egress_access: true` and an empty
     * `egress.allow` reaches exactly the Google hosts the default carries and
     * nothing else — and, holding no credential, can spend nothing there.
     */
    egress_access: z.boolean().optional(),
    /**
     * Host environment variables this worker is to be handed, BY NAME.
     *
     * A REQUEST, not a grant. The fleet-wide `secrets.env_allowlist` is the
     * ceiling and this is the draw against it; a name must appear in both or
     * `up` refuses. Splitting it this way means a role file — which is the
     * thing most likely to be copied between fleets — can ask for a variable
     * without being able to widen what the fleet permits.
     *
     * NEVER a provider key and never a Google credential. Those have their own
     * paths (`llm.api_key_env`, `security/adc.ts`), and `run/worker-env.ts`
     * REFUSES any name this fleet already owns rather than trusting the
     * operator not to write one — see `RESERVED_PREFIXES` there. This key must
     * not become a second route to §12.4's Class 2 material.
     */
    secrets: z.array(shortStr).max(64).optional(),
    isolation: IsolationSchema.optional(),
    pane_mode: z.enum(["rpc", "tui"]).optional(),
    /**
     * Pi TUI colour theme, by name (`config/themes.ts`).
     *
     * A free string rather than a `z.enum` of the 16 bundled names, and that is
     * a deliberate refusal to make this schema the authority. The names that
     * actually resolve are a property of the IMAGE — Pi reads them out of
     * `/opt/pifleet/themes` at start — and an enum here would refuse a theme an
     * operator legitimately added to a rebuilt image, at parse time, with no
     * way to say yes. So an unrecognised name WARNS (`unknownThemeWarning`
     * below) and the run proceeds: the worst case is a pane in the default
     * theme, which is cosmetic, and refusing a whole fleet over a cosmetic
     * mismatch is the larger error.
     *
     * Meaningful only where a person is looking at the pane, i.e. `pane_mode:
     * tui`. It is not refused on an rpc worker — the resolution is three-level,
     * so `defaults.theme` naturally lands on workers that will never render it,
     * and warning about every one of those would be noise about nothing.
     */
    theme: shortStr.optional(),
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

/**
 * The bound a supervisor answers an `extension_ui_request` within when no
 * config is reachable, in ms (SRD §12.3 guard 2 — ISC-111, ISC-112).
 *
 * Derived from the schema for the same reason as the heartbeat above, and the
 * derivation matters more here than there: ISC-111 is phrased as a literal
 * "within 5s", `ui_request_timeout` prefaults to `5s`, and a restated
 * `5_000` would let the criterion and the code that satisfies it drift apart
 * without either one becoming wrong on its own.
 *
 * `ui_request_timeout` was the schema's longest-standing key with no reader —
 * parsed here since the config landed and consulted by nothing, in the same
 * shape `max_concurrent` and `branch_prefix` were in — which is precisely why
 * ISC-111 stayed open with a "within 5s" clause that had no timer behind it.
 */
export const DEFAULT_UI_REQUEST_TIMEOUT_MS = TimersSchema.parse({}).ui_request_timeout * 1000;

export const RunSchema = z
  .object({
    root: shortStr.default("~/.pifleet/runs"),
    repo: shortStr,
    isolation: IsolationSchema.default("worktree"),
    branch_prefix: shortStr.default("fleet"),
    /** Bounded by measured oMLX throughput, not pane count (SRD §5.9 / F40). */
    max_concurrent: z.number().int().positive().default(2),
    /**
     * Consecutive turns a worker may complete with ZERO tool calls before the
     * supervisor classifies its task `failed:no_tool_calls` (SRD §5.9 detector
     * 2 / F39 — ISC-108). **`0` disables the detector.**
     *
     * `nonnegative`, not `positive`, and that is the whole of the off switch.
     * The other reading of `0` — "fail before completing any turn" — describes
     * no configuration anyone would want, since it would fire on every task
     * including the ones that work. Making it mean OFF gives §5.9's
     * "`require_native_tool_calls: false` disables both" a single spelling:
     * `up` folds the gate and this key into ONE effective number (see
     * `effectiveProseTurnsBeforeFail`), so an operator who turns the guard off
     * does not also have to know to zero a second key in a different block.
     *
     * It lives under `run:` rather than beside `require_native_tool_calls`
     * under `llm:` because of WHO READS IT. This is a supervisor runtime bound
     * — it travels to a detached process through `run.json`, exactly as
     * `timers.ui_request_timeout` and `max_concurrent` do — whereas everything
     * in `llm:` is consumed at `up`, by the probe and the relay. Putting a
     * supervisor bound in the block the supervisor never sees is precisely how
     * `ui_request_timeout` spent so long validating and changing nothing.
     */
    prose_turns_before_fail: z.number().int().nonnegative().default(3),
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
 * The zero-tool-call bound a run gets when no config is reachable (SRD §5.9
 * detector 2 — ISC-108).
 *
 * Same construction and the same reason as the two defaults above, and the
 * derivation earns its keep more sharply here than for either of them: ISC-108
 * is phrased as a literal "**3** turns", §5.9 says "default **3**", and a
 * restated `3` in the supervisor's reader would let the criterion and the code
 * that satisfies it drift apart without either becoming wrong on its own. Move
 * the schema default and the criterion follows it; restate it and the number in
 * `ISA.md` quietly stops describing the running system.
 *
 * Forgiving about absence, for the reason `readRunUiRequestTimeoutMs` is: a run
 * directory written before this key existed, or assembled by hand in a test,
 * must still get the detector rather than silently losing it. A guard that
 * fails OPEN on an old run directory is the version of this guard that is not
 * worth having.
 */
export const DEFAULT_PROSE_TURNS_BEFORE_FAIL: number =
  RunSchema.shape.prose_turns_before_fail.parse(undefined);

/**
 * The ONE number `up` records for a run: `run.prose_turns_before_fail`, zeroed
 * when `llm.require_native_tool_calls` is off (SRD §5.9 — ISC-108).
 *
 * §5.9 ends its two-detector section with "`require_native_tool_calls: false`
 * disables both", and until this function existed only the first half of that
 * sentence was executable — `up`'s probe checked the gate, and the runtime
 * detector did not exist to check it. Resolving both inputs into a single
 * effective threshold HERE, at `up`, rather than shipping two keys to the
 * supervisor and re-deciding there, is deliberate for three reasons:
 *
 *  1. The supervisor never loads `fleet.yaml` (see `readRunUiRequestTimeoutMs`
 *     for why), so it could not read `llm.require_native_tool_calls` even if it
 *     wanted to. Sending the gate along in `run.json` as a second key would
 *     mean two fields that must be interpreted together by a reader that could
 *     get the conjunction wrong.
 *  2. `run.json` then records what the run was actually LAUNCHED under, one
 *     number, auditable months later without re-deriving a policy from two.
 *  3. There is exactly one spelling of off, so a test that asserts "off means
 *     off" tests both routes to it at once.
 *
 * Structurally typed rather than taking `FleetConfig` so it can sit beside the
 * default it pairs with, above the schema that defines its second input.
 */
export function effectiveProseTurnsBeforeFail(cfg: {
  run: { prose_turns_before_fail: number };
  llm: { require_native_tool_calls: boolean };
}): number {
  return cfg.llm.require_native_tool_calls ? cfg.run.prose_turns_before_fail : 0;
}

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

/**
 * The schemes an `llm.base_url` may carry: `http:` and `https:`, and nothing
 * else.
 *
 * `z.string().url()` is a WELL-FORMEDNESS check, not a protocol one. It accepts
 * `file:///etc/passwd`, `ftp://â¦`, `gopher://â¦` and `data:` â every scheme the
 * WHATWG parser knows â and this field is not merely stored. It is fed to
 * `fetch` by `doctor`'s host-side probe, and `hostReachableBaseUrl` derives a
 * dial target FROM it, so the URL an operator writes here becomes a request
 * this process issues with their model-server credential attached.
 *
 * Refused at the SCHEMA rather than at each dial, and the placement is the
 * point. A `config validate` failure names the field and the file; a refusal
 * inside a probe arrives after `up` has already built a bridge, and a probe
 * that simply fails on `file:` teaches nothing about why. It is also the only
 * place that covers every reader at once â there is more than one, and
 * `assertModelsSupportToolCalls` reads this value verbatim from inside a
 * container.
 *
 * This is a NARROWING, and one that cannot break a working fleet: the field's
 * documented meaning is an OpenAI-compatible HTTP endpoint, the shipped default
 * is `http:`, and no other scheme has ever reached a working request.
 */
const HTTP_SCHEMES = new Set(["http:", "https:"]);

const httpUrl = z.string().url().superRefine((raw, ctx) => {
  let scheme: string;
  try {
    scheme = new URL(raw).protocol;
  } catch {
    // Unreachable: `.url()` has already parsed it. Not thrown from here
    // regardless â a second parse failure is `.url()`'s message to give.
    return;
  }
  if (!HTTP_SCHEMES.has(scheme)) {
    ctx.addIssue({
      code: "custom",
      message:
        `base_url must be an http: or https: URL; got '${scheme}'. This value is dialed â ` +
        `'doctor' fetches it from the host with the API key attached, and every worker fetches ` +
        `it from inside the egress bridge â so a non-HTTP scheme is not a stored string, it is a ` +
        `request this process would issue`,
    });
  }
});

/**
 * A name Docker will accept as an environment variable identifier.
 *
 * Exported because `run/worker-env.ts` needs the same rule when it serialises
 * the env file, and two spellings of one constant is the failure ISC-264 was
 * filed for.
 */
export const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Namespaces the fleet owns outright. Prefixes rather than a name list because
 * the list is the part that drifts: `PIFLEET_HONEYPOT` arrived after the other
 * three `PIFLEET_*` vars and would have had to be remembered here.
 *
 * `CLOUDSDK_`/`GOOGLE_` are wider than `CREDENTIAL_ENV_VARS` on purpose — that
 * set names four variables and gcloud reads dozens, so pinning only the four
 * would leave `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE` refused and its neighbours
 * open.
 */
export const RESERVED_ENV_PREFIXES = ["PIFLEET_", "GIT_CONFIG_", "CLOUDSDK_", "GOOGLE_"] as const;

/**
 * Names with no shared prefix that the container's own environment depends on.
 * Deliberately short: this list only has to cover what a plausible `api_key_env`
 * typo could hit, and everything the FLEET assigns is caught by the prefixes
 * above instead.
 */
export const RESERVED_ENV_NAMES: readonly string[] = [
  "PATH", "HOME", "SHELL", "USER", "LANG", "TERM",
];

/**
 * The three `api_key_env` rules, in ONE place, because there are now two doors
 * into the same namespace.
 *
 * Until 2026-09-01 there was one field to guard and the guard was written
 * inline. `llm.providers` adds a second `api_key_env` per declared provider,
 * and an inline copy of these checks on the flat field only would have left the
 * per-provider one bare — the field most likely to name a credential worth
 * stealing, since a hosted provider is the reason the map exists at all.
 *
 * The hole was MEASURED, not imagined, and the measurement is written out at
 * the flat field below: `api_key_env: PIFLEET_LLM_MODELS` parsed, and the
 * credential was then written into `models.json` AS A MODEL ID, on a named
 * volume that outlives the container's `--rm`, with nothing anywhere noticing.
 * Reopening that on the per-provider side one commit after closing it on the
 * flat side is the single most plausible way this change goes wrong, so the
 * rules are a function two schemas call rather than a paragraph two schemas
 * each try to remember.
 *
 * Returns the message, or `null` when the name is acceptable. `field` is only
 * the label the message carries; the issue's PATH names the exact location, so
 * the per-provider caller passes the bare key and lets the path say which
 * provider block it came from.
 */
export function envVarNameIssue(name: string, field: string): string | null {
  if (!ENV_VAR_NAME_RE.test(name)) {
    return (
      `${field} must be an environment variable NAME — got "${name}", which is not a ` +
      `valid identifier. The value is read from the host environment under this name; it is ` +
      `never written in config.`
    );
  }
  const prefix = RESERVED_ENV_PREFIXES.find((p) => name.startsWith(p));
  if (prefix !== undefined) {
    return (
      `${field} must not start with "${prefix}" — got "${name}". That namespace is ` +
      `assigned by the fleet itself, and a collision overwrites the variable the worker ` +
      `needs with the credential.`
    );
  }
  if (RESERVED_ENV_NAMES.includes(name)) {
    return (
      `${field} must not be "${name}" — the container's own environment depends on ` +
      `it, and overwriting it with the credential breaks the worker before it starts.`
    );
  }
  return null;
}

/** `api_key_env`, guarded, under whichever label the caller's messages carry. */
const apiKeyEnvName = (field: string) =>
  shortStr.superRefine((name, ctx) => {
    const message = envVarNameIssue(name, field);
    if (message !== null) ctx.addIssue({ code: "custom", message });
  });

/**
 * The fleet's default provider when `llm.provider` is not written.
 *
 * A named constant because it is read twice — once as this field's default, and
 * once by the flat-key collision check, which runs against the RAW document and
 * therefore has to reproduce the defaulting itself. Two literal `"omlx"`s, one
 * of them inside a refusal, is the shape ISC-264 was filed for.
 */
const DEFAULT_PROVIDER = "omlx";

/**
 * What a provider KEY may look like.
 *
 * Two independent reasons, and the first is the one that bites silently. The
 * key is what a worker names in a `provider/model` prefix, and `decomposeModel`
 * splits that on the FIRST `/` — so a key containing a slash describes a
 * provider no worker can ever name, and a prefix that looks like it names it
 * resolves to something else. The second is D7: the key is composed into
 * `pifleet-egress-relay-<network>-<provider>` and into a Docker network name,
 * and Docker accepts only `[a-zA-Z0-9][a-zA-Z0-9_.-]*` there.
 *
 * The LENGTH half of the Docker-name constraint is deliberately NOT checked
 * here. It depends on the fleet name and the network name this key is composed
 * WITH, which this schema cannot see, so it belongs at `up` where the composed
 * string exists — that is ISC-412, and duplicating half of it here would be a
 * second derivation that drifts from the real one.
 */
const PROVIDER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * One entry in `llm.providers` — everything that describes ONE endpoint
 * (`Docs/SRD-INFERENCE-PROVIDERS.md` §6.2).
 *
 * ## Why these six and not the other four
 *
 * §6.2's table splits the old flat `llm:` block on a single question: does the
 * field describe an ENDPOINT, or does it describe what the FLEET will tolerate?
 * `base_url`, `relay_upstream`, `api_key_env`, `models_allowlist`, `hosted` and
 * `tag_style` are all statements about one endpoint and move here.
 * `provider`, `model` and `thinking` stay fleet-wide because they are defaults
 * a worker overrides, and `require_native_tool_calls` stays fleet-wide for a
 * reason that is not symmetry — see its entry below.
 *
 * `models_allowlist` moving here closes §2.6's second gap by construction: the
 * allowlist is checked against the RESOLVED provider's list, so a model
 * belonging to one provider can no longer satisfy an allowlist written for the
 * other. That check itself is ISC-404 and lives in the resolver, not here.
 *
 * ## What is REQUIRED, and why the defaults were not simply copied down
 *
 * `hosted`, `base_url` and `api_key_env` have no defaults in a provider block,
 * and the flat keys' defaults were deliberately not repeated here. Every one of
 * those defaults describes oMLX on the operator's own machine. Inheriting them
 * into a block that exists precisely because it is NOT that endpoint is how a
 * second provider silently acquires oMLX's URL and, worse, oMLX's credential —
 * which is the exact failure §6.2 names when it says two endpoints cannot share
 * a credential. A missing field is a `config validate` error naming the field;
 * an inherited one is a fleet that comes up and sends the wrong key somewhere.
 */
export const ProviderSchema = z
  .object({
    /**
     * REQUIRED and explicit. Never inferred — D3, and the reason is measured
     * rather than stylistic.
     *
     * §5.9's third permitted private shape is a tunnel to the operator's own
     * machine. The operator's actual tunnel has a public address, a publicly
     * resolvable hostname and TLS, so EVERY inference available — the URL
     * scheme, the address range, whether `relay_upstream` is RFC1918 — reads it
     * as hosted, which is wrong in exactly the case §5.9 spent an amendment
     * establishing. An inference that is wrong about the one shape a whole
     * amendment was written for is not an inference worth having.
     *
     * The declared cost (D3): an operator can lie to this field. They can; and
     * so can they set `cloud_access: false` on a role that needs it. It is a
     * declaration of intent the fleet then holds them to, and every refusal and
     * banner in §7 keys on the declaration rather than on a guess.
     */
    hosted: z.boolean({
      error:
        "hosted must be declared explicitly on every provider — it is never inferred. A tunnel " +
        "to the operator's own machine is https:, publicly resolvable and on a public address, " +
        "so inferring from the URL, the address range or the presence of TLS misclassifies the " +
        "one shape SRD §5.9 permits. Write `hosted: true` for a provider running on someone " +
        "else's hardware, `hosted: false` for one running on yours.",
    }),
    /** What a worker dials for THIS provider; same semantics as `llm.base_url`. */
    base_url: httpUrl,
    /** Names the env var for THIS provider's key; the value never appears in config. */
    api_key_env: apiKeyEnvName("api_key_env"),
    /**
     * Where THIS provider's relay dials. `null` keeps the flat key's meaning —
     * the Docker host on the port from this block's `base_url` — which is the
     * right default for a provider that is reached the way oMLX always was, and
     * is simply wrong to guess at for a hosted one, whose operator must write
     * the upstream and the matching `egress.allow` entry either way.
     *
     * Validated in the block-level check below rather than here, because
     * whether a HOSTNAME is permitted depends on this block's `hosted` (D9) and
     * a field-level refinement cannot see its sibling.
     */
    relay_upstream: shortStr.nullable().default(null),
    /** Empty means "no allowlist", exactly as the flat key does. */
    models_allowlist: z.array(shortStr).max(64).default([]),
    /**
     * Turns off `decomposeModel`'s `:thinking` suffix stripping for models on
     * this provider (D12, ISC-405). Off by default, so oMLX is unaffected and
     * no existing config changes meaning.
     *
     * The collision is real and one-directional: a vendor that spells model
     * sizes as tags — `gpt-oss:120b`, and one day a tag that happens to be
     * spelled `high` — would have that tag silently eaten and produce a
     * `model-not-found` against a name the operator can see is correct. D12's
     * declared cost is that the `:thinking` SUFFIX is then unavailable on this
     * provider and the operator must use the `thinking:` key, which is the
     * field the merge rules give the lowest precedence to anyway.
     */
    tag_style: z.boolean().default(false),
    /**
     * REFUSED, and declared here rather than left to `.strict()` so the refusal
     * can say why (ISC-420).
     *
     * `.strict()` would already reject the key, with "unrecognized key" — the
     * same message an operator gets for a typo, which teaches nothing about a
     * field that exists, is spelled correctly, and is deliberately not
     * available at this level. This file already made that trade once, in
     * `CloudSchema.adc_mode`, and for the same reason.
     *
     * The scope is not symmetry. §6.2: this field is a statement about what the
     * FLEET will tolerate, not about an endpoint, and §6.8 names what a
     * per-provider override would buy — a hosted provider quietly leaving a
     * gate the SRD calls mandatory, which is the shape of relaxation that whole
     * document exists to avoid. The gate has been measured against the real
     * hosted endpoint and all 19 catalogue models clear it, so fixing the scope
     * costs nothing today, which is the best moment to fix it.
     */
    require_native_tool_calls: z
      .never({
        error:
          "require_native_tool_calls is fleet-wide and has no per-provider override (SRD " +
          "§6.2, §6.8). It states what the FLEET will tolerate, not what an endpoint offers, " +
          "and a per-provider opt-out is exactly how a hosted provider would quietly leave a " +
          "gate the SRD calls mandatory. Set it once, on `llm`.",
      })
      .optional(),
  })
  .strict()
  /**
   * `relay_upstream` may be a HOSTNAME on a hosted provider, and on nothing
   * else. D9 (§6.7), and the scoping is the whole of the decision.
   *
   * The IP-literal rule is not stylistic. The relay resolves through Docker's
   * embedded DNS, and — measured — it also PUBLISHES `base_url`'s host as an
   * alias on the bridge it is itself attached to, so a hostname upstream that
   * matches a published alias resolves to the relay itself and every forwarded
   * connection loops back into its own listener: a hang, on the one path a
   * fleet cannot run without, with nothing in `docker logs` explaining it.
   *
   * What D9 buys by relaxing it for hosted blocks is the removal of a recurring
   * chore that only exists when the address is somebody else's: §3.1 measured a
   * single A record behind a global load balancer, no published range, and no
   * firewall guidance, so a pinned literal is a short-lived pin maintained by
   * hand in two files. `up` resolves the name on the HOST, where the resolver
   * is known to answer public names, and stamps the literal into the target, so
   * the relay still dials an address and neither failure above can occur.
   *
   * What it costs, stated plainly because it is a real weakening: for a hosted
   * block the gate's property becomes "the operator authorized this NAME, and
   * the fleet recorded which address it resolved to at launch". What bounds it
   * is that it cannot spread — the operator's own oMLX still refuses a hostname
   * here, so the stronger property is enforced rather than merely default.
   *
   * **The resolution half of D9 is NOT built yet, and nothing resolves this map
   * at all**, so a hostname written here today reaches no relay. When the
   * resolver lands, `up` must stamp the literal; a hostname that reached the
   * relay unresolved is precisely the hang described above.
   */
  .superRefine((block, ctx) => {
    if (block.relay_upstream === null) return;
    const err = relayUpstreamError(block.relay_upstream, { allowHostname: block.hosted });
    if (err !== null) ctx.addIssue({ code: "custom", path: ["relay_upstream"], message: err });
  });

/**
 * The four flat keys that describe an ENDPOINT and therefore have a
 * per-provider spelling. Written out rather than derived from
 * `ProviderSchema.shape` on purpose: `hosted` and `tag_style` are in that shape
 * and have no flat spelling at all, so a derived list would name two keys that
 * cannot collide and quietly stop naming any that later can.
 */
const PER_PROVIDER_FLAT_KEYS = [
  "base_url",
  "relay_upstream",
  "api_key_env",
  "models_allowlist",
] as const;

const LlmObject = z
  .object({
    /**
     * oMLX — on the Docker host, or on a trusted LAN peer (§5.9).
     *
     * Also the fleet DEFAULT provider: the one a worker gets when its `model:`
     * carries no `provider/` prefix. When `providers` is written, this must
     * name a key of it — a fleet default that names nothing is a fleet where
     * every unprefixed model resolves to an endpoint that was never declared.
     */
    provider: shortStr.default(DEFAULT_PROVIDER),
    /**
     * What a WORKER dials, from inside the egress bridge — NOT necessarily
     * where the model server is. The host component must be
     * `omlx.pifleet.internal`, the relay's listen-side alias on that bridge
     * (§5.9). To move the server itself, set `relay_upstream`.
     *
     * Renamed from `host.docker.internal` by ISC-264. That name claimed the
     * relay was the Docker host, which stopped being true when `relay_upstream`
     * could name a LAN peer. The old spelling is still ACCEPTED and still
     * RESOLVES — `relayConnectArgv` attaches both aliases — with a deprecation
     * warning, so an existing `fleet.yaml` needs no edit to keep working.
     */
    base_url: httpUrl.default("http://omlx.pifleet.internal:8000/v1"),
    /**
     * Where the RELAY dials — `host:port`, explicit port required (§5.9; ISC-259).
     *
     * `null` (the default) means `host.docker.internal:<port from base_url>` —
     * the DOCKER HOST, which is a different constant from the listen alias
     * above and deliberately kept as this literal (ISC-264: the two used to be
     * the same string, and a policy rule about this side was written from that
     * side's name by accident) —
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
    /**
     * Names the env var; the value never appears in config (SRD §12.4).
     *
     * ## Why this is validated here and not left to `shortStr`
     *
     * This string becomes an environment variable NAME inside the worker, and
     * until 2026-09-01 nothing checked it — while the same repo already refused
     * exactly these names when they arrived through `secrets:`
     * (`worker-env.ts`'s `SecretReservedNameError`). Two doors into the same
     * namespace, one guarded.
     *
     * The gap was measured, not imagined. `api_key_env: PIFLEET_LLM_MODELS`
     * parsed, and `worker-env` then overwrote the model list with the
     * credential; the entrypoint's guard tests only non-emptiness, so it
     * rendered:
     *
     *   {"apiKey":"<the key>","models":[{"id":"<the key>","name":"<the key>"}]}
     *
     * The credential became a model id, on a NAMED VOLUME that outlives the
     * container's `--rm`. Nothing noticed: `missingApiKey` was false, the env
     * file serialised cleanly, and the ISC-31 test still passed because it
     * asserts how MANY variables hold the credential, not which. The runtime
     * symptom was `model-not-found`, which reads as a fleet.yaml typo.
     * `PIFLEET_LLM_BASE_URL` does the same to the endpoint, and `PATH` and
     * `HOME` were accepted too.
     *
     * A malformed name was the other half: the entrypoint's identifier guard
     * discards it and renders an empty key, silently. Refusing at parse time is
     * the only place the operator learns which field is wrong.
     *
     * The three rules moved into `envVarNameIssue` when `llm.providers` gave
     * this field a second spelling. They are unchanged; there is now one copy
     * of them instead of the two a per-provider block would otherwise need.
     */
    api_key_env: apiKeyEnvName("llm.api_key_env").default("OMLX_API_KEY"),
    model: z.string().min(1).max(256),
    thinking: ThinkingLevelSchema.optional(),
    models_allowlist: z.array(shortStr).max(64).default([]),
    require_native_tool_calls: z.boolean().default(true),
    /**
     * The provider map (§6.1). Absent — not empty — when the operator has not
     * written one, and the distinction is load-bearing twice over: it is what
     * makes the flat keys legal, and `providers: {}` is a document that
     * declares no provider while `llm.provider` still names one, which is a
     * refusal rather than a shorthand for "none".
     *
     * Nothing RESOLVES against this map yet. This schema establishes that a
     * multi-provider fleet can be SPELLED and that the two ways of spelling one
     * cannot disagree; wiring the resolver, the relay and the probe to it is
     * sequenced after, and until that lands a declared provider changes no
     * behaviour beyond being validated.
     */
    providers: z.record(z.string(), ProviderSchema).optional(),
  })
  .strict()
  /**
   * The fleet default must name a declared provider, and every key must be a
   * name a worker and Docker can both use.
   *
   * This runs on the PARSED object because it needs `provider`'s default
   * applied — an operator who writes `providers:` and never writes `provider:`
   * is relying on `omlx`, and if that is not a declared key then every
   * unprefixed model in the fleet resolves to an endpoint the document does not
   * describe. The worker-facing half of the same rule — a `provider/` prefix
   * naming something absent from the map — is ISC-402 and belongs to the
   * resolver, which is the only place a worker's merged model exists.
   */
  .superRefine((llm, ctx) => {
    if (llm.providers === undefined) return;
    const declared = Object.keys(llm.providers);
    for (const name of declared) {
      if (PROVIDER_KEY_RE.test(name)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["providers", name],
        message:
          `"${name}" is not usable as a provider key. It has to survive two places: a worker ` +
          `names it as the "provider/" prefix on a model, which is split on the first "/", and ` +
          `it is composed into a Docker network and relay name. Use letters, digits, "_", "." ` +
          `or "-", starting with a letter or a digit.`,
      });
    }
    if (Object.prototype.hasOwnProperty.call(llm.providers, llm.provider)) return;
    ctx.addIssue({
      code: "custom",
      path: ["provider"],
      message:
        `llm.provider is "${llm.provider}", which llm.providers does not declare ` +
        (declared.length === 0
          ? `— llm.providers is empty. `
          : `(declared: ${declared.join(", ")}). `) +
        `It is the provider every worker gets whose model carries no "provider/" prefix, so a ` +
        `fleet default naming nothing sends the whole fleet to an endpoint this document does ` +
        `not describe.`,
    });
  });

/**
 * The flat keys and the map cannot both spell the same provider.
 *
 * ## Why this is a preprocess and not another refinement
 *
 * The check needs to know whether the operator WROTE a flat key, and every one
 * of them carries a default — `base_url` resolves to the oMLX literal,
 * `api_key_env` to `OMLX_API_KEY`, `relay_upstream` to `null` — so by the time
 * the object has parsed, "the operator wrote it" and "the schema supplied it"
 * are the same value and are indistinguishable. Only the raw document knows,
 * and `z.preprocess` is where the raw document still exists. The alternative,
 * dropping the defaults and re-applying them in a transform, would move four
 * default values away from the four field docblocks that explain them.
 *
 * ## Why a refusal rather than a merge
 *
 * §6.1 names the reason and it is not tidiness: the flat keys mean "the block
 * for `llm.provider`", so a document that writes both has said one thing twice.
 * Whichever way a merge resolved it, the losing spelling would sit in the file
 * looking authoritative — and two constants that quietly disagree is exactly
 * what ISC-264 cost a whole rename to find. The operator moves the value into
 * the block, or deletes the block; the schema does not choose for them.
 *
 * Keyed on the ENTRY, not on the individual key, because that is what §6.1 and
 * ISC-403 both say: a `providers` entry for `llm.provider` is a complete
 * description of that endpoint, so any flat endpoint key beside it is a second
 * description of the same thing whether or not the values happen to match
 * today.
 */
export const LlmSchema = z.preprocess((raw, ctx) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const doc = raw as Record<string, unknown>;
  const providers = doc.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return raw;
  // `provider`'s own default has not been applied yet — this is the raw
  // document — so reproduce it from the same constant the field uses.
  const provider = typeof doc.provider === "string" ? doc.provider : DEFAULT_PROVIDER;
  if (!Object.prototype.hasOwnProperty.call(providers, provider)) return raw;
  for (const key of PER_PROVIDER_FLAT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(doc, key)) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message:
        `llm.${key} and llm.providers.${provider}.${key} are two spellings of one value. The ` +
        `flat keys mean "the block for llm.provider" (§6.1), so writing both is not a merge — ` +
        `one would have to win silently, and two constants that quietly disagree is what ` +
        `ISC-264 cost a rename to find. Move the value into llm.providers.${provider} and ` +
        `delete llm.${key}.`,
    });
  }
  return raw;
}, LlmObject);

export const CloudSchema = z
  .object({
    adc: z.boolean().default(false),
    /**
     * `token` is the ONLY mode (§5.8, ISC-268). A 1h access token, not a
     * refresh token.
     *
     * `file` was removed 2026-08-25 rather than wired. It had been accepted by
     * this schema and implemented nowhere: `buildDockerArgv` emitted no
     * `/creds` mount and the three file-mode symbols had no caller in `src/`,
     * so an operator could set it, `up` would not refuse, and no credential
     * was mounted. A mode that neither works nor fails is worse than one that
     * is absent — the failure surfaces as an unexplained permission error
     * inside the container instead of at launch.
     *
     * Wiring it was the other option and was rejected on what it would mount:
     * the host ADC file is `type: authorized_user` and carries a
     * `refresh_token`, a non-expiring grant over the operator's whole Google
     * account. That is §12.4's F37, the highest-value exfiltration target in
     * the threat model, and it would have been the FIRST credential path built
     * — ISC-248 established there is no credential runtime at all yet — into a
     * container that runs model output, on a machine where it cannot be
     * verified end to end.
     *
     * Kept as a one-value enum rather than deleted so an operator who has
     * `adc_mode: file` in their config gets "Invalid option: expected 'token'"
     * naming the field, instead of `.strict()`'s "unrecognized key".
     */
    adc_mode: z.enum(["token"]).default("token"),
    quota_project: shortStr.nullable().default(null),
    impersonate_service_account: shortStr.nullable().default(null),
    /** A FILTERED kubeconfig copy; never the host default (§5.5). */
    kubeconfig: shortStr.nullable().default(null),
    token_refresh: durationSeconds.prefault("45m"),
  })
  .strict()
  .prefault({});

/**
 * One entry on `secrets.env_allowlist`: a bare name, or a name that says it is
 * not a credential.
 *
 * ## Why the long form exists, and what it does NOT change
 *
 * `secrets:` is the only per-worker delivery channel this fleet has, so a
 * variable that must reach a worker has to be listed here whether or not it is
 * secret. `TICKET_BASE_URL` is the standing example and `fleet.example.yaml`
 * has argued the point in a comment since the channel was written: a public
 * endpoint on this list "is harmless but is not what this list is for".
 *
 * It was not harmless. `harvest/needles.ts` sweeps every granted VALUE through
 * `findCredentialLeaks`, and a ticket worker's artifacts legitimately contain
 * the endpoint they were pointed at — so every `ticket-ops.json` was refused
 * as carrying a credential and every verdict clamped. A detector that fires on
 * every honest run is the same defect as one that never fires, one sign
 * flipped.
 *
 * `credential: false` says one thing and only one thing: **do not use this
 * value as a needle.** Delivery is untouched — the name is still granted, the
 * worker still gets a 0444 file and a `<NAME>_FILE` pointer, and every
 * reserved-name and allowlist check applies exactly as before. It buys no
 * privilege; it forfeits a check.
 *
 * The DEFAULT is `true`, and a bare string means `true`. An operator who adds
 * a real credential and writes nothing extra gets it swept, which is the
 * direction a mistake has to fall.
 */
export const SecretEntrySchema = z.union([
  shortStr,
  z
    .object({
      name: shortStr,
      /**
       * `false` means "delivered, not swept". Defaulting to `true` makes the
       * long form safe to reach for — an operator who writes `{name: X}` to
       * add a comment does not silently disarm the sweep for X.
       */
      credential: z.boolean().default(true),
    })
    .strict(),
]);

export type SecretEntry = z.infer<typeof SecretEntrySchema>;

/** The granted NAMES, in order, whichever form each entry took. */
export function secretGrantNames(entries: readonly SecretEntry[]): string[] {
  return entries.map((e) => (typeof e === "string" ? e : e.name));
}

/** The subset declared `credential: false` — the names the sweep skips. */
export function nonCredentialSecretNames(entries: readonly SecretEntry[]): string[] {
  return entries.flatMap((e) => (typeof e === "string" || e.credential ? [] : [e.name]));
}

export const SecretsSchema = z
  .object({
    /** NEVER provider keys — see SRD §12.4. */
    env_allowlist: z.array(SecretEntrySchema).max(64).default([]),
  })
  .strict()
  /**
   * A name may not appear twice with different answers.
   *
   * `[X, {name: X, credential: false}]` has no defensible reading: the sweep
   * would take whichever the implementation happened to look at first, and the
   * operator's intent is unrecoverable from the document. Refusing at
   * `config validate` is cheap; a fleet that quietly disarmed a sweep because
   * of list order is not.
   */
  .superRefine((v, ctx) => {
    const seen = new Map<string, boolean>();
    for (const e of v.env_allowlist) {
      const name = typeof e === "string" ? e : e.name;
      const isCredential = typeof e === "string" ? true : e.credential;
      const prior = seen.get(name);
      if (prior !== undefined && prior !== isCredential) {
        ctx.addIssue({
          code: "custom",
          path: ["env_allowlist"],
          message:
            `secrets.env_allowlist lists ${name} twice with different credential settings — ` +
            `say once whether it is swept`,
        });
      }
      seen.set(name, isCredential);
    }
  })
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
        "harness.patterns cannot be empty: under `replace: true` it becomes the " +
          "WHOLE harness surface, so an empty list would disable the ISC-150 " +
          "test-harness cap entirely rather than mean 'no opinion'. Omit the " +
          "harness key to get the built-in defaults.",
      )
      .max(MAX_ITEMS)
      .optional(),
    /**
     * Whether `patterns` REPLACES the built-in defaults or EXTENDS them.
     *
     * Defaults to extending, and the default changed on 2026-08-25 because
     * replacement was a silent-disable path. ISC-243 measured it: the operator's
     * only lever was a list that swapped out all 91 built-in globs, so the
     * realistic first edit — `patterns: ["ci/**"]`, to add one CI file someone
     * cared about — switched the ISC-150 test-harness cap off for every diff
     * that did not touch `ci/`. The over-cap that replacement exists to answer
     * is a LOUD failure (a run capped to `unknown`); the under-cap it causes is
     * a SILENT one (a red suite certified `success`). Extending makes the
     * common edit safe and leaves the rare one available by name.
     */
    replace: z.boolean().prefault(false),
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

    // ------------------------------------------------------------------
    // `pane_mode: tui` combined with something that has no pane (SRD §3.5)
    // ------------------------------------------------------------------
    //
    // `tui` is not a Pi flag. Measured against `pi --help` in the shipped
    // worker image (`pifleet/pi-worker:0.79.6-base`), the only modes are
    // `--mode <text|json|rpc>`; a TUI worker is the SAME argv with `--mode rpc`
    // OMITTED, in a container that was given a TTY. So `pane_mode` does not
    // select a feature Pi either has or lacks — it selects WHO OWNS THE
    // CONTAINER'S STDIN, and SRD §162 is the constraint that follows: "a TTY
    // has one owner. Pi's RPC mode needs stdin/stdout as pipes; a TUI needs
    // them as a terminal."
    //
    // Two configurations therefore describe a worker that cannot exist, and
    // both are refused HERE rather than at `up`, for the reason `httpUrl` and
    // `egressRuleHost` above are: a `config validate` failure names the field
    // and the file, whereas the same refusal inside `up` arrives after
    // containers, worktrees and panes already exist, and a person reading it
    // has to work backwards to the line that caused it.
    //
    // What this check does NOT claim: `backend.kind` is OPTIONAL (see
    // `BackendSchema` — absent means UNSET, and `up`'s precedence is
    // `--backend > backend.kind > DEFAULT_BACKEND`). So this catches the
    // document that SAYS headless; it cannot see a `--backend headless`
    // typed at `up`, which is a different surface with its own reader.
    // `pifleet tui --worker` refuses a headless worker at runtime regardless
    // (`cli/commands/tui.ts`, EXIT.BACKEND_UNAVAILABLE), so the runtime floor
    // is unchanged by this being a partial check — it is an EARLIER refusal
    // for the case the config states outright, not the only one.
    const paneModeIssues = (
      subject: string,
      paneMode: "rpc" | "tui" | undefined,
      kind: "persistent" | "oneshot" | undefined,
      at: Array<string | number>,
    ): void => {
      // Resolved the way `load.ts` resolves them, so what is judged here is
      // what a worker would actually be launched as. Testing the raw key
      // would miss every combination assembled ACROSS levels — which is the
      // shape the read_only guard above was originally caught getting wrong.
      if ((paneMode ?? "rpc") !== "tui") return;

      if ((kind ?? "persistent") === "oneshot") {
        ctx.addIssue({
          code: "custom",
          path: at,
          message:
            `${subject} resolves to pane_mode: tui with kind: oneshot — a oneshot worker ` +
            `runs one container per task as \`pi -p --mode json\` (SRD §6.4), and \`-p\` is ` +
            `Pi's documented non-interactive mode: "process prompt and exit". There is no ` +
            `interactive session for a pane to attach to, and the container is gone before ` +
            `anyone could type into it. Set kind: persistent, or leave pane_mode at rpc.`,
        });
      }

      if (cfg.backend.kind === "headless") {
        ctx.addIssue({
          code: "custom",
          path: at,
          message:
            `${subject} resolves to pane_mode: tui, but backend.kind is headless — a tui ` +
            `worker's pane runs \`docker attach\` on its container (SRD §3.5) and the ` +
            `headless backend creates no pane at all, so there is nothing to attach and no ` +
            `hand could reach the worker. Choose backend.kind cmux or tmux, or leave ` +
            `pane_mode at rpc.`,
        });
      }
    };

    for (const [name, role] of Object.entries(cfg.roles)) {
      paneModeIssues(
        `role "${name}"`,
        role.pane_mode ?? cfg.defaults.pane_mode,
        role.kind ?? cfg.defaults.kind,
        ["roles", name, "pane_mode"],
      );
    }
    // Checked at BOTH levels, like the read_only guard above, because either
    // can complete the combination on its own: a role that pairs them is
    // broken wherever it is copied, and a worker override can pair them
    // against a role that did not.
    cfg.workers.forEach((w, i) => {
      const role = cfg.roles[w.role];
      if (!role) return; // already reported above
      paneModeIssues(
        `worker "${w.id}"`,
        w.pane_mode ?? role.pane_mode ?? cfg.defaults.pane_mode,
        w.kind ?? role.kind ?? cfg.defaults.kind,
        ["workers", i, "pane_mode"],
      );
    });
  });

export type FleetConfig = z.infer<typeof FleetConfigSchema>;

// ---------------------------------------------------------------------------
// Config warnings (SRD-OBSERVER-001 §6.2, §6.6) — deliberately NOT `superRefine`
// ---------------------------------------------------------------------------
//
// Every issue above this point fails `.safeParse`. These two do not, and that
// is the finding rather than an oversight: both name a document a real fleet
// must stay free to run. `sre` ships with `cloud_access: true` and no
// `cloud:` block in THIS file — refusing that would refuse the shipped
// default. `pane_mode: tui` on `observer` is a choice an operator can make on
// purpose — `scripts/operations` reads `resolveWorker(loaded, agent).paneMode
// === "tui"` to decide whether its console owns a pane for exactly this role
// — so a schema that refused it would make that console unbuildable. What
// must not stay silent is the MECHANISM each one gives up, so both compute
// text a caller prints, on `cli/commands/up.ts`'s `unattendedTuiWarning`
// pattern, rather than an issue this schema could add.

/**
 * Resolve one `RoleFields` key through `defaults <- role <- worker`.
 *
 * A second copy of `config/load.ts`'s `pick`, not a shared import: `load.ts`
 * imports FROM this module, and a function down here reaching back up for one
 * three-line helper would be the drifting-copy shape this file's own header
 * warns cross-field rules into `superRefine` to avoid. Three lines kept
 * identical by inspection cost less than the cycle.
 */
function pickRoleField<K extends keyof RoleFields>(
  worker: RoleFields,
  role: RoleFields,
  defaults: RoleFields,
  key: K,
): RoleFields[K] {
  if (worker[key] !== undefined) return worker[key];
  if (role[key] !== undefined) return role[key];
  return defaults[key];
}

/**
 * Worker ids resolving `cloud_access: true` while `cloud.kubeconfig` is unset
 * (§6.6).
 *
 * §6.6 calls the filtered kubeconfig this role's SCOPE FENCE: the mount
 * bounds which clusters a worker holding `bash` and a Google identity can
 * reach, composing with the credential's own IAM scope rather than replacing
 * it (§6.3). Its absence is not a missing convenience — `cloud.kubeconfig:
 * null` mounts nothing, so `kubectl` falls through to whatever default
 * config the image happens to carry, and a worker asked about one
 * environment ends up holding every context the operator has ever
 * authenticated against.
 *
 * Resolved at the WORKER, not the role block, for the reason `paneModeIssues`
 * above is: a worker-level override can complete a grant the role left
 * unset, and a check that only read `roles:` would miss it.
 */
export function workersMissingKubeconfig(cfg: FleetConfig): string[] {
  if (cfg.cloud.kubeconfig !== null) return [];
  const out: string[] = [];
  for (const w of cfg.workers) {
    const role = cfg.roles[w.role];
    if (!role) continue; // an unknown role is already a superRefine issue
    if (pickRoleField(w, role, cfg.defaults, "cloud_access") ?? false) out.push(w.id);
  }
  return out;
}

/**
 * The warning `workersMissingKubeconfig` renders, or `null` when there is
 * nothing to say.
 *
 * Names what is GIVEN UP rather than restating the config, on
 * `unattendedTuiWarning`'s precedent — "warning: no kubeconfig set" sends an
 * operator to re-read §6.6 to find out why that matters, and this sentence is
 * the finding itself.
 */
export function kubeconfigScopeWarning(workerIds: readonly string[]): string | null {
  if (workerIds.length === 0) return null;
  const n = workerIds.length;
  return (
    `warning: ${n} worker(s) resolve cloud_access: true with cloud.kubeconfig unset ` +
    `(${workerIds.join(", ")})\n` +
    `  cloud.kubeconfig is this fleet's scope fence (SRD-OBSERVER-001 §6.6): unset, a worker ` +
    `holding bash and a Google identity falls through to whatever kubeconfig the image happens ` +
    `to carry, rather than a copy filtered to the contexts this fleet's tasks actually name — ` +
    `the gap between a worker scoped to one environment and one holding every context the ` +
    `operator has ever authenticated against. Set cloud.kubeconfig to a filtered copy, or accept ` +
    `that these workers can reach every context it would otherwise exclude.\n`
  );
}

/**
 * Worker ids whose resolved role is literally `observer` and whose resolved
 * `pane_mode` is `tui` (§6.2, §7.5).
 *
 * Keyed to the role's NAME rather than to a property this schema can derive,
 * because the hazard is a fact about what the `observer-ops` skill DOES —
 * repeatedly re-dispatching a near-identical watch task (§7.5) — and nothing
 * in a `RoleFields` object says that. A fleet is free to name its read-only
 * diagnostic role something else and accept a different risk profile; this
 * only watches the name the shipped role actually uses.
 */
export function observerTuiWorkers(cfg: FleetConfig): string[] {
  const out: string[] = [];
  for (const w of cfg.workers) {
    if (w.role !== "observer") continue;
    const role = cfg.roles[w.role];
    if (!role) continue;
    const mode = pickRoleField(w, role, cfg.defaults, "pane_mode") ?? "rpc";
    if (mode === "tui") out.push(w.id);
  }
  return out;
}

/**
 * The warning `observerTuiWorkers` renders, or `null`.
 *
 * NOT a refusal — a fleet may deliberately want this pane visible, and
 * `scripts/operations` already reads `paneMode === "tui"` to decide whether
 * to attach one for exactly this role. What must not stay silent is the
 * mechanism: `tui` allocates no epoch, so there is no `already_completed`
 * fence, and a re-dispatched pass runs the same task twice. An observer
 * watch is BUILT on repeated dispatch of near-identical tasks (§7.5), which
 * makes this the one role least able to afford that gap.
 */
export function observerTuiEpochWarning(workerIds: readonly string[]): string | null {
  if (workerIds.length === 0) return null;
  const n = workerIds.length;
  return (
    `warning: ${n} observer worker(s) resolve pane_mode: tui (${workerIds.join(", ")})\n` +
    `  tui allocates no epoch (SRD-OBSERVER-001 §6.2): there is no already_completed fence, so ` +
    `a re-dispatched pass runs the same task twice. An observer watch is built on repeated ` +
    `dispatch of near-identical tasks (§7.5), which makes this the role least able to afford ` +
    `it. Set pane_mode: rpc unless a person is deliberately driving this pane by hand.\n`
  );
}

/**
 * Worker ids whose resolved `theme` is a name this image cannot resolve.
 *
 * Returned as `{id, theme}` pairs rather than bare ids because the operator's
 * next question is always "what did I type?", and a typo like `dracular` is
 * only diagnosable next to the name that was asked for.
 *
 * Only workers that will actually RENDER a theme are considered — `pane_mode:
 * tui`. The resolution is three-level, so a `defaults.theme` lands on every rpc
 * worker in the fleet as well, and warning about panes that do not exist would
 * bury the one line that matters under a dozen that do not.
 */
export function unknownThemeWorkers(cfg: FleetConfig): { id: string; theme: string }[] {
  const out: { id: string; theme: string }[] = [];
  for (const w of cfg.workers) {
    const role = cfg.roles[w.role];
    if (!role) continue;
    if ((pickRoleField(w, role, cfg.defaults, "pane_mode") ?? "rpc") !== "tui") continue;
    const theme = pickRoleField(w, role, cfg.defaults, "theme");
    if (theme !== undefined && !knownTheme(theme)) out.push({ id: w.id, theme });
  }
  return out;
}

/**
 * The warning `unknownThemeWorkers` renders, or `null`.
 *
 * WARNS rather than refuses, for the reason the `theme` key's own docstring
 * gives: the set of resolvable names is a property of the image, not of this
 * schema, and a fleet refused at parse time over a colour scheme is a worse
 * outcome than a pane that opens in Pi's default. The names are listed because
 * the overwhelmingly likely cause is a spelling — `catppuccin` alone, say,
 * where the bundle distinguishes `catppuccin-mocha` from `catppuccin-latte`.
 */
export function unknownThemeWarning(
  workers: readonly { id: string; theme: string }[],
): string | null {
  if (workers.length === 0) return null;
  const named = workers.map((w) => `${w.id}: "${w.theme}"`).join(", ");
  return (
    `warning: ${workers.length} tui worker(s) name a theme this image does not carry (${named})\n` +
    `  Pi falls back to its default theme, so the pane opens and looks like every other pane — ` +
    `which is the failure this is worth a line about, because two panes meant to be tellable ` +
    `apart quietly stop being so. Known names: ${KNOWN_THEMES.join(", ")}.\n`
  );
}
