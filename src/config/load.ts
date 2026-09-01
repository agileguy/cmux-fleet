import { EXIT } from "../contracts.ts";
/**
 * Config loading, resolution, and the role merge (SRD §6.1).
 *
 * Resolution order: `--config <path>` → `./fleet.yaml` → `~/.config/pifleet/fleet.yaml`.
 *
 * The merge is `defaults ← roles ← per-worker overrides`, shallow, with three
 * explicit exceptions. v1.1 left them implicit and its own worked example could
 * not be produced from its stated rule, so each is implemented here by name:
 *
 *  1. Arrays replace, they never concatenate — except `skills`, where
 *     `pifleet-worker` is re-injected after the merge and cannot be removed:
 *     a role that overrides `skills:` must not silently lose the result
 *     contract (ISC-64, SRD §5.4).
 *  2. A `:thinking` suffix inside a `model` string outranks a `thinking:` key
 *     at ANY level, and decomposes into `--model` + `--thinking`. A
 *     `provider/` prefix decomposes into `--provider`.
 *  3. Relative paths resolve against the config file's directory — not the
 *     cwd and not `run.repo`. A config that renders differently depending on
 *     where the command was typed is not a config.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  FleetConfigSchema,
  ThinkingLevelSchema,
  type FleetConfig,
  type Isolation,
  type RoleFields,
  type ThinkingLevel,
  type ToolName,
  type Toolchain,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  /** A bad or missing config is a usage failure, not a crash (SRD §10). */
  readonly exitCode = EXIT.USAGE;

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface FieldIssue {
  /** Dotted path into the YAML document, e.g. `workers.2.role`. */
  path: string;
  message: string;
}

/** Carries field-level issues so `config validate` can print them (ISC-58). */
export class ConfigValidationError extends ConfigError {
  constructor(
    readonly file: string,
    readonly issues: FieldIssue[],
  ) {
    super(
      `${file}: ${issues.length} validation error${issues.length === 1 ? "" : "s"}\n` +
        issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n"),
    );
    this.name = "ConfigValidationError";
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadedConfig {
  config: FleetConfig;
  /** Absolute path of the file that was loaded. */
  path: string;
  /** Its directory — the base for every relative path in the document (§6.1 rule 3). */
  dir: string;
}

/** Expand a leading `~` and resolve a relative path against `baseDir`. */
export function expandPath(p: string, baseDir: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (isAbsolute(p)) return resolve(p);
  return resolve(baseDir, p);
}

/** SRD §6.1 resolution order. An explicit path that does not exist is an error, not a fallthrough. */
export async function resolveConfigPath(
  explicit?: string,
  cwd: string = process.cwd(),
): Promise<string> {
  if (explicit !== undefined) {
    const p = expandPath(explicit, cwd);
    if (!(await Bun.file(p).exists())) throw new ConfigError(`config not found: ${p}`);
    return p;
  }
  const local = resolve(cwd, "fleet.yaml");
  if (await Bun.file(local).exists()) return local;
  const user = resolve(homedir(), ".config/pifleet/fleet.yaml");
  if (await Bun.file(user).exists()) return user;
  throw new ConfigError(
    "no config found: pass --config, or create ./fleet.yaml or ~/.config/pifleet/fleet.yaml",
  );
}

/** Parse and validate YAML text. Separated from file IO so tests feed strings. */
/**
 * Keys this config format USED to accept, and what to say when one turns up.
 *
 * A removed key is indistinguishable from a typo to a `.strict()` schema, and
 * the two want opposite reactions from a reader: a typo should be corrected, a
 * removal should be deleted. A bare "unrecognized key" tells someone who
 * copied a previous `fleet.example.yaml` that they made a mistake, which is
 * both wrong and a dead end — the key WAS valid, and the fix is to delete the
 * line rather than to hunt for the right spelling.
 *
 * Keyed by the dotted path the unroll in `parseConfig` produces, so a
 * same-named key under a different parent is unaffected.
 */
const REMOVED_KEYS: Record<string, string> = {
  "run.budget.soft_stop_at":
    "removed — it was parsed and never read by any command, so it advertised a soft stop " +
    "the product does not implement (ISC-280). Delete this line; nothing changes, because " +
    "no behaviour was ever attached to it.",
};

export async function parseConfig(text: string, path: string): Promise<LoadedConfig> {
  const { parse } = await import("yaml");
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ConfigValidationError(path, [
      { path: "", message: `not valid YAML: ${(err as Error).message}` },
    ]);
  }
  const result = FleetConfigSchema.safeParse(doc);
  if (!result.success) {
    const issues: FieldIssue[] = result.error.issues.flatMap((i) => {
      // zod reports a stray key at the PARENT's path with a `keys` list; the
      // useful diagnostic names the key itself, so unroll it.
      if (i.code === "unrecognized_keys") {
        return (i as unknown as { keys: string[] }).keys.map((k) => {
          const at = [...i.path.map(String), k].join(".");
          return { path: at, message: REMOVED_KEYS[at] ?? "unrecognized key" };
        });
      }
      return [{ path: i.path.map(String).join("."), message: i.message }];
    });
    throw new ConfigValidationError(path, issues);
  }
  return { config: result.data, path, dir: dirname(path) };
}

export async function loadConfig(
  explicit?: string,
  cwd: string = process.cwd(),
): Promise<LoadedConfig> {
  const path = await resolveConfigPath(explicit, cwd);
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (err) {
    // A file that EXISTS and cannot be read (mode 000, a directory, a dangling
    // symlink) is a bad config, not a bug in the tool. Left as a raw Error it
    // escaped every `instanceof ConfigError` handler in the CLI and exited 8
    // ("internal error"), which crashed `artifacts` and `report` outright
    // while malformed YAML — strictly less recoverable — degraded politely.
    // Same class of operator mistake, so the same class of error.
    throw new ConfigError(
      `config ${path} exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseConfig(text, path);
}

// ---------------------------------------------------------------------------
// Model decomposition (§6.1 rule 2)
// ---------------------------------------------------------------------------

export interface ModelSpec {
  provider: string;
  model: string;
  thinking: ThinkingLevel | undefined;
}

/**
 * Split `provider/model:thinking` into flags.
 *
 * The `:thinking` suffix outranks `mergedThinking` no matter which level the
 * key was set at — the suffix travels with the model string through the merge,
 * so the two are never in a race the reader can't see. The suffix is only
 * honoured when it names a real thinking level: model ids routinely contain
 * `:` -adjacent punctuation and a typo must surface as "unknown model" at the
 * server, not as a silently swallowed suffix.
 *
 * `isTagStyleProvider` turns that suffix parsing off for ONE provider
 * (SRD-INFERENCE-PROVIDERS §2.4 "Defect C", D12). Some vendors spell a model
 * id `name:tag` — Ollama's entire catalogue does, `gpt-oss:120b` and
 * `qwen3.5:397b` — and the six thinking levels are ordinary words in a
 * namespace the VENDOR owns, so a colliding tag is one rename away rather than
 * hypothetical. Measured on the unfixed code, `ollama/some-model:high`
 * resolved to model `some-model` with thinking `high`: the tag was gone and a
 * level had been invented out of it. That failure does not surface here. It
 * surfaces at the far end as `model-not-found` against a name the operator can
 * read back off their `fleet.yaml` and see is correct, which is the most
 * expensive shape a config bug can take.
 *
 * WHY A PREDICATE RATHER THAN A BOOLEAN. The flag belongs to the provider, and
 * the provider is not something the CALLER knows — it is discovered in here,
 * from the `provider/` prefix, falling back to the fleet default. A boolean
 * parameter would oblige every caller to split that prefix itself first, just
 * to decide what to pass, which is a second spelling of the split this
 * function exists to own; ISC-264 is the standing record of what two
 * spellings of one value cost to unpick. A predicate lets the caller answer
 * only once the answer is knowable.
 *
 * It is also the narrowest thing that composes with §6.1's `llm.providers`
 * map, which is a later phase and deliberately NOT built here: when that map
 * lands it feeds this in one line — `(p) => cfg.llm.providers[p]?.tag_style
 * === true` — with no change to this signature and no second reader of the
 * block. Taking the map itself would mean inventing that block's type now, in
 * the one file that must not be the place it is defined.
 *
 * OMITTED means "no provider is tag-style", which is exactly the behaviour
 * this function had before the parameter existed, so every existing caller
 * keeps its meaning unedited.
 *
 * THE PREFIX IS NOW SPLIT FIRST — the two steps traded places, because the
 * provider has to be known before the flag can be consulted about it. The
 * reordering is behaviour-preserving rather than merely believed to be. The
 * only input on which the two orders could diverge is one whose LAST colon
 * sits before the slash and whose suffix still parses as a level; that suffix
 * necessarily contains the slash, and all six levels are single slash-free
 * words, so it can never parse. In the other direction, truncating a trailing
 * `:level` cannot move the FIRST `/`, since a level contains none. Both halves
 * are pinned by tests rather than left as this paragraph.
 */
export function decomposeModel(
  raw: string,
  fallbackProvider: string,
  mergedThinking: ThinkingLevel | undefined,
  isTagStyleProvider?: (provider: string) => boolean,
): ModelSpec {
  let provider = fallbackProvider;
  let model = raw;
  let thinking = mergedThinking;

  const slash = model.indexOf("/");
  if (slash > 0) {
    provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }

  if (!isTagStyleProvider?.(provider)) {
    const colon = model.lastIndexOf(":");
    if (colon !== -1) {
      const suffix = model.slice(colon + 1);
      if (ThinkingLevelSchema.safeParse(suffix).success) {
        thinking = suffix as ThinkingLevel;
        model = model.slice(0, colon);
      }
    }
  }

  return { provider, model, thinking };
}

/**
 * The `tag_style` predicate for one fleet, in the shape `decomposeModel` takes.
 *
 * This is the composition `decomposeModel`'s docstring promises when it argues
 * for a predicate over a boolean, and it is deliberately the ONLY place that
 * reads `tag_style`. Three call sites need the same answer — `resolveWorker`,
 * `assertModelAllowed` and `doctor`'s allowlist verdict — and they must not
 * disagree: `doctor` answering `false` where `up` answers `true` is precisely
 * the shape ISC-256 exists to forbid, a green `doctor` over a config `up`
 * refuses. One function, three callers, no second reading of the flag.
 *
 * A fleet with no `providers` map answers `false` to everything, which is the
 * behaviour every existing config had before the map existed. That is not a
 * defensive default: with no map there is no block to carry the flag, so
 * `false` is the only answer that is actually true.
 */
export function tagStyleProviders(config: FleetConfig): (provider: string) => boolean {
  const providers = config.llm.providers;
  if (providers === undefined) return () => false;
  return (provider) => providers[provider]?.tag_style === true;
}

/**
 * The models allowlist governing ONE provider, from whichever spelling the
 * document used.
 *
 * With a `providers` map the list lives in the block; without one it is the
 * flat key, meaning the block for `llm.provider` (§6.1). ISC-403 refuses both
 * spellings at once, so exactly one of these branches describes any given
 * document and there is no merge to get wrong.
 *
 * Shared by `assertModelAllowed` and by `doctor`, and that sharing is the
 * point rather than a convenience: ISC-256 requires `doctor`'s verdict and
 * `up`'s gate to agree on the same config, and the cheapest way for them to
 * disagree is to read the allowlist from two places while a fleet is being
 * migrated from the flat keys to the map.
 */
export function providerAllowlist(config: FleetConfig, provider: string): readonly string[] {
  const providers = config.llm.providers;
  if (providers === undefined) return config.llm.models_allowlist;
  return providers[provider]?.models_allowlist ?? [];
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/** One briefing fragment, in concatenation order (SRD §6.3). */
export interface BriefingFragment {
  source: "defaults" | "role" | "worker";
  kind: "file" | "inline";
  /** Absolute path for `file` fragments; the text itself for `inline`. */
  value: string;
}

/** A worker after `defaults ← role ← worker`, decomposition, and skill injection. */
export interface ResolvedWorker {
  id: string;
  role: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel | undefined;
  toolchain: Toolchain;
  /** `undefined` means "Pi's default tool set" — the flag is omitted, not empty. */
  tools: ToolName[] | undefined;
  excludeTools: ToolName[] | undefined;
  /** Always contains `pifleet-worker`; order preserved otherwise. */
  skills: string[];
  cloudAccess: boolean;
  /** The CONNECT-proxy route, independent of the Google grant (§5.9). */
  egressAccess: boolean;
  /** Host variable NAMES requested; the intersection with the fleet ceiling is what arrives. */
  secrets: string[];
  isolation: Isolation;
  paneMode: "rpc" | "tui";
  /**
   * Pi TUI colour theme, or `undefined` for Pi's own default.
   *
   * Left OPTIONAL rather than defaulted to `"dark"` here, and the distinction
   * is load-bearing at the other end: `docker/entrypoint.sh` only writes the
   * `theme` key into `settings.json` when this arrives non-empty, so an
   * unset theme leaves whatever the operator selected inside Pi with
   * `/settings` alone. Defaulting it here would silently overwrite that
   * choice on every container start.
   */
  theme?: string;
  kind: "persistent" | "oneshot";
  readOnly: boolean;
  /** defaults → role → worker, file before inline at each level. */
  briefing: BriefingFragment[];
}

/** The name that cannot be merged away — the result contract (SRD §5.4, §14.4). */
export const CONTRACT_SKILL = "pifleet-worker";

function pick<K extends keyof RoleFields>(
  key: K,
  worker: RoleFields,
  role: RoleFields,
  defaults: RoleFields,
): RoleFields[K] {
  // Shallow: the most specific level that SAYS anything wins outright.
  // Arrays therefore replace — a worker's `skills: []` empties the role's
  // list rather than unioning with it (§6.1 rule 1); injection happens after.
  if (worker[key] !== undefined) return worker[key];
  if (role[key] !== undefined) return role[key];
  return defaults[key];
}

function fragmentsFor(
  source: BriefingFragment["source"],
  fields: RoleFields,
  configDir: string,
): BriefingFragment[] {
  const out: BriefingFragment[] = [];
  if (fields.append_system_prompt_file !== undefined) {
    out.push({ source, kind: "file", value: expandPath(fields.append_system_prompt_file, configDir) });
  }
  if (fields.append_system_prompt !== undefined) {
    out.push({ source, kind: "inline", value: fields.append_system_prompt });
  }
  return out;
}

/** Merge one worker. Throws `ConfigError` for an unknown id (roles are schema-checked). */
export function resolveWorker(loaded: LoadedConfig, id: string): ResolvedWorker {
  const { config, dir } = loaded;
  const entry = config.workers.find((w) => w.id === id);
  if (!entry) {
    throw new ConfigError(
      `unknown worker "${id}" — configured workers: ${config.workers.map((w) => w.id).join(", ")}`,
    );
  }
  const role = config.roles[entry.role];
  if (!role) throw new ConfigError(`worker "${id}" names unknown role "${entry.role}"`);
  const d = config.defaults;

  // Exception 1: `pifleet-worker` is re-injected post-merge and cannot be removed.
  const mergedSkills = pick("skills", entry, role, d) ?? [];
  const skills = mergedSkills.includes(CONTRACT_SKILL)
    ? [...mergedSkills]
    : [CONTRACT_SKILL, ...mergedSkills];

  // Exception 2: the `:thinking` suffix in the merged model string outranks the
  // merged `thinking:` key, wherever either was written.
  const mergedModel = pick("model", entry, role, d) ?? config.llm.model;
  const mergedThinking = pick("thinking", entry, role, d) ?? config.llm.thinking;
  const spec = decomposeModel(mergedModel, config.llm.provider, mergedThinking, tagStyleProviders(config));

  /*
   * A NON-EMPTY `model:` can decompose to an EMPTY model, and the failure is
   * completely silent — which is why this refuses here rather than trusting
   * `schema.ts`'s `.min(1)`.
   *
   * `schema.ts` enforces `min(1)` on the raw string, so `model: ""` is already
   * refused. But `omlx/` and `:high` are both non-empty and both decompose to
   * `model: ""` — the prefix split and the thinking strip each consume their
   * side and leave nothing between them. Measured:
   *
   *   "omlx/"      -> { provider: "omlx", model: "" }
   *   ":high"      -> { provider: "omlx", model: "", thinking: "high" }
   *
   * What happens next is the whole reason this is a refusal. `worker-env` sets
   * `PIFLEET_LLM_MODELS=""`, so the entrypoint's
   * `[ -n "${PIFLEET_LLM_MODELS:-}" ]` guard is FALSE and **no `models.json` is
   * written at all** — exit 0, nothing on stderr. `render.ts` still pushes
   * `--model ""`. Nothing in `src/` ever reads the rendered file back, and the
   * container is `--rm`, so "no file", "empty key" and "wrong provider" are
   * indistinguishable from the host. The one thing standing in front of it,
   * `assertModelsSupportToolCalls`, returns early whenever
   * `require_native_tool_calls: false` — a documented, supported setting — and
   * then the fleet comes up clean and can reach no model at all.
   *
   * That is this file's own stated worst case, reachable from a one-character
   * typo, so it fails at parse time naming the worker and the string.
   */
  if (spec.model === "") {
    throw new ConfigError(
      `worker "${entry.id}" has model: "${mergedModel}", which resolves to an empty model name. ` +
        `A "provider/" prefix and a ":thinking" suffix each consume their side of the string; ` +
        `written like this there is nothing left between them. Name a model.`,
    );
  }

  /*
   * ISC-402: a worker cannot resolve to a provider the document never declares.
   *
   * Only when a `providers` map exists. Without one there is nothing to check
   * against — every existing `fleet.yaml` names its provider in the flat keys
   * or not at all — and refusing here would break each of them.
   *
   * The provider reaches this line from one of two places and both must be
   * covered: a `provider/` prefix the operator typed on THIS worker's `model:`,
   * or `llm.provider` inherited when they typed no prefix. The second is the
   * one worth naming, because nothing in the file says the word and the
   * operator is reading a `model:` line that looks complete.
   *
   * Without this, an undeclared provider is not an error at all: it is a name
   * with no block behind it, so `assertModelAllowed` finds no allowlist and
   * constrains nothing, and every later phase that keys on the provider —
   * `base_url`, the credential, the egress network, the relay — resolves
   * against a block that does not exist. The failure surfaces as a worker that
   * cannot reach a model, arbitrarily far from the typo.
   *
   * The message names the FILE because `config validate` may be run against a
   * path the operator did not type, and the FIELD because `model:` and
   * `llm.provider` are different lines to go fix.
   */
  const declared = config.llm.providers;
  if (declared !== undefined && declared[spec.provider] === undefined) {
    const known = Object.keys(declared);
    const wrotePrefix = mergedModel.indexOf("/") > 0;
    const field = wrotePrefix ? `the "${spec.provider}/" prefix on worker "${entry.id}"'s model:` : `llm.provider`;
    throw new ConfigError(
      `worker "${entry.id}" resolves to provider "${spec.provider}", which is not declared in ` +
        `llm.providers in ${loaded.path}. It comes from ${field}. ` +
        (wrotePrefix
          ? ``
          : `The worker's model: "${mergedModel}" names no provider, so it inherits the fleet default. `) +
        `Declared: ${known.length === 0 ? "(none)" : known.map((k) => JSON.stringify(k)).join(", ")}.`,
    );
  }

  return {
    id: entry.id,
    role: entry.role,
    provider: spec.provider,
    model: spec.model,
    thinking: spec.thinking,
    toolchain: pick("toolchain", entry, role, d) ?? "base",
    tools: pick("tools", entry, role, d),
    excludeTools: pick("exclude_tools", entry, role, d),
    skills,
    cloudAccess: pick("cloud_access", entry, role, d) ?? false,
    egressAccess: pick("egress_access", entry, role, d) ?? false,
    // Replace-wins like every other array here (§6.1 rule 1): a worker's
    // `secrets: []` empties the role's request rather than unioning with it.
    // Union would be the wrong default for a capability list — it would make a
    // role's grant impossible to take away at the worker level, which is the
    // direction that must stay easy.
    secrets: [...(pick("secrets", entry, role, d) ?? [])],
    isolation: pick("isolation", entry, role, d) ?? config.run.isolation,
    paneMode: pick("pane_mode", entry, role, d) ?? "rpc",
    // No `?? "dark"`: see the field's docstring — absent means "leave Pi's own
    // selection alone", which is not the same as choosing Pi's default.
    ...(pick("theme", entry, role, d) === undefined ? {} : { theme: pick("theme", entry, role, d)! }),
    kind: pick("kind", entry, role, d) ?? "persistent",
    readOnly: pick("read_only", entry, role, d) ?? false,
    // Briefings CONCATENATE across levels by design — the one deliberate
    // departure from replace-wins, because `--append-system-prompt` is not
    // repeatable and the renderer folds all fragments into one file (ISC-65).
    briefing: [
      ...fragmentsFor("defaults", d, dir),
      ...fragmentsFor("role", role, dir),
      ...fragmentsFor("worker", entry, dir),
    ],
  };
}

/** Every worker, in config order. Length follows `workers:` and nothing else (ISC-61). */
export function resolveAllWorkers(loaded: LoadedConfig): ResolvedWorker[] {
  return loaded.config.workers.map((w) => resolveWorker(loaded, w.id));
}

// ---------------------------------------------------------------------------
// models_allowlist (SRD §5.9; ISC-52, ISC-190)
// ---------------------------------------------------------------------------

/** A worker resolved to a model `llm.models_allowlist` does not name. */
export class ModelNotAllowedError extends ConfigError {
  constructor(
    readonly workerId: string,
    readonly model: string,
    readonly allowlist: readonly string[],
  ) {
    super(
      `worker "${workerId}" resolves to model "${model}", which is not in ` +
        `llm.models_allowlist [${allowlist.join(", ")}] — add it there, or point ` +
        `the worker at a listed model`,
    );
    this.name = "ModelNotAllowedError";
  }
}

/**
 * Refuse a worker whose resolved model is not on `llm.models_allowlist`.
 *
 * The field has been in the schema since v2 and NOTHING read it, so a typo'd
 * or deliberately-swapped `model:` started a worker exactly as if the operator
 * had listed it — the allowlist was documentation. It is the fleet's statement
 * about which models it has probed for native tool calls (§5.9), and a model
 * nobody probed is one that may answer in prose: the cost of discovering that
 * is an hour of a burnt run rather than a second of `up`.
 *
 * An EMPTY list constrains nothing. That is the schema default and the shape
 * of every config that omits the key, so reading it as "no model may run"
 * would refuse fleets nobody asked to refuse.
 *
 * Both sides are compared AFTER §6.1 decomposition, because `provider/` and
 * `:thinking` are flags rather than part of a model's identity. A raw string
 * compare breaks in both directions: `omlx/Qwen3:high` would be refused by a
 * list that names `Qwen3`, and an entry written `omlx/Qwen3` could never match
 * anything — a rule that silently denies what it was written to permit, which
 * is the dead-rule shape `EgressRuleSchema` already refuses to ship.
 */
export function assertModelAllowed(loaded: LoadedConfig, worker: ResolvedWorker): void {
  const { llm } = loaded.config;
  /*
   * ISC-404: the list is the RESOLVED PROVIDER'S, not the fleet's.
   *
   * With a `providers` map the allowlist moved inside the block, and reading
   * the flat key here would have made one fleet-wide list govern every
   * provider — so a model probed against oMLX would authorize the same name on
   * a hosted endpoint that never answered a probe. The allowlist's whole
   * meaning is "these were probed for native tool calls (SRD §5.9)", and a
   * probe is of a (provider, model) PAIR; carrying the verdict across
   * providers is not a widening of the rule, it is a different rule.
   *
   * A declared provider with an empty `models_allowlist` constrains nothing,
   * exactly as the flat key's empty default does. A provider that is not in
   * the map cannot reach here at all — `resolveWorker` refuses it above — so
   * the `?? []` is unreachable-by-construction rather than a fallback with an
   * opinion, and it stays because `??` is cheaper to read than an assertion
   * that restates a guarantee enforced in another function.
   */
  const allowlist = providerAllowlist(loaded.config, worker.provider);
  if (allowlist.length === 0) return;
  /*
   * The fallback provider for an entry that names none: the block's own key
   * with a map, the fleet default without one. Inside `providers.ollama.
   * models_allowlist`, a bare `gpt-oss` means ollama's — there is no other
   * provider that entry could be about — and using the fleet default there
   * would prefix hosted entries with the local provider's name.
   */
  const fallback = llm.providers ? worker.provider : llm.provider;
  const isTagStyle = tagStyleProviders(loaded.config);
  /*
   * ISC-424's GATE HALF. Both sides decompose with the SAME predicate, so on a
   * tag-style provider `p/m:high` and `p/m:low` are two models and the second
   * is refused by a list naming only the first. Before the predicate reached
   * here the tag was eaten on both sides, both became `m`, and the gate
   * admitted a tag variant nobody had probed — the allowlist is the fleet's
   * record of what WAS probed (ISC-190), so admitting an unprobed variant is
   * the gate failing at the one thing it is for. `doctor` reads the same flag
   * through the same helper, which is what keeps its verdict and this refusal
   * from disagreeing.
   */
  const permitted = allowlist.map((e) => decomposeModel(e, fallback, undefined, isTagStyle).model);
  if (permitted.includes(worker.model)) return;
  throw new ModelNotAllowedError(worker.id, worker.model, allowlist);
}
