/**
 * The egress relay — the one sanctioned hole in the deny-all bridge
 * (SRD §5.6, §5.9, §12.4; ISC-50, ISC-51, ISC-57).
 *
 * `src/security/network.ts` puts every worker on an `--internal` Docker
 * bridge: no default route, no NAT, nothing OFF THE BRIDGE SUBNET reachable.
 * That is deny-all in hardware, and it denies the fleet's own model server
 * too. This module stands up the single container that re-opens exactly one
 * destination — oMLX on the Docker host — and nothing else.
 *
 * Read "nothing off the bridge subnet" literally: it is narrower than the
 * "no route to anything" this header used to claim, and the difference is a
 * measured, accepted residual documented under "What the internal bridge does
 * NOT deny" below and in SRD §12.8.
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
 * ## What the internal bridge does NOT deny (SRD §12.8; ISC-51, ISC-57)
 *
 * `--internal` is NOT "no route off this container". Measured 2026-08-19 on
 * `pifleet-egress` (172.18.0.0/16), with no relay running:
 *
 *     172.18.0.0/16 dev eth0 scope link      <- the container's ONLY route
 *     (no default route at all)
 *     nc 172.18.0.1 22  -> SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.13
 *     nc 1.1.1.1 443 / 192.168.86.49 8000 / 192.168.5.2 22 / 169.254.169.254 80
 *                       -> every one refused
 *
 * Docker implements internal-network isolation as FORWARD-chain rules —
 * `-A DOCKER-ISOLATION-STAGE-1 ! -d 172.18.0.0/16 -i br-<id> -j DROP` — but
 * the bridge GATEWAY is on-link and inside that subnet, so gateway-destined
 * traffic is delivered locally through INPUT (policy ACCEPT) and never meets
 * those rules. Every port the Docker host listens on is reachable from this
 * "deny-all" bridge, relay or no relay.
 *
 * The honest reachable set is:
 *
 *     {relay listen ports} ∪ {every port on the bridge gateway}
 *                          ∪ {every port on every sibling container}
 *
 * It is not a fixed set — anything the VM or a sibling binds later joins it
 * with no code change — and on native-Linux Docker the host's listener set is
 * larger than Colima's. This is an ACCEPTED, DOCUMENTED residual (SRD §12.8),
 * not an oversight: closing it needs host-side iptables outside Docker's
 * model, or a Docker host whose gateway serves nothing. ISC-51/57 are
 * therefore worded to what Docker actually guarantees — no route off the
 * bridge SUBNET — and `test/integration/relay.test.ts` asserts the residual as
 * a POSITIVE, so that hardening it later surfaces as a failing test rather
 * than as silent drift between the code and this comment.
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
 *
 * Say the consequence out loud, because no CLI output does: after the first
 * successful `up`, this container carries `--restart unless-stopped` and so
 * comes back on every daemon start and every reboot, INDEFINITELY, whether or
 * not a fleet is running. `down` does not remove it and there is no
 * `--purge-egress` flag. Removal is manual and the ORDER IS FORCED, because
 * Docker refuses to remove a network that still has an endpoint attached and
 * the relay holds two:
 *
 *     docker rm -f pifleet-egress-relay-<egress-network>
 *     docker network rm <egress-network>-uplink
 *     docker network rm <egress-network>        # only if nothing else uses it
 *
 * `relayContainerName` and `uplinkNetworkName` derive those first two names,
 * and both are pure functions of the configured egress network — so the exact
 * strings are always recoverable from `fleet.yaml` alone, with no hunting
 * through `docker ps`.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { realExec, repoRoot, type Exec } from "../container/run.ts";
import {
  decide,
  normalizeHost,
  policyFromConfig,
  type EgressConfigView,
  type EgressPolicy,
} from "./egress.ts";
import { assertDockerName, ensureUplinkNetwork } from "./network.ts";

/**
 * The name workers resolve on the INTERNAL bridge — the listen-side alias.
 *
 * This is the DNS alias attached to the relay's endpoint on the egress bridge
 * (`relayConnectArgv`). It is what makes a worker's baked-in
 * `host.docker.internal:8000` resolve to the relay instead of failing to
 * resolve at all, so `models.json` and `llm.base_url` need no rewriting to
 * work inside a containment they know nothing about.
 */
export const RELAY_LISTEN_ALIAS = "host.docker.internal";

/**
 * The name the relay itself DIALS — the uplink-side target.
 *
 * Deliberately a SEPARATE constant that happens to hold the same string.
 * Today both legs are `host.docker.internal`, and that coincidence is the
 * trick the listen alias above describes. But they are two different
 * resolutions of one literal — the listen side is a Docker network alias on
 * the internal bridge, the dial side is an `--add-host` mapping to the Docker
 * host on the uplink — and conflating them into one constant is what made
 * pointing the dial side elsewhere a redesign instead of a rename (ISC-259).
 * Splitting them now costs nothing and is a prerequisite for that work.
 */
export const RELAY_DIAL_HOST = "host.docker.internal";

/**
 * Plain upstream Node, not the worker image — PINNED BY DIGEST.
 *
 * The relay must not depend on `pifleet image build` having run — `up` would
 * then refuse to start over an unrelated image problem — and it needs nothing
 * the worker image adds. `docker/egress-relay.js` is dependency-free Node for
 * the same reason.
 *
 * The digest is not decoration. This is the ONE container bridging the
 * deny-all bridge to a NAT'd network, it runs `--restart unless-stopped`, and
 * a floating Docker Hub tag means the code on that boundary can change under
 * a machine reboot with no commit in this repo. `test/unit/relay.test.ts`
 * pins the whole argv byte-for-byte, so the digest is pinned by that test for
 * free and cannot drift silently.
 *
 * The digest below is the multi-arch OCI index (`linux/amd64` + `linux/arm64`
 * both present), so it resolves on CI runners and on Apple silicon alike —
 * verified with `docker buildx imagetools inspect node:24-bookworm-slim`.
 *
 * ROLLED: 2026-08-19. To roll it, re-run that command, paste the index
 * `Digest:` here, and update the unit test's expected argv.
 */
export const RELAY_IMAGE =
  "node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";

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
 * imports the config schema. Identical to `EgressConfigView`, which is what
 * lets `up` pass one config object to both subsystems.
 *
 * It carries the `egress` half — not just `llm` — because `ensureEgressRelay`
 * now runs every target it is about to forward through `decide()` (ISC-253).
 * A view narrow enough to build a target but too narrow to build the policy
 * that judges it is precisely how the two drifted apart.
 */
export type RelayConfigView = EgressConfigView;

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
  /**
   * SHA-256 of the relay script THIS checkout would run, and the targets this
   * config resolves to — recorded whether the relay was created or adopted.
   *
   * On an adopted relay these describe what the current checkout WOULD have
   * started, which is the point: adoption never compares targets, so the
   * ledger is where a divergence between runs becomes visible at all.
   */
  scriptSha256: string;
  targets: readonly RelayTarget[];
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
  if (host !== RELAY_LISTEN_ALIAS) {
    throw new Error(
      `relay: llm.base_url host ${JSON.stringify(url.hostname)} is not ${RELAY_LISTEN_ALIAS} — ` +
        `the egress relay forwards only the oMLX endpoint on the Docker host (SRD §5.9), and ` +
        `${RELAY_LISTEN_ALIAS} is the only name resolvable from the internal bridge. ` +
        `Point llm.base_url at the Docker host, or run without an egress network.`,
    );
  }
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!validPort(port)) {
    throw new Error(`relay: llm.base_url has an invalid port ${JSON.stringify(url.port)}`);
  }
  // Listen side and dial side are separate fields even though both resolve to
  // the same literal today — see RELAY_DIAL_HOST.
  return { listenPort: port, host: RELAY_DIAL_HOST, port, name: "omlx" };
}

/**
 * Every destination the relay is about to forward must be ALLOWED by the
 * egress policy (ISC-253).
 *
 * ## What this closes
 *
 * The relay's target list is derived from config, not fixed: `omlxRelayTarget`
 * pins the HOST to a constant but reads the PORT straight out of
 * `llm.base_url`. Nothing previously compared that port to the policy, so the
 * relay was an independent second derivation of "what may be reached" rather
 * than an application of the one in `egress.ts`. This makes it an application.
 *
 * ## What this does NOT close today, and why it is still worth having
 *
 * Be precise about the limit, because the obvious reading of this function is
 * wrong. `policyFromConfig` derives its `llm` rule from THE SAME
 * `llm.base_url` this target came from, with the same port rule. So the two
 * agree BY CONSTRUCTION, and this gate does NOT currently refuse
 * `llm.base_url: http://host.docker.internal:22/v1` — it builds an allow rule
 * for port 22 and then passes the target against it. The circularity is real
 * and is not fixed here.
 *
 * What bounds that case today is `omlxRelayTarget`'s host pin: the worst a
 * bad port can do is expose a port on the Docker host, a machine the operator
 * already fully controls (and which, per SRD §12.8, is reachable from the
 * bridge gateway anyway — so the relay adds no reachability the bridge did not
 * already have).
 *
 * That bound disappears the moment the dial side is decoupled from the listen
 * alias to reach an off-host oMLX (ISC-259). At that point an unchecked,
 * config-derived target becomes a TCP tunnel from a bridge running untrusted
 * model output to an arbitrary host:port, established by editing one YAML
 * string — and this gate is the seam where that gets stopped, PROVIDED the
 * decoupled dial target is judged against an explicit `egress.allow` entry the
 * operator wrote rather than against a rule re-derived from the same field.
 * Landing the seam now makes that a change of input, not a change of design.
 */
export function assertTargetsAllowed(
  targets: readonly RelayTarget[],
  policy: EgressPolicy,
): void {
  for (const t of targets) {
    const verdict = decide(t.host, t.port, policy);
    if (!verdict.allowed) {
      throw new Error(
        `relay: refusing to forward ${t.name} -> ${t.host}:${t.port} — the egress policy denies ` +
          `it (rule: ${verdict.rule}). The relay may only carry destinations decide() allows; ` +
          `add an explicit egress.allow entry for it, or correct llm.base_url.`,
      );
    }
  }
}

/**
 * SHA-256 of the relay script this checkout would bind-mount.
 *
 * The relay EXECUTES a file from a mutable path in the operator's working
 * tree, and `--restart unless-stopped` re-execs whatever is at that path after
 * a reboot. `:ro` stops the container editing it; nothing stops the host. The
 * bind-mount is still the right call (no image rebuild, no `bun` in the worker
 * image), so the gap is closed by RECORDING what was executed rather than by
 * preventing the mount: the hash goes into the `egress_relay_ready` ledger
 * event, so "which code was this relay actually running" is answerable after
 * the fact instead of inferred from the current contents of the file.
 *
 * It also makes an ADOPTED relay auditable: `ensureEgressRelay` adopts a
 * running relay without comparing what it forwards, so the ledger is the only
 * place a target or script change becomes visible across runs.
 */
export async function relayScriptSha256(path: string = relayScriptPath()): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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
    `${RELAY_DIAL_HOST}:host-gateway`,
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
    // Routing is not this container's job. The relay is dual-homed — internal
    // bridge on one side, NAT'd uplink on the other — which is exactly the
    // shape of a router, and Docker leaves `net.ipv4.ip_forward=1` inside the
    // netns by default (measured 1 in the running relay before this flag).
    // `--cap-drop ALL` does NOT turn forwarding off, so the previous posture
    // relied on a property it neither set nor stated. A pivot through it was
    // tested end-to-end and did NOT complete — the return path fails because
    // the host's MASQUERADE matches the uplink subnet, not the internal one —
    // so this is defence in depth against a NAT change, not a live break.
    "--sysctl",
    "net.ipv4.ip_forward=0",
    // The same limits every worker gets (SRD §5.6). The relay sits on the same
    // bridge as the workers and OUTLIVES all of them, so exempting it from the
    // resource posture it shares a network with was an inconsistency, not a
    // decision. Sized well above what a TCP forwarder needs; the point is that
    // an unbounded relay cannot become the fleet's memory or PID sink.
    "--pids-limit",
    "512",
    "--memory",
    "512m",
    "--cpus",
    "1",
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
  return ["network", "connect", "--alias", RELAY_LISTEN_ALIAS, egressNetwork, containerName];
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
 *
 * That limit is FAIR for a port change and becomes UNFAIR the moment the dial
 * target is configurable (ISC-259): adoption would then silently keep
 * forwarding to the old destination, which is not loud anywhere. The mitigation
 * that makes it detectable now and blockable later is the returned
 * `scriptSha256`/`targets` pair, which `up` writes into the
 * `egress_relay_ready` ledger event on EVERY run, adopted or created — so two
 * runs that disagree about what the relay forwards leave a record that says so.
 */
export async function ensureEgressRelay(
  cfg: RelayConfigView,
  egressNetwork: string,
  exec: Exec = realExec,
): Promise<RelayStatus> {
  // Config first, Docker second: an unusable `llm.base_url` should fail before
  // this function has created anything at all.
  const target = omlxRelayTarget(cfg);
  const targets = [target] as const;
  // …and POLICY before Docker too. The relay may only carry what `decide()`
  // allows; see `assertTargetsAllowed` for exactly how much that proves today.
  assertTargetsAllowed(targets, policyFromConfig(cfg));
  const containerName = relayContainerName(egressNetwork);
  const uplink = uplinkNetworkName(egressNetwork);
  // Hashed from the path that is about to be mounted, before the mount — so
  // the recorded hash is of the bytes this run actually handed the daemon.
  const scriptSha256 = await relayScriptSha256();

  const existing = await inspectRelayContainer(containerName, exec);
  if (existing.exists && existing.running) {
    return { name: containerName, created: false, scriptSha256, targets };
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

  const runArgv = relayRunArgv(containerName, uplink, targets, relayScriptPath());
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
      `relay: 'docker network connect --alias ${RELAY_LISTEN_ALIAS} ${egressNetwork} ` +
        `${containerName}' failed: ${connected.stderr.trim() || "(no stderr)"} — without this ` +
        `alias no worker can resolve ${RELAY_LISTEN_ALIAS}. The half-created relay was removed.`,
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

  return { name: containerName, created: true, scriptSha256, targets };
}
