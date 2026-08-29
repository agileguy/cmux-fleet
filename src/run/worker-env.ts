/**
 * The worker container's `--env-file` (SRD §5.6, §12.4) — the last unwritten
 * container input.
 *
 * ## Why this module exists
 *
 * `config/render.ts` pushes `--env-file <run>/workers/<id>/env` UNCONDITIONALLY
 * and nothing wrote that path, so every `docker run` the fleet could have
 * issued would have died on `docker: open …/env: no such file or directory`
 * before the container existed. That was deliberate rather than forgotten —
 * `materialize.ts`'s header argued that an EMPTY env file is semantically wrong
 * where an empty `cloud-allow` is right, and that leaving the path missing
 * makes a premature launch fail loudly instead of quietly. This module is the
 * real writer that argument was waiting for, so the tripwire can come out
 * without the failure mode it guarded against coming back.
 *
 * ## The contract is not invented here
 *
 * `docker/entrypoint.sh` states it, and it is the authority because it is the
 * code that consumes these names: it renders `~/.pi/agent/models.json` from
 * them before exec'ing Pi, because Pi reads oMLX provider configuration from
 * that FILE and registers a provider only when the models list is non-empty.
 * Get these names wrong and the failure is not a crash — it is a worker that
 * "streams tokens happily and can reach no model at all", which is that
 * script's own description and is exactly the kind of quiet wrongness the
 * missing-file tripwire existed to prevent.
 *
 * ## What must NEVER be in here
 *
 * Any Google credential. `security/adc.ts:tokenModeStartupEnv` says why in one
 * line — this file lands in `<run-dir>` and is read back by `status` and
 * `report`, so a token written here is a credential in a durable artifact that
 * outlives the container it was scoped to. Only the POINTER
 * (`CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`) belongs here; the token itself arrives at
 * runtime through `docker exec`, which leaves no artifact.
 *
 * The oMLX key is the deliberate exception and is not an inconsistency: SRD
 * §12.4 classifies it as Class 1 — no billing authority, no cloud identity, no
 * data at rest — and says plainly that it "is injected as an env var". The
 * §5.9 erratum narrows the claim to "no value off this LAN" for a LAN oMLX and
 * accepts that as a residual. So it is a secret, but a bounded one, and it is
 * the ONLY secret this file may carry.
 *
 * ## Mode 0600, and why that is not in tension with the container's uid
 *
 * `--env-file` is parsed by the DOCKER CLIENT on the host, not by anything
 * inside the container: Docker reads the file and passes the resulting
 * key/value pairs over its API. So unlike `/policy/cloud-allow` or the
 * briefing — which are bind-mounted and therefore must be readable by uid
 * 10001 — this file is never opened by the worker and does not go through
 * `container/mounts.ts`. Nothing is lost by keeping it operator-only, and a
 * file holding even a Class 1 key should not be 0644 in a run directory.
 */

import { writeFile, chmod } from "node:fs/promises";
import type { LoadedConfig, ResolvedWorker } from "../config/load.ts";
import { ConfigError } from "../config/load.ts";
import { CREDENTIAL_ENV_VARS, tokenModeStartupEnv } from "../security/adc.ts";
import {
  LEGACY_RELAY_LISTEN_ALIAS,
  PROXY_LISTEN_ALIAS,
  PROXY_LISTEN_PORT,
  RELAY_LISTEN_ALIAS,
} from "../security/relay.ts";
import { SECRET_NAMES_VAR } from "../security/redact.ts";

/**
 * `docker run --env-file` has no quoting and no escapes.
 *
 * Docker splits each line at the FIRST `=` and takes the entire remainder,
 * verbatim, as the value — no quote stripping, no backslash handling. Two
 * consequences drive `serializeEnvFile` below:
 *
 *  - A newline in a value does not escape, it TERMINATES the line, and the
 *    remainder becomes a new declaration. That is env-var injection through a
 *    config value, so it is refused rather than escaped — there is no escape
 *    to apply.
 *  - A `=` in a value is fine and needs nothing, because only the first one
 *    separates. `base_url` contains none today, but a query string would.
 */
const NEWLINE = /[\r\n]/;

/** A key Docker will accept as an identifier; anything else is a bug upstream. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface WorkerEnvPlan {
  /** The variables, in insertion order — the file is written in this order. */
  vars: Record<string, string>;
  /**
   * True when the configured `llm.api_key_env` was absent or empty in the host
   * environment.
   *
   * Reported rather than thrown, and NOT defaulted to a placeholder: whether a
   * missing oMLX key is fatal is a question about the run (a probe against a
   * keyless local server is legitimate), while silently writing `KEY=` would
   * produce the "reaches no model at all" failure deep inside the container.
   * The caller decides; this module makes the fact visible.
   */
  missingApiKey: boolean;
  /** The var name that was missing, for a diagnostic that can name it. */
  apiKeyEnvName: string;
  /**
   * The host variables delivered under `secrets:`, BY NAME, in request order.
   *
   * A `string[]` of names and not a map, and that is a type-level guarantee
   * rather than a convention: every reporting surface in this repo — the
   * stderr note in `materialize.ts`, anything a future ledger row would carry
   * — reads THIS field, and it is structurally incapable of holding a value.
   * A caller that wants to log what a worker was granted cannot reach a secret
   * by accident, because the object it is handed does not contain one.
   */
  secretNames: string[];
}

// ---------------------------------------------------------------------------
// secrets.env_allowlist ∩ the worker's request (SRD §5.6, §12.4)
// ---------------------------------------------------------------------------

/**
 * A worker asked for a name the fleet's ceiling does not carry.
 *
 * REFUSED, not dropped. A silently-omitted variable is the §5.9 quiet-failure
 * shape in its purest form: the worker starts, runs, and dies inside whatever
 * network call needed the value, minutes later and nowhere near the config
 * line that caused it. The refusal costs a second at `up`.
 */
export class SecretNotAllowlistedError extends ConfigError {
  constructor(
    readonly workerId: string,
    /** `varName`, not `name`: `name` is `Error`'s own field and this would shadow it. */
    readonly varName: string,
    readonly allowlist: readonly string[],
  ) {
    super(
      `worker "${workerId}" requests secret ${varName}, which secrets.env_allowlist does not ` +
        `carry [${allowlist.join(", ") || "empty"}] — the fleet-wide allowlist is a ceiling, ` +
        `so add ${varName} there as well, or drop it from the worker's secrets:`,
    );
    this.name = "SecretNotAllowlistedError";
  }
}

/**
 * A name cleared the intersection and the host environment has no value for it.
 *
 * Scoped to the INTERSECTION and deliberately not to the whole allowlist. The
 * ceiling is a statement about what the fleet PERMITS, not a promise that
 * every permitted name is set on every machine — reading it the other way
 * would refuse a run because of a variable nobody asked for, which is the
 * dead-rule shape `assertModelAllowed` already declines to ship ("an empty
 * list constrains nothing... refusing fleets nobody asked to refuse"). What is
 * refused here is the case that actually produces a broken worker: a value a
 * worker asked for, was permitted, and will not get.
 *
 * Empty counts as absent, on the `missingApiKey` precedent one block up:
 * writing `NAME=` hands the container an empty string, and every `[ -n ... ]`
 * guard downstream then behaves as if the variable were set.
 */
export class SecretMissingFromHostError extends ConfigError {
  constructor(
    readonly workerId: string,
    readonly missing: readonly string[],
  ) {
    super(
      `worker "${workerId}" is allowed secrets [${missing.join(", ")}] which are unset or ` +
        `empty in this environment — the worker would launch without them and fail inside ` +
        `whatever call needs them, so set them before \`up\` or remove them from its secrets:`,
    );
    this.name = "SecretMissingFromHostError";
  }
}

/**
 * A requested name is one THIS MODULE already owns.
 *
 * `secrets.env_allowlist`'s own comment says "NEVER provider keys — see §12.4",
 * and a comment is not a control. Without this refusal the key is a second
 * route to exactly the material §12.4 keeps on separate paths: allowlist
 * `CLOUDSDK_AUTH_ACCESS_TOKEN`, request it from a role, and a worker with
 * `cloud_access: false` is handed a Google credential out of the operator's
 * shell — through a file that lands in the run directory and is read back by
 * `status` and `report`, which is precisely what this module's header forbids.
 *
 * REFUSED rather than shadowed. Assignment order alone would already protect
 * the fleet's variables (secrets are applied last and could be made to lose),
 * but "your config line did nothing" is the silent half of the same failure.
 * An operator who wrote it meant it, and needs to be told it cannot happen.
 */
export class SecretReservedNameError extends ConfigError {
  constructor(
    readonly workerId: string,
    /** See `SecretNotAllowlistedError.varName` on why this is not `name`. */
    readonly varName: string,
  ) {
    super(
      `worker "${workerId}" requests secret ${varName}, which the fleet itself assigns — ` +
        `provider keys, Google credentials, the proxy route and PIFLEET_*/GIT_CONFIG_* ` +
        `have their own paths (SRD §12.4) and secrets: must not become a second one`,
    );
    this.name = "SecretReservedNameError";
  }
}

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
const RESERVED_PREFIXES = ["PIFLEET_", "GIT_CONFIG_", "CLOUDSDK_", "GOOGLE_"] as const;

/**
 * The proxy route, in every spelling — including `HTTP_PROXY`, which this
 * module deliberately never sets. Listing an unset variable is the point: a
 * worker that could set `HTTP_PROXY` through `secrets:` would advertise a
 * cleartext capability the proxy answers `405` to, undoing the reasoning in
 * the ISC-263 block by way of a config key.
 */
const RESERVED_PROXY_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

/**
 * Build the env plan for one resolved worker. Pure — the host environment is a
 * parameter, so the same inputs produce the same file on any machine and the
 * test does not have to mutate `process.env`.
 */
export function buildWorkerEnv(
  loaded: LoadedConfig,
  w: ResolvedWorker,
  hostEnv: Record<string, string | undefined>,
): WorkerEnvPlan {
  const { llm, cloud } = loaded.config;
  const apiKeyEnvName = llm.api_key_env;
  const apiKey = hostEnv[apiKeyEnvName];

  const vars: Record<string, string> = {
    // The three the entrypoint reads to render models.json.
    PIFLEET_LLM_PROVIDER: llm.provider,
    PIFLEET_LLM_BASE_URL: llm.base_url,
    /*
     * The worker's OWN model, not `llm.models_allowlist`.
     *
     * The allowlist is a GATE — what `up` will permit a worker to be
     * configured with (ISC-190) — and registering all of it would hand every
     * worker a provider entry for models it is not allowed to use, which is
     * the opposite of what that check is for. One worker runs one model.
     */
    PIFLEET_LLM_MODELS: w.model,
    /*
     * Arms the escape-attempt honeypot (ISC-125). Unconditional: every worker
     * is watched, and there is no config switch to turn it off, because an
     * operator-visible "this run was not watched" state that an operator can
     * cause on purpose is a state nobody will ever look at.
     *
     * It travels here rather than as a `-e` flag for the reason the block
     * below gives at length: `buildDockerArgv` emits NO `-e` at all and
     * `test/unit/container-env.test.ts` asserts the count is ZERO, so that
     * adding one of any name has to be a deliberate act.
     *
     * A worker cannot unset this. The env file is written on the host, under
     * the run directory, and is not on any mount the container can reach; by
     * the time the worker exists, `docker/entrypoint.sh` has already read the
     * variable and started the listener.
     */
    PIFLEET_HONEYPOT: "1",
    /*
     * WHICH of this file's entries are credentials, by name.
     *
     * Declared HERE, empty, and filled in at the bottom of this function once
     * the intersection has run. The placement is not cosmetic: `reserved` is
     * built from `Object.keys(vars)` at the intersection, so declaring the key
     * before that line is what makes a worker unable to request this name and
     * hand the supervisor its own list. (`PIFLEET_` is a reserved prefix as
     * well; this is belt to that brace, and it survives an edit to the prefix
     * list.)
     *
     * Its consumer is `security/redact.ts`, which the supervisor arms at
     * startup so a granted value is scrubbed out of every `events.jsonl`
     * append — the control that exists because a worker told twice, in a role
     * prompt and in a mounted skill, not to echo its token echoed it on its
     * second command.
     *
     * NAMES AND VALUES SHARE ONE FILE ON PURPOSE. A sibling `secret-names.
     * json` would be a second artifact written by a second call, and its
     * failure mode is a redactor armed against a name whose value it no longer
     * holds — reporting itself armed while scrubbing nothing. One file written
     * by one call cannot drift.
     */
    [SECRET_NAMES_VAR]: "",
  };

  /*
   * ISC-298's SECOND blocker, and the one that hides behind the first.
   *
   * Widening the checkout (`prepareWorktreePermissions`) fixes the filesystem
   * half. It does not touch git, which refuses on OWNERSHIP and ignores mode
   * entirely (CVE-2022-24765): on a Linux Docker host a bind mount passes host
   * ownership through, the container runs as the baked uid 10001, and `status`,
   * `add`, `commit` and `diff` all answer `fatal: detected dubious ownership in
   * repository at '/workspace'` on a tree that is world-writable. A worker in
   * that state can WRITE its files and cannot COMMIT them — strictly worse than
   * the failure the widening fixed, because the agent's work looks done and
   * lands nowhere.
   *
   * ## Why it is here and not on the argv
   *
   * The obvious home is `buildDockerArgv`, beside the mount it exists for, as
   * three `-e` flags. ISC-31 forbids that and is right to: `buildDockerArgv`
   * emits NO `-e` at all, and `test/unit/container-env.test.ts` asserts the
   * count is ZERO rather than "none of them is a secret" — precisely so that
   * adding one of any name has to be a deliberate act rather than a diff
   * nobody reads. That guard caught this on the first full run, with the `-e`
   * form already written. Delivering a non-secret constant that way would have
   * been a safe instance of an unsafe precedent, and the alternative costs
   * nothing: every worker variable already travels through `--env-file`, so
   * this rides the path that exists instead of opening a second one.
   *
   * Env rather than `git config --global` because the container's root
   * filesystem is read-only (SRD §5.6) — there is no writable `$HOME` for a
   * gitconfig to land in. `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` is git's own
   * supported mechanism and needs no file anywhere.
   *
   * Scoped to `/workspace`, the CONTAINER path — deliberately not `*`, the
   * form most answers to this error reach for, which disables the check for
   * every repository the container can see rather than the one tree a worker
   * has business in.
   *
   * Emitted for `shared-ro` as well as `worktree`: that mount is the
   * operator's OWN checkout, owned by the operator, so a read-only role
   * running `git log` meets the identical refusal. `none` has no `/workspace`
   * to name and gets nothing — a setting emitted unconditionally is one
   * nobody notices has stopped tracking the mount it exists for.
   */
  if (w.isolation !== "none") {
    vars["GIT_CONFIG_COUNT"] = "1";
    vars["GIT_CONFIG_KEY_0"] = "safe.directory";
    vars["GIT_CONFIG_VALUE_0"] = "/workspace";
  }

  // Class 1 (SRD §12.4). Written even when empty is NOT an option — see
  // `missingApiKey` — so the key is omitted entirely rather than written blank,
  // and the entrypoint's `[ -n "${…:-}" ]` guards then behave identically to a
  // genuinely unset variable instead of seeing an empty string.
  if (apiKey !== undefined && apiKey !== "") vars[apiKeyEnvName] = apiKey;

  /*
   * Class 2 — POINTERS ONLY, and only for a worker that opted in.
   *
   * `cloud_access: false` must be OBSERVABLE as the absence of the whole
   * CREDENTIAL_ENV_VARS set, not merely of whichever var the current default
   * mode happens to use (adc.ts). Gating the entire block on `w.cloudAccess`
   * is what keeps that assertion non-vacuous.
   *
   * ## The proxy route LEFT this block on 2026-08-28, and the invariant above
   * ## is exactly what decided where it went
   *
   * `HTTPS_PROXY` and friends used to be assigned inside this `if`, which made
   * one flag mean two things: "holds a Google identity" AND "may reach an
   * allowed host through the CONNECT proxy". A worker needing only the second
   * could not have it without being handed the first, so the cheap capability
   * was sold at the price of the expensive one.
   *
   * They are now under `w.cloudAccess || w.egressAccess`, below. Everything
   * Google — `CLOUDSDK_CORE_PROJECT` and `tokenModeStartupEnv()` — stayed
   * here, gated on `w.cloudAccess` ALONE, and that is the whole of what
   * protects the invariant this comment opens with: the CREDENTIAL_ENV_VARS
   * set is still absent for every worker without the grant, including one that
   * now holds the route. The route was never part of that set; ISC-263 added
   * it to the same `if` because at the time no other flag could reach it.
   */
  if (w.cloudAccess) {
    if (cloud.quota_project !== null) vars["CLOUDSDK_CORE_PROJECT"] = cloud.quota_project;
    // `adc_mode` has one value (ISC-268 removed `file`), so this reads as a
    // tautology today. It is kept as a branch rather than collapsed because
    // the record it mirrors — `AdcModeSchema` — is what a probe asserts the
    // mode from, and a second mode returning would need exactly this line.
    if (cloud.adc_mode === "token") Object.assign(vars, tokenModeStartupEnv());
  }

  if (w.cloudAccess || w.egressAccess) {
    /**
     * ISC-263 — the route that makes the credential usable.
     *
     * Until the CONNECT proxy existed this branch handed a worker ADC and no
     * path to spend it on: `egress.google_hosts` rules were matched
     * exhaustively by `decide()` in unit tests, and a Docker network alias
     * cannot be a wildcard, so `*.googleapis.com` had no live route off the
     * `--internal` bridge at all. A credential granted for a path that does
     * not exist is worse than no credential, because the failure surfaces as a
     * timeout deep inside a gcloud call rather than as a refusal.
     *
     * ## What `egress_access` buys, stated as what it does NOT buy
     *
     * These four variables and nothing else. The proxy's DESTINATION SURFACE
     * is fleet-wide and untouched: `proxyPolicyFor` and `relayGatePolicy` both
     * read `egress.allow` in full (`security/relay.ts`), so the set of
     * reachable host:port pairs is a property of the fleet's config, identical
     * for every worker, and this flag decides only WHO IS TOLD the route
     * exists. It cannot widen a policy and cannot narrow one.
     *
     * That is the honest limit and it is a real one: two workers with
     * `egress_access: true` reach the same hosts, so the grant is per-worker
     * and the reach is not. A fleet that needs one worker to reach a host
     * another must not still has no way to express that; `egress.allow` is the
     * union, and everything routed sees all of it.
     *
     * ## HTTPS_PROXY only — HTTP_PROXY is deliberately NOT set
     *
     * The proxy speaks CONNECT and answers `405` to everything else, on
     * purpose: cleartext forwarding would put it in the business of parsing
     * and re-emitting requests, a far larger surface than splicing a socket,
     * and every destination worth reaching here is TLS. Setting `HTTP_PROXY`
     * would therefore advertise a capability the proxy explicitly refuses, and
     * the first cleartext request would get a 405 that reads like a bug.
     *
     * It also happens to be the safe direction for the model path. This
     * project's own `llm.base_url` is `http://`, so leaving `HTTP_PROXY` unset
     * means model traffic cannot be routed here even if `NO_PROXY` were
     * mishandled by some client — and `NO_PROXY` below is belt to that brace,
     * not the only thing standing between a worker and a 403 on every
     * inference call.
     *
     * ## Why NO_PROXY names both relay aliases
     *
     * `proxyPolicyFor` deliberately carries no `llm` rule, so a model request
     * that DID enter the proxy would be denied `default-deny` — every worker
     * stalling with no tool calls, which is §5.9's exact quiet-failure shape.
     * Both spellings are listed because ISC-264's transition means a config
     * may still name the legacy alias, and a worker whose `models.json` says
     * one name while `NO_PROXY` lists the other is the same failure with an
     * extra step.
     */
    vars["HTTPS_PROXY"] = `http://${PROXY_LISTEN_ALIAS}:${PROXY_LISTEN_PORT}`;
    vars["https_proxy"] = vars["HTTPS_PROXY"];
    vars["NO_PROXY"] = [RELAY_LISTEN_ALIAS, LEGACY_RELAY_LISTEN_ALIAS, "localhost", "127.0.0.1"].join(
      ",",
    );
    vars["no_proxy"] = vars["NO_PROXY"];
  }

  /*
   * The intersection, applied LAST, and the position is load-bearing.
   *
   * `reserved` is built from `Object.keys(vars)` as it stands right here —
   * every variable the fleet has already decided on — plus the sets that must
   * be refused whether or not THIS worker got them. A structural read beats a
   * hand-maintained list: a variable added to the block above is reserved the
   * day it is added, with nobody having to remember this line exists.
   *
   * The explicit additions cover what the structural read cannot see: a worker
   * without `cloud_access` has no `CLOUDSDK_*` in `vars` to collide with, and
   * one without `egress_access` has no proxy variables, so both would be
   * requestable on exactly the workers that must never have them.
   */
  const reserved = new Set<string>([
    ...Object.keys(vars),
    ...CREDENTIAL_ENV_VARS,
    ...RESERVED_PROXY_VARS,
    apiKeyEnvName,
  ]);
  const allowlist = loaded.config.secrets.env_allowlist;
  const secretNames: string[] = [];
  const missing: string[] = [];
  for (const requested of w.secrets) {
    // Dedupe silently: `secrets: [X, X]` is a typo with one obvious meaning,
    // and there is no second value for the two entries to disagree about.
    if (secretNames.includes(requested)) continue;
    if (reserved.has(requested) || RESERVED_PREFIXES.some((p) => requested.startsWith(p))) {
      throw new SecretReservedNameError(w.id, requested);
    }
    if (!allowlist.includes(requested)) {
      throw new SecretNotAllowlistedError(w.id, requested, allowlist);
    }
    const value = hostEnv[requested];
    // Collected rather than thrown on first sight: an operator with three
    // unset variables should get all three names in one refusal, not learn
    // them one `up` at a time.
    if (value === undefined || value === "") {
      missing.push(requested);
      continue;
    }
    secretNames.push(requested);
    vars[requested] = value;
  }
  if (missing.length > 0) throw new SecretMissingFromHostError(w.id, missing);

  /*
   * The redaction list, filled into the slot declared above.
   *
   * THE API KEY IS ON IT AND `secretNames` IS NOT WIDENED TO MATCH. The two
   * lists answer different questions: `secretNames` is what the OPERATOR was
   * asked to grant and is what `up` reports back to them, while this one is
   * every value in this file that must never appear in a log. `llm.api_key_env`
   * is a Class 1 credential (§12.4) that no worker requested and every worker
   * carries, so it belongs on the second list and would be a lie on the first.
   *
   * Absent from `vars` when the host had no key — see `missingApiKey`, which
   * is why the key is omitted entirely rather than written blank — so the
   * membership test is over `vars`, not over `apiKeyEnvName` being a string.
   */
  const redactable = [...(apiKeyEnvName in vars ? [apiKeyEnvName] : []), ...secretNames];
  vars[SECRET_NAMES_VAR] = redactable.join(",");

  return {
    vars,
    missingApiKey: apiKey === undefined || apiKey === "",
    apiKeyEnvName,
    secretNames,
  };
}

/**
 * Render the plan to Docker's `--env-file` format, refusing anything that
 * would not survive the round trip.
 *
 * Throws rather than sanitising: a value that cannot be represented is a
 * config or environment defect, and quietly rewriting it would put a
 * DIFFERENT value in the container than the operator configured — which is
 * the class of silent divergence this repo keeps closing.
 */
export function serializeEnvFile(vars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!ENV_KEY_RE.test(k)) {
      throw new ConfigError(`env-file key ${JSON.stringify(k)} is not a valid environment name`);
    }
    if (NEWLINE.test(v)) {
      throw new ConfigError(
        `env-file value for ${k} contains a newline — docker's --env-file has no escaping, ` +
          `so the remainder would become a separate variable declaration`,
      );
    }
    lines.push(`${k}=${v}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Write the env file at 0600. Returns what was written, so a caller that wants
 * to record or assert on the content does not re-derive it.
 */
export async function writeWorkerEnvFile(
  path: string,
  plan: WorkerEnvPlan,
): Promise<string> {
  const text = serializeEnvFile(plan.vars);
  await writeFile(path, text);
  // Explicit rather than relying on umask: this file carries the Class 1 key,
  // and a run directory created under a permissive umask would otherwise leave
  // it world-readable.
  await chmod(path, 0o600);
  return text;
}
