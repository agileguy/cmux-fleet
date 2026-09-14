/**
 * `docker/ssh-connect.cjs` — the ProxyCommand SSH runs (SRD-OBSERVER-ROLES
 * §5.2 task 3.1).
 *
 * NO REAL PROXY, deliberately, and no Docker: an in-process fake CONNECT
 * server on loopback, following the same shape as
 * `test/integration/connect-proxy.test.ts` uses for the proxy's own suite.
 * The fake server distinguishes scenarios by the `host:port` the script
 * embeds in its CONNECT line — the exact thing `ssh-connect.cjs` sends
 * unmodified from argv — so one listener serves every case below and the
 * argv the script receives never has to name a real destination.
 *
 * `docker/connect-proxy.cjs`'s own `refuse()` is the model for the fake
 * server's refusal response: a status line, `Connection: close`, and a body
 * naming the rule (`connect-proxy.cjs:144-157`, `:257-265`) — because the
 * whole point of printing a refusal (SRD-OBSERVER-ROLES §5.2, task 3.1) is
 * that text surviving to stderr.
 *
 * The same paths under the Node the worker image ships are in
 * `test/integration/ssh-connect-node.test.ts`: the `node` these tests spawn is
 * whatever is on PATH, which on a development Mac is Bun's wrapper.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateBudget } from "../support/budget.ts";

/** `fileURLToPath`, not `.pathname`: a checkout path with a space or `%` stays percent-encoded in `.pathname`. */
const SCRIPT = fileURLToPath(new URL("../../docker/ssh-connect.cjs", import.meta.url));

/**
 * Can this host listen on the IPv6 loopback? Probed once, before any test is
 * defined, so the IPv6 test can skip itself by name on a host without `::1`
 * and say so, rather than fail for a reason that has nothing to do with the
 * script.
 */
async function ipv6LoopbackProbe(): Promise<string | null> {
  const s = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, "::1", () => resolve());
    });
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? String(err);
  } finally {
    await new Promise<void>((res) => (s.listening ? s.close(() => res()) : res()));
  }
}
const IPV6_UNAVAILABLE = await ipv6LoopbackProbe();
if (IPV6_UNAVAILABLE !== null) {
  console.warn(
    `[skip] the IPv6 proxy-literal test needs an IPv6 loopback, and this host has none: ` +
      `listening on ::1 failed with ${IPV6_UNAVAILABLE}.`,
  );
}

let fake: Server;
let fakePort = 0;
let connections = 0;
/** The same fake CONNECT server on `::1`, for the bracketed-literal test. Unset when the host has no IPv6 loopback. */
let fake6: Server | undefined;
let fake6Port = 0;
let connections6 = 0;

/**
 * Status lines the fake server answers with, keyed by the host the client
 * asks for, each followed by a blank line and `BANNER`, then a close. Only the
 * `open` ones may start a tunnel: the script accepts exactly
 * `^HTTP/1\.[01] 200( |$)`.
 */
const STATUS_LINES: Record<string, { line: string; open: boolean }> = {
  "status-http10.test": { line: "HTTP/1.0 200 Connection established", open: true },
  "status-nophrase.test": { line: "HTTP/1.1 200", open: true },
  "status-xyz.test": { line: "XYZ 200 whatever", open: false },
  "status-prefixed.test": { line: "XHTTP/1.1 200 OK", open: false },
  "status-http2.test": { line: "HTTP/2 200 OK", open: false },
  "status-http110.test": { line: "HTTP/1.10 200 OK", open: false },
  "status-lower.test": { line: "http/1.1 200 OK", open: false },
  "status-2000.test": { line: "HTTP/1.1 2000 OK", open: false },
};

/**
 * A refusal carrying terminal controls in its status line and body, sent as
 * these exact bytes: ESC sequences (a screen clear, a window-title set), BEL,
 * CR, NUL, DEL and the 8-bit CSI byte, around a tab and a final LF, which are
 * the two controls that pass through.
 */
const CONTROL_STATUS = "HTTP/1.1 403 Forbidden\x1b[2J\x07";
const CONTROL_BODY = "egress denied\x1b]0;owned\x07 by rule\r default-deny\x00\x7f\x9b31m\ttabbed\n";
/** What stderr must read for that refusal: every control but tab and LF shown as `\xNN`. */
const CONTROL_STDERR =
  "HTTP/1.1 403 Forbidden\\x1b[2J\\x07\n" + "egress denied\\x1b]0;owned\\x07 by rule\\x0d default-deny\\x00\\x7f\\x9b31m\ttabbed\n";
/** The request line of the most recent CONNECT the fake server received. */
let lastRequestLine = "";
/** Server-side sockets still open, so a hung child's connection can be cut before it is killed. */
const openSockets = new Set<Socket>();

/** Tunnel bytes the far side sends and then closes on: 4 MiB, position-revealing. */
const BULK = Buffer.from(Array.from({ length: 4 * 1024 * 1024 }, (_, i) => 65 + (i % 26)));

/** The banner a fake target sshd sends straight after the `200`. */
const BANNER = "SSH-2.0-fake\r\n";

/**
 * Time scaling for the response deadline. `ssh-connect.cjs` waits 30 s for
 * the proxy, and no test should wait that long, so the deadline tests run the
 * script through `scaled-timers.cjs`: a wrapper that divides every timer delay
 * of 1 s or more by `TIME_SCALE`, then `require`s the script with
 * `process.argv` shaped exactly as `node ssh-connect.cjs <host> <port>` would
 * shape it. The script itself carries no knob for this — nothing in the worker
 * environment can shorten or stretch the production deadline. The zero-delay
 * `setTimeout` on the stdin-end path is below the threshold and untouched.
 */
const TIME_SCALE = 60;
const WRAPPER_SOURCE = `"use strict";
const [, , factorText, script, ...rest] = process.argv;
const factor = Number(factorText);
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 1000 ? ms / factor : ms, ...args);
process.argv = [process.argv[0], script, ...rest];
require(script);
`;

let workDir = "";
let wrapper = "";
/** A script that prints the sorted names of its environment, for the test that pins `childEnv`. */
let envProbe = "";
/**
 * What `node` actually is for the child. On this repo's development Macs it is
 * Bun's `node` wrapper; in CI and inside the worker image it is real Node, and
 * the two differ on the socket paths below (see the reset test).
 */
let childRuntime: "node" | "bun" = "node";

/**
 * A second fake proxy, for the cases that need a real RST. It is a
 * `Bun.listen` server because the test process is always Bun, and on Bun
 * 1.3.11 and 1.3.12 `node:net`'s `resetAndDestroy()` sends a FIN (a real-Node
 * client sees `end`), while `Bun.listen`'s `terminate()` sends a reset (the
 * same client sees `ECONNRESET`). Measured with a Node 24.19.0 client.
 */
let resetProxy: Bun.TCPSocketListener<undefined>;
const resetSockets = new Set<Bun.Socket<undefined>>();

/**
 * Tunnel bytes pipelined right after a `200`, in the same write. Well over
 * `MAX_HEADER_BYTES` (8192), so the client's first read holds the header plus
 * more than 8192 bytes even if loopback splits the write at its 16 KiB MTU.
 * Position-revealing, so a dropped or reordered chunk cannot pass as equal.
 */
const BIG_PIPELINED = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(65 + (i % 26))).join("");

/** Far past any bound on a refusal body: 256 KiB. */
const HUGE_BODY_FILLER = "x".repeat(256 * 1024);

/** A free port, released before it is handed to `ssh-connect.cjs` as "nothing listening". */
async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((res) => s.close(() => res()));
  return p;
}

/**
 * The fake CONNECT server. One connection handler, branching on the target
 * authority the client asked for — never on anything about the client.
 */
function startFakeServer(): Promise<void> {
  return new Promise((resolve) => {
    fake = createServer({ allowHalfOpen: true }, (socket: Socket) => {
      connections += 1;
      onFakeConnection(socket);
    });
    fake.listen(0, "127.0.0.1", () => {
      fakePort = (fake.address() as { port: number }).port;
      resolve();
    });
  });
}

/** The same handler on `::1`, counted separately so a test can tell which listener was reached. */
function startFake6Server(): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
      connections6 += 1;
      onFakeConnection(socket);
    });
    fake6 = server;
    server.listen(0, "::1", () => {
      fake6Port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

function onFakeConnection(socket: Socket): void {
  let buf = Buffer.alloc(0);
  let routed = false;

  socket.on("error", () => {});
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));

  const onData = (chunk: Buffer) => {
    if (routed) return;
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) return;
    routed = true;

    const requestLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
    lastRequestLine = requestLine;
    const authority = requestLine.split(" ")[1] ?? "";

    if (authority === "bigtunnel.test:2222") {
      // A 200 and more than 8192 bytes of tunnel data in ONE write.
      socket.write(`HTTP/1.1 200 Connection Established\r\n\r\n${BIG_PIPELINED}`);
      socket.removeListener("data", onData);
      socket.on("data", (d) => socket.write(`ECHO:${d.toString("latin1")}`));
      socket.on("end", () => socket.end());
      return;
    }

    if (authority === "bigheader.test:2222") {
      // A 200 whose blank line lands past byte 8192, in one write: the
      // header itself is over the cap even though it does terminate.
      socket.write(`HTTP/1.1 200 Connection Established\r\nX-Pad: ${"a".repeat(9000)}\r\n\r\nSSH-2.0-fake\r\n`);
      return;
    }

    if (authority === "hugebody.test:443") {
      const body = `egress denied by rule default-deny\n${HUGE_BODY_FILLER}`;
      socket.end(
        `HTTP/1.1 403 Forbidden\r\n` +
          `Proxy-Agent: fake-connect-proxy\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n${body}`,
      );
      return;
    }

    if (authority === "tunnel.test:2222") {
      // 200, with bytes pipelined in the SAME write — the target sshd
      // answering fast enough to land in one TCP segment.
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\nPIPELINED-HELLO");
      socket.removeListener("data", onData);
      socket.on("data", (d) => socket.write(`ECHO:${d.toString("latin1")}`));
      socket.on("end", () => socket.end());
      return;
    }

    if (authority === "denied.test:443") {
      const body = "egress denied by rule default-deny\n";
      socket.end(
        `HTTP/1.1 403 Forbidden\r\n` +
          `Proxy-Agent: fake-connect-proxy\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n${body}`,
      );
      return;
    }

    if (authority === "cap.test:1") {
      // Never reaches a `\r\n\r\n` — the header-bound must stop this on
      // its own rather than accumulate it forever.
      socket.write("X".repeat(MAX_HEADER_TEST_FILLER));
      return;
    }

    if (authority === "fin.test:2222") {
      // A tunnel the far side closes cleanly, shortly after its banner.
      socket.write(`HTTP/1.1 200 Connection Established\r\n\r\n${BANNER}`);
      setTimeout(() => socket.end(), 100);
      return;
    }

    if (authority === "bulk.test:2222") {
      // Far more than one read's worth of tunnel data, then a FIN.
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.end(BULK);
      return;
    }

    if (authority === "slowtunnel.test:2222") {
      // A healthy tunnel that outlives the (scaled) response deadline.
      socket.write(`HTTP/1.1 200 Connection Established\r\n\r\n${BANNER}`);
      setTimeout(() => socket.end(), 1_500);
      return;
    }

    if (authority === "stream.test:2222") {
      // Tunnel data with no end, for as long as the reader keeps reading.
      // One chunk per turn, capped, so a runtime whose `write()` never
      // reports backpressure cannot spin this process.
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let sent = 0;
      const pump = () => {
        if (socket.destroyed || sent >= 64 * 1024 * 1024) return;
        sent += chunk.length;
        if (socket.write(chunk)) setImmediate(pump);
      };
      socket.on("drain", pump);
      pump();
      return;
    }

    if (authority === "wedged.test:2222") {
      // Accepts, reads the CONNECT, and never answers.
      return;
    }

    if (authority === "keepalive407.test:443") {
      // A complete refusal on a connection the proxy keeps open.
      const body = "proxy authentication required by rule relay-auth\n";
      socket.write(
        `HTTP/1.1 407 Proxy Authentication Required\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: keep-alive\r\n\r\n${body}`,
      );
      return;
    }

    if (authority === "noclose403.test:443") {
      // A refusal with no Content-Length on a connection that never closes:
      // nothing in the response says where the body ends.
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\negress denied by rule default-deny\n");
      return;
    }

    const statusHost = authority.slice(0, -":2222".length);
    if (authority.endsWith(":2222") && Object.hasOwn(STATUS_LINES, statusHost)) {
      // A status line under test, a blank line, the banner, and a close.
      socket.end(`${STATUS_LINES[statusHost]?.line}\r\n\r\n${BANNER}`);
      return;
    }

    if (authority === "controls.test:443") {
      // CONTROL_STATUS and CONTROL_BODY as exact bytes, complete by Content-Length.
      socket.end(
        Buffer.from(
          `${CONTROL_STATUS}\r\nContent-Length: ${CONTROL_BODY.length}\r\nConnection: close\r\n\r\n${CONTROL_BODY}`,
          "latin1",
        ),
      );
      return;
    }

    if (authority === "disagreecl.test:443") {
      // Two Content-Length headers that disagree, the second (2) far shorter
      // than the body. parseContentLength must return null rather than trust
      // either value — in particular not the last one seen, which a
      // check-free "last one wins" loop would produce here. With null, the
      // close (100 ms below) is what ends the read; a wrongly-trusted 2 would
      // end it after two body bytes and cut the rule text before it ever
      // reaches stderr.
      const body = "egress denied by rule default-deny\n";
      socket.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(body)}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n${body}`,
      );
      setTimeout(() => socket.end(), 100);
      return;
    }

    if (authority === "chunked403.test:443") {
      // A chunked refusal that also carries a Content-Length far shorter than
      // its body. Transfer-Encoding overrides Content-Length (RFC 9112 §6.3),
      // so the body runs to the close 200 ms later; honouring the length would
      // cut the response off after two bytes, before the rule text.
      const rule = "egress denied by rule default-deny\n";
      socket.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
          `${rule.length.toString(16)}\r\n${rule}\r\n0\r\n\r\n`,
      );
      setTimeout(() => socket.end(), 200);
      return;
    }

    socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\nunrecognised test authority\n");
  };
  socket.on("data", onData);
}

/** One byte over `MAX_HEADER_BYTES` (8192) in `ssh-connect.cjs`. */
const MAX_HEADER_TEST_FILLER = 8193;

/**
 * The reset proxy: answers a CONNECT the way the authority asks, then resets
 * the connection 100 ms later instead of closing it.
 */
function startResetProxy(): void {
  const partial = new Map<Bun.Socket<undefined>, Buffer>();
  resetProxy = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        resetSockets.add(socket);
        partial.set(socket, Buffer.alloc(0));
      },
      close(socket) {
        resetSockets.delete(socket);
        partial.delete(socket);
      },
      error() {},
      data(socket, chunk) {
        const before = partial.get(socket);
        if (before === undefined) return; // already answered
        const buf = Buffer.concat([before, chunk]);
        if (buf.indexOf("\r\n\r\n") === -1) {
          partial.set(socket, buf);
          return;
        }
        partial.delete(socket);
        const authority = buf.toString("latin1").split("\r\n")[0]?.split(" ")[1] ?? "";
        if (authority === "reset.test:2222") {
          socket.write(`HTTP/1.1 200 Connection Established\r\n\r\n${BANNER}`);
        } else if (authority === "refusereset.test:443") {
          // A complete refusal whose body is delimited by the close (no
          // Content-Length), and then a reset instead of that close.
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\negress denied by rule default-deny\n");
        } else {
          socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\nunrecognised test authority\n");
          return;
        }
        setTimeout(() => socket.terminate(), 100);
      },
    },
  });
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "ssh-connect-test-"));
  wrapper = join(workDir, "scaled-timers.cjs");
  writeFileSync(wrapper, WRAPPER_SOURCE);
  const runtimeProbe = join(workDir, "runtime.cjs");
  writeFileSync(runtimeProbe, `process.stdout.write(process.versions.bun ? "bun" : "node");\n`);
  childRuntime =
    Bun.spawnSync(["node", runtimeProbe], { env: childEnv(null) }).stdout.toString() === "bun" ? "bun" : "node";
  envProbe = join(workDir, "env-keys.cjs");
  writeFileSync(envProbe, `process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));\n`);
  startResetProxy();
  await startFakeServer();
  if (IPV6_UNAVAILABLE === null) await startFake6Server();
}, gateBudget([2_000]));

afterAll(async () => {
  for (const s of openSockets) s.destroy();
  for (const s of resetSockets) s.terminate();
  resetProxy.stop(true);
  await new Promise<void>((res) => fake.close(() => res()));
  const server6 = fake6;
  if (server6 !== undefined) await new Promise<void>((res) => server6.close(() => res()));
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Run `ssh-connect.cjs <host> <port>` as a real child process, to completion.
 *
 * Resolves fully here — one monomorphic `Bun.spawn` call, stdin always a
 * `Buffer` — rather than handing callers the live `Bun.spawn` handle: a
 * `stdin` typed from a conditional expression widens `Bun.spawn`'s return
 * type onto a generic overload where `stdout`/`stderr` are no longer known to
 * be `ReadableStream`, which `new Response()` at the call site then rejects.
 * An empty buffer behaves identically to "ignore" for every case here, since
 * none of `ssh-connect.cjs`'s refusal paths ever read stdin before exiting.
 */
async function run(opts: {
  host?: string;
  port?: string;
  proxy?: string | null;
  stdin?: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [SCRIPT];
  if (opts.host !== undefined) args.push(opts.host);
  if (opts.port !== undefined) args.push(opts.port);

  const proc = Bun.spawn(["node", ...args], {
    env: childEnv(opts.proxy),
    stdin: Buffer.from(opts.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * The child's environment, built from nothing: `PATH`, so `node` and `bash`
 * resolve, and `HTTPS_PROXY` pointed at the fake server, replaced, or (`null`)
 * left out. Nothing else of this process's environment reaches the child, so
 * a `NODE_OPTIONS`, `https_proxy` or anything else in the operator's shell
 * cannot change what these tests observe.
 */
function childEnv(proxy: string | null | undefined): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  if (proxy !== null) {
    env["HTTPS_PROXY"] = proxy ?? `http://127.0.0.1:${fakePort}`;
  }
  return env;
}

/** What a held-stdin run observed. `code` is `null` when the child had to be killed. */
type HeldRun = { code: number | null; hung: boolean; stdout: Buffer; stderr: string };

async function collect(stream: ReadableStream<Uint8Array>, into: Buffer[]): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    into.push(Buffer.from(value));
  }
}

/**
 * Run `cmd` with its stdin HELD OPEN for the whole run: the shape ssh gives a
 * ProxyCommand, whose stdin it never closes while the session lives. `run()`
 * cannot show this. Its `Buffer` stdin closes at once, which ends the tunnel
 * from this side, so the far side closing was never what ended the process
 * there.
 *
 * A child still running after `limitMs` is recorded as hung and killed, after
 * its server-side connections are cut, so a regression fails an assertion
 * rather than the test's budget, and leaves no process behind. `proxy`
 * replaces `HTTPS_PROXY` (the reset proxy's URL).
 */
async function runHeld(cmd: string[], opts: { proxy?: string; limitMs?: number } = {}): Promise<HeldRun> {
  const proc = Bun.spawn(cmd, { env: childEnv(opts.proxy), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const reading = Promise.all([collect(proc.stdout, out), collect(proc.stderr, err)]);
  const limitMs = opts.limitMs ?? 3_000;
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(limitMs).then(() => false)]);
  if (!exited) {
    for (const s of openSockets) s.destroy();
    for (const s of resetSockets) s.terminate();
    proc.kill("SIGKILL");
  }
  await proc.exited;
  try {
    proc.stdin.end();
  } catch {
    // The child is gone and its stdin may already be closed.
  }
  await Promise.race([reading, Bun.sleep(1_000)]);
  return {
    code: exited ? proc.exitCode : null,
    hung: !exited,
    stdout: Buffer.concat(out),
    stderr: Buffer.concat(err).toString("latin1"),
  };
}

describe("the 200 path (SRD-OBSERVER-ROLES 3.1)", () => {
  test("splices stdin/stdout onto the tunnel, forwarding bytes pipelined right after the 200", async () => {
    const before = connections;
    const { code, stdout, stderr } = await run({ host: "tunnel.test", port: "2222", stdin: "PING" });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    // The pipelined bytes, forwarded rather than dropped…
    expect(stdout).toContain("PIPELINED-HELLO");
    // …and a real round trip through the tunnel after splicing: stdin's
    // "PING" reached the fake server and its echo reached our stdout.
    expect(stdout).toContain("ECHO:PING");
    expect(connections).toBe(before + 1);
  }, gateBudget([2_000]));

  test("a first read holding the 200 plus more than 8192 bytes of tunnel data still splices every byte", async () => {
    // The header cap bounds the HEADER. Bytes after a terminated header are
    // tunnel data, however many arrive in the same read.
    const before = connections;
    const { code, stdout, stderr } = await run({ host: "bigtunnel.test", port: "2222", stdin: "PING" });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.length).toBe(BIG_PIPELINED.length + "ECHO:PING".length);
    // Compared as booleans so a failure does not print 20 KiB twice.
    expect(stdout.startsWith(BIG_PIPELINED)).toBe(true);
    expect(stdout.endsWith("ECHO:PING")).toBe(true);
    expect(connections).toBe(before + 1);
  }, gateBudget([2_000]));
});

describe("what a refusal looks like on stderr (SRD-OBSERVER-ROLES §5.2, task 3.1)", () => {
  test("a 403 with a rule body: stderr carries both the status line and the rule text", async () => {
    const { code, stdout, stderr } = await run({ host: "denied.test", port: "443" });

    expect(code).not.toBe(0);
    expect(stderr).toContain("403 Forbidden");
    expect(stderr).toContain("egress denied by rule default-deny");
    expect(stdout).toBe("");
  }, gateBudget([2_000]));
});

describe("what the proxy's answer can put on stdout and stderr (SRD-OBSERVER-ROLES §5.2, task 3.1)", () => {
  test.each(
    Object.entries(STATUS_LINES)
      .filter(([, c]) => !c.open)
      .map(([host, c]) => [c.line, host] as const),
  )("the status line '%s' is reported as a refusal, and nothing reaches stdout", async (line, host) => {
    const { code, stdout, stderr } = await run({ host, port: "2222" });

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr.startsWith(`${line}\n`)).toBe(true);
  }, gateBudget([2_000]));

  test.each(
    Object.entries(STATUS_LINES)
      .filter(([, c]) => c.open)
      .map(([host, c]) => [c.line, host] as const),
  )("the status line '%s' opens the tunnel", async (_line, host) => {
    const { code, stdout, stderr } = await run({ host, port: "2222" });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe(BANNER);
  }, gateBudget([2_000]));

  test("control characters in the proxy's status line and body reach stderr escaped, and tab and LF pass through", async () => {
    const { code, stdout, stderr } = await run({ host: "controls.test", port: "443" });

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    // No C0 control but tab and LF, no DEL and no C1 control, anywhere…
    expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(stderr)).toBe(false);
    // …and each one shown as `\xNN`, so the refusal is still readable.
    expect(stderr).toBe(CONTROL_STDERR);
  }, gateBudget([2_000]));
});

describe("a bracketed IPv6 proxy literal (SRD-OBSERVER-ROLES §5.2, task 3.1)", () => {
  // WHATWG `URL.hostname` keeps an IPv6 literal's brackets, and `net.connect`
  // given `[::1]` looks it up as a name. The connection must reach a proxy
  // listening on `::1` itself. Skips, with a warning at load, only on a host
  // with no IPv6 loopback.
  test.skipIf(IPV6_UNAVAILABLE !== null)("http://[::1]:<port> reaches the proxy on ::1 and the tunnel round-trips", async () => {
    const before = connections6;
    const { code, stdout, stderr } = await run({
      host: "tunnel.test",
      port: "2222",
      stdin: "PING",
      proxy: `http://[::1]:${fake6Port}`,
    });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("ECHO:PING");
    expect(connections6).toBe(before + 1);
  }, gateBudget([2_000]));
});

describe("the environment these tests give the child", () => {
  test("is PATH and HTTPS_PROXY alone, whatever this process's environment holds", async () => {
    process.env["SSH_CONNECT_TEST_CANARY"] = "leaked";
    try {
      const proc = Bun.spawn(["node", envProbe], { env: childEnv(undefined), stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual(["HTTPS_PROXY", "PATH"]);
    } finally {
      delete process.env["SSH_CONNECT_TEST_CANARY"];
    }
  }, gateBudget([2_000]));
});

describe("refused before any connection is attempted (SRD-OBSERVER-ROLES §5.2, task 3.1)", () => {
  test.each([
    ["a missing host", { host: "", port: "22" }, "missing host"],
    ["a non-integer port", { host: "tunnel.test", port: "abc" }, "port must be an integer"],
    ["an out-of-range port", { host: "tunnel.test", port: "70000" }, "port must be an integer"],
  ] as const)("%s is refused with a named reason, and the fake server sees no connection", async (_label, args, fragment) => {
    const before = connections;
    const { code, stderr } = await run({ host: args.host, port: args.port });

    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain(fragment);
    expect(connections).toBe(before);
  }, gateBudget([2_000]));

  test("a missing HTTPS_PROXY is refused with a named reason, and the fake server sees no connection", async () => {
    const before = connections;
    const { code, stderr } = await run({ host: "tunnel.test", port: "2222", proxy: null });

    expect(code).not.toBe(0);
    expect(stderr).toContain("HTTPS_PROXY");
    expect(connections).toBe(before);
  }, gateBudget([2_000]));

  // Only `http:`. This client never speaks TLS to the proxy, so an `https:`
  // proxy would be sent a plaintext CONNECT on its TLS port, and no other
  // scheme names a proxy it can talk to.
  test.each([["https"], ["ftp"], ["socks5"]] as const)(
    "an HTTPS_PROXY with the %s: scheme is refused, naming http:// and why https: is not supported, and the fake server sees no connection",
    async (scheme) => {
      const before = connections;
      const { code, stdout, stderr } = await run({
        host: "tunnel.test",
        port: "2222",
        proxy: `${scheme}://127.0.0.1:${fakePort}`,
      });

      expect(code).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("must be an http:// URL");
      expect(stderr).toContain("https: is not supported");
      expect(stderr).toContain("TLS");
      expect(connections).toBe(before);
    },
    gateBudget([2_000]),
  );

  test("a non-http scheme is refused before its host is looked up", async () => {
    // `.invalid` never resolves (RFC 6761), so a lookup would end in a
    // `getaddrinfo` failure on stderr in place of the scheme refusal.
    const { code, stderr } = await run({ host: "tunnel.test", port: "2222", proxy: "ftp://proxy.invalid:3128" });

    expect(code).not.toBe(0);
    expect(stderr).toContain("must be an http:// URL");
    expect(stderr).not.toContain("getaddrinfo");
    expect(stderr).not.toContain("proxy connection failed");
  }, gateBudget([2_000]));

  // Credentials are refused, and nothing on stderr repeats them: stderr
  // reaches the worker's transcript. Any `@` refuses the value, because no
  // `http://host:port` has one and parsers disagree about where userinfo ends;
  // a `\` hides it from the WHATWG parser, which reads what follows as a path.
  test.each([
    ["a user and password", "http://user:s3cret-pw@127.0.0.1:PORT"],
    ["a user alone", "http://s3cret-user@127.0.0.1:PORT"],
    ["a password alone", "http://:s3cret-pw@127.0.0.1:PORT"],
    ["credentials on an https: URL", "https://user:s3cret-pw@127.0.0.1:PORT"],
    ["credentials in a value that does not parse", "http://user:s3cret-pw@[::1"],
    ["credentials a backslash hides from the parser", "http://s3cret:1234\\@127.0.0.1"],
    ["credentials and no '//'", "s3cret:pw@127.0.0.1:PORT"],
  ] as const)(
    "an HTTPS_PROXY with %s is refused, repeats none of it, and the fake server sees no connection",
    async (_label, template) => {
      const before = connections;
      const { code, stdout, stderr } = await run({
        host: "tunnel.test",
        port: "2222",
        proxy: template.replace("PORT", String(fakePort)),
      });

      expect(code).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("HTTPS_PROXY");
      expect(stderr).not.toContain("s3cret");
      expect(connections).toBe(before);
    },
    gateBudget([2_000]),
  );

  // The host is interpolated into the CONNECT request line and the Host
  // header, so anything outside `observe-ssh`'s own `is_host` shape could add
  // header lines (CR/LF) or change how the proxy splits the authority.
  test.each([
    ["CR/LF header injection", "evil.test:22 HTTP/1.1\r\nX-Injected: yes\r\nHost"],
    ["only a trailing LF", "tunnel.test\n"],
    ["a space", "a b"],
    ["a '/'", "a/b"],
    ["an '@'", "user@tunnel.test"],
    ["a leading '-'", "-tunnel.test"],
    ["a leading '.'", ".tunnel.test"],
    ["254 characters", "a".repeat(254)],
  ] as const)("a host with %s is refused with a named reason, and the fake server sees no connection", async (_label, host) => {
    const before = connections;
    const { code, stdout, stderr } = await run({ host, port: "2222" });

    expect(code).not.toBe(0);
    expect(stderr).toContain("host must be");
    expect(stdout).toBe("");
    expect(connections).toBe(before);
  }, gateBudget([2_000]));

  // The other side of the host rule: these shapes reach the proxy, and reach
  // it UNCHANGED. A bare IPv6 authority stays unbracketed on purpose: the
  // proxy's `splitAuthority` reads `::1:22` by its last ':', and bracketing it
  // would change the host string the egress policy is judged against.
  test.each([
    ["a bare IPv6 literal", "::1"],
    ["an IPv4 address", "10.0.0.12"],
    ["a name at the 253-character limit", "a".repeat(253)],
  ] as const)("%s is sent to the proxy as written", async (_label, host) => {
    const before = connections;
    await run({ host, port: "22" });

    expect(connections).toBe(before + 1);
    expect(lastRequestLine).toBe(`CONNECT ${host}:22 HTTP/1.1`);
  }, gateBudget([2_000]));
});

describe("bounds on the proxy's own response (SRD-OBSERVER-ROLES §5.2, task 3.1)", () => {
  test("a Transfer-Encoding overrides a Content-Length, so the rule text is read to the close rather than cut at the length", async () => {
    const { code, stdout, stderr } = await run({ host: "chunked403.test", port: "443" });

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr.startsWith("HTTP/1.1 403 Forbidden\n")).toBe(true);
    expect(stderr).toContain("egress denied by rule default-deny");
  }, gateBudget([2_000]));

  test("two disagreeing Content-Length headers, the second far shorter than the body, are trusted as neither: the whole rule text still reaches stderr", async () => {
    const { code, stdout, stderr } = await run({ host: "disagreecl.test", port: "443" });

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("HTTP/1.1 403 Forbidden\negress denied by rule default-deny\n");
  }, gateBudget([2_000]));

  test("a 200 whose blank line lands past byte 8192 is refused, even in one read", async () => {
    // Guards the terminator-first search from the other side: looking for the
    // blank line before judging size must not let an oversized header through.
    const { code, stdout, stderr } = await run({ host: "bigheader.test", port: "2222" });

    expect(code).not.toBe(0);
    expect(stderr).toContain("8192");
    expect(stdout).toBe("");
  }, gateBudget([2_000]));

  test("an oversized refusal body is bounded, and the status line and rule still reach stderr", async () => {
    const { code, stdout, stderr } = await run({ host: "hugebody.test", port: "443" });

    expect(code).not.toBe(0);
    expect(stderr).toContain("403 Forbidden");
    expect(stderr).toContain("egress denied by rule default-deny");
    expect(stderr).toContain("body exceeded 8192 bytes");
    expect(stderr.length).toBeLessThan(2 * 8192);
    expect(stdout).toBe("");
  }, gateBudget([2_000]));

  test("a header that never terminates stops at the cap instead of growing forever", async () => {
    const { code, stderr } = await run({ host: "cap.test", port: "1" });

    expect(code).not.toBe(0);
    expect(stderr).toContain("8192");
  }, gateBudget([2_000]));

  test("a proxy port with nothing listening exits non-zero with a named error", async () => {
    const deadPort = await freePort();
    const { code, stderr } = await run({ host: "tunnel.test", port: "2222", proxy: `http://127.0.0.1:${deadPort}` });

    expect(code).not.toBe(0);
    expect(stderr).toContain("proxy connection failed");
  }, gateBudget([2_000]));
});

describe("the tunnel's lifecycle, with stdin held open as ssh holds it (SRD-OBSERVER-ROLES 3.1)", () => {
  test("the far side closing the tunnel ends the process with 0, after its bytes reach stdout", async () => {
    const { code, hung, stdout, stderr } = await runHeld(["node", SCRIPT, "fin.test", "2222"]);

    expect(hung).toBe(false);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.toString("latin1")).toBe(BANNER);
  }, gateBudget([2_000]));

  test("every one of 4 MiB sent before the far side's FIN reaches stdout before the process exits", async () => {
    const { code, hung, stdout, stderr } = await runHeld(["node", SCRIPT, "bulk.test", "2222"]);

    expect(hung).toBe(false);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.length).toBe(BULK.length);
    // Compared as a boolean so a failure does not print 4 MiB twice.
    expect(stdout.equals(BULK)).toBe(true);
  }, gateBudget([2_000]));

  test("a tunnel reset by the far side ends the process; under real Node, non-zero with one named line", async () => {
    const { code, hung, stderr } = await runHeld(["node", SCRIPT, "reset.test", "2222"], {
      proxy: `http://127.0.0.1:${resetProxy.port}`,
    });

    expect(hung).toBe(false);
    if (childRuntime === "bun") {
      // Bun's `node` reports a reset as a clean end (measured on 1.3.11: the
      // client sees `end` and no `error`), so ending is all that is
      // observable there. CI and the worker image run real Node.
      return;
    }
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/^ssh-connect: tunnel connection error: [^\n]*\n$/);
  }, gateBudget([2_000]));

  test("ssh closing its end of stdout mid-stream exits non-zero with one ssh-connect: line, not a stack trace", async () => {
    // `head` reads 1 KiB and exits, closing the pipe while the tunnel is
    // still streaming; bash hands back ssh-connect's own exit status.
    const { code, hung, stderr } = await runHeld([
      "bash",
      "-c",
      'node "$@" | head -c 1024 >/dev/null; exit "${PIPESTATUS[0]}"',
      "bash",
      SCRIPT,
      "stream.test",
      "2222",
    ]);

    expect(hung).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/^ssh-connect: [^\n]*EPIPE[^\n]*\n$/);
  }, gateBudget([2_000]));
});

describe("a refusal always reaches stderr, and a quiet proxy cannot hang the process", () => {
  test("a complete 403 followed by a reset still puts its status line and rule on stderr", async () => {
    // Under real Node the reset arrives as an `'error'` after the refusal's
    // bytes; under Bun's `node` it arrives as a clean end. Both must print it.
    const { code, hung, stdout, stderr } = await runHeld(["node", SCRIPT, "refusereset.test", "443"], {
      proxy: `http://127.0.0.1:${resetProxy.port}`,
    });

    expect(hung).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toContain("HTTP/1.1 403 Forbidden");
    expect(stderr).toContain("egress denied by rule default-deny");
    expect(stdout.length).toBe(0);
  }, gateBudget([2_000]));

  test("a proxy that accepts and never answers is abandoned with a named reason after a deadline above 15 s", async () => {
    const { code, hung, stdout, stderr } = await runHeld(["node", wrapper, String(TIME_SCALE), SCRIPT, "wedged.test", "2222"]);

    expect(hung).toBe(false);
    expect(code).not.toBe(0);
    const match = /^ssh-connect: [^\n]*complete response header[^\n]* within (\d+) s[^\n]*\n$/.exec(stderr);
    expect(match).not.toBeNull();
    // Above the fleet proxy's own 15 s handshake timeout, so a healthy relay
    // always answers first.
    expect(Number(match?.[1])).toBeGreaterThan(15);
    expect(stdout.length).toBe(0);
  }, gateBudget([2_000]));

  test("a 407 with Content-Length on a connection kept alive is reported without waiting for a close", async () => {
    // Unscaled: the deadline is 30 s, so exiting inside `runHeld`'s 3 s shows
    // the refusal was reported when its body was complete.
    const { code, hung, stdout, stderr } = await runHeld(["node", SCRIPT, "keepalive407.test", "443"]);

    expect(hung).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr).toBe("HTTP/1.1 407 Proxy Authentication Required\nproxy authentication required by rule relay-auth\n");
    expect(stdout.length).toBe(0);
  }, gateBudget([2_000]));

  test("a 403 with no Content-Length on a connection that never closes is reported at the deadline", async () => {
    const { code, hung, stdout, stderr } = await runHeld(["node", wrapper, String(TIME_SCALE), SCRIPT, "noclose403.test", "443"]);

    expect(hung).toBe(false);
    expect(code).not.toBe(0);
    expect(stderr.startsWith("HTTP/1.1 403 Forbidden\negress denied by rule default-deny\n")).toBe(true);
    expect(stdout.length).toBe(0);
  }, gateBudget([2_000]));

  test("a healthy tunnel that outlives the response deadline is not cut by it", async () => {
    const { code, hung, stdout, stderr } = await runHeld(["node", wrapper, String(TIME_SCALE), SCRIPT, "slowtunnel.test", "2222"]);

    expect(hung).toBe(false);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.toString("latin1")).toBe(BANNER);
  }, gateBudget([2_000]));
});
