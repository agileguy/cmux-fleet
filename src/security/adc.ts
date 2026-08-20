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

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CredentialInjectionSchema,
  EXIT,
  type AdcMode,
  type CredentialInjection,
} from "../contracts.ts";
import type { Exec } from "../container/run.ts";
import { bindMountSources } from "../container/docker-argv.ts";
import { WORKER_UID } from "../container/mounts.ts";
import { isPathUnder, pathsEqual } from "../run/paths.ts";
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

/**
 * File-mode mount point for the ADC file (§5.8) — bind-mounted at run, ro.
 *
 * NOTE, load-bearing for how the `file`-mode tests should be read: nothing in
 * `src/` mounts this today. `buildDockerArgv` emits no `/creds` mount, and
 * `fileModeMaterials`/`fileModeStartupEnv` have no production caller. The
 * constant is the agreed destination for when §5.8's `file` mode is actually
 * wired; tests that exercise it hand-write the `-v` themselves and are
 * FORWARD-LOOKING shape checks, not evidence about a launch `up` can perform.
 */
export const ADC_FILE_PATH = "/creds/adc.json";

/**
 * The container-side gcloud config directory — the image's baked
 * `CLOUDSDK_CONFIG` (`docker/Dockerfile`'s `ENV` block).
 *
 * Exported rather than retyped at each site because three things must name the
 * same path or the worker breaks in a way that reads as a credential fault:
 * the image's `CLOUDSDK_CONFIG`, the tmpfs `buildDockerArgv` mounts over it
 * (`gcloudConfigTmpfsArgv`, below), and the tests that probe it.
 */
export const CONTAINER_GCLOUD_CONFIG_DIR = "/home/pi/.config/gcloud";

/**
 * The `--tmpfs` that makes `CONTAINER_GCLOUD_CONFIG_DIR` writable, and why
 * production cannot go without it (ISC-255).
 *
 * SRD §5.2 calls that path a "container-local WRITABLE gcloud config so the
 * CLI can write its token cache", but the image bakes it as an ordinary
 * directory on the root filesystem and §5.6 makes the root `--read-only` with
 * only `/tmp` as tmpfs. So as launched before this, it was not writable, and
 * real gcloud does not degrade — measured on `pifleet/pi-worker:verify` in the
 * exact shape this function's caller builds, with a VALID minted token present:
 *
 *   WARNING: Could not setup log file in /home/pi/.config/gcloud/logs,
 *   (OSError: [Errno 30] Read-only file system: '.../logs'.
 *   ERROR: gcloud crashed (OSError): [Errno 30] Read-only file system:
 *   '/home/pi/.config/gcloud/configurations'
 *
 * exit 1, empty stdout. EVERY gcloud call in a worker failed that way — with a
 * good credential — which is why ISC-41 and ISC-47 could not have been true as
 * previously written. With this tmpfs, the identical container and the
 * identical token exit 0 and print the token back. That differential is
 * ISC-255's close-out and is asserted in `test/integration/adc.test.ts`.
 *
 * Each option chosen on measurement rather than by copying `/tmp`'s line:
 *
 *  - `uid`/`gid`: REQUIRED, and the failure without them is the sneaky kind. A
 *    tmpfs with no uid mounts root-owned 0755, so uid 10001 cannot write it.
 *    gcloud then fails to create `logs/` with EACCES rather than EROFS and —
 *    measured — tolerates that one, exiting 0 while printing a WARNING on
 *    every call and caching nothing. The un-owned version LOOKS like it works,
 *    which is exactly the state that would have got shipped.
 *  - `size=16m`: measured, not guessed. gcloud writes one ~1.2 KB log per
 *    invocation; at tmpfs block granularity that is ~4 KB, and 10 calls left
 *    the directory at 64 KB against a 28 KB baseline. 16 MB is therefore
 *    roughly 4,000 gcloud calls of headroom in one container lifetime.
 *  - A SEPARATE tmpfs rather than repointing `CLOUDSDK_CONFIG` at `/tmp`,
 *    which would have needed no new mount at all. Rejected because the token
 *    file lives in `/tmp` (`TOKEN_DIR`): one shared filesystem would let
 *    gcloud's unbounded log growth consume the space `injectToken` needs, and
 *    a refresh that cannot write is a worker that silently loses cloud access
 *    an hour in. A separate cap means gcloud can only exhaust its own budget.
 *  - `noexec,nosuid`: matches `/tmp`. gcloud writes only data here; components
 *    install into the SDK directory, not the config directory.
 *
 * A tmpfs, finally, rather than a bind mount, because it contributes no
 * `.Mounts` entry — ISC-44's claim is about that table, and the fix for one
 * criterion must not perturb another.
 */
export function gcloudConfigTmpfsArgv(): string[] {
  return [
    "--tmpfs",
    `${CONTAINER_GCLOUD_CONFIG_DIR}:rw,noexec,nosuid,size=16m,uid=${WORKER_UID},gid=${WORKER_UID}`,
  ];
}

/**
 * The host directory that must NEVER cross the container boundary (§5.8,
 * ISC-44) — `credentials.db`, `legacy_credentials/`, `access_tokens.db`: the
 * full gcloud auth store for every account the operator has logged in, which
 * is strictly more powerful than ADC itself. `file` mode mounts exactly one
 * file OUT of this directory (`hostAdcFile()`, below); `token` mode mounts
 * nothing here at all. One exported definition so "never mounted" has a single
 * source every test and every future mount-table change reads from, rather
 * than each call site re-deriving `~/.config/gcloud` and one of them drifting.
 *
 * A FUNCTION, not a `const`, and the difference is not cosmetic. Every other
 * `homedir()` in this repo is read lazily — `config/load.ts`'s `expandPath`,
 * `run/paths.ts`'s `runsRoot`, `container/mounts.ts`'s `daemonScratchRoot`,
 * `doctor.ts`'s cmux probe. A module-level `const` read `homedir()` at IMPORT
 * time, which is before any test that sets `HOME` for a fixture can run, and
 * which test file imports first is a property of the runner's file ordering.
 * That was safe only because nothing mutates `HOME` in-process today; matching
 * the convention means it stays safe on the day something does.
 */
export function hostGcloudConfigDir(): string {
  return join(homedir(), ".config", "gcloud");
}

/**
 * The host ADC file — the one artifact `file` mode is allowed to read out of
 * `hostGcloudConfigDir()`.
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` wins when set, because that is gcloud's own
 * ADC lookup order: the env var overrides the well-known location, and an
 * operator who exports it HAS moved their ADC. Reading the well-known path
 * regardless would have named a file gcloud itself would not use, which is the
 * same class of mistake as resolving the identity from the wrong store.
 *
 * Deliberately NOT applied to `hostGcloudConfigDir()`. That function answers
 * "which directory must never be mounted", and letting an env var redirect a
 * security boundary is how the boundary stops meaning anything. The two are
 * separate questions and only this one follows the env var — with the
 * consequence, harmless and worth stating, that `hostAdcFile()` need not sit
 * under `hostGcloudConfigDir()` any more. `classifyHostGcloudExposure` copes:
 * a file outside the store never reaches the inside-the-store branch where the
 * exception is applied.
 */
export function hostAdcFile(env: Record<string, string | undefined> = process.env): string {
  const explicit = env["GOOGLE_APPLICATION_CREDENTIALS"];
  if (explicit !== undefined && explicit !== "") return explicit;
  return join(hostGcloudConfigDir(), "application_default_credentials.json");
}

/**
 * How one bind-mount source exposes the host gcloud auth store, or `null`.
 *
 * THREE relations, and the third is the one both the unit and the integration
 * ISC-44 checks originally missed. They asked only whether a source WAS the
 * store or sat UNDER it; nothing asked whether a source CONTAINED it. Mounting
 * `$HOME`, or `$HOME/.config`, hands the worker the entire multi-account auth
 * store and satisfies "is not, and is not under, `~/.config/gcloud`"
 * perfectly. That is not hypothetical: `run.repo` is operator-configurable and
 * `buildDockerArgv` mounts it at `/workspace`, so `run.repo: ~` produces
 * exactly this mount.
 *
 * Comparison is on `resolve()`d paths — lexical, because `buildDockerArgv` is
 * synchronous and pure by design and `realpath` is I/O. That closes `..` and
 * trailing-slash spellings; it does NOT close a symlinked source, which is why
 * the integration-side check (`docker inspect`, already async) `realpath`s
 * both sides instead.
 *
 * Boundaries use an explicit separator. A bare `startsWith(dir)` would also
 * flag `~/.config/gcloud-backup` — a different directory this criterion says
 * nothing about — and a false red is how an assertion gets weakened later.
 *
 * That separator is now applied through `isPathUnder` rather than by an inline
 * `` `${dir}/` `` prefix, and the change is a FIX and not a tidy-up. `"/"` is
 * the one directory whose children are not spelled `${dir}/…`, so the inline
 * form tested `startsWith("//")` and `-v /:/host` — the whole host filesystem,
 * gcloud store included — passed this function. The run-dir guard in
 * `run/paths.ts` had the identical bug independently, which is the argument
 * for one shared definition: two copies of a boundary cannot check each other.
 * `isPathUnder` also case-folds; see `classifyRunDirExposure` for why that is
 * unconditional rather than per-platform.
 */
export type HostGcloudExposure = "is-the-store" | "inside-the-store" | "contains-the-store";

export function classifyHostGcloudExposure(
  source: string,
  opts: { allowAdcFile?: boolean } = {},
): HostGcloudExposure | null {
  const store = resolve(hostGcloudConfigDir());
  const s = resolve(source);
  if (pathsEqual(s, store)) return "is-the-store";
  if (isPathUnder(s, store)) {
    // The single documented exception: `file` mode may mount exactly one
    // artifact out of the store, and nothing else in it.
    if (opts.allowAdcFile === true && pathsEqual(s, hostAdcFile())) return null;
    return "inside-the-store";
  }
  if (isPathUnder(store, s)) return "contains-the-store";
  return null;
}

/** A `docker run` argv that would expose the host gcloud auth store. */
export class HostGcloudMountError extends Error {
  /**
   * A misconfigured `run.repo` is a USAGE failure, not a crash. Graded here
   * for the reason `RunDirMountError` records at length and on the same
   * decision: these two are deliberately shaped alike, an operator cannot tell
   * them apart from the outside, and grading one as a config refusal while the
   * other reports `internal error` would be the confusing half of both.
   */
  readonly exitCode = EXIT.USAGE;

  constructor(source: string, relation: HostGcloudExposure) {
    const how =
      relation === "is-the-store"
        ? "IS the host gcloud auth store"
        : relation === "inside-the-store"
          ? "is inside the host gcloud auth store"
          : "CONTAINS the host gcloud auth store";
    super(
      `refusing to launch: bind-mount source ${source} ${how} ` +
        `(${hostGcloudConfigDir()}) — SRD §5.8 / ISC-44`,
    );
    this.name = "HostGcloudMountError";
  }
}

/**
 * ISC-44 as a RUNTIME GUARD on the argv production actually launches.
 *
 * This exists because the constants above closed nothing on their own. They
 * had no importer in `src/` — only two test files read them — so `render.ts`
 * could have grown a `~/.config/gcloud` mount with every constant keeping its
 * value, and the criterion would have held only for as long as someone
 * remembered to keep asserting it. Calling this at the end of
 * `buildDockerArgv` puts the definition ON the path that builds the mount
 * table, so the criterion is ENFORCED by production code rather than merely
 * described by it. It also covers mounts that arrive from config rather than
 * from a literal in `render.ts` — `run.repo` being the live example.
 *
 * `allowAdcFile` is deliberately NOT offered here: no production path mounts
 * the ADC file today (see `ADC_FILE_PATH`), so the launcher's rule is the
 * strict one. When `file` mode is wired, that exception becomes a decision
 * made here, in the open, rather than a default nobody chose.
 */
export function assertNoHostGcloudMount(argv: readonly string[]): void {
  // `bindMountSources` rather than an inline `-v` scan: the inline copy read
  // exactly one of Docker's four bind-mount spellings, so `--volume=<src>:<dst>`,
  // `-v<src>:<dst>` and `--mount type=bind,source=…` all walked past this
  // guard. See that function's header for the measured table.
  for (const source of bindMountSources(argv)) {
    const relation = classifyHostGcloudExposure(source);
    if (relation !== null) throw new HostGcloudMountError(source, relation);
  }
}

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

/**
 * Env for a `file`-mode worker: point the client libraries at the ro mount.
 *
 * No production caller — see `ADC_FILE_PATH`. `up` never emits this env.
 */
export function fileModeStartupEnv(): Record<string, string> {
  return { GOOGLE_APPLICATION_CREDENTIALS: ADC_FILE_PATH };
}

/**
 * Every env var §5.8 can use to hand a worker a Google credential, in either
 * mode.
 *
 * ISC-45's claim ("a `cloud_access: false` role has no Google credential") is
 * about the whole SET, not about whichever one the current default happens to
 * use — otherwise a change of delivery mechanism would make every absence
 * assertion vacuous while leaving it green. Lives here rather than in a test
 * file because two suites now assert against it (the unit render check and the
 * in-container probe) and because it is a statement about what production is
 * ALLOWED to emit, which makes it production's to define.
 */
export const CREDENTIAL_ENV_VARS = [
  "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

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
 * The principal an ADC file mints as, read out of the file itself, or `null`.
 *
 * `authorized_user` ADC — what `gcloud auth application-default login`
 * writes — carries an `account` field naming the user it was minted for.
 * `service_account` ADC carries `client_email`. Either way the FILE knows who
 * it is, offline, with no network round-trip and no token minting.
 *
 * Returns `null` rather than throwing on a missing, unreadable, unparseable or
 * unrecognised file: the caller has a documented fallback, and a credential
 * PLAN that cannot be printed must not be the thing that fails `up`.
 */
export async function readAdcPrincipal(path: string): Promise<string | null> {
  try {
    const raw = await Bun.file(path).text();
    const d = JSON.parse(raw) as { type?: unknown; account?: unknown; client_email?: unknown };
    // Service-account ADC: the email IS the principal.
    if (typeof d.client_email === "string" && d.client_email !== "") return d.client_email;
    // User ADC: written by `gcloud auth application-default login`. Older
    // gcloud versions omitted `account`, hence the `null` return and the
    // fallback at the call site rather than an assumption that it is there.
    if (typeof d.account === "string" && d.account !== "") return d.account;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the identity label for the injection record.
 *
 * THREE sources, in strict order, and the ordering is the whole point:
 *
 *  1. The impersonated SA, when impersonating. The token really does carry the
 *     SA's identity (acceptance 15), so nothing else needs asking.
 *  2. The ADC FILE's own principal. This is the correction: the label must
 *     name the identity the worker was actually GRANTED, and in both modes
 *     that identity comes from ADC — `mintArgv` mints with
 *     `gcloud auth application-default print-access-token`, and `file` mode
 *     hands over `application_default_credentials.json` itself.
 *  3. `gcloud config get-value account`, and ONLY as a fallback, with the
 *     caveat that it is a DIFFERENT STORE. That is the `gcloud auth login`
 *     account; ADC is written separately by
 *     `gcloud auth application-default login`. The two routinely differ — an
 *     operator who logged in as one account and ran the ADC login as another
 *     has two perfectly valid, unequal answers on one machine — and this
 *     function used to return only this one. So the printed grant line could
 *     name an identity the worker was never given, in either mode, and ISC-49
 *     and ISC-251 were asserting that wrong line was correct.
 *
 *     It is kept because it is right more often than it is wrong (the ADC
 *     login usually follows the ordinary login, and on a machine where they
 *     agree it is the same string) and because an older gcloud may not have
 *     written `account` into the ADC file at all. It is a fallback, not the
 *     answer.
 *
 * `adcFile` is injectable so tests can point at a fixture rather than at the
 * operator's real credential.
 */
export async function resolveIdentity(
  exec: Exec,
  impersonateServiceAccount: string | null,
  opts: { adcFile?: string } = {},
): Promise<string> {
  if (impersonateServiceAccount !== null) return impersonateServiceAccount;

  const fromAdc = await readAdcPrincipal(opts.adcFile ?? hostAdcFile());
  if (fromAdc !== null) return fromAdc;

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
