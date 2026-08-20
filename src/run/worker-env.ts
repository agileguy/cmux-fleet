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
import { tokenModeStartupEnv } from "../security/adc.ts";

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
}

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
  };

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
   */
  if (w.cloudAccess) {
    if (cloud.quota_project !== null) vars["CLOUDSDK_CORE_PROJECT"] = cloud.quota_project;
    if (cloud.adc_mode === "token") Object.assign(vars, tokenModeStartupEnv());
    // `file` mode deliberately emits nothing here: `fileModeStartupEnv` has no
    // production caller by design, and inventing one would put
    // GOOGLE_APPLICATION_CREDENTIALS into a run-dir artifact for a mode the
    // product refuses unless explicitly opted into. ISC-268 owns that path.
  }

  return { vars, missingApiKey: apiKey === undefined || apiKey === "", apiKeyEnvName };
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
