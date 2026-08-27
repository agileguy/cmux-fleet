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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type LoadedConfig } from "../../src/config/load.ts";
import {
  assertImagesReady,
  buildImage,
  imageIdentityDrift,
  ImageGateError,
  imagePresent,
  imageTag,
  parseImageTag,
  requiredImages,
  verifyImage,
} from "../../src/container/image.ts";
import { makeDaemonScratch, makeWorkerAccessible } from "../../src/container/mounts.ts";
import { realExec } from "../../src/container/run.ts";
import { cliBudget } from "../support/budget.ts";

const DOCKER = process.env.PIFLEET_DOCKER === "1";
if (!DOCKER) {
  console.warn(
    "SKIP test/integration/image.test.ts: set PIFLEET_DOCKER=1 with a Docker daemon up to run the container probes",
  );
}

const it = test.skipIf(!DOCKER);

/**
 * Generous: `docker run` probes cold-start a VM path on macOS.
 *
 * ISC-274 audit: stands at 180_000, deliberately NOT reduced. Every test here
 * performs exactly ONE container operation (`runInImage`), so `containerBudget(1)`
 * derives 60_000 — its cold floor, since the per-op term only overtakes past
 * thirty operations. That is the DERIVED number, and it is narrower than this one.
 *
 * It is not adopted because the term this constant exists for is the one
 * `containerBudget` documents as unmeasured: the first `docker run` against a
 * cold macOS VM. Measured warm on a 14-core box at load 3.55, daemon up and image
 * already built, these thirteen tests take 27-959 ms — 60x inside even the 60_000
 * floor, which is exactly why the warm number cannot decide this. Lowering a
 * ceiling on the strength of a measurement that does not exercise the path the
 * ceiling exists for is the ISC-267 mistake, and budget.ts says its floor moves
 * only on a CI measurement, in either direction.
 *
 * `BUILD_TIMEOUT` below is separate and unaffected: the build runs in `beforeAll`
 * under its own budget, so no per-test ceiling here ever has to cover it.
 */
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
  }, cliBudget(1));

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
    PIFLEET_LLM_BASE_URL: "http://omlx.pifleet.internal:8000/v1",
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
    expect(omlx.baseUrl).toBe("http://omlx.pifleet.internal:8000/v1");
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

/**
 * ISC-32 / ISC-189 — the launch gate, against REAL bytes on a REAL daemon.
 *
 * ## What was already proved, and why it was not enough
 *
 * `up-wiring.test.ts` drives the real `pifleet up` process through a `docker`
 * PATH shim and proves the WIRING: the gate is on the launch path, it refuses
 * with the right diagnosis, and the refusal happens before anything is cloned,
 * before any remote is registered, and before any supervisor starts. That is
 * the half a shim can prove, and it is the half about `up`.
 *
 * It cannot prove the half about DOCKER. Every fact the gate depends on came
 * from a shim that answered `{{json .Config.Labels}}` by taking the tag string
 * apart — so the round trip `docker build --label` -> image store ->
 * `docker image inspect` had no automated reader anywhere in the suite, and
 * nothing would have noticed if `buildImage` stopped stamping those labels
 * tomorrow. Every rig would have kept answering as though it had. The same gap
 * covered the fails-verify half: it was a shimmed verdict, never a real image
 * that really fails.
 *
 * These four probes are that half. Composed with `up-wiring.test.ts`, the
 * criterion's sentence is covered end to end — and the composition is stated
 * here rather than left to be inferred, because neither file proves it alone.
 *
 * ## Why the exit code is not the discriminator anywhere below
 *
 * Recorded because it already caught a vacuous assertion once: `up` has
 * several preflights that refuse with `EXIT.BACKEND_UNAVAILABLE`, so a
 * mutation that neuters the image gate entirely can still produce exit 3 from
 * a LATER check. The load-bearing assertions are the refusal's `reason`, the
 * values it quotes, and — in the mismatch case — the fact that the two checks
 * it stands in front of both said yes.
 */
describe("the launch gate against real images (ISC-32, ISC-189)", () => {
  /** One worker's demand on the store, in the shape `renderWorker` produces. */
  const demand = (image: string) => requiredImages([{ workerId: "w1", role: "eng", toolchain: "node" as const, image }]);

  /** Run the gate and return the refusal, failing loudly if it did not refuse. */
  async function refusal(required: ReturnType<typeof demand>): Promise<ImageGateError> {
    try {
      await assertImagesReady(required, PI_VERSION);
    } catch (err) {
      if (err instanceof ImageGateError) return err;
      throw err;
    }
    throw new Error(`the gate ACCEPTED ${required[0]?.tag ?? "?"} — it was supposed to refuse`);
  }

  /**
   * ISC-189, residual one: the labels a REAL daemon reports on a REAL image.
   *
   * `imageIdentityDrift` is built entirely on these three labels, and until
   * this probe existed nothing read them back from an actual image store. The
   * comparison is against `parseImageTag`'s reading of the tag the image was
   * BUILT under, which is the exact equality the gate depends on — so if
   * `buildImage` stopped stamping a label, or stamped a different value, this
   * fails here with a readable diff instead of silently turning the gate into
   * a check that always passes.
   */
  it("the daemon reports the build labels exactly as buildImage stamped them", async () => {
    const claim = parseImageTag(tag);
    expect(claim, `the built tag ${tag} is not in imageTag's own format`).not.toBeNull();

    const r = await realExec(
      ["docker", "image", "inspect", tag, "--format", "{{json .Config.Labels}}"],
      { timeoutMs: PROBE_TIMEOUT },
    );
    expect(r.code, `docker could not inspect ${tag}: ${r.stderr.trim()}`).toBe(0);
    // `{{json .Config.Labels}}` answers the literal `null` for an image with no
    // labels at all, which would otherwise blow up on the first index with a
    // TypeError instead of saying what went wrong.
    const labels = (JSON.parse(r.stdout.trim()) as Record<string, string> | null) ?? {};
    expect(
      Object.keys(labels),
      `the image under ${tag} carries no labels whatsoever — buildImage stopped stamping them`,
    ).not.toEqual([]);

    expect(labels["pifleet.pi-version"]).toBe(claim!.piVersion);
    expect(labels["pifleet.toolchain"]).toBe(claim!.toolchain);
    expect(labels["pifleet.config-hash"]).toBe(claim!.configHash);
    // And the tag's own claim is the config's, not merely self-consistent.
    expect(claim!.piVersion).toBe(PI_VERSION);
  }, PROBE_TIMEOUT);

  /**
   * ISC-189, the case the whole criterion is graded against: a stale-but-
   * present image.
   *
   * ONE `docker tag` puts the real worker image — the one this suite just
   * built, that passes every check `verifyImage` makes — under a tag whose
   * config-hash is not its own. A registry pull does this whenever two builds
   * ever shared a name; an operator does it by hand more often than anyone
   * admits.
   *
   * The two assertions BEFORE the refusal are what make the third mean
   * anything: the old gate's presence check says PRESENT, and the old gate's
   * verification says OK, on this exact tag, against this exact daemon. Both
   * halves of the pre-identity gate pass on the wrong image. Without them this
   * would only show that some gate refused something.
   */
  it("a real image filed under another tag passes presence AND verify, and is still refused", async () => {
    const claim = parseImageTag(tag)!;
    // Derived from the real hash so it is deterministic, and asserted distinct
    // rather than assumed — a collision here would silently vacate the test.
    const otherHash = createHash("sha256").update(claim.configHash).digest("hex").slice(0, 12);
    expect(otherHash).not.toBe(claim.configHash);
    const stranger = `${loaded.config.docker.image_prefix}:${claim.piVersion}-${claim.toolchain}-${otherHash}`;

    const tagged = await realExec(["docker", "tag", tag, stranger], { timeoutMs: PROBE_TIMEOUT });
    expect(tagged.code, `docker tag failed: ${tagged.stderr.trim()}`).toBe(0);
    try {
      const presence = await imagePresent(stranger);
      expect(
        presence.present,
        `the retagged image is not present, so this probe is not testing what it claims: ${presence.detail}`,
      ).toBe(true);

      const verified = await verifyImage(stranger, PI_VERSION);
      expect(
        verified.ok,
        `verifyImage REFUSED the retagged image, so the mismatch below would be caught by the ` +
          `behavioural half anyway and this probe proves nothing about identity. Failed checks: ` +
          JSON.stringify(verified.checks.filter((c) => !c.ok)),
      ).toBe(true);

      const err = await refusal(demand(stranger));
      expect(err.reason).toBe("mismatched");
      expect(err.tag).toBe(stranger);
      expect(err.roles).toEqual(["eng"]);
      // The diagnosis must carry BOTH values, or an operator cannot tell which
      // way the drift runs and has nothing to rebuild against.
      expect(err.message).toContain(claim.configHash);
      expect(err.message).toContain(otherHash);
      expect(err.message).toContain("pifleet.config-hash");
    } finally {
      await realExec(["docker", "rmi", stranger], { timeoutMs: PROBE_TIMEOUT });
    }
  }, PROBE_TIMEOUT * 3);

  /**
   * ISC-189, the pre-existing residual: a real image that really FAILS
   * verification, rather than a shimmed verdict.
   *
   * Built `FROM` the real image with nothing changed but the user, and stamped
   * with identity labels that MATCH its tag — so presence passes and the
   * identity check passes, and the run reaches the verification stage under
   * its own power. `verifyImage`'s uid-10001 check is what refuses: this image
   * runs as root, which is the deterministic-bind-mount-ownership property of
   * SRD §5.2 and not an incidental one.
   *
   * The identity labels matching is the load-bearing detail. Without them the
   * gate would refuse at `imageIdentityDrift` one step earlier, this test
   * would pass, and the fails-verify path would still never have run against a
   * real daemon.
   */
  it("a real image that fails verification is refused at the verify stage", async () => {
    const claim = parseImageTag(tag)!;
    const badHash = createHash("sha256").update(`${claim.configHash}-root`).digest("hex").slice(0, 12);
    expect(badHash).not.toBe(claim.configHash);
    const badTag = `${loaded.config.docker.image_prefix}:${claim.piVersion}-${claim.toolchain}-${badHash}`;

    const ctx = await mkdtemp(join(tmpdir(), "pifleet-badimage-"));
    try {
      const dockerfile = join(ctx, "Dockerfile");
      await writeFile(dockerfile, `FROM ${tag}\nUSER root\n`);
      const built = await realExec(
        [
          "docker", "build", "-f", dockerfile,
          "--label", `pifleet.pi-version=${claim.piVersion}`,
          "--label", `pifleet.toolchain=${claim.toolchain}`,
          "--label", `pifleet.config-hash=${badHash}`,
          "-t", badTag, ctx,
        ],
        { timeoutMs: PROBE_TIMEOUT * 2 },
      );
      expect(built.code, `building the root-user image failed: ${built.stderr.slice(-2000)}`).toBe(0);

      // It really is present, and its identity really does match its tag —
      // otherwise the refusal below would be the mismatch case in disguise.
      expect((await imagePresent(badTag)).present).toBe(true);
      const drift = await imageIdentityDrift(badTag);
      expect(drift, `the labels do not match the tag, so this refuses one stage too early`).toBeNull();

      const err = await refusal(demand(badTag));
      expect(err.reason).toBe("unverified");
      expect(err.tag).toBe(badTag);
      expect(err.message).toContain("uid-10001");
    } finally {
      await realExec(["docker", "rmi", "-f", badTag], { timeoutMs: PROBE_TIMEOUT });
      await rm(ctx, { recursive: true, force: true });
    }
  }, PROBE_TIMEOUT * 4);

  /**
   * The positive control, and it is not optional: a gate that refused
   * EVERYTHING would pass both refusal probes above.
   *
   * This runs the real gate — real presence check, real identity check, real
   * `verifyImage` starting real containers — against the tag the image was
   * actually built under, and requires it to advance: no throw, and `onReady`
   * called exactly once with the daemon's own image id.
   */
  it("the same gate accepts the tag the image was built under", async () => {
    const ready: Array<{ tag: string; id: string }> = [];
    await assertImagesReady(demand(tag), PI_VERSION, {
      onReady: (img) => {
        ready.push({ tag: img.tag, id: img.id });
      },
    });
    expect(ready).toHaveLength(1);
    expect(ready[0]!.tag).toBe(tag);
    // A real image id, not an empty string a `--format` miss would produce.
    expect(ready[0]!.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, PROBE_TIMEOUT * 3);
});
