#!/usr/bin/env node
"use strict";
/**
 * pifleet egress relay (SRD §5.6, §5.9, §12.4, §12.8; ISC-50, ISC-51, ISC-57).
 *
 * Workers sit on `docker.network` — a Docker `--internal` bridge, which means
 * no default route and no NAT, so nothing OFF THE BRIDGE SUBNET is reachable
 * (`src/security/network.ts`). That is the deny-all default in hardware. This
 * process is the one sanctioned hole in it: it runs on the SAME internal
 * bridge (so workers can reach it) and ALSO on a second, non-internal "uplink"
 * network dedicated to it alone (so it, and only it, can reach
 * `host.docker.internal` — the oMLX server on the Docker host). It forwards
 * exactly the destinations it is told to and nothing else.
 *
 * Read "off the bridge subnet" precisely. `--internal` does NOT deny the
 * bridge GATEWAY: Docker's isolation rules live in the FORWARD chain and the
 * gateway is on-link, so every port the Docker host listens on is reachable
 * from the bridge with or without this relay. That is a measured, accepted
 * residual documented in SRD §12.8 and in `src/security/relay.ts`'s header —
 * not something this process causes, and not something it can fix.
 *
 * `--network-alias host.docker.internal` on the internal bridge is what
 * makes a worker's literal `host.docker.internal:8000` (baked into
 * `models.json` and `llm.base_url`, SRD §5.9) resolve to THIS container
 * instead of failing to resolve at all — measured live on this project's own
 * Colima setup: an `--internal` network's embedded DNS does not otherwise
 * answer that name, with or without `--add-host=host.docker.internal:
 * host-gateway`. This process's OWN outbound leg, by contrast, uses
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
 * That gap is shared with ISC-253 and is recorded in `ISA.md` rather than
 * silently assumed away: this relay proves the oMLX allow rule and the
 * default-deny for everything off the subnet, live; it does not prove live
 * Google reachability.
 *
 * Deliberately plain Node with no dependencies: the worker image's `base`
 * toolchain has no `bun` (only `node`, from the `node:*` base layer itself),
 * and this file is bind-mounted read-only rather than baked into the image,
 * so no image rebuild is needed to change it. The host records a SHA-256 of
 * this file in the `egress_relay_ready` ledger event at launch, because a
 * bind-mount from the operator's working tree is mutable on the host side and
 * `--restart unless-stopped` re-execs whatever is at that path after a reboot.
 * Tested via the Docker-gated integration suite
 * (`test/integration/relay.test.ts`) — the same "shell artifact,
 * integration-tested" shape `docker/verbgate` already has in this repo, for
 * the same reason: its correctness is a property of real Docker networking,
 * which a unit test cannot observe.
 */

const net = require("node:net");

/**
 * Idle sockets are reaped and total concurrency is capped. Neither bound
 * existed before, and the absence was measurable: 300 client connections that
 * sent ZERO bytes took this process from 19 open FDs to 619 (603 TCP
 * sockets), because the upstream used to be dialled on accept rather than on
 * first byte. Each of those was an unauthenticated connection against oMLX,
 * which is a Python server and exhausts long before this process's 1048576
 * nofile — so one unprivileged container on the bridge could deny the whole
 * fleet its model server without sending a single request.
 *
 * The defaults are generous for a dozen workers talking to one inference
 * server, and small enough that the failure mode is a queued connection
 * rather than a wedged daemon. Overridable so a test can drive them hard.
 */
const IDLE_TIMEOUT_MS = Number(process.env.PIFLEET_RELAY_IDLE_TIMEOUT_MS || 120000);
const MAX_CONNECTIONS = Number(process.env.PIFLEET_RELAY_MAX_CONNECTIONS || 256);

/** `1..65535`, mirroring `validPort` in `src/security/relay.ts`. */
function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

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
    // RANGE, not merely type. `typeof === "number"` admits 0, -1, 65536, 3.7
    // and NaN, and `listen(0)` binds a RANDOM port — the relay would come up
    // reporting itself healthy while forwarding on a port no worker can find.
    // The TypeScript side has `validPort`; this file is the trust boundary for
    // the environment variable and carries the rule itself rather than
    // assuming whoever set the variable already applied it.
    if (!validPort(t.listenPort)) {
      throw new Error(
        `PIFLEET_RELAY_TARGETS[${i}].listenPort is not a port in 1..65535: ` +
          JSON.stringify(t.listenPort),
      );
    }
    if (!validPort(t.port)) {
      throw new Error(
        `PIFLEET_RELAY_TARGETS[${i}].port is not a port in 1..65535: ` + JSON.stringify(t.port),
      );
    }
    if (t.host.length === 0) {
      throw new Error(`PIFLEET_RELAY_TARGETS[${i}].host is empty`);
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
      let upstream = null;
      let torn = false;

      const teardown = () => {
        if (torn) return;
        torn = true;
        client.destroy();
        if (upstream !== null) upstream.destroy();
      };

      // Applied to BOTH legs: a client that connects and says nothing, and an
      // upstream that accepts and never answers, are the same leak from
      // opposite ends.
      client.setTimeout(IDLE_TIMEOUT_MS, teardown);
      client.on("error", teardown);
      client.on("close", teardown);

      const dial = () => {
        upstream = net.connect({ host: t.host, port: t.port });
        upstream.setTimeout(IDLE_TIMEOUT_MS, teardown);
        upstream.on("error", teardown);
        upstream.on("close", teardown);
        upstream.on("connect", () => {
          client.pipe(upstream);
          upstream.pipe(client);
          // Half-close is FORWARDED, not treated as teardown. A client FIN
          // used to destroy the upstream outright, discarding an in-flight
          // response — fine for curl, wrong for an HTTP/1.0
          // `Connection: close` exchange where the response arrives after the
          // request side has finished. `close` above still does the teardown.
          client.on("end", () => upstream.end());
          upstream.on("end", () => client.end());
        });
      };

      /**
       * Dial the upstream on the FIRST BYTE, never on accept. This is the fix
       * for the FD measurement in the header: an idle client now costs one
       * socket in this process and ZERO against oMLX.
       *
       * `pause()` until the pipes exist, `once` so a second chunk cannot dial
       * a second upstream, and `unshift` so the byte that triggered the dial
       * is put back for `pipe` rather than dropped on the floor.
       */
      client.pause();
      client.once("data", (chunk) => {
        client.unshift(chunk);
        client.resume();
        if (!torn) dial();
      });
    });

    /**
     * A hard cap so the FD table cannot be exhausted by connection count
     * alone. Node stops ACCEPTING past this; pending connections wait in the
     * kernel backlog rather than being refused, which is what a transient
     * burst wants.
     */
    server.maxConnections = MAX_CONNECTIONS;

    /**
     * Listen failure is FATAL. Everything after it is not.
     *
     * One `process.exit(1)` used to catch both, and this container runs
     * `--restart unless-stopped` — so a single accept-time EMFILE/ENFILE took
     * model access away from every worker in the fleet and put the relay into
     * a crash loop. A relay that cannot bind its port has nothing to offer and
     * should die loudly; a relay that failed one accept should log it and keep
     * serving the connections it already has.
     */
    let listening = false;
    server.on("error", (err) => {
      const where = `0.0.0.0:${t.listenPort} -> ${t.host}:${t.port} (${t.name})`;
      if (!listening) {
        process.stderr.write(`pifleet-egress-relay: listen ${where} failed: ${err.message}\n`);
        process.exit(1);
      }
      process.stderr.write(
        `pifleet-egress-relay: ${where} server error (continuing): ${err.message}\n`,
      );
    });
    server.listen(t.listenPort, "0.0.0.0", () => {
      listening = true;
      process.stdout.write(
        `pifleet-egress-relay: forwarding 0.0.0.0:${t.listenPort} -> ${t.host}:${t.port} (${t.name})\n`,
      );
    });
    return server;
  });

  /**
   * `close()` is asynchronous and stops new accepts without waiting for
   * in-flight connections, so calling it and then `process.exit(0)` on the
   * next line cut them anyway — the call was decoration that read like a
   * graceful drain. Exit directly and say why: a TCP forwarder holds no state
   * worth draining, and the daemon is stopping the container regardless.
   */
  const shutdown = () => {
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // Returned so the listeners stay referenced for the life of the process.
  return servers;
}

main();
