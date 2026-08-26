#!/usr/bin/env node
"use strict";
/**
 * pifleet HTTP CONNECT proxy (ISC-263; SRD §5.9, §12.4).
 *
 * WHAT THIS EXISTS FOR, stated as the gap it closes rather than as a feature.
 * `egress.google_hosts` rules are matched exhaustively by `decide()` in unit
 * tests, and until this file there was NO live traffic path to
 * `*.googleapis.com` at all — because a Docker network alias cannot be a
 * wildcard, and the existing `egress-relay.cjs` is a per-target PORT FORWARDER
 * that can only carry destinations someone enumerated in advance. So a
 * `cloud_access: true` role on the internal bridge was granted ADC and then
 * could not reach Google, which is a credential handed out for a path that
 * does not exist.
 *
 * WHY CONNECT AND NOT SNI ROUTING. Both were on the table; SNI passthrough was
 * rejected on containment grounds rather than effort. SNI routes on a field
 * the CLIENT controls inside a handshake this process would have to parse
 * without terminating, which makes the allowlist decision a guess about
 * someone else's bytes. A CONNECT proxy is ASKED, in the clear, for a
 * destination — and can refuse it, by name, with a reason, before a single
 * byte is forwarded. The refusal is the product here; the tunnelling is the
 * easy part.
 *
 * THE POLICY IS NOT REIMPLEMENTED HERE. `egress-policy.cjs` is the same
 * matcher `src/security/egress.ts` uses — not a copy of it. The label-boundary
 * rule that separates `storage.googleapis.com` from `evil-googleapis.com` is
 * the single thing in this system least survivable as two implementations, and
 * a proxy that carried its own would be the copy nobody re-reads.
 *
 * WHAT IT REFUSES, and why each refusal is explicit rather than a fallthrough:
 *
 *  - Any method other than CONNECT. This is not a forward proxy for cleartext
 *    HTTP: an absolute-form `GET http://host/path` would put this process in
 *    the business of parsing and re-emitting requests, which is a far larger
 *    surface than splicing a socket, and every destination worth reaching here
 *    is TLS. `405` with the destination unnamed.
 *  - A destination `decide()` denies. `403`, carrying the rule name, so an
 *    operator reading a stalled worker sees `default-deny` rather than a
 *    timeout.
 *  - A request line longer than the header cap, or headers that never
 *    terminate. A client that opens a socket and dribbles bytes forever is the
 *    same leak the relay's idle timeout closes, reached through the parser.
 *
 * Deliberately plain Node with no dependencies and bind-mounted read-only, for
 * the same reasons as `egress-relay.cjs`: the pinned relay image
 * (`src/security/pinned-image.ts`) is upstream `node:24-bookworm-slim` and must
 * not depend on `pifleet image build` having run.
 */

const net = require("node:net");
const { decide } = require("./egress-policy.cjs");

/**
 * Bounds. Every one of these closes a leak that costs the attacker nothing.
 *
 * `MAX_HEADER_BYTES` is the important one: without it, a client that connects
 * and sends `A` forever grows an unbounded string in this process. 8 KiB is
 * generous for `CONNECT host:port HTTP/1.1` plus a couple of headers and is
 * the conventional server limit.
 */
const IDLE_TIMEOUT_MS = Number(process.env.PIFLEET_PROXY_IDLE_TIMEOUT_MS || 120000);
const MAX_CONNECTIONS = Number(process.env.PIFLEET_PROXY_MAX_CONNECTIONS || 256);
const MAX_HEADER_BYTES = Number(process.env.PIFLEET_PROXY_MAX_HEADER_BYTES || 8192);
const HANDSHAKE_TIMEOUT_MS = Number(process.env.PIFLEET_PROXY_HANDSHAKE_TIMEOUT_MS || 15000);

const POLICY_ENV = "PIFLEET_PROXY_POLICY";
const PORT_ENV = "PIFLEET_PROXY_PORT";

/**
 * Parse the policy from the environment.
 *
 * Rules arrive ALREADY NORMALIZED — the host side builds them with `makeRule`,
 * which is the only constructor and which throws on a pattern that could never
 * match. This re-validates shape rather than re-deriving it: a malformed entry
 * here means the container was handed something the host did not build, and
 * the safe response to that is to refuse to start rather than to run with a
 * policy that silently dropped a rule.
 *
 * An EMPTY rule list is accepted and is not a degenerate case — it is a
 * deny-all proxy, which is the correct posture for a fleet with no
 * `cloud_access` role. Refusing to start on empty would push an operator
 * toward not running the proxy at all, and a missing proxy fails as a timeout
 * where a running one fails as a named `403`.
 */
function parsePolicy(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${POLICY_ENV} is not valid JSON: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.rules)) {
    throw new Error(`${POLICY_ENV} must be an object with a "rules" array`);
  }
  parsed.rules.forEach((r, i) => {
    if (
      typeof r !== "object" ||
      r === null ||
      typeof r.name !== "string" ||
      typeof r.host !== "string" ||
      typeof r.port !== "number" ||
      r.name.length === 0 ||
      r.host.length === 0
    ) {
      throw new Error(`${POLICY_ENV}.rules[${i}] is malformed: ${JSON.stringify(r)}`);
    }
  });
  return { rules: parsed.rules };
}

/**
 * Split the CONNECT authority into host and port.
 *
 * CONNECT's target is `host:port` with the port MANDATORY (RFC 9110 §9.3.6),
 * so a missing port is a malformed request and not an invitation to default to
 * 443. Defaulting would mean a policy allowing `example.com:443` silently also
 * served `CONNECT example.com`, which is a destination nobody wrote down.
 *
 * IPv6 literals arrive bracketed (`[::1]:443`); the brackets are kept on the
 * host so `normalizeHost` strips them by the same rule it uses everywhere else.
 */
function splitAuthority(authority) {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null;
    const host = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (!rest.startsWith(":")) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) ? { host, port } : null;
  }
  const cut = authority.lastIndexOf(":");
  if (cut <= 0 || cut === authority.length - 1) return null;
  const host = authority.slice(0, cut);
  const portText = authority.slice(cut + 1);
  // `Number("")` is 0 and `Number("4 4")` is NaN; require digits outright so a
  // port is a port and not whatever coercion makes of it.
  if (!/^[0-9]+$/.test(portText)) return null;
  return { host, port: Number(portText) };
}

/** A minimal, final HTTP response. The socket is destroyed after it drains. */
function refuse(socket, status, reasonPhrase, detail) {
  const body = detail === undefined ? "" : `${detail}\n`;
  const head =
    `HTTP/1.1 ${status} ${reasonPhrase}\r\n` +
    "Proxy-Agent: pifleet-connect-proxy\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n" +
    "\r\n";
  try {
    socket.end(head + body);
  } catch {
    socket.destroy();
  }
}

function log(event, fields) {
  // One JSON object per line on stdout: the host reads these back out of
  // `docker logs` to prove a refusal happened, and a human reading them during
  // an incident should not have to parse prose.
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

/**
 * Start the proxy on an already-validated policy and port.
 *
 * Exported so `egress-relay.cjs` can run it IN-PROCESS rather than as a second
 * container. The two are the same concern — the one sanctioned hole in the
 * deny-all bridge — and the relay container is already dual-homed onto exactly
 * the two networks a CONNECT proxy needs, already carries the hardened posture
 * (`--read-only`, `--cap-drop ALL`, `no-new-privileges`, `ip_forward=0`), and
 * is already adopted, health-checked and drift-checked by `up`. A second
 * container would have duplicated all of that lifecycle to gain no isolation
 * the first one does not already have.
 */
function startProxy(policy, port) {
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    let buffer = "";
    /**
     * THREE states, not two, and conflating the middle one is a real bug this
     * file shipped with until its own test caught it.
     *
     *  - `spliced`     — the request line is parsed and accepted; stop feeding
     *                    bytes to the parser.
     *  - `established` — the upstream connected AND the 200 was written, so the
     *                    socket now belongs to the tunnel.
     *
     * Between them sits the window where the destination was ALLOWED and the
     * upstream has not answered yet. With one flag covering both, the
     * upstream-error branch guarded on `!spliced` and could never run, so an
     * allowed-but-unreachable destination returned an empty socket instead of
     * a 502 — a network fault reported as nothing at all.
     */
    let spliced = false;
    let established = false;
    let upstream = null;
    let torn = false;

    const teardown = () => {
      if (torn) return;
      torn = true;
      client.destroy();
      if (upstream !== null) upstream.destroy();
    };

    // Two different clocks on purpose. The HANDSHAKE timeout bounds how long a
    // client may take to finish its request line; the IDLE timeout bounds a
    // tunnel that has been established and gone quiet. Using one value for
    // both would either let a dribbling client hold a slot for the tunnel
    // lifetime, or cut off a legitimately idle long-lived TLS session.
    client.setTimeout(HANDSHAKE_TIMEOUT_MS, teardown);
    client.on("error", teardown);
    client.on("close", teardown);

    const onData = (chunk) => {
      if (spliced) return;
      buffer += chunk.toString("latin1");
      if (buffer.length > MAX_HEADER_BYTES) {
        log("proxy_refused", { reason: "header_too_large", bytes: buffer.length });
        refuse(client, 431, "Request Header Fields Too Large");
        return;
      }
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;

      const requestLine = buffer.slice(0, buffer.indexOf("\r\n"));
      const parts = requestLine.split(" ");
      if (parts.length !== 3 || parts[0] !== "CONNECT") {
        log("proxy_refused", { reason: "method_not_connect", method: parts[0] || "" });
        refuse(
          client,
          405,
          "Method Not Allowed",
          "this proxy speaks CONNECT only; cleartext forwarding is not offered",
        );
        return;
      }

      const target = splitAuthority(parts[1]);
      if (target === null) {
        log("proxy_refused", { reason: "malformed_authority", authority: parts[1].slice(0, 256) });
        refuse(client, 400, "Bad Request", "CONNECT target must be host:port with an explicit port");
        return;
      }

      /**
       * The decision. Same `decide()` the host side uses — not a copy.
       *
       * Note what is NOT done first: no DNS lookup, no socket, no bytes to the
       * destination. A denied host must not become a DNS query that tells an
       * observer which names a worker tried, and must not cost an upstream
       * connection at all.
       */
      const verdict = decide(target.host, target.port, policy);
      if (!verdict.allowed) {
        log("proxy_refused", {
          reason: "policy",
          rule: verdict.rule,
          host: verdict.host,
          port: verdict.port,
        });
        refuse(client, 403, "Forbidden", `egress denied by rule ${verdict.rule}`);
        return;
      }

      spliced = true;
      // Anything the client pipelined AFTER the blank line belongs to the
      // tunnel and must be forwarded once it opens — dropping it silently
      // corrupts a TLS ClientHello sent in the same packet as the CONNECT.
      const pending = Buffer.from(buffer.slice(end + 4), "latin1");
      buffer = "";

      upstream = net.connect(
        { host: verdict.host, port: verdict.port, allowHalfOpen: true },
        () => {
          client.setTimeout(IDLE_TIMEOUT_MS, teardown);
          upstream.setTimeout(IDLE_TIMEOUT_MS, teardown);
          established = true;
          client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: pifleet-connect-proxy\r\n\r\n");
          if (pending.length > 0) upstream.write(pending);
          client.removeListener("data", onData);
          client.pipe(upstream);
          upstream.pipe(client);
          client.on("end", () => upstream.end());
          upstream.on("end", () => client.end());
          log("proxy_allowed", { rule: verdict.rule, host: verdict.host, port: verdict.port });
        },
      );
      upstream.on("error", (err) => {
        // The destination was ALLOWED and could not be reached. That is a very
        // different fact from a refusal and must not be reported as one, or an
        // operator debugging a network fault goes looking for a policy bug.
        log("proxy_upstream_error", {
          host: verdict.host,
          port: verdict.port,
          code: err.code || "unknown",
        });
        if (!established && !client.destroyed) {
          /**
           * Destroy the UPSTREAM and let the client socket drain.
           *
           * `teardown()` here would call `client.destroy()` immediately, and
           * `refuse` had only just queued the response with `end()` — so the
           * bytes were discarded and the caller saw a silent close. The client
           * is closed by its own `close` handler once the response has gone
           * out, which is what `torn` is there to make idempotent.
           */
          refuse(client, 502, "Bad Gateway");
          upstream.destroy();
          return;
        }
        teardown();
      });
      upstream.on("close", teardown);
    };

    client.on("data", onData);
  });

  server.maxConnections = MAX_CONNECTIONS;
  server.on("error", (err) => {
    process.stderr.write(`pifleet-connect-proxy: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(port, () => {
    log("proxy_listening", { port, rules: policy.rules.length });
  });
  return server;
}

/** Read the policy and port out of the environment, validating both. */
function fromEnv(env) {
  const policy = parsePolicy(env[POLICY_ENV] || '{"rules":[]}');
  const port = Number(env[PORT_ENV] || 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${PORT_ENV} is not a port in 1..65535: ${JSON.stringify(env[PORT_ENV])}`);
  }
  return { policy, port };
}

module.exports = { startProxy, fromEnv, parsePolicy, splitAuthority, POLICY_ENV, PORT_ENV };

// Standalone entry, so this file is directly runnable for tests and for a
// deployment that wants the proxy without the port-forward relay.
if (require.main === module) {
  const { policy, port } = fromEnv(process.env);
  startProxy(policy, port);
}
