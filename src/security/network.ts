/**
 * The deny-all egress network — Docker side (SRD §5.6, §5.9; ISC-57).
 *
 * `docker.network` (default `pifleet-egress`) is created `--internal`: Docker
 * then attaches no default route and no NAT, so a worker on it can reach ONLY
 * other containers on the same bridge. That is the deny-all default in
 * hardware, not in policy prose — whatever relays permitted traffic (the
 * model-provider proxy §5.6 places on this bridge) consults
 * `src/security/egress.ts` per destination; everything that never reaches a
 * relay is simply unroutable.
 *
 * The failure this module exists to prevent is the QUIET downgrade: a
 * pre-existing, NON-internal network wearing the configured name gives every
 * worker the whole internet while `up` reports the egress posture is on. That
 * is strictly worse than no policy, so `ensureEgressNetwork` refuses it loudly
 * rather than adopting or "fixing" it — deleting a network this fleet did not
 * create is not this module's call to make.
 *
 * Every docker invocation is an argv ARRAY through `Bun.spawn` — never a shell
 * string, so no quoting of the name can become injection. Argv arrays do not
 * stop FLAG injection (a "name" of `--driver=host` parses as an option), which
 * is why the name is validated against Docker's own grammar first.
 */

// Name validation lives in `./docker-names.ts`. It was never a network
// concern — `relay.ts` validates CONTAINER names through it too, and got
// `egress: invalid docker container name …` out of a module named for
// networks. Re-exported here so existing importers keep working against one
// implementation rather than a second copy of the regex.
import { assertDockerName, assertNetworkName } from "./docker-names.ts";
import { ensureGatewayBlocked } from "./gateway-block.ts";
import type { Exec } from "../container/run.ts";

export { assertDockerName, assertNetworkName };

export interface EgressNetworkStatus {
  name: string;
  exists: boolean;
  /** True only when Docker itself reports `Internal: true` — the deny-all bit. */
  internal: boolean;
  id: string | null;
  /**
   * The bridge's own address, as the daemon assigned it.
   *
   * Carried because `--internal` does NOT contain it (ISC-51): the gateway is
   * on-link and inside the bridge subnet, so it is delivered through INPUT and
   * never reaches Docker's FORWARD isolation rule. `gateway-block.ts` needs
   * the literal address to write a rule narrow enough to be safe, and there is
   * no second place to learn it from — deriving `.1` from the subnet would be
   * a guess about IPAM that the daemon is already telling us the answer to.
   *
   * `null` when the daemon reports no IPAM config, which is a refusal signal
   * rather than a default: we do not firewall an address we did not read.
   */
  gateway: string | null;
}

/**
 * Argv builders are exported pure so the unit suite can pin them byte-for-byte
 * without a daemon (ISC-20/21). `--internal` on create IS the security
 * property; a test that only checks "a network got made" passes without it.
 */
export function networkCreateArgv(name: string): string[] {
  assertNetworkName(name);
  return ["network", "create", "--internal", name];
}

export function networkInspectArgv(name: string): string[] {
  assertNetworkName(name);
  return ["network", "inspect", name];
}

/**
 * Parse `docker network inspect` output for one network.
 *
 * Malformed JSON THROWS rather than reading as "missing": a daemon speaking an
 * unexpected dialect must not cause `ensure` to run `network create` on top of
 * whatever actually exists. Only a well-formed answer that does not contain the
 * name means absent.
 */
export function parseNetworkInspect(name: string, stdout: string): EgressNetworkStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`egress: unparseable 'docker network inspect' output for ${JSON.stringify(name)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`egress: expected a JSON array from 'docker network inspect', got ${typeof parsed}`);
  }
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { Name?: unknown; Id?: unknown; Internal?: unknown; IPAM?: unknown };
    if (e.Name !== name) continue;
    return {
      name,
      exists: true,
      // Strict `=== true`: an absent or novel Internal field must read as NOT
      // internal — the direction that refuses, not the one that reassures.
      internal: e.Internal === true,
      id: typeof e.Id === "string" ? e.Id : null,
      gateway: gatewayFrom(e.IPAM),
    };
  }
  return { name, exists: false, internal: false, id: null, gateway: null };
}

/**
 * Pull the first IPv4 gateway out of `IPAM.Config`, or `null`.
 *
 * Deliberately total and deliberately unfussy about extra entries: a
 * dual-stack network lists v6 alongside v4, and the containment rule this
 * feeds is an IPv4 rule. Anything unrecognised reads as `null`, which makes
 * the caller refuse rather than firewall a value it did not understand.
 */
function gatewayFrom(ipam: unknown): string | null {
  if (typeof ipam !== "object" || ipam === null) return null;
  const cfg = (ipam as { Config?: unknown }).Config;
  if (!Array.isArray(cfg)) return null;
  for (const entry of cfg) {
    if (typeof entry !== "object" || entry === null) continue;
    const g = (entry as { Gateway?: unknown }).Gateway;
    if (typeof g === "string" && /^[0-9.]+$/.test(g) && g.split(".").length === 4) return g;
  }
  return null;
}

/**
 * Run a docker argv, through the caller's `exec` when it supplied one.
 *
 * THE SEAM THIS ADDS, and the bug that made it necessary. `ensureEgressRelay`
 * takes an injectable `Exec` and its tests drive it with a fake daemon,
 * asserting on the exact argv sequence they record. But it called
 * `ensureUplinkNetwork(uplink)`, which took no `exec` and reached this function
 * — so eleven tests written to be hermetic spawned the REAL docker binary
 * halfway through, and passed only because the developer's machine had one.
 *
 * Discovered by running the suite in a worker container, where they failed with
 * `Executable not found in $PATH: "docker"` from a stack that starts in a test
 * holding a fake. The gap was invisible from inside the tests: everything they
 * assert on is recorded by the fake, and the leak happens somewhere they never
 * look.
 *
 * `exec` is OPTIONAL so no caller outside `relay.ts` changes, and the default
 * is the same `Bun.spawn` as before. A timeout (`code: null`) is reported as a
 * non-zero exit: every call site here tests `code !== 0`, and a killed process
 * is not a successful one.
 */
async function docker(
  args: string[],
  exec?: Exec,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (exec !== undefined) {
    const r = await exec(["docker", ...args]);
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
  }
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  return { code, stdout, stderr };
}

/**
 * Report whether the configured network exists and is internal — the probe
 * `up` and `doctor` act on (task requirement 6).
 *
 * "No such network" is a NORMAL answer, not an error. Every other non-zero
 * exit (daemon down, permission) throws: conflating "daemon unreachable" with
 * "network missing" would send `ensure` into a create it cannot complete, and
 * would let `doctor` report a decidable fact it never actually decided.
 */
export async function inspectEgressNetwork(
  name: string,
  exec?: Exec,
): Promise<EgressNetworkStatus> {
  const r = await docker(networkInspectArgv(name), exec);
  if (r.code !== 0) {
    if (/no such network|not found/i.test(r.stderr)) {
      return { name, exists: false, internal: false, id: null, gateway: null };
    }
    throw new Error(`egress: 'docker network inspect ${name}' failed: ${r.stderr.trim()}`);
  }
  return parseNetworkInspect(name, r.stdout);
}

/**
 * Create the network if absent; verify it either way. Returns a status that is
 * always `exists: true, internal: true` — every other outcome throws.
 *
 * The re-inspect after create is not paranoia: `network create` succeeding is
 * a claim, and the property the fleet depends on is the Internal bit as the
 * daemon reports it. Trusting our own argv instead of the daemon's answer is
 * how a flag silently dropped by a proxy/context wrapper goes unnoticed.
 */
export async function ensureEgressNetwork(
  name: string,
  exec?: Exec,
): Promise<EgressNetworkStatus> {
  const before = await inspectEgressNetwork(name, exec);
  if (before.exists) {
    if (!before.internal) {
      throw new Error(
        `egress: network ${JSON.stringify(name)} exists but is NOT internal — ` +
          `workers on it would have unrestricted egress while the fleet reports deny-all. ` +
          `Remove or rename it (docker network rm ${name}) and re-run; refusing to adopt it.`,
      );
    }
    await containGateway(before);
    return before;
  }
  const created = await docker(networkCreateArgv(name), exec);
  /*
   * THE CREATE'S EXIT STATUS IS NOT THE QUESTION — the daemon's answer is.
   *
   * `inspect`-then-`create` is a TOCTOU window, and the operations console
   * walks straight into it: each attended pane runs its OWN `up` (one terminal
   * per process), so two `up`s start within milliseconds of each other on the
   * SAME bridge. Both inspect and see nothing; both create; the loser gets
   * `Error response from daemon: network with name <n> already exists` and
   * `up` died on it. Measured 2026-09-02 on the first bring-up of a new
   * per-provider bridge, where obs-1 won and tick-1's whole console pane
   * failed with the fleet otherwise healthy.
   *
   * Why it stayed hidden until now: these networks are long-lived, so the
   * window only opens on the FIRST `up` of a name nothing has created yet. A
   * fleet that has run once is immune, which is exactly the shape that gets
   * shipped.
   *
   * RE-INSPECTING RATHER THAN MATCHING THE MESSAGE, and that is the whole
   * design of the fix. "already exists" is daemon dialect — this module's own
   * `inspectEgressNetwork` header already warns that an unexpected dialect
   * must not be conflated with a decidable fact — and a fleet whose deny-all
   * posture depends on a substring match is one Docker release away from
   * adopting whatever it finds. So the create's failure is treated as a
   * QUESTION, not an answer, and the daemon settles it: if a correctly-shaped
   * network is there afterwards, it does not matter which process made it.
   *
   * Nothing is weakened. The two guards below are the same ones the success
   * path has always run, and they run on what the daemon reports, so a
   * concurrent create that produced a NON-internal network is refused here
   * exactly as `before.internal` refuses an adopted one above. The only
   * behaviour that changed is that losing a race is no longer fatal.
   */
  const after = await inspectEgressNetwork(name, exec);
  if (!after.exists) {
    throw new Error(`egress: 'docker network create ${name}' failed: ${created.stderr.trim()}`);
  }
  if (!after.internal) {
    throw new Error(
      `egress: network ${JSON.stringify(name)} was created but the daemon does not report it ` +
        `internal — workers on it would have unrestricted egress while the fleet reports ` +
        `deny-all. Remove it (docker network rm ${name}) and re-run.`,
    );
  }
  await containGateway(after);
  return after;
}

/**
 * Close the gateway hole `--internal` leaves open (ISC-51).
 *
 * This lives on `ensureEgressNetwork` rather than in `up` on purpose, and the
 * purpose is the whole lesson of ISC-51: the posture must be inseparable from
 * the call that claims it. Containment wired into the COMMAND would leave
 * `ensureEgressNetwork` free to hand back a network that reports deny-all and
 * is not — to `doctor`, to the integration suite, to whatever calls it next.
 * The function's contract is "internal, and actually contained", or it throws.
 *
 * Applied on the ADOPT path too, not just after create. A network this fleet
 * made yesterday is not contained today if the host's tables were flushed by a
 * reboot, and adopting it silently is exactly the quiet downgrade the rest of
 * this module exists to refuse.
 */
async function containGateway(status: EgressNetworkStatus): Promise<void> {
  if (status.id === null || status.gateway === null) {
    throw new Error(
      `egress: the daemon reported network ${JSON.stringify(status.name)} without an id or an ` +
        `IPv4 gateway, so its bridge gateway cannot be contained (ISC-51). A worker on an ` +
        `uncontained bridge reaches every port the Docker host listens on while the fleet ` +
        `reports deny-all; refusing to hand back an unverified posture.`,
    );
  }
  await ensureGatewayBlocked(status.id, status.gateway);
}

/**
 * The relay's uplink — a plain (non-internal) bridge, dedicated to the
 * egress-relay container alone (`src/security/relay.ts`; ISC-50/51/57).
 *
 * Workers never attach here; only the relay does, and only the relay needs
 * real connectivity to reach `host.docker.internal` and mint the one
 * sanctioned forward to oMLX. Sharing `ensureEgressNetwork`'s inspect-then-
 * create shape rather than reimplementing it: the property that matters here
 * is the INVERSE of that function's guard — this network must NOT be
 * internal, or the relay itself could never reach anything to relay.
 *
 * A pre-existing network wearing this name that IS internal is refused for
 * the same reason `ensureEgressNetwork` refuses the opposite mismatch: silent
 * adoption would report a working relay that can reach nothing, which is
 * worse than a loud refusal at `up`.
 */
export async function ensureUplinkNetwork(
  name: string,
  exec?: Exec,
): Promise<EgressNetworkStatus> {
  const before = await inspectEgressNetwork(name, exec);
  if (before.exists) {
    if (before.internal) {
      throw new Error(
        `egress: uplink network ${JSON.stringify(name)} exists but IS internal — ` +
          `the egress relay attaches here to reach host.docker.internal and cannot do so on ` +
          `an internal bridge. Remove or rename it (docker network rm ${name}) and re-run.`,
      );
    }
    return before;
  }
  assertNetworkName(name);
  const created = await docker(["network", "create", name], exec);
  // Same race, same resolution — see `ensureEgressNetwork`. This is the one
  // that actually fired: the uplink is created immediately after the worker
  // bridge, so it is the second of the two windows a concurrent `up` hits and
  // the first whose loser has nothing else to blame.
  const after = await inspectEgressNetwork(name, exec);
  if (!after.exists) {
    throw new Error(`egress: 'docker network create ${name}' failed: ${created.stderr.trim()}`);
  }
  if (after.internal) {
    throw new Error(
      `egress: uplink network ${JSON.stringify(name)} was created but the daemon reports it ` +
        `internal — the egress relay attaches here to reach host.docker.internal and cannot do ` +
        `so on an internal bridge. Remove it (docker network rm ${name}) and re-run.`,
    );
  }
  return after;
}
