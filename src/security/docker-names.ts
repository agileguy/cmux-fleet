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

/**
 * The bound, EXPORTED because a caller now has to budget against it.
 *
 * `relay.ts` composes an operator-chosen provider key into a name whose length
 * it must bound BEFORE this function sees it — a key that overflows has to be
 * refused naming `llm.providers.<key>`, not the derived string the operator
 * never typed (ISC-412). That arithmetic needs the number, and a second copy
 * of `128` in `relay.ts` is a number that can drift away from the one actually
 * enforced here, which would make the good message describe a limit that is
 * not the limit.
 */
export const MAX_DOCKER_NAME = 128;

/**
 * Throws on a name that could not have come from a validated config.
 *
 * Networks and containers share one grammar and one bound because they share
 * the hazard described in this module's header. Callers validate through this
 * single function rather than carrying a second copy of the regex that could
 * be relaxed independently.
 */
/**
 * The GRAMMAR half alone, split out for a caller that reports it differently.
 *
 * `relay.ts` refuses a bad provider key naming `llm.providers.<key>` rather
 * than the composed string (ISC-412), so it needs the same predicate without
 * this module's message — and the alternative was a second copy of the regex
 * in `relay.ts`, which is precisely the drift this module's header exists to
 * prevent. The length bound is deliberately NOT folded in: the caller budgets
 * against `MAX_DOCKER_NAME` for a longer composed string, so it must be able
 * to ask about the grammar and the length separately.
 */
export function dockerNameGrammarOk(name: string): boolean {
  return name.length > 0 && DOCKER_NAME_RE.test(name);
}

export function assertDockerName(kind: "network" | "container", name: string): void {
  if (!dockerNameGrammarOk(name) || name.length > MAX_DOCKER_NAME) {
    throw new Error(`egress: invalid docker ${kind} name ${JSON.stringify(name)}`);
  }
}

export function assertNetworkName(name: string): void {
  assertDockerName("network", name);
}
