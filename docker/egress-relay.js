#!/usr/bin/env node
"use strict";
/**
 * pifleet egress relay (SRD §5.6, §5.9, §12.4; ISC-50, ISC-51, ISC-57).
 *
 * Workers sit on `docker.network` — a Docker `--internal` bridge, which means
 * no default route and no NAT, so nothing off that bridge is reachable at
 * all (`src/security/network.ts`). That is the deny-all default in hardware.
 * This process is the one sanctioned hole in it: it runs on the SAME
 * internal bridge (so workers can reach it) and ALSO on a second, non-
 * internal "uplink" network dedicated to it alone (so it, and only it, can
 * reach `host.docker.internal` — the oMLX server on the Docker host). It
 * forwards exactly the destinations it is told to and nothing else; workers
 * never get a route to anything but this process.
 *
 * `--network-alias host.docker.internal` on the internal bridge is what
 * makes a worker's literal `host.docker.internal:8000` (baked into
 * `models.json` and `llm.base_url`, SRD §5.9) resolve to THIS container
 * instead of failing to resolve at all — measured live on this project's own
 * Colima setup: an `--internal` network's embedded DNS does not otherwise
 * answer that name, with or without `--add-host=host.docker.internal:
 * host-gateway` (the gateway resolves, but nothing routes to it — internal
 * means internal). This process's OWN outbound leg, by contrast, uses
 * `--add-host=host.docker.internal:host-gateway` on its non-internal uplink
 * network, which IS reliable (Docker's documented, portable mechanism —
 * unlike the automatic `/etc/hosts` injection some Docker Desktop builds
 * perform on ordinary bridges, which this project's Colima setup was
 * measured NOT to provide consistently).
 *
 * Deliberately NOT a general-purpose forward proxy. It forwards only the
 * literal (host, port) pairs it is configured with — currently the oMLX
 * endpoint alone. `src/security/egress.ts`'s `decide()` already carries
 * allow rules for the configured Google endpoints (`egress.google_hosts`),
 * but routing arbitrary `*.googleapis.com` subdomains through a relay needs
 * either wildcard DNS aliasing (Docker network aliases don't support
 * wildcards) or an HTTP CONNECT/SNI-routing proxy — neither is built here.
 * That gap is shared with ISC-253 ("a relay consults decide() for live
 * traffic") and is recorded in `ISA.md` rather than silently assumed away:
 * this relay proves the oMLX allow rule and the default-deny for everything
 * else, live; it does not prove live Google reachability.
 *
 * Deliberately plain Node with no dependencies: the worker image's `base`
 * toolchain has no `bun` (only `node`, from the `node:*` base layer itself),
 * and this file is bind-mounted read-only rather than baked into the image,
 * so no image rebuild is needed to change it. Tested only via the
 * Docker-gated integration suite (`test/integration/relay.test.ts`) — the
 * same "shell artifact, integration-tested" shape `docker/verbgate` already
 * has in this repo, for the same reason: its correctness is a property of
 * real Docker networking, which a unit test cannot observe.
 */

const net = require("node:net");

/**
 * `PIFLEET_RELAY_TARGETS` — a JSON array of `{listenPort, host, port, name}`.
 * Kept as a small, explicit, fully-specified list rather than inferred from
 * anything else the container can see: a relay that forwards more than it
 * was told to is the exact failure this file exists to prevent.
 */
function parseTargets(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PIFLEET_RELAY_TARGETS is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("PIFLEET_RELAY_TARGETS must be a JSON array");
  }
  return parsed.map((t, i) => {
    if (
      typeof t !== "object" ||
      t === null ||
      typeof t.listenPort !== "number" ||
      typeof t.host !== "string" ||
      typeof t.port !== "number" ||
      typeof t.name !== "string"
    ) {
      throw new Error(`PIFLEET_RELAY_TARGETS[${i}] is malformed: ${JSON.stringify(t)}`);
    }
    return t;
  });
}

function main() {
  const raw = process.env.PIFLEET_RELAY_TARGETS || "[]";
  const targets = parseTargets(raw);
  if (targets.length === 0) {
    process.stderr.write("pifleet-egress-relay: no forwarding targets configured — exiting\n");
    process.exit(1);
  }

  const servers = targets.map((t) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: t.host, port: t.port });
      let piped = false;
      const cleanup = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on("connect", () => {
        piped = true;
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", cleanup);
      client.on("error", cleanup);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      // A client that hangs up before the upstream connects leaves nothing
      // to clean up on the `connect` handler above.
      client.on("close", () => {
        if (!piped) upstream.destroy();
      });
    });
    server.on("error", (err) => {
      process.stderr.write(
        `pifleet-egress-relay: listen 0.0.0.0:${t.listenPort} -> ${t.host}:${t.port} (${t.name}) failed: ${err.message}\n`,
      );
      process.exit(1);
    });
    server.listen(t.listenPort, "0.0.0.0", () => {
      process.stdout.write(
        `pifleet-egress-relay: forwarding 0.0.0.0:${t.listenPort} -> ${t.host}:${t.port} (${t.name})\n`,
      );
    });
    return server;
  });

  const shutdown = () => {
    for (const s of servers) s.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
