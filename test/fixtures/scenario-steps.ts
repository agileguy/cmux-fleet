/**
 * Which scripted steps a given session runs — the scenario partition rule.
 *
 * One `PIFLEET_PI_COMMAND` serves an ENTIRE fleet: every worker's double is
 * launched from the same string with the same `--scenario`, and only
 * `--session-id` distinguishes them. A heterogeneous fleet (two workers that
 * flood a pipe, fourteen that do not — ISC-158) is therefore not expressible
 * from the launch side and has to be expressible in the scenario itself.
 *
 * This lives in its own module rather than inside `fake-pi.ts` because two
 * readers need the same answer and the double cannot be one of them under
 * test: `fake-pi.ts` is an executable that parses argv and consumes stdin at
 * import time, so a test that imported it to check the partition would start a
 * second RPC loop. The rule was consequently unverified — the double was the
 * only thing that knew it, and the only way to exercise it was a live
 * sixteen-worker fleet.
 *
 * The partition matters more than its size suggests. A session-specific step
 * wins OUTRIGHT over the unrestricted fallback rather than merging with it, so
 * a scenario reads as "these workers do this, everyone else does that" instead
 * of an ordering puzzle. The failure mode when it goes wrong is silent: a
 * worker with no applicable step gets its prompt acked and then no events at
 * all, so it never settles and hangs to its full deadline while every other
 * worker looks healthy. That is why `warn` exists.
 */

/** The shape the partition reads. Scenarios carry far more; none of it matters here. */
export interface PartitionableStep {
  on: string;
  /** `--session-id` values this step applies to; absent means "any". */
  sessions?: string[];
}

/**
 * The steps `sessionId` runs for `command`, in scenario order.
 *
 * `warn` is called for the one empty result that is a scenario-authoring
 * MISTAKE rather than a normal outcome: steps exist for this command, but none
 * of them apply to this session — no `sessions` entry names it and no
 * unrestricted fallback remains. That worker would ack and then fall silent.
 *
 * The other empty result — no step for this command at all — is deliberately
 * silent. Most commands are unscripted in most scenarios (`get_session_stats`,
 * `get_last_assistant_text`) and fall through to the double's defaults by
 * design; warning there would print on nearly every RPC and train the reader
 * to ignore the channel that carries the real warning.
 */
export function stepsForSession<T extends PartitionableStep>(
  steps: readonly T[],
  command: string,
  sessionId: string,
  warn: (message: string) => void = () => {},
): T[] {
  const forCommand = steps.filter((s) => s.on === command);
  // No script for this command anywhere: normal, and not this function's news.
  if (forCommand.length === 0) return [];

  const specific = forCommand.filter((s) => s.sessions?.includes(sessionId) === true);
  if (specific.length > 0) return specific;

  const fallback = forCommand.filter((s) => s.sessions === undefined);
  if (fallback.length === 0) {
    const named = [...new Set(forCommand.flatMap((s) => s.sessions ?? []))].sort();
    warn(
      `scenario has ${forCommand.length} step(s) for '${command}' but none apply to ` +
        `session '${sessionId}': every step is restricted to [${named.join(", ")}] and ` +
        `there is no unrestricted fallback. This session will ack '${command}' and then ` +
        `emit nothing, which presents as a hang rather than an error.`,
    );
  }
  return fallback;
}
