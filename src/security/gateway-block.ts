/**
 * Bridge-gateway containment for the deny-all egress network (ISC-51; SRD §12.8).
 *
 * `--internal` is not the containment it reads as. Docker implements it in the
 * FORWARD chain — `! -d <subnet> -i br-<id> -j DROP` — which bounds traffic
 * LEAVING the bridge. The bridge GATEWAY is on-link and inside that subnet, so
 * gateway-destined packets are delivered through INPUT (policy ACCEPT) and are
 * never evaluated by the isolation rule at all. A worker on the deny-all
 * bridge therefore reaches every port the Docker host listens on in its own
 * network namespace, including sshd. Measured, not reasoned: 2026-08-19 a
 * container with no relay running pulled `SSH-2.0-OpenSSH_9.6p1` off
 * `172.18.0.1:22`, and `test/integration/relay.test.ts` has asserted that
 * reachability as a POSITIVE ever since, so the hole is a green test rather
 * than a rumour.
 *
 * This module closes it with the rule the FORWARD chain cannot express:
 *
 *     iptables -I INPUT -i br-<id> -d <gateway> -j DROP
 *
 * Scoped to one bridge and one address, so it drops exactly the traffic
 * `--internal` was supposed to and nothing else. Verified before shipping:
 * container-to-container traffic and Docker's embedded DNS both survive it,
 * because neither is gateway-destined — DNS on an internal network answers at
 * `127.0.0.11` inside the worker's own namespace, not at the gateway.
 *
 * ## Where the privilege comes from
 *
 * pifleet is an unprivileged user-space CLI. It does not have CAP_NET_ADMIN,
 * it must not call `sudo`, and on macOS it cannot run `iptables` at all —
 * there is no Linux netfilter on the client. The naive readings of "install a
 * firewall rule" all fail here, and two of them fail SILENTLY on the platform
 * this fleet is developed on.
 *
 * The privilege pifleet already holds is the DOCKER DAEMON. A privileged
 * container joined to the host's network and mount namespaces runs the host's
 * own `iptables` against the host's own tables:
 *
 *     docker run --privileged --pid host --network host \
 *       --entrypoint nsenter <image> -t 1 -m -n -i iptables …
 *
 * This is the correct target in every topology, which is why it is preferred
 * over sudo. On Linux the daemon's host IS the machine. On macOS/colima it is
 * the Lima VM — and the VM is precisely the host whose listeners a worker can
 * reach, so the rule lands where the exposure is rather than on the Mac, where
 * there is nothing to protect and no netfilter to protect it with.
 *
 * `nsenter -m` borrows the host's `iptables` binary rather than shipping one.
 * That is what lets this reuse `RELAY_IMAGE` — already pinned by digest, and
 * measured to contain `nsenter` but NOT `iptables` — instead of adding a
 * second image to pull, pin and re-pin. A host running Docker has iptables by
 * construction; the daemon programs its own NAT and isolation rules with it.
 */

import { EXIT } from "../contracts.ts";
import { RELAY_IMAGE } from "./pinned-image.ts";

/** The one chain, target and semantics this module is allowed to write. */
const CHAIN = "INPUT";
const TARGET = "DROP";

/**
 * Docker names a bridge for the first 12 hex characters of its network ID.
 *
 * Derived rather than read back from `ip link` so it can be pinned by a unit
 * test with no daemon, and because the two would have to agree anyway. A
 * shorter or non-hex ID means we are not looking at a Docker network ID and
 * must not guess an interface name to firewall.
 */
export function bridgeInterfaceFor(networkId: string): string {
  if (!/^[0-9a-f]{12,}$/.test(networkId)) {
    throw new Error(
      `egress: refusing to derive a bridge interface from ${JSON.stringify(networkId)} — ` +
        `expected a hex Docker network ID of at least 12 characters`,
    );
  }
  return `br-${networkId.slice(0, 12)}`;
}

/**
 * Reject anything that is not a dotted-quad IPv4 literal.
 *
 * Argv arrays stop quoting injection but NOT flag injection: a "gateway" of
 * `--jump=ACCEPT` is parsed by iptables as an option, and this rule's whole
 * value is that it is narrow. A gateway we cannot recognise is a gateway we
 * refuse to write a rule about.
 */
export function assertGatewayAddress(gateway: string): void {
  const octets = gateway.split(".");
  const ok =
    octets.length === 4 &&
    octets.every((o) => /^(0|[1-9][0-9]{0,2})$/.test(o) && Number(o) <= 255);
  if (!ok) {
    throw new Error(
      `egress: refusing to firewall ${JSON.stringify(gateway)} — expected an IPv4 gateway address`,
    );
  }
}

export type RuleOp = "-C" | "-I" | "-D";

/**
 * The rule itself, exported pure so the suite can pin it byte-for-byte.
 *
 * A test that only asserts "some iptables rule was built" passes for a rule
 * that drops nothing, or for one that drops everything. The `-i`/`-d` pair IS
 * the security property and the blast-radius bound at the same time.
 */
export function gatewayBlockRuleArgv(bridge: string, gateway: string, op: RuleOp): string[] {
  assertGatewayAddress(gateway);
  return [op, CHAIN, "-i", bridge, "-d", gateway, "-j", TARGET];
}

/** Wrap a rule in the privileged host-namespace invocation described above. */
export function hostIptablesArgv(rule: readonly string[]): string[] {
  return [
    "run", "--rm", "--privileged", "--pid", "host", "--network", "host",
    "--entrypoint", "nsenter", RELAY_IMAGE,
    "-t", "1", "-m", "-n", "-i", "iptables", ...rule,
  ];
}

export interface GatewayBlockStatus {
  bridge: string;
  gateway: string;
  /** True when this call inserted the rule; false when it was already present. */
  installed: boolean;
}

async function docker(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(p.stderr).text();
  const code = await p.exited;
  return { code, stderr };
}

/**
 * The error `up` surfaces when containment cannot be established.
 *
 * Carries `EXIT.BACKEND_UNAVAILABLE` — the same class `ensureEgressNetwork`
 * already uses for "the daemon will not give us the posture we require" —
 * rather than a new code, because the operator's response is the same one.
 */
export class GatewayBlockError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;
  constructor(message: string) {
    super(message);
    this.name = "GatewayBlockError";
  }
}

/**
 * Establish gateway containment for one network, and REFUSE the run if it
 * cannot be established.
 *
 * Refusing is the owner's recorded decision (ISA `## Decisions`, 2026-08-23)
 * and there is deliberately no `--i-know` escape hatch. The reasoning is the
 * one this module was written under: a fleet that reports deny-all while
 * workers reach the host's sshd is strictly worse than one that will not
 * start, because the first failure mode is silent and the second is not.
 *
 * Idempotent by CHECKING before inserting (`-C`), not by inserting blindly —
 * `-I` is unconditional, so an `up`-per-day fleet would otherwise accumulate a
 * duplicate rule per run forever.
 *
 * The verify after insert is the same discipline `ensureEgressNetwork` applies
 * to `--internal`: the insert succeeding is a CLAIM, and the property the
 * fleet depends on is what the host's own tables report afterwards.
 */
export async function ensureGatewayBlocked(
  networkId: string,
  gateway: string,
): Promise<GatewayBlockStatus> {
  const bridge = bridgeInterfaceFor(networkId);
  assertGatewayAddress(gateway);

  const present = async (): Promise<boolean> => {
    const r = await docker(hostIptablesArgv(gatewayBlockRuleArgv(bridge, gateway, "-C")));
    if (r.code === 0) return true;
    // iptables exits 1 for "no such rule"; anything else is a real failure
    // (no netfilter, no privilege, no such chain) and must not read as absent.
    if (r.code === 1) return false;
    throw new GatewayBlockError(
      `egress: cannot read the host firewall to contain the bridge gateway ${gateway} ` +
        `(iptables exit ${r.code}): ${r.stderr.trim()}\n` +
        `Without this rule a worker on the deny-all bridge reaches every port the Docker ` +
        `host listens on, while the fleet reports deny-all. Refusing to start.`,
    );
  };

  if (await present()) return { bridge, gateway, installed: false };

  const ins = await docker(hostIptablesArgv(gatewayBlockRuleArgv(bridge, gateway, "-I")));
  if (ins.code !== 0) {
    throw new GatewayBlockError(
      `egress: cannot contain the bridge gateway ${gateway} on ${bridge} ` +
        `(iptables exit ${ins.code}): ${ins.stderr.trim()}\n` +
        `Without this rule a worker on the deny-all bridge reaches every port the Docker ` +
        `host listens on, while the fleet reports deny-all. Refusing to start.`,
    );
  }
  if (!(await present())) {
    throw new GatewayBlockError(
      `egress: inserted the gateway DROP rule for ${gateway} on ${bridge}, but the host ` +
        `firewall does not report it present. Refusing to start on an unverified posture.`,
    );
  }
  return { bridge, gateway, installed: true };
}

/**
 * Remove the rule for one bridge — for TEST teardown, not for `down`.
 *
 * `down` deliberately does not call this. It leaves the egress network and the
 * relay standing, so a rule torn down with the run would reopen the hole for
 * whatever attaches to that same still-existing bridge next. The rule's
 * lifetime is the NETWORK's lifetime, and the integration suite is the one
 * caller that actually destroys its networks.
 *
 * Best-effort by design: "no such rule" is the desired end state, not a
 * failure, so teardown never fails a passing test over a rule that was already
 * gone. The return value distinguishes the two for a caller that cares.
 */
export async function removeGatewayBlock(networkId: string, gateway: string): Promise<boolean> {
  const bridge = bridgeInterfaceFor(networkId);
  const r = await docker(hostIptablesArgv(gatewayBlockRuleArgv(bridge, gateway, "-D")));
  return r.code === 0;
}
