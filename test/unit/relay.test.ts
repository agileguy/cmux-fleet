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
  omlxRelayTarget,
  parseRelayInspect,
  relayConnectArgv,
  relayContainerName,
  relayInspectArgv,
  relayRemoveArgv,
  relayRunArgv,
  relayScriptPath,
  relayScriptSha256,
  uplinkNetworkName,
  RELAY_DIAL_HOST,
  RELAY_IMAGE,
  RELAY_LISTEN_ALIAS,
  RELAY_SCRIPT_CONTAINER_PATH,
  type RelayTarget,
} from "../../src/security/relay.ts";

const NET = "pifleet-egress";

/**
 * A full `RelayConfigView` (= `EgressConfigView`). The relay now judges its own
 * targets with `decide()`, so it needs the `egress` half of the config too —
 * a view wide enough to build a target but too narrow to build the policy that
 * judges it is exactly how the two used to drift apart.
 */
function cfg(base_url: string, egress?: Partial<{ google_hosts: string[]; allow: Array<{ host: string; port: number }> }>) {
  return {
    llm: { base_url },
    egress: {
      google_hosts: egress?.google_hosts ?? ["oauth2.googleapis.com"],
      allow: egress?.allow ?? [],
    },
  };
}

describe("omlxRelayTarget", () => {
  test("derives the forward from llm.base_url's port — never a hardcoded 8000", () => {
    // The schema default. `listenPort` and `port` are deliberately the SAME
    // number: a worker's baked-in `host.docker.internal:8000` must arrive at
    // the relay on 8000 and leave for the real host on 8000, or the alias
    // trick resolves to a container listening somewhere else.
    expect(omlxRelayTarget(cfg("http://host.docker.internal:8000/v1"))).toEqual({
      listenPort: 8000,
      host: RELAY_DIAL_HOST,
      port: 8000,
      name: "omlx",
    });
  });

  test("a non-default port is carried through both legs", () => {
    expect(omlxRelayTarget(cfg("http://host.docker.internal:11434/v1"))).toEqual({
      listenPort: 11434,
      host: RELAY_DIAL_HOST,
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
    ).toBe(RELAY_DIAL_HOST);
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
    { listenPort: 8000, host: RELAY_DIAL_HOST, port: 8000, name: "omlx" },
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
    expect(relayRunArgv("relay-x", "uplink-x", targets, "/repo/docker/egress-relay.js")).toEqual([
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
      "/repo/docker/egress-relay.js:/relay/egress-relay.js:ro",
      "-e",
      'PIFLEET_RELAY_TARGETS=[{"listenPort":8000,"host":"host.docker.internal","port":8000,"name":"omlx"}]',
      "--entrypoint",
      "node",
      RELAY_IMAGE,
      RELAY_SCRIPT_CONTAINER_PATH,
    ]);
  });

  test("an empty target list is refused — a relay that forwards nothing is a lie", () => {
    expect(() => relayRunArgv("relay-x", "uplink-x", [], "/repo/docker/egress-relay.js")).toThrow(
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
      host: RELAY_DIAL_HOST,
      port: 22,
      name: "omlx",
    };
    expect(() => assertTargetsAllowed([rogue], policy)).toThrow(/refusing to forward/);
    expect(() => assertTargetsAllowed([rogue], policy)).toThrow(/egress policy denies/);
  });

  test("DOCUMENTED VACUITY: the gate does not catch a bad port in llm.base_url today", () => {
    // This is the honest half of S13 and it must not be quietly implied away.
    //
    // `policyFromConfig` derives its `llm` rule from THE SAME `llm.base_url`
    // that `omlxRelayTarget` derives the target from, with the same port rule.
    // So a `base_url` of `http://host.docker.internal:22/v1` builds an allow
    // rule for port 22 and then passes the target against it. The agreement is
    // a coincidence of shared derivation, NOT a check, and this test pins that
    // fact so nobody reads the gate as protection it does not yet provide.
    //
    // What bounds this today is `omlxRelayTarget`'s HOST pin: the worst case is
    // a port on the Docker host, a machine the operator already controls — and
    // which, per SRD §12.8, is reachable from the bridge gateway anyway, so the
    // relay adds no reachability the bridge did not already have.
    //
    // That bound disappears when the dial side is decoupled to reach an
    // off-host oMLX (ISC-259). At that point the target must be judged against
    // an explicit `egress.allow` entry the operator WROTE, not against a rule
    // re-derived from the same field. Landing the seam now makes that a change
    // of input rather than a change of design.
    const c = cfg("http://host.docker.internal:22/v1");
    expect(() => assertTargetsAllowed([omlxRelayTarget(c)], policyFromConfig(c))).not.toThrow();
  });

  test("a policy built from a DIFFERENT base_url refuses the target — the seam works", () => {
    // The forward-looking case in miniature: policy and target derived from two
    // different sources, which is exactly the shape ISC-259's work creates.
    const target = omlxRelayTarget(cfg("http://host.docker.internal:8000/v1"));
    const otherPolicy = policyFromConfig(cfg("http://host.docker.internal:9999/v1"));
    expect(() => assertTargetsAllowed([target], otherPolicy)).toThrow(/refusing to forward/);
  });

  test("an explicit egress.allow entry is what a decoupled target would ride on", () => {
    const target = omlxRelayTarget(cfg("http://host.docker.internal:8000/v1"));
    const policy = policyFromConfig(
      cfg("http://host.docker.internal:9999/v1", {
        allow: [{ host: "host.docker.internal", port: 8000 }],
      }),
    );
    expect(() => assertTargetsAllowed([target], policy)).not.toThrow();
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
