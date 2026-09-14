#!/usr/bin/env node
"use strict";
/**
 * `docker/ssh-connect.cjs` — the ProxyCommand every observer SSH call runs
 * (SRD-OBSERVER-ROLES §5.2 task 3.1; SRD §12.4).
 *
 * WHAT THIS EXISTS FOR. OpenSSH has no native CONNECT support and the image
 * carries no `nc`/`socat` (`docker/Dockerfile:48-49`), so `observe-ssh`'s
 * `ProxyCommand` is this file, invoked exactly as `node
 * /opt/pifleet/ssh-connect.cjs %h %p`. It is asked for `<host> <port>` on
 * argv, and its whole job is turning that into one `CONNECT` request against
 * `HTTPS_PROXY` and, once the proxy answers `200`, disappearing — stdin
 * becomes the tunnel's write side, stdout becomes its read side, and every
 * byte SSH itself would have written to a raw socket goes through unmodified.
 *
 * WHAT IT IS NOT. It does not re-implement `egress-policy.cjs`'s allow/deny
 * decision — `docker/connect-proxy.cjs`, on the other end of `HTTPS_PROXY`,
 * has already made that call before this file does anything. This file's only
 * decisions are whether ITS OWN INPUTS (argv and the environment) are
 * well-formed enough to attempt the CONNECT at all, and whether the proxy's
 * answer was `200`.
 *
 * THE THROWAWAY VERSION THIS REPLACES. `scripts/observe/characterise-ssh-transport`
 * (task 3.0) carries an inline `CONNECT_CLIENT` that measured the round trip
 * against a real proxy on 2026-09-14 (`test/fixtures/observe/ssh-transport-facts.json`,
 * `proxy_command.round_trips: true`) and nothing else: no argument validation
 * (`new URL(undefined)` throws an uncaught, contextless `TypeError`), an
 * unbounded header read, and a refusal line written to stderr that never
 * reaches an operator because that script's whole container is thrown away
 * the moment it exits. This file keeps the measured round trip and adds every
 * refusal SSH itself cannot supply: OpenSSH turns ANY non-zero ProxyCommand
 * exit into the same opaque `kex_exchange_identification: Connection closed
 * by remote host`, so the rule name a `403` carries
 * (`docker/connect-proxy.cjs:257-265`) has to reach stderr HERE or it never
 * reaches anyone at all.
 *
 * WHY THE HEADER READ IS BOUNDED. A proxy that answers and a proxy that
 * dribbles bytes forever without a `\r\n\r\n` look identical to a naive reader
 * right up until one of them runs the process out of memory.
 * `docker/connect-proxy.cjs` bounds the same shape of read at 8 KiB
 * (`MAX_HEADER_BYTES`, its own docblock); the number is mirrored rather than
 * imported, because this file must stay plain Node with no dependencies — it
 * is bind-mounted into every worker image the same way `connect-proxy.cjs` is
 * bind-mounted into the relay, and `require("./connect-proxy.cjs")` would tie
 * a client's startup to a proxy module it has no other reason to load.
 *
 * WHY EXIT IS NEVER FORCED WHILE OUTPUT MAY STILL BE QUEUED. `process.stdout`
 * and `process.stderr` write ASYNCHRONOUSLY to a pipe on POSIX (Node's own
 * documentation for `process.stdout`), and this script's stdout IS a pipe in
 * production — the far end is `ssh`'s own read of its ProxyCommand's stdout.
 * Every exit path below sets `process.exitCode` and tears down the handles
 * that are still open (the socket, stdin's flowing state) rather than calling
 * `process.exit()`: Node only exits once the event loop is empty, which is
 * exactly once every queued write has actually left the process. A forced
 * `process.exit()` here would truncate exactly the bytes item 2 exists to
 * deliver — the proxy's refusal line — or the tail of a legitimate tunnel.
 */

const net = require("node:net");

/** Mirrors `connect-proxy.cjs`'s own cap on an unterminated response header. */
const MAX_HEADER_BYTES = 8192;

/** Write a diagnostic this script generated itself (not the proxy's own text). */
function say(message) {
  process.stderr.write(`ssh-connect: ${message}\n`);
}

/**
 * `HTTPS_PROXY` as `src/run/worker-env.ts:1016` sets it: an `http://host:port`
 * URL. Returns `null` for anything that is not one, including an empty or
 * missing value — the caller reports WHY rather than letting `new
 * URL(undefined)` throw an uncaught `TypeError` with no context an operator
 * reading a stalled worker can act on.
 */
function parseProxyUrl(raw) {
  if (raw === undefined || raw === "") return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: url.hostname, port };
}

/**
 * A CONNECT target port: digits only, in range. The same rule
 * `connect-proxy.cjs`'s `splitAuthority` applies to the destination it
 * receives — `Number("")` is `0` and `Number("4 4")` is `NaN`, so digits are
 * required outright rather than trusting coercion.
 */
function parsePort(text) {
  if (text === undefined || !/^[0-9]+$/.test(text)) return null;
  const port = Number(text);
  if (port < 1 || port > 65535) return null;
  return port;
}

function main() {
  const [host, portArg] = process.argv.slice(2);

  // Refused before anything is opened: a malformed request never costs an
  // upstream connection, DNS query, or byte on the wire — the same posture
  // `connect-proxy.cjs` takes on the other end of this same CONNECT.
  if (host === undefined || host === "") {
    say("missing host argument (usage: ssh-connect.cjs <host> <port>)");
    process.exitCode = 1;
    return;
  }
  const port = parsePort(portArg);
  if (port === null) {
    say(`port must be an integer in 1..65535, got ${JSON.stringify(portArg ?? null)}`);
    process.exitCode = 1;
    return;
  }
  const proxy = parseProxyUrl(process.env.HTTPS_PROXY);
  if (proxy === null) {
    say(`HTTPS_PROXY must be an http(s) URL with a host, got ${JSON.stringify(process.env.HTTPS_PROXY ?? null)}`);
    process.exitCode = 1;
    return;
  }

  let torn = false;
  let spliced = false;
  // Accumulates the proxy's response. Before `headerEnd` is known this is the
  // in-progress header (bounded below); once known, further bytes on a
  // non-200 response are the refusal BODY, collected so the full text — not
  // whatever fit in the first TCP read — reaches stderr.
  let head = Buffer.alloc(0);
  let headerEnd = -1;

  const socket = net.connect({ host: proxy.hostname, port: proxy.port, allowHalfOpen: true });

  const teardown = () => {
    if (torn) return;
    torn = true;
    socket.destroy();
  };

  /** A failure this script is reporting about ITSELF, not the proxy's own response. */
  const abort = (message) => {
    say(message);
    process.exitCode = 1;
    teardown();
  };

  socket.on("error", (err) => {
    abort(spliced ? `tunnel connection error: ${err.message}` : `proxy connection failed: ${err.message}`);
  });

  socket.on("connect", () => {
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });

  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    if (headerEnd === -1) {
      if (head.length > MAX_HEADER_BYTES) {
        abort(`proxy response header exceeded ${MAX_HEADER_BYTES} bytes without reaching the blank line that ends it`);
        return;
      }
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      headerEnd = end + 4;

      const statusLine = head.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      const status = statusLine.split(" ")[1];

      if (status === "200") {
        spliced = true;
        // Anything the proxy wrote AFTER its header in the same read belongs
        // to the tunnel — the target sshd answering fast enough to land in
        // the same TCP segment as the `200`. Dropping it would corrupt the
        // first bytes of the SSH protocol exchange.
        const pending = head.subarray(headerEnd);
        head = Buffer.alloc(0);
        socket.removeListener("data", onData);
        if (pending.length > 0) process.stdout.write(pending);
        socket.pipe(process.stdout);
        // `{ end: false }`: we end the socket ourselves, below, rather than
        // letting `.pipe()`'s default do it — see why immediately after.
        process.stdin.pipe(socket, { end: false });
        // stdin ending (ssh closed its write side) half-closes the tunnel:
        // `allowHalfOpen: true` above means our own `end()` sends a FIN
        // without also giving up on reading whatever the target still has to
        // send. MEASURED rather than assumed, and the measurement is why this
        // is a `setTimeout`, not `.pipe()`'s own end-of-source handling: when
        // `process.stdin` is already fully written and closed by the time it
        // is piped here — exactly what a short-lived observer dispatch looks
        // like — calling `socket.end()` synchronously (or from the SAME
        // libuv turn: `process.nextTick`, `setImmediate`, or a write's own
        // completion callback were all tried) intermittently lost bytes the
        // target had already sent back, even with `allowHalfOpen: true`: 0/15
        // for each of those against a real loopback socket in this shape;
        // 15/15 once `end()` waits for one full event-loop turn (Node
        // v24.3.0, this repo's `docker/connect-proxy.cjs` is unaffected only
        // because its two ends are live sockets that are never this
        // synchronous). A zero-delay timer still runs through libuv's poll
        // phase before firing, which is the turn that matters here — it is
        // not a race against the clock, so 0 is not a number to "tune".
        process.stdin.on("end", () => setTimeout(() => socket.end(), 0));
        return;
      }
      // Non-200: fall through and keep accumulating — `refuse()` on the proxy
      // side (`connect-proxy.cjs:144-157`) writes `Connection: close`, so the
      // rest of the body (if any did not arrive in this same read) follows
      // shortly and the proxy sends FIN.
    }
  };
  socket.on("data", onData);

  // The proxy's FIN, before we ever spliced. `allowHalfOpen: true` means OUR
  // writable side does not auto-close in response — by design, so a target
  // that keeps talking after a `200` is never cut off. A refusal never asked
  // us to write anything, so there is nothing to keep the write side open
  // FOR: without this, the socket sits half-open forever (we read their FIN,
  // they never read ours) and `close` — where the refusal is actually
  // reported below — never fires at all.
  socket.on("end", () => {
    if (!spliced) socket.end();
  });

  socket.on("close", () => {
    if (torn) return; // already reported via `abort()`
    if (spliced) {
      // The tunnel ended cleanly. Stop reading stdin (nothing left to forward
      // to) and let Node exit once the stdout writes above have actually
      // drained — see the docblock on why this is never a forced `process.exit()`.
      process.stdin.unpipe(socket);
      process.stdin.pause();
      process.exitCode = 0;
      return;
    }
    if (headerEnd === -1) {
      abort("proxy closed the connection before sending a complete response header");
      return;
    }
    // The refusal, in full: the status line AND the body naming the rule
    // (`connect-proxy.cjs:257-265`) — an operator reading a failed dispatch
    // must see WHY, not just that it failed.
    const statusLine = head.subarray(0, head.indexOf("\r\n\r\n")).toString("latin1").split("\r\n")[0] ?? "";
    const body = head.subarray(headerEnd).toString("latin1");
    process.stderr.write(`${statusLine}\n`);
    if (body.length > 0) process.stderr.write(body.endsWith("\n") ? body : `${body}\n`);
    process.exitCode = 1;
  });
}

main();
