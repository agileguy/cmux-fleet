/**
 * `triage/targets.yaml` — the triage console's service registry, and the fence
 * that bounds what it can reach (SRD-TRIAGE-CONSOLE §7.1, §6.2, §6.10, D11).
 *
 * `pifleet.triagetargets/v1`. A tracked, diffable inventory of the
 * environments and services one sweep visits, so that *"adding an environment
 * or a service is a YAML edit and nothing else"* (§6.2 property 1). It is not
 * `fleet.yaml` — that file is `.strict()` over the FLEET's contract and is
 * gitignored, so a service list there is untracked and undispatchable — and it
 * is not argv, because 288 invocations a day against a list nobody can review
 * is an inventory with no history.
 *
 * ## Two properties carry this module, and neither is the field list
 *
 * **1. `kube_context` is a FENCE, so the value that has not been fenced is not
 * spellable.** §6.10 calls the filtered kubeconfig *"the strongest fence this
 * role has"* because *"it bounds reachability rather than intent"*, and D11
 * turns `schema.ts:1772`'s existing WARNING into this console's REFUSAL: a
 * console reading a live environment 288 times a day must not be able to reach
 * an environment nobody wrote down.
 *
 * A comment saying "call the fence before you use this" is worth nothing,
 * because the misuse is one property access — `targets.environments` — and no
 * comment survives contact with a caller in a hurry. So the asymmetry is spent
 * on the TYPES, on `pm-state.ts`'s precedent:
 *
 *   - **`parseTriageTargets` does not return the document.** It returns an
 *     {@link UnfencedTriageTargets}, which is the document with `environments`
 *     REMOVED and re-exposed as `environments_unchecked_against_kubeconfig`.
 *     The convenient name does not exist at runtime or at the type level, so
 *     the misuse does not compile and does not evaluate; the available name
 *     states exactly what the value is.
 *   - **{@link fenceTriageTargets} is the only thing here that can produce
 *     `environments`, and it takes the reach as a REQUIRED parameter.** There
 *     is no default argument and no overload without it, so "load it without
 *     checking" is not spellable.
 *   - **{@link ConsoleReach} has no arm meaning "everything".** A kubeconfig
 *     the fleet never declared is `undeclared`, which REFUSES; a declared
 *     kubeconfig carrying no contexts is a declared reach over the empty set,
 *     which also refuses. The degenerate reading — an empty allowlist that
 *     admits every context — is the one shape a subset check fails silently
 *     in, and it is unrepresentable rather than merely untaken.
 *
 * **2. Two of the three refusals span two files, so their messages name two
 * files.** `default_window` lives here and `cadence_s` lives in
 * `triage/console.yaml` (§7.8); `sweep_deadline_s` is derived from that file
 * and bounded against it. §12: *"a refusal naming one file when two disagree
 * sends the operator to the wrong editor."* So the cadence and the deadline
 * arrive as parameters together with BOTH file names, rather than this module
 * importing a config it does not own.
 *
 * ## The I/O is one injected dep, and the decisions are pure
 *
 * {@link parseTriageTargets}, {@link kubeContextIssues}, {@link windowIssues},
 * {@link sweepDeadlineIssue} and {@link fenceTriageTargets} take no
 * filesystem, so every refusal above is gradeable at unit speed without a
 * disk, a cluster or a kubeconfig. Only {@link loadTriageTargets} reads, and it
 * reads through {@link TriageTargetsDeps} — the house pattern named as a type,
 * exactly as `DockerPsRun` is (`src/monitor/read/docker.ts:122`) and as
 * §13 task 3.3 names `TriageConfigRead` for the neighbouring module.
 *
 * A MISSING targets file is an ERROR here, which is the deliberate opposite of
 * `triage/console.yaml`, where §7.8 makes a missing file resolve to defaults.
 * The difference is what each file holds: console.yaml holds tuning values
 * that HAVE documented defaults, and this file holds the inventory, for which
 * the only possible default is "sweep nothing" — a console that starts and
 * watches nothing is the failure this file exists to make impossible.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { ConfigValidationError, type FieldIssue } from "../config/load.ts";
import { durationSeconds } from "../config/schema.ts";
import { SESSION_ID_RE } from "../contracts.ts";

// ---------------------------------------------------------------------------
// The schema (§7.1)
// ---------------------------------------------------------------------------

/** The document tag §7.1 names. Checked by NAME, never inferred. */
export const TRIAGE_TARGETS_SCHEMA = "pifleet.triagetargets/v1";

/**
 * The closed check vocabulary (§6.2 property 4).
 *
 * A CLOSED enum rather than free strings, and that is a security property
 * rather than a tidiness one: *"the observers' procedures are `observer-ops`';
 * the targets file selects among them and cannot extend them."* A free string
 * here is a tracked file that can carry a command into a worker holding a
 * cloud identity.
 */
export const TRIAGE_CHECKS = ["rollout", "logs", "sink", "endpoint"] as const;
export type TriageCheck = (typeof TRIAGE_CHECKS)[number];

/** §7.1's cap on one environment's service list. */
export const MAX_SERVICES_PER_ENVIRONMENT = 64;

const shortStr = z.string().min(1).max(4096);

/**
 * An environment key or a service name.
 *
 * `SESSION_ID_RE` because §7.1 says the environment key *"becomes part of a
 * path under `~/.pifleet/triage/`"* — so this bound is a traversal refusal,
 * not a naming convention. `../../etc` and `a/b` are the cases it exists for.
 */
const triageToken = z
  .string()
  .min(1)
  .max(64)
  .regex(
    SESSION_ID_RE,
    "must be a bare token ([A-Za-z0-9] with . _ - inside) — it becomes a path segment " +
      "under ~/.pifleet/triage/, so a name carrying a slash, a space or a leading dot is a " +
      "directory traversal rather than a label",
  );

export const TriageServiceSchema = z
  .object({
    /** The logical service name — `mia`, `authorization`, `authentication`. */
    name: triageToken,
    /** DECLARED, never derived (§6.2 rule 2). */
    namespace: shortStr,
    /**
     * OPTIONAL, and `null` is a deliberate choice rather than a gap: it hands the
     * workload to the observer to identify, which is right whenever one service is
     * several deployments or the operator does not want to pin a name that drifts.
     * The namespace is still DECLARED (§6.2 rule 2) — what is delegated is which
     * workload inside it, never which cluster or which namespace.
     */
    workload: shortStr.nullable().default(null),
    checks: z.array(z.enum(TRIAGE_CHECKS)).min(1).max(TRIAGE_CHECKS.length),
    /** Per-service override of the environment's `default_window`. */
    window: durationSeconds.nullable().default(null),
  })
  .strict()
  .superRefine((service, ctx) => {
    /*
     * A duplicated check is a duplicated read against a live control plane,
     * 288 times a day. §6.10 rule 1 spends its whole argument on read
     * amplification, so the same check twice is refused rather than deduped
     * silently — a file that says something twice usually means something
     * else once.
     */
    const seen = new Set<string>();
    service.checks.forEach((check, i) => {
      if (seen.has(check)) {
        ctx.addIssue({
          code: "custom",
          path: ["checks", i],
          message:
            `duplicate check "${check}" — every check is a read against a live control ` +
            `plane on every sweep (§6.10 rule 1), so listing one twice doubles that read`,
        });
      }
      seen.add(check);
    });
  });

export const TriageEnvironmentSchema = z
  .object({
    /**
     * DECLARED, never derived, and fenced (§6.2 rule 2, §6.10).
     *
     * Validated here only for SHAPE. Whether the fleet can actually reach it
     * is {@link kubeContextIssues}, because the answer lives in a different
     * file.
     */
    kube_context: shortStr,
    /**
     * §6.10 rule 1's default, and the reason it is `5m` rather than something
     * generous: *"a six-hour log window re-read every five minutes is 72x the
     * necessary read volume against a live logging API, and it is the obvious
     * default a person would write."*
     */
    default_window: durationSeconds.prefault("5m"),
    services: z.array(TriageServiceSchema).min(1).max(MAX_SERVICES_PER_ENVIRONMENT),
  })
  .strict()
  .superRefine((environment, ctx) => {
    const firstAt = new Map<string, number>();
    environment.services.forEach((service, i) => {
      const first = firstAt.get(service.name);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["services", i, "name"],
          message:
            `duplicate service name "${service.name}" — already declared at services.${first}. ` +
            `The name keys this service's incident state (§6.8), so two rows sharing one name ` +
            `are two services sharing one incident`,
        });
      } else {
        firstAt.set(service.name, i);
      }
    });
  });

export const TriageTargetsSchema = z
  .object({
    version: z.literal(1),
    environments: z.record(z.string(), TriageEnvironmentSchema),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const names = Object.keys(doc.environments);
    if (names.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["environments"],
        message:
          "at least one environment is required — a targets file with none is a console that " +
          "starts, sweeps nothing, and reports healthy",
      });
    }
    /*
     * Validated here rather than as `z.record`'s key schema so the issue's
     * PATH names the offending key itself. `schema.ts:1540` tests
     * `SESSION_ID_RE` the same way and for the same reason.
     */
    for (const name of names) {
      const result = triageToken.safeParse(name);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: ["environments", name],
          message: `invalid environment key "${name}": ${result.error.issues[0]?.message ?? "invalid"}`,
        });
      }
    }
  });

export type TriageService = z.infer<typeof TriageServiceSchema>;
export type TriageEnvironment = z.infer<typeof TriageEnvironmentSchema>;
export type TriageEnvironments = Readonly<Record<string, TriageEnvironment>>;

// ---------------------------------------------------------------------------
// The two document types, and why there are two
// ---------------------------------------------------------------------------

/**
 * A targets file that PARSED and has NOT been checked against the fleet's
 * kubeconfig.
 *
 * The field is named for what it is. `environments` does not exist on this
 * type, so a caller that skipped the fence cannot reach an environment through
 * a name that reads as if it had been checked.
 */
export interface UnfencedTriageTargets {
  readonly version: 1;
  /** The file these bytes came from — every refusal downstream names it. */
  readonly source_path: string;
  readonly environments_unchecked_against_kubeconfig: TriageEnvironments;
}

/** A targets file that passed every §6.10 fence. Only {@link fenceTriageTargets} makes one. */
export interface TriageTargets {
  readonly version: 1;
  readonly source_path: string;
  readonly environments: TriageEnvironments;
}

// ---------------------------------------------------------------------------
// The reach — D11's fence, as a value with no permissive arm
// ---------------------------------------------------------------------------

/**
 * What the fleet's `cloud.kubeconfig` lets this console reach.
 *
 * Two arms, and the absent third is the design: there is no `unbounded`. The
 * ONLY way to satisfy the fence is to declare a kubeconfig and name a context
 * it carries, so an empty context set refuses everything rather than admitting
 * everything — which is the exact shape a subset check degenerates into when
 * "the allowlist is empty" and "there is no allowlist" share a
 * representation.
 */
export type ConsoleReach =
  | {
      readonly kind: "declared";
      /** `cloud.kubeconfig`, as resolved — named in every refusal. */
      readonly kubeconfigPath: string;
      readonly contexts: ReadonlySet<string>;
    }
  | { readonly kind: "undeclared" };

/** The reach a fleet with `cloud.kubeconfig` set has. */
export function declaredReach(kubeconfigPath: string, contexts: Iterable<string>): ConsoleReach {
  return { kind: "declared", kubeconfigPath, contexts: new Set(contexts) };
}

/** The reach a fleet with `cloud.kubeconfig: null` has. D11 refuses it. */
export function undeclaredReach(): ConsoleReach {
  return { kind: "undeclared" };
}

/** Both file names, so a cross-file refusal can send the operator to the right editor. */
export interface TriageFileNames {
  /** `triage/targets.yaml`. */
  readonly targets: string;
  /** `triage/console.yaml`. */
  readonly console: string;
}

/** Everything §6.10 needs that does not live in this file. */
export interface TriageFence {
  readonly reach: ConsoleReach;
  /** `cadence_s` from `triage/console.yaml` (§7.8). */
  readonly cadenceS: number;
  /** `cadence_s - reserve_s`, computed by §7.8's `sweepDeadlineS`. */
  readonly sweepDeadlineS: number;
  readonly files: TriageFileNames;
}

// ---------------------------------------------------------------------------
// The refusals (§6.10) — pure, so each is gradeable without a cluster
// ---------------------------------------------------------------------------

/** At most this many contexts are quoted back before the list is elided. */
const MAX_CONTEXTS_LISTED = 12;

function listContexts(contexts: ReadonlySet<string>): string {
  const sorted = [...contexts].sort();
  if (sorted.length === 0) return "(none)";
  if (sorted.length <= MAX_CONTEXTS_LISTED) return sorted.join(", ");
  return `${sorted.slice(0, MAX_CONTEXTS_LISTED).join(", ")}, … (${sorted.length} total)`;
}

/**
 * D11's fence: every `kube_context` this file names must be one the fleet's
 * `cloud.kubeconfig` actually carries (§6.10).
 *
 * The direction matters and is stated rather than implied: the file's contexts
 * must be a SUBSET of the kubeconfig's. The reverse — a kubeconfig whose every
 * context is named here — is a different and useless property, and it is the
 * inversion a symmetric fixture cannot catch.
 */
export function kubeContextIssues(
  environments: TriageEnvironments,
  reach: ConsoleReach,
): FieldIssue[] {
  const names = Object.keys(environments);
  if (reach.kind === "undeclared") {
    /*
     * One ROOT issue rather than one per environment: nothing in this file is
     * wrong, the fleet is. `schema.ts:1772` warns about this today; D11 makes
     * it a refusal for this console, because unset, `kubectl` falls through to
     * whatever kubeconfig the image happens to carry and a console asked about
     * one environment holds every context the operator ever authenticated
     * against.
     */
    return [
      {
        path: "",
        message:
          `cloud.kubeconfig is unset in the fleet config, and the triage console REQUIRES it ` +
          `(D11, §6.10). Unset, kubectl falls through to whatever kubeconfig the image happens ` +
          `to carry, so this file's ${names.length} environment(s) (${names.join(", ")}) would ` +
          `not be bounded by anything. Set cloud.kubeconfig to a filtered copy carrying exactly ` +
          `the contexts this file names.`,
      },
    ];
  }
  const issues: FieldIssue[] = [];
  for (const name of names) {
    const context = environments[name]!.kube_context;
    if (reach.contexts.has(context)) continue;
    issues.push({
      path: `environments.${name}.kube_context`,
      message:
        `"${context}" is not carried by the fleet's cloud.kubeconfig ` +
        `(${reach.kubeconfigPath}), which carries: ${listContexts(reach.contexts)}. ` +
        `The filtered kubeconfig bounds reachability rather than intent (§6.10), so a targets ` +
        `file naming a context it does not carry is refused at load rather than discovered at ` +
        `the first kubectl. Add the context to the kubeconfig, or remove this environment.`,
    });
  }
  return issues;
}

/**
 * §6.10 rule 1: no observation window may exceed the sweep cadence — and a
 * per-service override may not exceed its environment's `default_window`.
 *
 * The cadence rule is about READ AMPLIFICATION, so it applies to the
 * per-service override exactly as it applies to the environment default — a
 * `6h` window on one service re-read every five minutes is the same 72x
 * against the same logging API, and an override that escaped the rule would be
 * the obvious way around it.
 *
 * **The override's own bound is tighter than the cadence, and the reason is
 * §7.4 rather than §6.10** (resolved by the operator 2026-09-06). An observer
 * echoes ONE `window_opened_at` for the whole artifact, and §7.4 bounds it by
 * `dispatched_at − default_window − reserve_s`. So a service whose override is
 * WIDER than `default_window` makes a truthful observer fail an artifact-level
 * check — discarding every row that observer produced, including rows for
 * services carrying no override at all. Bounding the override by
 * `default_window` is what makes §7.4's table correct as written.
 *
 * The alternative — bounding §7.4 by the widest override in the observer's
 * share — was refused: it makes the check as weak as the loosest service that
 * observer happens to hold, which is exactly the *"queried six hours against a
 * five-minute configuration"* failure §7.4 exists to catch. It would leave the
 * check in place and quietly stop it working.
 *
 * **What this narrows, stated rather than buried.** A genuinely sparse service
 * can no longer be given a window wider than its environment's default. If that
 * need arrives, the answer is to move `window_opened_at` onto the ROW beside
 * the `window` field §6.7 already gates — §7.4's argument against a per-row
 * check (*"a wrong window applies to every row"*) holds only while there is one
 * window per artifact.
 *
 * The cadence bound reaches the override transitively, because
 * `default_window ≤ cadence_s` is enforced in this same pass. The explicit
 * cadence branch below is therefore reachable only when `default_window` is
 * ITSELF out of bounds — a file that is already refused, whose every fault is
 * still worth naming by path.
 *
 * EQUAL is allowed in both directions: §6.2's own worked example sets
 * `default_window: 5m` against a 300 s cadence, and a window that exactly
 * covers the interval since the last sweep is the correct one. Only GREATER is
 * a re-read.
 */
export function windowIssues(
  environments: TriageEnvironments,
  cadenceS: number,
  files: TriageFileNames,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const why = (windowS: number, path: string) =>
    `${path.split(".").pop()} is ${windowS}s, which is greater than the sweep cadence of ` +
    `${cadenceS}s (cadence_s in ${files.console}). A window wider than the cadence re-reads ` +
    `the same ${Math.round((windowS / cadenceS) * 10) / 10}x of history on every sweep against a ` +
    `live API (§6.10 rule 1). Lower it in ${files.targets}, or raise cadence_s in ` +
    `${files.console}.`;

  const whyOverride = (windowS: number, defaultS: number, path: string) =>
    `window is ${windowS}s, which is greater than the environment's default_window of ` +
    `${defaultS}s (${files.targets}). An observer echoes ONE window_opened_at for the whole ` +
    `artifact, and §7.4 bounds it by the default_window — so an override wider than the default ` +
    `makes a truthful observer fail that check and discards EVERY row it produced, including ` +
    `rows for services with no override. Lower it, or raise default_window for the environment ` +
    `(which must itself stay within cadence_s in ${files.console}).`;

  for (const [name, environment] of Object.entries(environments)) {
    if (environment.default_window > cadenceS) {
      const path = `environments.${name}.default_window`;
      issues.push({ path, message: why(environment.default_window, path) });
    }
    environment.services.forEach((service, i) => {
      if (service.window === null) return;
      const path = `environments.${name}.services.${i}.window`;
      if (service.window > environment.default_window) {
        issues.push({
          path,
          message: whyOverride(service.window, environment.default_window, path),
        });
      } else if (service.window > cadenceS) {
        issues.push({ path, message: why(service.window, path) });
      }
    });
  }
  return issues;
}

/**
 * §6.5's refusal: a sweep deadline must leave room before the next tick.
 *
 * §7.8 property 1 makes this UNREACHABLE by construction — `sweep_deadline_s`
 * is computed as `cadence_s - reserve_s` and never configured, and
 * `reserve_s.min(15)` makes the deadline strictly smaller. This function is
 * what says that rather than a comment claiming it: the property is checked on
 * the values the loader actually holds, so a future change to either bound
 * fails here instead of silently allowing a sweep that overruns its own tick.
 */
export function sweepDeadlineIssue(
  sweepDeadlineS: number,
  cadenceS: number,
  files: TriageFileNames,
): FieldIssue | null {
  if (sweepDeadlineS < cadenceS) return null;
  return {
    path: "",
    message:
      `the sweep deadline (${sweepDeadlineS}s) is not less than the cadence (${cadenceS}s), so a ` +
      `sweep can still be running when the next tick fires — §6.4's skip rule would then skip ` +
      `every tick forever. sweep_deadline_s is COMPUTED as cadence_s - reserve_s and is not a ` +
      `field (§7.8 property 1): raise reserve_s or cadence_s in ${files.console}. This bound is ` +
      `checked against the environments in ${files.targets}, which are what a sweep visits.`,
  };
}

/**
 * Apply every §6.10 fence, or refuse with ALL of them.
 *
 * Every issue is collected before the throw rather than short-circuiting on
 * the first: an operator editing two files should see both disagreements in
 * one pass, and `config validate`'s whole shape (`load.ts:56-66`) is a list of
 * field-level issues rather than the first one.
 */
export function fenceTriageTargets(
  targets: UnfencedTriageTargets,
  fence: TriageFence,
): TriageTargets {
  const environments = targets.environments_unchecked_against_kubeconfig;
  const deadline = sweepDeadlineIssue(fence.sweepDeadlineS, fence.cadenceS, fence.files);
  const issues: FieldIssue[] = [
    ...kubeContextIssues(environments, fence.reach),
    ...windowIssues(environments, fence.cadenceS, fence.files),
    ...(deadline === null ? [] : [deadline]),
  ];
  if (issues.length > 0) throw new ConfigValidationError(targets.source_path, issues);
  return { version: targets.version, source_path: targets.source_path, environments };
}

// ---------------------------------------------------------------------------
// Parsing — pure, and every failure names the file
// ---------------------------------------------------------------------------

/**
 * Parse and validate the bytes of a `triage/targets.yaml`.
 *
 * `safeParse` plus an explicit `ConfigValidationError` rather than a bare
 * `.parse`, on `load.ts:130-155`'s precedent: a raw `ZodError` names a field
 * path and no file, and this file is one of three a `config validate` pass
 * reads. The `unrecognized_keys` unroll is the same one `parseConfig` does,
 * because zod reports a stray key at the PARENT's path and the useful
 * diagnostic names the key itself — §7.1's *"an unknown key is a field-level
 * error, never an ignored typo"*.
 */
export function parseTriageTargets(text: string, path: string): UnfencedTriageTargets {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ConfigValidationError(path, [
      { path: "", message: `not valid YAML: ${(err as Error).message}` },
    ]);
  }
  const result = TriageTargetsSchema.safeParse(doc);
  if (!result.success) {
    const issues: FieldIssue[] = result.error.issues.flatMap((i) => {
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
  return {
    version: result.data.version,
    source_path: path,
    environments_unchecked_against_kubeconfig: result.data.environments,
  };
}

/**
 * The context NAMES a kubeconfig carries.
 *
 * Deliberately total and deliberately narrow: it reads `contexts[].name` and
 * nothing else, and a document with no `contexts` yields the EMPTY list rather
 * than throwing. Empty then flows into {@link kubeContextIssues} as a declared
 * reach over no contexts, which refuses every environment by name — the fence
 * failing CLOSED. Throwing here would instead surface as "could not read the
 * kubeconfig", which reads like a transient problem and invites a retry.
 */
export function parseKubeContexts(text: string, path: string): string[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ConfigValidationError(path, [
      { path: "", message: `kubeconfig is not valid YAML: ${(err as Error).message}` },
    ]);
  }
  const contexts = (doc as { contexts?: unknown } | null)?.contexts;
  if (!Array.isArray(contexts)) return [];
  return contexts
    .map((c) => (c as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

// ---------------------------------------------------------------------------
// Loading — the only part that touches a disk, and it does so through a dep
// ---------------------------------------------------------------------------

/** The read, and nothing but the read. `null` means the file does not exist. */
export type TriageTargetsRead = (path: string) => Promise<string | null>;

/** The kubeconfig's context names, read from wherever `cloud.kubeconfig` points. */
export type KubeContextRead = (kubeconfigPath: string) => Promise<readonly string[]>;

export interface TriageTargetsDeps {
  readonly readText: TriageTargetsRead;
  readonly readKubeContexts: KubeContextRead;
}

/** The real reads, taken through an optional ports object exactly as `DockerPsRun` is. */
export const DEFAULT_TRIAGE_TARGETS_DEPS: TriageTargetsDeps = {
  readText: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  },
  readKubeContexts: async (kubeconfigPath) =>
    parseKubeContexts(await Bun.file(kubeconfigPath).text(), kubeconfigPath),
};

export interface LoadTriageTargetsOptions {
  /** `triage/targets.yaml`, resolved. */
  readonly targetsPath: string;
  /** `triage/console.yaml`, resolved — named in the cross-file refusals only. */
  readonly consolePath: string;
  /** The fleet's `cloud.kubeconfig`, resolved, or `null` when it is unset. */
  readonly kubeconfigPath: string | null;
  /** `cadence_s` (§7.8). */
  readonly cadenceS: number;
  /** `sweepDeadlineS(cfg)` (§7.8). */
  readonly sweepDeadlineS: number;
  readonly deps?: Partial<TriageTargetsDeps>;
}

/**
 * Read, parse and fence in one call — what `pifleet config validate` and the
 * triage actor both want, and the only shape either of them gets.
 *
 * The kubeconfig is NOT read when `cloud.kubeconfig` is null: there is no path
 * to read, and D11's refusal is about the fleet's configuration rather than
 * about the kubeconfig's contents.
 */
export async function loadTriageTargets(opts: LoadTriageTargetsOptions): Promise<TriageTargets> {
  const deps: TriageTargetsDeps = { ...DEFAULT_TRIAGE_TARGETS_DEPS, ...opts.deps };
  const text = await deps.readText(opts.targetsPath);
  if (text === null) {
    throw new ConfigValidationError(opts.targetsPath, [
      {
        path: "",
        message:
          "no triage targets file — the console's inventory has no default (§7.1). Unlike " +
          `${opts.consolePath}, whose absence resolves to documented defaults, an absent ` +
          "targets file would start a console that sweeps nothing and reports healthy.",
      },
    ]);
  }
  const parsed = parseTriageTargets(text, opts.targetsPath);
  const reach =
    opts.kubeconfigPath === null
      ? undeclaredReach()
      : declaredReach(opts.kubeconfigPath, await deps.readKubeContexts(opts.kubeconfigPath));
  return fenceTriageTargets(parsed, {
    reach,
    cadenceS: opts.cadenceS,
    sweepDeadlineS: opts.sweepDeadlineS,
    files: { targets: opts.targetsPath, console: opts.consolePath },
  });
}
