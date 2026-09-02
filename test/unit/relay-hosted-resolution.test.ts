/**
 * ISC-426 — a `hosted: true` provider's HOSTNAME `relay_upstream` is resolved
 * ON THE HOST at `up`, and the relay's target carries the LITERAL (D9, §6.7).
 *
 * ## The fixture is §6.7's failure, written down
 *
 * `ollama-cloud` names `ollama.com` in BOTH `base_url` and `relay_upstream`,
 * and that collision is the whole point rather than laziness. `relayListenAliases`
 * publishes `base_url`'s host as an alias on the bridge the relay is itself
 * attached to, so a target carrying the NAME would resolve, through Docker's
 * embedded DNS, TO THE RELAY — every forwarded connection loops into its own
 * listener and the client hangs for the full timeout with nothing in
 * `docker logs`. §6.7 measured that; it is not inferred.
 *
 * It also removes the vacuity from the central assertion. "The target does not
 * contain `ollama.com`" is worth nothing if `ollama.com` appears nowhere in the
 * plan — a typo in the fixture would satisfy it. Here the name is asserted
 * PRESENT in the alias set in the same breath as it is asserted ABSENT from the
 * target, so the two fail in opposite directions and a passing pair carries
 * information.
 *
 * ## Why the resolver is injected
 *
 * `lookupHostAddresses` is `getaddrinfo` on the host, which is the mechanism
 * D9 specifies and exactly the thing a test must not depend on: a vendor's live
 * A record makes this file fail when someone else's DNS changes, and offline CI
 * would fail it for a third reason. The fake answers a fixed RRset and RECORDS
 * ITS CALLS, which is what makes the anti-criteria below provable — "a
 * non-hosted provider did not acquire a resolution step" is a claim about a
 * call that must NOT happen, and only a recording fake can witness it.
 *
 * The real resolver is exercised once, at the bottom, against `localhost` —
 * a name every host answers from `/etc/hosts` with no network at all.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { realExec } from "../../src/container/run.ts";
import {
  chooseUpstreamAddress,
  egressBridgePlan,
  lookupHostAddresses,
  providerNetworkName,
  RELAY_DEFAULT_DIAL_HOST,
  RELAY_TARGETS_ENV,
  RelayUpstreamResolutionError,
  ensureBridgeRelay,
  ensureEgressRelay,
  uplinkNetworkName,
  type FleetRelayConfigView,
  type HostAddressLookup,
} from "../../src/security/relay.ts";
import { answerMountProbe, isMountProbe } from "../support/mount-probe-fake.ts";

/**
 * A network name no fleet uses, per process.
 *
 * `ensureEgressRelay` reaches `ensureUplinkNetwork`, which takes NO injected
 * `exec` and therefore talks to the REAL daemon however thoroughly the rest of
 * the call is faked. The sibling D7 file learned that by creating
 * `pifleet-egress-…-uplink` beside a live fleet's networks. `process.pid` keeps
 * parallel runs from colliding, and `afterAll` removes what this file made.
 */
const NET = `pifleet-isc426-${process.pid.toString(36)}`;

/** The RRset the fake resolver answers for `ollama.com`. */
const OLLAMA_ADDRS = ["34.36.133.15"] as const;
const OLLAMA_ADDR = OLLAMA_ADDRS[0];

/**
 * One hosted provider naming a hostname, one non-hosted provider naming a
 * literal — and they agree about nothing else, so no assertion below can pass
 * because two derivations happened to return the same string.
 */
function fleet(): FleetRelayConfigView {
  return {
    llm: {
      // Deliberately unlike either block: a derivation that fell back to the
      // flat keys would put `omlx.legacy.test` somewhere these tests read.
      base_url: "http://omlx.legacy.test:7000/v1",
      relay_upstream: null,
      providers: {
        /** The operator's own machine. D9 changes NOTHING here. */
        omlx: {
          base_url: "http://omlx.house.test:8000/v1",
          relay_upstream: "192.168.86.49:8000",
          hosted: false,
        },
        /** §6.7's alias loop: the same name on both sides. */
        "ollama-cloud": {
          base_url: "https://ollama.com/v1",
          relay_upstream: "ollama.com:443",
          hosted: true,
        },
      },
    },
    egress: {
      google_hosts: [],
      /*
       * THE NAME ONLY, and the address is deliberately NOT authorized here.
       *
       * An earlier draft of this fixture allowed both, reasoning that ISC-428
       * was landing in parallel and this file should not depend on it. That was
       * exactly wrong, and it took ISC-428 landing to see why: with the address
       * also allowed, a target that FAILED to carry `policyHost` would be
       * judged on its dialled literal, find it in this list, and pass. The
       * belt-and-braces entry masked the one failure the integration can have.
       *
       * With the name alone, `assertTargetsAllowed` admits this relay only if
       * `policyHost` really carries the pre-resolution name — so
       * `ensureBridgeRelay` below is a live tripwire on the ISC-428 seam rather
       * than a test that would pass with the seam cut. §6.7's whole sentence is
       * that the operator authorizes a NAME while the relay dials an ADDRESS;
       * a fixture authorizing both is not testing that sentence.
       */
      allow: [
        { host: "192.168.86.49", port: 8000 },
        { host: "ollama.com", port: 443 },
      ],
    },
  };
}

/** §6.1's shorthand — no `providers` map, and therefore no `hosted` anywhere. */
function flatFleet(): FleetRelayConfigView {
  return {
    llm: { base_url: "http://omlx.legacy.test:7000/v1", relay_upstream: null },
    egress: { google_hosts: [], allow: [] },
  };
}

/**
 * A resolver that answers a fixed table and REMEMBERS WHAT IT WAS ASKED.
 *
 * The call log is the instrument for every anti-criterion in this file. "The
 * literal was not resolved" and "the non-hosted block was not resolved" are
 * claims about an absent call, and an assertion on the RESULT cannot tell a
 * skipped resolution apart from one that happened and returned the same string.
 */
function fakeResolver(table: Readonly<Record<string, readonly string[]>>) {
  const calls: string[] = [];
  const lookup: HostAddressLookup = async (hostname) => {
    calls.push(hostname);
    const answer = table[hostname];
    if (answer === undefined) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      (err as { code?: string }).code = "ENOTFOUND";
      throw err;
    }
    return answer;
  };
  return { calls, lookup };
}

/** The resolver a test uses when it asserts NOTHING may be resolved at all. */
const forbiddenResolver: HostAddressLookup = async (hostname) => {
  throw new Error(`resolution attempted for ${hostname}, and this test forbids it`);
};

const answersOllama = { "ollama.com": OLLAMA_ADDRS } as const;

// ---------------------------------------------------------------------------
// THE CRITERION
// ---------------------------------------------------------------------------

describe("ISC-426: the relay's target carries the resolved literal, never the name", () => {
  test("a hosted block's hostname upstream reaches the target as an IP literal", async () => {
    const { calls, lookup } = fakeResolver(answersOllama);
    const plan = await egressBridgePlan(fleet(), NET, ["ollama-cloud"], lookup);

    const target = plan[0]!.targets[0]!;
    expect(target.host).toBe(OLLAMA_ADDR);
    // The literal, stated as a PROPERTY and not only as a string match: a
    // future fixture change that swapped the address keeps this honest.
    expect(target.host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // …and the name is gone from THE FIELD THAT IS DIALLED. See the header for
    // why this is not vacuous.
    expect(target.host).not.toBe("ollama.com");

    /*
     * The name is not gone from the TARGET, and this assertion used to say it
     * was — wrongly, and it took ISC-428 landing to show it.
     *
     * `assertTargetsAllowed` judges `policyHost ?? host`, so the operator
     * authorizes `{host: ollama.com, port: 443}` in `egress.allow` while the
     * relay dials the address. A target that dropped the name would be refused
     * at `default-deny` on every hosted fleet. So the criterion is not "the
     * name appears nowhere" — that is the blunt version, and it is false — it
     * is "the name is never the string the relay dials, and is exactly the
     * string the policy judges".
     */
    expect(target.policyHost).toBe("ollama.com");
    expect(target.policyHost).not.toBe(target.host);

    // THE ANTI-VACUITY CONTROL, in the same run: the very name that must not
    // appear in the target IS published as an alias on this bridge, which is
    // the loop §6.7 measured. A fixture typo turns this red.
    expect(plan[0]!.aliases).toContain("ollama.com");

    // The resolution really happened, and for the upstream host rather than
    // for `base_url`'s (they are the same string here, so the CALL is the only
    // thing that can distinguish them from the result).
    expect(calls).toEqual(["ollama.com"]);

    // Everything else about the target is untouched by the resolution: the
    // listen side still comes from `base_url`, the dial port from
    // `relay_upstream`, the name from the provider key.
    expect(target.listenPort).toBe(443);
    expect(target.port).toBe(443);
    expect(target.name).toBe("ollama-cloud");
  });

  test("the resolution is recorded as a NAME/ADDRESS pair for the ledger", async () => {
    const { lookup } = fakeResolver(answersOllama);
    const plan = await egressBridgePlan(fleet(), NET, ["ollama-cloud"], lookup);

    // ISC-426 asks for BOTH halves. Asserted separately rather than as one
    // object literal so a report can say which half went missing.
    expect(plan[0]!.upstreamResolution).not.toBeNull();
    expect(plan[0]!.upstreamResolution!.name).toBe("ollama.com");
    expect(plan[0]!.upstreamResolution!.address).toBe(OLLAMA_ADDR);
    // The pair must describe THIS relay's dial, not a second resolution: the
    // recorded address is the one in the target, identically.
    expect(plan[0]!.upstreamResolution!.address).toBe(plan[0]!.targets[0]!.host);
  });
});

// ---------------------------------------------------------------------------
// The anti-criteria: nothing else acquires a resolution step
// ---------------------------------------------------------------------------

describe("ISC-426 anti: a non-hosted provider and a flat fleet are untouched", () => {
  test("a hosted:false block with an IP literal is never resolved", async () => {
    const { calls, lookup } = fakeResolver(answersOllama);
    const plan = await egressBridgePlan(fleet(), NET, ["omlx"], lookup);

    expect(plan[0]!.targets[0]!.host).toBe("192.168.86.49");
    expect(plan[0]!.upstreamResolution).toBeNull();
    // The load-bearing half: no call was made. A result assertion alone cannot
    // tell "skipped" from "resolved and got the same literal back".
    expect(calls).toEqual([]);
  });

  test("a HOSTED block that wrote a literal anyway is never resolved either", async () => {
    const cfg = fleet();
    cfg.llm.providers!["ollama-cloud"]!.relay_upstream = "34.36.133.15:443";
    const { calls, lookup } = fakeResolver(answersOllama);
    const plan = await egressBridgePlan(cfg, NET, ["ollama-cloud"], lookup);

    expect(plan[0]!.targets[0]!.host).toBe("34.36.133.15");
    expect(plan[0]!.upstreamResolution).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a flat pre-D7 fleet plans byte for byte what it always did", async () => {
    // `forbiddenResolver` rather than a recording fake: for the flat path the
    // claim is absolute, so the test should die on the call rather than on an
    // assertion after it.
    const plan = await egressBridgePlan(flatFleet(), NET, ["omlx"], forbiddenResolver);

    // The expected target is written out BY HAND, not re-derived from
    // `omlxRelayTarget`. Comparing production against itself would stay green
    // through any change to it, which is the one thing this test exists to
    // catch.
    expect(plan).toHaveLength(1);
    expect(plan[0]!.targets).toEqual([
      { listenPort: 7000, host: RELAY_DEFAULT_DIAL_HOST, port: 7000, name: "omlx" },
    ]);
    expect(plan[0]!.upstreamResolution).toBeNull();
    // The flat fleet keeps the base network verbatim — unchanged by D9 as it
    // was by D7.
    expect(plan[0]!.network).toBe(NET);
  });

  /**
   * THE PAIR, pinned — and it was NOT pinned until a mutation said so.
   *
   * `egressBridgePlan` reads `hosted` once and feeds it to two places: the
   * `allowHostname` that lets `providerRelayTarget` PARSE a hostname, and the
   * `resolvable` gate that decides whether to RESOLVE one. Mutating either one
   * to `true` on its own was measured GREEN against every other test in this
   * file, because no fixture anywhere put a hostname on a non-hosted block —
   * the one input that can tell the two apart.
   *
   * Without this test the interesting failure is invisible: `allowHostname`
   * forced true would let a non-hosted block's hostname through the parser, and
   * `resolvable`'s `hosted &&` would then decline to resolve it, so the relay
   * would dial THE NAME — §6.7's alias loop, on the provider D9 explicitly
   * refuses to weaken. This is the assertion that turns that red.
   *
   * It is deliberately the PLAN's refusal and not the schema's. ISC-427 owns
   * `config validate`; this owns the layer under it, which the whole test suite
   * — and `relayViewForProvider`'s exported structural view — reaches directly
   * without ever passing through Zod.
   */
  test("a hosted:false block naming a HOSTNAME is refused, not resolved", async () => {
    const cfg = fleet();
    cfg.llm.providers!["omlx"]!.relay_upstream = "macbook.local:8000";
    const { calls, lookup } = fakeResolver({ "macbook.local": ["192.168.86.49"] });

    await expect(egressBridgePlan(cfg, NET, ["omlx"], lookup)).rejects.toThrow(
      /is a hostname; relay_upstream must be an IP literal/,
    );
    // …and it was refused BEFORE any resolution, not after one. A plan that
    // resolved first and refused second would still have made the network call
    // D9 confines to hosted blocks.
    expect(calls).toEqual([]);

    // ANTI-VACUITY, in the same run: flipping `hosted` — and changing NOTHING
    // else, the same host, the same port, the same fixture — is what makes it
    // legal. Without this the refusal above could be about the name being
    // malformed rather than about the block being non-hosted.
    cfg.llm.providers!["omlx"]!.hosted = true;
    const plan = await egressBridgePlan(cfg, NET, ["omlx"], lookup);
    expect(plan[0]!.targets[0]!.host).toBe("192.168.86.49");
    expect(plan[0]!.upstreamResolution).toEqual({
      name: "macbook.local",
      address: "192.168.86.49",
    });
    expect(calls).toEqual(["macbook.local"]);
  });

  test("the Docker-host alias is NOT resolved, so --add-host still fires", async () => {
    /*
     * `relayRunArgv` detects the literal string `host.docker.internal` in the
     * target list and adds `--add-host …:host-gateway`. Resolving it here would
     * substitute an address, the string would stop matching, the flag would not
     * be added, and the relay would dial whatever THIS machine thinks that name
     * means — usually nothing. So it is exempted, and the exemption is checked
     * against the real argv rather than against the plan alone.
     */
    const cfg = fleet();
    cfg.llm.providers!["ollama-cloud"]!.relay_upstream = `${RELAY_DEFAULT_DIAL_HOST}:443`;
    const plan = await egressBridgePlan(cfg, NET, ["ollama-cloud"], forbiddenResolver);

    expect(plan[0]!.targets[0]!.host).toBe(RELAY_DEFAULT_DIAL_HOST);
    expect(plan[0]!.upstreamResolution).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The choice of address, and why it must be stable
// ---------------------------------------------------------------------------

describe("ISC-426: the address chosen from an RRset is deterministic", () => {
  /**
   * A ROTATING RRset is the ordinary case for a global load balancer, and
   * `relayTargetsDrifted` keys on the target's host. Taking the resolver's
   * first answer would report a SHARED relay as drifted and tear it down on
   * every `up`, with no configuration change at all — the cost §6.5.4 spends a
   * paragraph avoiding for the target NAME.
   */
  test("a rotated RRset yields the same address every time", async () => {
    const rotations = [
      ["34.36.133.15", "104.18.0.1", "203.0.113.7"],
      ["104.18.0.1", "203.0.113.7", "34.36.133.15"],
      ["203.0.113.7", "34.36.133.15", "104.18.0.1"],
    ];
    const chosen = rotations.map((r) => chooseUpstreamAddress(r));
    expect(new Set(chosen).size).toBe(1);
    // Anti-vacuity: the rotations really are different lists, so "all the same"
    // is a fact about the choice rather than about the input.
    expect(new Set(rotations.map((r) => r.join(","))).size).toBe(3);
    // Ordered NUMERICALLY, not lexicographically — `34.…` sorts after `203.…`
    // as text and before it as an address.
    expect(chosen[0]).toBe("34.36.133.15");
  });

  test("IPv4 wins over IPv6 whichever order the resolver offered them", async () => {
    // Docker does not enable IPv6 on user-defined bridges by default, so a
    // AAAA target is a relay that starts cleanly and fails every connection —
    // §6.7's failure, reintroduced by the mechanism meant to remove it.
    expect(chooseUpstreamAddress(["2606:4700::1111", "104.18.0.1"])).toBe("104.18.0.1");
    expect(chooseUpstreamAddress(["104.18.0.1", "2606:4700::1111"])).toBe("104.18.0.1");
    // …and a v6-only answer is still usable rather than refused.
    expect(chooseUpstreamAddress(["2606:4700::1111"])).toBe("2606:4700::1111");
  });

  test("an empty or unusable answer is null, so the caller owns the message", () => {
    expect(chooseUpstreamAddress([])).toBeNull();
    expect(chooseUpstreamAddress(["not-an-address", ""])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure: a name that does not resolve refuses the fleet, loudly and typed
// ---------------------------------------------------------------------------

describe("ISC-426: an unresolvable hosted upstream refuses the fleet", () => {
  test("a resolver error becomes a typed RelayUpstreamResolutionError", async () => {
    const { lookup } = fakeResolver({});
    let caught: unknown;
    try {
      await egressBridgePlan(fleet(), NET, ["ollama-cloud"], lookup);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RelayUpstreamResolutionError);
    const err = caught as RelayUpstreamResolutionError;
    // The message must name the FIELD and the PROVIDER, or an operator with a
    // two-provider fleet cannot tell which block to look at.
    expect(err.message).toContain("llm.providers.ollama-cloud.relay_upstream");
    expect(err.message).toContain("ollama.com");
    // The resolver's own words survive, so ENOTFOUND is distinguishable from a
    // timeout without turning on a debugger.
    expect(err.message).toContain("ENOTFOUND");
    expect(err.provider).toBe("ollama-cloud");
    expect(err.hostname).toBe("ollama.com");
    // The type is the interface `up` switches its exit code on, not the text.
    expect(err.cause).toBeInstanceOf(Error);
  });

  test("a resolver that answers with nothing is a refusal, not an empty target", async () => {
    const { lookup } = fakeResolver({ "ollama.com": [] });
    await expect(egressBridgePlan(fleet(), NET, ["ollama-cloud"], lookup)).rejects.toThrow(
      RelayUpstreamResolutionError,
    );
  });

  test("an answer with no usable address is a refusal too", async () => {
    const { lookup } = fakeResolver({ "ollama.com": ["ollama.com.cdn.example"] });
    await expect(egressBridgePlan(fleet(), NET, ["ollama-cloud"], lookup)).rejects.toThrow(
      /no usable IP address/,
    );
  });
});

// ---------------------------------------------------------------------------
// The instrument the criterion names: PIFLEET_RELAY_TARGETS
// ---------------------------------------------------------------------------

describe("ISC-426: the literal is what reaches the container's env", () => {
  afterAll(async () => {
    // Only what this block can have created, by exact derived name — never a
    // prune, and never a name a real fleet uses.
    for (const provider of ["ollama-cloud", "omlx"]) {
      await realExec(
        ["docker", "network", "rm", uplinkNetworkName(providerNetworkName(NET, provider))],
        { timeoutMs: 30_000 },
      ).catch(() => {});
    }
  }, 60_000);

  /** A daemon reporting no existing relay, so the CREATE path builds an argv. */
  function daemon() {
    const calls: string[][] = [];
    let inspects = 0;
    const exec = async (argv: string[]) => {
      calls.push(argv);
      if (isMountProbe(argv)) return answerMountProbe(argv);
      if (argv[1] === "inspect") {
        inspects += 1;
        if (inspects === 1) return { code: 1, stdout: "[]", stderr: "No such object" };
        return {
          code: 0,
          stdout: JSON.stringify([
            { Name: `/${argv[2]}`, Id: "abc123", State: { Running: true }, Config: { Env: [] } },
          ]),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, exec: exec as unknown as Parameters<typeof ensureEgressRelay>[2] };
  }

  function relayRunArgvFrom(calls: string[][]): string[] {
    const run = calls.find((c) => c[1] === "run" && !isMountProbe(c));
    if (run === undefined) throw new Error("no `docker run` was issued for the relay");
    return run;
  }

  /**
   * THE CRITERION'S LITERAL INSTRUMENT.
   *
   * The plan being right is not the claim — ISC-409's defect was a plan that
   * was right and a container that was not, because `ensureEgressRelay`
   * re-derived its own target. This reads the value out of the argv the daemon
   * would actually be handed.
   */
  test("PIFLEET_RELAY_TARGETS carries the literal and not the name", async () => {
    const { lookup } = fakeResolver(answersOllama);
    const plan = await egressBridgePlan(fleet(), NET, ["ollama-cloud"], lookup);
    const { calls, exec } = daemon();
    await ensureBridgeRelay(plan[0]!, exec);

    const argv = relayRunArgvFrom(calls);
    const prefix = `${RELAY_TARGETS_ENV}=`;
    const row = argv.find((a) => a.startsWith(prefix));
    expect(row).toBeDefined();
    const stamped = JSON.parse(row!.slice(prefix.length)) as Array<{
      name: string;
      host: string;
      port: number;
      policyHost?: string;
    }>;
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.host).toBe(OLLAMA_ADDR);
    expect(stamped[0]!.name).toBe("ollama-cloud");
    /*
     * `host` is what the relay script dials, and the name must never be there:
     * that is the string that resolves to the relay itself through Docker's
     * embedded DNS and loops every connection into its own listener.
     *
     * `policyHost` beside it is the authorized name and is inert to the relay
     * — the script reads `host` and `port` — so both travelling in one env var
     * is the container documenting what it dials AND on whose authority.
     */
    expect(stamped[0]!.policyHost).toBe("ollama.com");
    expect(stamped[0]!.host).not.toBe(stamped[0]!.policyHost);

    // ANTI-VACUITY: the name IS in this same argv, as a published alias, so
    // "absent from the targets row" is a statement about that row and not
    // about the launch. The alias arrives via `docker network connect`.
    const connect = calls.find((c) => c[1] === "network" && c[2] === "connect");
    expect(connect).toBeDefined();
    expect(connect!.join(" ")).toContain("ollama.com");
  });

  test("a hosted upstream on the Docker-host alias still gets --add-host", async () => {
    const cfg = fleet();
    cfg.llm.providers!["ollama-cloud"]!.relay_upstream = `${RELAY_DEFAULT_DIAL_HOST}:443`;
    const plan = await egressBridgePlan(cfg, NET, ["ollama-cloud"], forbiddenResolver);
    const { calls, exec } = daemon();
    await ensureBridgeRelay(plan[0]!, exec);

    const argv = relayRunArgvFrom(calls);
    expect(argv).toContain("--add-host");
    expect(argv.join(" ")).toContain(`${RELAY_DEFAULT_DIAL_HOST}:host-gateway`);
  });
});

// ---------------------------------------------------------------------------
// The real resolver, once, against a name every host answers offline
// ---------------------------------------------------------------------------

describe("ISC-426: the production resolver is getaddrinfo on this host", () => {
  /**
   * Every test above injects a fake, so all of them would stay green if
   * `lookupHostAddresses` were broken, or if `egressBridgePlan`'s DEFAULT
   * argument pointed at something else entirely. This one exercises the real
   * default, end to end, with no fake anywhere.
   *
   * `localhost` rather than a vendor name on purpose: every host answers it
   * from `/etc/hosts` with no network, no DNS server and no dependency on
   * somebody else's A record staying put. It is a hostname — `isIP` returns 0
   * for it — so it takes the resolution branch exactly as `ollama.com` does.
   */
  test("a hosted block naming `localhost` resolves through the real default", async () => {
    const base = fleet();
    base.llm.providers!["ollama-cloud"]!.base_url = "https://ollama.com:8443/v1";
    base.llm.providers!["ollama-cloud"]!.relay_upstream = "localhost:8443";
    const cfg: FleetRelayConfigView = {
      llm: base.llm,
      egress: {
        google_hosts: base.egress.google_hosts,
        allow: [
          ...base.egress.allow,
          { host: "127.0.0.1", port: 8443 },
          { host: "::1", port: 8443 },
        ],
      },
    };

    // NO fourth argument — production's default resolver, deliberately.
    const plan = await egressBridgePlan(cfg, NET, ["ollama-cloud"]);

    const host = plan[0]!.targets[0]!.host;
    expect(host).not.toBe("localhost");
    // IPv4 is preferred where the host offers both, and `localhost` is the one
    // name that reliably offers both.
    expect(["127.0.0.1", "::1"]).toContain(host);
    expect(plan[0]!.upstreamResolution).toEqual({ name: "localhost", address: host });
  });

  test("lookupHostAddresses returns real addresses for a real name", async () => {
    const found = await lookupHostAddresses("localhost");
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("127.0.0.1");
  });
});
