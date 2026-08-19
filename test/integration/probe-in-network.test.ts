/**
 * The ISC-53 probe runs from INSIDE the egress network (ISC-260).
 *
 * ## Why this file exists, when `up-wiring.test.ts` already covers the gate
 *
 * `up-wiring.test.ts` proves the WIRING — that `up` issues the probe, against
 * the configured endpoint, carrying tools, and refuses with the right exit
 * code. It cannot prove the vantage, because it runs against a `docker` PATH
 * shim and there is no network for anything to be inside of.
 *
 * The vantage is the entire criterion. A gate that certifies reachability it
 * did not test is worse than no gate, because it is trusted: ISC-53 passes on
 * the host, a model is certified, and every worker is denied at runtime — the
 * "burns a whole run before anyone notices" failure §5.9 makes the probe
 * mandatory to prevent.
 *
 * ## The discriminator
 *
 * The stub oMLX is a CONTAINER on the internal bridge, published on no port
 * and reachable only by network alias. That makes the two vantages give
 * OPPOSITE answers for one identical URL, which is what turns "the probe runs
 * inside the network" from a claim a comment can make into a thing a test can
 * fail. Measured on Docker 28 before this file was written:
 *
 *     from a container on the bridge : HTTP 200, body intact, auth header present
 *     from the host                  : Unable to connect. Is the computer able
 *                                      to access the url?
 *
 * So `probeVantageIsInsideTheNetwork` below is not merely a positive test. Move
 * the probe back to the host — restore `hostFacingBaseUrl`, pass the global
 * `fetch`, anything — and it goes red, because the host has no route to this
 * stub and no way to resolve its name. There is no rewrite that rescues it,
 * which is the property `up-wiring.test.ts` cannot offer: reverting the
 * vantage there is caught only INDIRECTLY, as a side effect of the URL rewrite
 * having been deleted too, so a reversion that restored both would pass.
 *
 * ## Gating
 *
 * `PIFLEET_DOCKER=1`, like every other suite here that needs a daemon, and it
 * is RUN by the container job in `.github/workflows/ci.yml` rather than left
 * to self-skip. A skip that nothing counts is how four criteria in this
 * project once reported green having executed nothing; `probe-guard.sh` counts
 * these.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { containerFetch, containerProbeArgv, PROBE_CONTAINER_LABEL } from "../../src/security/probe-transport.ts";
import { probeNativeToolCalls } from "../../src/security/model-probe.ts";
import { ensureEgressNetwork } from "../../src/security/network.ts";
import { RELAY_IMAGE } from "../../src/security/relay.ts";
import { realExec } from "../../src/container/run.ts";

const DOCKER = process.env["PIFLEET_DOCKER"] === "1";
if (!DOCKER) {
  console.log(
    "SKIP test/integration/probe-in-network.test.ts: set PIFLEET_DOCKER=1 to run the " +
      "in-network probe checks against a real daemon",
  );
}

/** Unique per process so a parallel run never collides on a name. */
const TAG = `pifleet-isc260-${process.pid.toString(36)}`;
const NETWORK = `${TAG}-net`;
const STUB = `${TAG}-stub`;
/** The alias the stub answers to on the bridge. Deliberately NOT a real host. */
const STUB_ALIAS = "omlx-stub";
const STUB_PORT = 9999;

/** A well-formed native tool call — the shape a compatible model returns. */
const TOOL_CALL_BODY = {
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_isc260", type: "function", function: { name: "pifleet_probe", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
};

/**
 * The stub, as an inline script.
 *
 * Inline rather than bind-mounted for the same reason the probe's own script
 * is: bind mounts only work from paths the Docker VM shares, and a temp
 * directory is not one of them. Measured — the mounted file was simply absent
 * inside the container and it exited 1 with `Cannot find module`.
 *
 * It records every request it receives into its own stdout, so "the probe
 * reached this server" is read off `docker logs` rather than inferred from the
 * probe having succeeded.
 */
const STUB_SCRIPT = [
  'const http = require("node:http");',
  `const BODY = ${JSON.stringify(JSON.stringify(TOOL_CALL_BODY))};`,
  "http",
  "  .createServer((req, res) => {",
  '    let body = "";',
  '    req.on("data", (c) => { body += c; });',
  '    req.on("end", () => {',
  '      console.log("HIT " + req.method + " " + req.url +',
  '        " auth=" + (req.headers.authorization ? "yes" : "no") +',
  '        " tools=" + (body.indexOf("pifleet_probe") >= 0 ? "yes" : "no"));',
  '      res.writeHead(200, { "Content-Type": "application/json" });',
  "      res.end(BODY);",
  "    });",
  "  })",
  `  .listen(${STUB_PORT}, "0.0.0.0", () => console.log("stub listening"));`,
].join("\n");

async function docker(args: string[], timeoutMs = 120_000) {
  return realExec(["docker", ...args], { timeoutMs });
}

/**
 * Everything this file creates, torn down in `afterAll` whether or not the
 * tests passed. Docker refuses to remove a network that still has an endpoint
 * attached, so the container goes first.
 */
async function cleanup(): Promise<void> {
  await docker(["rm", "-f", STUB], 60_000).catch(() => {});
  await docker(["network", "rm", NETWORK], 60_000).catch(() => {});
}

beforeAll(async () => {
  if (!DOCKER) return;
  await cleanup();
  await ensureEgressNetwork(NETWORK);
  const started = await docker([
    "run",
    "-d",
    "--name",
    STUB,
    "--network",
    NETWORK,
    "--network-alias",
    STUB_ALIAS,
    RELAY_IMAGE,
    "node",
    "-e",
    STUB_SCRIPT,
  ]);
  if (started.code !== 0) throw new Error(`could not start the stub oMLX: ${started.stderr}`);
  // `docker run -d` exiting 0 means the container STARTED, not that it stayed
  // up — the same distinction `ensureEgressRelay` re-inspects for. Wait for the
  // server to announce itself rather than sleeping a hopeful interval.
  for (let i = 0; i < 100; i++) {
    const logs = await docker(["logs", STUB], 15_000);
    if (logs.stdout.includes("stub listening")) return;
    const alive = await docker(["inspect", STUB, "--format", "{{.State.Running}}"], 15_000);
    if (alive.stdout.trim() !== "true") {
      throw new Error(`the stub oMLX exited before listening: ${logs.stdout}${logs.stderr}`);
    }
    await Bun.sleep(100);
  }
  throw new Error("the stub oMLX never announced itself");
}, 180_000);

afterAll(async () => {
  if (!DOCKER) return;
  await cleanup();
}, 120_000);

/** The URL under test. Resolvable ONLY on the bridge — that is the point. */
const STUB_BASE_URL = `http://${STUB_ALIAS}:${STUB_PORT}/v1`;

describe("the native-tool-call probe is issued from inside the egress network (ISC-260)", () => {
  /**
   * The negative half, and it runs FIRST on purpose.
   *
   * If the host could reach this URL, the positive test below would prove
   * nothing at all — it would pass from either vantage and the whole file
   * would be decorative. So the discriminator is established as a measurement
   * before anything depends on it, rather than being asserted in a comment.
   */
  test.skipIf(!DOCKER)("the HOST cannot reach the stub at all, which is what makes this a test", async () => {
    let reached = false;
    try {
      const res = await fetch(`${STUB_BASE_URL}/chat/completions`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      reached = res.ok;
    } catch {
      // Expected: the name does not resolve off the bridge and there is no
      // published port behind it.
    }
    expect(reached).toBe(false);
  }, 60_000);

  /**
   * The criterion itself: the same URL, dialled through the transport `up`
   * uses, succeeds — because the request originates on the bridge.
   */
  test.skipIf(!DOCKER)("the probe reaches an endpoint only the egress network can see", async () => {
    const result = await probeNativeToolCalls(
      STUB_BASE_URL,
      "isc260-test-key",
      "stub-model",
      containerFetch({ network: NETWORK }),
    );
    expect(result.failure).toBeNull();
    expect(result.ok).toBe(true);
  }, 120_000);

  /**
   * The stub's own record of what arrived, read off the server rather than
   * inferred from the client's verdict.
   *
   * `ok: true` above is satisfied by anything that returns the right JSON. It
   * would still be satisfied if the transport had somehow answered from a
   * cache, or if the probe had reached a different server. The far end saying
   * it received a `tools`-bearing POST carrying an `Authorization` header is
   * the independent half.
   *
   * The auth header matters for a second reason. It travels on STDIN, never in
   * argv, because `docker run` argv is visible in `ps` to every user on the
   * host — so this assertion also proves the credential path works, without
   * putting a credential anywhere near this file.
   */
  test.skipIf(!DOCKER)("the stub itself recorded a tools-bearing, authenticated request", async () => {
    const logs = await docker(["logs", STUB], 30_000);
    const hits = logs.stdout.split("\n").filter((l) => l.startsWith("HIT "));
    expect(hits.length).toBeGreaterThan(0);
    const last = hits[hits.length - 1] ?? "";
    expect(last).toContain("POST /v1/chat/completions");
    expect(last).toContain("auth=yes");
    expect(last).toContain("tools=yes");
  }, 60_000);

  /**
   * `--network` is the security property, so it is pinned in the argv rather
   * than trusted to the caller.
   *
   * The same reason `network.ts` exports `networkCreateArgv` and pins
   * `--internal`: a test that only checks "a container ran" passes with the
   * flag missing, and a probe on the DEFAULT bridge would reach oMLX on many
   * machines while testing nothing the criterion asks about.
   */
  test("the probe argv attaches to the configured network and nothing else", () => {
    const argv = containerProbeArgv("pifleet-egress", RELAY_IMAGE);
    expect(argv.slice(0, 5)).toEqual(["docker", "run", "--rm", "-i", "--network"]);
    expect(argv[5]).toBe("pifleet-egress");
    expect(argv).toContain("--label");
    expect(argv).toContain(PROBE_CONTAINER_LABEL);
    // Digest-pinned, and the same image the relay runs — one pin, not two.
    expect(argv).toContain(RELAY_IMAGE);
    expect(RELAY_IMAGE).toContain("@sha256:");
    // No published ports, no host networking, no privilege.
    expect(argv).not.toContain("-p");
    expect(argv).not.toContain("--privileged");
    expect(argv.join(" ")).not.toContain("--network host");
  });

  /**
   * A network name is operator input from `fleet.yaml`, and an argv ARRAY
   * stops quoting injection but NOT flag injection: a "name" of
   * `--privileged` parses as an option, not as a network. `network.ts` learned
   * this for `docker network create`; the same input reaches `docker run`
   * here.
   */
  test("a network name that is really a flag is refused, not passed through", () => {
    expect(() => containerProbeArgv("--privileged", RELAY_IMAGE)).toThrow();
    expect(() => containerProbeArgv("--network=host", RELAY_IMAGE)).toThrow();
  });
});
