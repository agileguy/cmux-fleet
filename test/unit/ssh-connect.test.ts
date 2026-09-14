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
        const authority = requestLine.split(" ")[1] ?? "";

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
});

describe("bounds on the proxy's own response (item 4)", () => {
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
