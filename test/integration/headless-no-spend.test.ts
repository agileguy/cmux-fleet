/**
 * The headless suite passes with no provider key in the environment (ISC-423).
 *
 * ## Why a RUNTIME probe when a static one already exists
 *
 * `test/unit/anti-criteria.test.ts` holds two static guards over this
 * criterion — ISC-140's original grep of `test/e2e/ ** / *.test.ts`, and
 * ISC-423's widening of it to every file the headless suite can reach. Both
 * answer the same KIND of question: does a spend-shaped LITERAL appear in the
 * source. That question has a permanent blind spot, and it is not a gap in
 * those particular patterns — it is a property of asking about literals at
 * all. A test that reads its credential through a name no list anticipated,
 * or assembles its endpoint at runtime from parts that never sit next to each
 * other in the file, is invisible to every regex that will ever be written
 * there.
 *
 * ISC-423's probe is deliberately phrased as a RUNTIME statement for that
 * reason: *"the `headless` suite passes with no provider key in the
 * environment."* This test is that sentence, executed. It does not guess how
 * a credential might be spelled. It takes the fuel away and runs the suite.
 *
 * ## THE ASYMMETRY THIS EXISTS FOR
 *
 * ISC-140 records it and it is worth restating, because it is the whole
 * reason a criterion about money is separate from one about network: a test
 * that needs EGRESS fails closed on an air-gapped runner and everybody finds
 * out, while a test that needs provider SPEND passes and quietly bills
 * someone. No green tick will ever reveal the second. Stripping the
 * environment is what converts it into the first.
 *
 * ## What makes this urgent rather than theoretical, MEASURED
 *
 * `require_native_tool_calls` defaults to TRUE, and since ISC-418 the §5.9
 * gate probes each distinct `(provider, model)` PAIR — so an `up` costs a
 * request per pair. What keeps the headless suite from paying it is NOT the
 * backend: in `up.ts`, `egressNetwork` is assigned from any loaded config on
 * any backend, and the gate runs whenever `loadedConfig !== null &&
 * egressNetwork !== null`. `--backend headless` is nowhere in that condition.
 *
 * Measured on this branch, with a providers-map `fleet.yaml` and
 * `up --backend headless`: exit 3, after a real host-side request —
 * *"the mandatory native-tool-call probe (SRD §5.9) did not settle whether
 * model "gpt-oss" emits native tool calls — oMLX unreachable at
 * https://api.spend-detector.invalid/v1/chat/completions: fetch failed"*.
 * Point that block at a vendor that exists and every `up` in the suite is
 * billable. The suite is one `writeFile` away, and `spawn-cli.ts` advertises
 * the shape: "point `cwd` at their own rig directory and put a `fleet.yaml`
 * there".
 *
 * ## HOW THIS DETECTS SPEND, stated as a chain so it can be disagreed with
 *
 * Stripping keys does not observe a request; it removes the ability to make a
 * PAID one. The chain: a paid endpoint requires authentication; authentication
 * needs a credential; the credential reaches a test through the environment,
 * because `spawnCli` spreads `process.env` into every child by default. Remove
 * it and the vendor answers 401, the §5.9 gate does not settle, `up` exits 3,
 * and the e2e test's `expect(up.code).toBe(0)` goes red. The load-bearing
 * assumption is the first link — that a paid endpoint rejects an
 * unauthenticated caller — which is close to the definition of "paid". A free
 * unauthenticated endpoint would slip through, and it would also not be spend.
 *
 * ## THE VACUITY TRAP, AND THE CONTROL THAT ANSWERS IT
 *
 * A suite that passes with a scrubbed environment BECAUSE IT NEVER DIALS
 * ANYTHING UNDER ANY ENVIRONMENT proves nothing about scrubbing. That is the
 * state the headless suite is in today and the state this criterion wants it
 * to stay in — so the passing assertion below is, on its own, indistinguishable
 * from a scrub that silently reached no child at all.
 *
 * The two control tests are what separate those. They drive the SAME scrubber
 * through the SAME spawn against a test that DOES depend on the environment,
 * and pin it in both directions: scrubbed it fails, unscrubbed it passes. So a
 * scrubber that removed nothing, an `env` option that never reached the child,
 * or a harness that read a red child as green would break the controls while
 * leaving the criterion's own assertion green.
 *
 * BE PRECISE ABOUT WHAT THAT BUYS. It proves the INSTRUMENT works — the scrub
 * reaches the child and a failing child is seen as failing. It does NOT prove
 * the e2e suite is itself environment-sensitive, because it is not, and making
 * it so to prove a point would be building the defect. The residual is stated
 * plainly: while the headless suite dials nothing, this probe passes for two
 * reasons at once and cannot tell them apart. Its value is the day that stops
 * being true, which is the day the criterion is about.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cliBudget, gateBudget } from "../support/budget.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * A variable name that could carry provider spend.
 *
 * WIDER THAN ISC-140'S REGEX, ON PURPOSE. That one keys on the suffixes
 * `API_KEY|SECRET|TOKEN`, which is the guess this test exists not to make:
 * `OPENAI_KEY`, `MISTRAL_AUTH` and `RALLY_APIKEY` — the last a live variable
 * on the maintainer's own machine — all carry a credential and none of those
 * suffixes. Here the cost of being wide is nil: this list decides what a CHILD
 * PROCESS does not get to see, not what a source file may say, so a false
 * positive removes a variable the headless suite already promises not to need.
 * Erring wide is the safe direction, which is the opposite of the trade a
 * static guard makes.
 *
 * `PATH`, `HOME`, `TMPDIR`, `SHELL` and `USER` are unaffected — none contains
 * any of these words — and `PIFLEET_*` is likewise untouched, which matters
 * because `PIFLEET_RUNS_DIR` and `PIFLEET_PI_COMMAND` are the two variables
 * ISC-140 measured the suite as actually using.
 */
const CREDENTIAL_SHAPED =
  /(?:KEY|TOKEN|SECRET|CRED|PASSWD|PASSWORD|AUTH|BEARER|SESSION_ID|_PAT$)/;

/** Everything from `base` whose NAME could name a credential, removed. */
function scrubProviderKeys(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (CREDENTIAL_SHAPED.test(name)) continue;
    out[name] = value;
  }
  return out;
}

interface BunTestRun {
  code: number;
  pass: number;
  fail: number;
  files: number;
  output: string;
}

/** Run `bun test <target>` as a child and read its own tally back. */
async function runBunTest(
  target: string,
  env: Record<string, string>,
): Promise<BunTestRun> {
  const proc = Bun.spawn([process.execPath, "test", target], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const output = `${stdout}\n${stderr}`;
  const code = await proc.exited;
  const num = (re: RegExp): number => Number(output.match(re)?.[1] ?? "-1");
  return {
    code,
    pass: num(/^\s*(\d+) pass$/m),
    fail: num(/^\s*(\d+) fail$/m),
    files: num(/Ran \d+ tests across (\d+) files?\./),
    output,
  };
}

/**
 * How many `*.test.ts` the headless suite has, read off disk.
 *
 * The child's file count is asserted against THIS rather than against `3`,
 * and the difference is the anti-vacuity property: a child that transpiled
 * nothing, matched nothing, or was pointed at the wrong directory reports a
 * tally too, and a literal would happily agree with it on the day someone
 * deletes a file. Deriving it means the assertion tracks the suite instead of
 * recording what the suite looked like when this was written.
 */
async function e2eFileCount(): Promise<number> {
  let n = 0;
  for await (const _ of new Bun.Glob("test/e2e/**/*.test.ts").scan({ cwd: ROOT })) n += 1;
  return n;
}

describe("the headless suite needs no provider key at runtime (ISC-423)", () => {
  /**
   * THE BUDGET, DERIVED — and neither `cliBudget` nor `containerBudget` is it.
   *
   * `cliBudget(1)` is 11_400 ms and does not govern: it is calibrated to the
   * ~1.9 s cost of transpiling and running the pifleet CLI entrypoint ONCE,
   * and this child is not one CLI invocation — it is `bun test` over a suite
   * that itself performs some forty of them. Reaching a workable number by
   * inflating the spawn count would be, in `budget.ts`'s own words, "a
   * derivation in appearance only". `containerBudget` is a cold-Docker floor
   * and this child starts no container.
   *
   * `gateBudget` is the right shape and the reason is its own docblock's: the
   * cost here is not the number of processes started but the ceilings this
   * child waits on. Every test inside `test/e2e/` already carries a derived
   * `cliBudget` third argument, so the child's worst case is the SUM of gates
   * whose authors have already justified them — and those gates already carry
   * `budget.ts`'s CONTENTION factor, which is exactly why `gateBudget` applies
   * SAFETY alone and declines to multiply contention in twice.
   *
   * The single gate below is the suite's measured wall time inflated by that
   * same CONTENTION = 3, which `budget.ts` records as the worst per-test
   * inflation actually observed under sustained load:
   *
   *   - MEASURED on this branch, warm and idle, 14-core macOS:
   *     `bun test test/e2e/` = 17 pass, 0 fail, 3 files, 56.9 s.
   *   - 56.9 s x CONTENTION 3 = ~171 s, the gate.
   *   - `gateBudget([171_000])` applies SAFETY 2 = 342_000 ms.
   *
   * That is a wide ceiling for a 57 s child and it is deliberately not
   * narrowed, because the INNER ceilings are what actually catch a hang: a
   * wedged e2e test fails against its own `cliBudget` and the child exits
   * non-zero in seconds. This outer number only ever fires if the child
   * process itself is stuck — which is the one thing the inner budgets cannot
   * see, and the only job left for an outer bound.
   */
  const E2E_SUITE_GATE_MS = 171_000;
  const SUITE_BUDGET_MS = gateBudget([E2E_SUITE_GATE_MS]);

  test(
    "the e2e suite passes with every credential-shaped variable stripped",
    async () => {
      const expectedFiles = await e2eFileCount();
      expect(expectedFiles, "no e2e files found; this probe is running nothing").toBeGreaterThan(
        0,
      );

      const run = await runBunTest("test/e2e/", scrubProviderKeys(process.env));

      expect(
        run.code,
        `the headless suite failed with no provider key in the environment. ` +
          `Something in it needs a credential, which means it can cost money ` +
          `on a machine that has one.\n${run.output.slice(-4000)}`,
      ).toBe(0);
      expect(run.fail).toBe(0);
      // Anti-vacuity: a child that ran NOTHING also reports no failures.
      expect(run.pass).toBeGreaterThan(0);
      expect(
        run.files,
        "the child did not collect every e2e file; its pass is over a subset",
      ).toBe(expectedFiles);
    },
    SUITE_BUDGET_MS,
  );

  /**
   * The control rig: one test file that fails unless a provider-shaped key is
   * present.
   *
   * It is written to a temp directory rather than checked in, for two
   * reasons. A file under `test/` that fails by design would be collected by
   * a bare `bun test` and turn the suite red; and the same file, checked in,
   * would name a credential variable inside the very tree ISC-423's static
   * guard scans — the control would trip the other half of its own criterion.
   *
   * The variable is SEEDED here rather than read from the ambient
   * environment. A control that depended on the developer happening to have a
   * key exported would silently stop controlling anything on a clean CI
   * runner, which is the machine where it matters most.
   */
  const PROBE_VAR = "PIFLEET_SPEND_CONTROL_API_KEY";

  async function controlRig(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-spend-control-"));
    const file = join(dir, "control.test.ts");
    await writeFile(
      file,
      `import { expect, test } from "bun:test";\n` +
        `test("the control needs a provider key", () => {\n` +
        `  expect(process.env[${JSON.stringify(PROBE_VAR)}]).toBe("seeded-sentinel");\n` +
        `});\n`,
    );
    return file;
  }

  const seeded = (): NodeJS.ProcessEnv => ({ ...process.env, [PROBE_VAR]: "seeded-sentinel" });

  /**
   * Direction one: the scrub REACHES the child.
   *
   * Without this, the criterion's assertion above is satisfied by an `env`
   * option that never took effect — the suite would pass with the developer's
   * full environment intact and report green for scrubbing it.
   */
  test(
    "a test that reads a provider key at runtime FAILS under the same scrub",
    async () => {
      const run = await runBunTest(await controlRig(), scrubProviderKeys(seeded()));
      expect(
        run.code,
        "the control passed with its key scrubbed — the scrub is not reaching " +
          "the child, so the criterion's own probe above proves nothing.",
      ).not.toBe(0);
      expect(run.fail).toBeGreaterThan(0);
    },
    cliBudget(1),
  );

  /**
   * Direction two: the failure above is caused by the SCRUB, not by a broken
   * rig.
   *
   * A control that fails for its own reasons — a syntax error in the
   * generated file, a bad path, a harness that reports every child as red —
   * would satisfy direction one while controlling nothing. The same rig, the
   * same spawn, the scrub removed, must go green.
   *
   * `cliBudget(1)` on both: the child is `bun test` over a single one-assertion
   * file, whose cost is a bun start plus a transpile — the same ~1.9 s shape
   * `cliBudget` is calibrated to, rather than the suite-sized cost above.
   */
  test(
    "the same control PASSES when the key is left in place",
    async () => {
      const env = seeded() as Record<string, string>;
      const run = await runBunTest(await controlRig(), env);
      expect(
        run.code,
        `the control failed even with its key present, so its failure under ` +
          `the scrub says nothing about scrubbing.\n${run.output.slice(-2000)}`,
      ).toBe(0);
      expect(run.pass).toBeGreaterThan(0);
    },
    cliBudget(1),
  );
});
