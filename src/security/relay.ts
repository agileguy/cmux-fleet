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
import { lookup as dnsLookup } from "node:dns/promises";
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
import { providerIsHosted } from "../config/load.ts";
import { EXIT } from "../contracts.ts";
import { dockerNameGrammarOk, MAX_DOCKER_NAME } from "./docker-names.ts";
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
  /**
   * What the EGRESS POLICY judges this target by, when that is not the string
   * it dials (D9, §6.7, ISC-428). Absent on every non-hosted target, where the
   * two are one string and always were.
   *
   * ## Why the target needs two hosts at all
   *
   * For a `hosted: true` provider, D9 splits a field that used to be one thing
   * into two. `host` is the ADDRESS, resolved on the Docker host at `up` and
   * stamped here, because the relay must dial an address: it resolves through
   * Docker's embedded DNS, and a name matching an alias the relay itself
   * publishes resolves TO THE RELAY, looping every forwarded connection into
   * its own listener. `policyHost` is the NAME the operator wrote in
   * `egress.allow`, because a vendor behind a global load balancer has no
   * published range and authorizing today's A record is a pin that expires.
   *
   * §6.7 anticipated this as *"a change of input, not of mechanism"*, and that
   * is right about `egress.ts` — `normalizeHost` and `decide` already match on
   * names and neither changed. It was incomplete about the target: the changed
   * input had to become REPRESENTABLE first, and a shape with one host cannot
   * say "dial this, judge that".
   *
   * ## Optional, and never a fallback
   *
   * Absent means the pre-D9 rule, unchanged: `host` is judged. That keeps the
   * stronger property on the default path without an edit at any existing call
   * site — the same reason `relayUpstreamError`'s `allowHostname` defaults off.
   *
   * PRESENT means the policy reads THIS AND ONLY THIS. It must never widen to
   * "match either form": an `egress.allow` naming the resolved literal has to
   * be refused even though that literal is exactly what gets dialled, because
   * D9's accepted cost is bounded by the operator authorizing a NAME. Matching
   * either would turn that into "the name, or whatever it currently points at",
   * which is a different and unstated bargain. `test/unit/
   * d9-egress-name-authorization.test.ts` pins the refusal.
   *
   * Deliberately NOT part of `formatRelayTarget`, and so not part of the drift
   * key: drift asks "would adopting this running relay serve the current
   * config", and that is a question about what it FORWARDS. Two relays dialling
   * the same address are the same relay. The authorization is re-checked from
   * config on every `up` regardless, so it cannot go stale by being omitted.
   */
  readonly policyHost?: string;
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

/**
 * The endpoint half of ONE `llm.providers` entry (§6.2) — the only two fields
 * of a provider block this module has any business reading.
 *
 * Structural like everything else here, and deliberately NARROWER than
 * `ProviderSchema`: `api_key_env`, `models_allowlist` and `tag_style` are
 * statements about credentials and about what the fleet will tolerate, and none
 * of them changes a network name, a listen alias or a dial target. Naming them
 * here would invite this file to grow an opinion about them.
 *
 * ## `hosted` is in, and the membership rule is why rather than an exception
 *
 * It used to be on the excluded list above, beside `api_key_env`, and the
 * stated reason was that it *"changes no network name, listen alias or dial
 * target"*. D9 (§6.7) makes that sentence false: a `hosted: true` block may
 * name a HOSTNAME upstream, which `up` resolves on the host and stamps into the
 * target as a literal, so `hosted` is now the flag that decides whether this
 * module dials the string the operator wrote or an address derived from it.
 * That is exactly the membership test the paragraph above states, so `hosted`
 * joins by satisfying the rule rather than by an exemption from it.
 *
 * Optional at the TYPE level — `ProviderSchema` makes it REQUIRED and refuses
 * to infer it (see its `hosted` docblock) — so that a structural fixture or a
 * caller holding an older view still type-checks. Absent reads as `false`,
 * which is the safe direction: the unresolved, IP-literal-only path.
 */
export type ProviderRelayView = {
  base_url: string;
  relay_upstream?: string | null;
  hosted?: boolean;
};

/**
 * The whole `llm:` block as D7 needs to see it: the flat keys, plus the map.
 *
 * `providers` is optional because §6.1 keeps the flat keys as the DEFAULT
 * PROVIDER'S SHORTHAND rather than deprecating them — a `fleet.yaml` with no
 * map is a one-provider fleet spelled the old way, and it must keep working
 * byte-for-byte.
 */
export type FleetRelayConfigView = RelayConfigView & {
  llm: {
    base_url: string;
    relay_upstream?: string | null;
    providers?: Readonly<Record<string, ProviderRelayView>> | undefined;
  };
};

/**
 * Everything D7 derives for ONE provider in use — the unit `up` loops over.
 *
 * Returned as a record rather than left as four call sites computing four
 * strings, because the four are only correct TOGETHER: `uplink` and `relay` are
 * derived from `network`, and `aliases` and `targets` are derived from `view`.
 * A caller that composed `network` itself and then asked for the relay name
 * from something else would be the ISC-264 shape again.
 *
 * `targets` is a LIST holding exactly one entry, and the length is the point.
 * §6.5.4's whole claim about D7 is that one relay per provider restores "exactly
 * one destination" — a claim about a COUNT, which a singular field would make
 * unfalsifiable. A future change that puts a second provider on one relay shows
 * up here as a length of two, and ISC-409's probe fails.
 */
export interface ProviderBridge {
  /** The `llm.providers` key, or the fleet's `llm.provider` for a flat config. */
  readonly provider: string;
  /** This provider's egress network — what its workers attach to. */
  readonly network: string;
  /** `uplinkNetworkName(network)`. */
  readonly uplink: string;
  /** `relayContainerName(network)`. */
  readonly relay: string;
  /** Every name this provider's relay answers to on ITS bridge, and no other. */
  readonly aliases: readonly string[];
  /** Exactly one — see above. */
  readonly targets: readonly RelayTarget[];
  /**
   * What a `hosted: true` block's HOSTNAME upstream resolved to on the host,
   * or `null` when nothing was resolved (D9, §6.7, ISC-426).
   *
   * `null` covers three cases and they are all the same case: a flat fleet, a
   * non-hosted provider (whose schema still refuses a hostname outright), and a
   * hosted provider that wrote a literal anyway. In every one of them
   * `targets[0].host` IS the string the operator wrote, so there is no name to
   * record beside it.
   *
   * ## Why it is a field here rather than recomputed at the ledger
   *
   * `targets[0].host` is the address after resolution; the NAME is gone from it
   * by construction, and that is the point — §6.7's alias loop is only
   * impossible if the name never reaches the relay. So the name has to be
   * carried, and this is the record `up` writes into `egress_relay_ready`.
   * Re-resolving it at the ledger to recover the name would be a SECOND
   * resolution, which could answer differently from the one the relay is
   * actually dialing and turn the audit record into a plausible lie.
   *
   * **Production reads this field** — `up.ts`'s `egress_relay_ready` row. That
   * sentence is here because the last field added to this interface,
   * `targets`, was computed correctly and read by nothing but the tests while
   * `ensureEgressRelay` re-derived its own; see that function for the shape.
   */
  readonly upstreamResolution: RelayUpstreamResolution | null;
  /** The projected view `ensureEgressRelay` is called with (§6.5.4). */
  readonly view: RelayConfigView;
}

/**
 * One hostname and the one address it resolved to, on the host, at `up`.
 *
 * Both halves are kept because ISC-426 asks for both: the relay dials
 * `address`, `egress.allow` authorizes `name` (ISC-428), and *"what did this
 * relay actually dial"* is only answerable months later if the ledger holds the
 * pair rather than either half.
 */
export interface RelayUpstreamResolution {
  /** The hostname exactly as `relay_upstream` spelled it, normalized. */
  readonly name: string;
  /** The IP literal stamped into the relay's target. */
  readonly address: string;
}

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
 * ## The SECOND reason, measured 2026-08-30, which is the stronger one
 *
 * The mDNS argument above is machine-specific and could in principle be fixed
 * by a better resolver. This one cannot be, and it is structural: the relay
 * PUBLISHES `llm.base_url`'s host as an alias on the internal bridge
 * (`relayListenAliases`), and it is attached to that bridge itself. So the
 * relay resolves its own published name TO ITSELF.
 *
 * Measured with a splice container aliased `inference.agileguy.ca`, dialing
 * that same name as its upstream:
 *
 *     from the bridge   getent hosts inference.agileguy.ca -> 172.19.0.3
 *     from the RELAY    dns.lookup("inference.agileguy.ca") -> 172.19.0.3  (itself)
 *     client            fetch -> Connect Timeout after 10s
 *
 * Every forwarded connection loops back into the relay's own listener. It is
 * not a resolution error and not a refusal — it is a hang, on the one path a
 * fleet cannot run without, and nothing in `docker logs` says why. An IP
 * literal has nothing to resolve and therefore cannot loop.
 *
 * An explicit port is REQUIRED, with no default. A bare host would have to
 * inherit a port from somewhere, and every candidate source is the `base_url`
 * this field exists to stop deriving things from.
 *
 * ## `allowHostname`, and why it is a parameter rather than a second function
 *
 * `SRD-INFERENCE-PROVIDERS` D9 (§6.7) permits a HOSTNAME upstream in one place
 * and one place only: a `hosted: true` block in `llm.providers`, where the
 * address belongs to a vendor behind a global load balancer with no published
 * range, so pinning a literal is a recurring manual chore against a target that
 * moves. There, `up` resolves the name ON THE HOST and stamps the literal into
 * the target, so the relay still dials an address and neither of the two
 * failures above can occur.
 *
 * Everything else in this function applies to that case unchanged — the
 * `host:port` shape, the explicit port, the hostname/IP well-formedness — which
 * is why this is one flag on one function rather than a second, nearly
 * identical validator that would drift from this one on the next edit.
 *
 * The flag is OFF by default, so every existing caller keeps the stronger rule
 * without an edit, and D9's scoping — "a non-hosted provider's block still
 * refuses a hostname at `config validate`" — is enforced by omission rather
 * than by remembering to pass `false`.
 */
export function relayUpstreamError(
  raw: string,
  { allowHostname = false }: { allowHostname?: boolean } = {},
): string | null {
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
  if (!allowHostname && host !== RELAY_DEFAULT_DIAL_HOST && isIP(host) === 0) {
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
 *
 * ## `allowHostname` has to be here too, and its absence was a live defect
 *
 * Phase 2 landed D9's schema half — `ProviderSchema` passes
 * `{ allowHostname: block.hosted }`, so a hosted block PARSES with a hostname
 * — and stopped there. This function kept `relayUpstreamError`'s default, so a
 * `fleet.yaml` that `config validate` accepted still threw from inside `up`
 * the moment `providerRelayTarget` read it: *"is a hostname; relay_upstream
 * must be an IP literal"*, about a field the validator had just approved. Found
 * by ISC-426's tests, not by the type checker — the flag is a default, and a
 * default cannot be forgotten loudly.
 *
 * The default stays `false` for the same reason it does on `relayUpstreamError`:
 * every existing caller keeps the stronger rule with no edit, and D9's scoping
 * is enforced by omission rather than by remembering to pass `false`.
 */
export function parseRelayUpstream(
  raw: string,
  { allowHostname = false }: { allowHostname?: boolean } = {},
): RelayUpstream {
  const err = relayUpstreamError(raw, { allowHostname });
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
export function relayUpstreamFor(
  cfg: RelayConfigView,
  listenPort: number,
  { allowHostname = false }: { allowHostname?: boolean } = {},
): RelayUpstream {
  const raw = cfg.llm.relay_upstream;
  if (raw === null || raw === undefined || raw === "") {
    return { host: RELAY_DEFAULT_DIAL_HOST, port: listenPort };
  }
  return parseRelayUpstream(raw, { allowHostname });
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
  const name = `${RELAY_NAME_PREFIX}${egressNetwork}`;
  // Re-checked after composition, and under D7 this is the check that actually
  // binds: `RELAY_NAME_PREFIX` is 21 characters, so the relay's name is the
  // LONGEST string an operator-chosen provider key feeds. `providerKeyBudget`
  // reserves exactly this much room so the refusal arrives with the field
  // named; this stays as the backstop that proves the bound is real.
  assertDockerName("container", name);
  return name;
}

/**
 * The relay container name's fixed prefix — a constant because a budget is
 * computed from its LENGTH (ISC-412).
 *
 * Spelling it inline in `relayContainerName` and again as a `21` inside
 * `providerKeyBudget` is two facts that must agree and nothing making them:
 * renaming the prefix would silently move the real limit while the budget kept
 * reserving room for the old one, and the fleet would go back to failing with
 * the derived-string message this criterion exists to replace.
 */
export const RELAY_NAME_PREFIX = "pifleet-egress-relay-";

/**
 * The longest provider key this fleet's `docker.network` leaves room for.
 *
 * Derived, never a literal: `MAX_DOCKER_NAME` comes from `docker-names.ts`
 * where it is enforced, and the overhead comes from `RELAY_NAME_PREFIX` plus
 * the single `-` that `providerNetworkName` joins with. The three names a key
 * feeds are
 *
 *     network  <net>-<key>                            net + 1 + key
 *     uplink   <net>-<key>-uplink                     net + 1 + key + 7
 *     relay    pifleet-egress-relay-<net>-<key>       net + 1 + key + 21
 *
 * and the relay is the longest of the three, so bounding the key by the relay
 * bounds all of them. That ordering is the whole reason a key can pass the
 * NETWORK check and still blow the limit twenty characters later, which is the
 * case ISC-412 names and the one a naive `128 - net - 1` budget would miss.
 */
export function providerKeyBudget(egressNetwork: string): number {
  return MAX_DOCKER_NAME - RELAY_NAME_PREFIX.length - egressNetwork.length - 1;
}

/**
 * Refuse an operator-chosen provider key NAMING THE FIELD (ISC-412).
 *
 * ## Why `assertDockerName` alone was not enough, when the bound already existed
 *
 * It did already refuse: the composed relay name goes through
 * `assertDockerName("container", …)` and a 128-character bound is enforced
 * there. What it produced was
 *
 *     egress: invalid docker network name "pifleet-egress-<something enormous>"
 *
 * — a string the operator never typed, from a module named for egress, with no
 * mention of `llm.providers` anywhere in it. Every other value this codebase
 * composes into a Docker name is one it derived itself, so naming the derived
 * string has always been the same as naming the input. A PROVIDER KEY is the
 * first one that is not: it is the operator's own word, and §6.5.2 calls this
 * "the first composed name in this codebase that a long config value can push
 * past Docker's limit". A refusal that does not say WHICH KEY, and by HOW MUCH,
 * leaves the operator to reverse the composition by hand to find their own
 * typo.
 *
 * ## Both halves name the field, not just the length one
 *
 * The grammar check moved in here too. A key of `--driver=host` is exactly as
 * operator-chosen as a long one, and the flag-injection hazard
 * `docker-names.ts` exists to close is reported best by pointing at the config
 * key that carries it.
 *
 * The remedy names BOTH inputs because the budget is a function of both: the
 * fleet's `docker.network` spends from the same 128 characters, so an operator
 * whose key is already short learns that the network name is what left no room
 * rather than being told to shorten something that cannot get shorter.
 */
export class ProviderKeyError extends Error {
  /**
   * USAGE, and the integer is the half of ISC-412 that a plain `Error` lost.
   *
   * `providerNetworkName` is reached from TWO call sites and the one that fires
   * first is not the obvious one: `renderAllWorkers` runs at `up.ts:1016`,
   * `egressBridgePlan` at `up.ts:1186`, so the render path always throws first
   * and it is NOT inside the plan's `try`. A bare `Error` therefore escaped
   * undiagnosed and `up` announced a config typo as
   *
   *     pifleet: internal error: egress: invalid docker network name "aaaa…"
   *     EXIT=8
   *
   * `index.ts` is explicit that an internal error means *"file a bug, do not fix
   * the command line"*, which is precisely the wrong instruction for an
   * operator who mistyped their own `llm.providers` key.
   *
   * Typed rather than wrapped at the call site: `exitCodeForError` dispatches
   * structurally through `isExitCoded`, so one typed throw is correct from BOTH
   * paths at once. Wrapping `up.ts:1016` would fix only the path that happens
   * to run first today, and would go quietly wrong the moment the order moved.
   */
  readonly exitCode = EXIT.USAGE;
  constructor(message: string) {
    super(message);
    this.name = "ProviderKeyError";
  }
}

export function assertProviderKey(egressNetwork: string, provider: string): void {
  if (!dockerNameGrammarOk(provider)) {
    throw new ProviderKeyError(
      `relay: llm.providers.${JSON.stringify(provider)} is not a usable provider key. A key ` +
        `becomes part of a Docker network and container name, so it must start with a letter ` +
        `or digit and contain only letters, digits, '_', '.' and '-'. Rename the key in ` +
        `llm.providers.`,
    );
  }
  const budget = providerKeyBudget(egressNetwork);
  if (provider.length > budget) {
    const composed = `${RELAY_NAME_PREFIX}${egressNetwork}-${provider}`;
    throw new ProviderKeyError(
      `relay: llm.providers.${JSON.stringify(provider)} is ${provider.length} characters, ` +
        `${provider.length - budget} too long. It composes into the relay container name ` +
        `${JSON.stringify(composed)}, which is ${composed.length} characters and Docker's ` +
        `limit is ${MAX_DOCKER_NAME}. Shorten the key in llm.providers to at most ${budget} ` +
        `characters, or shorten docker.network ${JSON.stringify(egressNetwork)} ` +
        `(${egressNetwork.length} characters), which spends from the same budget.`,
    );
  }
}

/**
 * ONE provider's egress network — `<docker.network>-<provider>` (D7, §6.5.2).
 *
 * The third derivation in this trio and the one that makes the other two
 * per-provider without either of them changing a line: `uplinkNetworkName` and
 * `relayContainerName` are pure functions of a network name, so composing one
 * more level in FRONT of them turns a fleet-wide uplink and a fleet-wide relay
 * into a per-provider pair for free. That is the property §6.5.2 leans on when
 * it calls D7 cheap, and it is why this is a separate function rather than an
 * argument threaded through those two.
 *
 * The header's promise survives it — *"the exact strings are always recoverable
 * from `fleet.yaml` alone, with no hunting through `docker ps`"*. There are
 * simply more of them now, one set per provider key the operator wrote.
 *
 * Validated after composition for the same reason `uplinkNetworkName` is, and
 * here the check finally earns its keep rather than merely being consistent: a
 * provider key is OPERATOR-CHOSEN, so `pifleet-egress-relay-<network>-<provider>`
 * is the first composed name in this codebase that a long config value can push
 * past Docker's limit (§6.5.2). It fails at `up` NAMING THE FIELD — §6.5.2's
 * wording, and ISC-412's — which is the right failure. An earlier revision of
 * this docblock said "naming the composed string"; that was the behaviour, and
 * it was the bug: see `assertProviderKey`.
 */
export function providerNetworkName(egressNetwork: string, provider: string): string {
  assertDockerName("network", egressNetwork);
  /*
   * The provider key alone, BUDGETED AGAINST THE RELAY NAME rather than merely
   * checked as a network name (ISC-412).
   *
   * `assertDockerName("network", provider)` stood here and refused too late in
   * two different ways. It bounded the key at 128 on its own, so a key that fit
   * a network name and then overflowed the 21-character-longer relay name got
   * past it and blew up further down the call; and when it did refuse, it named
   * a derived string rather than `llm.providers.<key>`. One call closes both.
   */
  assertProviderKey(egressNetwork, provider);
  const name = `${egressNetwork}-${provider}`;
  // Unreachable on LENGTH now — the budget above reserves the relay's prefix,
  // which is strictly more room than this name needs — and kept anyway as the
  // backstop for the composed grammar. A guard that only ever fires when the
  // one above is wrong is exactly the guard worth keeping.
  assertDockerName("network", name);
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
 * The endpoint the relay must PUBLISH and ACCEPT on — parsed from `llm.base_url`.
 *
 * Still `base_url` and deliberately so: a worker connects to the literal host
 * and port in its own `base_url`, so those are what the relay has to answer to.
 * Port handling mirrors `policyFromConfig` exactly (explicit port, else 443 for
 * https and 80 otherwise) rather than inventing a second rule.
 *
 * ## The host is no longer pinned to the built-in alias (ISC-369)
 *
 * It used to THROW on any host but `RELAY_LISTEN_ALIAS`, and the reasoning was
 * sound for the mechanism that existed: that alias was the only name attached
 * to the internal bridge, so a `base_url` naming anything else described a
 * listener no worker could resolve. The pin was enforcing a consequence of
 * `relayConnectArgv`'s hardcoded alias list, not a property of the network.
 *
 * Deriving the alias list from THIS field instead (`relayListenAliases`) makes
 * the invariant hold by construction rather than by refusal: whatever host a
 * worker is told to dial is the host the relay publishes. The check that used
 * to say "it must be this one name" now says "it must be a name that can be
 * published, and must not shadow one that already means something else".
 *
 * ## What this unlocks, and it is the reason the pin came out
 *
 * A `base_url` of `https://inference.agileguy.ca/v1` with a `relay_upstream` of
 * that endpoint's ADDRESS. The relay splices raw TCP, so TLS runs END TO END
 * between the worker and the real origin — the worker sends the correct SNI and
 * validates the real certificate, because as far as it is concerned it dialed
 * the real name. Measured 2026-08-30 from inside `pifleet-egress`: `200`, 229ms,
 * 32 models, `Qwen3.5-35B-A3B-8bit` present. Nothing in the relay parses,
 * terminates or re-originates the TLS; it cannot, and that is the property that
 * makes this safe to allow.
 *
 * The control ran in the same breath and matters as much: an UNALIASED public
 * name from the same bridge still fails to resolve at all
 * (`getaddrinfo EAI_AGAIN example.com`). Publishing one name does not open the
 * bridge; it opens that name, to the one upstream `egress.allow` authorized.
 */
interface RelayListenEndpoint {
  /** Normalized `base_url` host — the name the relay publishes on the bridge. */
  readonly host: string;
  readonly port: number;
}

function relayListenEndpoint(cfg: RelayConfigView): RelayListenEndpoint {
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
  if (host === null) {
    throw new Error(
      `relay: llm.base_url host ${JSON.stringify(url.hostname)} is not a valid hostname`,
    );
  }
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
    // A published endpoint. Two things it may not be, and both are refusals
    // rather than warnings because each produces a fleet that comes up and
    // then fails somewhere the message would not point at.
    //
    // An IP LITERAL cannot be a Docker network alias at all — `docker network
    // connect --alias 1.2.3.4` is accepted by the CLI and answers nothing, so
    // the worker's dial would leave the bridge and be dropped. Refusing here
    // turns a silent black hole into a sentence.
    if (isIP(host) !== 0) {
      throw new Error(
        `relay: llm.base_url host ${JSON.stringify(url.hostname)} is an IP literal. base_url is ` +
          `the name WORKERS dial and the relay publishes it as a Docker network alias, which ` +
          `cannot be an address. Use ${RELAY_LISTEN_ALIAS} (and set llm.relay_upstream to the ` +
          `address), or a DNS name the relay can publish.`,
      );
    }
    // LOOPBACK NAMES resolve inside the worker before DNS is ever consulted,
    // so publishing one as a bridge alias produces a name that answers — as
    // the worker's own loopback, where nothing is listening. That is a
    // connection refused against a relay reported healthy, and it is
    // indistinguishable from a dead model server. RFC 6761 reserves the whole
    // `localhost` tree for exactly this resolution behaviour, so the subtree
    // goes with the name.
    //
    // A SINGLE-LABEL name is refused with it. Docker's embedded DNS will
    // publish one, but a worker's resolver may append a search domain first and
    // reach something else entirely — a name whose meaning depends on
    // `/etc/resolv.conf` is not a name this can promise resolves to the relay.
    if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
      throw new Error(
        `relay: llm.base_url host ${JSON.stringify(host)} cannot be published as the relay's ` +
          `listen alias — loopback names resolve inside the worker before DNS, and a ` +
          `single-label name resolves through whatever search domain the container inherits. ` +
          `Use ${RELAY_LISTEN_ALIAS}, or a dotted DNS name the relay can publish unambiguously.`,
      );
    }
    // SHADOWING. Publishing a name on the internal bridge makes that name mean
    // "the relay's TCP splice" for every worker on it. For the proxy alias and
    // for any `egress.google_hosts` entry the name already means something
    // else — the CONNECT proxy, and the destinations it is allowed to reach —
    // so republishing it would silently re-point traffic the operator
    // authorized through one mechanism into a different one.
    const shadowed = [PROXY_LISTEN_ALIAS, ...cfg.egress.google_hosts]
      .map((h) => normalizeHost(h))
      .filter((h): h is string => h !== null && h === host);
    if (shadowed.length > 0) {
      throw new Error(
        `relay: llm.base_url host ${JSON.stringify(host)} would shadow a name that already has ` +
          `a meaning on the egress bridge (${shadowed.join(", ")}). Publishing it as the relay's ` +
          `listen alias re-points traffic the CONNECT proxy is meant to carry into the TCP ` +
          `splice, which forwards to llm.relay_upstream and nowhere else. Choose another name.`,
      );
    }
  }
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!validPort(port)) {
    throw new Error(`relay: llm.base_url has an invalid port ${JSON.stringify(url.port)}`);
  }
  return { host, port };
}

function relayListenPort(cfg: RelayConfigView): number {
  return relayListenEndpoint(cfg).port;
}

/**
 * Every name the relay must answer to on the INTERNAL bridge (ISC-369).
 *
 * ONE derivation, consumed by `relayConnectArgv`. The list used to be three
 * hardcoded constants in that function, which is what forced `relayListenPort`
 * to refuse any `base_url` naming something else: the alias set could not
 * follow the config, so the config was made to follow the alias set.
 *
 * Ordered and de-duplicated so the argv is stable across runs — an argv that
 * reorders for no reason cannot be pinned byte-for-byte, and the byte-for-byte
 * pin is what stops an alias silently disappearing from a launch.
 */
export function relayListenAliases(cfg: RelayConfigView): string[] {
  const { host } = relayListenEndpoint(cfg);
  const aliases = [
    RELAY_LISTEN_ALIAS,
    LEGACY_RELAY_LISTEN_ALIAS,
    // ISC-263: the name `HTTPS_PROXY` resolves to. Attached unconditionally
    // rather than only when a proxy is configured — an alias costs nothing,
    // and a worker whose env names a host that does not resolve fails with DNS
    // noise instead of the connection-refused that says "no proxy here".
    PROXY_LISTEN_ALIAS,
  ];
  // Appended, never inserted: the three built-ins keep their positions so an
  // existing pinned argv stays valid, and a published endpoint is visibly the
  // thing this config added.
  if (!aliases.includes(host)) aliases.push(host);
  return aliases;
}

/**
 * Project the fleet config down to the `RelayConfigView` for ONE provider.
 *
 * **This one function is why D7 changed nothing downstream of it.** §6.5.4's
 * claim — *"`ensureEgressRelay`'s `const targets = [target] as const` needs no
 * change at all"* — is only true because the per-provider-ness is resolved
 * HERE, before the relay code runs, rather than by teaching every function
 * below about a map. `omlxRelayTarget`, `relayListenEndpoint`,
 * `relayListenAliases`, `relayGatePolicy` and `ensureEgressRelay` all keep
 * reading a single `llm.base_url` and a single `llm.relay_upstream`; they are
 * simply handed a different pair per provider.
 *
 * ## The `egress` half is carried through UNPROJECTED, and that is D7's bound
 *
 * `egress.allow` and `egress.google_hosts` stay fleet-wide, so every provider's
 * relay is judged against the SAME operator-authored allowlist and every
 * provider's CONNECT proxy enforces the same policy. §6.5.5 states the bound
 * exactly: **D7 partitions MODEL reachability, not ALL reachability.** Splitting
 * `egress.allow` per provider would be a second, unrequested feature, and it
 * would quietly weaken `relayGatePolicy` — an operator's single hand-written
 * allow entry is what authorizes a dial target, and per-provider allowlists is
 * how one of them ends up authorizing nothing.
 *
 * ## Why a missing key THROWS instead of falling back to the flat block
 *
 * Inheriting the flat block is how a second provider silently acquires oMLX's
 * URL — the exact failure `ProviderSchema` refuses field by field when it
 * declines to copy the defaults down. The schema already refuses a worker whose
 * `provider` is not declared, so reaching here with an unknown key means the two
 * disagree, and a fleet that comes up pointing the wrong way is worse than one
 * that does not come up.
 */
export function relayViewForProvider(cfg: FleetRelayConfigView, provider: string): RelayConfigView {
  const providers = cfg.llm.providers;
  // No map: §6.1's shorthand. The flat keys ARE this provider's block, so the
  // config is already its own view and pre-D7 fleets behave identically.
  if (providers === undefined) return cfg;
  const block = providers[provider];
  if (block === undefined) {
    throw new Error(
      `relay: worker resolves to provider ${JSON.stringify(provider)}, which llm.providers does ` +
        `not declare — declared: ${Object.keys(providers).join(", ") || "(none)"}. The relay ` +
        `will not fall back to the flat llm.base_url: that is how a second provider silently ` +
        `acquires the default endpoint, and its credential with it.`,
    );
  }
  return {
    llm: { base_url: block.base_url, relay_upstream: block.relay_upstream ?? null },
    egress: cfg.egress,
  };
}

/**
 * The one target ONE provider's relay carries, named after the provider.
 *
 * Split from `omlxRelayTarget` rather than parameterising it, because the NAME
 * is the whole difference and `omlxRelayTarget`'s `"omlx"` is load-bearing for a
 * flat fleet: the name is serialized into `PIFLEET_RELAY_TARGETS` and compared
 * by `relayTargetsDrifted`, so renaming it on the flat path would report every
 * existing relay as drifted and cycle it on the next `up` for no reason at all.
 */
export function providerRelayTarget(
  view: RelayConfigView,
  provider: string,
  { allowHostname = false }: { allowHostname?: boolean } = {},
): RelayTarget {
  const listenPort = relayListenPort(view);
  const upstream = relayUpstreamFor(view, listenPort, { allowHostname });
  return { listenPort, host: upstream.host, port: upstream.port, name: provider };
}

/**
 * Every bridge this run must stand up — one per provider IN USE (D7, §6.5.2).
 *
 * `resolved` is the provider each of THIS RUN'S workers resolves to, in launch
 * order, duplicates and all. That argument shape is the containment property
 * ISC-410 names, and it is worth being precise about why: the plan is built from
 * what workers RESOLVED TO, never from `Object.keys(llm.providers)`. A provider
 * an operator declared and no worker selected therefore contributes no network,
 * no uplink, no relay container and no listen alias — there is no code path by
 * which its name reaches Docker at all. **The fleet-wide design could not express
 * that**: it published every declared endpoint as an alias on one shared bridge,
 * so declaring a provider WAS opening a route to it for every worker on the
 * fleet, whether or not anything used it (§6.5.1).
 *
 * Ordered and de-duplicated, in the same first-wins way `relayListenAliases` is
 * and for the same reason: `up` walks this list creating networks and
 * containers, and a list that reorders between runs makes an idempotent
 * operation look like a changing one in the ledger.
 *
 * ## The flat config is NOT composed, and that is a decision
 *
 * With no `llm.providers` map the network stays the operator's `docker.network`
 * verbatim instead of becoming `<network>-omlx`. §6.5.2's table states the
 * composition unconditionally, but §6.1 is the governing sentence: the flat keys
 * are *"retained as the default provider's shorthand"*, so a fleet with no map
 * has exactly one provider and NOTHING TO PARTITION. Composing anyway would
 * rename the network and the relay of every fleet that never asked for this
 * feature, strand the relay each of them is running behind a name nothing looks
 * for any more, and buy precisely nothing — D7's property is that reach tracks
 * SELECTION, and where there is one provider every worker selects it.
 *
 * The cost, stated because it is real: writing a `providers:` map that declares
 * a single endpoint identical to the flat keys DOES move the network. That is
 * the migration, not an accident — opting into the map is opting into
 * per-provider bridges — and it is one rule with one boundary rather than a
 * per-field guess about which shape the operator meant.
 */
/**
 * The network a worker on `provider` attaches to — THE ONE PLACE THAT DECIDES.
 *
 * Read by `egressBridgePlan`, which CREATES the bridges, and by
 * `config/render.ts`, which ATTACHES workers to them. Those two agreeing is not
 * optional and must not be arranged by two copies of the same ternary: a worker
 * attached to a network no relay is on reaches nothing, and Docker does not
 * refuse it — `docker run --network` on an absent name is an error, but on the
 * BASE network it is a clean start onto a bridge whose relay serves a different
 * provider's upstream. That is a worker dialing its own `base_url` and getting
 * somebody else's endpoint, which is the failure §6.5.4 exists to prevent.
 *
 * This repo has closed that shape twice already, both times by deleting a
 * predicate rather than duplicating it: ISC-188's mount-source rule, and D8's
 * `/secrets` gate, where `render.ts` and `materialize.ts` each spelled out
 * `w.secrets.length > 0` and would have diverged. One function, two callers.
 *
 * A FLAT fleet keeps the base network unchanged, byte for byte. §6.1 calls the
 * flat block a shorthand for a one-provider map, but composing `<net>-<name>`
 * for it would rename the network every existing run already uses and orphan
 * every adopted relay — a migration this feature has no reason to ask for.
 */
export function workerEgressNetwork(
  cfg: FleetRelayConfigView,
  egressNetwork: string,
  provider: string,
): string {
  return isFlatFleet(cfg) ? egressNetwork : providerNetworkName(egressNetwork, provider);
}

/**
 * Whether this fleet uses the flat `llm.*` shorthand rather than a providers map.
 *
 * ONE reading of `llm.providers === undefined`, for the same reason this module
 * now has one reading of the network name. Two decisions genuinely turn on this
 * fact — which network a worker attaches to, and which target-naming function
 * keeps a running relay's `PIFLEET_RELAY_TARGETS` stable — and they are
 * different decisions that must never disagree about which fleet they are in.
 * Spelling the condition twice is how they would eventually.
 */
export function isFlatFleet(cfg: FleetRelayConfigView): boolean {
  return cfg.llm.providers === undefined;
}

/**
 * Resolve a hostname to its addresses, ON THE HOST. Injected so no test dials
 * DNS and no fixture depends on a vendor's live A record.
 */
export type HostAddressLookup = (hostname: string) => Promise<readonly string[]>;

/**
 * The production `HostAddressLookup`: `getaddrinfo`, in this process, on the
 * host — which is the whole of D9's mechanism (§6.7).
 *
 * `dns.promises.lookup` and NOT `dns.resolve4`. The distinction is the reason
 * the resolution is specified as happening "on the host" rather than merely
 * "before the container": `lookup` goes through the platform resolver, so it
 * honours `/etc/hosts`, the search domains, and whatever the operator's VPN or
 * corporate resolver has configured — the same answer any other program on that
 * machine would get. `resolve4` talks to a nameserver directly and would
 * silently disagree with the machine it is running on, which is a worse failure
 * than not resolving at all: the fleet would dial an address the operator
 * cannot reproduce with `getent`.
 *
 * `verbatim: true` so the platform's own ordering arrives here untouched;
 * `chooseUpstreamAddress` then imposes its own order, and it must be choosing
 * from what the resolver said rather than from what Node re-sorted.
 */
export async function lookupHostAddresses(hostname: string): Promise<readonly string[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

/**
 * A resolution that did not produce a usable address — a config or network
 * fault, never a bug in pifleet.
 *
 * Its own class because `up` must map it to a DIFFERENT exit code from the rest
 * of `egressBridgePlan`'s throws. Everything else that function raises is a
 * config error (an undeclared provider, a composed name Docker will not take)
 * and exits `USAGE`, telling the operator to edit `fleet.yaml`. A resolver that
 * did not answer is `BACKEND_UNAVAILABLE`: the config may be perfect and the
 * VPN merely down, and sending that operator to edit a correct file is the
 * wrong instruction. Distinguished by type rather than by matching the message,
 * because a message is not an interface.
 */
export class RelayUpstreamResolutionError extends Error {
  constructor(
    readonly provider: string,
    readonly hostname: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `relay: could not resolve llm.providers.${provider}.relay_upstream host ` +
        `${JSON.stringify(hostname)} on this host: ${detail}. A hosted provider may name a ` +
        `hostname (D9, SRD §6.7), but 'up' must stamp the ADDRESS into the relay's target — the ` +
        `relay resolves through Docker's embedded DNS, where this name would either fail every ` +
        `connection or, if it matches an alias this relay publishes, resolve to the relay ` +
        `itself and hang. Check the name and this machine's resolver, then re-run.`,
      options,
    );
    this.name = "RelayUpstreamResolutionError";
  }
}

/**
 * Sort key that puts IPv4 first and orders each family deterministically.
 *
 * The `"4:"`/`"6:"` prefix does the family preference and the padding does the
 * ordering, so one key expresses both and they cannot drift apart.
 */
function addressSortKey(address: string): string {
  if (isIP(address) === 4) {
    return `4:${address.split(".").map((o) => o.padStart(3, "0")).join(".")}`;
  }
  return `6:${address.toLowerCase()}`;
}

/**
 * Pick ONE address out of an RRset, deterministically.
 *
 * ## Why not simply the resolver's first answer
 *
 * Because a global load balancer's RRset ROTATES. `relayTargetsDrifted` keys on
 * `formatRelayTarget`, which contains the host, and a relay whose targets have
 * "drifted" is torn down and rebuilt — a relay this module documents as SHARED,
 * which other fleets on that bridge are forwarding through. Taking the
 * resolver's first answer would therefore cycle a live relay on every `up`
 * against any name with more than one A record, for no configuration change at
 * all. Sorting costs nothing and makes the target a function of the RRset's
 * CONTENTS rather than of its order.
 *
 * ## Why IPv4 wins when both families are offered
 *
 * The relay dials from a Docker bridge, and Docker's daemon does not enable
 * IPv6 on user-defined bridges unless the operator turns it on. Choosing a AAAA
 * on a v4-only bridge produces a relay that starts cleanly, reports ready and
 * fails every connection — §6.7's exact failure shape, reintroduced by the
 * mechanism meant to remove it. Stated from Docker's documented default rather
 * than from a measurement taken here; the deterministic ordering below is what
 * this file actually proves.
 *
 * Returns `null` for an empty or entirely unparseable list rather than
 * throwing, so the caller owns the one error message.
 */
export function chooseUpstreamAddress(addresses: readonly string[]): string | null {
  const usable = addresses.filter((a) => isIP(a) !== 0);
  if (usable.length === 0) return null;
  return usable.slice().sort((a, b) => (addressSortKey(a) < addressSortKey(b) ? -1 : 1))[0]!;
}

/**
 * THE ONE PLACE A HOSTNAME UPSTREAM BECOMES AN ADDRESS (D9, §6.7, ISC-426).
 *
 * Called from `egressBridgePlan` and nowhere else, which is the containment
 * this criterion is really about: `egressBridgePlan` is the single derivation
 * of what a relay dials, so stamping the literal HERE means every consumer
 * downstream — `ensureBridgeRelay`, `relayRunArgv`, `PIFLEET_RELAY_TARGETS`,
 * the ledger row — carries the address without any of them knowing a
 * resolution happened. A second call site would be a second answer to "what
 * does this relay dial", which is the defect D7 shipped and §6.5.4 now guards.
 *
 * ## The two hosts that are NOT resolved, and both matter
 *
 * An IP LITERAL is returned untouched: there is nothing to resolve, and running
 * `getaddrinfo` on it would make a hosted block with a pinned address depend on
 * a resolver it currently does not need.
 *
 * `RELAY_DEFAULT_DIAL_HOST` is returned untouched and the reason is mechanical:
 * `relayRunArgv` detects that exact string in the target list and adds
 * `--add-host host-gateway`, which is how the container reaches the Docker
 * host. Resolving it here would substitute an address, the string would no
 * longer match, the flag would not be added, and the relay would dial whatever
 * this MACHINE thinks `host.docker.internal` means — usually nothing. It is
 * also not a name the resolution exists for: D9's chore is a vendor's address
 * behind a load balancer, not Docker's own alias.
 */
async function stampUpstreamAddress(
  provider: string,
  host: string,
  lookup: HostAddressLookup,
): Promise<string> {
  let addresses: readonly string[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new RelayUpstreamResolutionError(provider, host, detail, { cause: err });
  }
  const address = chooseUpstreamAddress(addresses);
  if (address === null) {
    throw new RelayUpstreamResolutionError(
      provider,
      host,
      addresses.length === 0
        ? "the resolver returned no addresses"
        : `the resolver returned no usable IP address (got ${JSON.stringify(addresses)})`,
    );
  }
  return address;
}

export async function egressBridgePlan(
  cfg: FleetRelayConfigView,
  egressNetwork: string,
  resolved: readonly string[],
  lookup: HostAddressLookup = lookupHostAddresses,
): Promise<ProviderBridge[]> {
  const seen = new Set<string>();
  const plan: ProviderBridge[] = [];
  for (const provider of resolved) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    const view = relayViewForProvider(cfg, provider);
    const network = workerEgressNetwork(cfg, egressNetwork, provider);
    /*
     * ONE READING OF `hosted`, feeding BOTH halves of D9 — and that is the
     * invariant, not a convenience.
     *
     * The same flag that PERMITS a hostname here is the flag that REQUIRES it
     * to be resolved before the relay sees it. Read twice, they could disagree,
     * and the disagreement has a direction that matters: permitted-but-unresolved
     * is a hostname reaching Docker's embedded DNS, which is §6.7's alias loop —
     * a hang with nothing in `docker logs`. Read once, that state is not
     * expressible.
     *
     * `hosted !== true` — which includes EVERY flat fleet, since the flat
     * shorthand has no `hosted` field to set — means `allowHostname` stays
     * `false` AND no resolution runs, so a pre-D7 fleet's plan is unchanged
     * byte for byte and no non-hosted provider acquires a resolution step it
     * did not have. `ProviderSchema` refuses a hostname on those blocks at
     * `config validate` (ISC-427), so both layers say the same thing.
     */
    // Through `providerIsHosted` rather than inline, because §7.3's disclosure
    // banner now keys on the same flag: a second reading of it here is how the
    // relay and the banner come to disagree about which endpoints are a
    // vendor's, and a worker the banner omits is the silent bring-up ISC-417
    // forbids. The expression is unchanged — see that function's docblock.
    const hosted = providerIsHosted(cfg, provider);
    // `omlxRelayTarget` on the flat path keeps the name `"omlx"` that every
    // running relay already has stamped in `PIFLEET_RELAY_TARGETS`; see
    // `providerRelayTarget` for why that is not cosmetic.
    const target = isFlatFleet(cfg)
      ? omlxRelayTarget(view)
      : providerRelayTarget(view, provider, { allowHostname: hosted });
    /*
     * `hosted` HERE IS REDUNDANT, AND THAT IS MEASURED RATHER THAN ASSUMED.
     *
     * Deleting it from this line was mutation-tested and NOTHING went red —
     * across the whole suite, not one file. The reason is the `allowHostname`
     * on the line above: a non-hosted block naming a hostname is REFUSED by
     * `providerRelayTarget` before this expression is evaluated, so no input
     * exists that can distinguish this clause's presence from its absence.
     * `omlxRelayTarget` refuses the same way on the flat path.
     *
     * It stays, and the reason is not superstition. Without it the line reads
     * *"resolve any hostname"*, and its correctness then lives entirely in a
     * guard fifteen lines up — one relaxation of the parse away from silently
     * resolving names on blocks D9 explicitly refuses to weaken. With it, the
     * two halves of the decision are spelled at the point each is used.
     *
     * What must NOT be read into it: this clause is not the enforcement. The
     * enforcement is `allowHostname: hosted` above and `ProviderSchema`'s
     * `superRefine` below that (ISC-427). A future reader hunting for what
     * stops a non-hosted hostname should look there, and a future editor who
     * deletes this line has broken nothing today.
     */
    const resolvable =
      hosted && isIP(target.host) === 0 && target.host !== RELAY_DEFAULT_DIAL_HOST;
    /*
     * ONE RESOLUTION, and everything D9 needs is read off it.
     *
     * Three facts fall out of this single step and they must not be able to
     * disagree: the address the relay DIALS (`target.host`), the name the
     * egress policy JUDGES (`target.policyHost`, ISC-428), and the pair the
     * ledger RECORDS (`upstreamResolution`). Held as one object rather than as
     * three assignments, so there is no edit that sets one and forgets another
     * — and the failure of forgetting is not cosmetic in any of the three
     * directions. A `host` left as the name is §6.7's alias loop. A missing
     * `policyHost` is every hosted relay refused at `default-deny`, which is
     * what ISC-428 measured before this field existed. A missing record is a
     * relay nobody can afterwards say what it dialled.
     */
    const resolution: RelayUpstreamResolution | null = resolvable
      ? { name: target.host, address: await stampUpstreamAddress(provider, target.host, lookup) }
      : null;
    plan.push({
      provider,
      network,
      uplink: uplinkNetworkName(network),
      relay: relayContainerName(network),
      // Derived from THIS provider's view, so a provider's hostname is
      // published on its own bridge and on no other — and so `NO_PROXY` can be
      // built per network rather than per fleet (§6.5.5).
      aliases: relayListenAliases(view),
      // The LITERAL, never the name. `relayRunArgv` serializes this into
      // `PIFLEET_RELAY_TARGETS` verbatim, so a name surviving to here is a name
      // the relay would hand to Docker's embedded DNS (§6.7).
      // The LITERAL is dialled, the NAME is judged. `relayRunArgv` serializes
      // this straight into `PIFLEET_RELAY_TARGETS`, so a name left in `host`
      // is a name the relay hands to Docker's embedded DNS (§6.7); a name
      // missing from `policyHost` is a relay `assertTargetsAllowed` refuses at
      // `default-deny` (ISC-428). Both are set from `resolution` or neither is.
      targets: [
        resolution === null
          ? target
          : { ...target, host: resolution.address, policyHost: resolution.name },
      ],
      upstreamResolution: resolution,
      view,
    });
  }
  return plan;
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
 *
 * ## What D9 changes here, and what it costs (§6.7, ISC-428)
 *
 * For a `hosted: true` provider the thing DIALLED and the thing AUTHORIZED stop
 * being the same string: `up` resolves the name on the Docker host and stamps
 * the literal into `target.host`, while the operator writes the NAME in
 * `egress.allow`. So this loop reads `policyHost` where one is present.
 *
 * §6.7 called that *"a change of input, not of mechanism"*. Correct about the
 * mechanism — `normalizeHost` and `decide` were already name-matchers and did
 * not change — and incomplete about the input, which had to become
 * representable before it could be changed: with one host per target, this
 * function compared the resolved literal against a name-carrying allowlist and
 * refused the relay at `default-deny`. D9 did not work at all until the target
 * could carry both.
 *
 * **The property this gate holds for a hosted target is therefore weaker, in a
 * way worth stating rather than burying.** It is no longer *"the operator
 * authorized this exact address"* but *"the operator authorized this name, and
 * the fleet recorded which address it resolved to at launch"*. Between the
 * check and the dial there is one resolution, performed once and reused, so the
 * window is small — but a hostile or compromised resolver moves that relay's
 * dial target without `egress.allow` changing.
 *
 * **Two things bound it.** It cannot spread: ISC-427 keeps a non-hosted block
 * refusing a hostname at `config validate`, so an operator cannot opt their own
 * oMLX into this by editing a field. And it cannot widen: an `egress.allow`
 * naming the resolved LITERAL does not admit a target whose `policyHost` is
 * set, even though that literal is precisely what gets dialled — the
 * authorization means the name, or it means nothing in particular.
 */
export function assertTargetsAllowed(
  targets: readonly RelayTarget[],
  policy: EgressPolicy,
): void {
  for (const t of targets) {
    // D9 (§6.7): the operator authorizes a NAME and the relay dials an ADDRESS,
    // so the policy reads `policyHost` where one exists. `??` and not `||`: the
    // fallback must trigger on ABSENCE, never on emptiness. `makeRule` refuses
    // an unmatchable host, so `""` cannot come from config — but a future
    // producer that stamped one would, under `||`, silently revert this target
    // to being judged on the address it dials, which is the exact weakening the
    // third clause of ISC-428 exists to refuse.
    const judged = t.policyHost ?? t.host;
    const verdict = decide(judged, t.port, policy);
    if (!verdict.allowed) {
      // Name what was JUDGED, not only what is dialled. When D9 has split the
      // two, a message showing only the address sends the operator to add that
      // address to `egress.allow` — an entry that can never match, because the
      // comparison above reads the name. They would then get this identical
      // message a second time, on the one path a fleet cannot start without.
      const dialled = `${t.host}:${t.port}`;
      const via =
        t.policyHost === undefined
          ? dialled
          : `${dialled} (authorized as ${JSON.stringify(t.policyHost)}, which is what the ` +
            `policy compares — an egress.allow entry naming the address will NOT match)`;
      throw new Error(
        `relay: refusing to forward ${t.name} -> ${via} — the egress policy denies ` +
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
    // The relay runs as `--user node` with `--cap-drop ALL`, and a published
    // `https://` endpoint puts its listen port at 443 — which an unprivileged
    // process cannot bind. The container would `docker run -d` fine and die on
    // EACCES milliseconds later, reported as "exited immediately after start".
    //
    // A SYSCTL rather than `--cap-add NET_BIND_SERVICE`, and the difference is
    // the whole point: the capability would let this process bind any
    // privileged port AND is a capability the hardened posture above
    // deliberately drops. This lowers the unprivileged floor inside THIS
    // container's network namespace and grants nothing else — the cap set stays
    // empty. Measured 2026-08-30: `cap-drop ALL --user node` plus this sysctl
    // binds 443 and serves; without it the same container cannot.
    //
    // Emitted unconditionally rather than only for low ports. A relay is a
    // shared, durable container that `up` ADOPTS by name, so a conditional flag
    // would make two configs produce two different containers under one name
    // and hand the second fleet whichever one happened to be created first.
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
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
export function relayConnectArgv(
  egressNetwork: string,
  containerName: string,
  aliases: readonly string[],
): string[] {
  assertDockerName("network", egressNetwork);
  assertDockerName("container", containerName);
  // An empty list would produce a `docker network connect` with no `--alias` at
  // all: a relay reachable only by container name, every worker failing to
  // resolve its model server, and an exit code of 0 saying it went fine. The
  // alias IS the mechanism, so nothing may call this without one.
  if (aliases.length === 0) {
    throw new Error("relay: refusing to attach the relay with no listen alias");
  }
  return [
    "network",
    "connect",
    ...aliases.flatMap((a) => ["--alias", a]),
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
export async function ensureBridgeRelay(
  bridge: ProviderBridge,
  exec: Exec = realExec,
): Promise<RelayStatus> {
  /*
   * The ONE call `up` makes, and the reason it exists is that the argument it
   * carries was previously forgettable.
   *
   * `ensureEgressRelay`'s fourth parameter has to be optional — a dozen callers
   * predate it and the flat path must keep deriving `"omlx"` — and an optional
   * argument that must be passed for correctness is an argument that will
   * eventually not be. That is precisely how `ProviderBridge.targets` came to
   * be a field the tests asserted on and production ignored. Here the plan's
   * target is not passed by a caller at all; it is taken from the bridge, which
   * is the only thing that ever had the right answer.
   */
  return ensureEgressRelay(bridge.view, bridge.network, exec, bridge.targets[0]);
}

export async function ensureEgressRelay(
  cfg: RelayConfigView,
  egressNetwork: string,
  exec: Exec = realExec,
  planned?: RelayTarget,
): Promise<RelayStatus> {
  /*
   * THE PLAN'S TARGET, not a second derivation of it (D7).
   *
   * `omlxRelayTarget` stamps `name: "omlx"` UNCONDITIONALLY — the constant is
   * load-bearing on the flat path and wrong on every other one. So while
   * `relayViewForProvider` gave this function the right host and the right
   * port, a two-provider fleet came up with both relays labelled `omlx`:
   *
   *     …-ollama-cloud  [{"listenPort":443,"host":"34.36.133.15","name":"omlx"}]
   *     …-vendor-b      [{"listenPort":443,"host":"160.79.104.10","name":"omlx"}]
   *
   * measured on real containers, not inferred. `egressBridgePlan` had already
   * computed the correct per-provider target into `ProviderBridge.targets`, and
   * NOTHING IN PRODUCTION READ THAT FIELD: the tests asserted on it, and the
   * relay derived its own. Two derivations of one fact that agree in the suite
   * and disagree in the shipped artifact — the shape this repo has closed twice
   * already, for the `/secrets` mount and for the worker's network, both times
   * by deleting the second derivation rather than by keeping them in step.
   *
   * The fallback is NOT a convenience. Every relay running on an operator's
   * machine today has `"name":"omlx"` stamped in its env, and the name is part
   * of `formatRelayTarget`, which is the drift key: a caller that stopped
   * producing that string would report every one of them as drifted and cycle
   * live relays on the next `up`. So the flat path keeps deriving exactly what
   * it always did, and `egressBridgePlan` — which already chooses
   * `omlxRelayTarget` for a flat fleet for this same reason — passes it back in
   * unchanged.
   */
  const target = planned ?? omlxRelayTarget(cfg);
  // Config first, Docker second: an unusable `llm.base_url` should fail before
  // this function has created anything at all. Still true when the target came
  // from the plan — `egressBridgePlan` derives it through the same
  // `relayListenEndpoint`, one step earlier and before any daemon call.
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

  const aliases = relayListenAliases(cfg);
  const connected = await docker(
    exec,
    relayConnectArgv(egressNetwork, containerName, aliases),
    60_000,
  );
  if (connected.code !== 0) {
    await destroy();
    throw new Error(
      `relay: 'docker network connect' for ${egressNetwork}/${containerName} failed: ` +
        `${connected.stderr.trim() || "(no stderr)"} — without these aliases ` +
        `(${aliases.join(", ")}) no worker can resolve its model server. The half-created ` +
        `relay was removed.`,
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
