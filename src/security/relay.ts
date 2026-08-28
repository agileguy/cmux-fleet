/**
 * The egress relay — the one sanctioned hole in the deny-all bridge
 * (SRD §5.6, §5.9, §12.4; ISC-50, ISC-51, ISC-57).
 *
 * `src/security/network.ts` puts every worker on an `--internal` Docker
 * bridge: no default route, no NAT, nothing OFF THE BRIDGE SUBNET reachable.
 * That is deny-all in hardware, and it denies the fleet's own model server
 * too. This module stands up the single container that re-opens exactly one
 * destination — the fleet's oMLX endpoint — and nothing else.
 *
 * That endpoint is the Docker host BY DEFAULT and may be a trusted LAN peer
 * (SRD §5.9, ISC-259). The two legs are separately named and separately
 * decided: workers always dial `RELAY_LISTEN_ALIAS` on the internal bridge,
 * while the relay dials `llm.relay_upstream`. Anything but the Docker-host
 * default requires an `egress.allow` entry the operator wrote — see
 * `relayGatePolicy`, which is the check that stops "one destination" from
 * meaning "any destination someone typed into a YAML string".
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
import { isIP } from "node:net";
import { join } from "node:path";
import { assertBindMountsVisible } from "../container/mount-preflight.ts";
import { realExec, repoRoot, type Exec } from "../container/run.ts";
import {
  decide,
  makeRule,
  normalizeHost,
  type EgressConfigView,
  type EgressPolicy,
  type EgressRule,
} from "./egress.ts";
import { assertDockerName, ensureUplinkNetwork } from "./network.ts";

/**
 * The name workers resolve on the INTERNAL bridge — the listen-side alias.
 *
 * This is the DNS alias attached to the relay's endpoint on the egress bridge
 * (`relayConnectArgv`). It is what makes a worker's baked-in
 * `omlx.pifleet.internal:8000` resolve to the relay instead of failing to
 * resolve at all, so `models.json` and `llm.base_url` need no rewriting to
 * work inside a containment they know nothing about.
 *
 * ## The name was an OVERLOAD until ISC-264 renamed it (2026-08-25)
 *
 * It used to be the literal `host.docker.internal`, and that was a deliberate
 * deferral rather than an oversight. Once ISC-259 let the dial side point at a
 * LAN peer, the alias stopped meaning "the Docker host" to a worker and started
 * meaning "wherever this fleet's oMLX lives" — two different claims wearing one
 * name. The deferral rested on two arguments, and the history is kept because
 * one of them is still load-bearing:
 *
 *  1. **The name had no prior meaning on this bridge to shadow.** Measured: a
 *     container on an `--internal` network cannot resolve `host.docker.internal`
 *     AT ALL — Docker's automatic injection does not happen there. Inside the
 *     egress bridge it resolved ONLY because `relayConnectArgv` attached it, so
 *     nothing was being displaced. **Still true, and it is why the overload was
 *     a naming debt rather than a live bug** — anything genuinely wanting the
 *     Docker host from inside the bridge must use the gateway address (SRD
 *     §12.8 measures it as reachable), never this name.
 *  2. **Expired.** `model-probe.ts:hostFacingBaseUrl` used to rewrite exactly
 *     this literal to `localhost` for host-side probing, so a second accepted
 *     spelling would have skipped the rewrite and probed a name the host cannot
 *     resolve. ISC-260 deleted that helper — the `up` probe now runs inside the
 *     egress network and dials `llm.base_url` verbatim, as a worker does.
 *
 * ## What the rename actually FOUND, which is the reason it was worth doing
 *
 * `relayGatePolicy`'s rule 1 authorized `RELAY_LISTEN_ALIAS` at the listen
 * port. Its own documentation describes that rule as covering *the Docker host
 * at the listen port* — the destination the relay may reach without an operator
 * allow entry — and the destination constant is `RELAY_DEFAULT_DIAL_HOST`, a
 * DIFFERENT constant that happened to hold the SAME STRING. So a rule about the
 * dial side was written from a listen-side constant, and nothing could detect
 * it while the two literals agreed.
 *
 * Changing this value made it visible immediately and loudly: with rule 1
 * unchanged, the DEFAULT configuration is refused — target
 * `host.docker.internal:8000` judged against rule `omlx.pifleet.internal:8000`,
 * no match, every fleet dead at launch. Rule 1 now names
 * `RELAY_DEFAULT_DIAL_HOST`. Two constants that mean different things must not
 * be interchangeable by coincidence; this is what that costs when they are.
 *
 * ## Transition
 *
 * `relayConnectArgv` attaches BOTH names, and `relayListenPort` accepts either
 * with a deprecation warning on the old one, so an existing `fleet.yaml`
 * spelling `host.docker.internal` in `base_url` keeps working. See
 * `LEGACY_RELAY_LISTEN_ALIAS`.
 */
export const RELAY_LISTEN_ALIAS = "omlx.pifleet.internal";

/**
 * The name this alias used to have, still attached during the transition.
 *
 * Kept ATTACHED rather than merely accepted in config: a worker's `models.json`
 * is rendered from `llm.base_url`, so a fleet whose config still spells the old
 * name needs the old name to resolve, not just to validate. `relayConnectArgv`
 * therefore attaches both.
 *
 * It is deliberately NOT in `relayGatePolicy`. That policy judges DIAL targets,
 * and the dial-side constant is `RELAY_DEFAULT_DIAL_HOST`, which genuinely is
 * the Docker host and is unaffected by this rename. Adding a legacy listen
 * alias there would re-create exactly the conflation ISC-264 uncovered.
 */
export const LEGACY_RELAY_LISTEN_ALIAS = "host.docker.internal";

/**
 * The DEFAULT dial target's host — used when `llm.relay_upstream` is unset.
 *
 * Was `RELAY_DIAL_HOST`, renamed because it stopped being "the host the relay
 * dials" and became "the host the relay dials WHEN NOBODY SAID OTHERWISE". The
 * old name would now read as a guarantee the code no longer makes.
 *
 * It is a compile-time constant and NOT a config field, which is the property
 * `relayGatePolicy` leans on: the one destination reachable without an
 * operator-written allow rule cannot be steered by editing YAML.
 */
export const RELAY_DEFAULT_DIAL_HOST = "host.docker.internal";

// The pinned image now lives in `./pinned-image.ts` — see that module for why.
// Re-exported here because `RELAY_IMAGE` is the name every importer and the
// argv tests already use, and renaming it would churn them for no gain.
export { RELAY_IMAGE } from "./pinned-image.ts";
import { RELAY_IMAGE } from "./pinned-image.ts";

/**
 * Where the bind-mounted script lands inside the container.
 *
 * The `.cjs` EXTENSION IS LOAD-BEARING — do not "tidy" it back to `.js`. This
 * repo's `package.json` declares `"type": "module"`, so a `.js` file anywhere
 * in the checkout is treated as an ES module and the script's `require()`
 * calls die with `ReferenceError: require is not defined in ES module scope`.
 *
 * It worked in the container regardless, and that is exactly what made it
 * dangerous: the file is mounted ALONE at `/relay/`, with no `package.json`
 * beside it, so Node there falls back to CommonJS. The script was correct only
 * by virtue of where it was mounted — running `node docker/egress-relay.js` on
 * the host to debug it failed instantly, and no amount of exercising the
 * Docker path would ever have revealed that. Caught by
 * `test/integration/relay-script.test.ts`, which runs the script on the host.
 * `.cjs` is CommonJS in both places, by definition rather than by accident.
 */
export const RELAY_SCRIPT_CONTAINER_PATH = "/relay/egress-relay.cjs";

/**
 * The env var carrying the relay's forwarding table.
 *
 * Named once here and used on BOTH sides — `relayRunArgv` stamps it,
 * `liveTargetsFromEnv` reads it back off a running container (ISC-265). It was
 * a bare literal in the argv builder while nothing read it; a drift check makes
 * the two sides a pair, and a pair that spells its own key twice is one typo
 * away from a check that silently never fires. `docker/egress-relay.cjs`
 * carries the third spelling by necessity — it is a separate CommonJS file with
 * no import of this module — and `test/unit/relay.test.ts` pins the argv
 * byte-for-byte, which is what keeps that copy honest.
 */
export const RELAY_TARGETS_ENV = "PIFLEET_RELAY_TARGETS";

// ---------------------------------------------------------------------------
// The CONNECT proxy (ISC-263)
// ---------------------------------------------------------------------------

/**
 * The name a `cloud_access` worker points `HTTPS_PROXY` at.
 *
 * A SECOND alias on the same relay container rather than a reuse of
 * `RELAY_LISTEN_ALIAS`, and the distinction is not cosmetic: that name means
 * "the oMLX endpoint" and is baked into `models.json` and `llm.base_url`.
 * Pointing proxy traffic at it would make one name mean two services, and the
 * first person to debug a 403 would be reading a hostname that says model
 * server.
 */
export const PROXY_LISTEN_ALIAS = "egress.pifleet.internal";

/**
 * The proxy's listen port. 3128 is the conventional forward-proxy port
 * (squid's default), so the value is recognizable to anyone reading a
 * `HTTPS_PROXY` line, and it cannot collide with the relay's listen ports —
 * those come from `llm.base_url`, and `relayListenPort` refusing 3128 is not
 * needed because the two live on the same container and a collision would fail
 * loudly at `listen(2)` rather than silently mis-route.
 */
export const PROXY_LISTEN_PORT = 3128;

export const PROXY_SCRIPT_CONTAINER_PATH = "/relay/connect-proxy.cjs";
export const PROXY_POLICY_SCRIPT_CONTAINER_PATH = "/relay/egress-policy.cjs";
export const PROXY_POLICY_ENV = "PIFLEET_PROXY_POLICY";
export const PROXY_PORT_ENV = "PIFLEET_PROXY_PORT";

/** One forward: accept on `listenPort`, connect to `host:port`. */
export interface RelayTarget {
  readonly listenPort: number;
  readonly host: string;
  readonly port: number;
  readonly name: string;
}

/**
 * The slice of `FleetConfig` this module reads — structural, so nothing here
 * imports the config schema. A superset of `EgressConfigView`, which is what
 * lets `up` pass one config object to both subsystems.
 *
 * It carries the `egress` half — not just `llm` — because `ensureEgressRelay`
 * runs every target it is about to forward through `decide()` (ISC-253). A view
 * narrow enough to build a target but too narrow to build the policy that
 * judges it is precisely how the two drifted apart.
 *
 * `relay_upstream` is optional at the TYPE level so a caller holding a plain
 * `EgressConfigView` still type-checks; absent and `null` mean the same thing
 * (`relayUpstreamFor` derives the Docker-host default), which is what keeps
 * every pre-ISC-259 `fleet.yaml` behaving exactly as it did.
 */
export type RelayConfigView = EgressConfigView & {
  llm: { base_url: string; relay_upstream?: string | null };
};

/** A fully-resolved dial target: an explicit host and an explicit port. */
export interface RelayUpstream {
  readonly host: string;
  readonly port: number;
}

/**
 * Why `raw` cannot be a `relay_upstream` value, or null when it can.
 *
 * Shared with the config schema (`src/config/schema.ts` imports it) so a bad
 * value is a loud, field-level `config validate` error rather than a throw from
 * deep inside `up` after containers exist — the same contract `ruleHostError`
 * keeps for `egress.allow`, for the same reason.
 *
 * ## Why the host must be an IP literal or the Docker-host alias
 *
 * A LAN *hostname* is refused, and this is the measured reason rather than a
 * stylistic one. The relay dials from the uplink bridge, whose resolver is
 * Docker's embedded DNS; that forwards to the host resolver, and on this
 * machine the host resolver **does not answer mDNS/`.local` names** — resolving
 * `macbook.local` needed `dns-sd`, not `getaddrinfo`. A hostname upstream would
 * therefore produce a relay that starts cleanly, reports ready, and then fails
 * every single connection with a resolution error no operator-facing surface
 * shows. Refusing at config-validate time converts that into a sentence.
 *
 * It also keeps `--add-host` honest: with an IP literal there is nothing to
 * resolve and no flag to get wrong (see `relayRunArgv`). An operator who really
 * has a resolvable LAN name should still write its ADDRESS here — the name buys
 * nothing at this layer and costs the failure mode above.
 *
 * An explicit port is REQUIRED, with no default. A bare host would have to
 * inherit a port from somewhere, and every candidate source is the `base_url`
 * this field exists to stop deriving things from.
 */
export function relayUpstreamError(raw: string): string | null {
  const parsed = splitHostPort(raw);
  if (parsed === null) {
    return (
      `${JSON.stringify(raw)} is not a host:port — write an explicit port, e.g. ` +
      `${JSON.stringify("192.168.86.49:8000")} or ${JSON.stringify("[fd00::1]:8000")}`
    );
  }
  const host = normalizeHost(parsed.host);
  if (host === null) return `${JSON.stringify(parsed.host)} is not a valid hostname or IP literal`;
  if (!validPort(parsed.port)) return `invalid port ${JSON.stringify(String(parsed.port))} — expected 1..65535`;
  if (host !== RELAY_DEFAULT_DIAL_HOST && isIP(host) === 0) {
    return (
      `${JSON.stringify(host)} is a hostname; relay_upstream must be an IP literal or ` +
      `${JSON.stringify(RELAY_DEFAULT_DIAL_HOST)}. The relay resolves through Docker's embedded ` +
      `DNS, which forwards to the host resolver — measured NOT to answer mDNS/.local names on ` +
      `this machine — so a name here yields a relay that starts and then fails every connection. ` +
      `Use the address.`
    );
  }
  return null;
}

/**
 * Split `host:port` / `[v6]:port`, or null when the shape is wrong.
 *
 * Hand-written rather than routed through `new URL`, because every scheme that
 * makes `URL` accept a bare authority also makes it accept things this field
 * must refuse — a path, a query, credentials — and silently drop them. Here the
 * whole string must be a host and a port and nothing else.
 */
function splitHostPort(raw: string): { host: string; port: number } | null {
  const s = raw.trim();
  if (s === "") return null;
  let host: string;
  let portText: string;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close === -1 || s[close + 1] !== ":") return null;
    host = s.slice(1, close);
    portText = s.slice(close + 2);
  } else {
    const colon = s.indexOf(":");
    // Exactly one colon: a bare IPv6 literal has several and MUST be bracketed,
    // otherwise `fd00::1` reads as host `fd00` on a port that is not a number.
    if (colon === -1 || s.indexOf(":", colon + 1) !== -1) return null;
    host = s.slice(0, colon);
    portText = s.slice(colon + 1);
  }
  if (host === "" || portText === "") return null;
  // `Number` accepts `" 8000"`, `"0x1f"` and `"8e3"`; a port is decimal digits.
  if (!/^\d+$/.test(portText)) return null;
  return { host, port: Number(portText) };
}

/**
 * Parse a validated `relay_upstream`. Throws on anything `relayUpstreamError`
 * refuses — the schema should have caught it first, so reaching this throw
 * means config validation was bypassed, not that the operator mistyped.
 */
export function parseRelayUpstream(raw: string): RelayUpstream {
  const err = relayUpstreamError(raw);
  if (err !== null) throw new Error(`relay: llm.relay_upstream ${err}`);
  const parsed = splitHostPort(raw)!;
  // Through the SAME normalizer the policy matcher uses, so a trailing root dot
  // or an upper-case spelling cannot read as one host here and another there.
  return { host: normalizeHost(parsed.host)!, port: parsed.port };
}

/**
 * The dial target for this config: explicit `relay_upstream`, or the
 * Docker-host default at the listen port.
 *
 * The default is what makes this change invisible to every existing
 * `fleet.yaml`: absent `relay_upstream`, the relay dials
 * `host.docker.internal:<port from base_url>` — byte-for-byte the behaviour
 * `omlxRelayTarget` had before ISC-259.
 */
export function relayUpstreamFor(cfg: RelayConfigView, listenPort: number): RelayUpstream {
  const raw = cfg.llm.relay_upstream;
  if (raw === null || raw === undefined || raw === "") {
    return { host: RELAY_DEFAULT_DIAL_HOST, port: listenPort };
  }
  return parseRelayUpstream(raw);
}

/**
 * NOTE ON THE HOST-SIDE PROBE VANTAGE (ISC-259 × ISC-260) — nothing to do here.
 *
 * Moving the dial side off-host falsifies any rule that rewrites
 * `llm.base_url` into "something the HOST can reach": `base_url` still names
 * the relay's listen alias (it must — it is what WORKERS dial), so rewriting it
 * to `localhost` probes the Docker host's oMLX while the relay forwards to a
 * LAN peer. Measured here 2026-08-19, and the divergence is not cosmetic:
 * `127.0.0.1:8000` serves 3 models and NONE of `fleet.example.yaml`'s three
 * allowlisted ones, while `192.168.86.49:8000` serves 32 including all three.
 * A localhost-rewriting probe would therefore fail `up` with an allowlist error
 * describing a server the fleet was never going to use.
 *
 * This module deliberately exports NO host-facing URL helper to fix that. The
 * concurrent ISC-260 change deletes the rewrite outright and probes from INSIDE
 * the egress network, dialling `llm.base_url` verbatim exactly as a worker
 * does — so the probe follows whatever this relay forwards, with no second
 * derivation of the endpoint to keep in step. That is the correct fix and it
 * belongs there; a helper here would be a duplicate of a decision this file
 * does not own. Recorded so the absence reads as a decision rather than a gap.
 */

export interface RelayContainerStatus {
  name: string;
  exists: boolean;
  /** True only when the daemon itself reports `State.Running: true`. */
  running: boolean;
  id: string | null;
  /**
   * What this container is ACTUALLY forwarding, read back out of the
   * `PIFLEET_RELAY_TARGETS` env var `relayRunArgv` stamped on it at creation.
   *
   * `null` means the question could not be answered — the variable is absent,
   * unparseable, or does not describe a target list. That is deliberately NOT
   * the same value as `[]`, and the distinction is load-bearing: an empty list
   * is a relay forwarding nothing, while `null` is a relay whose posture this
   * build cannot vouch for (a container from an older build, or one an
   * operator started by hand under the same name). `relayTargetsDrifted`
   * treats `null` as drift, because adopting what you cannot read is the
   * quiet downgrade this module exists to refuse.
   */
  liveTargets: readonly RelayTarget[] | null;
  /** The CONNECT policy it is enforcing, or null if unreadable (ISC-263). */
  livePolicy: EgressPolicy | null;
}

export interface RelayStatus {
  name: string;
  /** False when an already-running relay was adopted unchanged. */
  created: boolean;
  /**
   * What a drifted relay USED to forward, when this run replaced one (ISC-265);
   * `null` on every other path — created fresh, or adopted as-is.
   *
   * Carried separately from `targets` rather than folded into `created`,
   * because "created" now covers two materially different events. A relay
   * created because none existed is unremarkable. A relay created because the
   * previous one pointed somewhere else is the fleet changing model servers
   * under a shared resource, and an operator reading the ledger months later
   * needs the OLD value to reconstruct what the earlier runs were talking to.
   * `null` when the previous targets were unreadable — the replacement still
   * happened, and the honest record is that we cannot say what it displaced.
   */
  replaced: readonly RelayTarget[] | null;
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
 * A `base_url` naming any other host THROWS, and that pin survives ISC-259
 * unchanged, because it is a claim about the LISTEN side only:
 * `RELAY_LISTEN_ALIAS` is the one name aliased onto the internal bridge, so a
 * `base_url` naming anything else describes a listener no worker can reach —
 * the fleet would report a healthy relay while every worker failed to resolve
 * its model server. What ISC-259 changed is the DIAL side, which is now
 * `llm.relay_upstream` and no longer this field at all.
 */
export function omlxRelayTarget(cfg: RelayConfigView): RelayTarget {
  const listenPort = relayListenPort(cfg);
  const upstream = relayUpstreamFor(cfg, listenPort);
  // Listen side and dial side are now genuinely independent: the worker
  // connects to `listenPort` on the alias, and the relay dials `upstream`,
  // which may be another machine entirely (SRD §5.9, ISC-259).
  return { listenPort, host: upstream.host, port: upstream.port, name: "omlx" };
}

/**
 * The port the relay must ACCEPT on — parsed from `llm.base_url`.
 *
 * Still `base_url` and deliberately so: a worker connects to the literal port
 * in its own `base_url`, so that is the port the relay has to be listening on.
 * Port handling mirrors `policyFromConfig` exactly (explicit port, else 443 for
 * https and 80 otherwise) rather than inventing a second rule.
 */
function relayListenPort(cfg: RelayConfigView): number {
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
  if (host === LEGACY_RELAY_LISTEN_ALIAS) {
    // Accepted, and SAID SO. `relayConnectArgv` still attaches this name, so
    // the fleet works — but silently accepting a spelling that is on its way
    // out is how a transition becomes permanent.
    process.stderr.write(
      `pifleet: llm.base_url names ${LEGACY_RELAY_LISTEN_ALIAS}, which is the relay's OLD ` +
        `listen alias. It still resolves, but the name means "the Docker host" and the relay ` +
        `may be forwarding to a LAN peer. Rename it to ${RELAY_LISTEN_ALIAS} (ISC-264); the ` +
        `port and llm.relay_upstream are unaffected.\n`,
    );
  } else if (host !== RELAY_LISTEN_ALIAS) {
    throw new Error(
      `relay: llm.base_url host ${JSON.stringify(url.hostname)} is not ${RELAY_LISTEN_ALIAS} — ` +
        `${RELAY_LISTEN_ALIAS} is the only name resolvable from the internal bridge, so a ` +
        `base_url naming anything else is a listener no worker can reach. To point the fleet ` +
        `at an oMLX on another machine, leave base_url alone and set llm.relay_upstream ` +
        `(SRD §5.9) — base_url describes what WORKERS dial, not where the model server is.`,
    );
  }
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!validPort(port)) {
    throw new Error(`relay: llm.base_url has an invalid port ${JSON.stringify(url.port)}`);
  }
  return port;
}

/**
 * The policy the relay's own targets are judged against — deliberately NOT
 * `policyFromConfig` (ISC-253, ISC-259).
 *
 * ## This function is the whole point of ISC-253
 *
 * The gate that landed in PR #18 was vacuous BY CONSTRUCTION: it judged a
 * target derived from `llm.base_url` against a policy whose `llm` rule was
 * derived from `llm.base_url`. Two derivations of one field agree without
 * anyone checking anything, and a unit test named `DOCUMENTED VACUITY` pinned
 * that so it could not be mistaken for protection.
 *
 * Passing `relay_upstream` to `policyFromConfig` would NOT have fixed it. An
 * operator who writes `base_url: http://192.168.86.49:8000/v1` gets an `llm`
 * rule for `192.168.86.49:8000`, which would then authorize the very upstream
 * under test — the circularity reappears through a different field. The fix has
 * to be a policy that contains **no host derived from config at all** except
 * ones the operator wrote as ALLOW RULES, and that is what this builds:
 *
 *  1. `relay-docker-host` — `RELAY_LISTEN_ALIAS` at the LISTEN port. A
 *     compile-time constant host, unreachable by editing YAML.
 *  2. every `egress.allow` entry, which the operator authored by hand.
 *
 * `egress.google_hosts` is excluded on purpose: the relay does not forward
 * Google (see the header), so letting those rules authorize a relay target
 * would be an allowance for traffic that does not exist.
 *
 * ## What rule 1 costs, stated exactly
 *
 * Rule 1 is why an existing `fleet.yaml` needs no new allow entry, and it is
 * also the ONLY vacuity left: a `base_url` of `http://host.docker.internal:22/v1`
 * with no `relay_upstream` still builds a listen port of 22, a default upstream
 * of `host.docker.internal:22`, and a rule that matches it. That case is
 * BOUNDED and the bound is measured, not assumed — SRD §12.8 records that every
 * port on the bridge gateway is already reachable from the deny-all bridge with
 * no relay running at all, so the relay grants no reachability there that the
 * bridge did not already have. The gate demands operator authorization for
 * exactly the reachability the relay actually CREATES, which is everything
 * off-host.
 *
 * Note what rule 1 does NOT cover, because it is a real tightening over PR #18:
 * an upstream on the Docker host at a port OTHER than the listen port —
 * `base_url` on 8000, `relay_upstream: host.docker.internal:22` — matches no
 * rule and is refused. Under the old gate that combination was unexpressible;
 * under a naive `policyFromConfig` gate it would have passed.
 */
/**
 * The policy the in-container CONNECT proxy enforces (ISC-263).
 *
 * Two sources, and the omission is the interesting part: `egress.google_hosts`
 * on 443, plus every explicit `egress.allow` entry. The `llm` rule that
 * `policyFromConfig` derives from `llm.base_url` is DELIBERATELY ABSENT.
 *
 * Model traffic does not go through this proxy. It goes through the
 * port-forward relay on `RELAY_LISTEN_ALIAS`, which is a different listener on
 * the same container reached by a different name, and a worker's `NO_PROXY`
 * names that alias precisely so its LLM calls never enter here. Carrying an
 * `llm` rule anyway would authorize a destination this path is not meant to
 * serve, and would do it in the one place a reader checks to learn what the
 * proxy can reach.
 *
 * An empty result is legitimate and is not an error: a fleet that configures
 * no Google hosts and no extra allows gets a deny-all proxy, which is the
 * correct posture and still better than no proxy at all — the failure is then
 * a named 403 rather than a connection refused.
 */
export function proxyPolicyFor(cfg: RelayConfigView): EgressPolicy {
  const rules: EgressRule[] = [];
  for (const h of cfg.egress.google_hosts) rules.push(makeRule(`google:${h}`, h, 443));
  for (const r of cfg.egress.allow) rules.push(makeRule(`config:${r.host}:${r.port}`, r.host, r.port));
  return { rules };
}

export function relayGatePolicy(cfg: RelayConfigView): EgressPolicy {
  // `RELAY_DEFAULT_DIAL_HOST`, not `RELAY_LISTEN_ALIAS` (ISC-264). This rule is
  // about the DESTINATION the relay may reach without an operator allow entry —
  // the Docker host — and it was written from the listen-side constant while
  // the two happened to hold the same string. Renaming the listen alias made
  // the mismatch fatal in one step: the default target stopped matching the
  // default rule and every fleet would have refused at launch.
  const rules: EgressRule[] = [
    makeRule("relay-docker-host", RELAY_DEFAULT_DIAL_HOST, relayListenPort(cfg)),
  ];
  for (const r of cfg.egress.allow) {
    rules.push(makeRule(`config:${r.host}:${r.port}`, r.host, r.port));
  }
  return { rules };
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
 * ## What it closes NOW that the dial side is decoupled (ISC-259)
 *
 * This function's own text used to end by describing the gate as a SEAM whose
 * value was future: it judged a `base_url`-derived target against a
 * `base_url`-derived policy, so the two agreed by construction and nothing was
 * actually checked. That is no longer the shape. The target's host and port now
 * come from `llm.relay_upstream`, and the policy comes from `relayGatePolicy`,
 * which contains no config-derived host except the ones the operator wrote into
 * `egress.allow`. The two inputs are independent, so this comparison is a
 * check.
 *
 * The consequence that matters: pointing the fleet at an off-host oMLX takes
 * TWO edits, in two different blocks, one of which is unambiguously a security
 * decision. `llm.relay_upstream: 192.168.86.49:8000` alone is REFUSED —
 * `test/unit/relay.test.ts` proves it by mutation, removing the allow entry and
 * asserting the refusal. Without that, decoupling the dial side would have
 * turned this module into a TCP tunnel from a bridge running untrusted model
 * output to an arbitrary host:port on the operator's LAN, established by
 * editing one YAML string.
 *
 * The one case still decided without an operator-written rule is an upstream on
 * the Docker host at the listen port — `relayGatePolicy`'s rule 1. See that
 * function for why that is bounded by measurement (SRD §12.8) rather than by
 * assumption.
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
/**
 * What the relay container needs in order to ALSO serve CONNECT (ISC-263).
 *
 * `null` at the call site rather than an optional parameter, so adding the
 * proxy is a decision every caller states. An optional argument would let a
 * call site acquire a `cloud_access` role and silently keep launching a relay
 * without a proxy — the credential-granted-for-a-path-that-does-not-exist
 * failure this criterion exists to close, reintroduced by a default.
 */
export interface RelayProxySpec {
  readonly policy: EgressPolicy;
  readonly port: number;
  readonly scriptPath: string;
  readonly policyScriptPath: string;
}

export function relayRunArgv(
  containerName: string,
  uplinkNetwork: string,
  targets: readonly RelayTarget[],
  scriptPath: string,
  proxy: RelayProxySpec | null,
): string[] {
  assertDockerName("container", containerName);
  assertDockerName("network", uplinkNetwork);
  if (targets.length === 0) {
    // A relay with no targets exits 1 immediately (see docker/egress-relay.cjs).
    // Refusing here turns "the fleet has no model server" into a config error
    // at `up` rather than a container that quietly is not there.
    throw new Error("relay: refusing to start a relay with no forwarding target");
  }
  // `--add-host` is emitted ONLY when a target actually dials that name.
  //
  // It is the sole reliable route from the uplink bridge to the Docker host, so
  // it is mandatory for the default upstream. It is also pure noise for a LAN
  // upstream — an /etc/hosts line for a name the relay never looks up — and
  // ISC-259 called that out as the flag becoming "dead weight or a bug". An
  // argv that lists a mapping nothing uses invites the reader to believe the
  // relay reaches the Docker host when it does not, so the honest argv is the
  // one that carries the flag exactly when it is load-bearing.
  //
  // There is no third case to handle: `relayUpstreamError` refuses a hostname
  // upstream outright, so a target is either this alias or an IP literal, and
  // an IP literal needs no resolution at all. That refusal is what keeps this
  // conditional from having to guess at an `--add-host <lanhost>:<ip>`.
  const dialsDockerHost = targets.some((t) => t.host === RELAY_DEFAULT_DIAL_HOST);
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    uplinkNetwork,
    ...(dialsDockerHost ? ["--add-host", `${RELAY_DEFAULT_DIAL_HOST}:host-gateway`] : []),
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
    // The CONNECT proxy and the matcher it requires, mounted read-only beside
    // the relay script. Both are emitted only when a proxy is asked for, so a
    // fleet with no `cloud_access` role runs an argv with no proxy surface in
    // it at all rather than one carrying a disabled feature.
    ...(proxy === null
      ? []
      : [
          "-v",
          `${proxy.scriptPath}:${PROXY_SCRIPT_CONTAINER_PATH}:ro`,
          "-v",
          `${proxy.policyScriptPath}:${PROXY_POLICY_SCRIPT_CONTAINER_PATH}:ro`,
        ]),
    "-e",
    `${RELAY_TARGETS_ENV}=${JSON.stringify(targets)}`,
    ...(proxy === null
      ? []
      : [
          "-e",
          `${PROXY_POLICY_ENV}=${JSON.stringify(proxy.policy)}`,
          "-e",
          `${PROXY_PORT_ENV}=${proxy.port}`,
        ]),
    "--entrypoint",
    "node",
    RELAY_IMAGE,
    RELAY_SCRIPT_CONTAINER_PATH,
  ];
}

/**
 * Attach the relay to the internal bridge under the alias workers resolve.
 *
 * `--alias` IS the mechanism, not a nicety. Without it the relay is reachable
 * only by container name and every worker's baked-in `<alias>:8000` fails to
 * resolve — the internal bridge's embedded DNS does not answer these names on
 * its own.
 *
 * TWO aliases, for the duration of ISC-264's transition. A worker's
 * `models.json` is rendered from `llm.base_url`, so a fleet whose config still
 * spells the old name needs that name to RESOLVE, not merely to pass
 * validation. Both are attached so neither spelling can produce a worker that
 * comes up and cannot reach its model server.
 */
export function relayConnectArgv(egressNetwork: string, containerName: string): string[] {
  assertDockerName("network", egressNetwork);
  assertDockerName("container", containerName);
  return [
    "network",
    "connect",
    "--alias",
    RELAY_LISTEN_ALIAS,
    "--alias",
    LEGACY_RELAY_LISTEN_ALIAS,
    // ISC-263: the name `HTTPS_PROXY` resolves to. Attached unconditionally
    // rather than only when a proxy is configured — an alias costs nothing,
    // and a worker whose env names a host that does not resolve fails with DNS
    // noise instead of the connection-refused that says "no proxy here".
    "--alias",
    PROXY_LISTEN_ALIAS,
    egressNetwork,
    containerName,
  ];
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
  return join(repoRoot(), "docker", "egress-relay.cjs");
}

/** Absolute path to the CONNECT proxy in this checkout (ISC-263). */
export function proxyScriptPath(): string {
  return join(repoRoot(), "docker", "connect-proxy.cjs");
}

/**
 * Absolute path to the SHARED matcher in this checkout (ISC-263).
 *
 * Mounted beside the proxy because the proxy `require`s it, and it is the same
 * file `src/security/egress.ts` imports — the host-side policy and the
 * in-container decision are one implementation, not two that agree.
 */
export function proxyPolicyScriptPath(): string {
  return join(repoRoot(), "docker", "egress-policy.cjs");
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
    const e = entry as { Name?: unknown; Id?: unknown; State?: unknown; Config?: unknown };
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
      liveTargets: liveTargetsFromEnv(e.Config),
      livePolicy: livePolicyFromEnv(e.Config),
    };
  }
  return { name, exists: false, running: false, id: null, liveTargets: null, livePolicy: null };
}

/**
 * Read a running relay's forwarding targets back out of its `Config.Env`.
 *
 * The env var is the right place to read this from, and the alternative is
 * worse in a way worth stating: the targets also appear in `Config.Cmd`-
 * adjacent argv, but only as the JSON this same variable carries, so parsing
 * argv would be a second derivation of one fact. `relayRunArgv` stamps
 * `PIFLEET_RELAY_TARGETS` exactly once, the relay script reads exactly that,
 * and so does this.
 *
 * Returns `null` — never `[]` — for every failure mode, because every one of
 * them means the same thing to the caller: this container's posture is not
 * legible to this build. Malformed JSON does not throw here for the same
 * reason `inspectRelayContainer` does not treat a daemon error as "absent":
 * an unreadable relay must be REPLACED, not crash `up`, and a throw would
 * make an old container an unrecoverable error rather than a stale one.
 */
/**
 * The POLICY a running relay is actually enforcing, read back off the
 * container (ISC-263).
 *
 * The mirror of `liveTargetsFromEnv`, and needed for the same reason ISC-265
 * needed that one: `up` ADOPTS a running relay, and several fleets share it.
 * Without this, an operator who added a host to `egress.google_hosts` would
 * get a relay still enforcing the previous policy — `up` reporting success, a
 * `cloud_access` worker getting a 403 for a destination the config plainly
 * allows, and nothing anywhere saying the two disagree. A stale allowlist that
 * looks applied is the same failure class as a stale forwarding table, and it
 * is worse in one direction: the denial is silent to the operator and loud
 * only inside a container nobody is reading.
 *
 * `null` means "this build cannot vouch for what that relay enforces", which
 * `relayPolicyDrifted` treats as drift — the direction that rebuilds.
 */
function livePolicyFromEnv(config: unknown): EgressPolicy | null {
  if (typeof config !== "object" || config === null) return null;
  const env = (config as { Env?: unknown }).Env;
  if (!Array.isArray(env)) return null;
  const prefix = `${PROXY_POLICY_ENV}=`;
  const row = env.find((v): v is string => typeof v === "string" && v.startsWith(prefix));
  // ABSENT is a real answer and NOT null: a relay launched before the proxy
  // existed, or by a build that passed `proxy: null`, is enforcing no policy
  // at all. Reporting that as "unreadable" would be indistinguishable from a
  // daemon speaking an unexpected dialect, and the two deserve the same
  // REBUILD but not the same diagnosis.
  if (row === undefined) return { rules: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.slice(prefix.length));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rules = (parsed as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return null;
  for (const r of rules) {
    if (
      typeof r !== "object" ||
      r === null ||
      typeof (r as { name?: unknown }).name !== "string" ||
      typeof (r as { host?: unknown }).host !== "string" ||
      typeof (r as { port?: unknown }).port !== "number"
    ) {
      return null;
    }
  }
  return { rules: rules as EgressRule[] };
}

/**
 * Has the enforced policy diverged from what this config wants (ISC-263)?
 *
 * Compared as a SORTED set of `name|host|port`, not as the serialized JSON:
 * rule ORDER is not semantic — `decide` returns the first match and every rule
 * that matches a given (host, port) allows it — so an order change would
 * otherwise cycle a shared relay for no reason, and a relay that rebuilds
 * spuriously is one an operator learns to work around.
 */
export function relayPolicyDrifted(live: EgressPolicy | null, desired: EgressPolicy): boolean {
  if (live === null) return true;
  if (live.rules.length !== desired.rules.length) return true;
  const key = (r: EgressRule) => `${r.name}|${r.host}|${r.port}`;
  const a = live.rules.map(key).sort();
  const b = desired.rules.map(key).sort();
  return a.some((k, i) => k !== b[i]);
}

function liveTargetsFromEnv(config: unknown): readonly RelayTarget[] | null {
  if (typeof config !== "object" || config === null) return null;
  const env = (config as { Env?: unknown }).Env;
  if (!Array.isArray(env)) return null;
  const prefix = `${RELAY_TARGETS_ENV}=`;
  const row = env.find((v): v is string => typeof v === "string" && v.startsWith(prefix));
  if (row === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.slice(prefix.length));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: RelayTarget[] = [];
  for (const t of parsed) {
    if (typeof t !== "object" || t === null) return null;
    const c = t as Record<string, unknown>;
    if (
      typeof c.listenPort !== "number" ||
      typeof c.host !== "string" ||
      typeof c.port !== "number" ||
      typeof c.name !== "string"
    ) {
      return null;
    }
    out.push({ listenPort: c.listenPort, host: c.host, port: c.port, name: c.name });
  }
  return out;
}

/** One target rendered for an operator: `omlx:8000->192.168.86.49:8000`. */
export function formatRelayTarget(t: RelayTarget): string {
  return `${t.name}:${t.listenPort}->${t.host}:${t.port}`;
}

/**
 * Would adopting this running relay serve the current config? (ISC-265)
 *
 * Order-insensitive on purpose: the target list is a SET of forwards, and two
 * relays carrying the same forwards in a different order are the same relay.
 * Comparing the serialized JSON instead would make a reordering in
 * `omlxRelayTarget` read as drift and needlessly cycle a shared container.
 *
 * `live === null` is drift. See `RelayContainerStatus.liveTargets` for why the
 * unreadable case resolves this way rather than the permissive one: the whole
 * point of the check is that adoption stops being an assumption, and "I could
 * not read it, so I assumed it was fine" is the assumption.
 */
export function relayTargetsDrifted(
  live: readonly RelayTarget[] | null,
  desired: readonly RelayTarget[],
): boolean {
  if (live === null) return true;
  if (live.length !== desired.length) return true;
  const key = (t: RelayTarget) => formatRelayTarget(t);
  const liveKeys = [...live].map(key).sort();
  const desiredKeys = [...desired].map(key).sort();
  return liveKeys.some((k, i) => k !== desiredKeys[i]);
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
      return { name, exists: false, running: false, id: null, liveTargets: null, livePolicy: null };
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
 *  - **Running AND forwarding what this config resolves to** → adopted
 *    unchanged, `created: false`. The relay outlives individual runs on
 *    purpose (see the header), so re-creating it on every `up` would cut the
 *    model server out from under a concurrent fleet.
 *  - **Running but forwarding something else** → removed and rebuilt (ISC-265).
 *    See "Adoption compares targets now" below for why this outranks the
 *    concurrent-fleet cost.
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
 * ## Adoption compares targets now (ISC-265, closed 2026-08-23)
 *
 * The first bullet used to end "adopted unchanged" full stop, and that was the
 * defect. An already-running relay was recognized by NAME alone, so changing
 * `llm.relay_upstream` did nothing until an operator ran `docker rm -f` by
 * hand — and after ISC-259 made the dial target configurable, the resulting
 * failure was the dangerous kind rather than the loud kind. Every worker
 * connects successfully, gets real completions, and is talking to the PREVIOUS
 * oMLX. There is no closed port to notice and no error to read. Worse for the
 * amendment's own purpose: the operator who moved the fleet to the LAN server
 * precisely to reach the allowlisted models could still be served by the host
 * oMLX that lacks them.
 *
 * So a running relay is now adopted only if `relayTargetsDrifted` says it
 * already forwards what this config resolves to. On drift it is removed and
 * rebuilt, and `RelayStatus.replaced` names what it USED to forward so the
 * ledger records the swap rather than merely the outcome.
 *
 * **The lifecycle question this deferred, answered.** The worry was that a
 * relay may be serving a concurrent fleet, since `pifleet-egress-relay-<net>`
 * is shared by every fleet on that egress network. Recreating it does cut the
 * model server out from under those workers mid-turn — and it is still right,
 * because the alternative is not "leave the other fleet alone". If the targets
 * have drifted then two configs disagree about where the one shared relay
 * points, and it can only ever satisfy one of them. Adoption does not avoid
 * that conflict; it resolves it silently in favour of whoever booted first,
 * which is both arbitrary and invisible. Recreating resolves it in favour of
 * the most recent `up`, which is at least deterministic, and it leaves a
 * `relay_targets_replaced` row saying so. A wrong answer an operator can read
 * beats a wrong answer nobody can.
 *
 * An unreadable `PIFLEET_RELAY_TARGETS` counts as drift for the same reason —
 * see `RelayContainerStatus.liveTargets`. Adopting a container whose posture
 * this build cannot read would reintroduce the assumption in a new place.
 *
 * `scriptSha256` is still recorded on every run and is still NOT a drift
 * input: the script is bind-mounted from the working tree and re-exec'd by
 * `--restart unless-stopped`, so its hash describes the file on disk now, not
 * the bytes the running relay started with. Cycling a shared relay on a hash
 * that cannot be attributed to it would be a guess. The ledger keeps it
 * answerable after the fact, which is what it was always for.
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
  // …and POLICY before Docker too. Judged against `relayGatePolicy`, NOT
  // `policyFromConfig` — the latter derives its `llm` rule from config fields
  // that also feed the target, so it can only ever agree with itself. See
  // `relayGatePolicy` for why this one cannot.
  assertTargetsAllowed(targets, relayGatePolicy(cfg));
  const containerName = relayContainerName(egressNetwork);
  const uplink = uplinkNetworkName(egressNetwork);
  // Hashed from the path that is about to be mounted, before the mount — so
  // the recorded hash is of the bytes this run actually handed the daemon.
  const scriptSha256 = await relayScriptSha256();

  const existing = await inspectRelayContainer(containerName, exec);
  /**
   * The drift check that makes adoption a decision instead of an assumption
   * (ISC-265). Only meaningful for a RUNNING relay: a stopped one is removed
   * and rebuilt regardless, so asking what it forwarded would change nothing.
   */
  /**
   * The proxy spec, derived from the SAME config this relay was built for
   * (ISC-263).
   *
   * Built unconditionally rather than gated on "does any role have
   * cloud_access". The relay is SHARED — `up` adopts a running one and several
   * fleets depend on it — so gating the proxy on one run's role table would
   * mean the second fleet's `cloud_access` worker silently inherits a relay
   * built without one. The policy is what decides reachability, and a fleet
   * that configures no Google hosts gets an empty policy: a deny-all proxy,
   * which refuses by name rather than by connection-refused.
   */
  const proxy: RelayProxySpec = {
    policy: proxyPolicyFor(cfg),
    port: PROXY_LISTEN_PORT,
    scriptPath: proxyScriptPath(),
    policyScriptPath: proxyPolicyScriptPath(),
  };
  /**
   * Drift is now TWO comparisons, and the second is not optional (ISC-263).
   *
   * `up` adopts a running relay and several fleets share one, so a relay
   * launched before a `egress.google_hosts` edit would keep enforcing the old
   * allowlist: `up` reports success, a `cloud_access` worker gets a 403 for a
   * destination the config plainly allows, and nothing says the two disagree.
   * The forwarding table already had this exact problem and ISC-265 fixed it;
   * adding a second piece of enforced state without extending the check would
   * have reintroduced it beside the fix.
   */
  const drifted =
    existing.exists &&
    existing.running &&
    (relayTargetsDrifted(existing.liveTargets, targets) ||
      relayPolicyDrifted(existing.livePolicy, proxy.policy));
  if (existing.exists && existing.running && !drifted) {
    return { name: containerName, created: false, replaced: null, scriptSha256, targets };
  }
  const replaced = drifted ? existing.liveTargets : null;

  /**
   * The finished launch argv, built before anything is created so its mounts
   * can be checked while a refusal is still free (ISC-292).
   *
   * It is the SAME array `docker run` is handed below — not a reconstruction —
   * because a guard that inspects an argv the launch does not use is a guard
   * that agrees with itself and nothing else.
   */
  const runArgv = relayRunArgv(containerName, uplink, targets, relayScriptPath(), proxy);
  /**
   * ISC-292 at the relay's own launch, because `up`'s guard cannot reach it.
   *
   * `up` asserts bind-mount visibility over the finished WORKER argvs, and not
   * one of the relay's `-v` sources appears on those: `relayScriptPath`,
   * `proxyScriptPath` and `proxyPolicyScriptPath` all resolve under
   * `repoRoot()` — wherever this checkout happens to live — while the worker
   * mounts come from `run.repo`, the runs root and the scratch root. `up` also
   * calls `ensureEgressRelay` some five hundred lines BEFORE that assertion,
   * so even a source the workers did share would be mounted here first.
   *
   * On a VM-backed runtime a checkout outside the shared set does not fail the
   * `docker run` below; it mounts THREE invented empty directories where the
   * relay script, the CONNECT proxy and the shared matcher belong. `docker run
   * -d` exits 0 and the relay dies on `Cannot find module` milliseconds later,
   * which `ensureEgressRelay` then reports as "exited immediately after start"
   * — a message that blames the listen port for a mount problem and sends the
   * operator looking in the wrong place entirely.
   *
   * The finished argv is the only place these values are knowable, for the
   * reason `mount-preflight.ts` states about its own siblings: the offending
   * path is not a literal any reviewer can audit, it arrives from where the
   * operator cloned.
   *
   * ## Only on the LAUNCH path, never on adoption
   *
   * Every early return above this line leaves having mounted nothing: a running
   * relay whose targets and policy have not drifted is adopted as-is and
   * `created: false`. Probing there would charge EVERY `up` a probe container's
   * cold start — the cost `probeBindMountSources` goes to the trouble of paying
   * once per fleet rather than once per mount — for a mount nothing is about to
   * make. So this sits past the last early return, on the launch path only.
   *
   * ## …and BEFORE the first thing that changes the machine
   *
   * Past the early return but ahead of `ensureUplinkNetwork` and the `rm -f`,
   * which is the one placement decision here worth arguing about. Both of those
   * MUTATE: the first creates a bridge network, and the second destroys a relay
   * a concurrent fleet may still be forwarding through. A refusal issued after
   * them would leave the operator with no relay at all, an orphan network, and
   * a message about bind mounts — the guard would have done more damage than
   * the fault it declined. Nothing between here and `docker run` can change
   * this argv's mount sources, so checking early costs no accuracy.
   *
   * `RELAY_IMAGE` is the probe tag for the same reason `up` uses the worker
   * image rather than a probe-specific one: a preflight that pulls an image of
   * its own is slow on a cold machine and fails outright on an offline one.
   * This is the image the relay itself is about to run, so it is either already
   * local or the launch was never going to succeed regardless.
   */
  await assertBindMountsVisible([runArgv], RELAY_IMAGE, exec);

  await ensureUplinkNetwork(uplink);

  if (existing.exists) {
    const removed = await docker(exec, relayRemoveArgv(containerName), 60_000);
    if (removed.code !== 0) {
      // Two callers now, and the message has to serve both: a stopped relay
      // being cleared, and a RUNNING one being cycled because its targets no
      // longer match the config. The second is the case an operator will be
      // surprised by, so it says what it was about to do and why.
      const why = drifted
        ? `while replacing a relay whose targets no longer match this config ` +
          `(was ${(replaced ?? []).map(formatRelayTarget).join(", ") || "unreadable"}; ` +
          `want ${targets.map(formatRelayTarget).join(", ")})`
        : "while clearing a stopped relay";
      throw new Error(
        `relay: 'docker rm -f ${containerName}' failed ${why}: ${removed.stderr.trim()}`,
      );
    }
  }

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

  return { name: containerName, created: true, replaced, scriptSha256, targets };
}
