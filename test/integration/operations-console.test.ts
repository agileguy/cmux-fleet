/**
 * `scripts/operations` — the standing console's pane 1, end to end.
 *
 * `operations-plan.test.ts` pins the PLAN: given `attachHere`, what argv comes
 * out. That is half the feature. The other half lives in the script, which
 * decides `attachHere` for itself by loading the config and resolving one
 * worker's `pane_mode` — and a plan that is correct for both inputs proves
 * nothing about a script that computes the wrong input.
 *
 * That gap is not hypothetical. The script carried its own literal `"tick-1"`
 * fallback while the plan's default had moved to `obs-1`, so pane 1 brought up
 * obs-1 and then rendered it as a LOG TAIL, because the mode was resolved from
 * a worker the pane never showed. Every unit assertion stayed green throughout.
 *
 * `--dry-run` is the seam: it prints the finished pane commands and returns
 * before the console touches cmux, so this needs no GUI, no daemon and no
 * container. It runs ungated in the fast `test` job for that reason.
 */
import { describe, expect, test } from "bun:test";

import { cliBudget } from "../support/budget.ts";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

async function dryRun(args: readonly string[], script = "scripts/operations"): Promise<string> {
  const proc = Bun.spawn(["bun", "run", script, ...args, "--dry-run"], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(await proc.exited).toBe(0);
  return `${out}\n${err}`;
}

describe("the operations console's pane 1", () => {
  /**
   * The owner's requirement: the top pane runs Pi's own interface for the
   * observer, not a rendered tail of its log. `--attach-here` is the whole
   * difference between those two panes.
   */
  test("resolves obs-1's pane_mode from the config and attaches Pi's interface", async () => {
    const out = await dryRun(["--config", "fleet.example.yaml"]);
    const pane1 = out.split("pane 2")[0]!;
    // This pane's `up` names THIS pane's worker and no other. `--attach-here`
    // hands over the terminal of the process that runs it, and one process has
    // one terminal — so two attended panes are two `up` invocations and two
    // runs, which is why `status` grew `--all`. An earlier design stood both
    // console workers up from pane 1 (`'obs-1,tick-1'`); that could not give
    // pane 2 a keyboard, and this assertion is what pins the replacement.
    expect(pane1).toContain("'up' '--workers' 'obs-1'");
    expect(pane1).toContain("'--attach-here'");
    expect(pane1).toContain("'logs' '--worker' 'obs-1' '--follow' '--render'");
  }, cliBudget(1));

  /**
   * The negative direction, and the one that would have caught the original
   * defect. A worker resolving to `pane_mode: rpc` must produce the viewer
   * pane — no `--attach-here`. Asserting only the positive case cannot tell
   * "resolved from the config" apart from "always attaches".
   *
   * `obs-2` is the worker to ask, and deliberately so: it carries the SAME
   * ROLE as obs-1 and differs from it only in a per-worker `pane_mode`. So a
   * script that resolved the mode from the role — the nearest wrong thing to
   * do, and the shape of the original defect — answers `tui` here and fails.
   *
   * It replaces `tick-1`, which was rpc when this was written and is now `tui`
   * in `fleet.example.yaml`: the console gained a second attended pane, and
   * this test kept asserting the old fleet rather than the current one.
   */
  test("a worker that resolves to rpc gets the viewer, not an attach", async () => {
    const out = await dryRun(["--config", "fleet.example.yaml", "--workers", "obs-2"]);
    const pane1 = out.split("pane 2")[0]!;
    expect(pane1).toContain("'up' '--workers' 'obs-2'");
    expect(pane1).not.toContain("'--attach-here'");
    expect(pane1).toContain("'logs' '--worker' 'obs-2' '--follow' '--render'");
  }, cliBudget(1));
});

/**
 * `scripts/development`, through the same seam.
 *
 * ## Why the script and not only the plan
 *
 * `development-plan.test.ts` pins what `developmentPanes` returns. That is the
 * plan, and a plan is correct for inputs the SCRIPT may never compute — the
 * exact gap that let `operations` resolve one pane's mode from another pane's
 * worker while every unit assertion stayed green.
 *
 * There is a second reason here, and it is sharper: `scripts/**` is NOT in
 * `tsconfig.json`'s `include`, so no `tsc` run reads these two files at all.
 * They are extensionless bun scripts and the compiler cannot glob them without
 * a suffix. Nothing type-checks them; executing one is the only thing that
 * does. That is not hypothetical either — the first draft of
 * `scripts/development` called a `runOutput` helper it never defined, and
 * `bun run typecheck` was clean.
 *
 * **WHAT THIS STILL DOES NOT REACH:** the `--recreate` branch. `--dry-run`
 * returns before it, so the teardown path — the one that decides which runs to
 * stop — is exercised only by `status-runs.test.ts` against the function it
 * delegates to. The decision is unit-covered; the wiring to it is not.
 */
describe("the development console's four panes", () => {
  test(
    "resolves every worker's pane_mode from the config and attaches all four",
    async () => {
      const out = await dryRun(["--config", "fleet.example.yaml"], "scripts/development");
      expect(out).toContain("workspace: development");
      for (const w of ["eng-1", "eng-2", "tst-1", "tst-2"]) {
        expect(out, `${w} has no pane`).toContain(`(${w}):`);
        expect(out).toContain(`'up' '--workers' '${w}'`);
      }
      // Four keyboards is the whole point, so four attaches.
      expect((out.match(/'--attach-here'/g) ?? []).length).toBe(4);
    },
    cliBudget(1),
  );

  test(
    "refuses a fifth worker rather than laying out a shape it does not have",
    async () => {
      // Through the SCRIPT, so the refusal is proved to reach an operator as a
      // non-zero exit and a sentence rather than as a stack trace. `dryRun`
      // asserts exit 0, so this spawns directly.
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/development",
          "--workers",
          "eng-1,eng-2,tst-1,tst-2,sre-1",
          "--dry-run",
        ],
        { cwd: REPO, stdout: "pipe", stderr: "pipe" },
      );
      const [err, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).not.toBe(0);
      expect(err).toContain("2x2 and holds at most 4");
    },
    cliBudget(1),
  );
});

/**
 * THE DRY-RUN HOP — the scripts' own pass of `SPEC.name` into the plan.
 *
 * ## Why this block exists, stated as the gap it closes
 *
 * The live path folds the workspace title in at `planPanes` (`operations.ts`),
 * which the unit suite covers. The `--dry-run` path BYPASSES that fold: each
 * script calls its plan function directly to print a preview, so it passes
 * `SPEC.name` itself. That is a third call site and it had no reader — a
 * reviewer deleted `workspaceName: OPERATIONS_SPEC.name` from
 * `scripts/operations` and the equivalent from `scripts/development`, and the
 * whole suite stayed green at 72/72. `scripts/review` was spawned by no test
 * at all, in any form.
 *
 * The consequence is narrow and nasty: `--dry-run` would print a command that
 * is not the command the console runs. A preview that disagrees with reality
 * is worse than no preview, because it is consulted exactly when someone is
 * trying to work out what will happen.
 *
 * ## THE REVIEW CONSOLE NEEDS A ROSTER OVERRIDE, and the reason is a fixture fact
 *
 * `fleet.example.yaml` — the shipped reference config, which is what these
 * scripts are pointed at here — declares `sre-1, sre-2, obs-1, obs-2, ver-1,
 * eng-1, eng-2, tst-1, tst-2, tick-1`. It declares NONE of the review console's
 * own workers: no `col-1`, no `rev-arch-1`, `rev-ctx-1` or `rev-lang-1`.
 *
 * The parenthetical that used to sit inside that sentence said the example was
 * used "because the operator's `fleet.yaml` is gitignored", pointing at
 * `test/unit/review-plan.test.ts` for what reading an untracked config costs in
 * CI. That is no longer the reason and cannot be: `fleet.yaml` has been tracked
 * since 2026-09-12 and is on every checkout, CI included. The reason that
 * survives is the one this block actually needs — the example is the config the
 * console scripts ship against, and the fixture fact below is a fact ABOUT THE
 * EXAMPLE. Reading the live file instead would make this test pass or fail on
 * whether the operator currently seats a review console, which is the opposite
 * of what a plumbing test wants.
 *
 * With its default roster, then, `scripts/review` correctly degrades — "could
 * not read pane_mode from the config … the panes will tail their logs" — every
 * pane is non-attended, and `agentPaneCommand` suppresses `--workspace-name`
 * by design. **The fixture could not produce the value being asserted**, which
 * is the same defect that made `console-restart.test.ts` blind to the restart
 * hop, and it was nearly written up here as a limitation instead of fixed.
 *
 * It did not need to be a limitation. `--workers` overrides the roster, so
 * four workers the example config DOES declare put four attended panes in the
 * review console's own 2x2 and the flag appears. Nothing about the workspace
 * NAME plumbing depends on which workers occupy the seats, and this is a test
 * of that plumbing.
 *
 * The alternative — adding the review roster to `fleet.example.yaml` — was
 * rejected: ten test files read that config (`config.test.ts`,
 * `docs-currency.test.ts`, `role-briefings.test.ts`, `worker-secrets.test.ts`
 * among them), and widening a shared fixture to satisfy one assertion spends
 * more integrity than it buys in a change meant to be repairing it.
 */
describe("--dry-run prints the workspace name the console will actually pass", () => {
  /**
   * Each console, its workspace title, and any argv it needs to put attended
   * panes on screen under the tracked config. Only review needs the override,
   * and the header says why.
   */
  const consoles = [
    ["scripts/operations", "operations", [] as readonly string[]],
    ["scripts/development", "development", [] as readonly string[]],
    ["scripts/review", "review", ["--workers", "eng-1,eng-2,tst-1,tst-2"] as readonly string[]],
  ] as const;

  for (const [script, name, extra] of consoles) {
    test(
      `${script} previews --workspace-name '${name}'`,
      async () => {
        const out = await dryRun(["--config", "fleet.example.yaml", ...extra], script);
        expect(out).toContain(`'--workspace-name' '${name}'`);
      },
      cliBudget(1),
    );
  }

  /**
   * ANTI-DEGENERACY, and it is what makes the three assertions above mean
   * something. Each looking only for its own string would pass against a
   * script that hardcoded one title, or against a plan that read the console
   * `label` instead of `SPEC.name` — the two are equal today and only a
   * cross-check separates them.
   */
  test(
    "no console previews a workspace name belonging to another",
    async () => {
      const foreign: Record<string, readonly string[]> = {
        "scripts/operations": ["development", "review"],
        "scripts/development": ["operations", "review"],
        "scripts/review": ["operations", "development"],
      };
      for (const [script, name, extra] of consoles) {
        const out = await dryRun(["--config", "fleet.example.yaml", ...extra], script);
        for (const other of foreign[script]!) {
          expect(out, `${script} named the ${other} workspace`).not.toContain(
            `'--workspace-name' '${other}'`,
          );
        }
        // The control: it DID name its own, so the absences above are not
        // simply the absence of any flag at all.
        expect(out).toContain(`'--workspace-name' '${name}'`);
      }
    },
    cliBudget(3),
  );

  /**
   * The flag rides with `--attach-here` and only there. A pane that runs no
   * `up` — the monitor, the git watch — must not carry it, and the preview is
   * the cheapest place to see that.
   */
  test(
    "only the panes that attach carry the flag",
    async () => {
      const out = await dryRun(["--config", "fleet.example.yaml"], "scripts/operations");
      for (const line of out.split("\n")) {
        if (!line.includes("--workspace-name")) continue;
        expect(line, "a pane named a workspace without attaching").toContain("'--attach-here'");
      }
    },
    cliBudget(1),
  );

  /**
   * THE ROSTER OVERRIDE'S PREMISE, pinned so it cannot go stale silently.
   *
   * If someone later adds the review roster to `fleet.example.yaml`, this
   * fails — and that failure is the correct signal: the override above would
   * become unnecessary and the header's reasoning would no longer hold. A
   * workaround that does not announce its own expiry outlives its cause.
   */
  test(
    "the example config still declares no review worker — why the roster is overridden",
    async () => {
      const out = await dryRun(["--config", "fleet.example.yaml"], "scripts/review");
      expect(out).toContain("could not read pane_mode from the config");
      expect(out).toContain('unknown worker "col-1"');
      // And with the DEFAULT roster no pane attaches, so no flag is emitted —
      // which is the behaviour the override exists to route around.
      expect(out).not.toContain("--workspace-name");
    },
    cliBudget(1),
  );
});
