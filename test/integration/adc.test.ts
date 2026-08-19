/**
 * ADC injection probed against a real container (SRD §5.8; acceptance 11, 13,
 * 14; ISC-41..47).
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
 * ISC-46 is the one claim a fake cannot carry. It is about what real `gcloud`
 * DOES with a credential present versus absent, and a made-up string fails
 * that command for the WRONG reason — a malformed token, not a missing one —
 * which would let the test pass while proving nothing about the criterion. So
 * that block mints a genuine ~1h access token from the operator's own
 * already-authenticated ADC (no impersonation; the exact production
 * `gcloudMinter` path) and skips itself on a machine with no host ADC. The
 * token is never printed: assertions on its VALUE compare sha256 digests or a
 * boolean, because a failing `toBe(token)` prints both sides and would put a
 * live bearer token in the test log — the one place `adc.ts`'s header promises
 * a credential never reaches.
 *
 * Why these build containers by hand rather than driving `pifleet up`: the
 * mint+inject mechanism is not yet wired into a real launch — `up` prints a
 * `credential_plan` and stops (tracked separately as ISC-248). ISA.md's Test
 * Strategy prescribes exactly this shape for ISC-41..49 ("integration |
 * in-container gcloud probes | `docker exec`"): construct the production
 * container SHAPE and drive `adc.ts`'s exported primitives against it, which
 * is what the ISC-41/42/43/47 tests below already do.
 *
 * ISC-44 is covered at two altitudes and both are needed. `render.test.ts`
 * asserts the ARGV `up` would launch never names the host gcloud config dir —
 * cheap, runs everywhere, and catches the mistake at the point it is written.
 * The block here asserts the same thing about a container that actually
 * exists, read back out of `docker inspect`, which is the ISC's literal wording
 * and the only version that survives a mount arriving from somewhere other
 * than `renderWorker`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ExecResult, realExec } from "../../src/container/run.ts";
import {
  ADC_FILE_PATH,
  HOST_ADC_FILE,
  HOST_GCLOUD_CONFIG_DIR,
  TOKEN_FILE,
  type CredentialPlan,
  fileModeMaterials,
  gcloudMinter,
  injectToken,
  planCredential,
  proveRefreshTokenAbsent,
  resolveIdentity,
  tokenModeStartupEnv,
} from "../../src/security/adc.ts";

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
 * credential layer ISC-45/46 are actually about — the same reason the tests
 * below probe the token file directly instead of through a wrapped CLI.
 */
const REAL_GCLOUD = "/usr/local/libexec/gcloud.real";

/**
 * The image's baked `CLOUDSDK_CONFIG` (docker/Dockerfile) — a container-LOCAL
 * empty directory, never the host's. Named once so the tmpfs below and the
 * ISC-44 assertions read the same value.
 */
const CONTAINER_GCLOUD_CONFIG = "/home/pi/.config/gcloud";

/**
 * Every env var §5.8 can use to hand a worker a Google credential, in either
 * mode. ISC-45's claim is about the whole set rather than whichever one the
 * current default happens to use, so absence is asserted across all four —
 * otherwise a change of delivery mechanism would silently make the test
 * vacuous while still passing.
 */
const CREDENTIAL_ENV_VARS = [
  "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

/**
 * Does this machine have a host ADC file? The `file`-mode shape and the live
 * mint need one, and SKIP rather than fail without it: their subject is what
 * the credential layer does with a REAL credential, and on a machine with no
 * Google login there is no such thing to observe.
 */
const HOST_ADC_PRESENT = await Bun.file(HOST_ADC_FILE).exists();

if (DOCKER && !HOST_ADC_PRESENT) {
  console.warn(
    `[skip] adc live-credential tests need ${HOST_ADC_FILE}. ` +
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
}

/**
 * Start a detached container in the §5.6 deployment shape that matters here:
 * read-only root, tmpfs /tmp with noexec — the environment the injection path
 * claims to work inside. The default startup env is the production pointer
 * env, so the test also proves that env carries no secret.
 *
 * The second tmpfs is `CLOUDSDK_CONFIG`, and it is load-bearing rather than
 * decoration. SRD §5.2 says that path is a "container-local WRITABLE gcloud
 * config so the CLI can write its token cache", but the image bakes it as an
 * ordinary directory on the root filesystem and §5.6's flag list makes the root
 * `--read-only` with only `/tmp` as tmpfs — so as launched today it is not
 * writable, and real gcloud does not merely warn:
 *
 *   ERROR: gcloud crashed (OSError): [Errno 30] Read-only file system:
 *   '/home/pi/.config/gcloud/configurations'
 *
 * measured on this image with a VALID token present. Every `gcloud` call in a
 * worker fails that way, and it reads as a broken credential rather than a
 * missing mount. A tmpfs is the smallest thing that matches what §5.2 already
 * promises — container-local, host-disk-free, and (unlike a bind mount) it
 * contributes no `.Mounts` entry, so ISC-44's mount-table claim is untouched.
 * The gap in the production flag list is real and is reported separately; this
 * helper does not paper over it, it makes the criteria under test observable.
 */
async function startContainer(shape: ContainerShape = {}): Promise<string> {
  const name = `pifleet-adc-test-${Math.random().toString(36).slice(2, 10)}`;
  containers.push(name);
  const env = Object.entries(shape.env ?? tokenModeStartupEnv()).flatMap(
    ([k, v]) => ["-e", `${k}=${v}`],
  );
  const r = await realExec([
    "docker", "run", "-d", "--name", name,
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs", `${CONTAINER_GCLOUD_CONFIG}:rw,noexec,nosuid,size=16m,uid=10001,gid=10001`,
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
 * Two assertions, because the literal criterion is not quite enough on its own.
 * The first is the ISC's own wording: the host `~/.config/gcloud` DIRECTORY is
 * not a mount source. The second catches the near-miss that wording permits —
 * mounting `~/.config/gcloud/credentials.db` or `legacy_credentials/` instead,
 * which hands over the same multi-account auth store one path segment deeper.
 * So nothing UNDER the directory may be a source either, with exactly one
 * documented exception: `HOST_ADC_FILE`, the single artifact §5.8 allows `file`
 * mode to mount.
 *
 * The prefix test uses a trailing separator. Plain `startsWith(dir)` would also
 * flag `~/.config/gcloud-backup`, a different directory that this criterion
 * says nothing about — a false red teaches people to weaken the assertion.
 */
function expectNoHostGcloudConfigMount(
  mounts: DockerMount[],
  opts: { allowAdcFile: boolean },
): void {
  const sources = mounts.map((m) => m.Source ?? "");
  expect(sources).not.toContain(HOST_GCLOUD_CONFIG_DIR);
  const under = sources.filter((s) => s.startsWith(`${HOST_GCLOUD_CONFIG_DIR}/`));
  expect(under).toEqual(opts.allowAdcFile ? [HOST_ADC_FILE] : []);
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
  });

  test("injection lands in tmpfs under a read-only root, mode 0600", async () => {
    const name = await startContainer();
    await injectToken(realExec, name, FAKE_TOKEN);
    const out = await inContainer(
      name,
      `cat ${TOKEN_FILE}; echo; stat -c "mode=%a" ${TOKEN_FILE}`,
    );
    expect(out).toContain(FAKE_TOKEN);
    expect(out).toContain("mode=600");
  });

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
  });

  /**
   * Acceptance 11: no `refresh_token` string anywhere in the container — not
   * in the env, not on disk, not in /creds. Probed AFTER a real injection, so
   * a production change that started shipping the ADC blob would be seen
   * here, not reasoned away. The writable surfaces are enumerated (tmpfs,
   * /creds if present, the gcloud config dir) because that is where injected
   * material can land under a read-only root; the env is read from PID 1's
   * environ as well as a fresh exec, since the two can differ.
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
       echo "hits=$hits"`,
    );
    expect(out).toContain("hits=0");
  });

  /** The env file's contract, observed live: pointer only, no token value. */
  test("the container environment holds the pointer, never the token", async () => {
    const name = await startContainer();
    await injectToken(realExec, name, FAKE_TOKEN);
    const out = await inContainer(name, `env; tr "\\0" "\\n" < /proc/1/environ`);
    expect(out).toContain(`CLOUDSDK_AUTH_ACCESS_TOKEN_FILE=${TOKEN_FILE}`);
    expect(out).not.toContain(FAKE_TOKEN);
  });
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
    expectNoHostGcloudConfigMount(await mountsOf(name), { allowAdcFile: false });
  }, 60_000);

  test("token mode, after a real injection — still nothing", async () => {
    const name = await startContainer();
    // Inspect AFTER injecting, not before: the claim is about the container a
    // worker actually runs in, and `injectToken` is the one production step
    // that touches a live container's contents. A mount cannot appear from a
    // `docker exec` — proving that is the point.
    await injectToken(realExec, name, FAKE_TOKEN);
    expectNoHostGcloudConfigMount(await mountsOf(name), { allowAdcFile: false });
  }, 60_000);

  /**
   * `file` mode, built from `fileModeMaterials` so the mount destination and
   * the env var come from production code rather than being retyped here.
   *
   * Two things are proved at once. First the ISC: the mount table names the
   * single ADC FILE and never the directory holding it — the distinction
   * between handing over one credential and handing over the whole
   * multi-account auth store. Second, on the same real file,
   * `proveRefreshTokenAbsent` returns FALSE — live evidence for the §5.8
   * decision that `token` mode is the default, since the artifact `file` mode
   * mounts genuinely does carry a non-expiring `refresh_token`.
   */
  test.skipIf(!HOST_ADC_PRESENT)(
    "file mode mounts the one ADC file, never its parent directory",
    async () => {
      const materials = fileModeMaterials(await Bun.file(HOST_ADC_FILE).text());
      expect(Object.keys(materials.files)).toEqual([ADC_FILE_PATH]);
      // The reason `file` mode is opt-in, measured rather than asserted.
      expect(proveRefreshTokenAbsent(materials)).toBe(false);

      const name = await startContainer({
        env: materials.env,
        extraArgs: ["-v", `${HOST_ADC_FILE}:${ADC_FILE_PATH}:ro`],
      });
      const mounts = await mountsOf(name);
      expectNoHostGcloudConfigMount(mounts, { allowAdcFile: true });

      // Exactly one source is the ADC file — "the one file, not the directory"
      // stated positively, so the test would also catch the mount silently
      // disappearing and leaving a vacuous pass above.
      const adcSources = mounts.filter((m) => m.Source === HOST_ADC_FILE);
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
    60_000,
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
 */
describe.skipIf(!DOCKER)("ISC-45: cloud_access: false has no Google credential", () => {
  test("no token file, no /creds content, and no credential env var", async () => {
    const name = await startContainer({ env: NO_CLOUD_ENV });

    const out = await inContainer(
      name,
      `test -f ${TOKEN_FILE} && echo "token=present" || echo "token=absent"
       echo "creds_entries=$(ls -A /creds 2>/dev/null | wc -l)"
       echo "---ENV---"
       env
       echo "---PID1---"
       tr "\\0" "\\n" < /proc/1/environ`,
    );

    expect(out).toContain("token=absent");
    expect(out).toContain("creds_entries=0");

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
  }, 60_000);

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
  }, 60_000);
});

/**
 * ISC-46 — in a `cloud_access: false` role, `gcloud auth print-access-token`
 * fails.
 *
 * A test that only asserted a nonzero exit would be satisfied by gcloud being
 * broken, absent, or refused by the verb gate, none of which is the criterion.
 * So the failure is pinned to gcloud's own credential-absence message, read off
 * a real run rather than guessed, and the block carries a positive control: the
 * SAME command, in the SAME image, succeeds the moment a credential is present.
 *
 * That pair is the "reproduce the failure, then prove the fix flips it" bar.
 * The second test is the tighter of the two — one container, probed before and
 * after `injectToken`, so the ONLY thing that changes between exit 1 and exit 0
 * is the presence of the token file. Nothing about the image, the flags, the
 * env, or the mount table differs, which is what rules out an incidental
 * environment difference explaining the flip.
 */
describe.skipIf(!DOCKER)("ISC-46: gcloud fails without a credential, succeeds with one", () => {
  test("cloud_access: false — real gcloud reports no active account", async () => {
    const name = await startContainer({ env: NO_CLOUD_ENV });
    const r = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);

    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    // gcloud's own words for "there is no credential here", verbatim from a
    // real run against this image. Asserting the message and not just the exit
    // code is what separates the criterion from a gcloud that is merely
    // missing or gated — a 127 or a verbgate 77 would not contain this.
    expect(r.stderr).toContain(
      "(gcloud.auth.print-access-token) You do not currently have an active account selected",
    );
  }, 60_000);

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
      // A different message from the test above, and correctly so: this role
      // HAS a credential pointer, so gcloud fails on the missing file the
      // pointer names rather than on having no account configured.
      expect(before.stderr).toContain(`Unable to read file [${TOKEN_FILE}]`);

      const minted = await gcloudMinter(realExec, {
        impersonateServiceAccount: null,
        identity: await resolveIdentity(realExec, null),
      })();
      expect(minted.token.length).toBeGreaterThan(0);
      await injectToken(realExec, name, minted.token);

      const after = await inContainerResult(name, `${REAL_GCLOUD} auth print-access-token`);
      expect(after.code).toBe(0);
      expect(after.stderr.trim()).toBe("");

      // Equality with the minted token, asserted without printing it. The
      // digest comparison is what fails informatively; the boolean states the
      // literal claim. `toBe(minted.token)` would say the same thing and dump a
      // live bearer token into the log on failure.
      const printed = after.stdout.trim();
      expect(digest(printed)).toBe(digest(minted.token));
      expect(printed === minted.token).toBe(true);
    },
    120_000,
  );
});
