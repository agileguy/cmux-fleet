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
import { gateBudget } from "../support/budget.ts";

const SCRIPT = new URL("../../docker/ssh-connect.cjs", import.meta.url).pathname;

let fake: Server;
let fakePort = 0;
let connections = 0;
/** The request line of the most recent CONNECT the fake server received. */
let lastRequestLine = "";

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

beforeAll(async () => {
  await startFakeServer();
}, gateBudget([2_000]));

afterAll(async () => {
  await new Promise<void>((res) => fake.close(() => res()));
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

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env["HTTPS_PROXY"];
  delete env["https_proxy"];
  if (opts.proxy !== null) {
    env["HTTPS_PROXY"] = opts.proxy ?? `http://127.0.0.1:${fakePort}`;
  }

  const proc = Bun.spawn(["node", ...args], {
    env,
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
