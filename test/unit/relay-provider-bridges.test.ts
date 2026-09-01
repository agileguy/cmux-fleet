/**
 * D7's per-provider bridges (SRD §6.5, decision D7): ISC-409, ISC-410, ISC-413.
 *
 * ## Why every fixture here is ASYMMETRIC, and why that is not fussiness
 *
 * The claim under test is that a network name, a relay name, an alias set and a
 * dial target are all functions of ONE PROVIDER. A fixture whose two providers
 * share a host, a port and a name shape cannot tell that claim apart from a
 * fleet-wide derivation that happens to return the same string twice — both
 * produce two identical values, and every assertion passes against either.
 *
 * So the providers below differ in every field that feeds a derivation: three
 * hostnames, three ports (8000, 443, 9443), three upstream addresses, three
 * keys of different lengths. The one deliberate SAMENESS is ISC-413's pair,
 * which shares a port precisely because the port collision is the thing being
 * probed — and even there the hosts and upstreams differ.
 *
 * ## What is proved here and what is not
 *
 * These are the pure derivations and the plan `up` loops over. That a relay
 * container then really binds its port in its own namespace is an integration
 * fact and belongs to the Docker-backed suite; what belongs HERE is that the
 * fleet asks for two containers on two networks rather than one container with
 * two listeners, which is the decision §6.3 records as rejected.
 */
import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { parseConfig, resolveWorker } from "../../src/config/load.ts";
import { renderWorker } from "../../src/config/render.ts";
import { buildWorkerEnv } from "../../src/run/worker-env.ts";
import { resolvedProviders } from "../../src/cli/commands/up.ts";
import {
  assertProviderKey,
  egressBridgePlan,
  providerKeyBudget,
  providerNetworkName,
  relayContainerName,
  relayListenAliases,
  relayViewForProvider,
  uplinkNetworkName,
  RELAY_NAME_PREFIX,
  type FleetRelayConfigView,
} from "../../src/security/relay.ts";
import { assertDockerName } from "../../src/security/docker-names.ts";
import { EXIT } from "../../src/contracts.ts";

const NET = "pifleet-egress";

/**
 * Three providers that agree about nothing.
 *
 * `spare-vendor` is the DECLARED-BUT-UNUSED one throughout this file. It is
 * declared exactly like the other two — same shape, same completeness — so that
 * its absence downstream can only be explained by nothing selecting it, and
 * never by it being malformed.
 */
function threeProviders(): FleetRelayConfigView {
  return {
    llm: {
      // The flat keys remain, and they are DELIBERATELY unlike every block
      // below: if any derivation silently fell back to them, `omlx.legacy.test`
      // would appear in an alias set and the assertions would say so.
      base_url: "http://omlx.legacy.test:7000/v1",
      relay_upstream: null,
      providers: {
        /*
         * NOT `omlx.pifleet.internal`, and the first draft of this fixture used
         * it and was wrong.
         *
         * `RELAY_LISTEN_ALIAS` is a compile-time CONSTANT that EVERY relay
         * publishes, so a fixture naming it as the local provider's endpoint
         * cannot distinguish "this alias is here because this provider was
         * projected" from "this alias is here because every relay has it". The
         * assertion that the ollama relay does not publish omlx's endpoint
         * failed against correct code for exactly that reason. A distinctive
         * host restores the asymmetry the whole file depends on.
         */
        omlx: {
          base_url: "http://omlx.house.test:8000/v1",
          relay_upstream: "192.168.86.49:8000",
        },
        "ollama-cloud": {
          base_url: "https://ollama.com/v1",
          relay_upstream: "104.18.0.1:443",
        },
        "spare-vendor": {
          base_url: "https://api.spare-vendor.test:9443/v1",
          relay_upstream: "203.0.113.7:9443",
        },
      },
    },
    egress: {
      google_hosts: ["oauth2.googleapis.com"],
      allow: [
        { host: "104.18.0.1", port: 443 },
        { host: "203.0.113.7", port: 9443 },
      ],
    },
  };
}

/**
 * ISC-413 — two providers whose `base_url` names THE SAME PORT.
 *
 * Both on 443 and nothing else in common: different hostnames, different
 * upstream addresses. That is what makes the port the only shared thing, so a
 * test that passes can only be passing because of the namespace separation.
 */
function twoOn443(): FleetRelayConfigView {
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
      google_hosts: ["oauth2.googleapis.com"],
      allow: [
        { host: "198.51.100.10", port: 443 },
        { host: "198.51.100.20", port: 443 },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// ISC-413 — the criterion that proves D7 bought something
// ---------------------------------------------------------------------------

describe("ISC-413: two providers on the same port stand up, in separate namespaces", () => {
  /**
   * THE PRECONDITION, asserted first and on purpose.
   *
   * Every other assertion in this block is worthless if the two providers do
   * not actually collide — a fixture where one quietly resolved to 8000 would
   * make "both stand up" true for a reason that has nothing to do with D7. So
   * the collision is established as a fact about the fixture before separation
   * is claimed as a fact about the design.
   */
  test("the collision is real: both providers listen on 443", () => {
    const plan = egressBridgePlan(twoOn443(), NET, ["vendor-a", "vendor-b"]);
    expect(plan).toHaveLength(2);
    expect(plan.map((b) => b.targets[0]!.listenPort)).toEqual([443, 443]);
  });

  /**
   * §6.4's failure, dissolved. Under the shared-relay design that section
   * describes, ONE container would take both of these targets and its second
   * `listen(2)` on 443 would fail — the good failure, but a failure. Here the
   * plan stands up and the two listeners are in two network namespaces.
   */
  test("they stand up cleanly: two networks, two uplinks, two relay containers", () => {
    const cfg = twoOn443();
    const plan = egressBridgePlan(cfg, NET, ["vendor-a", "vendor-b"]);

    // The separation, asserted as DISTINCTNESS rather than as two literals: a
    // derivation that ignored its provider argument would return one string
    // twice and every set below would collapse to size 1.
    expect(new Set(plan.map((b) => b.network)).size).toBe(2);
    expect(new Set(plan.map((b) => b.uplink)).size).toBe(2);
    expect(new Set(plan.map((b) => b.relay)).size).toBe(2);

    // …and each of those two relays carries ONE listener on 443, rather than
    // one relay carrying two. This is the assertion §6.3's design fails.
    for (const bridge of plan) {
      expect(bridge.targets).toHaveLength(1);
      expect(bridge.targets[0]!.listenPort).toBe(443);
    }
  });

  test("the upstreams stay distinct, so the two relays are not the same relay twice", () => {
    const plan = egressBridgePlan(twoOn443(), NET, ["vendor-a", "vendor-b"]);
    // Different dial targets on the same listen port is exactly the pair a
    // single spliced listener cannot serve: the relay resolves which upstream
    // to dial from which port the connection arrived on, and here that signal
    // does not distinguish them (§6.4). Two namespaces make the question moot.
    expect(plan.map((b) => b.targets[0]!.host)).toEqual(["198.51.100.10", "198.51.100.20"]);
    expect(plan.map((b) => b.targets[0]!.port)).toEqual([443, 443]);
  });

  test("each relay publishes only ITS OWN vendor hostname as a listen alias", () => {
    const cfg = twoOn443();
    const plan = egressBridgePlan(cfg, NET, ["vendor-a", "vendor-b"]);
    const [a, b] = plan;

    expect(a!.aliases).toContain("api.vendor-a.test");
    expect(a!.aliases).not.toContain("api.vendor-b.test");
    expect(b!.aliases).toContain("api.vendor-b.test");
    expect(b!.aliases).not.toContain("api.vendor-a.test");
    // Neither publishes the flat block's host: nothing fell back to it.
    expect([...a!.aliases, ...b!.aliases]).not.toContain("omlx.legacy.test");
  });
});

// ---------------------------------------------------------------------------
// ISC-410 — declared is not used
// ---------------------------------------------------------------------------

describe("ISC-410: a declared provider no worker resolves to creates nothing", () => {
  /**
   * The names are DERIVED by calling the real functions, never typed as string
   * literals. A literal would test this file's own spelling: if the
   * composition rule changed to `<provider>-<network>` tomorrow, a typed
   * `"pifleet-egress-spare-vendor"` would be absent from the plan for a reason
   * that has nothing to do with containment, and this suite would report a
   * property it had stopped checking.
   */
  function ghostNames(cfg: FleetRelayConfigView) {
    const network = providerNetworkName(NET, "spare-vendor");
    return {
      network,
      uplink: uplinkNetworkName(network),
      relay: relayContainerName(network),
      aliases: relayListenAliases(relayViewForProvider(cfg, "spare-vendor")),
    };
  }

  /**
   * THE ANTI-VACUITY CONTROL, and the most important test in this block.
   *
   * "Assert some strings are absent" passes trivially against a plan that is
   * empty, against derivations that return "", and against a probe that looks
   * in the wrong place. So the SAME derived names, checked by the SAME
   * predicate, must APPEAR when a worker does resolve to that provider. If this
   * test and the next one ever both pass for the wrong reason, they have to
   * pass for opposite wrong reasons.
   */
  test("CONTROL: those exact derived names DO appear once a worker uses it", () => {
    const cfg = threeProviders();
    const ghost = ghostNames(cfg);
    const plan = egressBridgePlan(cfg, NET, ["omlx", "spare-vendor"]);
    const serialized = JSON.stringify(plan);

    // The derivations are non-empty and distinct from the other providers', so
    // "absent" below cannot be satisfied by an empty or duplicated string.
    expect(ghost.network).toBe(`${NET}-spare-vendor`);
    expect(ghost.relay).toContain("spare-vendor");
    expect(ghost.aliases).toContain("api.spare-vendor.test");

    expect(plan.map((b) => b.network)).toContain(ghost.network);
    expect(plan.map((b) => b.uplink)).toContain(ghost.uplink);
    expect(plan.map((b) => b.relay)).toContain(ghost.relay);
    expect(serialized).toContain("api.spare-vendor.test");
  });

  test("declared and unused: no network, no uplink, no relay, no alias", () => {
    const cfg = threeProviders();
    const ghost = ghostNames(cfg);
    // Declared three; two workers, resolving to two of them.
    expect(Object.keys(cfg.llm.providers!)).toHaveLength(3);
    const plan = egressBridgePlan(cfg, NET, ["omlx", "ollama-cloud"]);
    expect(plan).toHaveLength(2);

    expect(plan.map((b) => b.network)).not.toContain(ghost.network);
    expect(plan.map((b) => b.uplink)).not.toContain(ghost.uplink);
    expect(plan.map((b) => b.relay)).not.toContain(ghost.relay);
    for (const bridge of plan) {
      expect(bridge.aliases).not.toContain("api.spare-vendor.test");
    }

    /*
     * The sweep, and it is the assertion that catches what the three above
     * cannot: a derived name reaching Docker through a FIELD NOBODY THOUGHT TO
     * CHECK — a stray target, a view, a future field on `ProviderBridge`. The
     * plan is everything `up` hands the daemon, so a name absent from its
     * serialization is a name with no path to `docker network ls` or
     * `docker ps` at all.
     */
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(ghost.network);
    expect(serialized).not.toContain(ghost.uplink);
    expect(serialized).not.toContain(ghost.relay);
    expect(serialized).not.toContain("api.spare-vendor.test");
    // The provider KEY itself, which is the strongest form of the claim: the
    // string an operator typed in `llm.providers` appears in nothing this run
    // hands the daemon.
    expect(serialized).not.toContain("spare-vendor");
  });

  /**
   * THE BOUNDARY OF THAT SWEEP, asserted rather than left as a silent omission.
   *
   * The unused provider's UPSTREAM ADDRESS is still in the plan, and a first
   * draft of the sweep above asserted it away and failed. It fails correctly:
   * `203.0.113.7:9443` is in `egress.allow`, which §6.5.5 keeps FLEET-WIDE —
   * *"D7 partitions model reachability, not all reachability"* — so it reaches
   * every bridge's view as part of the operator's own authored allowlist, not
   * as anything derived from the unused provider.
   *
   * That distinction is the whole difference between what ISC-410 claims and
   * what it does not. Written down here as a test, because an assertion quietly
   * dropped from the sweep is indistinguishable from one nobody thought of.
   */
  test("BOUND: the fleet-wide allowlist is NOT partitioned, and that is D7's stated limit", () => {
    const cfg = threeProviders();
    const plan = egressBridgePlan(cfg, NET, ["omlx", "ollama-cloud"]);
    for (const bridge of plan) {
      expect(bridge.view.egress.allow).toEqual(cfg.egress.allow);
    }
    // So the address does appear — via `egress.allow`, and via nothing else.
    expect(JSON.stringify(plan)).toContain("203.0.113.7");
  });

  /**
   * The other half of ISC-410, and the half a plan-level test cannot reach:
   * the plan is only inert if it is built from what WORKERS RESOLVED TO. Built
   * from `Object.keys(llm.providers)` every assertion above would fail, but
   * built from a hardcoded list they would all pass while the real `up` still
   * opened the route. So this walks the real config loader.
   */
  test("the plan's input comes from resolved WORKERS, not from declared keys", async () => {
    const loaded = await parseConfig(
      stringify({
        version: 2,
        name: "bridge-fleet",
        docker: { pi_version: "0.79.6", network: NET },
        run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
        llm: {
          model: "gpt-oss",
          provider: "omlx",
          providers: {
            omlx: {
              hosted: false,
              base_url: "http://omlx.pifleet.internal:8000/v1",
              api_key_env: "OMLX_API_KEY",
              relay_upstream: "192.168.86.49:8000",
            },
            "ollama-cloud": {
              hosted: true,
              base_url: "https://ollama.com/v1",
              api_key_env: "OLLAMA_CLOUD_API_KEY",
              relay_upstream: "104.18.0.1:443",
            },
            "spare-vendor": {
              hosted: true,
              base_url: "https://api.spare-vendor.test:9443/v1",
              api_key_env: "SPARE_VENDOR_API_KEY",
              relay_upstream: "203.0.113.7:9443",
            },
          },
        },
        roles: { eng: {} },
        workers: [
          { id: "w-local", role: "eng" },
          { id: "w-cloud", role: "eng", model: "ollama-cloud/gpt-oss" },
        ],
        egress: {
          allow: [
            { host: "104.18.0.1", port: 443 },
            { host: "203.0.113.7", port: 9443 },
          ],
        },
      }),
      "/tmp/fleet.yaml",
    );

    // Three declared…
    expect(Object.keys(loaded.config.llm.providers!)).toHaveLength(3);
    // …two resolved, and `spare-vendor` is not among them.
    const resolved = resolvedProviders(loaded, ["w-local", "w-cloud"]);
    expect(resolved).toEqual(["omlx", "ollama-cloud"]);
    expect(resolved).not.toContain("spare-vendor");

    const plan = egressBridgePlan(loaded.config, NET, resolved);
    expect(plan.map((b) => b.provider)).toEqual(["omlx", "ollama-cloud"]);
    expect(JSON.stringify(plan)).not.toContain("spare-vendor");
  });

  /**
   * ISC-410's ALIAS clause, followed all the way into a worker's environment.
   *
   * The criterion says an unused provider creates "no network, no relay and no
   * alias", and the plan tests above cover the first two and the alias set. But
   * `NO_PROXY` is a SECOND place a listen alias is written down, derived
   * separately in `worker-env.ts`, and §6.5.5 calls that out by name: leaving it
   * fleet-wide would put another provider's hostname into the environment of a
   * worker with no route to it. Harmless for routing, and still a disclosure
   * with no purpose — and exactly the "second derivation of a fact that now
   * varies" shape that produced ISC-264 and ISC-369.
   *
   * A worker with `egress_access` is the only one that gets `NO_PROXY` at all,
   * which is why the role carries it here.
   */
  test("no worker's NO_PROXY names a provider it does not resolve to", async () => {
    const loaded = await parseConfig(
      stringify({
        version: 2,
        name: "noproxy-fleet",
        docker: { pi_version: "0.79.6", network: NET },
        run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
        llm: {
          model: "gpt-oss",
          provider: "omlx",
          providers: {
            omlx: {
              hosted: false,
              base_url: "http://omlx.house.test:8000/v1",
              api_key_env: "OMLX_API_KEY",
              relay_upstream: "192.168.86.49:8000",
            },
            "ollama-cloud": {
              hosted: true,
              base_url: "https://ollama.com/v1",
              api_key_env: "OLLAMA_CLOUD_API_KEY",
              relay_upstream: "104.18.0.1:443",
            },
            "spare-vendor": {
              hosted: true,
              base_url: "https://api.spare-vendor.test:9443/v1",
              api_key_env: "SPARE_VENDOR_API_KEY",
              relay_upstream: "203.0.113.7:9443",
            },
          },
        },
        roles: { reacher: { egress_access: true } },
        workers: [
          { id: "w-local", role: "reacher" },
          { id: "w-cloud", role: "reacher", model: "ollama-cloud/gpt-oss" },
        ],
        egress: { allow: [{ host: "104.18.0.1", port: 443 }] },
      }),
      "/tmp/fleet.yaml",
    );

    const noProxyFor = (id: string) =>
      buildWorkerEnv(loaded, resolveWorker(loaded, id), {}).vars["NO_PROXY"] ?? "";

    const local = noProxyFor("w-local");
    const cloud = noProxyFor("w-cloud");

    // Each worker bypasses the proxy for ITS OWN provider's endpoint…
    expect(local).toContain("omlx.house.test");
    expect(cloud).toContain("ollama.com");
    // …and for no other provider's, used or unused. The cross assertion is the
    // one that distinguishes a per-provider derivation from a fleet-wide list:
    // under the old fleet-wide spelling BOTH of these would name all three.
    expect(local).not.toContain("ollama.com");
    expect(cloud).not.toContain("omlx.house.test");
    // The declared-but-unused provider reaches NEITHER environment.
    expect(local).not.toContain("api.spare-vendor.test");
    expect(cloud).not.toContain("api.spare-vendor.test");
  });
});

// ---------------------------------------------------------------------------
// ISC-409 — two in use, two bridges, one target each
// ---------------------------------------------------------------------------

describe("ISC-409: two providers in use produce two bridges of exactly one target", () => {
  test("two networks and two relays, derived per provider", () => {
    const plan = egressBridgePlan(threeProviders(), NET, ["omlx", "ollama-cloud"]);
    expect(plan).toHaveLength(2);

    // Whole-value equality rather than `toContain`, for the reason this file's
    // sibling gives about argv: a partial assertion stays green while the
    // provider suffix is being dropped from one of the two.
    expect(plan.map((b) => b.network)).toEqual([`${NET}-omlx`, `${NET}-ollama-cloud`]);
    expect(plan.map((b) => b.uplink)).toEqual([
      `${NET}-omlx-uplink`,
      `${NET}-ollama-cloud-uplink`,
    ]);
    expect(plan.map((b) => b.relay)).toEqual([
      `pifleet-egress-relay-${NET}-omlx`,
      `pifleet-egress-relay-${NET}-ollama-cloud`,
    ]);
    // And each derived name really is this provider's — checked against the
    // derivation functions themselves, so the literals above cannot drift away
    // from the rule while both stay self-consistent.
    for (const bridge of plan) {
      expect(bridge.network).toBe(providerNetworkName(NET, bridge.provider));
      expect(bridge.uplink).toBe(uplinkNetworkName(bridge.network));
      expect(bridge.relay).toBe(relayContainerName(bridge.network));
    }
  });

  /**
   * **A RELAY HOLDING TWO TARGETS FAILS.** This is the count ISC-409 names and
   * the sentence §6.5.4 says D7 preserves — *"the single container that
   * re-opens exactly one destination"*. The rejected §6.3 design would put both
   * of these on one relay, and this assertion is what refuses it.
   */
  test("each relay carries exactly ONE target, and the two differ", () => {
    const plan = egressBridgePlan(threeProviders(), NET, ["omlx", "ollama-cloud"]);

    for (const bridge of plan) expect(bridge.targets).toHaveLength(1);

    // Asymmetric on every axis, so "one target each" cannot be satisfied by
    // two copies of one fleet-wide target.
    expect(plan[0]!.targets[0]).toEqual({
      listenPort: 8000,
      host: "192.168.86.49",
      port: 8000,
      name: "omlx",
    });
    expect(plan[1]!.targets[0]).toEqual({
      listenPort: 443,
      host: "104.18.0.1",
      port: 443,
      name: "ollama-cloud",
    });
  });

  test("each relay's alias set names its own endpoint and not the other's", () => {
    const plan = egressBridgePlan(threeProviders(), NET, ["omlx", "ollama-cloud"]);
    expect(plan[0]!.aliases).toContain("omlx.house.test");
    expect(plan[0]!.aliases).not.toContain("ollama.com");
    expect(plan[1]!.aliases).toContain("ollama.com");
    expect(plan[1]!.aliases).not.toContain("omlx.house.test");
  });

  test("duplicate workers on one provider still produce ONE bridge for it", () => {
    // Five workers, two providers. The bridge count is a function of DISTINCT
    // providers, not of fleet size — otherwise `up` would try to create the
    // same network four times and the ledger would claim four bridges.
    const plan = egressBridgePlan(threeProviders(), NET, [
      "omlx",
      "omlx",
      "ollama-cloud",
      "omlx",
      "ollama-cloud",
    ]);
    expect(plan.map((b) => b.provider)).toEqual(["omlx", "ollama-cloud"]);
  });

  test("a flat fleet with no providers map is ONE bridge on docker.network verbatim", () => {
    // The §6.1 shorthand, pinned so the no-regression claim is a test rather
    // than a paragraph: a pre-D7 `fleet.yaml` must get the network and the
    // relay name it already has, or every running relay is stranded.
    const flat: FleetRelayConfigView = {
      llm: { base_url: "http://omlx.pifleet.internal:8000/v1", relay_upstream: null },
      egress: { google_hosts: ["oauth2.googleapis.com"], allow: [] },
    };
    const plan = egressBridgePlan(flat, NET, ["omlx"]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.network).toBe(NET);
    expect(plan[0]!.relay).toBe(`pifleet-egress-relay-${NET}`);
    expect(plan[0]!.uplink).toBe(`${NET}-uplink`);
    expect(plan[0]!.targets).toHaveLength(1);
    // The name stays `"omlx"`, which is not cosmetic: it is serialized into
    // `PIFLEET_RELAY_TARGETS` and compared by `relayTargetsDrifted`, so
    // renaming it would report every existing relay as drifted and cycle it.
    expect(plan[0]!.targets[0]!.name).toBe("omlx");
  });
});

// ---------------------------------------------------------------------------
// The projection the other three rest on
// ---------------------------------------------------------------------------

describe("relayViewForProvider", () => {
  test("projects to THIS provider's endpoint, never to the flat block", () => {
    const cfg = threeProviders();
    expect(relayViewForProvider(cfg, "ollama-cloud").llm).toEqual({
      base_url: "https://ollama.com/v1",
      relay_upstream: "104.18.0.1:443",
    });
    // The flat `base_url` is a decoy in this fixture and must not leak.
    expect(relayViewForProvider(cfg, "ollama-cloud").llm.base_url).not.toContain("legacy");
  });

  test("carries the egress half UNPROJECTED — D7 partitions model reach only", () => {
    const cfg = threeProviders();
    // §6.5.5: `egress.allow` and `egress.google_hosts` stay fleet-wide, so each
    // provider's relay is judged against the same operator-authored allowlist.
    // Splitting them per provider would quietly weaken `relayGatePolicy`.
    expect(relayViewForProvider(cfg, "omlx").egress).toBe(cfg.egress);
    expect(relayViewForProvider(cfg, "ollama-cloud").egress).toBe(cfg.egress);
  });

  test("REFUSES an undeclared provider rather than inheriting the flat block", () => {
    // Inheritance is how a second endpoint silently acquires the first one's
    // URL and its credential — the failure `ProviderSchema` refuses field by
    // field when it declines to copy the oMLX defaults down.
    expect(() => relayViewForProvider(threeProviders(), "not-declared")).toThrow(
      /llm\.providers does not declare/,
    );
  });

  test("a config with no providers map projects to itself (§6.1 shorthand)", () => {
    const flat: FleetRelayConfigView = {
      llm: { base_url: "http://omlx.pifleet.internal:8000/v1", relay_upstream: null },
      egress: { google_hosts: [], allow: [] },
    };
    expect(relayViewForProvider(flat, "omlx")).toBe(flat);
  });
});

// ---------------------------------------------------------------------------
// The bridges are only worth building if workers are ON them
// ---------------------------------------------------------------------------

describe("a worker attaches to ITS provider's bridge, not the fleet's", () => {
  /**
   * THE OTHER HALF OF ISC-409 AND ISC-411, and it was missing while every
   * derivation test above was already green.
   *
   * `egressBridgePlan` decides which networks EXIST; `config/render.ts` decides
   * which one each worker JOINS. Those are separate code paths, and for a while
   * the first shipped without the second: `up` stood up `pifleet-egress-omlx`
   * and `pifleet-egress-ollama-cloud` correctly while every worker still got
   * `--network pifleet-egress`, the base bridge.
   *
   * Docker does not report that. An ABSENT network name is an error, but the
   * BASE network is a clean start onto a bridge whose relay serves a different
   * provider's upstream — so a worker dials its own `base_url`, the alias
   * resolves on a relay that publishes somebody else's, and the credential goes
   * with it. `up` reports success throughout.
   *
   * Both sides now read `workerEgressNetwork`, so there is no second ternary to
   * drift; these tests are what keeps that true.
   */
  const doc = () => ({
    version: 2,
    name: "attach-fleet",
    docker: { pi_version: "0.79.6", network: NET },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: {
      model: "gpt-oss",
      provider: "omlx",
      providers: {
        omlx: {
          hosted: false,
          base_url: "http://omlx.house.test:8000/v1",
          api_key_env: "OMLX_API_KEY",
          relay_upstream: "192.168.86.49:8000",
        },
        "ollama-cloud": {
          hosted: true,
          base_url: "https://ollama.com/v1",
          api_key_env: "OLLAMA_CLOUD_API_KEY",
          relay_upstream: "104.18.0.1:443",
        },
      },
    },
    roles: { plain: {} },
    workers: [
      { id: "w-local", role: "plain" },
      { id: "w-cloud", role: "plain", model: "ollama-cloud/gpt-oss" },
    ],
    egress: { allow: [{ host: "104.18.0.1", port: 443 }] },
  });

  const networkOf = async (loaded: Awaited<ReturnType<typeof parseConfig>>, id: string) => {
    const r = await renderWorker(loaded, id, { runId: "attach-run" });
    const i = r.docker.lastIndexOf("--network");
    expect(i).toBeGreaterThan(-1);
    return r.docker[i + 1]!;
  };

  test("two workers on two providers join two different bridges", async () => {
    const loaded = await parseConfig(stringify(doc()), "/tmp/fleet.yaml");
    const local = await networkOf(loaded, "w-local");
    const cloud = await networkOf(loaded, "w-cloud");

    // Against the DERIVED names, not against strings typed here: a literal
    // would still pass if `providerNetworkName` changed its composition, and
    // then `up` would create names these workers never join.
    expect(local).toBe(providerNetworkName(NET, "omlx"));
    expect(cloud).toBe(providerNetworkName(NET, "ollama-cloud"));
    // The distinguishing assertion. A fleet-wide derivation returns one name
    // twice and passes everything above it.
    expect(local).not.toBe(cloud);
    // And neither is the BASE network, which is the silent-failure value —
    // the one Docker accepts without complaint.
    expect([local, cloud]).not.toContain(NET);
  });

  test("every bridge a worker joins is one the plan actually builds", async () => {
    const loaded = await parseConfig(stringify(doc()), "/tmp/fleet.yaml");
    const plan = egressBridgePlan(
      loaded.config as unknown as FleetRelayConfigView,
      NET,
      resolvedProviders(loaded, ["w-local", "w-cloud"]),
    );
    const built = new Set(plan.map((b) => b.network));
    for (const id of ["w-local", "w-cloud"]) {
      expect(built.has(await networkOf(loaded, id))).toBe(true);
    }
    // Anti-vacuity: an empty plan would satisfy nothing above by making the
    // loop's body unreachable, and an over-broad plan would satisfy it by
    // containing every name there is.
    expect(built.size).toBe(2);
  });

  /**
   * The flat fleet is UNCHANGED, byte for byte, and that is a deliberate
   * reading of §6.1 rather than a transcription of §6.5.2's table. Composing
   * `<net>-<provider>` for a flat config would rename the network every
   * existing run already uses and orphan every adopted relay — a migration this
   * feature has no reason to ask for.
   */
  test("a flat fleet still joins the base network", async () => {
    const flat = doc() as Record<string, unknown>;
    const llm = flat["llm"] as Record<string, unknown>;
    delete llm["providers"];
    flat["workers"] = [{ id: "w-local", role: "plain" }];
    const loaded = await parseConfig(stringify(flat), "/tmp/fleet.yaml");
    expect(await networkOf(loaded, "w-local")).toBe(NET);
  });
});

// ---------------------------------------------------------------------------
// ISC-412 — an over-long provider key is refused at `up` NAMING THE FIELD
// ---------------------------------------------------------------------------

/**
 * The bound already existed. The DIAGNOSTIC did not, and that was the gap.
 *
 * `assertDockerName` has always enforced 128 characters and the composed relay
 * name has always passed through it, so an enormous provider key was always
 * refused. What came back was
 *
 *     egress: invalid docker container name "pifleet-egress-relay-pifleet-egress-aaaa…"
 *
 * — a string the operator never typed, from a module named for egress, with no
 * mention of `llm.providers` in it. Every other value this codebase composes
 * into a Docker name is one it derived itself, so naming the derived string was
 * always equivalent to naming the input; a provider key is the first one where
 * it is not (§6.5.2). These tests pin the MESSAGE, not the refusal — the
 * refusal was never the thing that was missing.
 *
 * ## Why the boundary is asserted on BOTH sides
 *
 * A test that only checks "a 500-character key throws" passes against the old
 * code, against a `128 - net - 1` budget, and against a budget of three. It
 * cannot fail in the direction that matters. So the pair below straddles the
 * exact edge: 92 characters is ACCEPTED and composes into a relay name of
 * exactly 128, and 93 is REFUSED as "1 too long". Only a budget that reserves
 * the relay prefix exactly puts the edge there.
 */
describe("ISC-412: an over-long provider key is refused naming llm.providers", () => {
  /**
   * The budget's arithmetic, written as the test rather than as a comment.
   * Pinned literally, because a budget that recomputed itself from whatever the
   * code currently does would agree with any bug.
   */
  test("the budget reserves the relay prefix, not just the network name", () => {
    expect(RELAY_NAME_PREFIX.length).toBe(21);
    expect(NET.length).toBe(14);
    expect(providerKeyBudget(NET)).toBe(128 - 21 - 14 - 1);
    expect(providerKeyBudget(NET)).toBe(92);
    // The naive budget — the one that checks only the network name — is 21
    // characters more generous, and every key in that gap is one this
    // criterion exists to catch.
    expect(providerKeyBudget(NET)).toBeLessThan(128 - NET.length - 1);
  });

  /**
   * THE CONTROL. A key at exactly the budget composes into a relay name of
   * exactly 128 and is accepted end to end.
   *
   * Without this, every assertion below is satisfied by a budget of zero —
   * refuse everything and all the anti-tests pass. This is the half that goes
   * red if the bound is tightened for no reason.
   */
  test("a key at exactly the budget is accepted, and its relay name is exactly 128", () => {
    const key = "a".repeat(providerKeyBudget(NET));
    const network = providerNetworkName(NET, key);
    const relay = relayContainerName(network);
    expect(relay.length).toBe(128);
    // Docker's own validator agrees, so the accepted edge is a real limit
    // rather than a number this test and the budget both invented.
    expect(() => assertDockerName("container", relay)).not.toThrow();
    expect(() => uplinkNetworkName(network)).not.toThrow();
  });

  /** THE ANTI, one character past the control. Same fleet, same network. */
  test("one character past the budget is refused, and the message names the field", () => {
    const key = "a".repeat(providerKeyBudget(NET) + 1);
    let message = "";
    try {
      providerNetworkName(NET, key);
      throw new Error("providerNetworkName accepted a key that overflows the relay name");
    } catch (err) {
      message = (err as Error).message;
    }
    // THE CRITERION: the field, by name. Not the derived string.
    expect(message).toContain("llm.providers.");
    expect(message).toContain(key);
    // By how much, so the operator does not binary-search their own key.
    expect(message).toContain("1 too long");
    expect(message).toContain(`at most ${providerKeyBudget(NET)} characters`);
    // And the OLD message is gone — this is what a regression would restore.
    expect(message).not.toContain("invalid docker network name");
    expect(message).not.toContain("invalid docker container name");
  });

  /**
   * THE GAP ITSELF, and the sharpest test in this block.
   *
   * A 93-character key composes into a NETWORK name of 108, which Docker
   * accepts without complaint. Only the relay name — 21 characters longer —
   * breaks the limit. A budget derived from the network name alone therefore
   * lets this key straight through `providerNetworkName`, and it fails later in
   * `relayContainerName`, talking about containers. This is the test that goes
   * red for that mutation, and it is why the budget is a function of
   * `RELAY_NAME_PREFIX`.
   */
  test("a key the NETWORK name would accept is still refused for the RELAY name", () => {
    const key = "a".repeat(93);
    // The premise, measured rather than assumed: this key really does fit a
    // network name. If it did not, the assertion below would prove nothing.
    expect(`${NET}-${key}`.length).toBeLessThanOrEqual(128);
    expect(() => assertDockerName("network", `${NET}-${key}`)).not.toThrow();
    // …and really does not fit the relay name.
    expect(`${RELAY_NAME_PREFIX}${NET}-${key}`.length).toBeGreaterThan(128);
    expect(() => providerNetworkName(NET, key)).toThrow(/llm\.providers\./);
  });

  /**
   * The remedy names BOTH inputs, because the budget is a function of both. An
   * operator whose key cannot get any shorter needs to be told that the
   * fleet's `docker.network` is what left no room.
   */
  test("the refusal names docker.network too, since it spends the same budget", () => {
    const key = "a".repeat(providerKeyBudget(NET) + 1);
    let message = "";
    try {
      providerNetworkName(NET, key);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("docker.network");
    expect(message).toContain(JSON.stringify(NET));
    // A longer network name really does buy the key less room, so the network
    // is named because it matters rather than decoratively.
    expect(providerKeyBudget(`${NET}-longer`)).toBe(providerKeyBudget(NET) - 7);
  });

  /**
   * A key Docker's GRAMMAR refuses is operator-chosen too, and the
   * flag-injection hazard `docker-names.ts` exists to close is reported best by
   * pointing at the config key that carries it.
   */
  test("a key that is not a legal Docker name is refused naming the field as well", () => {
    for (const bad of ["--driver=host", "-leading-dash", "has space", ""]) {
      let message = "";
      try {
        providerNetworkName(NET, bad);
        throw new Error(`providerNetworkName accepted ${JSON.stringify(bad)}`);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("llm.providers.");
      expect(message).not.toContain("invalid docker network name");
    }
    // The grammar predicate is SHARED with `assertDockerName` rather than
    // copied, so a key this refuses is one Docker's own validator refuses too.
    expect(() => assertProviderKey(NET, "fine-key")).not.toThrow();
  });

  /**
   * THE CRITERION'S OWN WORDING — "refused at `up`".
   *
   * `up` builds the plan inside a `try` whose `catch` raises `CliError(…,
   * EXIT.USAGE)`. What has to be true here is that the refusal reaches that
   * `catch` at all: thrown by `egressBridgePlan`, from a real fleet-shaped
   * config, and not by something further down that only runs after the first
   * daemon call has already created a network.
   */
  test("the refusal is thrown by egressBridgePlan, so `up` refuses before any daemon call", () => {
    const cfg = threeProviders();
    const providers = cfg.llm.providers as Record<
      string,
      { base_url: string; relay_upstream: string | null }
    >;
    const longKey = "a".repeat(providerKeyBudget(NET) + 1);
    providers[longKey] = { base_url: "https://api.toolong.test/v1", relay_upstream: "198.51.100.9:443" };
    expect(() => egressBridgePlan(cfg, NET, [longKey])).toThrow(/llm\.providers\./);
    // "Exits non-zero" is half the probe, so assert the code rather than
    // trusting the constant's name.
    expect(EXIT.USAGE).toBeGreaterThan(0);
    // Anti-vacuity: the same plan call over the same providers map SUCCEEDS for
    // a key that fits, so the throw above is about the key's length and not
    // about the fixture being malformed.
    providers["fits"] = { base_url: "https://api.fits.test/v1", relay_upstream: "198.51.100.8:443" };
    expect(() => egressBridgePlan(cfg, NET, ["fits"])).not.toThrow();
  });
});
