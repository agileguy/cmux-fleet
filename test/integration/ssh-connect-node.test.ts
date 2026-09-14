/**
 * `docker/ssh-connect.cjs` under the Node the worker image ships
 * (SRD-OBSERVER-ROLES §5.2, task 3.1).
 *
 * WHY THIS EXISTS ALONGSIDE `test/unit/ssh-connect.test.ts`. The unit file
 * spawns whatever `node` is on PATH. On a development Mac that is Bun's `node`
 * wrapper, which reports a TCP reset as a clean end and loses tunnel bytes
 * Node delivers; CI's `test` job installs Bun and pins no Node at all. So
 * nothing there pins what the script does under the runtime it actually runs
 * in. This file runs it under `node:24-bookworm-slim`, by the digest
 * `RELAY_IMAGE` pins, which is also the image CI's `container` job already
 * pulls for the relay. It covers the lifecycle paths where the two runtimes
 * were measured to differ, and the input handling that rests on Node's own URL
 * parser and socket layer.
 *
 * THE SHAPE. One container per test, `--network none`, with the script
 * mounted read-only at `/opt/pifleet/ssh-connect.cjs`, where
 * `docker/Dockerfile` puts it. Everything it talks to is inside that
 * container: `HARNESS`, run as `node -e`, starts a fake CONNECT proxy on
 * loopback, spawns the script with its stdin held open the way ssh holds a
 * ProxyCommand's stdin, and prints one JSON line saying what it saw. With no
 * network there is nothing else the script could reach, so a pass cannot come
 * from somewhere unintended. The harness bounds its own run (`LIMIT_MS`) and
 * reports a child it had to kill as `hung`, so a regression fails an
 * assertion rather than a budget.
 *
 * Every test also asserts the runtime the harness reports. A run that somehow
 * used another runtime would otherwise pass as Node evidence.
 */

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RELAY_IMAGE } from "../../src/security/pinned-image.ts";
import { containerBudget } from "../support/budget.ts";

const DOCKER = process.env["PIFLEET_DOCKER"] === "1";

if (!DOCKER) {
  console.warn(
    `[skip] ssh-connect real-Node tests need a Docker daemon and ${RELAY_IMAGE}. ` + `Run with PIFLEET_DOCKER=1.`,
  );
}

const SCRIPT = fileURLToPath(new URL("../../docker/ssh-connect.cjs", import.meta.url));

/** How long the harness lets the script run before killing it and reporting `hung`. */
const LIMIT_MS = 10_000;

/** The banner the fake target sshd sends straight after a `200`. */
const BANNER = "SSH-2.0-fake\r\n";

/** What stderr must read for the harness's `controls` refusal: every control but tab and LF shown as `\xNN`. */
const CONTROL_STDERR =
  "HTTP/1.1 403 Forbidden\\x1b[2J\\x07\n" + "egress denied\\x1b]0;owned\\x07 by rule\\x0d default-deny\\x00\\x7f\\x9b31m\ttabbed\n";

/**
 * The in-container harness. Plain CommonJS for Node, written with
 * `String.raw` so its `\r\n` escapes reach Node as escapes, and with no `${`
 * anywhere, so nothing in it is interpolated here.
 *
 * Each scenario names the fake proxy's behaviour (`proxy`), the proxy URL the
 * script is given, and optionally what to do before the run (`before`), once
 * the script is spawned (`start`), and as its stdout grows (`stdout`).
 */
const HARNESS = String.raw`"use strict";
const net = require("node:net");
const { spawn } = require("node:child_process");

const SCRIPT = "/opt/pifleet/ssh-connect.cjs";
const scenario = process.argv[1];
const LIMIT_MS = Number(process.argv[2]);
const BANNER = "SSH-2.0-fake\r\n";
const OK = "HTTP/1.1 200 Connection Established\r\n\r\n";
const PIPELINED = Buffer.from(Array.from({ length: 20000 }, (_, i) => 65 + (i % 26)));
const BULK = Buffer.from(Array.from({ length: 4 * 1024 * 1024 }, (_, i) => 97 + (i % 26)));

const report = { node: process.version, runtime: process.versions.bun ? "bun" : "node", connections: 0, hung: false };
const sockets = new Set();

// A hard stop whatever else happens, so the container always ends.
setTimeout(() => process.exit(3), LIMIT_MS + 5000).unref();

/** Wait for the CONNECT request's blank line, record the request line, then hand over. */
function onRequest(socket, then) {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) return;
    socket.removeListener("data", onData);
    report.requestLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
    then();
  };
  socket.on("data", onData);
}

const SCENARIOS = {
  roundtrip: {
    proxy: (s) => onRequest(s, () => {
      s.write(Buffer.concat([Buffer.from(OK), PIPELINED]));
      s.on("data", (d) => s.write(Buffer.concat([Buffer.from("ECHO:"), d])));
      s.on("end", () => s.end());
    }),
    start: (child) => child.stdin.write("PING"),
    stdout: (bytes, child) => { if (bytes >= PIPELINED.length + "ECHO:PING".length) child.stdin.end(); },
    summarize: (r, buf) => {
      r.pipelinedIntact = buf.subarray(0, PIPELINED.length).equals(PIPELINED);
      r.tail = buf.subarray(PIPELINED.length).toString("latin1");
    },
  },
  fin: {
    proxy: (s) => onRequest(s, () => { s.write(OK); s.end(BULK); }),
    summarize: (r, buf) => { r.bulkIntact = buf.equals(BULK); },
  },
  refusereset: {
    target: ["denied.test", "443"],
    before: (r) => new Promise((resolve) => {
      // The control: a plain Node client against the same kind of reset must
      // see ECONNRESET, or this scenario is not testing a reset at all.
      const srv = net.createServer((s) => { s.on("error", () => {}); s.write("x"); setTimeout(() => s.resetAndDestroy(), 50); });
      srv.listen(0, "127.0.0.1", () => {
        const c = net.connect(srv.address().port, "127.0.0.1");
        c.on("data", () => {});
        c.on("end", () => { r.resetControl = "end"; });
        c.on("error", (e) => { r.resetControl = e.code; });
        c.on("close", () => { srv.close(); resolve(); });
      });
    }),
    proxy: (s) => onRequest(s, () => {
      s.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\negress denied by rule default-deny\n");
      setTimeout(() => s.resetAndDestroy(), 100);
    }),
  },
  tunnelreset: {
    proxy: (s) => onRequest(s, () => { s.write(OK + BANNER); setTimeout(() => s.resetAndDestroy(), 100); }),
  },
  epipe: {
    proxy: (s) => onRequest(s, () => {
      s.write(OK);
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let sent = 0;
      const pump = () => {
        if (s.destroyed || sent >= 64 * 1024 * 1024) return;
        sent += chunk.length;
        if (s.write(chunk)) setImmediate(pump);
      };
      s.on("drain", pump);
      pump();
    }),
    stdout: (bytes, child) => { if (bytes >= 1024 && !child.stdout.destroyed) child.stdout.destroy(); },
  },
  ipv6: {
    listen: "::1",
    proxyUrl: "http://[::1]:PORT",
    proxy: (s) => onRequest(s, () => s.end(OK + BANNER)),
  },
  oddstatus: {
    proxy: (s) => onRequest(s, () => s.end("XYZ 200 whatever\r\n\r\n" + BANNER)),
  },
  controls: {
    target: ["denied.test", "443"],
    proxy: (s) => onRequest(s, () => {
      const body = "egress denied\x1b]0;owned\x07 by rule\r default-deny\x00\x7f\x9b31m\ttabbed\n";
      s.end(Buffer.from(
        "HTTP/1.1 403 Forbidden\x1b[2J\x07\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n" + body,
        "latin1",
      ));
    }),
  },
  credentials: {
    proxyUrl: "http://user:s3cret-pw@127.0.0.1:PORT",
    proxy: (s) => onRequest(s, () => s.end(OK + BANNER)),
  },
  https: {
    proxyUrl: "https://127.0.0.1:PORT",
    proxy: (s) => onRequest(s, () => s.end(OK + BANNER)),
  },
};

const sc = SCENARIOS[scenario];
if (sc === undefined) {
  process.stdout.write(JSON.stringify({ error: "unknown scenario " + scenario }) + "\n", () => process.exit(2));
} else {
  (async () => {
    if (sc.before) await sc.before(report);
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      report.connections += 1;
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
      sc.proxy(s);
    });
    // A listen failure (e.g. the ipv6 scenario's "::1" on a container whose
    // loopback has IPv6 disabled) must not fall through to the hard stop's
    // silent process.exit(3): that prints nothing, and the caller sees only
    // "printed no report", which names no cause. Report it, with the error
    // code, and exit at once.
    server.once("error", (listenErr) => {
      // Exits 0, same as a normal report below: the harness DID its job,
      // reporting what happened, so the caller's docker-run-exit-code check
      // is not what should catch this — the parsed report itself is what
      // tells a listen failure apart from a completed scenario.
      process.stdout.write(
        JSON.stringify({ listenError: listenErr.code || listenErr.message }) + "\n",
        () => process.exit(0),
      );
    });
    await new Promise((resolve) => server.listen(0, sc.listen || "127.0.0.1", resolve));
    const proxyUrl = (sc.proxyUrl || "http://127.0.0.1:PORT").replace("PORT", String(server.address().port));
    const target = sc.target || ["tunnel.test", "2222"];
    const child = spawn(process.execPath, [SCRIPT, target[0], target[1]], {
      env: { PATH: process.env.PATH, HTTPS_PROXY: proxyUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    const out = [];
    const err = [];
    let outBytes = 0;
    child.stdout.on("data", (d) => {
      out.push(d);
      outBytes += d.length;
      if (sc.stdout) sc.stdout(outBytes, child);
    });
    child.stderr.on("data", (d) => err.push(d));
    if (sc.start) sc.start(child);
    const limit = setTimeout(() => {
      report.hung = true;
      for (const s of sockets) s.destroy();
      child.kill("SIGKILL");
    }, LIMIT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(limit);
      const buf = Buffer.concat(out);
      report.code = code;
      report.signal = signal;
      report.stderr = Buffer.concat(err).toString("latin1");
      report.stdoutBytes = buf.length;
      if (buf.length <= 65536) report.stdout = buf.toString("latin1");
      if (sc.summarize) sc.summarize(report, buf);
      for (const s of sockets) s.destroy();
      server.close();
      process.stdout.write(JSON.stringify(report) + "\n", () => process.exit(0));
    });
  })();
}
`;

/** One harness run, as reported. `code` is `null` when the harness had to kill the script. */
interface Observation {
  node: string;
  runtime: string;
  connections: number;
  hung: boolean;
  code: number | null;
  signal: string | null;
  stderr: string;
  stdoutBytes: number;
  /** Present only when stdout was at most 64 KiB. */
  stdout?: string;
  requestLine?: string;
  pipelinedIntact?: boolean;
  tail?: string;
  bulkIntact?: boolean;
  resetControl?: string;
}

/** Printed instead of an `Observation` when the harness's own fake proxy could not `listen()`. */
interface ListenFailure {
  listenError: string;
}

/**
 * Run one harness scenario in a fresh container and return its report.
 *
 * The container is named, so a `docker run` that outlives the harness's own
 * hard stop by 30 s can be removed by name rather than left running after the
 * test gives up on it.
 */
async function observe(scenario: string): Promise<Observation> {
  const name = `pifleet-ssh-connect-node-${randomBytes(4).toString("hex")}`;
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      // The ipv6 scenario's fake proxy listens on "::1". A container's
      // loopback IPv6 state is set from the host's own default at namespace
      // creation, not from anything `--network none` implies, so on a host
      // that defaults it off, "::1" would not exist and every scenario using
      // it would fail before the script under test runs at all. Setting it
      // explicitly makes the container's own "::1" independent of that
      // default. Measured on Colima/Docker 28.4.0: unset behaves however the
      // host default says; `=0` always succeeds; `=1` always fails
      // EADDRNOTAVAIL (`net.createServer().listen(0, "::1")`).
      "--sysctl",
      "net.ipv6.conf.lo.disable_ipv6=0",
      "-v",
      `${SCRIPT}:/opt/pifleet/ssh-connect.cjs:ro`,
      RELAY_IMAGE,
      "node",
      "-e",
      HARNESS,
      scenario,
      String(LIMIT_MS),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const watchdog = setTimeout(() => Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }), LIMIT_MS + 35_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(watchdog);
  if (code !== 0) {
    throw new Error(`docker run for scenario ${scenario} exited ${code}\nstdout: ${out}\nstderr: ${err}`);
  }
  const line = out.trim().split("\n").pop() ?? "";
  let parsed: Observation | ListenFailure;
  try {
    parsed = JSON.parse(line) as Observation | ListenFailure;
  } catch {
    throw new Error(`scenario ${scenario} printed no report\nstdout: ${out}\nstderr: ${err}`);
  }
  if ("listenError" in parsed) {
    // Named, rather than falling through to the generic assertions below
    // and failing on `parsed.runtime` being `undefined` — the point of the
    // harness reporting this at all is that the cause reaches here.
    throw new Error(`scenario ${scenario}: the fake proxy failed to listen (${parsed.listenError})\nstdout: ${out}\nstderr: ${err}`);
  }
  expect(parsed.runtime).toBe("node");
  expect(parsed.node).toStartWith("v24.");
  return parsed;
}

describe.skipIf(!DOCKER)("ssh-connect.cjs under node:24-bookworm-slim (SRD-OBSERVER-ROLES §5.2, task 3.1)", () => {
  test(
    "a tunnel round trip: 20 000 bytes pipelined with the 200 arrive intact, then stdin's bytes come back through the tunnel",
    async () => {
      const r = await observe("roundtrip");

      expect(r.hung).toBe(false);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.requestLine).toBe("CONNECT tunnel.test:2222 HTTP/1.1");
      expect(r.pipelinedIntact).toBe(true);
      expect(r.tail).toBe("ECHO:PING");
      expect(r.connections).toBe(1);
    },
    containerBudget(2),
  );

  test(
    "the far side's FIN ends the process with 0 while stdin is held open, after all 4 MiB reach stdout",
    async () => {
      const r = await observe("fin");

      expect(r.hung).toBe(false);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdoutBytes).toBe(4 * 1024 * 1024);
      expect(r.bulkIntact).toBe(true);
    },
    containerBudget(2),
  );

  test(
    "a refusal followed by a reset still prints the status line and the rule, and nothing else",
    async () => {
      const r = await observe("refusereset");

      // Without this the scenario could pass against a close, not a reset.
      expect(r.resetControl).toBe("ECONNRESET");
      expect(r.hung).toBe(false);
      expect(r.code).toBe(1);
      expect(r.stderr).toBe("HTTP/1.1 403 Forbidden\negress denied by rule default-deny\n");
      expect(r.stdoutBytes).toBe(0);
    },
    containerBudget(2),
  );

  test(
    "a tunnel reset by the far side exits 1 with one named ssh-connect: line",
    async () => {
      const r = await observe("tunnelreset");

      expect(r.hung).toBe(false);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^ssh-connect: tunnel connection error: [^\n]*\n$/);
    },
    containerBudget(2),
  );

  test(
    "ssh closing its end of stdout mid-stream (EPIPE) exits 1 with one ssh-connect: line, not a stack trace",
    async () => {
      const r = await observe("epipe");

      expect(r.hung).toBe(false);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^ssh-connect: [^\n]*EPIPE[^\n]*\n$/);
    },
    containerBudget(2),
  );

  test(
    "a bracketed IPv6 proxy literal reaches a proxy listening on ::1",
    async () => {
      const r = await observe("ipv6");

      expect(r.hung).toBe(false);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.connections).toBe(1);
      expect(r.stdout).toBe(BANNER);
    },
    containerBudget(2),
  );

  test(
    "a status line with 200 in the wrong place is reported as a refusal and opens no tunnel",
    async () => {
      const r = await observe("oddstatus");

      expect(r.hung).toBe(false);
      expect(r.code).toBe(1);
      expect(r.stdoutBytes).toBe(0);
      expect(r.stderr.startsWith("XYZ 200 whatever\n")).toBe(true);
    },
    containerBudget(2),
  );

  test(
    "control characters in the proxy's status line and body reach stderr escaped",
    async () => {
      const r = await observe("controls");

      expect(r.hung).toBe(false);
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(CONTROL_STDERR);
    },
    containerBudget(2),
  );

  test(
    "an HTTPS_PROXY carrying credentials is refused without connecting, and they never reach stderr",
    async () => {
      const r = await observe("credentials");

      expect(r.hung).toBe(false);
      expect(r.code).toBe(1);
      expect(r.connections).toBe(0);
      expect(r.stderr).toContain("HTTPS_PROXY");
      expect(r.stderr).not.toContain("s3cret");
    },
    containerBudget(2),
  );

  test(
    "an https: HTTPS_PROXY is refused without connecting, naming http:// and why TLS is not spoken",
    async () => {
      const r = await observe("https");

      expect(r.hung).toBe(false);
      expect(r.code).toBe(1);
      expect(r.connections).toBe(0);
      expect(r.stderr).toContain("http://");
      expect(r.stderr).toContain("TLS");
    },
    containerBudget(2),
  );
});
