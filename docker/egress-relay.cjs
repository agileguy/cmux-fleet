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
 * Deliberately NOT a general-purpose forward proxy. The TCP forwarder below
 * forwards only the literal (host, port) pairs it is configured with —
 * currently the oMLX endpoint alone. `src/security/egress.ts`'s `decide()`
 * already carries allow rules for the configured Google endpoints
 * (`egress.google_hosts`), and routing arbitrary `*.googleapis.com`
 * subdomains through a relay needs either wildcard DNS aliasing (Docker
 * network aliases don't support wildcards) or an HTTP CONNECT proxy.
 *
 * CORRECTED 2026-08-30 (documentation audit): this paragraph used to end
 * "neither is built here". The CONNECT proxy has since been built and is
 * loaded by THIS FILE — see `require("./connect-proxy.cjs")` below, ISC-263 —
 * so the sentence had been false since that landed, in the one place a reader
 * goes to find out what the relay does. What remains true is the split of
 * responsibility: the forwarder proves the oMLX allow rule and the
 * default-deny for everything off the subnet, live; the CONNECT proxy carries
 * the Google hosts under the same `decide()` policy. Wildcard DNS aliasing is
 * still not built, and is no longer needed.
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
const { startProxy, fromEnv, POLICY_ENV } = require("./connect-proxy.cjs");

/**
 * Idle sockets are reaped and total concurrency is capped. Neither bound
 * existed before, and the absence was measurable: 300 client connections that
 * sent ZERO bytes took this process from 19 open FDs to 619 (603 TCP
 * sockets), because the upstream used to be dialled on accept rather than on
 * first byte. Each of those was an unauthenticated connection against oMLX,
 * which is a Python server and exhausts long before this process's 1048576
 * nofile — so one unprivileged container on the bridge could deny the whole
 * fleet its model server without sending a single request. That measurement
 * is why the PRE-dial phase below stays short: a connection that has sent
 * nothing has no legitimate reason to sit open, and the fix is to reap it
 * fast — not to widen the window a zero-byte flood gets to live in.
 *
 * TWO PHASES, not one, since 2026-09-15. A worker's model turn was
 * `terminated` exactly 120 s after its request went out: a large context sent
 * to a shared local model server, where a long prefill streams no bytes back
 * while it runs. The short timeout is right for a connection that has said
 * nothing; it is wrong for one that HAS spoken and is waiting on a slow but
 * legitimate answer. So: before the first byte there is no upstream leg
 * yet — only the client socket exists, and it alone is bounded by the SHORT
 * `PIFLEET_RELAY_IDLE_TIMEOUT_MS` (unchanged — it is still what closes the
 * zero-byte-flood case above). Once that first byte triggers the dial, BOTH
 * legs move to the LONG `PIFLEET_RELAY_ACTIVE_IDLE_TIMEOUT_MS`. That bound
 * applies to every relayed target and every role that speaks through this
 * relay, not only observer tasks — the observer tasks' own 900 s deadline is
 * only where the number came from, as the sizing reference, so the relay
 * never kills a request they could still use.
 *
 * ONE-BYTE RESIDUAL, left open by this change. A single byte ends the short
 * phase, so a client that sends one byte and then goes silent now holds a
 * relay slot — and a dialled upstream socket — for ACTIVE_IDLE_TIMEOUT_MS
 * (900 s) instead of the previous 120 s. One container doing that across
 * MAX_CONNECTIONS connections on one listener can hold every slot that long.
 * The trigger was already possible before this change — a client could
 * always send one byte and go quiet — but the hold time is now 7.5x longer
 * (900000 / 120000). No per-source connection cap is added in this change to
 * bound how many slots one container can occupy this way; that stays an open
 * follow-up.
 *
 * The CONNECT proxy (`connect-proxy.cjs`, SSH and Google traffic) is
 * SEPARATE and UNCHANGED by either constant below: its own
 * `PIFLEET_PROXY_IDLE_TIMEOUT_MS` stays at 120000.
 *
 * The defaults are generous for a dozen workers talking to one inference
 * server. Measured under real Node 24: a connection past MAX_CONNECTIONS is
 * not queued and not refused at the TCP level — see the note above
 * `server.maxConnections` below for the measurement. Overridable so a test
 * can drive them hard.
 *
 * `IDLE_TIMEOUT_MS`, `ACTIVE_IDLE_TIMEOUT_MS` and `MAX_CONNECTIONS` used to be
 * `Number(process.env.X || default)` with only an `isInteger && > 0` check.
 * That check's failure modes are NOT one failure. Each was measured
 * separately under real Node 24.21.0:
 *
 * - A bad `PIFLEET_RELAY_IDLE_TIMEOUT_MS` (e.g. `"abc"`, `"-5"`) crashes on
 *   CONNECT, before any byte — `client.setTimeout(IDLE_TIMEOUT_MS, teardown)`
 *   runs at accept, in the PRE-DIAL phase below. Measured: a client that
 *   connects and sends nothing still brings the relay down.
 * - A bad `PIFLEET_RELAY_ACTIVE_IDLE_TIMEOUT_MS` crashes only once the FIRST
 *   BYTE arrives — it feeds the `dial()` leg, reached only from
 *   `client.once("data", ...)`. Measured: a connect-only client leaves the
 *   relay running; a client that writes one byte brings it down. Both throw
 *   `RangeError [ERR_OUT_OF_RANGE]` from `socket.setTimeout()`, uncaught —
 *   nothing wraps the connection handler — so either one takes down the
 *   WHOLE PROCESS (every other in-flight connection, every target), and
 *   `--restart unless-stopped` turns that into a crash loop.
 * - `server.maxConnections = NaN | negative`, BY CONTRAST, does not throw at
 *   all. `NaN` silently disables the cap: every connection was accepted and
 *   served normally in the measurement. A negative value instead refuses
 *   every connection from the first one on: the server emits a `'drop'`
 *   event and closes the client unserved, while the relay process itself
 *   stays up.
 * - `"0"` is a truthy STRING, so it became the NUMBER `0` — `isInteger && >
 *   0` rejects that today, but the bare `Number(raw || fallback)` shape this
 *   file had before even that check existed would have silently disabled
 *   the bound instead of erroring (measured: `socket.setTimeout(0, cb)`
 *   does not throw — Node treats `0` as "no timeout").
 *
 * A separate, non-crashing failure mode: `Number()` coerces far more than
 * plain integers. `"1e3"`, `" 5"`, `"\t7\n"`, `"0x10"` and `"5.0"` all pass
 * `isInteger && > 0` and were silently accepted. Worse, so does
 * `"2147483648"` — and `socket.setTimeout()`'s own ceiling is a signed
 * 32-bit integer (libuv's timer duration); going over it does not throw, it
 * WARNS and truncates. Measured: `socket.setTimeout(2147483648, cb)` prints
 * `TimeoutOverflowWarning: 2147483648 does not fit into a 32-bit signed
 * integer. Timer duration was truncated to 2147483647.` to stderr, and the
 * connection stays open with its timer silently capped at 2147483647 ms
 * (~24.86 days) — so an oversized `PIFLEET_RELAY_IDLE_TIMEOUT_MS` would not
 * fail loudly, it would just turn the zero-byte-flood guard into a
 * ~24.86-day hold.
 *
 * Validated here, before anything listens, against both failure classes.
 * `raw` must match `^[1-9][0-9]*$` — a plain decimal integer: no sign, no
 * decimal point, no exponent, no leading zero, and (the anchors alone rule
 * this out — nothing is trimmed first) no leading or trailing whitespace.
 * The resulting number must also sit inside a hard ceiling: `MAX_TIMEOUT_MS`
 * (2147483647) for the two timeouts — the same signed 32-bit ceiling
 * `socket.setTimeout()` itself silently truncates to, so this now fails at
 * startup instead of at runtime — and `MAX_RELAY_CONNECTIONS` (65536) for
 * `MAX_CONNECTIONS`: comfortably under this process's own 1048576-file
 * nofile limit even though each ACTIVE relayed connection costs 2 FDs
 * (client leg + upstream leg), and far larger than any fleet this relay is
 * sized for (default 256). An invalid value — either class — writes one
 * `pifleet-egress-relay:` line naming the variable, the accepted form, and
 * the range, then exits non-zero — the same fatal style as the
 * `server.on("error", ...)` listen failure below. An unset (or empty)
 * variable still gets its default.
 */
const MAX_TIMEOUT_MS = 2147483647; // 2^31 - 1: socket.setTimeout()'s own signed-32-bit ceiling — see measurement above.
const MAX_RELAY_CONNECTIONS = 65536; // sane ceiling for MAX_CONNECTIONS — see measurement above (FD budget + fleet sizing).
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

function positiveIntEnv(name, fallback, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!POSITIVE_INT_RE.test(raw) || value > max) {
    process.stderr.write(
      `pifleet-egress-relay: ${name} must be a plain positive decimal integer ` +
        `in 1..${max} (digits only — no sign, decimal point, exponent, leading ` +
        `zero, or whitespace), got ${JSON.stringify(raw)}\n`,
    );
    process.exit(1);
  }
  return value;
}

const IDLE_TIMEOUT_MS = positiveIntEnv("PIFLEET_RELAY_IDLE_TIMEOUT_MS", 120000, MAX_TIMEOUT_MS);
const ACTIVE_IDLE_TIMEOUT_MS = positiveIntEnv(
  "PIFLEET_RELAY_ACTIVE_IDLE_TIMEOUT_MS",
  900000,
  MAX_TIMEOUT_MS,
);
const MAX_CONNECTIONS = positiveIntEnv(
  "PIFLEET_RELAY_MAX_CONNECTIONS",
  256,
  MAX_RELAY_CONNECTIONS,
);

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
    /**
     * `allowHalfOpen: true` is load-bearing, not a tuning knob.
     *
     * With the default (`false`), Node ends the WRITABLE side of a socket as
     * soon as it receives a FIN, so the socket closes outright and
     * `client.on("close")` fires — tearing the upstream down mid-response.
     * That means forwarding half-close is impossible to express at all: an
     * `on("end", () => upstream.end())` handler is correct and still never
     * gets the chance to matter, because the socket is already gone.
     *
     * Both legs opt in, and the idle timeouts above are what stop a socket
     * that half-closes and never finishes from lingering forever.
     */
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      let upstream = null;
      let torn = false;

      const teardown = () => {
        if (torn) return;
        torn = true;
        client.destroy();
        if (upstream !== null) upstream.destroy();
      };

      // PRE-DIAL phase: the short timeout. A client that connects and says
      // nothing is the zero-byte-flood case in the header, and there is no
      // upstream leg yet to bound alongside it. Re-armed to the long ACTIVE
      // timeout — for this leg AND the upstream leg — the instant the first
      // byte triggers a dial, below.
      client.setTimeout(IDLE_TIMEOUT_MS, teardown);
      client.on("error", teardown);
      client.on("close", teardown);

      const dial = (firstChunk) => {
        // ACTIVE phase begins here: the client has said something, so
        // teardown moves off the short DoS-guarding clock and onto the long
        // one the header describes. Duration only, no callback — `teardown`
        // is already registered as a one-time 'timeout' listener from the
        // PRE-dial `client.setTimeout(IDLE_TIMEOUT_MS, teardown)` call above,
        // and it is still armed (it has not fired). `socket.setTimeout(ms,
        // cb)` calls `once('timeout', cb)` on every invocation that passes a
        // callback, so passing `teardown` again here would stack a SECOND
        // listener for the same event; both would run — harmlessly, since
        // `teardown` is idempotent on `torn` — but there is no reason to
        // carry a listener that adds nothing. Passing no callback just resets
        // the timer's duration and leaves the existing listener in place.
        client.setTimeout(ACTIVE_IDLE_TIMEOUT_MS);

        // `allowHalfOpen` on THIS leg too, for the mirror-image reason: when
        // the upstream finishes its response and sends FIN, the default would
        // close our socket outright and take with it anything the client still
        // owed. Because Node no longer auto-destroys either socket, the `close`
        // handlers do the teardown explicitly — that is the trade
        // `allowHalfOpen` makes, not an oversight to be tidied away.
        upstream = net.connect({ host: t.host, port: t.port, allowHalfOpen: true });
        upstream.setTimeout(ACTIVE_IDLE_TIMEOUT_MS, teardown);
        upstream.on("error", teardown);
        upstream.on("close", teardown);
        upstream.on("connect", () => {
          // The bytes that triggered the dial go out FIRST, then the live
          // stream. Writing the chunk and only then piping is what keeps the
          // request intact; `unshift`-ing it before any pipe exists races the
          // rest of the request into the void.
          upstream.write(firstChunk);
          client.pipe(upstream);
          upstream.pipe(client);
          // `pipe` resumes the client itself; this is belt and braces for
          // bytes that arrived while the dial was in flight.
          client.resume();
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
       * `once` so a second chunk cannot dial a second upstream, and `pause()`
       * INSIDE the handler — never before it. Calling `pause()` first sets
       * `flowing = false`, and attaching a `data` listener does not undo that,
       * so the handler never fires and every connection deadlocks until the
       * client gives up. A version of this file shipped exactly that bug and
       * the integration suite caught it: the deny half still passed while
       * `models=` came back empty.
       */
      client.once("data", (chunk) => {
        client.pause();
        if (!torn) dial(chunk);
      });
    });

    /**
     * A hard cap so the FD table cannot be exhausted by connection count
     * alone. MEASURED under real Node 24 (2026-09-14), not assumed: with
     * `MAX_CONNECTIONS=2` and a 3rd client connecting, the 3rd client's TCP
     * handshake still completes — its `connect` event fired with no
     * measurable delay (0 ms in the run that produced these numbers) — and
     * Node then destroyed that socket about 1 ms later, before a single byte
     * crossed it; a write attempted right after failed because the socket
     * was already destroyed. It is NOT held pending in the kernel accept
     * backlog — freeing a slot by closing one of the first two connections
     * did not revive it, it stayed destroyed — and it is NOT refused at the
     * TCP level either, since the handshake completes. So the failure mode
     * this cap produces for the `(cap+1)`th connection is
     * accept-then-instant-close, not a queued connection and not a refusal.
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

  /**
   * The CONNECT proxy, in this same process (ISC-263).
   *
   * Started only when a policy is configured, and the absence is a real state
   * rather than a degraded one: a fleet with no `cloud_access` role has no
   * business running a proxy that accepts arbitrary destinations, and the
   * host side omits the variable entirely in that case.
   *
   * IN-PROCESS rather than a second container because this container is
   * already the one sanctioned hole in the deny-all bridge — dual-homed onto
   * the internal bridge and the NAT'd uplink, under `--read-only`,
   * `--cap-drop ALL`, `no-new-privileges` and `ip_forward=0`. A separate
   * container would duplicate that entire lifecycle to gain no isolation.
   *
   * A failure to start is FATAL rather than logged and continued. The proxy
   * existing but denying everything and the proxy not existing at all are very
   * different diagnoses — one is a 403 naming a rule, the other a connection
   * refused — and a relay that silently came up without its proxy would hand a
   * `cloud_access` worker the second while the operator believed the first.
   */
  let proxyServer = null;
  if (typeof process.env[POLICY_ENV] === "string") {
    const { policy, port } = fromEnv(process.env);
    proxyServer = startProxy(policy, port);
  }

  // Returned so the listeners stay referenced for the life of the process.
  return { servers, proxyServer };
}

main();
