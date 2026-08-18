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
        return (i as unknown as { keys: string[] }).keys.map((k) => ({
          path: [...i.path.map(String), k].join("."),
          message: "unrecognized key",
        }));
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
 */
export function decomposeModel(
  raw: string,
  fallbackProvider: string,
  mergedThinking: ThinkingLevel | undefined,
): ModelSpec {
  let provider = fallbackProvider;
  let model = raw;
  let thinking = mergedThinking;

  const colon = model.lastIndexOf(":");
  if (colon !== -1) {
    const suffix = model.slice(colon + 1);
    if (ThinkingLevelSchema.safeParse(suffix).success) {
      thinking = suffix as ThinkingLevel;
      model = model.slice(0, colon);
    }
  }

  const slash = model.indexOf("/");
  if (slash > 0) {
    provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }

  return { provider, model, thinking };
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
  isolation: Isolation;
  paneMode: "rpc" | "tui";
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
  const spec = decomposeModel(mergedModel, config.llm.provider, mergedThinking);

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
    isolation: pick("isolation", entry, role, d) ?? config.run.isolation,
    paneMode: pick("pane_mode", entry, role, d) ?? "rpc",
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
  const allowlist = loaded.config.llm.models_allowlist;
  if (allowlist.length === 0) return;
  const fallback = loaded.config.llm.provider;
  const permitted = allowlist.map((e) => decomposeModel(e, fallback, undefined).model);
  if (permitted.includes(worker.model)) return;
  throw new ModelNotAllowedError(worker.id, worker.model, allowlist);
}
