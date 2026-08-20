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
 * where the test is. (Probed on 1.3.11, the maintainer's version; CI pins
 * 1.3.12 and was not probed, so the claim is scoped to what was measured. It
 * does not matter to the fix either way — a config default that worked would
 * still be a repo-wide number rather than a per-test one.)
 *
 * WHERE THE NUMBERS COME FROM. All measured on a 14-core machine, not guessed.
 *
 *   - A `bun run <cli> --help` spawn costs ~57 ms (p50 of 12, min 54, max 64).
 *     Process creation is NOT the cost. Transpiling the CLI entrypoint and
 *     then doing the work is.
 *   - SPAWN COST IS NOT UNIFORM, and this is the fact the model is built
 *     around. `report` and `artifacts --all` grade an entire run and cost
 *     ~1.3-1.6 s each; `artifacts --task`, `config validate` and `render`
 *     cost ~50-200 ms. A single average across both would be wrong in both
 *     directions.
 *   - PER_SPAWN_IDLE_MS is therefore the EXPENSIVE case, measured directly on
 *     the four one-spawn tests in `harvest.test.ts` — 1335, 1408, 1618 and
 *     1631 ms idle across two runs. Worst is 1631; 1900 rounds it up. Costing
 *     every spawn at the expensive rate is deliberate: it makes the budget
 *     conservative for mixed tests rather than dependent on knowing which
 *     commands a test happens to call.
 *   - The test ISC-266 was filed over,
 *     `harvest.test.ts > report honours the same config as artifacts`, takes
 *     3593-3894 ms idle and performs FOUR spawns (two `report`, two
 *     `artifacts --task`) — not two, which an earlier revision of this comment
 *     asserted from reading only the first two lines of the body. Its average
 *     per-spawn cost is ~940 ms precisely BECAUSE two of its four spawns are
 *     the cheap kind, which is the non-uniformity above rather than a
 *     contradiction of the 1900 figure.
 *   - That test therefore sat at ~1.3x headroom against the 5000 ms default
 *     WHEN IDLE. It was one scheduling accident from red before any load.
 *   - Under ten busy loops on those 14 cores, per-test wall time across
 *     `harvest.test.ts` inflated 2.09x-2.98x (2.50x overall). Three tests
 *     died at exactly 5001-5003 ms — the timeout, not the work — and the same
 *     test reached 9991 ms once the budget was lifted. It FAILED 3/3
 *     consecutively at the default and passed 34/34 with budgets applied.
 *     Consistent under load rather than intermittent, exactly as ISC-266
 *     predicted, which is why it first read as a real breakage.
 *   - ISC-266 recorded load average 18.40 on 14 cores when the defect was
 *     originally seen — busier than the ten-loop probe above, so the observed
 *     3x is a floor for contention, not a ceiling.
 *
 * HOW THE BUDGET IS BUILT. `spawns * PER_SPAWN_IDLE_MS * CONTENTION * SAFETY`.
 * CONTENTION is the worst inflation actually measured; SAFETY covers the
 * busier machine ISC-266 describes. The result stays BOUNDED on purpose — a
 * genuinely hung subprocess still fails, it just fails in ~11 s per spawn
 * instead of 5 s flat. An unbounded budget would trade a flaky test for a
 * hanging suite, which is the same erosion of trust from the other direction.
 *
 * WHAT THIS DOES NOT DO. It does not weaken a single assertion. Every
 * expectation runs unchanged; only the wall-clock ceiling moves, and it moves
 * to a number derived from the work rather than inherited from a default.
 */

/**
 * Cost of one EXPENSIVE `bun run <cli> <command>` spawn on an idle machine —
 * one that grades a whole run. Cheap commands cost a tenth of this; charging
 * every spawn the expensive rate is what keeps the model conservative.
 */
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
 * Count the calls in the body; do not estimate. Miscounting is not
 * hypothetical — the four-spawn test above was first recorded as two.
 */
export function cliBudget(spawns: number): number {
  if (!Number.isInteger(spawns) || spawns < 1) {
    throw new TypeError(`cliBudget expects a positive spawn count, got ${spawns}`);
  }
  return Math.max(BUN_DEFAULT_MS, spawns * PER_SPAWN_IDLE_MS * CONTENTION * SAFETY);
}

// ---------------------------------------------------------------------------
// Container operations — a DIFFERENT cost with a different distribution
// ---------------------------------------------------------------------------

/**
 * WHY A SECOND HELPER AND NOT A BIGGER `spawns` NUMBER (ISC-274).
 *
 * `cliBudget` is calibrated to ONE thing: the ~1900 ms it costs to transpile
 * and run this project's CLI entrypoint. A `docker run` is not that. Reaching
 * a workable number for a container test by inflating its `spawns` count would
 * encode a lie as arithmetic — the count would no longer describe the test, and
 * the next person to add a spawn would have no way to tell which part of the
 * number was real. `container-env.test.ts` reached this conclusion first and
 * stated it as "borrowing the number would be a derivation in appearance only";
 * this helper is that reasoning lifted out of one file so the other Docker-gated
 * suites stop restating it.
 *
 * ## The warm term, measured
 *
 * Taken on a 14-core macOS machine at load average 3.55, Docker 28.4.0, daemon
 * already running and `pifleet/pi-worker:verify` already present:
 *
 *   - `docker run --rm <image> true`, ten consecutive samples:
 *     949, 619, 556, 474, 537, 439, 459, 515, 518, 497 ms. Worst 949.
 *   - `docker run -d` + two `docker exec` + `docker rm -f`, five samples:
 *     261, 248, 257, 244, 256 ms.
 *   - `docker network create --internal` + `inspect` + `rm`, five samples:
 *     126, 110, 116, 113, 112 ms.
 *
 * And the suites themselves, run warm with `PIFLEET_DOCKER=1`: `image.test.ts`
 * 27-959 ms per test, `egress.test.ts` 14-414 ms, `probe-in-network.test.ts`
 * 22-187 ms, `adc.test.ts` 125-3493 ms (its slowest four make a real `gcloud`
 * call, which is network latency rather than container cost — those four keep
 * their own ceilings and say so inline).
 *
 * Worst single warm operation is therefore 949 ms, rounded to 1000 below.
 *
 * ## Why the warm term is NOT the budget
 *
 * Deriving the `cliBudget` way from that figure — worst op x count x CONTENTION
 * x SAFETY — gives 1000 x 1 x 3 x 2 = 6000 ms for a one-operation test. That is
 * barely over bun's default, and it is the argument FOR a floor rather than
 * against it: it shows the 5 s default only ever looked adequate because the
 * daemon was warm and the image already pulled.
 *
 * The dominant term is the cold one — on CI the first `docker run` follows a
 * build against a cold daemon and a fresh overlay, where container creation is
 * orders of magnitude slower than the numbers above. THAT TERM WAS NOT MEASURED
 * HERE, and it deliberately was not: forcing it would mean stopping the
 * developer's Docker daemon, which is not this file's business. Picking a tight
 * ceiling from a warm measurement whose variation is not understood is the
 * ISC-267 mistake.
 *
 * So the floor below is INHERITED, not derived: 60_000 is the value every
 * Docker-gated suite in this tree already converged on independently
 * (`container-env.test.ts`, and `adc.test.ts` eight times), chosen by authors
 * who watched these run on CI. It is recorded as an inheritance rather than
 * dressed up as a measurement. It remains BOUNDED: a genuinely hung `docker`
 * still fails, it just fails later than a flat 5 s would let it.
 */
export const PER_CONTAINER_OP_MS = 1_000;

/**
 * The cold-start floor. NOT measured on a developer machine — see above. Raise
 * it only with a CI measurement, and lower it only with one too.
 */
export const CONTAINER_COLD_FLOOR_MS = 60_000;

/**
 * The budget for a test that performs `ops` container operations — `docker
 * run`, `docker exec`, `docker network create`, and their teardowns.
 *
 * Count what the test performs, exactly as with `cliBudget`. For every op count
 * these suites actually use, the cold floor dominates and the answer is 60_000;
 * the per-op term only takes over past thirty operations, which is the point —
 * a test that grows into a container-heavy one gets a budget that grows with it
 * instead of silently consuming a floor sized for a smaller version.
 */
export function containerBudget(ops: number): number {
  if (!Number.isInteger(ops) || ops < 1) {
    throw new TypeError(`containerBudget expects a positive operation count, got ${ops}`);
  }
  return Math.max(CONTAINER_COLD_FLOOR_MS, ops * PER_CONTAINER_OP_MS * CONTENTION * SAFETY);
}
