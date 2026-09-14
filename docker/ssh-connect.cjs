#!/usr/bin/env node
"use strict";
/**
 * `docker/ssh-connect.cjs` — the ProxyCommand every observer SSH call runs
 * (SRD-OBSERVER-ROLES §5.2; §12, Phase 3, task 3.1).
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
 * WHY THE HOST IS VALIDATED HERE TOO. `observe-ssh` only ever passes a host
 * its `is_host` accepted, but this file interpolates `%h` straight into the
 * CONNECT request line and the `Host` header, and anything can run it. A CR or
 * LF in the host would add header lines of the caller's choosing; a space or
 * `/` would change what the proxy parses as the authority. So the host must
 * have the shape `is_host` enrols, checked before any socket is opened. A bare
 * IPv6 literal (`::1`) passes and is sent UNBRACKETED, as `CONNECT ::1:22`:
 * `connect-proxy.cjs`'s `splitAuthority` splits that at its last `:`, and
 * bracketing it here would change the host string the egress policy judges.
 *
 * WHAT `HTTPS_PROXY` MAY BE, AND WHAT OF IT IS EVER PRINTED. Only an
 * `http://host:port` URL, the shape `src/run/worker-env.ts` sets. `https:` is
 * refused because this client never speaks TLS to the proxy: it would send its
 * CONNECT in plaintext to a port expecting a handshake. No other scheme names a
 * proxy it can talk to. Both are refused before any lookup or connection. A
 * value containing `@` is refused outright: no `http://host:port` has one, the
 * fleet's proxy takes no credentials and this client sends none, and parsers
 * disagree about where userinfo ends (`http://user:1234\@host` hides it from
 * the WHATWG parser, which reads `user` as the host and `1234` as the port). A
 * refusal never repeats the value or anything parsed from it: stderr reaches
 * the worker's transcript, and a value that does not parse may carry
 * credentials in a form no check here recognises. An IPv6 literal's brackets,
 * which `URL.hostname` keeps, are removed before `net.connect`, which would
 * otherwise look `[fd00::1]` up as a name.
 *
 * WHAT OPENS THE TUNNEL, AND WHY THE PROXY'S TEXT IS ESCAPED. Only a status
 * line matching `^HTTP/1\.[01] 200( |$)` opens it. Anything else, a `200` in
 * the wrong field included, is reported as a refusal. That report puts the
 * proxy's own status line and body on ssh's stderr, and from there into the
 * worker's transcript, so a broken or hostile proxy could otherwise write
 * terminal escape sequences or a bare CR there. Every C0 control but tab and
 * LF, DEL, and every C1 control is shown as `\xNN`. C1 is included because the
 * response is decoded as latin1, which turns the bytes 0x80-0x9f, the 8-bit
 * CSI among them, into those code points. An honest refusal is printable ASCII
 * and prints unchanged.
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
 * reaches anyone at all. That holds however the refusal's connection ends —
 * a close, a reset, or not at all — so every one of those paths prints it.
 *
 * WHY THE RESPONSE READ IS BOUNDED, AND WHAT THE BOUND COUNTS. A proxy that
 * answers and a proxy that dribbles bytes forever without a `\r\n\r\n` look
 * identical to a naive reader right up until one of them runs the process out
 * of memory. So the response header, its blank line included, must END within
 * its first `MAX_HEADER_BYTES`, the 8 KiB `docker/connect-proxy.cjs` uses for
 * its own `MAX_HEADER_BYTES`. The blank line is searched for BEFORE size is
 * judged, and only within that window: after a `200`, the target sshd's first
 * bytes can arrive in the same read as the header, and those are tunnel data,
 * however many there are. Judging the whole read would refuse a healthy tunnel
 * for being fast. A non-`200` response's body is kept only to print, so it is
 * bounded too (`MAX_BODY_BYTES`), and the rest is never read.
 *
 * WHY THE RESPONSE IS ALSO BOUNDED IN TIME, AND WHY THAT BOUND HAS NO KNOB. A
 * byte bound does nothing about a proxy that sends no bytes: a relay that
 * accepts the connection and wedges, or a refusal with no `Content-Length`
 * on a connection that is never closed, would hold ssh forever with nothing on
 * stderr. So the proxy has `RESPONSE_TIMEOUT_MS` (30 s), from the moment the
 * connection is attempted, to finish answering; the deadline is cleared the
 * moment a `200` opens the tunnel, so it never limits a tunnel. 30 s is twice
 * the fleet proxy's own handshake timeout (`HANDSHAKE_TIMEOUT_MS`, 15 s of
 * client inactivity, which runs until the upstream connects), so a healthy
 * relay has always answered or dropped the connection before this fires. It
 * is a constant rather than an environment variable on purpose: this process
 * inherits the worker's environment through ssh, and a variable read here
 * could be set by anything running in the worker. The unit tests shorten it
 * from outside instead, by scaling timers in a wrapper that `require`s this
 * file.
 *
 * HOW THE PROCESS ENDS ONCE THE TUNNEL IS OPEN. ssh keeps its ProxyCommand's
 * stdin open for the whole session, and learns the tunnel has ended only when
 * this process's stdout reaches EOF, which is when this process exits. So
 * stdin closing can never be what ends it. The far side's FIN (the proxy's
 * 120 s idle teardown, or its `upstream.on("end")` when the target's sshd goes
 * away) exits 0 once every byte already received has been handed to stdout; a
 * reset exits 1 with one `ssh-connect:` line; and ssh closing its end of stdout
 * (EPIPE) exits 1 with one line, not the unhandled-`'error'` stack trace Node
 * would otherwise print onto ssh's stderr.
 *
 * WHY NOTHING IS `require`d BUT NODE BUILT-INS. This file runs alone:
 * `docker/Dockerfile` COPYs just this one file into the worker image, at
 * `/opt/pifleet/ssh-connect.cjs`. `connect-proxy.cjs` is not in that image at
 * all; it reaches the relay container by bind mount
 * (`PROXY_SCRIPT_CONTAINER_PATH` in `src/security/relay.ts`). A
 * `require("./connect-proxy.cjs")` would therefore throw `MODULE_NOT_FOUND` on
 * every call, which is why the 8 KiB figure is mirrored rather than imported.
 *
 * WHY EXIT IS NEVER FORCED WHILE OUTPUT MAY STILL BE QUEUED. `process.stdout`
 * and `process.stderr` write ASYNCHRONOUSLY to a pipe on POSIX (Node's own
 * documentation for `process.stdout`), and this script's stdout IS a pipe in
 * production — the far end is `ssh`'s own read of its ProxyCommand's stdout.
 * Every exit path below sets `process.exitCode` and tears down the handles
 * that are still open (the socket, stdin's flowing state, the deadline timer)
 * rather than calling `process.exit()`: Node only exits once the event loop is
 * empty, which is exactly once every queued write has actually left the
 * process. A forced `process.exit()` here would truncate exactly the bytes
 * this file exists to deliver when the proxy refuses (SRD-OBSERVER-ROLES §5.2)
 * — the proxy's refusal line — or the tail of a legitimate tunnel.
 */

const net = require("node:net");

/** The response header, blank line included, must end within this many bytes. Mirrors `connect-proxy.cjs`. */
const MAX_HEADER_BYTES = 8192;

/** At most this much of a non-200 response's body is read and printed. */
const MAX_BODY_BYTES = 8192;

/**
 * How long the proxy has, from the connection attempt, to finish answering
 * the CONNECT. Twice `connect-proxy.cjs`'s 15 s handshake timeout; cleared
 * when the tunnel opens. Deliberately not configurable (see the docblock).
 */
const RESPONSE_TIMEOUT_MS = 30_000;

/**
 * `docker/observe-ssh`'s `is_host`: `[A-Za-z0-9.:-]`, the first character a
 * letter, digit or `:`, at most 253 characters. Spelled out as ASCII classes,
 * and anchored with a `$` that in JavaScript (no `m` flag) matches only at the
 * very end, never before a trailing newline.
 */
const HOST_SHAPE = /^[A-Za-z0-9:][A-Za-z0-9.:-]{0,252}$/;

/** The only status lines that open the tunnel (see the docblock). */
const TUNNEL_OPEN_STATUS = /^HTTP\/1\.[01] 200( |$)/;

/** Write a diagnostic this script generated itself (not the proxy's own text). */
function say(message) {
  process.stderr.write(`ssh-connect: ${message}\n`);
}

/**
 * The proxy's own text, made safe for ssh's stderr: every C0 control but tab
 * and LF, DEL, and every C1 control shown as `\xNN` (see the docblock).
 */
function printable(text) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * `HTTPS_PROXY` as `src/run/worker-env.ts` sets it: an `http://host:port` URL.
 * Returns `{ hostname, port }`, or `{ refusal }` naming what is wrong without
 * repeating the value (see the docblock), including for an empty or missing
 * one, so the caller never lets `new URL(undefined)` throw an uncaught
 * `TypeError` an operator reading a stalled worker cannot act on.
 */
function parseProxyUrl(raw) {
  if (raw === undefined || raw === "") {
    return { refusal: "HTTPS_PROXY is not set; it must be an http://host:port URL" };
  }
  if (raw.includes("@")) {
    return {
      refusal:
        "HTTPS_PROXY must not carry credentials (anything before an '@'): this client sends none and the " +
        "fleet's proxy takes none. The value is not repeated here",
    };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { refusal: "HTTPS_PROXY must be an http://host:port URL, and its value does not parse as a URL" };
  }
  if (url.protocol !== "http:") {
    return {
      refusal:
        "HTTPS_PROXY must be an http:// URL, and its scheme is not http:. https: is not supported: this client " +
        "never speaks TLS to the proxy, so it would send its CONNECT in plaintext to a port expecting a TLS handshake",
    };
  }
  const bracketed = url.hostname.startsWith("[") && url.hostname.endsWith("]");
  const hostname = bracketed ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === "" ? 80 : Number(url.port);
  if (hostname === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { refusal: "HTTPS_PROXY must be an http://host:port URL with a host and a port in 1..65535" };
  }
  return { hostname, port };
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

/**
 * A non-200 response's `Content-Length`, or `null` when its header does not
 * say where the body ends: no such header, a `Transfer-Encoding` (which
 * overrides it), or two that disagree. Only ever used to stop waiting early;
 * `null` leaves the close, the body bound, or the deadline to end the read.
 */
function parseContentLength(headerText) {
  let length = null;
  for (const line of headerText.split("\r\n").slice(1)) {
    if (/^transfer-encoding:/i.test(line)) return null;
    const match = /^content-length:[ \t]*([0-9]{1,15})[ \t]*$/i.exec(line);
    if (match === null) continue;
    const value = Number(match[1]);
    if (length !== null && length !== value) return null;
    length = value;
  }
  return length;
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
  if (!HOST_SHAPE.test(host)) {
    // The value is not echoed: it may hold the very CR/LF this refuses.
    say(
      `host must be [A-Za-z0-9.:-], starting with a letter, digit or ':', at most 253 characters ` +
        `(the shape observe-ssh enrols); got ${host.length} character(s) that are not`,
    );
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
  if ("refusal" in proxy) {
    say(proxy.refusal);
    process.exitCode = 1;
    return;
  }

  let torn = false;
  let spliced = false;
  let connected = false;
  let stdoutFailed = false;
  // Accumulates the proxy's response. Before `headerEnd` is known this is the
  // in-progress header (bounded by MAX_HEADER_BYTES); once known, further bytes
  // on a non-200 response are the refusal BODY (bounded by MAX_BODY_BYTES),
  // collected so the rule text — not whatever fit in the first TCP read —
  // reaches stderr.
  let head = Buffer.alloc(0);
  let headerEnd = -1;
  let contentLength = null;

  const socket = net.connect({ host: proxy.hostname, port: proxy.port, allowHalfOpen: true });

  /**
   * Stop forwarding stdin. ssh never closes it while the session lives, so a
   * stdin still flowing into a dead tunnel is what would keep this process
   * running after the tunnel is gone. Before the splice it was never read.
   */
  const releaseStdin = () => {
    if (!spliced) return;
    process.stdin.unpipe(socket);
    process.stdin.pause();
  };

  const teardown = () => {
    if (torn) return;
    torn = true;
    clearTimeout(deadline);
    releaseStdin();
    socket.destroy();
  };

  /** A failure this script is reporting about ITSELF, not the proxy's own response. */
  const abort = (message) => {
    say(message);
    process.exitCode = 1;
    teardown();
  };

  /**
   * The proxy's refusal: the status line AND the body naming the rule
   * (`connect-proxy.cjs:257-265`) — an operator reading a failed dispatch must
   * see WHY, not just that it failed. The ONLY way a refusal is finished, so
   * every path that ends one (close, error, body bound, `Content-Length`
   * reached, deadline) prints it, and `teardown()`'s `torn` makes that once.
   */
  const endRefusal = (note) => {
    const statusLine = printable(head.subarray(0, headerEnd - 4).toString("latin1").split("\r\n")[0] ?? "");
    const body = printable(head.subarray(headerEnd).toString("latin1"));
    process.stderr.write(`${statusLine}\n`);
    if (body.length > 0) process.stderr.write(body.endsWith("\n") ? body : `${body}\n`);
    if (note !== undefined) say(note);
    process.exitCode = 1;
    teardown();
  };

  /** ssh closed its end of our stdout (EPIPE, most often): one line, not Node's stack trace. */
  const onStdoutError = (err) => {
    if (stdoutFailed) return;
    stdoutFailed = true;
    say(`cannot write the tunnel to stdout (${err.code || err.message}); closing the tunnel`);
    process.exitCode = 1;
    teardown();
  };

  const onDeadline = () => {
    if (torn || spliced) return;
    const seconds = RESPONSE_TIMEOUT_MS / 1000;
    if (headerEnd === -1) {
      abort(
        `no complete response header from the proxy within ${seconds} s ` +
          `(${connected ? "it accepted the connection" : "it never accepted the connection"})`,
      );
      return;
    }
    endRefusal(`proxy neither closed the connection nor finished its response within ${seconds} s; stopped reading`);
  };
  const deadline = setTimeout(onDeadline, RESPONSE_TIMEOUT_MS);

  socket.on("error", (err) => {
    if (torn) return;
    if (headerEnd !== -1 && !spliced) {
      // A complete refusal header arrived before the error (a proxy that
      // resets instead of closing). The refusal is why the CONNECT failed;
      // the reset after it adds nothing an operator needs.
      endRefusal();
      return;
    }
    abort(spliced ? `tunnel connection error: ${err.message}` : `proxy connection failed: ${err.message}`);
  });

  socket.on("connect", () => {
    connected = true;
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });

  const onData = (chunk) => {
    if (torn) return;
    head = Buffer.concat([head, chunk]);
    if (headerEnd === -1) {
      // The terminator first, and only inside the window: bytes past a
      // terminated header are not header bytes (see the docblock). A
      // terminator that ENDS past the window is still over the cap, which is
      // why the search is not over the whole of `head`.
      const end = head.subarray(0, MAX_HEADER_BYTES).indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_HEADER_BYTES) {
          abort(`proxy response header exceeded ${MAX_HEADER_BYTES} bytes without reaching the blank line that ends it`);
        }
        return;
      }
      headerEnd = end + 4;

      const headerText = head.subarray(0, end).toString("latin1");
      const statusLine = headerText.split("\r\n")[0] ?? "";

      if (TUNNEL_OPEN_STATUS.test(statusLine)) {
        spliced = true;
        clearTimeout(deadline);
        // Anything the proxy wrote AFTER its header in the same read belongs
        // to the tunnel — the target sshd answering fast enough to land in
        // the same TCP segment as the `200`. Dropping it would corrupt the
        // first bytes of the SSH protocol exchange.
        const pending = head.subarray(headerEnd);
        head = Buffer.alloc(0);
        socket.removeListener("data", onData);
        process.stdout.on("error", onStdoutError);
        if (pending.length > 0) process.stdout.write(pending);
        socket.pipe(process.stdout);
        // `{ end: false }`: we end the socket ourselves, below, rather than
        // letting `.pipe()`'s default do it — see why immediately after.
        process.stdin.pipe(socket, { end: false });
        // stdin ending (ssh closed its write side) half-closes the tunnel:
        // `allowHalfOpen: true` above means our own `end()` sends a FIN
        // without also giving up on reading whatever the target still has to
        // send. The `end()` waits for a zero-delay timer, and this is what
        // was measured about that, and where. The first measurement (bytes
        // the target had already sent back lost in 15 of 15 runs with a
        // synchronous `end()`, `process.nextTick`, `setImmediate` or a write
        // callback, and in 0 of 15 behind the timer, with stdin already
        // closed when piped) was taken with a `node` that reported v24.3.0
        // and was in fact Bun's `node` wrapper, not Node. Re-measured in the
        // Phase 3 review: under real Node 24.19.0 (`node:24-bookworm-slim`,
        // the runtime this file ships in) a synchronous `end()` lost nothing
        // in 20 of 20 runs; under Bun's wrapper it lost bytes in 20 of 20.
        // The timer stays because it costs nothing on Node and keeps a
        // Bun-hosted run, such as this repo's unit tests on a development
        // machine, from losing the tail. Why Bun loses those bytes, and why
        // the timer avoids it there, was not established.
        process.stdin.on("end", () => setTimeout(() => socket.end(), 0));
        return;
      }
      // Non-200. `refuse()` on the proxy side (`connect-proxy.cjs:144-157`)
      // sends `Content-Length` and `Connection: close`, so its body is
      // complete once that many bytes are in, without waiting for the FIN.
      // Without a usable `Content-Length`, the close, the body bound or the
      // deadline ends the read.
      contentLength = parseContentLength(headerText);
    }
    const bodyBytes = head.length - headerEnd;
    if (contentLength !== null && contentLength <= MAX_BODY_BYTES) {
      if (bodyBytes >= contentLength) {
        head = head.subarray(0, headerEnd + contentLength);
        endRefusal();
      }
      return;
    }
    // A non-200 body, bounded. Past the bound, print what was kept and stop
    // reading: the rule line comes first in every body `refuse()` writes.
    if (bodyBytes > MAX_BODY_BYTES) {
      head = head.subarray(0, headerEnd + MAX_BODY_BYTES);
      endRefusal(`proxy response body exceeded ${MAX_BODY_BYTES} bytes; the rest was not read`);
    }
  };
  socket.on("data", onData);

  socket.on("end", () => {
    if (spliced) {
      // The far side has finished sending: the proxy's idle teardown, or the
      // target's sshd going away. `'end'` is emitted only once every byte
      // received has gone through the pipe into stdout, and stdout's queued
      // writes keep the process alive until they drain. Nothing is left for
      // ssh to read, so the tunnel is over, whatever stdin is doing. Destroy
      // rather than `end()`: a FIN from our side can wait behind unflushed
      // stdin bytes for a reader that is no longer reading.
      releaseStdin();
      socket.destroy();
      return;
    }
    // The proxy's FIN, before we ever spliced. `allowHalfOpen: true` means OUR
    // writable side does not auto-close in response — by design, so a target
    // that keeps talking after a `200` is never cut off. A refusal never asked
    // us to write anything, so there is nothing to keep the write side open
    // FOR: without this, the socket sits half-open forever (we read their FIN,
    // they never read ours) and `close` — where the refusal is actually
    // reported below — never fires at all.
    socket.end();
  });

  socket.on("close", () => {
    if (torn) return; // already reported via `abort()`, `endRefusal()` or the stdout error
    if (spliced) {
      // The tunnel ended cleanly. Stop reading stdin (nothing left to forward
      // to) and let Node exit once the stdout writes above have actually
      // drained — see the docblock on why this is never a forced `process.exit()`.
      releaseStdin();
      process.exitCode = 0;
      return;
    }
    if (headerEnd === -1) {
      abort("proxy closed the connection before sending a complete response header");
      return;
    }
    endRefusal();
  });
}

main();
