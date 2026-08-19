/**
 * `docker/egress-relay.js` itself, against real sockets (S1, S2, S9, S10).
 *
 * NO DOCKER. The relay script is dependency-free Node and its interesting
 * properties are properties of TCP, not of containers — so they can be
 * measured directly by running the script and talking to it. That matters
 * twice over: it is the only relay coverage that runs in CI today (the
 * container suite is gated on `PIFLEET_DOCKER=1` and this file is not, see
 * ISC-257), and it turns a 166-second Docker round trip into a 200ms one.
 *
 * `test/integration/relay.test.ts` still owns everything that is genuinely
 * about Docker networking — the alias, the internal bridge, the gateway
 * residual. This file owns everything that is about the forwarder.
 *
 * The measurements these tests replace were taken by hand against a running
 * relay: 300 idle client connections that sent zero bytes took it from 19 open
 * FDs to 619, with 603 TCP sockets, because the upstream was dialled on accept
 * rather than on first byte. That is a denial of service against oMLX from any
 * container on the bridge, spending nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "docker", "egress-relay.js");

interface Upstream {
  server: Server;
  port: number;
  /** Connections the relay actually opened against us. */
  connections: number;
  sockets: Socket[];
}

/** An upstream that counts connections and replies with `body` on request. */
async function startUpstream(
  onData?: (sock: Socket, chunk: string | Uint8Array) => void,
): Promise<Upstream> {
  const up: Upstream = { server: null as never, port: 0, connections: 0, sockets: [] };
  const server = createServer((sock) => {
    up.connections += 1;
    up.sockets.push(sock);
    sock.on("error", () => undefined);
    sock.on("data", (chunk) => {
      if (onData) onData(sock, chunk);
      else sock.write(`ECHO:${chunk.toString()}`);
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  up.server = server;
  up.port = (server.address() as { port: number }).port;
  return up;
}

interface Relay {
  proc: Bun.Subprocess;
  port: number;
  stderr: () => Promise<string>;
}

const running: Array<{ kill: () => void }> = [];
const upstreams: Upstream[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) r.kill();
  for (const u of upstreams.splice(0)) {
    for (const s of u.sockets) s.destroy();
    await new Promise<void>((res) => u.server.close(() => res()));
  }
});

/**
 * Start the relay forwarding `listenPort -> 127.0.0.1:upstreamPort` and wait
 * until it says it is listening. Waiting on the process's OWN announcement,
 * rather than sleeping, is what keeps these tests off the flake list.
 */
async function startRelay(
  targets: Array<Record<string, unknown>>,
  env: Record<string, string> = {},
): Promise<Relay> {
  const proc = Bun.spawn(["node", SCRIPT], {
    env: { ...process.env, PIFLEET_RELAY_TARGETS: JSON.stringify(targets), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push({ kill: () => proc.kill() });

  const stderrText = new Response(proc.stderr).text();
  const reader = (proc.stdout as ReadableStream).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 10_000;
  while (!seen.includes("forwarding") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return {
    proc,
    port: Number(targets[0]!.listenPort),
    stderr: () => stderrText,
  };
}

/** A free localhost port, released before the caller binds it. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((res) => s.close(() => res()));
  return port;
}

function open(port: number): Socket {
  const sock = connect({ host: "127.0.0.1", port });
  sock.on("error", () => undefined);
  return sock;
}

async function once(sock: Socket, event: string, ms = 5_000): Promise<unknown> {
  return await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${event}`)), ms);
    sock.once(event, (v: unknown) => {
      clearTimeout(timer);
      res(v);
    });
  });
}

describe("egress-relay.js — forwarding", () => {
  test("forwards a request and its response", async () => {
    const up = await startUpstream();
    upstreams.push(up);
    const listenPort = await freePort();
    await startRelay([{ listenPort, host: "127.0.0.1", port: up.port, name: "omlx" }]);

    const client = open(listenPort);
    await once(client, "connect");
    client.write("HELLO");
    const reply = (await once(client, "data")) as Buffer;
    expect(reply.toString()).toBe("ECHO:HELLO");
    expect(up.connections).toBe(1);
    client.destroy();
  });

  test("the first chunk is not lost when it triggers the dial", async () => {
    // The bytes that cause the upstream to be dialled must arrive at the
    // upstream too. A version that `unshift`-ed them before any pipe existed
    // dropped them; a version that paused the socket before attaching the
    // `data` listener never fired at all and deadlocked. Both are silent —
    // the connection just returns nothing — so this asserts the payload.
    const seen: string[] = [];
    const up = await startUpstream((sock, chunk) => {
      seen.push(chunk.toString());
      sock.write("OK");
    });
    upstreams.push(up);
    const listenPort = await freePort();
    await startRelay([{ listenPort, host: "127.0.0.1", port: up.port, name: "omlx" }]);

    const client = open(listenPort);
    await once(client, "connect");
    client.write("FIRST");
    await once(client, "data");
    expect(seen.join("")).toContain("FIRST");
    client.destroy();
  });

  test("data sent after the dial still arrives, in order", async () => {
    const seen: string[] = [];
    const up = await startUpstream((sock, chunk) => {
      seen.push(chunk.toString());
      sock.write("OK");
    });
    upstreams.push(up);
    const listenPort = await freePort();
    await startRelay([{ listenPort, host: "127.0.0.1", port: up.port, name: "omlx" }]);

    const client = open(listenPort);
    await once(client, "connect");
    client.write("A");
    await once(client, "data");
    client.write("B");
    await once(client, "data");
    expect(seen.join("")).toBe("AB");
    client.destroy();
  });
});

describe("egress-relay.js — S1: an idle client costs the upstream nothing", () => {
  test("connections that send no bytes do NOT dial the upstream", async () => {
    /**
     * The measurement this replaces: 300 idle connections, zero bytes sent,
     * relay FDs 19 -> 619 and 603 TCP sockets — every one an unauthenticated
     * connection against a Python inference server that exhausts long before
     * the relay's own nofile.
     *
     * 25 rather than 300 because the property is binary: either accept dials
     * upstream or it does not. The old code would show 25 here; the fix shows
     * 0 until a byte is actually sent.
     */
    const up = await startUpstream();
    upstreams.push(up);
    const listenPort = await freePort();
    await startRelay([{ listenPort, host: "127.0.0.1", port: up.port, name: "omlx" }]);

    const idle: Socket[] = [];
    for (let i = 0; i < 25; i += 1) {
      const s = open(listenPort);
      idle.push(s);
      await once(s, "connect");
    }
    // Generous settle window: if the relay were going to dial, it would have.
    await Bun.sleep(300);
    expect(up.connections).toBe(0);

    // …and one byte on ONE of them dials exactly one upstream, so the laziness
    // is not simply "the relay is broken".
    idle[0]!.write("GO");
    await once(idle[0]!, "data");
    expect(up.connections).toBe(1);

    for (const s of idle) s.destroy();
  });

  test("an idle client is reaped by the idle timeout", async () => {
    const up = await startUpstream();
    upstreams.push(up);
    const listenPort = await freePort();
    await startRelay([{ listenPort, host: "127.0.0.1", port: up.port, name: "omlx" }], {
      PIFLEET_RELAY_IDLE_TIMEOUT_MS: "250",
    });

    const client = open(listenPort);
    await once(client, "connect");
    // No bytes ever sent: the socket must be closed by the relay, not held.
    await once(client, "close", 5_000);
    expect(up.connections).toBe(0);
  });
});

describe("egress-relay.js — S10: a client FIN is forwarded, not turned into a kill", () => {
  /**
   * WHAT IS ASSERTED, AND WHY IT IS ASSERTED FROM THE UPSTREAM SIDE.
   *
   * The defect: `client.on("close", () => upstream.destroy())` turned a client
   * half-close into an abrupt teardown of the upstream, discarding whatever
   * response was still in flight. Fine for curl, wrong for an HTTP/1.0
   * `Connection: close` exchange, where the client finishes its request and
   * only then waits for the body.
   *
   * The natural test — "half-close the client, then assert the client receives
   * a late response" — CANNOT be written with a raw Node socket, and that was
   * MEASURED rather than assumed. A client that calls `end()` emits `end` and
   * then `close` immediately and never reads the reply; it does so against a
   * DIRECT server with no relay in the path at all, with `allowHalfOpen` true
   * and false alike. A client-side assertion would therefore be testing Node's
   * socket semantics, not this relay's forwarding, and it would fail against a
   * correct relay — which is exactly what happened when it was tried.
   *
   * HONEST LIMIT — READ THIS BEFORE TRUSTING THE TEST BELOW.
   *
   * The single test here asserts that the client's FIN reaches the upstream as
   * a FIN. It is TRUE and it is worth keeping, but it is NOT a regression test
   * for this defect, and that was established by mutation rather than assumed:
   * flipping the server back to `allowHalfOpen: false` leaves it GREEN. The
   * reason is that `client.pipe(upstream)` forwards the FIN via pipe's own
   * `end: true` before the teardown path destroys the socket, so the upstream
   * sees `end` under both the old and new behaviour.
   *
   * Two stronger assertions were written and then REMOVED rather than shipped,
   * because they passed under the mutation too — which would have made them
   * exactly the vacuous-pass shape this whole review round exists to delete.
   *
   * So: `allowHalfOpen` and the explicit end-forwarding are IMPLEMENTED and
   * argued for in `docker/egress-relay.js`, and they are NOT covered by a test
   * that would fail if someone removed them. Proving the real consequence — a
   * response written after the client's half-close still reaches the client —
   * needs a client that half-closes and keeps reading, and a raw Node socket
   * does not do that (measured: it emits `end` then `close` the moment `end()`
   * is called, against a DIRECT server with no relay in the path, with
   * `allowHalfOpen` true and false alike). An HTTP/1.0-speaking fixture is
   * where that coverage would have to come from.
   */
  test("the client's FIN reaches the upstream as a FIN", async () => {
    const events: string[] = [];
    const up = await startUpstream();
    upstreams.push(up);
    up.server.on("connection", (sock) => {
      sock.on("end", () => events.push("end"));
      sock.on("close", () => events.push("close"));
    });
    const listenPort = await freePort();
    await startRelay([{ listenPort, host: "127.0.0.1", port: up.port, name: "omlx" }]);

    const client = open(listenPort);
    await once(client, "connect");
    client.write("REQ");
    await once(client, "data"); // the upstream is connected and has replied
    client.end(); // half-close

    const deadline = Date.now() + 5_000;
    while (!events.includes("end") && Date.now() < deadline) await Bun.sleep(25);
    expect(events).toContain("end");
    client.destroy();
  });
});

describe("egress-relay.js — S9: ports are range-checked, not just typed", () => {
  const cases: Array<[string, unknown]> = [
    ["zero would listen(0) and bind a RANDOM port", 0],
    ["negative", -1],
    ["above the TCP range", 65536],
    ["fractional", 3.7],
  ];

  for (const [why, port] of cases) {
    test(`refuses listenPort ${JSON.stringify(port)} — ${why}`, async () => {
      const relay = await startRelay([
        { listenPort: port, host: "127.0.0.1", port: 8000, name: "omlx" },
      ]);
      const code = await relay.proc.exited;
      expect(code).not.toBe(0);
      expect(await relay.stderr()).toMatch(/listenPort is not a port in 1\.\.65535/);
    });
  }

  test("refuses an empty host", async () => {
    const relay = await startRelay([{ listenPort: 9, host: "", port: 8000, name: "omlx" }]);
    expect(await relay.proc.exited).not.toBe(0);
    expect(await relay.stderr()).toMatch(/host is empty/);
  });
});

describe("egress-relay.js — S2: only a LISTEN failure is fatal", () => {
  test("a relay whose port is already held exits non-zero", async () => {
    // The half that must stay fatal: a relay that cannot bind has nothing to
    // offer, and `ensureEgressRelay` depends on it dying so that "started"
    // cannot be reported for a relay that is not listening.
    const up = await startUpstream();
    upstreams.push(up);
    const listenPort = await freePort();
    const blocker = createServer();
    await new Promise<void>((res) => blocker.listen(listenPort, "0.0.0.0", res));
    try {
      const relay = await startRelay([
        { listenPort, host: "127.0.0.1", port: up.port, name: "omlx" },
      ]);
      expect(await relay.proc.exited).toBe(1);
      expect(await relay.stderr()).toMatch(/listen .* failed/);
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()));
    }
  });
});
