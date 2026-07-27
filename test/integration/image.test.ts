/**
 * Worker image integration probes (ISC-23..29, ISC-33..40) — real `docker`
 * against a really built image, per the ISA's live-probe rule: nothing about
 * a container is verified by a mock.
 *
 * Gated on PIFLEET_DOCKER=1 because CI has no daemon. The tests are skipped
 * there — never deleted, never vacuous — and the skip announces itself so a
 * green CI run cannot be mistaken for container coverage.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, type LoadedConfig } from "../../src/config/load.ts";
import { buildImage, imageTag, verifyImage } from "../../src/container/image.ts";
import { makeDaemonScratch, makeWorkerAccessible } from "../../src/container/mounts.ts";
import { realExec } from "../../src/container/run.ts";

const DOCKER = process.env.PIFLEET_DOCKER === "1";
if (!DOCKER) {
  console.warn(
    "SKIP test/integration/image.test.ts: set PIFLEET_DOCKER=1 with a Docker daemon up to run the container probes",
  );
}

const it = test.skipIf(!DOCKER);

/** Generous: `docker run` probes cold-start a VM path on macOS. */
const PROBE_TIMEOUT = 180_000;
/** The image build installs google-cloud-cli; the first build takes many minutes. */
const BUILD_TIMEOUT = 2_400_000;

const PI_VERSION = "0.79.6";

const CONFIG_YAML = `
version: 2
name: image-test
docker:
  pi_version: "${PI_VERSION}"
run:
  repo: .
  budget:
    tokens_ceiling: 1000000
llm:
  model: TestModel
roles:
  eng: { toolchain: node }
workers:
  - { id: w1, role: eng }
`;

let loaded: LoadedConfig;
let tag: string;

beforeAll(async () => {
  if (!DOCKER) return;
  loaded = await parseConfig(CONFIG_YAML, "/virtual/image-test/fleet.yaml");
  tag = imageTag(loaded.config, "node");
  // Build once per suite run; Docker's layer cache makes reruns cheap.
  const result = await buildImage(loaded.config, { toolchain: "node", timeoutMs: BUILD_TIMEOUT });
  if (!result.ok) throw new Error(`image build failed:\n${result.stderr.slice(-4000)}`);
}, BUILD_TIMEOUT);

async function runInImage(
  args: string[],
  opts: { entrypoint?: string; env?: Record<string, string>; extra?: string[] } = {},
) {
  const argv = ["docker", "run", "--rm", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"];
  for (const [k, v] of Object.entries(opts.env ?? {})) argv.push("-e", `${k}=${v}`);
  if (opts.extra) argv.push(...opts.extra);
  if (opts.entrypoint) argv.push("--entrypoint", opts.entrypoint);
  argv.push(tag, ...args);
  return realExec(argv, { timeoutMs: PROBE_TIMEOUT });
}

describe("image build and verify", () => {
  // ISC-23: the built image's pi --version matches the pin, through the real
  // entrypoint chain (tini → pifleet-entrypoint → pi).
  it("pi --version matches the pinned version", async () => {
    const r = await runInImage(["--version"]);
    expect(r.code).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(PI_VERSION);
  }, PROBE_TIMEOUT);

  // ISC-24: verify FAILS when the pin differs from the image.
  it("image verify fails on a Pi version mismatch", async () => {
    const bad = await verifyImage(tag, "0.0.1");
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.name === "pi-version")?.ok).toBe(false);
  }, PROBE_TIMEOUT * 3);

  it("image verify passes against the true pin", async () => {
    const good = await verifyImage(tag, PI_VERSION);
    expect(good.ok).toBe(true);
  }, PROBE_TIMEOUT * 3);
});

describe("container posture", () => {
  // ISC-25: fixed uid so bind-mount ownership is deterministic.
  it("runs as uid 10001", async () => {
    const r = await runInImage(["-u"], { entrypoint: "/usr/bin/id" });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("10001");
  }, PROBE_TIMEOUT);

  // ISC-26: the read-only root actually refuses writes.
  it("read-only root refuses a write outside the tmpfs", async () => {
    const r = await runInImage(["-c", "touch /probe"], { entrypoint: "/bin/sh" });
    expect(r.code).not.toBe(0);
  }, PROBE_TIMEOUT);

  // ISC-38: tini is PID 1 — asserted on the image's entrypoint, which is the
  // only honest observation point while the default process is pi itself.
  it("the image entrypoint is tini", async () => {
    const r = await realExec([
      "docker", "image", "inspect", tag, "--format", "{{json .Config.Entrypoint}}",
    ]);
    expect(r.code).toBe(0);
    const entrypoint = JSON.parse(r.stdout.trim()) as string[];
    expect(entrypoint[0]).toBe("/usr/bin/tini");
  });

  // ISC-27/28: /workspace write-through, both directions.
  it("/workspace writes are visible on the host and vice versa", async () => {
    // Not os.tmpdir(): the macOS daemon cannot see it and mounts an empty dir.
    const host = await makeDaemonScratch("ws");
    try {
      await writeFile(join(host, "from-host"), "host-wrote-this\n");
      const r = await runInImage(
        ["-c", "cat /workspace/from-host && echo container-wrote-this > /workspace/from-container"],
        { entrypoint: "/bin/sh", extra: ["-v", `${host}:/workspace`] },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("host-wrote-this");
      expect(await readFile(join(host, "from-container"), "utf8")).toContain("container-wrote-this");
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT);

  /**
   * ISC-29: /skills is read-only; a write attempt fails.
   *
   * The read assertion is not decoration. A mount the daemon cannot see comes
   * up as an empty directory, and an empty `:ro` mount refuses writes too — so
   * "touch failed" alone passes just as happily against a broken mount as a
   * working one. Reading a host-written file first is what makes the refusal
   * mean `ro` rather than `absent`.
   */
  it("/skills mounted ro refuses writes but serves reads", async () => {
    const host = await makeDaemonScratch("skills");
    try {
      await writeFile(join(host, "SKILL.md"), "skill-content\n");
      const r = await runInImage(["-c", "cat /skills/SKILL.md && touch /skills/x"], {
        entrypoint: "/bin/sh",
        extra: ["-v", `${host}:/skills:ro`],
      });
      expect(r.stdout).toContain("skill-content");
      expect(r.code).not.toBe(0);
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT);
});

describe("toolchain baseline (ISC-33..37)", () => {
  // Every worker image ships the cloud/ops baseline regardless of toolchain —
  // an SRE role that discovers mid-task that kubectl is missing is a wasted run.
  const probes: [string, string, string[]][] = [
    ["gcloud", "/usr/local/bin/gcloud", ["version"]],
    ["kubectl", "/usr/local/bin/kubectl", ["version", "--client"]],
    ["helm", "/usr/local/bin/helm", ["version"]],
    ["jq", "/usr/bin/jq", ["--version"]],
    ["curl", "/usr/bin/curl", ["--version"]],
  ];
  for (const [name, bin, args] of probes) {
    it(`${name} works inside the image`, async () => {
      const r = await runInImage(args, { entrypoint: bin });
      expect(r.code).toBe(0);
    }, PROBE_TIMEOUT);
  }
});

describe("entrypoint models.json rendering (ISC-39, ISC-40)", () => {
  // PIFLEET_WORKER_BIN is the entrypoint's documented test seam: pi itself
  // cannot print the rendered file, so the probe swaps in /bin/sh AFTER the
  // rendering step has run — same code path, observable output.
  const env = {
    PIFLEET_LLM_PROVIDER: "omlx",
    PIFLEET_LLM_BASE_URL: "http://host.docker.internal:8000/v1",
    PIFLEET_LLM_MODELS: "ModelA,ModelB",
    OMLX_API_KEY: "test-key",
    PIFLEET_WORKER_BIN: "/bin/sh",
  };

  it("renders models.json from env into a path that survives the read-only root", async () => {
    const r = await runInImage(["-c", 'cat "$HOME/.pi/agent/models.json"'], { env });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      providers: Record<string, { baseUrl: string; apiKey: string; models: { id: string }[] }>;
    };
    const omlx = doc.providers["omlx"]!;
    expect(omlx.baseUrl).toBe("http://host.docker.internal:8000/v1");
    expect(omlx.apiKey).toBe("test-key");
    expect(omlx.models.map((m) => m.id)).toEqual(["ModelA", "ModelB"]);
  }, PROBE_TIMEOUT);

  it("under a bare read-only root the file lands on the /tmp tmpfs", async () => {
    // No volume at /home/pi/.pi/agent here, so HOME must have been re-pointed.
    const r = await runInImage(["-c", 'echo "HOME=$HOME"; ls "$HOME/.pi/agent"'], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("HOME=/tmp/pi-home");
    expect(r.stdout).toContain("models.json");
  }, PROBE_TIMEOUT);

  it("an empty models list renders no provider at all", async () => {
    const r = await runInImage(["-c", 'test ! -e "$HOME/.pi/agent/models.json" && echo absent'], {
      env: { ...env, PIFLEET_LLM_MODELS: "" },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("absent");
  }, PROBE_TIMEOUT);
});

describe("verbgate (SRD §5.10)", () => {
  it("a read verb passes through to the real binary", async () => {
    const r = await runInImage(["version", "--client"], { entrypoint: "/usr/local/bin/kubectl" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Client Version");
  }, PROBE_TIMEOUT);

  it("a mutating verb with no allowlist exits 77", async () => {
    const r = await runInImage(["delete", "pod", "x"], { entrypoint: "/usr/local/bin/kubectl" });
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("not authorized");
  }, PROBE_TIMEOUT);

  /**
   * The policy now arrives on a read-only mount, not through the environment.
   * It was env-configurable, which meant the worker could hand the gate its own
   * allow file — so this test used to configure the very control it was
   * verifying.
   */
  it("an allowlisted verb prefix reaches the real binary and lands in the ledger", async () => {
    const host = await makeDaemonScratch("imgverbgate");
    try {
      await mkdir(join(host, "outbox", "ledger"), { recursive: true });
      // 0755 from mkdir leaves the container's uid 10001 unable to append; on
      // Linux the gate decision is then lost to an ENOENT the test only sees as
      // a missing ledger.
      await makeWorkerAccessible(join(host, "outbox"), true);
      await makeWorkerAccessible(join(host, "outbox", "ledger"), true);
      const policy = join(host, "cloud-allow");
      await writeFile(policy, "kubectl delete\n");
      const r = await runInImage(
        ["-c", 'kubectl delete pod x --dry-run=client 2>/dev/null; echo "gate=$?"'],
        {
          entrypoint: "/bin/sh",
          env: { PIFLEET_TASK_ID: "T-test" },
          extra: [
            "-v", `${join(host, "outbox")}:/outbox`,
            "-v", `${policy}:/policy/cloud-allow:ro`,
          ],
        },
      );
      expect(r.code).toBe(0);
      // != 77 proves the gate opened; kubectl then fails on no cluster.
      expect(r.stdout).not.toContain("gate=77");
      const ledger = await readFile(join(host, "outbox", "ledger", "verbgate.jsonl"), "utf8");
      const rows = ledger
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { decision: string; task_id: string; verb: string });
      expect(rows.some((row) => row.decision === "allow_listed" && row.task_id === "T-test")).toBe(
        true,
      );
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT);

  it("flag reordering does not sneak a mutating verb past the gate", async () => {
    // The verb tokens are collected with flags excluded, so this refuses
    // identically to the plain form.
    const r = await runInImage(["delete", "--namespace", "prod", "pod", "x"], {
      entrypoint: "/usr/local/bin/kubectl",
    });
    expect(r.code).toBe(77);
  }, PROBE_TIMEOUT);
});
