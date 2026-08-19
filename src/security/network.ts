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

/** Docker object-name grammar; also refuses a leading `-` becoming a flag. */
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const MAX_DOCKER_NAME = 128;

export interface EgressNetworkStatus {
  name: string;
  exists: boolean;
  /** True only when Docker itself reports `Internal: true` — the deny-all bit. */
  internal: boolean;
  id: string | null;
}

/**
 * Throws on a name that could not have come from a validated config.
 *
 * Networks and containers share one grammar and one bound because they share
 * the hazard: the only reason this validation exists is that argv arrays stop
 * QUOTING injection but not FLAG injection, and `--driver=host` reads as an
 * option wherever it appears. `src/security/relay.ts` derives container and
 * network names from the configured egress network, so it validates through
 * this same function rather than carrying a second copy of the regex that
 * could be relaxed independently.
 */
export function assertDockerName(kind: "network" | "container", name: string): void {
  if (name.length === 0 || name.length > MAX_DOCKER_NAME || !DOCKER_NAME_RE.test(name)) {
    throw new Error(`egress: invalid docker ${kind} name ${JSON.stringify(name)}`);
  }
}

export function assertNetworkName(name: string): void {
  assertDockerName("network", name);
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
    const e = entry as { Name?: unknown; Id?: unknown; Internal?: unknown };
    if (e.Name !== name) continue;
    return {
      name,
      exists: true,
      // Strict `=== true`: an absent or novel Internal field must read as NOT
      // internal — the direction that refuses, not the one that reassures.
      internal: e.Internal === true,
      id: typeof e.Id === "string" ? e.Id : null,
    };
  }
  return { name, exists: false, internal: false, id: null };
}

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
export async function inspectEgressNetwork(name: string): Promise<EgressNetworkStatus> {
  const r = await docker(networkInspectArgv(name));
  if (r.code !== 0) {
    if (/no such network|not found/i.test(r.stderr)) {
      return { name, exists: false, internal: false, id: null };
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
export async function ensureEgressNetwork(name: string): Promise<EgressNetworkStatus> {
  const before = await inspectEgressNetwork(name);
  if (before.exists) {
    if (!before.internal) {
      throw new Error(
        `egress: network ${JSON.stringify(name)} exists but is NOT internal — ` +
          `workers on it would have unrestricted egress while the fleet reports deny-all. ` +
          `Remove or rename it (docker network rm ${name}) and re-run; refusing to adopt it.`,
      );
    }
    return before;
  }
  const created = await docker(networkCreateArgv(name));
  if (created.code !== 0) {
    throw new Error(`egress: 'docker network create ${name}' failed: ${created.stderr.trim()}`);
  }
  const after = await inspectEgressNetwork(name);
  if (!after.exists || !after.internal) {
    throw new Error(
      `egress: created network ${JSON.stringify(name)} but the daemon does not report it internal`,
    );
  }
  return after;
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
export async function ensureUplinkNetwork(name: string): Promise<EgressNetworkStatus> {
  const before = await inspectEgressNetwork(name);
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
  const created = await docker(["network", "create", name]);
  if (created.code !== 0) {
    throw new Error(`egress: 'docker network create ${name}' failed: ${created.stderr.trim()}`);
  }
  const after = await inspectEgressNetwork(name);
  if (!after.exists || after.internal) {
    throw new Error(
      `egress: created uplink network ${JSON.stringify(name)} but the daemon reports it internal`,
    );
  }
  return after;
}
