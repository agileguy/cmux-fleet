/**
 * ADC token injection (SRD §5.8, §12.4; acceptance 10–16).
 *
 * Workers inherit Google identity as a ~1h ACCESS token minted on the HOST,
 * never as the ADC file's `refresh_token` — a refresh token is a permanent
 * grant that outlives the run, the container, and the fleet, so the whole
 * design goal here is that it provably never crosses the container boundary
 * (acceptance 11). Three rules fall out of that and shape every function in
 * this module:
 *
 *  1. The token VALUE lives only in memory and in the container's tmpfs. It
 *     never enters a `CredentialInjection` record, a log line, an error
 *     message, or the run directory — the §5.6 env-file lives in `<run-dir>`
 *     and is exactly the durable artifact a credential must not escape into.
 *  2. `refresh_token_absent` is VERIFIED against the actual injected material
 *     by `proveRefreshTokenAbsent`, never asserted from belief. The field has
 *     no default in the schema precisely so nobody can report the safe answer
 *     without checking.
 *  3. Every subprocess is an argv array. A shell string interpolating an
 *     account name or token is an injection surface and a `ps` leak in one.
 *
 * Delivery mechanism, and why it diverges from §5.8's literal env-var wording:
 * `docker exec` cannot change a running container's environment — PID 1's env
 * is fixed at `docker run` — so an env-var token could never be REFRESHED
 * (acceptance 14). Instead the startup env carries only a POINTER
 * (`CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`, gcloud's `auth/access_token_file`
 * property) and the token itself is written to that path over `docker exec`
 * stdin. Same mechanism family the SRD names — env-driven gcloud auth — but
 * refreshable, and the env-file in the run dir never holds a secret.
 */

import {
  CredentialInjectionSchema,
  type AdcMode,
  type CredentialInjection,
} from "../contracts.ts";
import type { Exec } from "../container/run.ts";
import { isoNow, monotonicMs } from "../util/clock.ts";

// ---------------------------------------------------------------------------
// Where the token lives inside the container
// ---------------------------------------------------------------------------

/**
 * The container root is `--read-only` (§5.6); the writable paths are
 * `/workspace`, `/outbox`, and the tmpfs at `/tmp`. The first two are
 * HARVESTED — anything written there comes back to the host as a durable
 * artifact, which is the escape this module exists to prevent — so the token
 * goes under `/tmp`: tmpfs is container-lifetime memory that never touches
 * host disk and vanishes with the container. `noexec` on the tmpfs is
 * irrelevant to a data file.
 */
export const TOKEN_DIR = "/tmp/.pifleet-adc";
export const TOKEN_FILE = `${TOKEN_DIR}/access-token`;

/** File-mode mount point for the ADC file (§5.8) — bind-mounted at run, ro. */
export const ADC_FILE_PATH = "/creds/adc.json";

/**
 * Measured TTL of a user access token (§5.8: `expires_in: 3599`). Used ONLY
 * to derive the `expires_at` LABEL when the issuer path cannot report one —
 * `gcloud … print-access-token` emits the bare token. Nothing schedules from
 * this number; the refresh loop runs on `token_refresh` and the monotonic
 * clock (ISC-155).
 */
export const MEASURED_TOKEN_TTL_S = 3599;

// ---------------------------------------------------------------------------
// Startup environment — pointers only, never secrets
// ---------------------------------------------------------------------------

/**
 * Env for a `token`-mode worker's `--env-file`. Deliberately contains no
 * credential: the env-file is written into `<run-dir>` and read by `status`
 * and `report`, so a token here would be a credential in a durable artifact.
 */
export function tokenModeStartupEnv(): Record<string, string> {
  return { CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: TOKEN_FILE };
}

/** Env for a `file`-mode worker: point the client libraries at the ro mount. */
export function fileModeStartupEnv(): Record<string, string> {
  return { GOOGLE_APPLICATION_CREDENTIALS: ADC_FILE_PATH };
}

// ---------------------------------------------------------------------------
// The credential plan — cloud_access: false must be OBSERVABLE (acceptance 13)
// ---------------------------------------------------------------------------

export type CredentialPlan =
  | { kind: "none"; reason: "cloud_access_false" }
  | {
      kind: "inject";
      mode: AdcMode;
      impersonateServiceAccount: string | null;
      quotaProject: string | null;
    };

/**
 * Decide what, if anything, a role gets. A `cloud_access: false` role gets a
 * `none` plan — a VALUE, not an early return — so `up` can print "no Google
 * credential" per worker (§5.8: the grant is never silent) and a test can
 * assert the absence rather than infer it from nothing having happened.
 */
export function planCredential(role: {
  cloudAccess: boolean;
  adcMode: AdcMode;
  impersonateServiceAccount: string | null;
  quotaProject: string | null;
}): CredentialPlan {
  if (!role.cloudAccess) return { kind: "none", reason: "cloud_access_false" };
  return {
    kind: "inject",
    mode: role.adcMode,
    impersonateServiceAccount: role.impersonateServiceAccount,
    quotaProject: role.quotaProject,
  };
}

/** One line for `up`'s per-worker grant print (§5.8, acceptance 16). */
export function describeCredentialPlan(plan: CredentialPlan, identity?: string): string {
  if (plan.kind === "none") return "google: no credential (cloud_access: false)";
  const who = plan.impersonateServiceAccount ?? identity ?? "(adc user)";
  const project = plan.quotaProject ?? "(no quota project)";
  return `google: ${plan.mode} mode as ${who}, project ${project}`;
}

// ---------------------------------------------------------------------------
// Minting — on the HOST, argv arrays only
// ---------------------------------------------------------------------------

/** What a mint produces. The token stays in memory; only labels travel. */
export interface MintedToken {
  token: string;
  /** Identity the token actually carries — the SA when impersonating. */
  identity: string;
  /** Issuer's expiry as a wall-clock LABEL. Never subtracted from anything. */
  expiresAt: string;
}

/** A mint function the refresh loop can call; tests substitute a fake. */
export type Minter = () => Promise<MintedToken>;

/**
 * A failed mint, by name. The message carries gcloud's stderr — which names
 * the actual problem (expired ADC, wrong project, no network) — and NEVER the
 * token, because this message is exactly what ends up in a supervisor log.
 */
export class MintError extends Error {
  constructor(detail: string) {
    super(`gcloud token mint failed: ${detail}`);
    this.name = "MintError";
  }
}

/**
 * The exact argv, exported so tests pin it. `application-default` because the
 * inherited identity IS the host's ADC (§5.8), and impersonation as a single
 * `--flag=value` token so no shell ever parses an account name.
 */
export function mintArgv(impersonateServiceAccount: string | null): string[] {
  const argv = ["gcloud", "auth", "application-default", "print-access-token"];
  if (impersonateServiceAccount !== null) {
    argv.push(`--impersonate-service-account=${impersonateServiceAccount}`);
  }
  return argv;
}

/**
 * Resolve the identity label for the injection record: the SA when
 * impersonating (the token really carries the SA's identity — acceptance 15),
 * otherwise the host gcloud account.
 */
export async function resolveIdentity(
  exec: Exec,
  impersonateServiceAccount: string | null,
): Promise<string> {
  if (impersonateServiceAccount !== null) return impersonateServiceAccount;
  const r = await exec(["gcloud", "config", "get-value", "account"], { timeoutMs: 15_000 });
  const account = r.stdout.trim();
  if (r.code !== 0 || account === "") {
    throw new MintError(`cannot resolve gcloud account: ${r.stderr.trim() || "empty output"}`);
  }
  return account;
}

/**
 * Real minter over the injected `Exec`. `expiresAt` is derived from the
 * measured TTL because `print-access-token` reports none — it is a LABEL for
 * the record, and deriving it here (rather than pretending the issuer said
 * it) keeps the derivation in one commented place.
 */
export function gcloudMinter(
  exec: Exec,
  opts: { impersonateServiceAccount: string | null; identity: string },
): Minter {
  return async () => {
    const r = await exec(mintArgv(opts.impersonateServiceAccount), { timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) {
      // stderr only — stdout is where the token would be, and a failed mint
      // may still have written a partial one.
      throw new MintError(r.timedOut ? "timed out" : r.stderr.trim() || `exit ${r.code}`);
    }
    const token = r.stdout.trim();
    if (token === "") throw new MintError("gcloud printed an empty token");
    return {
      token,
      identity: opts.identity,
      expiresAt: new Date(Date.now() + MEASURED_TOKEN_TTL_S * 1000).toISOString(),
    };
  };
}

// ---------------------------------------------------------------------------
// refresh_token_absent — verified, never assumed (acceptance 11)
// ---------------------------------------------------------------------------

/** Everything that would cross the boundary for one injection. */
export interface InjectionMaterials {
  /** Env vars the container starts with (pointers in token mode). */
  env: Record<string, string>;
  /** Files placed or mounted into the container, path → content. */
  files: Record<string, string>;
}

/** Materials for one token-mode injection: the pointer env + the token file. */
export function tokenModeMaterials(token: string): InjectionMaterials {
  return { env: tokenModeStartupEnv(), files: { [TOKEN_FILE]: token } };
}

/** Materials for file mode: the ADC file content that will be mounted ro. */
export function fileModeMaterials(adcFileContent: string): InjectionMaterials {
  return { env: fileModeStartupEnv(), files: { [ADC_FILE_PATH]: adcFileContent } };
}

/**
 * True only when NOTHING crossing the boundary contains a refresh token.
 *
 * A substring scan, deliberately broader than parsing JSON for the key: an
 * `authorized_user` ADC file carries `"refresh_token"`, but so would a token
 * env var into which someone pasted the whole ADC blob, or a future file
 * format we did not anticipate. Over-matching fails SAFE — a false `absent`
 * is the failure that matters, a false `present` is a loud investigation.
 */
export function proveRefreshTokenAbsent(materials: InjectionMaterials): boolean {
  const needle = "refresh_token";
  for (const v of Object.values(materials.env)) {
    if (v.includes(needle)) return false;
  }
  for (const content of Object.values(materials.files)) {
    if (content.includes(needle)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Injection into a RUNNING container — docker exec, token over stdin
// ---------------------------------------------------------------------------

export class InjectError extends Error {
  constructor(detail: string) {
    super(`token injection failed: ${detail}`);
    this.name = "InjectError";
  }
}

/**
 * The in-container write script. `umask 077` so the file is 0600; write to a
 * temp name then `mv` so a `gcloud` reading mid-refresh sees the old complete
 * token or the new complete token, never a truncated one (rename within one
 * tmpfs is atomic). The token arrives on STDIN: `docker exec` argv is visible
 * to `ps` on the host for the life of the exec, and argv is exactly the kind
 * of place a credential escapes into a process listing or an audit log.
 */
const WRITE_SCRIPT = [
  "umask 077",
  `mkdir -p ${TOKEN_DIR}`,
  `cat > ${TOKEN_FILE}.tmp`,
  `mv ${TOKEN_FILE}.tmp ${TOKEN_FILE}`,
].join(" && ");

/** Argv for the injection exec, exported so tests pin token-free argv. */
export function injectArgv(container: string): string[] {
  return ["docker", "exec", "-i", container, "sh", "-c", WRITE_SCRIPT];
}

/**
 * Write `token` into the running container's tmpfs. Throws `InjectError` on
 * failure — a silent injection failure is a worker that loses cloud access
 * and produces a confusing task failure instead of a credential failure.
 */
export async function injectToken(exec: Exec, container: string, token: string): Promise<void> {
  const r = await exec(injectArgv(container), { stdin: token, timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) {
    throw new InjectError(
      r.timedOut ? `timed out writing to ${container}` : r.stderr.trim() || `exit ${r.code}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The durable record — everything EXCEPT the token
// ---------------------------------------------------------------------------

/**
 * Build the `CredentialInjection` record for one injection. Takes the minted
 * token's LABELS and the verified materials — never the token value, which
 * has no parameter here by construction. `refresh_token_absent` is computed
 * by `proveRefreshTokenAbsent` on the actual materials; passing a literal
 * would be reporting the safe answer without checking, which is the exact
 * failure the schema's no-default field exists to prevent.
 */
export function recordInjection(args: {
  worker: string;
  mode: AdcMode;
  identity: string;
  expiresAt: string;
  generation: number;
  materials: InjectionMaterials;
  now?: () => number;
}): CredentialInjection {
  return CredentialInjectionSchema.parse({
    schema: "pifleet.credential/v1",
    worker: args.worker,
    mode: args.mode,
    identity: args.identity,
    expires_at: args.expiresAt,
    injected_at: isoNow(),
    injected_mono: (args.now ?? monotonicMs)(),
    generation: args.generation,
    refresh_token_absent: proveRefreshTokenAbsent(args.materials),
  });
}
