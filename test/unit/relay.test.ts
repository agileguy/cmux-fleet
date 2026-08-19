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
import {
  omlxRelayTarget,
  parseRelayInspect,
  relayConnectArgv,
  relayContainerName,
  relayInspectArgv,
  relayRemoveArgv,
  relayRunArgv,
  uplinkNetworkName,
  RELAY_IMAGE,
  RELAY_SCRIPT_CONTAINER_PATH,
  RELAY_UPSTREAM_HOST,
  type RelayTarget,
} from "../../src/security/relay.ts";

const NET = "pifleet-egress";

describe("omlxRelayTarget", () => {
  test("derives the forward from llm.base_url's port — never a hardcoded 8000", () => {
    // The schema default. `listenPort` and `port` are deliberately the SAME
    // number: a worker's baked-in `host.docker.internal:8000` must arrive at
    // the relay on 8000 and leave for the real host on 8000, or the alias
    // trick resolves to a container listening somewhere else.
    expect(omlxRelayTarget({ llm: { base_url: "http://host.docker.internal:8000/v1" } })).toEqual({
      listenPort: 8000,
      host: RELAY_UPSTREAM_HOST,
      port: 8000,
      name: "omlx",
    });
  });

  test("a non-default port is carried through both legs", () => {
    expect(omlxRelayTarget({ llm: { base_url: "http://host.docker.internal:11434/v1" } })).toEqual({
      listenPort: 11434,
      host: RELAY_UPSTREAM_HOST,
      port: 11434,
      name: "omlx",
    });
  });

  test("an absent port defaults by protocol, exactly as policyFromConfig does", () => {
    // Mirroring `policyFromConfig`'s rule rather than inventing a second one:
    // the policy and the relay must agree about which port is being allowed,
    // and two independent defaults are how they drift apart.
    expect(omlxRelayTarget({ llm: { base_url: "http://host.docker.internal/v1" } }).port).toBe(80);
    expect(omlxRelayTarget({ llm: { base_url: "https://host.docker.internal/v1" } }).port).toBe(443);
  });

  test("a trailing-dot or upper-case spelling of the host is still the host", () => {
    // Normalized through the same `normalizeHost` the policy matcher uses, so
    // `HOST.DOCKER.INTERNAL.` cannot read as "some other host" and get refused
    // while the policy happily allows it.
    expect(
      omlxRelayTarget({ llm: { base_url: "http://HOST.DOCKER.INTERNAL.:8000/v1" } }).host,
    ).toBe(RELAY_UPSTREAM_HOST);
  });

  test("REFUSES a base_url pointing anywhere other than the Docker host", () => {
    // This relay is single-purpose. A target built for `10.0.0.5:8000` would
    // be forwarded from a listener that no worker can ever reach, because the
    // only name aliased onto the internal bridge is `host.docker.internal` —
    // so the fleet would report a working relay and every worker would fail to
    // resolve its model server. Refusing loudly is the only honest answer.
    expect(() => omlxRelayTarget({ llm: { base_url: "http://10.0.0.5:8000/v1" } })).toThrow(
      /host\.docker\.internal/,
    );
    expect(() => omlxRelayTarget({ llm: { base_url: "http://localhost:8000/v1" } })).toThrow(
      /host\.docker\.internal/,
    );
  });

  test("an unparseable base_url throws rather than yielding a targetless relay", () => {
    expect(() => omlxRelayTarget({ llm: { base_url: "not a url" } })).toThrow(/not a URL/);
  });

  test("a port outside the TCP range is refused, not silently listened on", () => {
    // `listen(0)` means "any free port" to node, which would come up healthy
    // and forward nothing a worker could find.
    expect(() => omlxRelayTarget({ llm: { base_url: "http://host.docker.internal:0/v1" } })).toThrow(
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
    { listenPort: 8000, host: RELAY_UPSTREAM_HOST, port: 8000, name: "omlx" },
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
