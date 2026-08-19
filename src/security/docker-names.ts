/**
 * Docker object-name validation, shared by every module that builds argv.
 *
 * Extracted from `network.ts` because it was never a network concern: argv
 * arrays through `Bun.spawn` stop QUOTING injection but not FLAG injection —
 * a "name" of `--driver=host` parses as an option wherever it appears — and
 * that hazard is identical for networks and containers. `relay.ts` derives
 * both kinds of name from the configured egress network, so it validated
 * through `network.ts` and got errors reading `egress: invalid docker
 * container name …` out of a module named for networks. One grammar, one
 * bound, one home.
 */

/** Docker object-name grammar; also refuses a leading `-` becoming a flag. */
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const MAX_DOCKER_NAME = 128;

/**
 * Throws on a name that could not have come from a validated config.
 *
 * Networks and containers share one grammar and one bound because they share
 * the hazard described in this module's header. Callers validate through this
 * single function rather than carrying a second copy of the regex that could
 * be relaxed independently.
 */
export function assertDockerName(kind: "network" | "container", name: string): void {
  if (name.length === 0 || name.length > MAX_DOCKER_NAME || !DOCKER_NAME_RE.test(name)) {
    throw new Error(`egress: invalid docker ${kind} name ${JSON.stringify(name)}`);
  }
}

export function assertNetworkName(name: string): void {
  assertDockerName("network", name);
}
