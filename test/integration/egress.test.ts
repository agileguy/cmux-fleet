/**
 * The deny-all egress network, probed against a real daemon (SRD §5.6, §5.9;
 * ISC-57).
 *
 * The unit suite proves the MATCHER; only this suite proves the NETWORK — that
 * a worker container on the configured bridge genuinely cannot reach the
 * internet, and that the one sanctioned path (a relay container sitting ON the
 * bridge, §5.6) works. A mocked version of these tests would assert on our own
 * argv, which is precisely the trust `ensureEgressNetwork` refuses to extend.
 *
 * Gated exactly like test/integration/verbgate.test.ts: they run only with a
 * Docker daemon and a built worker image, and skip cleanly otherwise.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ensureEgressNetwork,
  inspectEgressNetwork,
} from "../../src/security/network.ts";

const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] egress integration tests need a Docker daemon and ${IMAGE}. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

/** Unique per test so a crashed run never collides with the real bridge. */
let seq = 0;
function testNetName(): string {
  seq += 1;
  return `pifleet-egress-it-${process.pid}-${seq}`;
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

/** Networks/containers THIS suite created; removed even when a test fails. */
const cleanupNetworks: string[] = [];
const cleanupContainers: string[] = [];
afterEach(async () => {
  for (const c of cleanupContainers.splice(0)) await docker(["rm", "-f", c]);
  for (const n of cleanupNetworks.splice(0)) await docker(["network", "rm", n]);
});

/**
 * The per-test ceiling for this file, DERIVED and written down (ISC-274).
 *
 * Stands at 120_000 and deliberately NOT reduced. These tests perform one to
 * three container operations each, so `containerBudget(3)` derives 60_000 — its
 * cold floor, the per-op term not overtaking until thirty operations. That is
 * the derived number, and it is HALF this one.
 *
 * It is not adopted, for the reason `containerBudget` records against its own
 * floor: the dominant term is a cold daemon, and it was not measured. Warm, with
 * `PIFLEET_DOCKER=1` on a 14-core box at load 3.55, these five tests take 14,
 * 155, 161, 297 and 414 ms — the whole file finishes inside half a second of
 * container time, which tells us nothing about the cold path the ceiling exists
 * for. Two of the five also reach for the public internet ON PURPOSE (proving a
 * container CANNOT), so their tail is a DNS-and-connect timeout on someone
 * else's network rather than anything this repo controls, and that is exactly
 * the case a floor-width ceiling is there to absorb.
 *
 * Halving a ceiling on a warm measurement that exercises neither term is the
 * ISC-267 mistake. budget.ts says its floor moves only on a CI measurement.
 */
const EGRESS_TEST_TIMEOUT_MS = 120_000;

/** Run a bash script in the worker image on `net` and return combined output. */
async function onNetwork(net: string, script: string): Promise<string> {
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

describe.skipIf(!DOCKER)("egress network", () => {
  test(
    "ensure creates the network, the daemon reports it internal, and ensure is idempotent",
    async () => {
      const name = testNetName();
      cleanupNetworks.push(name);
      const created = await ensureEgressNetwork(name);
      expect(created.exists).toBe(true);
      expect(created.internal).toBe(true);
      // The probe `up`/`doctor` act on must agree with what ensure returned.
      const probed = await inspectEgressNetwork(name);
      expect(probed).toEqual(created);
      // Second ensure adopts the existing internal network, creates nothing new.
      const again = await ensureEgressNetwork(name);
      expect(again.id).toBe(created.id);
    },
    EGRESS_TEST_TIMEOUT_MS,
  );

  test(
    "a missing network reports exists: false — not an error, not internal",
    async () => {
      const s = await inspectEgressNetwork(`pifleet-egress-it-absent-${process.pid}`);
      expect(s).toEqual({
        name: `pifleet-egress-it-absent-${process.pid}`,
        exists: false,
        internal: false,
        id: null,
      });
    },
    EGRESS_TEST_TIMEOUT_MS,
  );

  test(
    "ensure REFUSES a pre-existing non-internal network wearing the configured name",
    async () => {
      // The quiet-downgrade failure: this network grants full egress, and
      // adopting it would report deny-all while providing nothing.
      const name = testNetName();
      cleanupNetworks.push(name);
      const made = await docker(["network", "create", name]); // deliberately NOT --internal
      expect(made.code).toBe(0);
      await expect(ensureEgressNetwork(name)).rejects.toThrow(/NOT internal/);
      // And it must not have "fixed" it behind the operator's back.
      const after = await inspectEgressNetwork(name);
      expect(after.exists).toBe(true);
      expect(after.internal).toBe(false);
    },
    EGRESS_TEST_TIMEOUT_MS,
  );

  test(
    "a container on the egress network CANNOT reach the internet",
    async () => {
      const name = testNetName();
      cleanupNetworks.push(name);
      await ensureEgressNetwork(name);
      // Two denied destinations: a public IP literal (no DNS involved — proves
      // the ROUTE is absent, not merely the resolver) and a public name (the
      // path a worker would actually attempt). Any zero exit here means the
      // deny-all default is fiction.
      const out = await onNetwork(
        name,
        `curl -sS -m 5 https://1.1.1.1/ >/dev/null 2>&1; echo "ip=$?"
         curl -sS -m 5 https://example.com/ >/dev/null 2>&1; echo "name=$?"`,
      );
      expect(out).not.toContain("ip=0");
      expect(out).not.toContain("name=0");
    },
    EGRESS_TEST_TIMEOUT_MS,
  );

  test(
    "a container on the egress network CAN reach a relay sitting on the bridge",
    async () => {
      // The sanctioned shape of "allowed egress" (§5.6): permitted traffic
      // leaves through a relay container ON the internal bridge, which consults
      // decide() per destination. Container-to-container reachability on the
      // same bridge is therefore the allowed path, and it must work — a bridge
      // that denies everything INCLUDING its own relay is an outage, not a
      // policy. The worker image is node-based (§5.2), so the relay stub is a
      // one-line http server; it self-terminates so a crashed test cannot leak
      // a running container past the timeout.
      const name = testNetName();
      const relay = `${name}-relay`;
      cleanupNetworks.push(name);
      cleanupContainers.push(relay);
      await ensureEgressNetwork(name);
      const started = await docker([
        "run",
        "-d",
        "--rm",
        "--network",
        name,
        "--name",
        relay,
        "--entrypoint",
        "node",
        IMAGE,
        "-e",
        'require("http").createServer((q,s)=>s.end("relay-ok")).listen(8000,"0.0.0.0");setTimeout(()=>process.exit(0),110000)',
      ]);
      expect(started.code).toBe(0);
      // Docker's embedded DNS resolves container names on user-defined
      // networks, internal ones included; poll briefly for server start.
      const out = await onNetwork(
        name,
        `for i in $(seq 1 20); do
           body=$(curl -sS -m 5 http://${relay}:8000/ 2>/dev/null) && break
           sleep 0.5
         done
         echo "body=$body"`,
      );
      expect(out).toContain("body=relay-ok");
    },
    EGRESS_TEST_TIMEOUT_MS,
  );
});
