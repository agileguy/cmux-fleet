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
import { ensureEgressNetwork, ensureUplinkNetwork } from "../../src/security/network.ts";
import {
  ensureEgressRelay,
  inspectRelayContainer,
  relayContainerName,
  uplinkNetworkName,
  type RelayTarget,
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

async function docker(
  args: string[],
  env?: Readonly<Record<string, string>>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
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
async function onNetwork(
  net: string,
  script: string,
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  // `-e NAME` with NO `=value` tells docker to copy the variable out of its own
  // environment. The value never appears in argv, so it is not in `ps`, not in
  // the ephemeral container's `docker inspect`, and not in a CI log that echoes
  // the command — which is what `-H "Authorization: Bearer <key>"` interpolated
  // into a shell string used to do with the real oMLX key.
  const envArgs: string[] = [];
  for (const name of Object.keys(env)) envArgs.push("-e", name);
  const r = await docker(
    ["run", "--rm", ...envArgs, "--network", net, "--entrypoint", "bash", IMAGE, "-c", script],
    env,
  );
  /**
   * A non-zero `docker run` is a BROKEN PROBE, not a measurement.
   *
   * This helper used to return `stdout + stderr` and never look at `r.code`,
   * which made every `not.toContain(...)` assertion built on it a vacuous
   * pass: if `docker run` failed outright — image missing, daemon hiccup,
   * network already gone — the returned string was an error message, and "this
   * error message does not contain `ip=0`" is true of every error message ever
   * written. The DENY half of ISC-51/57 rested entirely on assertions of that
   * shape, with nothing playing the role `toContain(nonce)` plays for the
   * reach half.
   *
   * The probe scripts all end in `echo`, so the container exits 0 even when the
   * curl inside it fails. A non-zero code here therefore always means the
   * container did not run — never that the probe observed a denial.
   */
  if (r.code !== 0) {
    throw new Error(
      `relay test: probe container exited ${r.code} — the probe did not run, so nothing was ` +
        `measured. stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
    );
  }
  return r.stdout + r.stderr;
}

/**
 * The least-privileged container this project can produce, on the INTERNAL
 * bridge specifically — no `--add-host`, no extra networks, no capabilities.
 * Most claims here are about what an ordinary worker can do, and an ordinary
 * worker gets exactly this.
 */
const onInternalNetwork = onNetwork;

/**
 * Bash that derives THIS container's gateway and probes a TCP port on it.
 *
 * No `ip` and no `nc` in the worker image (measured), so both halves come from
 * things that are always there: `/proc/net/route` and `curl`.
 *
 *  - Gateway: the default route's gateway when there is one. On an `--internal`
 *    bridge there is NO default route, so it is derived from the single on-link
 *    route the way Docker assigns it — network address + 1. `/proc/net/route`
 *    is little-endian hex, hence the byte reversal.
 *  - Reachability: `curl` exit 7 is "could not connect" (refused, or no route).
 *    Anything else means the TCP connection was ESTABLISHED — measured live: a
 *    port with sshd behind it returns exit 1 (`unsupported protocol`, because
 *    an SSH banner is not HTTP), a closed port on a reachable host returns 7,
 *    and an unroutable address returns 7. Exit 28 (timeout) is treated as NOT
 *    connected, which is the conservative direction for a deny assertion.
 */
// Deliberately written with no `${...}` bash parameter expansions: this is a
// JS template literal, and `${` would be interpolated by JavaScript before
// bash ever sees it. Only `$VAR` and `$(...)` forms appear below.
const GATEWAY_PROBE = `
  hex2ip() {
    h=$1
    printf "%d.%d.%d.%d\\n" \\
      0x$(echo "$h" | cut -c7-8) 0x$(echo "$h" | cut -c5-6) \\
      0x$(echo "$h" | cut -c3-4) 0x$(echo "$h" | cut -c1-2)
  }
  GWHEX=$(awk '$2=="00000000" {print $3; exit}' /proc/net/route)
  if [ -n "$GWHEX" ] && [ "$GWHEX" != "00000000" ]; then
    GW=$(hex2ip "$GWHEX")
  else
    DEST=$(awk 'NR==2 {print $2; exit}' /proc/net/route)
    NET=$(hex2ip "$DEST")
    GW="$(echo "$NET" | cut -d. -f1-3).1"
  fi
  echo "gateway=$GW"
  probe() {
    curl -sS -m 3 "http://$1:$2/" >/dev/null 2>&1
    code=$?
    if [ "$code" -eq 7 ] || [ "$code" -eq 28 ]; then
      echo "port$2=closed"
    else
      echo "port$2=open"
    fi
  }
`;

/** Ports worth asking about on a Docker host. 22 is the live case here. */
const GATEWAY_CANDIDATE_PORTS = [22, 2375, 2376, 111, 53] as const;

function gatewayScan(ports: readonly number[]): string {
  return `${GATEWAY_PROBE}\n${ports.map((p) => `probe "$GW" ${p}`).join("\n")}`;
}

function parseKv(out: string, key: string): string | null {
  const line = out.split("\n").find((l) => l.trim().startsWith(`${key}=`));
  return line === undefined ? null : line.trim().slice(key.length + 1);
}

function openPorts(out: string): number[] {
  return [...out.matchAll(/^port(\d+)=open$/gm)].map((m) => Number(m[1]));
}

/**
 * A full `RelayConfigView` (= `EgressConfigView`).
 *
 * `ensureEgressRelay` now runs each target through `decide()` before it builds
 * argv (ISC-253), so it needs the `egress` half of the config as well as
 * `llm`. See `test/unit/relay.test.ts` for exactly how much that gate proves
 * today — including the documented case it does NOT catch.
 */
function cfg(base_url: string) {
  return {
    llm: { base_url },
    egress: { google_hosts: ["oauth2.googleapis.com"], allow: [] as Array<never> },
  };
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

/**
 * What the deny-all bridge ACTUALLY denies (M1; SRD §12.8; ISC-51, ISC-57).
 *
 * These replace sampling with enumeration, and they exist because the sampled
 * version did not catch the thing that was actually open. The old evidence
 * probed two destinations — `1.1.1.1` and `example.com` — concluded "no route
 * to the public internet", and never measured the bridge GATEWAY, which was
 * serving sshd the entire time.
 */
describe.skipIf(!DOCKER)("what the internal bridge denies — enumerated, not sampled", () => {
  test(
    "exactly one on-link route, no default route, and nothing off-subnet is reachable",
    async () => {
      const net = testNetName();
      cleanupNetworks.push(net);
      await ensureEgressNetwork(net);

      const out = await onInternalNetwork(
        net,
        `${GATEWAY_PROBE}
         echo "routecount=$(($(wc -l < /proc/net/route) - 1))"
         echo "defaultroutes=$(awk '$2=="00000000"' /proc/net/route | wc -l)"
         echo "onlink=$(awk 'NR>1 && $3=="00000000"' /proc/net/route | wc -l)"
         curl -sS -m 4 https://1.1.1.1/          >/dev/null 2>&1; echo "pubip=$?"
         curl -sS -m 4 https://example.com/      >/dev/null 2>&1; echo "pubname=$?"
         curl -sS -m 4 http://192.168.86.49:8000/ >/dev/null 2>&1; echo "lan=$?"
         curl -sS -m 4 http://169.254.169.254/   >/dev/null 2>&1; echo "metadata=$?"
         curl -sS -m 4 http://192.168.5.2:22/    >/dev/null 2>&1; echo "limahost=$?"`,
      );

      // ENUMERATION, not sampling. One route, on-link, no default. This is the
      // structural claim — "nothing off the bridge subnet is routable" — and it
      // is strictly stronger than probing a handful of addresses, because it
      // bounds the whole address space rather than five points in it.
      expect(parseKv(out, "routecount")).toBe("1");
      expect(parseKv(out, "defaultroutes")).toBe("0");
      expect(parseKv(out, "onlink")).toBe("1");

      // The sampled probes are kept as corroboration, now as POSITIVE
      // assertions of a non-zero curl exit rather than `not.toContain("=0")`.
      // Note what each one actually proves: an IP literal proves the ROUTE is
      // absent; a NAME proves the resolver is too. The LAN address matters
      // because it is where oMLX is proposed to move (ISC-259), and the
      // metadata address because it is the classic container escape target.
      for (const key of ["pubip", "pubname", "lan", "metadata", "limahost"]) {
        expect(out).toMatch(new RegExp(`^${key}=[1-9][0-9]*$`, "m"));
      }
    },
    180_000,
  );

  test(
    "ACCEPTED RESIDUAL: the bridge gateway IS reachable from the deny-all bridge",
    async () => {
      /**
       * This test asserts a HOLE, on purpose. Read it before changing it.
       *
       * `--internal` is not "no route off this container". Docker implements
       * internal-network isolation as FORWARD-chain rules:
       *
       *   -A DOCKER-ISOLATION-STAGE-1 ! -d 172.18.0.0/16 -i br-<id> -j DROP
       *
       * The bridge gateway is on-link and INSIDE that subnet, so traffic to it
       * is delivered locally through INPUT (policy ACCEPT) and never meets
       * those rules. Every port the Docker host listens on is therefore
       * reachable from the "deny-all" bridge, relay or no relay. Measured here
       * on 2026-08-19: a container with no default route pulled a full
       * `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.13` banner off 172.18.0.1:22.
       *
       * That is recorded as an accepted, documented residual in SRD §12.8, and
       * ISC-51/57 are worded to what Docker actually guarantees — no route off
       * the bridge SUBNET — rather than to the stronger claim the branch used
       * to make. Closing it needs host-side iptables outside Docker's model or
       * a Docker host whose gateway serves nothing; neither is in this PR.
       *
       * IF THIS TEST FAILS, that is very likely GOOD NEWS: the gateway was
       * hardened, the residual closed, and SRD §12.8 plus ISC-51/57 should be
       * tightened to match. Do not "fix" it by deleting the assertion.
       *
       * It is deliberately NOT circular. The port under test is discovered from
       * a NON-internal network first — where reaching the gateway is expected
       * and uncontroversial — and only then asserted from the internal one. So
       * the claim is "a port the Docker host genuinely serves is reachable from
       * the deny-all bridge exactly as it is from an ordinary bridge", not "a
       * port I already found open is open".
       */
      const net = testNetName();
      const uplink = uplinkNetworkName(net);
      cleanupNetworks.push(net);
      cleanupNetworks.push(uplink);
      await ensureEgressNetwork(net);
      await ensureUplinkNetwork(uplink);

      const fromUplink = await onNetwork(uplink, gatewayScan([...GATEWAY_CANDIDATE_PORTS]));
      const served = openPorts(fromUplink);
      if (served.length === 0) {
        // Nothing to prove against. Loud, and NOT a silent pass: on a host
        // whose gateway serves none of the candidate ports there is no
        // residual to demonstrate, and inventing one would be theatre.
        console.warn(
          `[inconclusive] gateway residual: the Docker host serves none of ` +
            `${GATEWAY_CANDIDATE_PORTS.join(", ")} on ${parseKv(fromUplink, "gateway")}, so the ` +
            `§12.8 residual could not be demonstrated here. It is NOT thereby closed — any port ` +
            `the host binds later is reachable from the bridge with no code change.`,
        );
        return;
      }

      const fromInternal = await onNetwork(net, gatewayScan(served));
      const reachable = openPorts(fromInternal);

      // The gateways are DIFFERENT addresses on the same machine — the uplink
      // bridge and the internal bridge each have their own — which is what
      // makes this a statement about the host rather than about one IP.
      expect(parseKv(fromInternal, "gateway")).not.toBe(parseKv(fromUplink, "gateway"));
      expect(reachable).toEqual(served);
    },
    180_000,
  );
});

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
        // POSITIVE, not `not.toContain("pre=0")`. The negative form passes on
        // any string that fails to contain the token — including an error
        // message from a probe that never ran. This asserts curl actually
        // reported a NON-ZERO failure code, which is the measurement.
        expect(before).toMatch(/^pre=[1-9][0-9]*$/m);

        const relay = await ensureEgressRelay(cfg(`http://host.docker.internal:${port}/v1`), net);
        expect(relay.created).toBe(true);
        expect(relay.name).toBe(relayContainerName(net));
        // The relay records WHAT it would run and WHERE it would forward, on
        // every run, created or adopted — the only cross-run trace of a target
        // or script change, since adoption never compares them (S5/S8).
        expect(relay.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(relay.targets).toEqual([
          { listenPort: port, host: "host.docker.internal", port, name: "omlx" } as RelayTarget,
        ]);

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
        // POSITIVE assertions for the DENY half, for the reason in
        // `onInternalNetwork`'s comment. `toContain(nonce)` already rescued the
        // REACH half from vacuity; nothing rescued these two, and they are
        // precisely ISC-51/57's evidence. Asserting a non-zero curl code is
        // strictly stronger than asserting the absence of `=0`, and still not
        // hostage to curl's exact error taxonomy (7 vs 6 vs 28).
        expect(after).toMatch(/^ip=[1-9][0-9]*$/m);
        expect(after).toMatch(/^name=[1-9][0-9]*$/m);

        // Idempotence, the property `up` depends on: a second ensure adopts
        // the running relay rather than rebuilding a shared resource other
        // fleets may be using right now.
        const again = await ensureEgressRelay(cfg(`http://host.docker.internal:${port}/v1`), net);
        expect(again).toEqual({
          name: relay.name,
          created: false,
          scriptSha256: relay.scriptSha256,
          targets: relay.targets,
        });
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
        const first = await ensureEgressRelay(cfg(base), net);
        expect(first.created).toBe(true);
        const stopped = await docker(["stop", "-t", "1", first.name]);
        expect(stopped.code).toBe(0);

        const second = await ensureEgressRelay(cfg(base), net);
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
        ensureEgressRelay(cfg("http://10.0.0.5:8000/v1"), net),
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
        cfg("http://host.docker.internal:8000/v1"),
        net,
      );
      expect(relay.created).toBe(true);

      /**
       * The key is passed by NAME through docker's env plumbing and expanded
       * INSIDE the container — never interpolated into the argv.
       *
       * The previous form built `-H "Authorization: Bearer <the real key>"`
       * into a shell string handed to `docker run`, which put the live key in
       * `ps` output, in the ephemeral container's `docker inspect`, and in any
       * CI log that echoes commands. No leak had happened yet only because
       * this test has never run anywhere but the maintainer's machine — it
       * becomes a live exposure the moment ISC-257 wires this file into CI with
       * a real secret. `$OMLX_API_KEY` below is expanded by the container's own
       * bash, not by this process.
       */
      const out = await onInternalNetwork(
        net,
        curlProbe(
          "models",
          "http://host.docker.internal:8000/v1/models",
          "Authorization: Bearer $OMLX_API_KEY",
        ),
        { OMLX_API_KEY: OMLX_KEY },
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
