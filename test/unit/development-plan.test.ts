/**
 * The `development` console's plan — four equal panes, four keyboards.
 *
 * ## What this file is for that `operations-plan.test.ts` is not
 *
 * The two consoles share a builder and a rung (`agentPaneCommand`), so most of
 * what could break here breaks there too and is caught there. Three things are
 * this console's alone, and all three are shape rather than text:
 *
 *  - **The 2x2 split table.** `operations` has one pane that names an earlier
 *    anchor; this has two, and they must name DIFFERENT ones. A table that
 *    pointed both at pane 0 still produces four panes — stacked three-deep in
 *    the left column — and no assertion about pane COUNT would notice.
 *  - **Every pane is an agent pane.** `operations` mixes agents with watch
 *    loops; a stray status or git pane here would be a quarter of the console
 *    doing something nobody asked for.
 *  - **Four attached panes.** The whole point is four keyboards, and the flag
 *    that gives one is `--attach-here`.
 */

import { describe, expect, it } from "bun:test";

import {
  DEFAULT_DEVELOPMENT_WORKERS,
  DEVELOPMENT_TOP_FRACTION,
  DEVELOPMENT_WORKSPACE,
  developmentPanes,
} from "../../src/backends/cmux/operations-plan.ts";

const REPO = "/repo";
const BASE = { repoRoot: REPO, watchDir: "/work" } as const;

/** The default console: every worker attended, as `fleet.yaml` declares them. */
function fourAttended() {
  return developmentPanes({ ...BASE, tuiWorkers: DEFAULT_DEVELOPMENT_WORKERS });
}

describe("the development console is a 2x2 of agent panes", () => {
  it("is a distinct workspace from operations", () => {
    // Adoption matches on the exact title, so two consoles that shared a name
    // would each adopt the other and split panes into it.
    expect(DEVELOPMENT_WORKSPACE).toBe("development");
    expect(DEVELOPMENT_WORKSPACE).not.toBe("operations");
  });

  it("names two engineers on top and two testers below", () => {
    expect([...DEFAULT_DEVELOPMENT_WORKERS]).toEqual(["eng-1", "eng-2", "tst-1", "tst-2"]);
  });

  it("titles panes by WORKER ID, because two of them share a role", () => {
    // A role title would print `engineer` on both top panes. The id is also
    // what `dispatch --worker` takes, so the title is the argument.
    expect(fourAttended().map((p) => p.title)).toEqual(["eng-1", "eng-2", "tst-1", "tst-2"]);
  });

  /**
   * THE SHAPE, and the assertion this file exists for.
   *
   * Pane 3 hangs off pane 1 and pane 4 off pane 2. Both naming pane 0 — the
   * nearest wrong table, and the one "split the previous pane" degenerates to —
   * stacks three panes in the left column and leaves the right one whole. That
   * is still four panes with four correct commands, so only the anchors catch
   * it.
   */
  it("splits into two columns, each halved, and never off the previous pane", () => {
    const panes = fourAttended();
    expect(panes.map((p) => p.split)).toEqual([null, "right", "down", "down"]);
    expect(panes[2]!.splitFrom).toBe(0);
    expect(panes[3]!.splitFrom).toBe(1);
    // Different anchors, stated as the property rather than as two numbers.
    expect(panes[2]!.splitFrom).not.toBe(panes[3]!.splitFrom);
  });

  it("leaves the halves alone, because the panes are equal", () => {
    // `null`, not `1/2`: a correction computed to nothing is indistinguishable
    // from one computed wrongly, and equal panes are a stated requirement.
    expect(DEVELOPMENT_TOP_FRACTION).toBeNull();
  });

  it("gives every pane a keyboard when every worker is tui", () => {
    for (const pane of fourAttended()) {
      expect(pane.command, `${pane.title} does not attach`).toContain("'--attach-here'");
      // `--attach-clear` rides with it and never alone.
      expect(pane.command).toContain("'--attach-clear'");
    }
  });

  /**
   * The negative direction, without which "attaches" cannot be told apart from
   * "always attaches". `tuiWorkers` is read from the config by the script, so a
   * worker flipped to `rpc` in `fleet.yaml` must produce a viewer pane here —
   * passing `--attach-here` for an rpc worker is a refusal from `up`, naming a
   * flag the operator never typed.
   */
  it("gives a worker that is NOT tui the viewer, not an attach", () => {
    const panes = developmentPanes({ ...BASE, tuiWorkers: ["eng-1", "eng-2", "tst-2"] });
    const tester = panes.find((p) => p.title === "tst-1")!;
    expect(tester.command).not.toContain("'--attach-here'");
    expect(tester.command).not.toContain("'--attach-clear'");
    // …and the others are untouched, so this is a per-worker decision.
    expect(panes.find((p) => p.title === "eng-1")!.command).toContain("'--attach-here'");
  });

  it("runs one `up` per pane, naming only that pane's worker", () => {
    // One process has one terminal, so four keyboards is four runs. An `up`
    // naming two workers is refused by `attended/adopt.ts`, which is the
    // failure this shape avoids rather than discovers.
    for (const pane of fourAttended()) {
      expect(pane.command).toContain(`'up' '--workers' '${pane.title}'`);
      expect(pane.command).toContain(`'logs' '--worker' '${pane.title}'`);
      expect(pane.command).toContain(`'shell' '--worker' '${pane.title}'`);
    }
  });

  it("has no status pane and no git pane — every quarter is an agent", () => {
    for (const pane of fourAttended()) {
      // The two watch loops are `while :` bodies; the git one shells out to git.
      expect(pane.command).not.toContain("while :;");
      expect(pane.command).not.toContain("git --no-pager");
      expect(pane.command).not.toContain("'status' '--all'");
    }
  });

  it("sources ~/.env before `up`, so the model credential is there", () => {
    for (const pane of fourAttended()) {
      expect(pane.command.startsWith("set -a;")).toBe(true);
    }
  });
});

describe("the development console refuses what it cannot lay out", () => {
  it("refuses a fifth worker rather than stacking a third row", () => {
    expect(() =>
      developmentPanes({ ...BASE, workers: ["eng-1", "eng-2", "tst-1", "tst-2", "sre-1"] }),
    ).toThrow(/2x2 and holds at most 4/);
  });

  it("refuses an empty worker set", () => {
    expect(() => developmentPanes({ ...BASE, workers: [] })).toThrow(/at least one worker/);
  });

  it("refuses a worker id that is not a plain identifier", () => {
    // Quoting already makes injection impossible; this is legibility. A worker
    // id with a space is a typo every time, and it should fail here with the
    // value in the message rather than deep inside `up`.
    expect(() => developmentPanes({ ...BASE, workers: ["eng 1"] })).toThrow(
      /not a plain identifier/,
    );
  });

  it("degrades to a prefix of the shape for fewer than four", () => {
    // Two workers is a clean side-by-side pair, not a refusal: `--workers` is a
    // flag an operator may narrow.
    const two = developmentPanes({ ...BASE, workers: ["eng-1", "eng-2"] });
    expect(two.map((p) => p.split)).toEqual([null, "right"]);
    const three = developmentPanes({ ...BASE, workers: ["eng-1", "eng-2", "tst-1"] });
    expect(three.map((p) => p.split)).toEqual([null, "right", "down"]);
    expect(three[2]!.splitFrom).toBe(0);
  });
});
