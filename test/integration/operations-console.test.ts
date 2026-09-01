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

async function dryRun(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "scripts/operations", ...args, "--dry-run"], {
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
