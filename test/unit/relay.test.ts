/**
 * The egress relay's pure core (SRD §5.6, §5.9, §12.4; ISC-50, ISC-51, ISC-57).
 *
 * Everything here is daemon-free on purpose. `src/security/relay.ts` splits the
 * same way `src/security/network.ts` does — pure argv builders and parsers on
 * one side, a thin `docker` layer on the other — because the parts that decide
 * WHAT gets run are the parts a reviewer has to be able to read as facts. The
 * integration suite proves the resulting containers actually forward; only
 * these tests prove the argv carries the flags that make that forwarding safe,
 * and a hardening flag silently dropped from `docker run` is invisible to a
 * test that only checks "a relay came up".
 *
 * The argv assertions are byte-for-byte whole-array comparisons rather than
 * `toContain` spot-checks, for the same reason `networkCreateArgv`'s test is:
 * `--internal` there and `--read-only`/`--cap-drop ALL` here are security
 * properties, and a partial assertion passes while they are being removed.
 */

import { describe, expect, test } from "bun:test";
import { policyFromConfig } from "../../src/security/egress.ts";
import {
  assertTargetsAllowed,
  ensureEgressRelay,
  omlxRelayTarget,
  parseRelayInspect,
  parseRelayUpstream,
  relayGatePolicy,
  relayUpstreamError,
  relayUpstreamFor,
  relayConnectArgv,
  relayContainerName,
  relayInspectArgv,
  relayRemoveArgv,
  relayRunArgv,
  relayScriptPath,
  relayScriptSha256,
  uplinkNetworkName,
  RELAY_DEFAULT_DIAL_HOST,
  RELAY_IMAGE,
  RELAY_LISTEN_ALIAS,
  RELAY_SCRIPT_CONTAINER_PATH,
  type RelayTarget,
} from "../../src/security/relay.ts";

const NET = "pifleet-egress";

/**
 * A full `RelayConfigView`. The relay judges its own targets with `decide()`,
 * so it needs the `egress` half of the config too — a view wide enough to build
 * a target but too narrow to build the policy that judges it is exactly how the
 * two used to drift apart.
 *
 * `relay_upstream` defaults to `null` here for the same reason it does in the
 * schema: that is what an untouched pre-ISC-259 `fleet.yaml` supplies, so every
 * test written before the split still describes the case it always described.
 */
function cfg(
  base_url: string,
  egress?: Partial<{ google_hosts: string[]; allow: Array<{ host: string; port: number }> }>,
  relay_upstream: string | null = null,
) {
  return {
    llm: { base_url, relay_upstream },
    egress: {
      google_hosts: egress?.google_hosts ?? ["oauth2.googleapis.com"],
      allow: egress?.allow ?? [],
    },
  };
}

/** The measured LAN oMLX this change exists to permit (SRD §5.9; ISC-259). */
const LAN_OMLX = "192.168.86.49";
const DEFAULT_BASE_URL = "http://host.docker.internal:8000/v1";

describe("omlxRelayTarget", () => {
  test("derives the forward from llm.base_url's port — never a hardcoded 8000", () => {
    // The schema default. `listenPort` and `port` are deliberately the SAME
    // number: a worker's baked-in `host.docker.internal:8000` must arrive at
    // the relay on 8000 and leave for the real host on 8000, or the alias
    // trick resolves to a container listening somewhere else.
    expect(omlxRelayTarget(cfg("http://host.docker.internal:8000/v1"))).toEqual({
      listenPort: 8000,
      host: RELAY_DEFAULT_DIAL_HOST,
      port: 8000,
      name: "omlx",
    });
  });

  test("a non-default port is carried through both legs", () => {
    expect(omlxRelayTarget(cfg("http://host.docker.internal:11434/v1"))).toEqual({
      listenPort: 11434,
      host: RELAY_DEFAULT_DIAL_HOST,
      port: 11434,
      name: "omlx",
    });
  });

  test("an absent port defaults by protocol, exactly as policyFromConfig does", () => {
    // Mirroring `policyFromConfig`'s rule rather than inventing a second one:
    // the policy and the relay must agree about which port is being allowed,
    // and two independent defaults are how they drift apart.
    expect(omlxRelayTarget(cfg("http://host.docker.internal/v1")).port).toBe(80);
    expect(omlxRelayTarget(cfg("https://host.docker.internal/v1")).port).toBe(443);
  });

  test("a trailing-dot or upper-case spelling of the host is still the host", () => {
    // Normalized through the same `normalizeHost` the policy matcher uses, so
    // `HOST.DOCKER.INTERNAL.` cannot read as "some other host" and get refused
    // while the policy happily allows it.
    expect(
      omlxRelayTarget(cfg("http://HOST.DOCKER.INTERNAL.:8000/v1")).host,
    ).toBe(RELAY_DEFAULT_DIAL_HOST);
  });

  test("REFUSES a base_url pointing anywhere other than the Docker host", () => {
    // This relay is single-purpose. A target built for `10.0.0.5:8000` would
    // be forwarded from a listener that no worker can ever reach, because the
    // only name aliased onto the internal bridge is `host.docker.internal` —
    // so the fleet would report a working relay and every worker would fail to
    // resolve its model server. Refusing loudly is the only honest answer.
    expect(() => omlxRelayTarget(cfg("http://10.0.0.5:8000/v1"))).toThrow(
      /host\.docker\.internal/,
    );
    expect(() => omlxRelayTarget(cfg("http://localhost:8000/v1"))).toThrow(
      /host\.docker\.internal/,
    );
  });

  test("an unparseable base_url throws rather than yielding a targetless relay", () => {
    expect(() => omlxRelayTarget(cfg("not a url"))).toThrow(/not a URL/);
  });

  test("a port outside the TCP range is refused, not silently listened on", () => {
    // `listen(0)` means "any free port" to node, which would come up healthy
    // and forward nothing a worker could find.
    expect(() => omlxRelayTarget(cfg("http://host.docker.internal:0/v1"))).toThrow(
      /port/,
    );
  });
});

describe("deterministic naming", () => {
  test("both names are derived from the egress network, so `up` is idempotent", () => {
    expect(relayContainerName(NET)).toBe("pifleet-egress-relay-pifleet-egress");
    expect(uplinkNetworkName(NET)).toBe("pifleet-egress-uplink");
  });

  test("an invalid egress network name is refused before it becomes docker argv", () => {
    // Same grammar `assertNetworkName` enforces: a name of `--driver=host`
    // parses as an OPTION, not as a name, and argv arrays do not stop flag
    // injection.
    for (const bad of ["", "-flag", "has space", "semi;colon", "--driver=host"]) {
      expect(() => relayContainerName(bad)).toThrow(/name/);
      expect(() => uplinkNetworkName(bad)).toThrow(/name/);
    }
  });

  test("a network name that is legal but too long to derive from is refused", () => {
    // The derived names are longer than their input, so a name Docker accepts
    // can still produce a container name it does not. Caught here rather than
    // as an opaque daemon error mid-`up`.
    const long = "n".repeat(126);
    expect(() => relayContainerName(long)).toThrow(/name/);
  });
});

describe("relayRunArgv", () => {
  const targets: RelayTarget[] = [
    { listenPort: 8000, host: RELAY_DEFAULT_DIAL_HOST, port: 8000, name: "omlx" },
  ];

  test("pins the whole invocation, hardening flags included", () => {
    // Read this as the security statement it is:
    //  --network <uplink>          the relay's PRIMARY network must be the
    //                              non-internal one, or --add-host below has
    //                              nothing to route through (measured live).
    //  --add-host host-gateway     the ONLY reliable way to reach the Docker
    //                              host from a container on this project's
    //                              Colima setup; the automatic /etc/hosts
    //                              injection was measured NOT to be dependable.
    //  --read-only, --cap-drop ALL, --security-opt no-new-privileges, --user
    //                              the relay is a network-exposed process on a
    //                              bridge every worker can reach; it gets the
    //                              worker containers' posture, not root.
    //  -v ...:ro                   the script is mounted, never baked, so it
    //                              changes without an image rebuild.
    //  --sysctl ip_forward=0       the relay is dual-homed, which is the shape
    //                              of a router; Docker leaves forwarding ON in
    //                              the netns (measured 1) and --cap-drop ALL
    //                              does not turn it off.
    //  --pids-limit/--memory/--cpus the posture the workers on the same bridge
    //                              already get (SRD §5.6). The relay outlives
    //                              every one of them, so exempting it was an
    //                              inconsistency rather than a decision.
    //  RELAY_IMAGE                 pinned BY DIGEST. This is the container
    //                              bridging the deny-all bridge to a NAT'd
    //                              network under --restart unless-stopped, so
    //                              a floating tag lets the code on that
    //                              boundary change under a machine reboot with
    //                              no commit in this repo. This byte-for-byte
    //                              comparison is what stops the digest being
    //                              quietly dropped again.
    expect(relayRunArgv("relay-x", "uplink-x", targets, "/repo/docker/egress-relay.cjs")).toEqual([
      "run",
      "-d",
      "--name",
      "relay-x",
      "--network",
      "uplink-x",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--restart",
      "unless-stopped",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--sysctl",
      "net.ipv4.ip_forward=0",
      "--pids-limit",
      "512",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--user",
      "node",
      "--label",
      "pifleet.component=egress-relay",
      "-v",
      "/repo/docker/egress-relay.cjs:/relay/egress-relay.cjs:ro",
      "-e",
      'PIFLEET_RELAY_TARGETS=[{"listenPort":8000,"host":"host.docker.internal","port":8000,"name":"omlx"}]',
      "--entrypoint",
      "node",
      RELAY_IMAGE,
      RELAY_SCRIPT_CONTAINER_PATH,
    ]);
  });

  test("--add-host is emitted for a Docker-host target and OMITTED for a LAN one", () => {
    // ISC-259 flagged this flag as becoming "dead weight or a bug". It is the
    // only reliable route from the uplink to the Docker host, so it is
    // mandatory for the default upstream — and it is an /etc/hosts line for a
    // name the relay never looks up once the upstream is a LAN IP. An argv
    // listing a mapping nothing uses invites the reader to believe the relay
    // reaches the Docker host when it does not.
    const toHost = relayRunArgv("relay-x", "uplink-x", targets, "/repo/docker/egress-relay.cjs");
    expect(toHost).toContain("--add-host");
    expect(toHost).toContain(`${RELAY_DEFAULT_DIAL_HOST}:host-gateway`);

    const toLan = relayRunArgv(
      "relay-x",
      "uplink-x",
      [{ listenPort: 8000, host: LAN_OMLX, port: 8000, name: "omlx" }],
      "/repo/docker/egress-relay.cjs",
    );
    expect(toLan).not.toContain("--add-host");
    expect(toLan.join(" ")).not.toContain("host-gateway");

    // Everything else about the invocation is unchanged — the hardening set is
    // not conditional on where the relay dials.
    for (const flag of ["--read-only", "--cap-drop", "no-new-privileges", "net.ipv4.ip_forward=0"]) {
      expect(toLan.join(" ")).toContain(flag);
    }
    // Beyond `--add-host` and the targets env var (which SHOULD differ — it
    // names a different destination), the two invocations are identical. Pinned
    // as a whole-array comparison so a flag quietly dropped from only the LAN
    // path cannot hide behind a spot-check.
    const withoutVariable = (argv: string[]) =>
      argv.filter(
        (a, i) =>
          !a.startsWith("PIFLEET_RELAY_TARGETS=") &&
          a !== "--add-host" &&
          !a.endsWith(":host-gateway") &&
          // drop the `-e` whose value we just removed
          !(a === "-e" && argv[i + 1]?.startsWith("PIFLEET_RELAY_TARGETS=")),
      );
    expect(withoutVariable(toLan)).toEqual(withoutVariable(toHost));
  });

  test("the LAN target is what the relay is told to forward, not the alias", () => {
    // The env var is the relay script's whole instruction set; if the decoupled
    // host did not reach it, every worker would still land on the Docker host.
    const argv = relayRunArgv(
      "relay-x",
      "uplink-x",
      [{ listenPort: 8000, host: LAN_OMLX, port: 9999, name: "omlx" }],
      "/repo/docker/egress-relay.cjs",
    );
    const env = argv[argv.indexOf("-e") + 1];
    expect(env).toBe(
      `PIFLEET_RELAY_TARGETS=[{"listenPort":8000,"host":"${LAN_OMLX}","port":9999,"name":"omlx"}]`,
    );
  });

  test("an empty target list is refused — a relay that forwards nothing is a lie", () => {
    expect(() => relayRunArgv("relay-x", "uplink-x", [], "/repo/docker/egress-relay.cjs")).toThrow(
      /target/,
    );
  });

  test("the image is pinned by digest, not by a floating tag", () => {
    // Asserted as a PROPERTY as well as inside the byte-for-byte argv above,
    // because the argv assertion would keep passing if someone replaced the
    // digest with a tag in both places at once. This one says what the rule
    // is: a mutable tag on this particular container means the code sitting on
    // the deny-all boundary can change with no commit in this repo.
    expect(RELAY_IMAGE).toContain("@sha256:");
    expect(RELAY_IMAGE).toMatch(/^node:24-bookworm-slim@sha256:[0-9a-f]{64}$/);
  });
});

describe("assertTargetsAllowed — the relay applies the egress policy (ISC-253)", () => {
  test("a target the policy allows passes", () => {
    const c = cfg("http://host.docker.internal:8000/v1");
    expect(() => assertTargetsAllowed([omlxRelayTarget(c)], policyFromConfig(c))).not.toThrow();
  });

  test("a target the policy DENIES is refused before any argv is built", () => {
    // Proved against an explicit policy rather than a config-derived one, and
    // deliberately so — see the vacuity note in the next test. This is the
    // assertion that shows the gate has teeth at all: given a policy that does
    // not cover the destination, the relay refuses to carry it.
    const policy = policyFromConfig(cfg("http://host.docker.internal:8000/v1"));
    const rogue: RelayTarget = {
      listenPort: 8000,
      host: RELAY_DEFAULT_DIAL_HOST,
      port: 22,
      name: "omlx",
    };
    expect(() => assertTargetsAllowed([rogue], policy)).toThrow(/refusing to forward/);
    expect(() => assertTargetsAllowed([rogue], policy)).toThrow(/egress policy denies/);
  });

  test("VACUITY CLOSED: policyFromConfig is no longer what guards the relay", () => {
    // This test REPLACES the one PR #18 shipped as `DOCUMENTED VACUITY`, which
    // asserted `assertTargetsAllowed(target, policyFromConfig(c))` cannot refuse
    // a bad port because both sides derive from `llm.base_url`. That assertion
    // was true and is now describing a code path production does not take:
    // `ensureEgressRelay` judges against `relayGatePolicy`, not
    // `policyFromConfig`. Leaving the old test passing would have left a green
    // assertion claiming this gate is circular after the circularity was cut.
    //
    // The old fact, kept because it is WHY the production call had to change:
    // policyFromConfig still agrees with itself by construction.
    const c = cfg("http://host.docker.internal:22/v1");
    expect(() => assertTargetsAllowed([omlxRelayTarget(c)], policyFromConfig(c))).not.toThrow();

    // The new fact: policyFromConfig's `llm` rule tracks base_url's HOST, so
    // routing the relay through it would re-open the circularity through a
    // different field the moment the dial side became configurable. It allows a
    // destination relayGatePolicy refuses.
    const lan = cfg(DEFAULT_BASE_URL, {}, `${LAN_OMLX}:8000`);
    const viaPolicyFromConfig = policyFromConfig({
      ...lan,
      llm: { base_url: `http://${LAN_OMLX}:8000/v1` },
    });
    expect(() => assertTargetsAllowed([omlxRelayTarget(lan)], viaPolicyFromConfig)).not.toThrow();
    expect(() => assertTargetsAllowed([omlxRelayTarget(lan)], relayGatePolicy(lan))).toThrow(
      /refusing to forward/,
    );
  });

  test("a policy built from a DIFFERENT base_url refuses the target — the seam works", () => {
    // The forward-looking case in miniature: policy and target derived from two
    // different sources, which is exactly the shape ISC-259's work creates.
    const target = omlxRelayTarget(cfg("http://host.docker.internal:8000/v1"));
    const otherPolicy = policyFromConfig(cfg("http://host.docker.internal:9999/v1"));
    expect(() => assertTargetsAllowed([target], otherPolicy)).toThrow(/refusing to forward/);
  });

  test("an explicit egress.allow entry is what a decoupled target rides on", () => {
    const target = omlxRelayTarget(cfg("http://host.docker.internal:8000/v1"));
    const policy = policyFromConfig(
      cfg("http://host.docker.internal:9999/v1", {
        allow: [{ host: "host.docker.internal", port: 8000 }],
      }),
    );
    expect(() => assertTargetsAllowed([target], policy)).not.toThrow();
  });
});

describe("the LAN upstream gate — MUTATION PROOF of non-vacuity (ISC-253, ISC-259)", () => {
  /**
   * One config, one knob: `egress.allow`. Everything else — `base_url`,
   * `relay_upstream`, therefore the whole target — is byte-identical between
   * the allowed and refused cases, which is what makes the allow entry the
   * ONLY thing that can account for the difference.
   */
  const lan = (allow: Array<{ host: string; port: number }>) =>
    cfg(DEFAULT_BASE_URL, { allow }, `${LAN_OMLX}:8000`);

  test("PROOF: removing the operator's allow entry is what turns the gate red", () => {
    // This is the assertion ISC-253 has been open across two PRs to obtain, so
    // it is written to leave no other explanation standing.
    const withAllow = lan([{ host: LAN_OMLX, port: 8000 }]);
    const withoutAllow = lan([]);

    // (1) The target is IDENTICAL in both configs. Nothing about what the relay
    //     would dial changes; only the policy does. Without this the refusal
    //     below could be a target-construction difference wearing a policy
    //     costume.
    const target = omlxRelayTarget(withAllow);
    expect(omlxRelayTarget(withoutAllow)).toEqual(target);
    expect(target).toEqual({ listenPort: 8000, host: LAN_OMLX, port: 8000, name: "omlx" });

    // (2) WITH the entry the LAN upstream is ACCEPTED. This is the half that
    //     rules out every other candidate refusal — the base_url host pin, the
    //     upstream parser, port validation, `makeRule`. If any of those were
    //     refusing this config, it could not pass here.
    expect(() => assertTargetsAllowed([target], relayGatePolicy(withAllow))).not.toThrow();

    // (3) Remove ONLY that entry → REFUSED.
    expect(() => assertTargetsAllowed([target], relayGatePolicy(withoutAllow))).toThrow(
      /refusing to forward/,
    );

    // (4) …and refused for the allow-rule reason SPECIFICALLY. `default-deny`
    //     is the verdict `decide()` returns when a destination matched no rule
    //     at all, as opposed to `invalid-host`/`invalid-port`, which would mean
    //     the gate had rejected the target's SHAPE and never consulted the
    //     policy. If the vacuity had merely moved, it would show up here as one
    //     of those two rather than as default-deny.
    expect(() => assertTargetsAllowed([target], relayGatePolicy(withoutAllow))).toThrow(
      /rule: default-deny/,
    );
    expect(() => assertTargetsAllowed([target], relayGatePolicy(withoutAllow))).toThrow(
      /add an explicit egress\.allow entry/,
    );
  });

  test("the allow entry must MATCH — a near miss on host or port is still refused", () => {
    // Otherwise "an allow entry exists" would be the real check rather than
    // "an allow entry covers THIS destination", and any entry would open every
    // destination.
    const target = omlxRelayTarget(lan([]));
    for (const near of [
      { host: LAN_OMLX, port: 8001 }, // right host, wrong port
      { host: "192.168.86.50", port: 8000 }, // wrong host, right port
      { host: "192.168.86.4", port: 8000 }, // a PREFIX of the real host
    ]) {
      expect(() => assertTargetsAllowed([target], relayGatePolicy(lan([near])))).toThrow(
        /rule: default-deny/,
      );
    }
  });

  test("the relay's own listen-side pin cannot be used to smuggle the upstream in", () => {
    // The circularity's other escape route: if `base_url` could name the LAN
    // host, `relayGatePolicy`'s constant-host rule would be operator-steerable
    // after all. It cannot — the listen-side pin refuses it, and the diagnosis
    // points at the field that IS the right one to edit.
    expect(() => omlxRelayTarget(cfg(`http://${LAN_OMLX}:8000/v1`))).toThrow(
      /host\.docker\.internal/,
    );
    expect(() => omlxRelayTarget(cfg(`http://${LAN_OMLX}:8000/v1`))).toThrow(/relay_upstream/);
  });

  test("google_hosts do not authorize a relay target — the relay never forwards them", () => {
    // A rule for traffic that has no live path must not become an allowance for
    // traffic that does.
    const c = cfg(DEFAULT_BASE_URL, { google_hosts: ["oauth2.googleapis.com"] }, "oauth2.googleapis.com:443");
    expect(relayGatePolicy(c).rules.map((r) => r.name)).toEqual(["relay-docker-host"]);
  });

  test("RESIDUAL, STATED: the Docker host at the listen port needs no allow entry", () => {
    // The one destination `relayGatePolicy` authorizes on its own, kept so that
    // every pre-ISC-259 fleet.yaml keeps working with no new config.
    //
    // Bounded by MEASUREMENT, not assumption: SRD §12.8 records that every port
    // on the bridge gateway is already reachable from the deny-all bridge with
    // no relay running at all, so the relay grants no reachability here that the
    // bridge did not already have. That is why this residual is acceptable and
    // the LAN one is not.
    const c = cfg("http://host.docker.internal:22/v1");
    expect(() => assertTargetsAllowed([omlxRelayTarget(c)], relayGatePolicy(c))).not.toThrow();
  });

  test("TIGHTENED: the Docker host at a DIFFERENT port is now refused", () => {
    // A real gain over PR #18, and the case that shows rule 1 is pinned to the
    // listen port rather than to the host. Under the old gate this combination
    // could not even be expressed; under a naive policyFromConfig gate it would
    // have passed.
    const c = cfg(DEFAULT_BASE_URL, {}, "host.docker.internal:22");
    expect(() => assertTargetsAllowed([omlxRelayTarget(c)], relayGatePolicy(c))).toThrow(
      /rule: default-deny/,
    );
    // …and an operator who genuinely means it can still say so, explicitly.
    const allowed = cfg(DEFAULT_BASE_URL, { allow: [{ host: "host.docker.internal", port: 22 }] }, "host.docker.internal:22");
    expect(() => assertTargetsAllowed([omlxRelayTarget(allowed)], relayGatePolicy(allowed))).not.toThrow();
  });
});

describe("ensureEgressRelay applies the gate at the PRODUCTION call site", () => {
  /**
   * Every test above proves `relayGatePolicy` and `assertTargetsAllowed` are
   * correct in isolation. None of them proves `ensureEgressRelay` actually
   * calls THOSE — wiring it back to `policyFromConfig` would leave all of them
   * green while restoring the vacuity. This closes that gap with a fake `exec`
   * that RECORDS rather than runs, so a refusal can be distinguished from a
   * daemon that was never contacted.
   */
  const recordingExec = () => {
    const calls: string[][] = [];
    const exec = async (argv: string[]) => {
      calls.push(argv);
      return { code: 0, stdout: "[]", stderr: "" };
    };
    return { calls, exec: exec as unknown as Parameters<typeof ensureEgressRelay>[2] };
  };

  test("a LAN upstream with no allow entry is refused BEFORE docker is touched", async () => {
    const { calls, exec } = recordingExec();
    await expect(
      ensureEgressRelay(cfg(DEFAULT_BASE_URL, {}, `${LAN_OMLX}:8000`), NET, exec),
    ).rejects.toThrow(/rule: default-deny/);
    // Config and policy first, Docker second: nothing was created, so there is
    // no half-built relay to clean up and no window in which the tunnel existed.
    expect(calls).toEqual([]);
  });

  test("the same config WITH the allow entry gets past the gate and reaches docker", async () => {
    // The paired half: proves the refusal above is the gate's verdict and not
    // an unrelated failure on the way to it.
    const { calls, exec } = recordingExec();
    const allowed = cfg(DEFAULT_BASE_URL, { allow: [{ host: LAN_OMLX, port: 8000 }] }, `${LAN_OMLX}:8000`);
    // It will fail LATER — the fake exec reports an empty inspect and never
    // starts anything — but it must fail somewhere past the policy check.
    await ensureEgressRelay(allowed, NET, exec).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.slice(0, 2)).toEqual(["docker", "inspect"]);
  });
});

describe("relay_upstream parsing (ISC-259)", () => {
  test("an absent upstream reproduces the pre-ISC-259 target exactly", () => {
    // The backward-compatibility claim, asserted rather than asserted-in-prose.
    expect(omlxRelayTarget(cfg(DEFAULT_BASE_URL))).toEqual({
      listenPort: 8000,
      host: RELAY_DEFAULT_DIAL_HOST,
      port: 8000,
      name: "omlx",
    });
    expect(relayUpstreamFor(cfg("http://host.docker.internal:11434/v1"), 11434)).toEqual({
      host: RELAY_DEFAULT_DIAL_HOST,
      port: 11434,
    });
  });

  test("listen port and dial port are now genuinely independent", () => {
    // The decoupling in one assertion: a worker dials 8000 on the alias and the
    // relay dials 9999 on another machine.
    expect(omlxRelayTarget(cfg(DEFAULT_BASE_URL, {}, `${LAN_OMLX}:9999`))).toEqual({
      listenPort: 8000,
      host: LAN_OMLX,
      port: 9999,
      name: "omlx",
    });
  });

  test("a bracketed IPv6 upstream parses; a bare one is refused", () => {
    expect(parseRelayUpstream("[fd00::1]:8000")).toEqual({ host: "fd00::1", port: 8000 });
    // Unbracketed, `fd00::1:8000` is ambiguous — the last colon is part of the
    // address, not a separator — so it must be refused rather than guessed at.
    expect(relayUpstreamError("fd00::1:8000")).toMatch(/host:port/);
  });

  test("a HOSTNAME upstream is refused, with the resolver reason", () => {
    // Measured, not stylistic: Docker's embedded DNS forwards to the host
    // resolver, which on this machine does not answer mDNS/.local names. A name
    // here yields a relay that starts and then fails every connection.
    expect(relayUpstreamError("macbook.local:8000")).toMatch(/IP literal/);
    expect(relayUpstreamError("omlx.example.com:8000")).toMatch(/mDNS/);
    // The Docker-host alias remains legal — it is the default, and `--add-host`
    // resolves it on the uplink.
    expect(relayUpstreamError("host.docker.internal:8000")).toBeNull();
  });

  test("an explicit port is mandatory — nothing is inherited from base_url", () => {
    // Inheriting one would reintroduce exactly the derivation this field exists
    // to break.
    expect(relayUpstreamError(LAN_OMLX)).toMatch(/explicit port/);
    expect(relayUpstreamError(`${LAN_OMLX}:`)).toMatch(/host:port/);
  });

  test("junk that is not a bare host:port is refused, not coerced", () => {
    for (const bad of [
      `http://${LAN_OMLX}:8000`, // a URL, not a host:port
      `${LAN_OMLX}:8000/v1`, // a path
      `user@${LAN_OMLX}:8000`, // credentials
      `${LAN_OMLX}:0`, // out of range
      `${LAN_OMLX}:65536`,
      `${LAN_OMLX}: 8000`, // Number() would accept the space; a port is digits
      `${LAN_OMLX}:0x1f`,
      `${LAN_OMLX}:8e3`,
      "",
    ]) {
      expect(relayUpstreamError(bad)).not.toBeNull();
    }
  });

  test("an upper-case or trailing-dot alias normalizes to the same dial host", () => {
    expect(parseRelayUpstream("HOST.DOCKER.INTERNAL.:8000").host).toBe(RELAY_DEFAULT_DIAL_HOST);
  });
});


describe("relayScriptSha256 — what the relay actually executes (S5/S8)", () => {
  test("hashes the real script this checkout would mount", async () => {
    const hash = await relayScriptSha256();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Same file, same hash — it is a function of bytes on disk, not of when it
    // was called.
    expect(await relayScriptSha256(relayScriptPath())).toBe(hash);
  });

  test("a different file hashes differently — the record can actually detect a swap", async () => {
    // Without this the previous test passes against a constant.
    const other = await relayScriptSha256(
      new URL(import.meta.url).pathname,
    );
    expect(other).not.toBe(await relayScriptSha256());
  });
});

describe("relay docker argv, remaining", () => {
  test("connect uses the alias that makes host.docker.internal resolve for workers", () => {
    // Without `--alias host.docker.internal` the relay is reachable only by
    // container name, and every worker's baked-in `host.docker.internal:8000`
    // fails to resolve at all. This flag IS the mechanism.
    expect(relayConnectArgv(NET, "relay-x")).toEqual([
      "network",
      "connect",
      "--alias",
      "host.docker.internal",
      NET,
      "relay-x",
    ]);
  });

  test("inspect and remove are plain, validated argv", () => {
    expect(relayInspectArgv("relay-x")).toEqual(["inspect", "relay-x"]);
    expect(relayRemoveArgv("relay-x")).toEqual(["rm", "-f", "relay-x"]);
    expect(() => relayInspectArgv("-flag")).toThrow(/name/);
    expect(() => relayRemoveArgv("-flag")).toThrow(/name/);
    expect(() => relayConnectArgv(NET, "-flag")).toThrow(/name/);
  });
});

describe("parseRelayInspect", () => {
  const entry = (over: Record<string, unknown> = {}): string =>
    JSON.stringify([
      { Name: "/relay-x", Id: "abc123", State: { Running: true }, ...over },
    ]);

  test("reads the running bit and the id for a container that exists", () => {
    expect(parseRelayInspect("relay-x", entry())).toEqual({
      name: "relay-x",
      exists: true,
      running: true,
      id: "abc123",
    });
  });

  test("docker's leading-slash name and a bare name both match", () => {
    const bare = JSON.stringify([{ Name: "relay-x", Id: "abc123", State: { Running: true } }]);
    expect(parseRelayInspect("relay-x", bare).exists).toBe(true);
  });

  test("a stopped container exists but is NOT running", () => {
    expect(parseRelayInspect("relay-x", entry({ State: { Running: false } })).running).toBe(false);
  });

  test("an absent or novel Running field reads as NOT running", () => {
    // Strict `=== true`, same direction `parseNetworkInspect` takes with
    // `Internal`: the answer that refuses, never the one that reassures. A
    // daemon dialect we do not understand must not certify a live relay.
    expect(parseRelayInspect("relay-x", entry({ State: {} })).running).toBe(false);
    expect(parseRelayInspect("relay-x", entry({ State: { Running: "true" } })).running).toBe(false);
    expect(parseRelayInspect("relay-x", entry({ State: undefined })).running).toBe(false);
  });

  test("an empty array, or an array naming something else, means absent", () => {
    expect(parseRelayInspect("relay-x", "[]")).toEqual({
      name: "relay-x",
      exists: false,
      running: false,
      id: null,
    });
    expect(parseRelayInspect("relay-x", entry({ Name: "/other" })).exists).toBe(false);
  });

  test("malformed output THROWS rather than reading as absent", () => {
    // Reading a daemon we cannot parse as "no relay here" would send `ensure`
    // into `docker run` on top of whatever is actually there — the same
    // reasoning `parseNetworkInspect` documents.
    expect(() => parseRelayInspect("relay-x", "not json")).toThrow(/unparseable/);
    expect(() => parseRelayInspect("relay-x", '{"Name":"/relay-x"}')).toThrow(/array/);
  });
});
