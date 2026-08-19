/**
 * Per-test time budgets for integration tests that spawn subprocesses (ISC-266).
 *
 * WHY A HELPER AND NOT A CONFIG KEY. bun's default per-test budget is 5000 ms,
 * a number with no relationship to what these tests do. It cannot be replaced
 * repo-wide: bun 1.3.11 IGNORES `[test] timeout` in `bunfig.toml` — probed
 * directly, a deliberately-6s test still died at 5001.03 ms with
 * `timeout = 12345` set — and `--timeout` only covers the invocation that
 * passes it, so it cannot protect a developer running a bare `bun test`, which
 * is precisely the case ISC-266 is about. The per-test third argument is the
 * only mechanism that travels with the test, so the budget has to be written
 * where the test is.
 *
 * WHERE THE NUMBERS COME FROM. All measured on a 14-core machine, not guessed.
 *
 *   - A `bun run <cli> --help` spawn costs ~57 ms (p50 of 12, min 54, max 64).
 *     Process creation is NOT the cost.
 *   - A spawn that runs a real command costs ~1.9 s, because each one
 *     transpiles the CLI entrypoint and then does the work. Derived from
 *     `harvest.test.ts > report honours the same config as artifacts`, which
 *     performs exactly two `runCli` spawns and takes 3756 ms idle.
 *   - That test therefore sat at 1.33x headroom against the 5000 ms default
 *     WHEN IDLE. It was one scheduling accident from red before any load.
 *   - Under ten busy loops on those 14 cores, per-test wall time across
 *     `harvest.test.ts` inflated 2.09x-2.98x (2.50x overall), and that test
 *     went 3756 ms -> 9991 ms: it FAILED 3/3 consecutively at the default,
 *     and passed 34/34 with the budget lifted. Consistent under load, exactly
 *     as ISC-266 predicted, which is why it first read as a real breakage.
 *   - ISC-266 recorded load average 18.40 on 14 cores when the defect was
 *     originally seen — busier than the ten-loop probe above, so the observed
 *     3x is a floor for contention, not a ceiling.
 *
 * HOW THE BUDGET IS BUILT. `spawns * PER_SPAWN_IDLE_MS * CONTENTION * SAFETY`.
 * CONTENTION is the worst inflation actually measured; SAFETY covers the
 * busier machine ISC-266 describes. The result stays BOUNDED on purpose — a
 * genuinely hung subprocess still fails, it just fails in ~23 s instead of 5 s.
 * An unbounded budget would trade a flaky test for a hanging suite, which is
 * the same erosion of trust from the other direction.
 *
 * WHAT THIS DOES NOT DO. It does not weaken a single assertion. Every
 * expectation runs unchanged; only the wall-clock ceiling moves, and it moves
 * to a number derived from the work rather than inherited from a default.
 */

/** Measured cost of one `bun run <cli> <command>` spawn on an idle machine. */
export const PER_SPAWN_IDLE_MS = 1_900;

/** Worst per-test inflation measured under sustained load (2.09x-2.98x). */
export const CONTENTION = 3;

/** Headroom for a machine busier than the one measured (ISC-266 saw 18.40). */
export const SAFETY = 2;

/** bun's default, kept as a floor so cheap tests are never given LESS. */
export const BUN_DEFAULT_MS = 5_000;

/**
 * The budget for a test that performs `spawns` CLI subprocess invocations.
 *
 * Pass the number the test actually performs — that is the point of the
 * criterion. A test whose spawn count grows should see its budget grow with
 * it, rather than quietly consuming headroom sized for an older version.
 */
export function cliBudget(spawns: number): number {
  if (!Number.isInteger(spawns) || spawns < 1) {
    throw new TypeError(`cliBudget expects a positive spawn count, got ${spawns}`);
  }
  return Math.max(BUN_DEFAULT_MS, spawns * PER_SPAWN_IDLE_MS * CONTENTION * SAFETY);
}
