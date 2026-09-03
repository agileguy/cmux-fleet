/**
 * The HTTP CONNECT proxy, driven over real TCP (ISC-263).
 *
 * NO DOCKER, deliberately. The proxy's contract is a property of sockets and
 * of `decide()`, not of Docker networking: what it must do is answer a request
 * line, refuse the destinations the policy denies, and splice the ones it
 * allows. All of that is observable against loopback, so it belongs in a suite
 * that actually runs rather than behind a daemon gate. What Docker DOES decide
 * — that a worker on the `--internal` bridge can reach this process and cannot
 * reach anything else — is a different claim and is proved where the bridge
 * exists, in `relay.test.ts`'s gated block.
 *
 * The origin server is a real listener on loopback, so "allowed" means bytes
 * actually crossed and came back, not that a code path was entered.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, connect, type Server, type Socket } from "node:net";
import { once } from "node:events";

import { makeRule } from "../../src/security/egress.ts";
import { gateBudget } from "../support/budget.ts";

const PROXY_SCRIPT = new URL("../../docker/connect-proxy.cjs", import.meta.url).pathname;

let origin: Server;
let originPort = 0;
let proxy: ReturnType<typeof Bun.spawn> | null = null;
let proxyPort = 0;

/** A listener that answers anything with a fixed banner, so a tunnel is provable. */
async function startOrigin(): Promise<void> {
  origin = createServer({ allowHalfOpen: true }, (s) => {
    s.on("data", () => s.write("ORIGIN-PONG"));
    s.on("error", () => {});
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  originPort = (origin.address() as { port: number }).port;
}

/** A free port, released before the proxy claims it. */
async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((res) => s.close(() => res()));
  return p;
}

/**
 * One request against the proxy. Returns everything read until the socket
 * closes or the read budget elapses, so a response and any tunnelled bytes
 * arrive in one string and the test can assert on both.
 */
async function ask(request: string, opts: { readMs?: number } = {}): Promise<string> {
  const sock: Socket = connect({ host: "127.0.0.1", port: proxyPort });
  await once(sock, "connect");
  let out = "";
  sock.on("data", (d) => {
    out += d.toString("latin1");
  });
  sock.on("error", () => {});
  sock.write(request);
  await Bun.sleep(opts.readMs ?? 350);
  sock.destroy();
  return out;
}

beforeAll(async () => {
  await startOrigin();
  proxyPort = await freePort();
  const policy = {
    rules: [
      makeRule("origin", "127.0.0.1", originPort),
      makeRule("google", "*.googleapis.com", 443),
      // Allowed by policy, and nothing is listening — the 502 case.
      makeRule("dead", "127.0.0.1", 1),
    ],
  };
  proxy = Bun.spawn(["node", PROXY_SCRIPT], {
    env: {
      ...process.env,
      PIFLEET_PROXY_POLICY: JSON.stringify(policy),
      PIFLEET_PROXY_PORT: String(proxyPort),
      PIFLEET_PROXY_MAX_HEADER_BYTES: "1024",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for the listener rather than sleeping a guess: a race here would
  // surface as a flaky ECONNREFUSED in whichever test happened to run first.
  for (let i = 0; i < 100; i += 1) {
    try {
      const s = connect({ host: "127.0.0.1", port: proxyPort });
      await once(s, "connect");
      s.destroy();
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  // GATE-shaped, not spawn-shaped: the cost is the listener wait below — 100
  // attempts at 50 ms — not the one `node` spawn that precedes it. `gateBudget`
  // declines to re-apply CONTENTION for exactly this reason (ISC-509).
}, gateBudget([5_000]));

afterAll(async () => {
  proxy?.kill();
  await new Promise<void>((res) => origin.close(() => res()));
});

describe("what the proxy allows (ISC-263)", () => {
  /**
   * The criterion in one test: a destination the policy allows is tunnelled,
   * and the proof is the ORIGIN's bytes coming back — not a 200 line, which a
   * proxy that answered and then dropped the socket would also produce.
   */
  test("an allowed destination is tunnelled, and real bytes cross it", async () => {
    const out = await ask(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: x\r\n\r\nHELLO`);
    expect(out).toContain("200 Connection Established");
    expect(out).toContain("ORIGIN-PONG");
  });

  test("bytes pipelined with the CONNECT are forwarded, not dropped", async () => {
    // A TLS ClientHello routinely arrives in the same packet as the CONNECT.
    // Dropping it would leave the tunnel open and the handshake stalled — a
    // failure that looks like a network problem and is not one.
    const out = await ask(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\n\r\nEARLY-BYTES`);
    expect(out).toContain("200 Connection Established");
    expect(out).toContain("ORIGIN-PONG");
  });
});

describe("what the proxy refuses (ISC-263)", () => {
  /**
   * The refusal is the product. A denied destination must cost no DNS query
   * and no upstream socket, and must say WHY — an operator reading a stalled
   * worker needs `default-deny`, not a timeout.
   */
  test("a destination outside the policy is 403 with the rule named", async () => {
    const out = await ask("CONNECT evil.test:443 HTTP/1.1\r\n\r\n");
    expect(out).toContain("403 Forbidden");
    expect(out).toContain("default-deny");
  });

  /**
   * The label boundary, over live TCP rather than in a matcher unit test.
   * `*.googleapis.com` is in the policy above; these two are the attacks it
   * exists to refuse, and they are asserted HERE as well because a proxy that
   * normalized the authority differently from `decide()` would pass the unit
   * tests and fail in production.
   */
  test("the wildcard's label boundary holds through the CONNECT parser", async () => {
    for (const host of ["evil-googleapis.com", "googleapis.com.evil.test", "..googleapis.com"]) {
      const out = await ask(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
      expect(out).toContain("403 Forbidden");
    }
  });

  test("an allowed host on an unlisted port is still refused", async () => {
    // Port is part of every rule: an allowed name on an unexpected port is
    // exactly how a permitted destination becomes a tunnel.
    const out = await ask("CONNECT storage.googleapis.com:22 HTTP/1.1\r\n\r\n");
    expect(out).toContain("403 Forbidden");
    expect(out).toContain("default-deny");
  });

  test("a method other than CONNECT is 405 — this is not a forward proxy", async () => {
    const out = await ask("GET http://storage.googleapis.com/ HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(out).toContain("405 Method Not Allowed");
    expect(out).toContain("CONNECT only");
  });

  test("a CONNECT with no explicit port is 400, not a default to 443", async () => {
    // Defaulting would mean a rule for `host:443` silently also served
    // `CONNECT host` — a destination nobody wrote down.
    const out = await ask("CONNECT storage.googleapis.com HTTP/1.1\r\n\r\n");
    expect(out).toContain("400 Bad Request");
  });

  test("headers that never terminate are bounded, not buffered forever", async () => {
    const out = await ask(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nX: ${"A".repeat(2000)}`);
    expect(out).toContain("431");
  });

  /**
   * An ALLOWED destination that cannot be reached is 502, not 403. Reporting a
   * network fault as a policy refusal sends an operator to debug the wrong
   * system, which is why the proxy distinguishes them in its log line too.
   */
  test("an allowed but unreachable destination is 502, not a refusal", async () => {
    const out = await ask("CONNECT 127.0.0.1:1 HTTP/1.1\r\n\r\n");
    expect(out).toContain("502 Bad Gateway");
    expect(out).not.toContain("403");
  });
});

/**
 * The CHAIN, end to end (ISC-263).
 *
 * Every assertion above drives the proxy from a hand-written policy, which
 * proves the proxy and proves nothing about how it gets its policy. This block
 * closes that gap: the policy comes from a real `fleet.yaml` through the
 * production `proxyPolicyFor`, is serialized exactly as `relayRunArgv`
 * serializes it, and is handed to the real proxy process through the same
 * environment variable the container gets.
 *
 * That is the difference between "the proxy works" and "the proxy a fleet
 * actually launches works", and this repo has shipped the former believing it
 * was the latter — `AcceptanceContext.image` sat at the literal `null` for a
 * year with four green test files over it.
 */
describe("the policy a fleet launches is the policy the proxy enforces (ISC-263)", () => {
  let chainProxy: ReturnType<typeof Bun.spawn> | null = null;
  let chainPort = 0;
  let llmHost = "";

  beforeAll(async () => {
    const { parseConfig } = await import("../../src/config/load.ts");
    const { stringify } = await import("yaml");
    const { proxyPolicyFor, PROXY_POLICY_ENV, PROXY_PORT_ENV } = await import(
      "../../src/security/relay.ts"
    );

    const loaded = await parseConfig(
      stringify({
        version: 2,
        name: "chain-fleet",
        docker: { pi_version: "0.79.6" },
        run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
        llm: { model: "TestModel" },
        roles: { cloudy: { cloud_access: true } },
        workers: [{ id: "wc", role: "cloudy" }],
        // The origin is reachable ONLY because an operator wrote it down.
        egress: { allow: [{ host: "127.0.0.1", port: originPort }] },
      }),
      "/tmp/fleet.yaml",
    );
    llmHost = new URL(loaded.config.llm.base_url).hostname;

    chainPort = await freePort();
    chainProxy = Bun.spawn(["node", PROXY_SCRIPT], {
      env: {
        ...process.env,
        // Serialized exactly as `relayRunArgv` builds the `-e` flag.
        [PROXY_POLICY_ENV]: JSON.stringify(proxyPolicyFor(loaded.config)),
        [PROXY_PORT_ENV]: String(chainPort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 100; i += 1) {
      try {
        const s = connect({ host: "127.0.0.1", port: chainPort });
        await once(s, "connect");
        s.destroy();
        break;
      } catch {
        await Bun.sleep(50);
      }
    }
    // The same 100 x 50 ms listener gate as the outer fixture.
  }, gateBudget([5_000]));

  afterAll(() => {
    chainProxy?.kill();
  });

  async function askChain(request: string): Promise<string> {
    const sock: Socket = connect({ host: "127.0.0.1", port: chainPort });
    await once(sock, "connect");
    let out = "";
    sock.on("data", (d) => {
      out += d.toString("latin1");
    });
    sock.on("error", () => {});
    sock.write(request);
    await Bun.sleep(350);
    sock.destroy();
    return out;
  }

  test("a destination the CONFIG allows is tunnelled, with real bytes", async () => {
    const out = await askChain(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\n\r\nHI`);
    expect(out).toContain("200 Connection Established");
    expect(out).toContain("ORIGIN-PONG");
  });

  /**
   * The `llm` omission, at runtime rather than in a unit assertion.
   *
   * `proxyPolicyFor` deliberately builds no rule from `llm.base_url` — model
   * traffic reaches the relay's port-forward listener under a different name,
   * and a worker's `NO_PROXY` names that alias so its inference calls never
   * arrive here. If a future edit "helpfully" reused `policyFromConfig`, this
   * goes red, and the unit test asserting the same thing would not: that one
   * reads the rule list, this one proves the proxy acts on it.
   */
  test("the LLM host is refused here — model traffic does not belong to this path", async () => {
    const out = await askChain(`CONNECT ${llmHost}:8000 HTTP/1.1\r\n\r\n`);
    expect(out).toContain("403 Forbidden");
    expect(out).toContain("default-deny");
  });

  test("a Google host is refused when the config lists none", async () => {
    // The default `egress.google_hosts` is what a fleet gets when it says
    // nothing; this config sets `allow` only. Whatever the default is, the
    // decision must come FROM it rather than from a hardcoded convenience.
    const out = await askChain("CONNECT totally-unlisted.example:443 HTTP/1.1\r\n\r\n");
    expect(out).toContain("403 Forbidden");
  });
});

/**
 * The relay entrypoint starts the proxy (ISC-263).
 *
 * Every other test in this file spawns `connect-proxy.cjs` directly, which
 * proves the proxy and proves nothing about the process the CONTAINER actually
 * runs — its entrypoint is `node /relay/egress-relay.cjs`, and the proxy is
 * started from inside it. Without this, `egress-relay.cjs` could stop calling
 * `startProxy` entirely and every assertion above would stay green while a
 * `cloud_access` worker got connection-refused.
 */
describe("the relay entrypoint starts both listeners (ISC-263)", () => {
  let relayProc: ReturnType<typeof Bun.spawn> | null = null;
  let relayProxyPort = 0;
  let forwardPort = 0;

  beforeAll(async () => {
    relayProxyPort = await freePort();
    forwardPort = await freePort();
    relayProc = Bun.spawn(
      ["node", new URL("../../docker/egress-relay.cjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          PIFLEET_RELAY_TARGETS: JSON.stringify([
            { listenPort: forwardPort, host: "127.0.0.1", port: originPort, name: "omlx" },
          ]),
          PIFLEET_PROXY_POLICY: JSON.stringify({
            rules: [{ name: "origin", host: "127.0.0.1", port: originPort }],
          }),
          PIFLEET_PROXY_PORT: String(relayProxyPort),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await Bun.sleep(600);
    // One fixed 600 ms settle for the relay, which is the whole cost here.
  }, gateBudget([600]));

  afterAll(() => {
    relayProc?.kill();
  });

  test("the port-forward listener still forwards — the proxy did not displace it", async () => {
    const sock: Socket = connect({ host: "127.0.0.1", port: forwardPort });
    await once(sock, "connect");
    let out = "";
    sock.on("data", (d) => {
      out += d.toString("latin1");
    });
    sock.on("error", () => {});
    sock.write("PING");
    await Bun.sleep(300);
    sock.destroy();
    expect(out).toContain("ORIGIN-PONG");
  });

  test("the CONNECT listener is up in the SAME process and enforces the policy", async () => {
    const sock: Socket = connect({ host: "127.0.0.1", port: relayProxyPort });
    await once(sock, "connect");
    let out = "";
    sock.on("data", (d) => {
      out += d.toString("latin1");
    });
    sock.on("error", () => {});
    sock.write("CONNECT nope.example:443 HTTP/1.1\r\n\r\n");
    await Bun.sleep(300);
    sock.destroy();
    // A refusal, not a connection-refused: the difference between the proxy
    // running and denying, and the proxy not being there at all.
    expect(out).toContain("403 Forbidden");
  });
});
