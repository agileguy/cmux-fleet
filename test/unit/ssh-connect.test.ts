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
 * whole point of item 2 in this task is that text surviving to stderr.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateBudget } from "../support/budget.ts";

const SCRIPT = new URL("../../docker/ssh-connect.cjs", import.meta.url).pathname;

let fake: Server;
let fakePort = 0;
let connections = 0;
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

        socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\nunrecognised test authority\n");
      };
      socket.on("data", onData);
    });
    fake.listen(0, "127.0.0.1", () => {
      fakePort = (fake.address() as { port: number }).port;
      resolve();
    });
  });
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
  childRuntime = Bun.spawnSync(["node", runtimeProbe]).stdout.toString() === "bun" ? "bun" : "node";
  startResetProxy();
  await startFakeServer();
}, gateBudget([2_000]));

afterAll(async () => {
  for (const s of openSockets) s.destroy();
  for (const s of resetSockets) s.terminate();
  resetProxy.stop(true);
  await new Promise<void>((res) => fake.close(() => res()));
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

/** The child's environment: this process's, with `HTTPS_PROXY` pointed at the fake server, replaced, or (`null`) removed. */
function childEnv(proxy: string | null | undefined): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env["HTTPS_PROXY"];
  delete env["https_proxy"];
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

describe("what a refusal looks like on stderr (item 2)", () => {
  test("a 403 with a rule body: stderr carries both the status line and the rule text", async () => {
    const { code, stdout, stderr } = await run({ host: "denied.test", port: "443" });

    expect(code).not.toBe(0);
    expect(stderr).toContain("403 Forbidden");
    expect(stderr).toContain("egress denied by rule default-deny");
    expect(stdout).toBe("");
  }, gateBudget([2_000]));
});

describe("refused before any connection is attempted (item 3)", () => {
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

describe("bounds on the proxy's own response (item 4)", () => {
  test("a 200 whose blank line lands past byte 8192 is refused, even in one read", async () => {
    // Guards the P2 fix from the other side: moving the terminator search
    // ahead of the cap must not let an oversized header through.
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
