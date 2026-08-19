/**
 * The egress relay — the one sanctioned hole in the deny-all bridge
 * (SRD §5.6, §5.9, §12.4; ISC-50, ISC-51, ISC-57).
 *
 * `src/security/network.ts` puts every worker on an `--internal` Docker
 * bridge: no default route, no NAT, nothing off the bridge reachable at all.
 * That is deny-all in hardware, and it denies the fleet's own model server
 * too. This module stands up the single container that re-opens exactly one
 * destination — oMLX on the Docker host — and nothing else.
 *
 * ## The mechanism, and why it is this one
 *
 * Measured live on this project's Colima setup (Docker 28/29, macOS), not
 * reasoned from documentation:
 *
 *  - A container on an `--internal` network cannot resolve
 *    `host.docker.internal` AT ALL. Adding
 *    `--add-host=host.docker.internal:host-gateway` makes the name resolve and
 *    the connection still fails — `--internal` genuinely removes the route to
 *    the gateway, so no per-worker flag can reach the host.
 *  - A container on a NON-internal network with that same `--add-host` flag
 *    reaches the real host reliably (3/3 trials, confirmed end-to-end by
 *    hitting the real oMLX server and receiving its own `401`).
 *  - Docker's AUTOMATIC `/etc/hosts` injection of `host.docker.internal` on
 *    ordinary bridges is NOT dependable here — it worked once and then did not
 *    on freshly created networks. `--add-host` is therefore always passed
 *    explicitly rather than relied upon implicitly.
 *  - `docker network connect --alias host.docker.internal <internal-net>` DOES
 *    reliably make Docker's embedded DNS answer that name, on the internal
 *    bridge, with the relay's address.
 *
 * So the shape is: relay's PRIMARY network is a dedicated non-internal uplink
 * (`ensureUplinkNetwork`) so `--add-host` has something to route through; the
 * internal egress bridge is attached SECOND, carrying the alias. Order matters
 * — the `--add-host` mechanism was only reliable when the uplink was the
 * network at `docker run` time. A worker then needs no special flags at all:
 * its baked-in `host.docker.internal:8000` resolves to this container, while
 * `1.1.1.1` and `example.com` remain unreachable.
 *
 * ## What this relay does NOT do
 *
 * It forwards the oMLX target and nothing else. `src/security/egress.ts`'s
 * `policyFromConfig`/`decide` also carry allow rules for the configured Google
 * endpoints (`egress.google_hosts`), and those rules are exhaustively
 * unit-tested — but NO live traffic to `*.googleapis.com` flows through this
 * relay, because a wildcard cannot be a Docker network alias and routing it
 * properly needs an HTTP CONNECT proxy or SNI-based TLS passthrough. That is a
 * separate, larger effort tracked by ISC-253 and is deliberately left open
 * here. A `cloud_access` worker on the internal bridge still cannot reach
 * Google; this module must not be read as claiming otherwise.
 *
 * ## Lifetime
 *
 * The relay is a DURABLE, SHARED resource, like the egress network itself: it
 * is created on demand by `up`, adopted unchanged by every later `up`, and
 * never torn down by `down`. Several fleets share one relay, so tearing it
 * down at the end of any single run would cut the model server out from under
 * whatever else is still running.
 */

import { join } from "node:path";
import { realExec, repoRoot, type Exec } from "../container/run.ts";
import { normalizeHost } from "./egress.ts";
import { assertDockerName, ensureUplinkNetwork } from "./network.ts";

/**
 * The one host this relay is built to forward to, on both legs.
 *
 * On the WORKER side it is the DNS alias that makes the internal bridge answer
 * at all; on the RELAY's own side it is a real name resolved through
 * `--add-host` to the Docker host. Those are different resolutions of the same
 * literal string, and that coincidence is the whole trick: a worker's
 * `models.json` and `llm.base_url` need no rewriting to work inside a
 * containment they know nothing about.
 */
export const RELAY_UPSTREAM_HOST = "host.docker.internal";

/**
 * Plain upstream Node, not the worker image.
 *
 * The relay must not depend on `pifleet image build` having run — `up` would
 * then refuse to start over an unrelated image problem — and it needs nothing
 * the worker image adds. `docker/egress-relay.js` is dependency-free Node for
 * the same reason.
 */
export const RELAY_IMAGE = "node:24-bookworm-slim";

/** Where the bind-mounted script lands inside the container. */
export const RELAY_SCRIPT_CONTAINER_PATH = "/relay/egress-relay.js";

/** One forward: accept on `listenPort`, connect to `host:port`. */
export interface RelayTarget {
  readonly listenPort: number;
  readonly host: string;
  readonly port: number;
  readonly name: string;
}

/**
 * The slice of `FleetConfig` this module reads — structural, so nothing here
 * imports the config schema. `EgressConfigView` satisfies it, which is what
 * lets `up` pass one config object to both subsystems.
 */
export interface RelayConfigView {
  llm: { base_url: string };
}

export interface RelayContainerStatus {
  name: string;
  exists: boolean;
  /** True only when the daemon itself reports `State.Running: true`. */
  running: boolean;
  id: string | null;
}

export interface RelayStatus {
  name: string;
  /** False when an already-running relay was adopted unchanged. */
  created: boolean;
}

/** `1..65535`; anything else would be a listener no worker could find. */
function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The uplink network's name — derived, never configured.
 *
 * Deriving it from the egress network means one config key still describes the
 * whole posture, and two fleets configured with different egress networks get
 * different uplinks rather than silently sharing one.
 */
export function uplinkNetworkName(egressNetwork: string): string {
  assertDockerName("network", egressNetwork);
  const name = `${egressNetwork}-uplink`;
  // Validated AGAIN after composition: the derived name is longer than its
  // input, so a network name Docker accepts can still compose into one it
  // does not. Caught here rather than as an opaque daemon error mid-`up`.
  assertDockerName("network", name);
  return name;
}

/**
 * The relay container's name — derived for the same reason, and load-bearing
 * for idempotence: `ensureEgressRelay` recognizes an existing relay by this
 * name alone, so it must be a pure function of config and nothing else.
 */
export function relayContainerName(egressNetwork: string): string {
  assertDockerName("network", egressNetwork);
  const name = `pifleet-egress-relay-${egressNetwork}`;
  assertDockerName("container", name);
  return name;
}

/**
 * Derive the oMLX forward from `llm.base_url` — never a hardcoded 8000.
 *
 * Port handling mirrors `policyFromConfig` exactly (explicit port, else 443
 * for https and 80 otherwise) rather than inventing a second rule: the policy
 * decides which port is ALLOWED and this decides which port is FORWARDED, and
 * a fleet where those two disagree is denied its own model server with no
 * error anyone can read.
 *
 * `listenPort === port` is not a simplification. A worker connects to the
 * literal port in its own `base_url`, so the relay must accept on that port;
 * and it is forwarding to the same server, so it must dial that port too.
 *
 * A `base_url` naming any other host THROWS. This relay is single-purpose:
 * `host.docker.internal` is the only name aliased onto the internal bridge, so
 * a target built for anything else would be a listener no worker can reach —
 * the fleet would report a healthy relay while every worker failed to resolve
 * its model server. Refusing loudly is the only honest answer; supporting
 * other hosts is real work, not a defaulting decision.
 */
export function omlxRelayTarget(cfg: RelayConfigView): RelayTarget {
  let url: URL;
  try {
    url = new URL(cfg.llm.base_url);
  } catch {
    throw new Error(`relay: llm.base_url is not a URL: ${JSON.stringify(cfg.llm.base_url)}`);
  }
  // Through the SAME normalizer the policy matcher uses, so a trailing root
  // dot or an upper-case spelling cannot read as a different host here while
  // reading as an allowed one there.
  const host = normalizeHost(url.hostname);
  if (host !== RELAY_UPSTREAM_HOST) {
    throw new Error(
      `relay: llm.base_url host ${JSON.stringify(url.hostname)} is not ${RELAY_UPSTREAM_HOST} — ` +
        `the egress relay forwards only the oMLX endpoint on the Docker host (SRD §5.9), and ` +
        `${RELAY_UPSTREAM_HOST} is the only name resolvable from the internal bridge. ` +
        `Point llm.base_url at the Docker host, or run without an egress network.`,
    );
  }
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!validPort(port)) {
    throw new Error(`relay: llm.base_url has an invalid port ${JSON.stringify(url.port)}`);
  }
  return { listenPort: port, host: RELAY_UPSTREAM_HOST, port, name: "omlx" };
}

/**
 * Argv builders are exported pure so the unit suite can pin them byte-for-byte
 * without a daemon — the same contract `networkCreateArgv` keeps, for the same
 * reason. Here the flags that matter are `--network <uplink>` (primary, and it
 * must be the non-internal one), `--add-host` (the only reliable route to the
 * Docker host), and the hardening set: this process listens on a bridge every
 * worker can reach, so it runs read-only, unprivileged, and capability-less.
 */
export function relayRunArgv(
  containerName: string,
  uplinkNetwork: string,
  targets: readonly RelayTarget[],
  scriptPath: string,
): string[] {
  assertDockerName("container", containerName);
  assertDockerName("network", uplinkNetwork);
  if (targets.length === 0) {
    // A relay with no targets exits 1 immediately (see docker/egress-relay.js).
    // Refusing here turns "the fleet has no model server" into a config error
    // at `up` rather than a container that quietly is not there.
    throw new Error("relay: refusing to start a relay with no forwarding target");
  }
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    uplinkNetwork,
    "--add-host",
    `${RELAY_UPSTREAM_HOST}:host-gateway`,
    // Durable and shared: it must come back after a daemon or machine restart,
    // because `up` adopts a running relay and several fleets depend on one.
    "--restart",
    "unless-stopped",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // uid 1000, built into the node image. Nothing here needs root: the listen
    // ports are unprivileged and the mounted script is world-readable.
    "--user",
    "node",
    // So an operator who finds this container months later can tell what owns
    // it — it outlives every run that used it.
    "--label",
    "pifleet.component=egress-relay",
    "-v",
    `${scriptPath}:${RELAY_SCRIPT_CONTAINER_PATH}:ro`,
    "-e",
    `PIFLEET_RELAY_TARGETS=${JSON.stringify(targets)}`,
    "--entrypoint",
    "node",
    RELAY_IMAGE,
    RELAY_SCRIPT_CONTAINER_PATH,
  ];
}

/**
 * Attach the relay to the internal bridge under the alias workers resolve.
 *
 * `--alias host.docker.internal` IS the mechanism, not a nicety. Without it
 * the relay is reachable only by container name and every worker's baked-in
 * `host.docker.internal:8000` fails to resolve — the internal bridge's
 * embedded DNS does not answer that name on its own.
 */
export function relayConnectArgv(egressNetwork: string, containerName: string): string[] {
  assertDockerName("network", egressNetwork);
  assertDockerName("container", containerName);
  return ["network", "connect", "--alias", RELAY_UPSTREAM_HOST, egressNetwork, containerName];
}

export function relayInspectArgv(containerName: string): string[] {
  assertDockerName("container", containerName);
  return ["inspect", containerName];
}

export function relayRemoveArgv(containerName: string): string[] {
  assertDockerName("container", containerName);
  return ["rm", "-f", containerName];
}

/** Absolute path to the relay script in this checkout, resolved from module location. */
export function relayScriptPath(): string {
  return join(repoRoot(), "docker", "egress-relay.js");
}

/**
 * Parse `docker inspect` output for one container.
 *
 * Malformed JSON THROWS rather than reading as "absent", for the reason
 * `parseNetworkInspect` documents: a daemon speaking an unexpected dialect
 * must not cause `ensure` to `docker run` on top of whatever actually exists.
 * `Running` is compared strictly to `true` so an absent or novel field reads
 * as NOT running — the direction that rebuilds, never the one that certifies a
 * relay nobody checked.
 */
export function parseRelayInspect(name: string, stdout: string): RelayContainerStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`relay: unparseable 'docker inspect' output for ${JSON.stringify(name)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`relay: expected a JSON array from 'docker inspect', got ${typeof parsed}`);
  }
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { Name?: unknown; Id?: unknown; State?: unknown };
    // Docker reports container names with a leading slash; accept both so this
    // does not become a dialect assumption.
    if (e.Name !== name && e.Name !== `/${name}`) continue;
    const state = typeof e.State === "object" && e.State !== null
      ? (e.State as { Running?: unknown })
      : {};
    return {
      name,
      exists: true,
      running: state.Running === true,
      id: typeof e.Id === "string" ? e.Id : null,
    };
  }
  return { name, exists: false, running: false, id: null };
}

async function docker(exec: Exec, args: string[], timeoutMs: number) {
  return exec(["docker", ...args], { timeoutMs });
}

/**
 * Report whether the relay container exists and is running.
 *
 * "No such object" is a NORMAL answer. Every other failure throws: conflating
 * "daemon unreachable" with "no relay yet" would send `ensure` into a create
 * it cannot complete, and would let `up` report a posture it never decided.
 */
export async function inspectRelayContainer(
  name: string,
  exec: Exec = realExec,
): Promise<RelayContainerStatus> {
  const r = await docker(exec, relayInspectArgv(name), 30_000);
  if (r.code !== 0) {
    if (/no such object|no such container/i.test(r.stderr)) {
      return { name, exists: false, running: false, id: null };
    }
    throw new Error(`relay: 'docker inspect ${name}' failed: ${r.stderr.trim()}`);
  }
  return parseRelayInspect(name, r.stdout);
}

/**
 * Create the relay if it is not already running; adopt it if it is.
 *
 * Three outcomes, and the difference between them is deliberate:
 *
 *  - **Running** → adopted unchanged, `created: false`. The relay outlives
 *    individual runs on purpose (see the header), so re-creating it on every
 *    `up` would cut the model server out from under a concurrent fleet.
 *  - **Exists but stopped** → REMOVED and rebuilt. This differs from
 *    `ensureEgressNetwork`'s refusal to touch a pre-existing network, and the
 *    difference is ownership: `pifleet-egress-relay-*` is a name only this
 *    function creates, so a dead one is unambiguously our own litter and
 *    clearing it is this module's call. A network wearing the configured name
 *    may well be the operator's.
 *  - **Absent** → created.
 *
 * A partial failure never leaves a half-built relay behind. The container is
 * removed if the alias attach fails, or if it is not running once both steps
 * are done, because a later `ensureEgressRelay` recognizes the relay by NAME —
 * so a broken container under the right name would be adopted as healthy by
 * every subsequent `up`, forever. That is the quiet downgrade this whole
 * subsystem exists to refuse.
 *
 * KNOWN LIMIT: an already-running relay is adopted without comparing its
 * forwarding targets to the current config. Changing `llm.base_url`'s port
 * therefore needs a `docker rm -f <relay>` to take effect. That failure is
 * loud where it lands — the worker connects to a port nothing is listening on
 * — rather than silently reaching the wrong server, which is why it is
 * documented here instead of being guessed at automatically.
 */
export async function ensureEgressRelay(
  cfg: RelayConfigView,
  egressNetwork: string,
  exec: Exec = realExec,
): Promise<RelayStatus> {
  // Config first, Docker second: an unusable `llm.base_url` should fail before
  // this function has created anything at all.
  const target = omlxRelayTarget(cfg);
  const containerName = relayContainerName(egressNetwork);
  const uplink = uplinkNetworkName(egressNetwork);

  const existing = await inspectRelayContainer(containerName, exec);
  if (existing.exists && existing.running) {
    return { name: containerName, created: false };
  }

  await ensureUplinkNetwork(uplink);

  if (existing.exists) {
    const removed = await docker(exec, relayRemoveArgv(containerName), 60_000);
    if (removed.code !== 0) {
      throw new Error(
        `relay: 'docker rm -f ${containerName}' failed while clearing a stopped relay: ` +
          `${removed.stderr.trim()}`,
      );
    }
  }

  const runArgv = relayRunArgv(containerName, uplink, [target], relayScriptPath());
  const started = await docker(exec, runArgv, 120_000);
  if (started.code !== 0) {
    throw new Error(
      `relay: 'docker ${runArgv.join(" ")}' failed: ${started.stderr.trim() || "(no stderr)"}`,
    );
  }

  /** Best-effort teardown so a failed ensure never leaves an adoptable wreck. */
  const destroy = async (): Promise<void> => {
    await docker(exec, relayRemoveArgv(containerName), 60_000).catch(() => undefined);
  };

  const connected = await docker(exec, relayConnectArgv(egressNetwork, containerName), 60_000);
  if (connected.code !== 0) {
    await destroy();
    throw new Error(
      `relay: 'docker network connect --alias ${RELAY_UPSTREAM_HOST} ${egressNetwork} ` +
        `${containerName}' failed: ${connected.stderr.trim() || "(no stderr)"} — without this ` +
        `alias no worker can resolve ${RELAY_UPSTREAM_HOST}. The half-created relay was removed.`,
    );
  }

  // `docker run -d` returning 0 means the container STARTED, not that it is
  // still up: a relay whose listen port is already taken exits within
  // milliseconds, and reporting `egress_relay_ready` for it would be exactly
  // the quiet downgrade above. Verified against the daemon, not against our
  // own argv.
  const after = await inspectRelayContainer(containerName, exec);
  if (!after.running) {
    await destroy();
    throw new Error(
      `relay: container ${containerName} exited immediately after start — the relay is not ` +
        `forwarding ${target.host}:${target.port}. Check that nothing else holds port ` +
        `${target.listenPort} inside the relay, then re-run.`,
    );
  }

  return { name: containerName, created: true };
}
