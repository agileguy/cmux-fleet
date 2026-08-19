/**
 * WHERE the ISC-53 probe is asked from (SRD §5.9; ISC-260).
 *
 * `model-probe.ts` decides what the probe ASKS and what the answer MEANS. This
 * module decides the one thing that criterion is actually about: the vantage
 * point. They are split because they fail independently — a correct question
 * asked from the wrong place is precisely the defect ISC-260 names, and it is
 * invisible to every test that only checks the question.
 *
 * ## The defect this exists to remove
 *
 * `up` used to probe oMLX with the host's own `fetch`, through a helper
 * (`hostFacingBaseUrl`) whose entire job was rewriting the WORKER-facing
 * hostname into something the host could reach. Every worker, meanwhile,
 * reaches oMLX from inside `docker.network` — the `--internal` bridge, where
 * `host.docker.internal` resolves to the egress relay and nothing else
 * resolves at all.
 *
 * On a Docker-host-local oMLX those two paths land on the same box, so the
 * asymmetry is invisible. It is not harmless. The gate certifies a model, the
 * fleet launches, and the workers are denied at RUNTIME — "burns a whole run
 * before anyone notices", which is the outcome §5.9 makes this probe mandatory
 * to prevent. A gate that certifies reachability it did not test is worse than
 * no gate, because it is trusted.
 *
 * It stops being invisible the moment oMLX is not on the Docker host, which is
 * the direction the project is going (a trusted-LAN inference server). Note
 * what that does NOT change: nothing here names an oMLX address. The probe
 * dials `llm.base_url` VERBATIM, exactly as a worker does, and whatever the
 * relay chooses to dial upstream is the relay's business. That is what makes
 * this transport topology-independent — moving oMLX rewrites the relay's
 * target, not this file.
 *
 * ## The mechanism
 *
 * One throwaway container, `--network <docker.network>`, running the pinned
 * relay image with a small script that performs exactly one request and prints
 * the result as JSON. Measured on this project's Docker 28 setup rather than
 * reasoned from documentation:
 *
 *  - A container on the internal bridge reached a sibling container's HTTP
 *    server by network alias and got its body back: 200, body intact,
 *    `Authorization` header present at the far end.
 *  - The HOST could not reach that same URL at all —
 *    `Unable to connect. Is the computer able to access the url?`. That
 *    asymmetry is the whole criterion, and `probe-in-network.test.ts` is built
 *    on it: it is what makes "the probe ran from inside the network" a thing a
 *    test can FAIL rather than a claim a comment can make.
 *  - `AbortSignal.timeout` inside the container rejects with `TimeoutError`,
 *    while an unroutable destination rejects with `TypeError: fetch failed`.
 *    Both names cross back intact, so `model-probe.ts`'s timeout-vs-unreachable
 *    split (a real past misdiagnosis) survives the move unchanged.
 *
 * ## Why the request travels on stdin
 *
 * Because the API key is in it. `docker run` argv is visible in `ps` to every
 * user on the host, and `docker inspect` records it for the container's
 * lifetime. The script goes in argv, where it is not secret; the URL, headers
 * and body go in on stdin, where they are not published. Nothing in this file
 * ever interpolates a credential into a command line.
 *
 * ## Why the script is inline rather than bind-mounted
 *
 * The relay bind-mounts its script, and copying that here was the first
 * attempt. It fails: bind mounts only work from paths the Docker VM shares,
 * and a probe that works from a checkout under `/Users` but not from one under
 * a temp dir is a probe whose behaviour depends on where the repo happens to
 * live. Measured directly — the mounted file was simply absent inside the
 * container (`Cannot find module`) and the container exited 1. An inline
 * script has no such dependency, needs no shared-mount configuration, and
 * cannot be edited underneath a running fleet.
 */

import { realExec, type Exec } from "../container/run.ts";
import { assertNetworkName } from "./network.ts";
import { RELAY_IMAGE } from "./relay.ts";
import type { FetchLike, ProbeRequestInit } from "./model-probe.ts";

/**
 * Label stamped on every probe container.
 *
 * Two jobs. For a human it makes an in-flight probe identifiable in
 * `docker ps` rather than looking like a stray Node container. For the
 * `up-wiring` docker shim it is the marker that distinguishes a probe run from
 * the relay's `docker run`, so that fixture can stand in for one without
 * silently absorbing the other.
 */
export const PROBE_CONTAINER_LABEL = "pifleet.probe=native-tool-calls";

/**
 * How long the CONTAINER gets, beyond the deadline the request itself carries.
 *
 * The in-container `AbortSignal.timeout` is the real deadline and normally
 * ends the process on its own; this is only the backstop for a container that
 * never gets as far as running the script (image pull, a wedged daemon). It
 * has to exceed the request deadline or it would pre-empt it and every slow
 * cold load would be reported as the wrong failure class.
 */
const CONTAINER_OVERHEAD_MS = 30_000;

/**
 * The script the probe container runs.
 *
 * Deliberately written with no `$`, no backticks and no template literals.
 * It travels as ONE argv element to `docker run`, and the `up-wiring` fixture
 * re-executes this same text through `sh -c '... bun -e "$SCRIPT"'`; a `$` in
 * the body would be expanded by that shell and the fixture would run something
 * subtly different from production. Keeping the text shell-inert costs one
 * comment and removes a whole class of divergence between the two.
 *
 * It reads one JSON request from stdin, performs it, and writes one JSON
 * result to stdout. It NEVER throws: a transport that dies with a stack trace
 * gives the caller nothing to classify, and `model-probe.ts`'s whole design is
 * that every failure arrives as a named class rather than an exception.
 */
export const PROBE_SCRIPT = [
  'const fs = require("node:fs");',
  'const req = JSON.parse(fs.readFileSync(0, "utf8"));',
  "(async () => {",
  "  try {",
  "    const res = await fetch(req.url, {",
  "      method: req.method,",
  "      headers: req.headers,",
  "      body: req.body,",
  "      signal: AbortSignal.timeout(req.timeoutMs),",
  "    });",
  "    const body = await res.text();",
  '    process.stdout.write(JSON.stringify({ kind: "response", status: res.status, body: body }));',
  "  } catch (err) {",
  "    process.stdout.write(",
  "      JSON.stringify({",
  '        kind: "error",',
  '        name: err && err.name ? String(err.name) : "Error",',
  "        message: err && err.message ? String(err.message) : String(err),",
  "      }),",
  "    );",
  "  }",
  "})();",
].join("\n");

/**
 * The `docker run` argv, exported pure so the unit suite can pin it
 * byte-for-byte without a daemon.
 *
 * Same reason `networkCreateArgv` is exported from `network.ts`: `--network`
 * IS the security property this criterion is about, and a test that only
 * checks "a container ran" passes with it missing. Pinning the whole argv also
 * pins the image digest for free.
 *
 * `--network` is validated through the same `assertNetworkName` the network
 * module uses. Argv arrays stop quoting injection but NOT flag injection — a
 * "network name" of `--privileged` would parse as an option — and the probe
 * takes its network from `fleet.yaml`, which is operator input.
 */
export function containerProbeArgv(network: string, image: string = RELAY_IMAGE): string[] {
  assertNetworkName(network);
  return [
    "docker",
    "run",
    "--rm",
    // stdin carries the request, including the API key. Without `-i` the
    // script reads EOF immediately and every probe fails as malformed.
    "-i",
    "--network",
    network,
    "--label",
    PROBE_CONTAINER_LABEL,
    image,
    "node",
    "-e",
    PROBE_SCRIPT,
  ];
}

export interface ContainerFetchOptions {
  /** `docker.network` — the `--internal` bridge every worker is attached to. */
  network: string;
  /** Overridable for tests; defaults to the relay's digest-pinned image. */
  image?: string;
  /** Overridable for tests; defaults to a real subprocess. */
  exec?: Exec;
}

/** What the container writes to stdout. Anything else is a transport failure. */
type ProbeWireResult =
  | { kind: "response"; status: number; body: string }
  | { kind: "error"; name: string; message: string };

function parseWire(stdout: string): ProbeWireResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (r["kind"] === "response" && typeof r["status"] === "number" && typeof r["body"] === "string") {
    return { kind: "response", status: r["status"], body: r["body"] };
  }
  if (r["kind"] === "error" && typeof r["name"] === "string" && typeof r["message"] === "string") {
    return { kind: "error", name: r["name"], message: r["message"] };
  }
  return null;
}

/**
 * An error carrying a chosen `name`, so a failure raised INSIDE the container
 * classifies on the host exactly as the same failure would have.
 *
 * `model-probe.ts` branches on `err.name === "TimeoutError"` to tell a cold
 * model load apart from a dead server — a distinction this project has the
 * incident report for. That branch reads a name, and a name is the one part of
 * an exception that survives a process boundary, so the transport reconstructs
 * it rather than flattening every remote failure into a generic Error.
 */
class RemoteProbeError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/**
 * A `FetchLike` that performs the request from INSIDE the egress network.
 *
 * Deliberately the same shape as `fetch`, so `model-probe.ts` needs no notion
 * of containers at all and its whole unit suite keeps testing classification
 * against a plain injected double. The only thing that changes between a probe
 * that satisfies ISC-260 and one that does not is which function is passed in
 * — which is exactly the seam a reviewer should be able to check at a glance.
 *
 * The returned `Response` is a REAL one, built from the status and body text
 * the container reported, because the caller reads `.ok`, `.status`, `.json()`
 * and `.text()` off it and a hand-rolled stand-in would have to re-implement
 * all four consistently.
 */
export function containerFetch(opts: ContainerFetchOptions): FetchLike {
  const exec = opts.exec ?? realExec;
  const image = opts.image ?? RELAY_IMAGE;
  const argv = containerProbeArgv(opts.network, image);

  return async (input, init) => {
    const requestInit = (init ?? {}) as ProbeRequestInit;
    /**
     * The deadline travels as a NUMBER, not as the caller's `AbortSignal`.
     *
     * A signal is a host-process object and cannot cross into a container, so
     * the container needs the interval itself to build its own. `init.signal`
     * is still honoured below as a host-side backstop; the in-container
     * deadline is what normally ends the request, which matters because it
     * lets the container exit on its own rather than being killed and leaked.
     */
    const timeoutMs = requestInit.timeoutMs;
    if (typeof timeoutMs !== "number") {
      throw new Error(
        "probe transport: the request carried no timeoutMs. A container cannot be handed the " +
          "caller's AbortSignal, so the deadline has to travel as a number — see ProbeRequestInit.",
      );
    }

    const wireRequest = JSON.stringify({
      url: typeof input === "string" ? input : String(input),
      method: requestInit.method ?? "GET",
      headers: requestInit.headers ?? {},
      body: requestInit.body ?? undefined,
      timeoutMs,
    });

    const run = exec(argv, { stdin: wireRequest, timeoutMs: timeoutMs + CONTAINER_OVERHEAD_MS });

    /**
     * Honour the caller's signal too. `fetch` does, and a `FetchLike` that
     * quietly ignored it would be a double that behaves differently from the
     * thing it stands in for — which is how a substitutable seam stops being
     * substitutable.
     */
    const signal = requestInit.signal;
    const result =
      signal === undefined || signal === null
        ? await run
        : await Promise.race([
            run,
            new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          ]);

    if (result.timedOut) {
      throw new RemoteProbeError(
        "TimeoutError",
        `the probe container on network ${JSON.stringify(opts.network)} did not finish within ` +
          `${timeoutMs + CONTAINER_OVERHEAD_MS}ms and was killed`,
      );
    }

    const wire = parseWire(result.stdout);
    if (wire === null) {
      /**
       * The container failed to speak the protocol. That is a DOCKER problem
       * — a missing image, a network that vanished, a daemon refusing — and
       * not a statement about oMLX or the model, so it is reported with the
       * daemon's own stderr rather than a guess.
       *
       * It surfaces through `model-probe.ts` as `unreachable`, which is the
       * honest class: nothing was learned about the model.
       */
      const detail = (result.stderr.trim() || result.stdout.trim() || "(no output)").slice(0, 400);
      throw new Error(
        `probe transport: the probe container exited ${String(result.code)} without a readable ` +
          `result — ${detail}`,
      );
    }

    if (wire.kind === "error") throw new RemoteProbeError(wire.name, wire.message);

    return new Response(wire.body, {
      status: wire.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
