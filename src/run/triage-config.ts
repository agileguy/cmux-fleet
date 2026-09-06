/**
 * `triage/console.yaml` — the console's nine tuning knobs, the notification
 * channel, and the refusal that keeps a credential out of a tracked file
 * (SRD-TRIAGE-CONSOLE §7.8, §6.9, D14; §13 tasks 3.3 and 3.4).
 *
 * `pifleet.triageconsole/v1`. The sibling of `triage-targets.ts` and
 * deliberately its twin: same parse/fence split, same injected read, same rule
 * that every refusal names the file it came from. The two files are separate
 * because they change on different clocks — §7.8's blast-radius argument: the
 * targets file is edited often, and this one holds the two values whose
 * accidental edit costs the most, the cadence and the endpoint.
 *
 * ## Four properties carry this module, and none of them is the field list
 *
 * **1. A MISSING file and an EMPTY file are one code path, not two that agree.**
 * §7.8 makes an absent file resolve to the schema's defaults, *"which is what
 * makes the default endpoint the default rather than a thing an operator must
 * type"*, and §12 demands both arms be asserted — *"'the default endpoint' is
 * only true if an operator who writes no file gets it."* Two arms that must
 * produce the same value are two arms that will one day disagree, so
 * {@link loadTriageConsoleConfig} does not have a defaults branch at all: it
 * turns a missing file into the EMPTY STRING and hands it to
 * {@link parseTriageConsoleConfig}, whose empty-document arm is the only place
 * defaults are produced. The equality is structural rather than tested into
 * existence.
 *
 * An empty document is the only shape that may omit `version`. A file that says
 * anything at all must declare which contract it is written against, because
 * that is the entire job of a version tag; a file that says NOTHING is
 * indistinguishable from the file that was never written, and §7.8 has already
 * decided what that means.
 *
 * **2. `sweep_deadline_s` is not a field, and `.strict()` is what enforces it.**
 * §7.8 property 1: it is COMPUTED as `cadence_s − reserve_s`
 * ({@link sweepDeadlineS}), and *"a redundant field is a field that will one day
 * disagree."* Writing the key is therefore a field-level error on `fleet.yaml`'s
 * own rule (`schema.ts:4-7`), which is why the `unrecognized_keys` unroll below
 * is not cosmetic: zod reports a stray key at the PARENT's path, and a refusal
 * that says `(root): Unrecognized key` when the operator wrote
 * `sweep_deadline_s` sends them looking for a typo they did not make.
 *
 * The bound that makes §6.5's `sweep_deadline_s ≥ cadence_s` refusal
 * *unreachable* is `reserve_s.min(15)`. The bound in the OTHER direction is not
 * free and is not reachable-by-construction: `reserve_s: 600` against
 * `cadence_s: 60` is inside both fields' ranges and computes a deadline of
 * −540 s, a console every sweep of which is late before it starts. That is
 * {@link reserveFitsCadenceIssue}, and it is a real refusal rather than a
 * comment claiming one.
 *
 * **3. `token_env` CALLS the fleet's guard; it does not restate it.**
 * `envVarNameIssue` (`src/config/schema.ts:672`) is an exported function for
 * exactly this reason, and its own docblock (`:649-666`) records the measured
 * cost of the alternative: an inline copy on one door left the second door bare,
 * and `api_key_env: PIFLEET_LLM_MODELS` parsed and wrote a credential into
 * `models.json` as a model id. `notify.token_env` is the THIRD door into that
 * namespace. It gets the reserved-prefix and reserved-name refusals for free by
 * calling the function, and — the part a copy would not survive — a change to
 * the shared rule reaches this field automatically.
 *
 * **4. The endpoint refusal does not itself leak the credential it refuses.**
 * {@link notifyEndpointIssue} exists because `triage/console.yaml` is TRACKED,
 * `~/.pifleet/triage.log` appends and is never truncated (§7.7), and
 * `pifleet triage --status` prints the endpoint — so a token in the URL is a
 * secret in git history, in a log nobody rotates, and on a terminal. ntfy
 * documents an `?auth=<token>` query form (`docs.ntfy.sh/publish/`), which makes
 * that the spelling an operator who reads the docs will reach for, and the
 * schema is the only thing that can catch them before git does.
 *
 * A refusal is printed by `config validate` and written to the same appended
 * log, so **the messages below never echo the part of the URL most likely to be
 * the secret**: the userinfo case quotes the URL with the userinfo masked, the
 * query case quotes no part of the query at all (a bare `?tk_abc…` has the
 * token as the parameter NAME, so listing names is not safe either), and the
 * unparseable case quotes nothing, because a string that will not parse cannot
 * be redacted. Refusing a credential in a message that publishes it would be the
 * same defect one layer down.
 *
 * ## The I/O is one injected dep, and the decisions are pure
 *
 * {@link notifyEndpointIssue}, {@link reserveFitsCadenceIssue},
 * {@link sweepDeadlineS} and {@link parseTriageConsoleConfig} take no
 * filesystem, so every refusal here is gradeable at unit speed without a disk.
 * Only {@link loadTriageConsoleConfig} reads, and it reads through
 * {@link TriageConfigRead} — the house pattern named as a type, exactly as
 * `DockerPsRun` is (`src/monitor/read/docker.ts:122`) and as `triage-targets.ts`
 * does with `TriageTargetsRead`.
 *
 * ## Two deviations from §7.8's written sketch, both deliberate
 *
 * - **`parseTriageConsoleConfig` takes `(text, path)`, not `(text)`.** The path
 *   is not I/O — it is the label every `ConfigValidationError` carries, and
 *   `config validate` reads three files in one pass (§7.8). A refusal that names
 *   no file is a refusal the operator has to guess at. Same signature as
 *   `parseTriageTargets`.
 * - **`notifyEndpointIssue` returns `string | null` rather than being a
 *   `superRefine` callback, and the schema does not chain `.url()` in front of
 *   it.** `envVarNameIssue` — the function §7.8 tells this field to reuse — has
 *   exactly that shape, and so do `sweepDeadlineIssue` and `kubeContextIssues`
 *   next door: in this tree an `…Issue` function returns the message or `null`.
 *   It also makes the function directly gradeable without a fake refinement
 *   context. `.url()` is dropped because zod v4 runs a trailing `superRefine`
 *   even after a failed string check (measured), so keeping it produces TWO
 *   issues on one path for one defect — and the second of them would be the bare
 *   `"Invalid URL"` that property 4 above is written against.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { ConfigValidationError, type FieldIssue } from "../config/load.ts";
import { envVarNameIssue } from "../config/schema.ts";

// ---------------------------------------------------------------------------
// The notification endpoint (§6.9, §7.8; task 3.4)
// ---------------------------------------------------------------------------

/** The document tag §7.8 names. Checked by NAME, never inferred. */
export const TRIAGE_CONSOLE_SCHEMA = "pifleet.triageconsole/v1";

/**
 * §6.9's measured default, and the spelling is the load-bearing part.
 *
 * Checked on this host 2026-09-06: `ntfy.agileguy.ca` resolves and
 * `GET /v1/health` returns `{"healthy":true}`, while `agleguy.ca` — the spelling
 * the commission used — is **NXDOMAIN**. A console defaulting to the typo would
 * have failed DNS on every notification forever, which is a failure whose only
 * symptom is silence from the thing whose entire output is messages.
 *
 * An anonymous read of this topic returned **403**, so the shipped default is an
 * endpoint that will refuse until {@link NotifyConfigSchema}'s `token_env` is
 * set. That is deliberate and §11 Q11 records it: the alternative is a baked-in
 * credential, which is the exact thing {@link notifyEndpointIssue} exists to
 * refuse from the other direction.
 */
export const DEFAULT_NOTIFY_ENDPOINT = "https://ntfy.agileguy.ca/Alerts";

/**
 * The two schemes an endpoint may carry.
 *
 * A second spelling of `schema.ts:594`'s private constant of the same name, and
 * the duplication is recorded rather than hidden: that one is not exported, this
 * module owns two files this round, and a cross-module import for a two-element
 * set would be the wrong trade. The RULE is identical for the same reason — this
 * value is not stored, it is dialed.
 */
const HTTP_SCHEMES = new Set(["http:", "https:"]);

const shortStr = z.string().min(1).max(4096);

/**
 * The three §7.8 property 3 rules, as a refusal rather than as advice.
 *
 * Total by construction: an unparseable string is refused here rather than
 * deferred to a `.url()` that would say less. Returns the message, or `null`
 * when the endpoint is acceptable — `envVarNameIssue`'s shape
 * (`src/config/schema.ts:672`), which is the convention for an `…Issue`
 * function in this tree.
 *
 * **No message quotes the part of the value most likely to be a secret.** See
 * property 4 in the module docblock: this text is printed by `config validate`
 * and written to `~/.pifleet/triage.log`, which appends forever.
 *
 * Order is §7.8's own — scheme, then userinfo, then query — and the first match
 * wins, because each fixture in §12's probe carries exactly one defect and a
 * list of every way one URL is wrong is a worse message than the first way.
 */
export function notifyEndpointIssue(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return (
      `notify.endpoint is not a URL. The value is deliberately not quoted back here — a string ` +
      `that will not parse cannot be redacted, and this message is printed by ` +
      `\`pifleet config validate\` and written to ~/.pifleet/triage.log, which appends and is ` +
      `never truncated (§7.7). Write an http: or https: URL; for ntfy the topic is the path, as ` +
      `in ${DEFAULT_NOTIFY_ENDPOINT}.`
    );
  }
  if (!HTTP_SCHEMES.has(url.protocol)) {
    return (
      `notify.endpoint must be an http: or https: URL; its scheme is '${url.protocol}'. The ` +
      `endpoint is POSTed to VERBATIM on every incident transition (§6.9), so this is not a ` +
      `stored string — it is the request this console issues, and a scheme that is not HTTP is ` +
      `one \`fetch\` cannot make.`
    );
  }
  if (url.username !== "" || url.password !== "") {
    return (
      `notify.endpoint must not carry userinfo — it is written as ` +
      `${url.protocol}//***@${url.host}${url.pathname}, and the part masked there is a ` +
      `CREDENTIAL IN A TRACKED FILE. triage/console.yaml is committed, ~/.pifleet/triage.log ` +
      `appends forever and is never truncated (§7.7), and \`pifleet triage --status\` prints ` +
      `this endpoint. Put the token in the host environment and name the variable in ` +
      `notify.token_env, which is the only door this console has for a secret (§6.9 ` +
      `requirement 4).`
    );
  }
  if (url.search !== "") {
    return (
      `notify.endpoint must not carry a query string. ntfy documents an \`?auth=<token>\` form ` +
      `(docs.ntfy.sh/publish/), and this refusal exists BECAUSE it is documented: an operator ` +
      `who finds that page will reach for it, and triage/console.yaml is tracked, so the next ` +
      `commit puts the token in git history — and every sweep writes it to ` +
      `~/.pifleet/triage.log, which appends forever (§7.7). The query is not quoted back here, ` +
      `because it is the part most likely to be the secret. Move the token to the host ` +
      `environment and name the variable in notify.token_env (§6.9 requirement 4).`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// The notify block (§7.8)
// ---------------------------------------------------------------------------

/** ntfy priority: *"1=min, 3=default and 5=max"* — `docs.ntfy.sh/publish/`. */
const NtfyPriority = z.number().int().min(1).max(5);

/**
 * The four priorities, one per announcement kind (§7.8's table).
 *
 * `open` and `console_health` are high; a recovery is not worth a long vibration
 * burst at 3 a.m., which is why `recover` and `flapping` sit at ntfy's default.
 */
export const NotifyPrioritySchema = z
  .object({
    open: NtfyPriority.default(4),
    recover: NtfyPriority.default(3),
    flapping: NtfyPriority.default(3),
    console_health: NtfyPriority.default(4),
  })
  .strict();

/**
 * `notify.token_env` — a NAME, guarded by the fleet's own function.
 *
 * The body is `schema.ts:698-702`'s `apiKeyEnvName` verbatim, and that is the
 * point: the four lines that adapt a message into a zod issue are duplicated,
 * and the RULES — which prefixes and which names are refused — are not. `field`
 * is only the label the message carries; the issue's path names the location.
 */
const envVarName = (field: string) =>
  shortStr.superRefine((name, ctx) => {
    const message = envVarNameIssue(name, field);
    if (message !== null) ctx.addIssue({ code: "custom", message });
  });

export const NotifyConfigSchema = z
  .object({
    /**
     * The URL POSTed to, VERBATIM. For ntfy the topic is this path (§6.9).
     *
     * Defaulted, because §7.8's table gives this field a default and the
     * alternative reads badly: without one, an operator who writes
     * `notify: {token_env: NTFY_TOKEN}` — the single most likely edit anyone
     * makes to this block, since §11 Q11 says the shipped endpoint needs a
     * credential — would be refused for omitting a value they did not want to
     * change, and would fix it by pasting the endpoint back in. A default the
     * operator has to retype is a default that becomes a typo.
     */
    endpoint: shortStr
      .superRefine((raw, ctx) => {
        const message = notifyEndpointIssue(raw);
        if (message !== null) ctx.addIssue({ code: "custom", message });
      })
      .default(DEFAULT_NOTIFY_ENDPOINT),
    /**
     * A CLOSED enum on §6.2 rule 4's reasoning: a closed set cannot acquire a
     * third member by accident, and the set is small enough that every member
     * has a criterion. `ntfy` POSTs a plain-text body to the topic URL; `json`
     * POSTs the typed envelope. A body TEMPLATE is refused in §6.9 — a
     * configurable composition is a configurable injection guard.
     */
    adapter: z.enum(["ntfy", "json"]).default("ntfy"),
    /**
     * `AbortSignal.timeout()`. §6.9 requirement 2, and it is not defensive: an
     * unbounded `fetch` inside a serial `relayPass` is a half-open socket with
     * no natural end, so the pass blocks, the console stops sweeping, and the
     * operator's only evidence is silence.
     */
    timeout_ms: z.number().int().min(1_000).max(30_000).default(5_000),
    /** A NAME. The value is read from the host environment; never written here. */
    token_env: envVarName("notify.token_env").nullable().default(null),
    /** The backoff cap, in sweeps. §6.9 requirement 6 — 12 is an hour at the default cadence. */
    max_retry_sweeps: z.number().int().min(1).max(288).default(12),
    priority: NotifyPrioritySchema.prefault({}),
  })
  .strict();

export type NotifyConfig = z.infer<typeof NotifyConfigSchema>;

/**
 * §7.8's shipped notification block — DERIVED from the schema, never restated.
 *
 * Written as a parse of the EMPTY block rather than as an object literal, so
 * this constant cannot drift from what the schema produces. The drift it
 * forecloses is not hypothetical: `notify:` absent takes this value and
 * `notify: {}` takes the schema's field defaults, so a literal here would be a
 * second copy of every default that an operator could reach by writing one key.
 */
export const DEFAULT_NOTIFY: NotifyConfig = NotifyConfigSchema.parse({});

// ---------------------------------------------------------------------------
// The document (§7.8)
// ---------------------------------------------------------------------------

/**
 * §6.5's other bound, and unlike `sweep_deadline_s ≥ cadence_s` this one is
 * REACHABLE.
 *
 * `reserve_s.min(15)` makes the deadline strictly smaller than the cadence, so
 * §6.5's refusal is unreachable by construction (§7.8 property 1). Nothing makes
 * it POSITIVE: `reserve_s: 600` and `cadence_s: 60` are each inside their own
 * field's range and together compute a deadline of −540 s — a console whose
 * every sweep is over its deadline before the first `kubectl`, and whose
 * `max_consecutive_skips` counter therefore trips forever.
 *
 * Refused at the document rather than at either field, because neither field is
 * wrong alone. Returns the message, or `null`. §7.8's sketch calls this
 * `reserveFitsCadence`; the `…Issue` spelling is the tree's convention for a
 * pure refusal and is what lets it be graded without a refinement context.
 */
export function reserveFitsCadenceIssue(cadenceS: number, reserveS: number): string | null {
  if (reserveS < cadenceS) return null;
  return (
    `reserve_s (${reserveS}s) must be less than cadence_s (${cadenceS}s). sweep_deadline_s is ` +
    `COMPUTED as cadence_s - reserve_s and is not a field (§7.8 property 1), so these two values ` +
    `give a sweep deadline of ${cadenceS - reserveS}s — every sweep would be over deadline ` +
    `before it started. Lower reserve_s or raise cadence_s.`
  );
}

export const TriageConsoleConfigSchema = z
  .object({
    version: z.literal(1),
    /** §6.4's tick. `--cadence` overrides it for a hand-run and does not persist. */
    cadence_s: z.number().int().min(60).max(3_600).default(300),
    /** The margin `sweep_deadline_s` is derived against. §6.5. */
    reserve_s: z.number().int().min(15).max(600).default(60),
    /** Fifteen minutes of not sweeping, at the default cadence. Raises `sweeps_skipped` (§6.8a). */
    max_consecutive_skips: z.number().int().min(1).max(24).default(3),
    /** Four hours. `0` disables — the setting for measuring §11 Q5. §6.6. */
    recycle_after_sweeps: z.number().int().min(0).max(1_000).default(48),
    flap_threshold: z.number().int().min(2).max(20).default(3),
    flap_window_s: z.number().int().min(300).max(86_400).default(3_600),
    /**
     * Six hours. `0` disables. **The knob that undoes the design if it is set
     * small** — §6.8 and §8 both say so, and these bounds constrain it but
     * cannot protect it.
     */
    renotify_after_s: z.number().int().min(0).max(604_800).default(21_600),
    /**
     * `null` DISABLES the channel without disabling the console (§6.9
     * requirement 7). Absent takes {@link DEFAULT_NOTIFY}.
     *
     * The default is produced through a FUNCTION so that every parse gets its
     * own object: zod returns a value default by reference, and a parsed config
     * that aliases an exported constant is one whose mutation reaches every
     * other parse in the process.
     */
    notify: NotifyConfigSchema.nullable().default(() => structuredClone(DEFAULT_NOTIFY)),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const message = reserveFitsCadenceIssue(cfg.cadence_s, cfg.reserve_s);
    if (message !== null) ctx.addIssue({ code: "custom", path: ["reserve_s"], message });
  });

export type TriageConsoleConfig = z.infer<typeof TriageConsoleConfigSchema>;

/**
 * The document an operator who wrote no file gets — the schema's own defaults,
 * produced by parsing the one field that has none.
 *
 * A function rather than a constant for the aliasing reason above, and derived
 * rather than written out so that §12's *"the shipped defaults are the
 * documented ones"* is a property of the schema instead of a second copy of it.
 */
export function defaultTriageConsoleConfig(): TriageConsoleConfig {
  return TriageConsoleConfigSchema.parse({ version: 1 });
}

/**
 * `cadence_s − reserve_s`. COMPUTED, never configured (§7.8 property 1).
 *
 * Takes the two fields structurally rather than a whole
 * {@link TriageConsoleConfig}, on `schema.ts:553-558`'s precedent and because
 * §12's probe calls it that way: `sweepDeadlineS({cadence_s: 300, reserve_s: 60})
 * === 240`. A caller holding a full config satisfies it; a test does not have to
 * build eight irrelevant fields to check one subtraction.
 *
 * `triage-targets.ts`'s `sweepDeadlineIssue` is the other half — this produces
 * the value, that one checks the bound it must satisfy against the cadence.
 */
export function sweepDeadlineS(cfg: { cadence_s: number; reserve_s: number }): number {
  return cfg.cadence_s - cfg.reserve_s;
}

// ---------------------------------------------------------------------------
// Parsing — pure, and every failure names the file
// ---------------------------------------------------------------------------

/**
 * Parse and validate the bytes of a `triage/console.yaml`.
 *
 * An EMPTY document — an empty file, or one holding only comments — is the
 * operator who wrote no configuration, and resolves to
 * {@link defaultTriageConsoleConfig}. It is the only shape that may omit
 * `version`: a file that says anything must declare which contract it is written
 * against, and a file that says nothing is the file that was never written,
 * whose meaning §7.8 has already fixed.
 *
 * Everything else is an ERROR and the actor refuses to start, *"because a
 * console running on half a config is a console whose cadence nobody knows"*
 * (§7.8). The `unrecognized_keys` unroll is `parseTriageTargets`' and
 * `parseConfig`'s (`load.ts:130-155`), and it is what makes the
 * `sweep_deadline_s` refusal name `sweep_deadline_s` rather than `(root)`.
 */
export function parseTriageConsoleConfig(text: string, path: string): TriageConsoleConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ConfigValidationError(path, [
      { path: "", message: `not valid YAML: ${(err as Error).message}` },
    ]);
  }
  if (doc === null || doc === undefined) return defaultTriageConsoleConfig();

  const result = TriageConsoleConfigSchema.safeParse(doc);
  if (!result.success) {
    const issues: FieldIssue[] = result.error.issues.flatMap((i) => {
      if (i.code === "unrecognized_keys") {
        return (i as unknown as { keys: string[] }).keys.map((k) => ({
          path: [...i.path.map(String), k].join("."),
          message:
            k === "sweep_deadline_s"
              ? "unrecognized key — sweep_deadline_s is COMPUTED as cadence_s - reserve_s and " +
                "is not a field (§7.8 property 1). A value that must always equal a function of " +
                "two others is one that will one day disagree with them; raise reserve_s to " +
                "shorten the deadline."
              : "unrecognized key",
        }));
      }
      return [{ path: i.path.map(String).join("."), message: i.message }];
    });
    throw new ConfigValidationError(path, issues);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Loading — the only part that touches a disk, and it does so through a dep
// ---------------------------------------------------------------------------

/** The read, and nothing but the read. `null` means the file does not exist. */
export type TriageConfigRead = (path: string) => Promise<string | null>;

export interface TriageConfigDeps {
  readonly readText: TriageConfigRead;
}

/** The real read, taken through an optional ports object exactly as `DockerPsRun` is. */
export const DEFAULT_TRIAGE_CONFIG_DEPS: TriageConfigDeps = {
  readText: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  },
};

export interface LoadTriageConsoleConfigOptions {
  /** `triage/console.yaml`, resolved. Named in every refusal. */
  readonly configPath: string;
  readonly deps?: Partial<TriageConfigDeps>;
}

/**
 * Read and parse, with a missing file resolving to the defaults.
 *
 * **There is no defaults branch here.** A missing file becomes the empty string
 * and goes through the same parse an empty file does, so §12's *"a missing file
 * resolves to the same values"* is structural rather than a second arm that has
 * to be kept in step. The deliberate opposite of `loadTriageTargets`, where a
 * missing file is an error — §7.1 has no possible default for an inventory, and
 * §7.8 has a documented one for every knob.
 */
export async function loadTriageConsoleConfig(
  opts: LoadTriageConsoleConfigOptions,
): Promise<TriageConsoleConfig> {
  const deps: TriageConfigDeps = { ...DEFAULT_TRIAGE_CONFIG_DEPS, ...opts.deps };
  const text = await deps.readText(opts.configPath);
  return parseTriageConsoleConfig(text ?? "", opts.configPath);
}
