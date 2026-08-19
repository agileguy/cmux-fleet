/**
 * The egress relay, against a real daemon (SRD §5.6, §5.9, §12.4;
 * ISC-50, ISC-51, ISC-57).
 *
 * `test/integration/egress.test.ts` proves the bridge DENIES; the unit suite
 * proves the argv and the matcher. Only this file proves the thing the two
 * halves exist for: that a container with NO special flags, attached to
 * nothing but the deny-all internal network, completes a real model-shaped
 * call to `host.docker.internal` — and still cannot reach the internet.
 *
 * That combination is the whole point, so both halves are asserted in ONE
 * test against ONE container. Splitting them would let a future change open
 * the internet in the same edit that fixes the relay and leave the suite
 * green.
 *
 * Each test also asserts the destination is unreachable BEFORE the relay
 * exists, from the same network and the same image. Without that, "the call
 * succeeded" proves only that curl works: an internal network that had never
 * actually been internal would pass every remaining assertion here.
 *
 * The primary test uses a STUB upstream in this process on an ephemeral port,
 * not the real oMLX server, so it runs anywhere Docker does. The real oMLX
 * server exists only on the maintainer's machine; the second test uses it
 * when it is there and skips cleanly when it is not.
 *
 * Gated exactly like the egress and verbgate suites: `PIFLEET_DOCKER=1`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ensureEgressNetwork } from "../../src/security/network.ts";
import {
  ensureEgressRelay,
  inspectRelayContainer,
  relayContainerName,
  uplinkNetworkName,
} from "../../src/security/relay.ts";

/** Client container image: needs bash + curl, same as the egress suite. */
const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] relay integration tests need a Docker daemon, ${IMAGE}, and node:24-bookworm-slim. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

/**
 * Is the maintainer's real oMLX server up? `401` counts — it means the TCP
 * path and the HTTP server are both there and only the key is missing, which
 * is exactly what a reachable oMLX looks like without credentials.
 */
async function omlxReachable(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:8000/v1/models", {
      signal: AbortSignal.timeout(3_000),
    });
    return r.status === 200 || r.status === 401;
  } catch {
    return false;
  }
}

const OMLX_KEY = process.env.OMLX_API_KEY ?? "";
const OMLX_LIVE = DOCKER && OMLX_KEY !== "" && (await omlxReachable());
if (DOCKER && !OMLX_LIVE) {
  console.warn(
    "[skip] live oMLX relay test: needs a reachable http://localhost:8000 and OMLX_API_KEY.",
  );
}

let seq = 0;
function testNetName(): string {
  seq += 1;
  return `pifleet-relay-it-${process.pid}-${seq}`;
}

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  return { code, stdout, stderr };
}

/**
 * Containers come down before networks: Docker refuses to remove a network
 * that still has an endpoint attached, and the relay is attached to two.
 */
const cleanupContainers: string[] = [];
const cleanupNetworks: string[] = [];
afterEach(async () => {
  for (const c of cleanupContainers.splice(0)) await docker(["rm", "-f", c]);
  for (const n of cleanupNetworks.splice(0)) await docker(["network", "rm", n]);
});

/**
 * Register every artifact `ensureEgressRelay` will create BEFORE creating it,
 * so a test that fails halfway still cleans up after itself.
 */
function registerRelayArtifacts(net: string): void {
  cleanupNetworks.push(net);
  cleanupContainers.push(relayContainerName(net));
  cleanupNetworks.push(uplinkNetworkName(net));
}

/**
 * Run a script in the worker image attached to ONLY the internal network —
 * no `--add-host`, no extra networks, no capabilities. This is deliberately
 * the least-privileged container this project can produce, because the claim
 * under test is that an ordinary worker needs nothing special.
 */
async function onInternalNetwork(net: string, script: string): Promise<string> {
  const r = await docker([
    "run",
    "--rm",
    "--network",
    net,
    "--entrypoint",
    "bash",
    IMAGE,
    "-c",
    script,
  ]);
  return r.stdout + r.stderr;
}

/** One curl with a retry loop, printing a parseable `key=...` line. */
function curlProbe(key: string, url: string, header = ""): string {
  const h = header === "" ? "" : `-H ${JSON.stringify(header)}`;
  return `body=""
     for i in $(seq 1 30); do
       body=$(curl -sS -m 5 ${h} ${JSON.stringify(url)} 2>/dev/null) && break
       sleep 0.5
     done
     echo "${key}=$body"`;
}

describe.skipIf(!DOCKER)("egress relay", () => {
  test(
    "a worker on the deny-all bridge reaches oMLX through the relay and nothing else",
    async () => {
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);

      /**
       * A stand-in for oMLX, in THIS process, on an ephemeral port.
       *
       * Ephemeral rather than 8000 on purpose: the real oMLX server may well
       * be holding 8000 on the machine running this suite, and a hardcoded
       * port would then test the relay against the wrong server — or fail to
       * bind at all. It also proves the port is genuinely read from
       * `llm.base_url` rather than hardcoded anywhere in the path.
       */
      const nonce = `stub-${process.pid}-${Date.now()}`;
      const stub = Bun.serve({
        port: 0,
        hostname: "0.0.0.0",
        fetch(req) {
          const { pathname } = new URL(req.url);
          if (pathname !== "/v1/models") return new Response("nope", { status: 404 });
          return Response.json({ object: "list", data: [{ id: nonce, object: "model" }] });
        },
      });
      const port = stub.port;
      const url = `http://host.docker.internal:${port}/v1/models`;

      try {
        // BEFORE: the destination is unreachable from the bridge. This is the
        // failure the relay exists to fix, demonstrated rather than assumed —
        // and it is what makes the success below mean something.
        const before = await onInternalNetwork(
          net,
          `curl -sS -m 5 ${JSON.stringify(url)} >/dev/null 2>&1; echo "pre=$?"`,
        );
        expect(before).not.toContain("pre=0");

        const relay = await ensureEgressRelay({ llm: { base_url: `http://host.docker.internal:${port}/v1` } }, net);
        expect(relay.created).toBe(true);
        expect(relay.name).toBe(relayContainerName(net));

        /**
         * AFTER, from a container attached to nothing but the internal bridge:
         *  - the oMLX-shaped call returns the STUB'S OWN body (ISC-50), and
         *    the nonce is what proves it came from the real upstream rather
         *    than from anything Docker synthesized;
         *  - a public IP literal and a public name both fail (ISC-51, ISC-57)
         *    — the IP proves the ROUTE is absent, not merely the resolver.
         */
        const after = await onInternalNetwork(
          net,
          `${curlProbe("models", url)}
           curl -sS -m 5 https://1.1.1.1/ >/dev/null 2>&1; echo "ip=$?"
           curl -sS -m 5 https://example.com/ >/dev/null 2>&1; echo "name=$?"`,
        );
        expect(after).toContain(nonce);
        expect(after).toContain(`"object":"list"`);
        expect(after).not.toContain("ip=0");
        expect(after).not.toContain("name=0");

        // Idempotence, the property `up` depends on: a second ensure adopts
        // the running relay rather than rebuilding a shared resource other
        // fleets may be using right now.
        const again = await ensureEgressRelay({ llm: { base_url: `http://host.docker.internal:${port}/v1` } }, net);
        expect(again).toEqual({ name: relay.name, created: false });
        const status = await inspectRelayContainer(relay.name);
        expect(status.running).toBe(true);
      } finally {
        stub.stop(true);
      }
    },
    180_000,
  );

  test(
    "a stopped relay is rebuilt, not adopted as healthy",
    async () => {
      // The quiet downgrade this module refuses: the relay is recognized by a
      // deterministic NAME, so a dead container wearing that name would be
      // adopted by every later `up` and the fleet would report a model path
      // that forwards nothing.
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);

      const nonce = `stub-stop-${process.pid}-${Date.now()}`;
      const stub = Bun.serve({
        port: 0,
        hostname: "0.0.0.0",
        fetch: () => Response.json({ object: "list", data: [{ id: nonce }] }),
      });
      const base = `http://host.docker.internal:${stub.port}/v1`;
      try {
        const first = await ensureEgressRelay({ llm: { base_url: base } }, net);
        expect(first.created).toBe(true);
        const stopped = await docker(["stop", "-t", "1", first.name]);
        expect(stopped.code).toBe(0);

        const second = await ensureEgressRelay({ llm: { base_url: base } }, net);
        expect(second.created).toBe(true);
        expect((await inspectRelayContainer(second.name)).running).toBe(true);

        // And the rebuilt relay actually forwards — "running" is a claim, the
        // stub's own body is the fact.
        const out = await onInternalNetwork(
          net,
          curlProbe("models", `http://host.docker.internal:${stub.port}/v1/models`),
        );
        expect(out).toContain(nonce);
      } finally {
        stub.stop(true);
      }
    },
    180_000,
  );

  test(
    "a base_url pointing away from the Docker host is refused before anything is created",
    async () => {
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);
      await expect(
        ensureEgressRelay({ llm: { base_url: "http://10.0.0.5:8000/v1" } }, net),
      ).rejects.toThrow(/host\.docker\.internal/);
      // Nothing was built on the way to that refusal.
      expect((await inspectRelayContainer(relayContainerName(net))).exists).toBe(false);
    },
    120_000,
  );

  test.skipIf(!OMLX_LIVE)(
    "the REAL oMLX model list comes back through the relay, from inside the bridge",
    async () => {
      /**
       * The live counterpart to the stub test (ISC-50 proper): a genuine
       * `GET /v1/models` against the real local inference server, authenticated
       * with the real key, from a container that has no route to it except the
       * relay.
       *
       * Asserted as "both sides return a non-empty list of model ids", not as
       * an exact set: oMLX's loaded models change as the maintainer works, and
       * a test that pins today's model names would fail for reasons that have
       * nothing to do with egress.
       */
      const net = testNetName();
      registerRelayArtifacts(net);
      await ensureEgressNetwork(net);

      const direct = (await (
        await fetch("http://localhost:8000/v1/models", {
          headers: { Authorization: `Bearer ${OMLX_KEY}` },
          signal: AbortSignal.timeout(10_000),
        })
      ).json()) as { data?: Array<{ id?: unknown }> };
      const directIds = (direct.data ?? []).map((m) => m.id).filter((id) => typeof id === "string");
      expect(directIds.length).toBeGreaterThan(0);

      const relay = await ensureEgressRelay(
        { llm: { base_url: "http://host.docker.internal:8000/v1" } },
        net,
      );
      expect(relay.created).toBe(true);

      const out = await onInternalNetwork(
        net,
        curlProbe(
          "models",
          "http://host.docker.internal:8000/v1/models",
          `Authorization: Bearer ${OMLX_KEY}`,
        ),
      );
      const line = out.split("\n").find((l) => l.startsWith("models="));
      expect(line).toBeDefined();
      const body = JSON.parse(line!.slice("models=".length)) as { data?: Array<{ id?: unknown }> };
      const throughRelay = (body.data ?? []).map((m) => m.id).filter((id) => typeof id === "string");
      expect(throughRelay.length).toBeGreaterThan(0);
      // Same server, so the two lists must overlap — a relay pointed at some
      // other listener could still return a well-formed model list.
      expect(throughRelay.some((id) => directIds.includes(id))).toBe(true);
    },
    180_000,
  );
});
