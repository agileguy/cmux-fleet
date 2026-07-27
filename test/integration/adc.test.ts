/**
 * ADC injection probed against a real container (SRD §5.8; acceptance 11, 13, 14).
 *
 * Gated like the verbgate suite: these need a Docker daemon and a built worker
 * image, because the claims under test are claims ABOUT a container — that a
 * read-only root with a tmpfs /tmp accepts the injection, and that nothing
 * resembling a refresh token exists anywhere inside. A mocked version would
 * assert on our own beliefs.
 *
 * The mint is FAKE throughout — a fixed string stands in for the token — so
 * the suite requires no Google credentials and can never leak a real one. The
 * injection path (docker exec, stdin, tmpfs write, atomic rename) is the real
 * production code either way, and that path is what these tests own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { realExec } from "../../src/container/run.ts";
import {
  TOKEN_FILE,
  injectToken,
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

const containers: string[] = [];
afterEach(async () => {
  await Promise.all(
    containers.splice(0).map((name) => realExec(["docker", "rm", "-f", name])),
  );
});

/**
 * Start a detached container in the §5.6 deployment shape that matters here:
 * read-only root, tmpfs /tmp with noexec — the environment the injection path
 * claims to work inside. The startup env is the production pointer env, so
 * the test also proves that env carries no secret.
 */
async function startContainer(): Promise<string> {
  const name = `pifleet-adc-test-${Math.random().toString(36).slice(2, 10)}`;
  containers.push(name);
  const env = Object.entries(tokenModeStartupEnv()).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = await realExec([
    "docker", "run", "-d", "--name", name,
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    ...env,
    "--entrypoint", "bash", IMAGE, "-c", "sleep 300",
  ]);
  expect(r.code).toBe(0);
  return name;
}

async function inContainer(name: string, script: string): Promise<string> {
  const r = await realExec(["docker", "exec", name, "bash", "-c", script]);
  return r.stdout;
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
