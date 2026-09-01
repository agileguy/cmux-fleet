/**
 * ISC-411 — a worker CANNOT resolve a provider it is not assigned to (D7, §6.5).
 *
 * ## Why this cannot be a unit test
 *
 * The claim is about NETWORK NAMESPACES. `egressBridgePlan` returning two
 * different network names proves the fleet ASKS for two bridges; it says
 * nothing about whether Docker's embedded DNS actually scopes an alias to the
 * network that published it. Every derivation in
 * `test/unit/relay-provider-bridges.test.ts` can be perfect while the daemon
 * resolves `api.vendor-b.test` from vendor A's bridge, and the whole point of
 * D7 would be gone with 21 unit probes still green. So this file runs against a
 * real daemon and reads the answer out of a real container's resolver.
 *
 * ## The vacuity this file is built to avoid
 *
 * ISC-411 is an ANTI-criterion, which makes it the easiest claim in the project
 * to "prove" by accident. `getent hosts api.vendor-b.test` fails with NXDOMAIN
 * if the stub never started, if the alias was never published anywhere, if the
 * name was misspelled in this file, or if the probe container did not run at
 * all. Every one of those is a green anti-test measuring nothing.
 *
 * Three things answer that, and they are the reason this file is longer than
 * the assertion it makes:
 *
 *  1. **THE CONTROL IS THE SAME STRING FROM THE OTHER VANTAGE.** Not "A's alias
 *     resolves from A" — the identical alias that must NOT resolve from A is
 *     asserted to resolve from B, in the same run. A misspelling, a stub that
 *     failed to start, or an alias nothing published turns the CONTROL red.
 *     Absence and presence therefore fail in opposite directions, which is the
 *     only arrangement where a passing anti-test carries information.
 *  2. **THE ALIASES ARE TAKEN FROM THE PLAN, NEVER TYPED.** They come out of
 *     `relayListenAliases` via `egressBridgePlan`, so this file cannot probe a
 *     name the production derivation does not publish. It also cannot drift:
 *     change the derivation and these probes follow it.
 *  3. **A BROKEN PROBE IS NOT A MEASUREMENT.** `resolveFrom` refuses any
 *     container that exits non-zero rather than folding the error text into the
 *     answer — the failure `relay.test.ts`'s `onNetwork` documents, where
 *     "this error message does not contain an IP" is true of every error
 *     message ever written.
 *
 * ## Gating
 *
 * `PIFLEET_DOCKER=1` and the worker image, exactly like the relay and egress
 * suites next to it. The probe deliberately uses the WORKER image and an
 * ordinary `docker run` with no `--add-host`, no capabilities and no extra
 * networks, because the criterion is about what a plain worker can reach.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realExec } from "../../src/container/run.ts";
import { ensureEgressNetwork, inspectEgressNetwork } from "../../src/security/network.ts";
import { removeGatewayBlock } from "../../src/security/gateway-block.ts";
import { egressBridgePlan, RELAY_IMAGE, type FleetRelayConfigView } from "../../src/security/relay.ts";
import { containerBudget } from "../support/budget.ts";

const IMAGE = process.env.PIFLEET_TEST_IMAGE ?? "pifleet/pi-worker:verify";
const DOCKER = process.env.PIFLEET_DOCKER === "1";

if (!DOCKER) {
  console.warn(
    `[skip] ISC-411 containment tests need a Docker daemon and ${IMAGE}. ` +
      `Run with PIFLEET_DOCKER=1 after 'pifleet image build'.`,
  );
}

/** Unique per process, so a parallel run never collides on a network name. */
const NET = `pifleet-isc411-${process.pid.toString(36)}`;

/**
 * Two providers that agree about nothing except that they are both declared.
 *
 * Distinct hostnames are what make this file possible at all: the three
 * built-in aliases (`omlx.pifleet.internal`, `host.docker.internal`,
 * `egress.pifleet.internal`) are published by EVERY relay, so probing one of
 * those could never distinguish "scoped to this bridge" from "on every bridge".
 * The `base_url` host is the only alias that belongs to one provider, which is
 * why it is the one under test.
 */
function twoProviders(): FleetRelayConfigView {
  return {
    llm: {
      base_url: "http://omlx.legacy.test:7000/v1",
      relay_upstream: null,
      providers: {
        "vendor-a": {
          base_url: "https://api.vendor-a.test/v1",
          relay_upstream: "198.51.100.10:443",
        },
        "vendor-b": {
          base_url: "https://api.vendor-b.test/v1",
          relay_upstream: "198.51.100.20:443",
        },
      },
    },
    egress: {
      google_hosts: [],
      allow: [
        { host: "198.51.100.10", port: 443 },
        { host: "198.51.100.20", port: 443 },
      ],
    },
  };
}

/**
 * THE PLAN — the same call `up` makes, so the names below are production's.
 *
 * Both providers are listed as resolved, which is what makes them bridges at
 * all: a declared provider nothing selects creates nothing (ISC-410).
 */
const PLAN = egressBridgePlan(twoProviders(), NET, ["vendor-a", "vendor-b"]);

/** One provider's bridge, with the alias that belongs to it and no other. */
interface Side {
  readonly provider: string;
  readonly network: string;
  readonly alias: string;
  readonly stub: string;
  /** THIS provider's listen port, from the plan's target — 443 for both. */
  readonly listenPort: number;
}

function sideFor(provider: string, host: string): Side {
  const bridge = PLAN.find((b) => b.provider === provider);
  if (bridge === undefined) throw new Error(`no bridge planned for ${provider}`);
  // Taken from the PLAN's alias set rather than typed, and asserted to be the
  // provider's own host: if `relayListenAliases` stopped publishing the
  // endpoint, this throws at load rather than quietly probing nothing.
  const alias = bridge.aliases.find((a) => a === host);
  if (alias === undefined) {
    throw new Error(`${provider}'s plan does not publish ${host}: ${bridge.aliases.join(", ")}`);
  }
  const target = bridge.targets[0];
  if (target === undefined) throw new Error(`${provider}'s bridge carries no target`);
  return {
    provider,
    network: bridge.network,
    alias,
    stub: `${bridge.network}-stub`,
    listenPort: target.listenPort,
  };
}

const A = sideFor("vendor-a", "api.vendor-a.test");
const B = sideFor("vendor-b", "api.vendor-b.test");

async function docker(args: string[], timeoutMs = 120_000) {
  return realExec(["docker", ...args], { timeoutMs });
}

/**
 * Stand in for the relay: a container on ONE bridge publishing THAT bridge's
 * alias set.
 *
 * The real relay is not run here, and that is deliberate rather than a
 * shortcut. ISC-411 is a claim about which names a worker's resolver can see,
 * and a name becomes visible because a container endpoint on that network
 * carries it as an alias — `relayConnectArgv` attaching `bridge.aliases` is
 * exactly this operation. Running the full relay would add a script mount, an
 * uplink network and an upstream dial to a test whose subject is DNS scoping,
 * and every one of those is a way for this file to fail for a reason that is
 * not the criterion.
 */
async function startStub(side: Side): Promise<void> {
  const aliasArgs = PLAN.flatMap((b) =>
    b.network === side.network ? b.aliases.flatMap((a) => ["--network-alias", a]) : [],
  );
  /**
   * It BINDS the provider's listen port, which is what carries ISC-413.
   *
   * `--user node --cap-drop ALL` plus the unprivileged-port sysctl is exactly
   * how `relayRunArgv` launches the real thing: an unprivileged process with no
   * capabilities binding 443, which only works because the sysctl lowers the
   * floor in THAT netns. Running the stub as root would bind 443 for a reason
   * production does not have, and the test would stop describing the relay.
   */
  const script =
    'require("node:http")' +
    ".createServer((_q, s) => { s.writeHead(204); s.end(); })" +
    `.listen(${side.listenPort}, "0.0.0.0", () => console.log("listening ${side.listenPort}"));`;
  const started = await docker([
    "run", "-d", "--name", side.stub,
    "--network", side.network,
    ...aliasArgs,
    "--user", "node",
    "--cap-drop", "ALL",
    "--sysctl", "net.ipv4.ip_unprivileged_port_start=0",
    RELAY_IMAGE, "node", "-e", script,
  ]);
  if (started.code !== 0) {
    throw new Error(`could not start ${side.provider}'s stub: ${started.stderr}`);
  }
  /**
   * `docker run -d` exiting 0 means the container STARTED, not that its
   * `listen(2)` succeeded — the distinction `ensureEgressRelay` re-inspects
   * for, and the whole subject of ISC-413. A relay that dies on EACCES
   * milliseconds later looks identical here without this wait.
   */
  for (let i = 0; i < 150; i++) {
    const logs = await docker(["logs", side.stub], 15_000);
    if (logs.stdout.includes(`listening ${side.listenPort}`)) return;
    const alive = await docker(["inspect", side.stub, "--format", "{{.State.Running}}"], 15_000);
    if (alive.stdout.trim() !== "true") {
      throw new Error(
        `${side.provider}'s relay stub exited before it bound ${side.listenPort}: ` +
          `${logs.stdout}${logs.stderr}`,
      );
    }
    await Bun.sleep(100);
  }
  throw new Error(`${side.provider}'s relay stub never bound ${side.listenPort}`);
}

/**
 * Resolve `alias` from an ordinary worker on `network`.
 *
 * Returns the resolved address, or `null` for NXDOMAIN — and THROWS if the
 * probe container itself failed, because a broken probe is not a measurement.
 * The script always exits 0, so a non-zero code here can only mean the
 * container did not run.
 */
async function resolveFrom(network: string, alias: string): Promise<string | null> {
  const script =
    `if out=$(getent hosts ${JSON.stringify(alias)} 2>/dev/null); then ` +
    `echo "RESOLVED ${"${out}"}"; else echo "NXDOMAIN"; fi`;
  const r = await docker([
    "run", "--rm", "--network", network, "--entrypoint", "bash", IMAGE, "-c", script,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `the probe container did not run on ${network} (exit ${r.code}): ${r.stderr || r.stdout}`,
    );
  }
  const out = r.stdout.trim();
  if (out.startsWith("RESOLVED ")) return out.slice("RESOLVED ".length).trim();
  if (out === "NXDOMAIN") return null;
  throw new Error(`unreadable probe output from ${network}: ${JSON.stringify(out)}`);
}

/**
 * Open a TCP connection to `alias:port` from an ordinary worker on `network`.
 *
 * Resolution alone cannot carry ISC-413: a name can answer while nothing is
 * bound behind it, which is precisely the EACCES failure the sysctl exists to
 * prevent. This completes the handshake, so "the relay is listening on 443" is
 * measured from a worker rather than inferred from a log line.
 *
 * THROWS if the probe container did not run, for the same reason `resolveFrom`
 * does — `bash` exits 0 either way, so a non-zero code is never a denial.
 */
async function connectFrom(network: string, alias: string, port: number): Promise<boolean> {
  const script =
    `if timeout 10 bash -c 'exec 3<>/dev/tcp/${alias}/${port}' 2>/dev/null; ` +
    `then echo OPEN; else echo CLOSED; fi`;
  const r = await docker([
    "run", "--rm", "--network", network, "--entrypoint", "bash", IMAGE, "-c", script,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `the connect probe did not run on ${network} (exit ${r.code}): ${r.stderr || r.stdout}`,
    );
  }
  const out = r.stdout.trim();
  if (out === "OPEN") return true;
  if (out === "CLOSED") return false;
  throw new Error(`unreadable connect output from ${network}: ${JSON.stringify(out)}`);
}

async function cleanup(): Promise<void> {
  for (const side of [A, B]) {
    await docker(["rm", "-f", side.stub], 60_000).catch(() => {});
  }
  for (const side of [A, B]) {
    // Drop the ISC-51 gateway rule with the network, or the host accumulates
    // one dead rule per run — the same care `relay.test.ts` takes.
    const before = await inspectEgressNetwork(side.network).catch(() => null);
    if (before?.exists && before.id !== null && before.gateway !== null) {
      await removeGatewayBlock(before.id, before.gateway).catch(() => {});
    }
    await docker(["network", "rm", side.network], 60_000).catch(() => {});
  }
}

beforeAll(async () => {
  if (!DOCKER) return;
  await cleanup();
  for (const side of [A, B]) {
    await ensureEgressNetwork(side.network);
    await startStub(side);
  }
}, containerBudget(6));

afterAll(async () => {
  if (!DOCKER) return;
  await cleanup();
}, containerBudget(6));

describe("ISC-411: a worker cannot resolve a provider it is not assigned to", () => {
  /**
   * The fixture's own premise, checked before anything rests on it.
   *
   * Two providers must be two DIFFERENT networks carrying two DIFFERENT
   * aliases. If D7's composition regressed to a single fleet-wide bridge, both
   * sides would name the same network and every probe below would be asking one
   * bridge about itself — and the anti-tests would still pass, because the
   * alias would be there either way.
   */
  test("the plan really did produce two bridges with two distinct aliases", () => {
    expect(PLAN).toHaveLength(2);
    expect(A.network).not.toBe(B.network);
    expect(A.alias).not.toBe(B.alias);
    // And neither bridge is the BASE network, which is the silent-failure value.
    expect([A.network, B.network]).not.toContain(NET);
  });

  /**
   * THE CONTROL, and it runs first on purpose.
   *
   * Each provider's alias resolves from its OWN bridge. Without this the anti
   * tests below prove only that two names do not resolve anywhere, which is
   * equally true of a fleet where nothing started at all.
   */
  test.skipIf(!DOCKER)("each provider's alias DOES resolve on its own bridge", async () => {
    const a = await resolveFrom(A.network, A.alias);
    const b = await resolveFrom(B.network, B.alias);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // An address, not merely a non-null string — a resolver that answered with
    // anything else is not a resolver that answered.
    expect(a).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(b).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // Two bridges are two subnets, so the two stubs cannot share an address.
    expect(a).not.toBe(b);
  }, containerBudget(2));

  /**
   * THE CRITERION. The SAME alias the control just resolved on B is NXDOMAIN
   * from A, and vice versa.
   *
   * Asserted in both directions because containment that holds one way and not
   * the other is not containment; and because a single direction could be
   * satisfied by B's stub simply having failed to start, which the control
   * already rules out but which the symmetry rules out again.
   */
  test.skipIf(!DOCKER)("provider B's alias is NXDOMAIN from provider A's bridge", async () => {
    expect(await resolveFrom(A.network, B.alias)).toBeNull();
  }, containerBudget(2));

  test.skipIf(!DOCKER)("provider A's alias is NXDOMAIN from provider B's bridge", async () => {
    expect(await resolveFrom(B.network, A.alias)).toBeNull();
  }, containerBudget(2));

  /**
   * The pairing stated as one measurement, so the property is visible as a
   * property rather than as two tests a reader has to hold together.
   *
   * This is the assertion that inverts if per-worker containment regresses: on
   * a shared bridge BOTH lookups answer, and `[address, null]` becomes
   * `[address, address]`.
   */
  test.skipIf(!DOCKER)("the same alias answers from its own bridge and not from the other", async () => {
    const fromOwn = await resolveFrom(B.network, B.alias);
    const fromOther = await resolveFrom(A.network, B.alias);
    expect(fromOwn).not.toBeNull();
    expect(fromOther).toBeNull();
    // Spelled out: presence and absence of ONE string, decided only by which
    // network namespace asked.
    expect([fromOwn === null, fromOther === null]).toEqual([false, true]);
  }, containerBudget(2));
});

/**
 * ISC-413 — two providers on THE SAME PORT both listen, in separate namespaces.
 *
 * Kept as its own `describe` over the SAME fixture rather than folded into the
 * assertions above, so a failure says which criterion broke: ISC-411 is about
 * which names a worker can resolve, ISC-413 is about two `listen(2)` calls on
 * one port not colliding. They share a fixture because the fixture that proves
 * containment is already two providers on two bridges — making both of them
 * `https://` with no explicit port costs nothing and makes the port the only
 * thing they have in common.
 *
 * §6.4 recorded a listen-port collision as a live problem and D7 dissolved it:
 * two providers on `:443` are two containers in two network namespaces, each
 * binding `:443` in its own. There is nothing to demultiplex. The unit block in
 * `relay-provider-bridges.test.ts` can prove the fleet ASKS for that; only a
 * daemon can prove the second bind does not fail.
 */
describe("ISC-413: two providers on the same port both listen, in separate namespaces", () => {
  /**
   * The premise, derived from the plan rather than asserted about the fixture:
   * both providers really are on one port. If either `base_url` drifted off
   * 443 this whole block would still pass while testing nothing.
   */
  test("both providers' relays are planned for the very same port", () => {
    expect(A.listenPort).toBe(443);
    expect(B.listenPort).toBe(443);
    expect(A.listenPort).toBe(B.listenPort);
    // …in two different namespaces, which is the only reason that is legal.
    expect(A.network).not.toBe(B.network);
  });

  /**
   * Both containers are RUNNING after the wait for their bind.
   *
   * `startStub` refuses to return until each logged `listening 443`, so a
   * second bind that failed with EADDRINUSE — or with EACCES, the
   * unprivileged-port failure — could never reach this assertion. This states
   * the outcome that the wait already guaranteed, so the criterion is visible
   * as a test rather than only as a fixture precondition.
   */
  test.skipIf(!DOCKER)("both relay containers are up after binding the same port", async () => {
    for (const side of [A, B]) {
      const alive = await docker(["inspect", side.stub, "--format", "{{.State.Running}}"], 30_000);
      expect(alive.stdout.trim()).toBe("true");
      const logs = await docker(["logs", side.stub], 30_000);
      expect(logs.stdout).toContain(`listening ${side.listenPort}`);
    }
  }, containerBudget(4));

  /**
   * THE CRITERION, measured from a worker rather than from the daemon's logs.
   *
   * A completed TCP handshake to `alias:443` on BOTH bridges is the fact §6.4
   * said would need demultiplexing and D7 says does not. A log line proves a
   * process believed it bound the port; this proves a worker can reach it.
   */
  test.skipIf(!DOCKER)("a worker on each bridge completes a TCP connect to 443", async () => {
    expect(await connectFrom(A.network, A.alias, A.listenPort)).toBe(true);
    expect(await connectFrom(B.network, B.alias, B.listenPort)).toBe(true);
  }, containerBudget(2));

  /**
   * The two criteria meeting: the port is open on its OWN bridge and the other
   * provider's name is not reachable at that same port from here.
   *
   * This is the assertion that would inflect if D7 regressed to one shared
   * bridge — where both names would answer on 443 and both connects would
   * succeed, which is exactly §6.4's collision reappearing as a security
   * problem rather than as a bind error.
   */
  test.skipIf(!DOCKER)("the other provider's endpoint is NOT reachable on 443 from here", async () => {
    expect(await connectFrom(A.network, A.alias, A.listenPort)).toBe(true);
    expect(await connectFrom(A.network, B.alias, B.listenPort)).toBe(false);
  }, containerBudget(2));
});
