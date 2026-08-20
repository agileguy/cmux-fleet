/**
 * ADC injection probed against a real container (SRD §5.8; acceptance 11, 13,
 * 14; ISC-41..47, ISC-255).
 *
 * Gated like the verbgate suite: these need a Docker daemon and a built worker
 * image, because the claims under test are claims ABOUT a container — that a
 * read-only root with a tmpfs /tmp accepts the injection, and that nothing
 * resembling a refresh token exists anywhere inside. A mocked version would
 * assert on our own beliefs.
 *
 * The mint is FAKE for the injection-mechanism tests — a fixed string stands
 * in for the token — so those need no Google credentials and can never leak a
 * real one. The injection path (docker exec, stdin, tmpfs write, atomic
 * rename) is the real production code either way, and that path is what they
 * own.
 *
 * ISC-41/46/47/255 are the claims a fake cannot carry. They are about what real
 * `gcloud` DOES with a credential present versus absent, and a made-up string
 * fails that command for the WRONG reason — a malformed token, not a missing
 * one — which would let the test pass while proving nothing. So those blocks
 * mint a genuine ~1h access token from the operator's own already-authenticated
 * ADC (no impersonation; the exact production `gcloudMinter` path) and skip
 * themselves on a machine with no host ADC. The token is never printed:
 * assertions on its VALUE compare sha256 digests or a boolean, because a
 * failing `toBe(token)` prints both sides and would put a live bearer token in
 * the test log — the one place `adc.ts`'s header promises a credential never
 * reaches.
 *
 * THE CONTAINER SHAPE IS PRODUCTION'S, NOT THIS FILE'S. `startContainer` builds
 * the flags `buildDockerArgv` emits, and takes the gcloud-config tmpfs from
 * `gcloudConfigTmpfsArgv()` — the same exported function `render.ts` calls —
 * rather than spelling it out here. That is a correction, and the bug it fixes
 * is the reason ISC-255 exists: this file used to add a `$CLOUDSDK_CONFIG`
 * tmpfs of its own that production never created, which silently gave every
 * test in it a container shape `pifleet up` could not launch. The tmpfs both
 * neutralised the vector ISC-45/46 exist to disprove (a credential landing in
 * gcloud's real store would have been shadowed by an empty overlay) and made
 * ISC-43's filesystem sweep search that empty overlay instead of the directory
 * gcloud actually writes into. The fix was to put the tmpfs in PRODUCTION,
 * where §5.2 always said it belonged, and let the tests inherit it. Deviations
 * from the production shape are now opt-in fields on `ContainerShape`, default
 * off, and exactly one test uses one (ISC-255's negative control).
 *
 * Why these build containers by hand rather than driving `pifleet up`: the
 * mint+inject mechanism is not yet wired into a real launch — `up` prints a
 * `credential_plan` and stops (tracked separately as ISC-248). ISA.md's Test
 * Strategy prescribes exactly this shape for ISC-41..49 ("integration |
 * in-container gcloud probes | `docker exec`").
 *
 * ISC-44 is covered at two altitudes and both are needed. `render.test.ts`
 * asserts the ARGV `up` would launch never names the host gcloud config dir —
 * cheap, runs everywhere, and catches the mistake at the point it is written;
 * it also owns the ANCESTOR direction, which is reachable from operator config.
 * The block here asserts the same thing about a container that actually exists,
 * read back out of `docker inspect`, which is the ISC's literal wording and the
 * only version that survives a mount arriving from somewhere other than
 * `renderWorker`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { type ExecResult, realExec } from "../../src/container/run.ts";
import { WORKER_UID } from "../../src/container/mounts.ts";
import {
  ADC_FILE_PATH,
  CONTAINER_GCLOUD_CONFIG_DIR,
  CREDENTIAL_ENV_VARS,
  TOKEN_FILE,
  type CredentialPlan,
  classifyHostGcloudExposure,
  fileModeMaterials,
  gcloudConfigTmpfsArgv,
  gcloudMinter,
  hostAdcFile,
  injectToken,
  planCredential,
  proveRefreshTokenAbsent,
  resolveIdentity,
  tokenModeStartupEnv,
} from "../../src/security/adc.ts";
import { cliBudget, containerBudget } from "../support/budget.ts";

const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] adc integration tests need a Docker daemon and ${IMAGE}. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

const FAKE_TOKEN = "ya29.pifleet-fake-token-f00d-do-not-mint";

/**
 * The REAL gcloud, at the path the Dockerfile relocates it to.
 *
 * PATH's `gcloud` is `docker/verbgate`, which classifies
 * `auth print-access-token` as MUTATING whatever the credential state — a
 * credential-MINTING verb is not a read however its name reads (verbgate's
 * gcloud case; verbgate.test.ts's ISC-210). Under the default empty
 * `cloud_allow` policy it therefore exits 77 in the credential-present case and
 * the credential-absent case alike, so a test driving PATH's `gcloud` would go
 * green while measuring the gate rather than the credential. That gate is
 * §5.10 / Group J and is tested there. Calling `.real` isolates the §5.8
 * credential layer ISC-41/45/46 are actually about — the same reason the tests
 * below probe the token file directly instead of through a wrapped CLI.
 *
 * The consequence is recorded rather than hidden, and it matters to anyone
 * reading ISC-46's criterion literally: in a REAL worker, `gcloud auth
 * print-access-token` never exits 0 even WITH a perfectly valid credential,
 * because verbgate refuses it first. The ISC-46 block below asserts that
 * directly, so the criterion's literal command is covered somewhere.
 */
const REAL_GCLOUD = "/usr/local/libexec/gcloud.real";

/**
 * The ADC file the `file`-mode SHAPE test mounts.
 *
 * Overridable so that assertion can run in CI. What it actually needs is A FILE
 * at a path under the host gcloud store — it inspects the resulting mount
 * table, and Docker does not care whether the bytes are a usable credential.
 * Pinning it to the operator's real ADC made a CI-runnable check host-only for
 * no reason, and part of ISC-44's `[x]` rested on a test that executed in no
 * automated job at all.
 *
 * The LIVE MINT is a different matter and stays gated on the real thing: it
 * needs a credential Google will actually honour, which no synthetic file can
 * be. Hence two flags, not one.
 */
const ADC_FILE = process.env.PIFLEET_TEST_ADC_FILE ?? hostAdcFile();
const ADC_FILE_PRESENT = await Bun.file(ADC_FILE).exists();

/**
 * Does this machine have a real host ADC to MINT from? `gcloudMinter` shells
 * `gcloud auth application-default print-access-token` on the HOST, which reads
 * the real store regardless of `PIFLEET_TEST_ADC_FILE`, so this deliberately
 * ignores the override.
 */
const HOST_ADC_PRESENT = await Bun.file(hostAdcFile()).exists();

if (DOCKER && !ADC_FILE_PRESENT) {
  console.warn(
    `[skip] adc file-mode shape test needs a file at ${ADC_FILE}. ` +
      `Set PIFLEET_TEST_ADC_FILE to a synthetic ADC JSON to include it.`,
  );
}
if (DOCKER && !HOST_ADC_PRESENT) {
  console.warn(
    `[skip] adc live-credential tests need ${hostAdcFile()}. ` +
      `Run 'gcloud auth application-default login' to include them.`,
  );
}

/**
 * sha256 hex. Value assertions on a live token go through this so a FAILURE
 * prints two digests instead of two bearer tokens.
 */
function digest(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

const containers: string[] = [];
afterEach(async () => {
  await Promise.all(
    containers.splice(0).map((name) => realExec(["docker", "rm", "-f", name])),
  );
});

/** How one container under test differs from the default token-mode shape. */
interface ContainerShape {
  /**
   * Startup env. Defaults to the production token-mode POINTER env — the shape
   * every pre-existing test in this file assumes. A `cloud_access: false` role
   * passes the empty env `planCredential` implies for it (see `startupEnvFor`).
   */
  env?: Record<string, string>;
  /** Extra `docker run` arguments — the mount table ISC-44 reads back. */
  extraArgs?: string[];
  /**
   * OPT-IN DEVIATION, default `true` (i.e. production). Set `false` to build
   * the pre-ISC-255 shape, where `$CLOUDSDK_CONFIG` sits on the read-only root
   * and real gcloud crashes. Exactly one test sets it: the negative control
   * that proves the production tmpfs is what makes the difference. Nothing else
   * may, because a container without it is a container `pifleet up` cannot
   * launch, and a criterion proved in a shape production cannot produce is not
   * proved.
   */
  gcloudConfigTmpfs?: boolean;
  /**
   * OPT-IN DEVIATION, default `"none"`. Production always passes `--network`
   * (`render.ts`), and this file mounts a live
   * `application_default_credentials.json` — refresh token included — into one
   * of these containers, in an image that ships `curl`. Started on the default
   * bridge, that is an operator's permanent Google grant sitting in a container
   * with full egress, which is precisely what `adc.ts`'s header says this
   * module exists to prevent. Measured: every probe in this file passes under
   * `--network none`, because the mint happens on the HOST and
   * `print-access-token` only reads a local file. So the safe default costs
   * nothing, and it also closes the GCE metadata-server fallback
   * (169.254.169.254) as a credential vector for the ISC-45 probes. No test
   * overrides it today.
   */
  network?: string;
}

/**
 * Start a detached container in the §5.6 deployment shape `buildDockerArgv`
 * actually produces: read-only root, tmpfs /tmp with noexec, the worker uid,
 * and the `$CLOUDSDK_CONFIG` tmpfs — the last taken from production's own
 * `gcloudConfigTmpfsArgv()` rather than retyped, so this file cannot drift back
 * into probing a shape production does not build (ISC-255). The default startup
 * env is the production pointer env, so the tests also prove that env carries
 * no secret.
 */
async function startContainer(shape: ContainerShape = {}): Promise<string> {
  const name = `pifleet-adc-test-${Math.random().toString(36).slice(2, 10)}`;
  containers.push(name);
  const env = Object.entries(shape.env ?? tokenModeStartupEnv()).flatMap(
    ([k, v]) => ["-e", `${k}=${v}`],
  );
  const r = await realExec([
    "docker", "run", "-d", "--name", name,
    "--user", `${WORKER_UID}:${WORKER_UID}`,
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--network", shape.network ?? "none",
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    ...(shape.gcloudConfigTmpfs === false ? [] : gcloudConfigTmpfsArgv()),
    ...env,
    ...(shape.extraArgs ?? []),
    "--entrypoint", "bash", IMAGE, "-c", "sleep 300",
  ]);
  expect(r.code).toBe(0);
  return name;
}

/** Full result of a command in the container — exit code and stderr included. */
async function inContainerResult(name: string, script: string): Promise<ExecResult> {
  return realExec(["docker", "exec", name, "bash", "-c", script]);
}

async function inContainer(name: string, script: string): Promise<string> {
  return (await inContainerResult(name, script)).stdout;
}

/** Mint a real token through the exact production path, no impersonation. */
async function mintReal(): Promise<string> {
  const minted = await gcloudMinter(realExec, {
    impersonateServiceAccount: null,
    identity: await resolveIdentity(realExec, null),
  })();
  expect(minted.token.length).toBeGreaterThan(0);
  return minted.token;
}

/**
 * The startup env one credential plan implies. A `none` plan contributes
 * NOTHING — that is the whole content of `cloud_access: false`, and deriving it
 * from `planCredential` rather than hardcoding `{}` means a future plan kind
 * that started leaking an env var would show up here instead of being
 * described accurately by a test that never asked.
 */
function startupEnvFor(plan: CredentialPlan): Record<string, string> {
  return plan.kind === "none" ? {} : tokenModeStartupEnv();
}

/** The env a `cloud_access: false` role really starts with: none at all. */
const NO_CLOUD_ENV = startupEnvFor(
  planCredential({
    cloudAccess: false,
    adcMode: "token",
    impersonateServiceAccount: null,
    quotaProject: null,
  }),
);

interface DockerMount {
  Type?: string;
  Source?: string;
  Destination?: string;
}

/** The container's real mount table, as Docker reports it. */
async function mountsOf(name: string): Promise<DockerMount[]> {
  const r = await realExec(["docker", "inspect", name, "--format", "{{json .Mounts}}"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout.trim()) as DockerMount[];
}

/**
 * ISC-44 applied to one container's real mount table.
 *
 * Delegates the relation test to `classifyHostGcloudExposure`, production's own
 * predicate, so this and the launcher's guard cannot disagree about what counts
 * — and so this inherits the ANCESTOR direction for free. The literal criterion
 * ("the host `~/.config/gcloud` directory is not a mount source") is not enough
 * on its own in either direction: mounting `credentials.db` or
 * `legacy_credentials/` hands over the same multi-account store one segment
 * deeper, and mounting `$HOME` hands it over one segment shallower.
 *
 * Sources are `realpath`-normalised before comparison, and both sides are. A
 * lexical compare passes a symlinked source — `/tmp -> /private/tmp` on macOS
 * is the everyday case — and an APFS case variant, either of which would mount
 * the store while this function reported clean. `realpath` is affordable here
 * because this side is already async and already shelling out to
 * `docker inspect`; the production guard stays lexical for the reason given on
 * `classifyHostGcloudExposure`.
 *
 * The assertion compares two rendered STRINGS rather than calling
 * `expect(relation).toBeNull()` so a failure names the offending source and how
 * it offends, instead of printing `"inside-the-store" is not null`.
 */
async function expectNoHostGcloudConfigMount(
  mounts: DockerMount[],
  opts: { allowAdcFile: boolean },
): Promise<void> {
  // `realpath` throws on a path that does not exist; a mount source normally
  // does exist, but fall back to the raw value rather than turning a missing
  // path into a confusing test error.
  const norm = async (p: string): Promise<string> => realpath(p).catch(() => p);
  for (const m of mounts) {
    const source = m.Source ?? "";
    if (source === "") continue;
    const relation = classifyHostGcloudExposure(await norm(source), {
      allowAdcFile: opts.allowAdcFile,
    });
    expect(`${source} -> ${relation ?? "clean"}`).toBe(`${source} -> clean`);
  }
}

describe.skipIf(!DOCKER)("adc token injection", () => {
  /**
   * Acceptance 13's mechanism, before any injection: the pointer env exists
   * but points at nothing, so there is NO credential — a role that never gets
   * an injection (cloud_access: false) holds exactly this state forever.
   */
  test("before injection there is no credential in the container", async () => {
    const name = await startContainer();
    const out = await inContainer(
      name,
      `test -f ${TOKEN_FILE} && echo "file=present" || echo "file=absent"
       env | grep -c "CLOUDSDK_AUTH_ACCESS_TOKEN=" || true`,
    );
    expect(out).toContain("file=absent");
    expect(out).not.toContain("CLOUDSDK_AUTH_ACCESS_TOKEN=");
  }, cliBudget(2));

  test("injection lands in tmpfs under a read-only root, mode 0600", async () => {
    const name = await startContainer();
    await injectToken(realExec, name, FAKE_TOKEN);
    const out = await inContainer(
      name,
      `cat ${TOKEN_FILE}; echo; stat -c "mode=%a" ${TOKEN_FILE}`,
    );
    expect(out).toContain(FAKE_TOKEN);
    expect(out).toContain("mode=600");
  }, cliBudget(2));

  /**
   * Acceptance 14's mechanics: a SECOND injection into the same still-running
   * container replaces the token. This is the property the whole file-pointer
   * design exists for — env vars cannot do this to a running container.
   */
  test("re-injection into the running container replaces the token", async () => {
    const name = await startContainer();
    await injectToken(realExec, name, FAKE_TOKEN);
    await injectToken(realExec, name, `${FAKE_TOKEN}-gen1`);
    const out = await inContainer(name, `cat ${TOKEN_FILE}`);
    expect(out.trim()).toBe(`${FAKE_TOKEN}-gen1`);
    // The temp file from the atomic rename must not linger beside it.
    const tmp = await inContainer(
      name,
      `test -f ${TOKEN_FILE}.tmp && echo "tmp=present" || echo "tmp=absent"`,
    );
    expect(tmp).toContain("tmp=absent");
  }, cliBudget(3));

  /**
   * Acceptance 11 / ISC-43: no `refresh_token` string anywhere in the
   * container — not in the env, not on disk, not in /creds. Probed AFTER a real
   * injection, so a production change that started shipping the ADC blob would
   * be seen here, not reasoned away.
   *
   * `$CLOUDSDK_CONFIG` is swept as a real, writable, production-shaped
   * directory. When this file added its own tmpfs there, this sweep searched an
   * empty overlay production never created — an already-closed criterion,
   * quietly weakened to searching nothing. It now searches the directory gcloud
   * actually writes into, which is the only version of this assertion worth
   * having.
   */
  test("no refresh_token appears anywhere: env, disk, or /creds", async () => {
    const name = await startContainer();
    await injectToken(realExec, name, FAKE_TOKEN);
    const out = await inContainer(
      name,
      `hits=0
       env | grep -q refresh_token && hits=$((hits+1))
       tr "\\0" "\\n" < /proc/1/environ | grep -q refresh_token && hits=$((hits+1))
       grep -rq refresh_token /tmp /creds "\${CLOUDSDK_CONFIG:-/nonexistent}" 2>/dev/null && hits=$((hits+1))
       echo "hits=$hits"
       echo "cloudsdk_config=\${CLOUDSDK_CONFIG:-unset}"`,
    );
    expect(out).toContain("hits=0");
    // The sweep only means anything if it looked at the real directory. Pin the
    // var so a future image that stopped baking it turns this red rather than
    // silently degrading the third grep to `/nonexistent`.
    expect(out).toContain(`cloudsdk_config=${CONTAINER_GCLOUD_CONFIG_DIR}`);
  }, cliBudget(2));

  /** The env file's contract, observed live: pointer only, no token value. */
  test("the container environment holds the pointer, never the token", async () => {
    const name = await startContainer();
    await injectToken(realExec, name, FAKE_TOKEN);
    const out = await inContainer(name, `env; tr "\\0" "\\n" < /proc/1/environ`);
    expect(out).toContain(`CLOUDSDK_AUTH_ACCESS_TOKEN_FILE=${TOKEN_FILE}`);
    expect(out).not.toContain(FAKE_TOKEN);
  }, cliBudget(2));
});

/**
 * ISC-255 / ISC-41 — real gcloud works in the shape `pifleet up` launches.
 *
 * These two are one block because they are one measurement taken twice. ISC-255
 * is the defect: the image bakes `$CLOUDSDK_CONFIG` as an ordinary directory on
 * the root filesystem and §5.6 makes the root `--read-only` with only `/tmp` as
 * tmpfs, so gcloud could not write its own config and CRASHED — with a valid
 * credential present. ISC-41 is the criterion that could not have been true
 * while that held, and it had no test of its own: before this, no test in this
 * file invoked `gcloud` at all, and `ISC-41` appeared only in a comment.
 *
 * The negative control is the whole argument, so it is asserted rather than
 * described. One container in the pre-fix shape (`gcloudConfigTmpfs: false`)
 * and one in production's, identical in every other respect, the same kind of
 * real token injected into both: the first crashes on a read-only filesystem,
 * the second prints the token back. That rules out "gcloud was broken anyway"
 * and "the token was bad" in a single comparison.
 */
describe.skipIf(!DOCKER)("ISC-255/ISC-41: gcloud in the production container shape", () => {
  /**
   * ISC-255's LITERAL claim — `$CLOUDSDK_CONFIG` is writable — with NO
   * credential involved, and therefore the only part of this block that runs
   * in CI.
   *
   * The differential below is the better evidence about gcloud, but it needs a
   * real host ADC to mint a live token from and so self-skips on every CI
   * runner. Resting the whole criterion on that would leave it resting on one
   * laptop. This probe needs only a Docker daemon and the image: it starts a
   * container in the production shape and writes where gcloud writes its
   * config, which is exactly what `--read-only` used to make impossible. It is
   * deliberately the weaker assertion, because it is the one that can be
   * re-checked automatically on every push.
   *
   * The ownership assertion is not decoration. A tmpfs mounted without
   * `uid`/`gid` comes up root-owned 0755, and every symptom of that is a
   * WARNING rather than an error — gcloud exits 0 and caches nothing — so a
   * bare writability check would pass on the broken configuration if it
   * happened to run as root. Checking the owning uid is what distinguishes
   * "writable" from "writable by the uid the worker actually runs as".
   */
  test("the gcloud config dir is writable by the worker uid, no credential needed (ISC-255)", async () => {
    const name = await startContainer();
    const out = await inContainer(
      name,
      `echo "owner=$(stat -c '%u:%g' "$CLOUDSDK_CONFIG")"
       mkdir -p "$CLOUDSDK_CONFIG/configurations" 2>/dev/null && echo "mkdir=ok" || echo "mkdir=FAILED"
       echo probe > "$CLOUDSDK_CONFIG/probe" 2>/dev/null && echo "write=ok" || echo "write=FAILED"
       echo "whoami=$(id -u)"
       echo "fstype=$(stat -f -c %T "$CLOUDSDK_CONFIG")"`,
    );
    // Writable at all — the thing `--read-only` denied, and what `[Errno 30]`
    // was reporting. `configurations/` by name because that is the exact
    // subdirectory gcloud crashed creating.
    expect(out).toContain("mkdir=ok");
    expect(out).toContain("write=ok");
    // …by the worker's own uid, not by root.
    expect(out).toContain(`whoami=${WORKER_UID}`);
    expect(out).toContain(`owner=${WORKER_UID}:${WORKER_UID}`);
    // A tmpfs specifically: container-lifetime memory that never touches host
    // disk, which is why a credential cache landing here is acceptable at all.
    expect(out).toContain("fstype=tmpfs");
  }, containerBudget(2));

  test.skipIf(!HOST_ADC_PRESENT)(
    "without the production tmpfs, gcloud crashes on the read-only config dir (ISC-255)",
    async () => {
      const token = await mintReal();
      const name = await startContainer({ gcloudConfigTmpfs: false });
      await injectToken(realExec, name, token);
      const r = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);

      expect(r.code).not.toBe(0);
      expect(r.stdout.trim()).toBe("");
      // The measured failure, matched on the parts that carry meaning: a
      // read-only filesystem, naming the config dir. Not pinned verbatim — the
      // wording is google-cloud-cli's and the image does not pin the SDK
      // version, so an exact string is a scheduled false red.
      expect(r.stderr).toMatch(/Read-only file system/i);
      expect(r.stderr).toContain(CONTAINER_GCLOUD_CONFIG_DIR);
    },
    // ISC-274 audit: stands at 120_000, NOT reduced to the derived number. Two
    // container operations derive containerBudget(2) = 60_000 (its cold floor).
    // What that model does not describe is the real `gcloud` invocation inside
    // the container: it resolves and contacts Google endpoints, so the tail is
    // network latency on someone else's service, not container startup. Measured
    // warm at 2240 ms on a 14-core box at load 3.55, against a warm per-op term
    // of ~2 x 1000 ms — so very nearly the whole excess is gcloud, not Docker.
    // The slowest four tests in this file are exactly the four that shell out to
    // real gcloud, which is the evidence for sizing them above the floor.
    120_000,
  );

  test.skipIf(!HOST_ADC_PRESENT)(
    "with cloud_access and a token, gcloud auth print-access-token succeeds (ISC-41)",
    async () => {
      const token = await mintReal();
      const name = await startContainer();
      await injectToken(realExec, name, token);
      const r = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);

      expect(r.code).toBe(0);
      // Digest, never the value: a failing equality would print a live bearer
      // token into the test log.
      expect(digest(r.stdout.trim())).toBe(digest(token));
      // gcloud must be CLEAN, not merely exiting 0. A tmpfs mounted without
      // `uid`/`gid` is root-owned, and gcloud then tolerates the EACCES while
      // warning on every call and caching nothing — it exits 0 and looks fine.
      // Requiring empty stderr is what distinguishes the real fix from that
      // near-miss.
      expect(r.stderr.trim()).toBe("");
    },
    // ISC-274 audit: stands at 120_000, same derivation as the ISC-255 test
    // above: containerBudget(2) = 60_000 describes the container operations, not
    // the real `gcloud auth print-access-token` round-trip this asserts on.
    // Measured warm 1780 ms; the ceiling covers a slow or retrying token endpoint.
    120_000,
  );

  /**
   * ISC-47 — after `token_refresh` elapses, a `gcloud` call inside a
   * long-running container still succeeds.
   *
   * The container is the long-running thing; the refresh is the event. Rather
   * than sleep out a real `token_refresh` interval (minutes of wall clock for
   * no extra information), this drives the same production step the refresh
   * loop drives — a second `injectToken` into the still-running container,
   * which is what a refresh IS at this layer — and re-probes. The second mint
   * is a genuinely separate call, so the assertion is that gcloud picked up the
   * NEW value, not that it kept working from a cache.
   *
   * What this does not prove, stated plainly: that the supervisor's timer fires
   * at the configured interval. That is `supervisor.test.ts`'s monotonic-clock
   * territory (ISC-155) and is not re-litigated here.
   */
  test.skipIf(!HOST_ADC_PRESENT)(
    "a gcloud call still succeeds after a refresh re-injection (ISC-47)",
    async () => {
      const name = await startContainer();

      const first = await mintReal();
      await injectToken(realExec, name, first);
      const before = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);
      expect(before.code).toBe(0);
      expect(digest(before.stdout.trim())).toBe(digest(first));

      // Generation 2 — the refresh loop's actual production step.
      const second = await mintReal();
      await injectToken(realExec, name, second);
      const after = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);
      expect(after.code).toBe(0);
      expect(after.stderr.trim()).toBe("");
      expect(digest(after.stdout.trim())).toBe(digest(second));
    },
    // ISC-274 audit: stands at 180_000, the widest in this file and NOT reduced.
    // containerBudget(3) = 60_000 covers the container work; this test then makes
    // TWO real gcloud calls either side of a refresh re-injection, so it carries
    // two network round-trips rather than one. Measured warm 3493 ms — the
    // slowest test in the file, and the ordering (3493 > 2240 > 2031 > 1780) tracks
    // the number of gcloud calls exactly, which is the evidence that network and
    // not container time is what these ceilings are sized against.
    180_000,
  );
});

/**
 * ISC-44 — the host `~/.config/gcloud` directory is not in ANY container's
 * `docker inspect` mount list.
 *
 * "Any" is the load-bearing word, so all three role shapes §5.8 can produce are
 * built and inspected rather than one representative: `cloud_access: false`,
 * `token` mode, and `file` mode. `file` mode is the shape that matters most —
 * it is the only one that mounts a host credential at all, so it is the only
 * one where mounting the parent directory instead of the single file is a
 * plausible mistake, and it is the one an author reaching for "just mount the
 * gcloud dir, it is easier" would produce.
 */
describe.skipIf(!DOCKER)("ISC-44: the host gcloud config dir is never a mount source", () => {
  test("cloud_access: false — nothing is mounted from the host gcloud store", async () => {
    const name = await startContainer({ env: NO_CLOUD_ENV });
    await expectNoHostGcloudConfigMount(await mountsOf(name), { allowAdcFile: false });
  }, containerBudget(2));

  test("token mode, after a real injection — still nothing", async () => {
    const name = await startContainer();
    // Inspect AFTER injecting, not before: the claim is about the container a
    // worker actually runs in, and `injectToken` is the one production step
    // that touches a live container's contents. A mount cannot appear from a
    // `docker exec` — proving that is the point.
    await injectToken(realExec, name, FAKE_TOKEN);
    await expectNoHostGcloudConfigMount(await mountsOf(name), { allowAdcFile: false });
  }, containerBudget(2));

  /**
   * `file` mode. FORWARD-LOOKING, and that qualifier is not modesty.
   *
   * No production code path mounts an ADC file: `buildDockerArgv` emits no
   * `/creds` mount, and `fileModeMaterials`/`fileModeStartupEnv`/
   * `ADC_FILE_PATH` have no caller in `src/`. So the `-v` below is hand-written
   * BY THIS TEST, which means the mount-table assertion inspects a shape this
   * file authored — the "assert on our own beliefs" the header disclaims. It is
   * kept because the destination and the env still come from production's
   * `fileModeMaterials`, so it pins the contract `file` mode must satisfy WHEN
   * it is wired and would catch a future implementation reaching for the parent
   * directory. It is not evidence about a launch `up` can perform today, and
   * ISA.md's ISC-44 close-out says so.
   */
  test.skipIf(!ADC_FILE_PRESENT)(
    "file mode mounts the one ADC file, never its parent directory",
    async () => {
      const raw = await Bun.file(ADC_FILE).text();
      const materials = fileModeMaterials(raw);
      expect(Object.keys(materials.files)).toEqual([ADC_FILE_PATH]);

      // The reason `file` mode is opt-in, measured rather than asserted — but
      // only where the artifact is the kind that carries one. A bare
      // `toBe(false)` failed with an uninformative `true !== false` on any host
      // whose ADC is a service-account or external-account file, which has no
      // `refresh_token` string at all (it carries a private key or an external
      // credential config — still a permanent grant, just not this shape).
      // Naming what was found turns that from a puzzle into a fact.
      const kind = ((): string => {
        try {
          return String((JSON.parse(raw) as { type?: unknown }).type ?? "unknown");
        } catch {
          return "unparseable";
        }
      })();
      const absent = proveRefreshTokenAbsent(materials);
      if (kind === "authorized_user") {
        expect(`${kind}: refresh_token_absent=${absent}`).toBe(
          `${kind}: refresh_token_absent=false`,
        );
      } else {
        // Not a failure — a different credential shape. Recorded so the run
        // says which one it saw rather than silently asserting nothing.
        console.warn(
          `[note] ${ADC_FILE} is type "${kind}", not authorized_user; ` +
            `the refresh_token contrast is only meaningful for the latter.`,
        );
      }

      const name = await startContainer({
        env: materials.env,
        extraArgs: ["-v", `${ADC_FILE}:${ADC_FILE_PATH}:ro`],
      });
      const mounts = await mountsOf(name);
      await expectNoHostGcloudConfigMount(mounts, { allowAdcFile: true });

      // Exactly one source is the ADC file — "the one file, not the directory"
      // stated positively, so the test also catches the mount silently
      // disappearing and leaving a vacuous pass above. Both spellings are
      // accepted because Docker may report the realpath of a symlinked source.
      const real = await realpath(ADC_FILE).catch(() => ADC_FILE);
      const adcSources = mounts.filter((m) => m.Source === ADC_FILE || m.Source === real);
      expect(adcSources).toHaveLength(1);
      expect(adcSources[0]?.Destination).toBe(ADC_FILE_PATH);

      // Read-only: a worker that can rewrite the host's ADC file owns the
      // operator's Google identity outright.
      expect(adcSources[0]?.Type).toBe("bind");
      const rw = await inContainer(
        name,
        `test -w ${ADC_FILE_PATH} && echo "writable" || echo "read-only"`,
      );
      expect(rw).toContain("read-only");
    },
    containerBudget(3),
  );
});

/**
 * ISC-45 — a role with `cloud_access: false` has no Google credential.
 *
 * The container is started from the env `planCredential` actually returns for
 * such a role, which is the empty set: a `none` plan contributes no env and no
 * files. That distinction matters and is easy to get wrong — this file's
 * default `startContainer()` carries the token-mode POINTER env, so testing
 * "no credential" against it would assert the absence of a token while the
 * pointer sat right there, which is the `cloud_access: true` shape before its
 * injection, not the `false` shape at all.
 *
 * Absence alone is weak evidence, because an image that shipped no credential
 * under any configuration would satisfy it just as well. So the contrast is
 * asserted in the same block: the identical probe run against an injected
 * token-mode container finds every one of those things present.
 *
 * On the vector set: the four env vars are §5.8's delivery mechanisms, but they
 * were never the whole surface, and calling them "four vectors" oversold it.
 * `$CLOUDSDK_CONFIG` is the vector this file used to blind itself to (ISC-255)
 * and is now swept; `/home/pi/.kube/config` is the only credential-bearing
 * mount `buildDockerArgv` emits TODAY and gets its own case below; and the GCE
 * metadata fallback at 169.254.169.254 is closed by `--network none`, which
 * `startContainer` applies by default.
 */
describe.skipIf(!DOCKER)("ISC-45: cloud_access: false has no Google credential", () => {
  test("no token file, no /creds content, and no credential env var", async () => {
    const name = await startContainer({ env: NO_CLOUD_ENV });

    const out = await inContainer(
      name,
      `test -f ${TOKEN_FILE} && echo "token=present" || echo "token=absent"
       echo "creds_entries=$(ls -A /creds 2>/dev/null | wc -l)"
       echo "gcloud_entries=$(ls -A "\${CLOUDSDK_CONFIG:-/nonexistent}" 2>/dev/null | wc -l)"
       echo "---ENV---"
       env
       echo "---PID1---"
       tr "\\0" "\\n" < /proc/1/environ`,
    );

    expect(out).toContain("token=absent");
    expect(out).toContain("creds_entries=0");
    // The vector ISC-255 was about: gcloud's own store starts empty too. With
    // the tmpfs now arriving from production, this is a real statement about
    // the launched shape rather than about an overlay the test invented.
    expect(out).toContain("gcloud_entries=0");

    // Both env sources are read because they can differ: `env` is a fresh
    // exec's environment, `/proc/1/environ` is what the container was LAUNCHED
    // with, and only the second can show a credential baked in at `docker run`.
    for (const v of CREDENTIAL_ENV_VARS) {
      expect(out).not.toContain(`${v}=`);
    }

    // The `not.toContain` loop above passes trivially if either dump came back
    // empty — a `/proc/1/environ` that silently failed to read would look
    // exactly like a clean environment. Pin a var the image always bakes and
    // require it TWICE, once per source, so both are proven non-empty.
    const baked = out.split("PIFLEET_CONTAINER=1").length - 1;
    expect(baked).toBe(2);
  }, containerBudget(2));

  /**
   * The contrast, on the same probe: with `cloud_access: true` and an
   * injection, the file and the pointer env both appear. Absence in the test
   * above is therefore a property of the ROLE, not of the image.
   */
  test("the same probe finds a credential once a token-mode role is injected", async () => {
    const name = await startContainer();
    await injectToken(realExec, name, FAKE_TOKEN);

    const out = await inContainer(
      name,
      `test -f ${TOKEN_FILE} && echo "token=present" || echo "token=absent"
       stat -c "mode=%a" ${TOKEN_FILE}
       env; tr "\\0" "\\n" < /proc/1/environ`,
    );

    expect(out).toContain("token=present");
    expect(out).toContain("mode=600");
    expect(out).toContain(`CLOUDSDK_AUTH_ACCESS_TOKEN_FILE=${TOKEN_FILE}`);

    // Only the POINTER appears. The other three delivery vars stay absent even
    // in the credentialed case, because §5.8's design keeps the token value out
    // of the environment entirely.
    for (const v of CREDENTIAL_ENV_VARS.filter((n) => n !== "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE")) {
      expect(out).not.toContain(`${v}=`);
    }
  }, containerBudget(2));

  /**
   * The kubeconfig vector, which the four-env-var set does not cover.
   *
   * `buildDockerArgv` mounts `/home/pi/.kube/config` when
   * `cloud.kubeconfig !== null && w.cloudAccess` — the ONLY credential-bearing
   * mount production emits today, and it had no probe here at all. A kubeconfig
   * with a `gcp` auth-provider block, or an embedded bearer token, IS a Google
   * credential by any definition ISC-45 cares about, so "no Google credential"
   * has to mean that path is empty too for a `cloud_access: false` role.
   *
   * The mount is gated on `w.cloudAccess`, so the correct assertion for this
   * container is that the directory exists (the image creates it) and is empty.
   */
  test("cloud_access: false — the kubeconfig mount point is empty", async () => {
    const name = await startContainer({ env: NO_CLOUD_ENV });
    const out = await inContainer(
      name,
      `test -d /home/pi/.kube && echo "dir=present" || echo "dir=absent"
       echo "kube_entries=$(ls -A /home/pi/.kube 2>/dev/null | wc -l)"
       test -f /home/pi/.kube/config && echo "config=present" || echo "config=absent"`,
    );
    expect(out).toContain("dir=present");
    expect(out).toContain("kube_entries=0");
    expect(out).toContain("config=absent");
  }, containerBudget(2));
});

/**
 * ISC-46 — in a `cloud_access: false` role, `gcloud auth print-access-token`
 * fails.
 *
 * A test that only asserted a nonzero exit would be satisfied by gcloud being
 * broken, absent, or refused by the verb gate, none of which is the criterion.
 * So the failure is pinned to gcloud's own credential-absence message, and the
 * block carries a positive control: the SAME command, in the SAME image,
 * succeeds the moment a credential is present.
 *
 * That pair is the "reproduce the failure, then prove the fix flips it" bar.
 * The differential test is the tighter of the two — one container, probed
 * before and after `injectToken`, so the ONLY thing that changes between exit 1
 * and exit 0 is the presence of the token file. Nothing about the image, the
 * flags, the env, or the mount table differs, which is what rules out an
 * incidental environment difference explaining the flip.
 */
describe.skipIf(!DOCKER)("ISC-46: gcloud fails without a credential, succeeds with one", () => {
  test("cloud_access: false — real gcloud reports no active account", async () => {
    const name = await startContainer({ env: NO_CLOUD_ENV });
    const r = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);

    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    // gcloud's own words for "there is no credential here". Matched as REGEXES
    // on the invariant parts rather than pinned verbatim: this is
    // google-cloud-cli's English, the image installs it unpinned and CI rebuilds
    // the image every run, so an exact string is a false red waiting on an
    // upstream copy edit. The parts that carry the meaning — that it is THIS
    // command failing, and that the reason is an absent active account — are
    // what the patterns require. Still far more than a nonzero exit: a 127
    // (missing) or a verbgate 77 (gated) matches neither.
    expect(r.stderr).toMatch(/gcloud\.auth\.print-access-token/);
    expect(r.stderr).toMatch(/do not currently have an active account/i);
  }, containerBudget(2));

  /**
   * The criterion's LITERAL command, through PATH, where a real worker meets
   * it.
   *
   * The tests either side of this deliberately call `gcloud.real` to isolate
   * the §5.8 credential layer from the §5.10 verb gate. That is the right call
   * for measuring the credential — but it leaves the criterion's own wording,
   * `gcloud auth print-access-token`, unexercised in the form an agent actually
   * types. So: assert the PATH binary refuses too, and record WHY the exit code
   * differs. 77 is verbgate's refusal, not gcloud's.
   *
   * The consequence is worth stating because it surprises anyone reading ISC-46
   * literally: in a real worker this command never exits 0, credential or no
   * credential, because verbgate classifies token minting as mutating under the
   * default empty `cloud_allow` policy. ISC-46's "fails without a credential"
   * is therefore true for a stronger reason than the criterion claims.
   */
  test("through PATH, verbgate refuses the same command with exit 77", async () => {
    const name = await startContainer({ env: NO_CLOUD_ENV });
    const r = await inContainerResult(name, "gcloud auth print-access-token");
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("not authorized for task");
    // Not gcloud's credential message — this never reached gcloud at all.
    expect(r.stderr).not.toMatch(/do not currently have an active account/i);
  }, containerBudget(2));

  /**
   * The differential, live. One container, one variable.
   *
   * The token is REAL — minted through the production `gcloudMinter` from the
   * operator's own ADC, no impersonation — because a fake string would make
   * the "after" case fail as a malformed credential and quietly invert what the
   * test proves. Skipped when the host has no ADC to mint from.
   */
  test.skipIf(!HOST_ADC_PRESENT)(
    "injecting a real minted token flips the same command from exit 1 to exit 0",
    async () => {
      const name = await startContainer();

      const before = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);
      expect(before.code).not.toBe(0);
      expect(before.stdout.trim()).toBe("");
      // A different failure from the test above, and correctly so: this role
      // HAS a credential pointer, so gcloud fails on the missing file the
      // pointer names rather than on having no account configured. Matched on
      // the path rather than on gcloud's phrasing around it.
      expect(before.stderr).toContain(TOKEN_FILE);

      const token = await mintReal();
      await injectToken(realExec, name, token);

      const after = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);
      expect(after.code).toBe(0);
      expect(after.stderr.trim()).toBe("");

      // Equality with the minted token, asserted without printing it. The
      // digest comparison is what fails informatively; the boolean states the
      // literal claim. `toBe(token)` would say the same thing and dump a live
      // bearer token into the log on failure.
      const printed = after.stdout.trim();
      expect(digest(printed)).toBe(digest(token));
      expect(printed === token).toBe(true);
    },
    // ISC-274 audit: stands at 120_000. containerBudget(3) = 60_000 describes the
    // container operations; the assertion is that a freshly minted token flips a
    // real gcloud call from exit 1 to exit 0, so a live token endpoint is in the
    // path. Measured warm 2031 ms.
    120_000,
  );
});
