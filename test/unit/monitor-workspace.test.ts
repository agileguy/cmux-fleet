/**
 * View 1's workers, grouped by the WORKSPACE `up` recorded for them.
 *
 * ## The requirement, and the one way it can go badly wrong
 *
 * "Break the fleet view down by workspace, with the workspace name in bold
 * yellow." The grouping half is cosmetic. **The correctness half is not:** this
 * project's own operating rule is that *"the consoles are not the fleet.
 * Workers survive a closed cmux window; `status --all` is the truth, a visible
 * pane is not."* A grouping that asked cmux which panes exist and grouped by
 * the answer would drop every worker whose window the operator has since
 * closed — and it would drop them at the exact moment the monitor is worth
 * having, which is when something has gone wrong and the window is gone.
 *
 * So the assertions below are weighted accordingly. One of them checks a
 * colour. Most of them check that **no worker leaves the frame**, and they
 * check it as a conservation law over the rendered lines rather than as a
 * spot-check of a fixture that happens to be complete.
 *
 * ## Where the workspace comes from, and why that makes cmux irrelevant
 *
 * `presentation.json`'s `workspace_ref`, written once by `up`
 * (`cli/commands/up.ts:2224`) and immutable thereafter (§2.7). The monitor's
 * worker reader ALREADY parses that file — `WorkerEvidence.presentation` — so
 * the field costs no read, no subprocess and no import that was not already in
 * the closure. It is a fact on disk, so a closed window, a quit cmux and an
 * uninstalled cmux are all the same to it: the record still says which
 * workspace the worker was brought up in.
 *
 * That is the strongest form of the R3 requirement rather than a workaround for
 * it, and `cmux is not consulted, so it cannot be a dependency` below asserts
 * the absence directly: there is nothing to degrade because there is nothing to
 * fail.
 *
 * ## MEASURED, because the null case is not an edge case
 *
 * Across the operator's own 226 run directories (183 `presentation.json`
 * records, surveyed 2026-09-04) **81 workers carry `workspace_ref: null`** —
 * roughly a third. A grouping that dropped or hid ungrouped workers would hide
 * a third of this fleet's history. `no workspace recorded` is therefore a
 * first-class group with real membership, not a defensive branch nobody
 * reaches, and the fixtures below give it members for that reason.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { never, ok, type FleetModel, type RunRow, type WorkerRow } from "../../src/monitor/model.ts";
import { renderFleet } from "../../src/monitor/render.ts";
import {
  NO_WORKSPACE,
  groupByWorkspace,
  workspaceHeading,
  workspaceHeadingStyle,
} from "../../src/monitor/views/fleet.tsx";
import { COLOUR, PLAIN } from "../../src/monitor/views/chrome.tsx";
import {
  deriveWorkspace,
  deriveWorkspaceName,
  readWorkerRow,
  refreshWorkerRow,
} from "../../src/monitor/read/worker.ts";
import { presentedWorkspace } from "../../src/cli/commands/up.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { PresentationSchema, WorkerStateSchema } from "../../src/contracts.ts";

const NOW = 5_000_000;
const RUN_A = "2026-09-04T10-00-00Z-aaaa";
const RUN_B = "2026-09-04T11-00-00Z-bbbb";
const WS_OPS = "72D01454-0368-4978-91B2-DD0B68BD8D3A";
const WS_DEV = "3200BC6A-183B-4CF2-B304-EF44D33EF346";

const base: WorkerRow = {
  workerId: "w-0",
  runId: RUN_A,
  activity: "quiet",
  phase: "idle",
  transcriptAgeMs: 42_000,
  containerPresent: true,
  taskId: null,
  via: "rpc",
  fence: null,
  workspace: WS_OPS,
  /*
   * NO NAME on the base fixture, deliberately. It is the shape every record on
   * the operator's disk has today — `up` records a name only for a workspace it
   * created, and all 179 runs there were adopted into one cmux already owned.
   * Fixtures that want a name state it, so the default exercises the FALLBACK.
   */
  workspaceName: null,
};

const row = (over: Partial<WorkerRow> = {}): WorkerRow => ({ ...base, ...over });

const model = (runs: readonly RunRow[], over: Partial<FleetModel> = {}): FleetModel => ({
  runs: ok(runs, NOW - 2_000),
  containers: ok([], NOW - 2_000),
  now: NOW,
  columns: 120,
  view: { kind: "fleet" },
  history: never(),
  detail: never(),
  report: never(),
  ...over,
});

/**
 * Every worker id the frame actually printed, taken from the bullet rows.
 *
 * By the BULLET rather than by searching for known ids, on
 * `monitor-render.test.ts`'s reasoning: the bullet is "on every worker row and
 * on nothing else", so counting it answers "which rows exist" without assuming
 * which rows ought to. A helper that looked for the ids it expected would find
 * exactly those and report a dropped worker as a pass.
 */
function renderedWorkerIds(frame: readonly string[]): string[] {
  return frame
    .filter((l) => /^ {2}[*●] /.test(l))
    .map((l) => l.slice(4, 12).trim());
}

// ---------------------------------------------------------------------------
// R3 — nothing leaves the frame. The whole risk of the feature lives here.
// ---------------------------------------------------------------------------

describe("a worker with no discoverable workspace is still rendered", () => {
  /**
   * THE CRITERION, at its narrowest: one run, one worker, no workspace at all.
   *
   * This is the shape of a headless run and of every record written before
   * `up` learned to record a workspace — 81 of the 183 live records on this
   * machine. If grouping is implemented as "iterate the workspaces we know
   * about", this worker is in none of them and vanishes silently.
   */
  test("a lone unattached worker survives grouping", () => {
    const frame = renderFleet(
      model([{ runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "eng-1", workspace: null })] }]),
    );
    expect(renderedWorkerIds(frame)).toEqual(["eng-1"]);
    expect(frame.join("\n")).toContain(NO_WORKSPACE);
  });

  /**
   * THE DISCRIMINATING CASE, and the one that actually rules out a broken
   * implementation.
   *
   * The test above passes for a grouper that ignores workspaces entirely. This
   * one has an attached worker AND a detached one in the same frame, so
   * "render everything ungrouped" fails the heading assertion and "group by
   * the workspaces cmux knows" fails the survival assertion. Only an
   * implementation that does both satisfies it.
   */
  test("an unattached worker survives ALONGSIDE an attached one", () => {
    const frame = renderFleet(
      model([
        { runId: RUN_A, models: [], modelsNote: null, workers: [
            row({ workerId: "eng-1", workspace: WS_OPS }),
            row({ workerId: "eng-2", workspace: null }),
          ],
        },
      ]),
    );
    expect(renderedWorkerIds(frame).sort()).toEqual(["eng-1", "eng-2"]);
    const text = frame.join("\n");
    expect(text).toContain(WS_OPS);
    expect(text).toContain(NO_WORKSPACE);
  });

  /**
   * CONSERVATION, over a fixture built to be awkward: three workspaces
   * including the null one, two runs, and a run whose workers span workspaces.
   *
   * Asserted as a law over the whole frame rather than as a list of expected
   * ids, because the failure this guards is a worker nobody thought to name.
   * Grouping is a PARTITION: every worker in, every worker out, exactly once.
   */
  test("grouping is a partition — no worker is added, lost or duplicated", () => {
    const runs: RunRow[] = [
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "eng-1", workspace: WS_OPS }),
          row({ workerId: "eng-2", workspace: null }),
          row({ workerId: "eng-3", workspace: WS_DEV }),
        ],
      },
      { runId: RUN_B, models: [], modelsNote: null, workers: [
          row({ workerId: "rev-1", runId: RUN_B, workspace: WS_DEV }),
          row({ workerId: "tst-1", runId: RUN_B, workspace: null }),
        ],
      },
    ];
    const before = runs.flatMap((r) => r.workers.map((w) => `${r.runId}/${w.workerId}`)).sort();

    const after = groupByWorkspace(runs)
      .flatMap((g) => g.runs.flatMap((r) => r.workers.map((w) => `${r.runId}/${w.workerId}`)))
      .sort();
    expect(after).toEqual(before);

    // And the same law on the FRAME, which is what the operator reads. The
    // grouper being a partition buys nothing if the view then renders three of
    // the five groups.
    expect(renderedWorkerIds(renderFleet(model(runs))).sort()).toEqual(
      ["eng-1", "eng-2", "eng-3", "rev-1", "tst-1"],
    );
  });

  /**
   * A run whose workers disagree about their workspace is SPLIT rather than
   * forced into one group.
   *
   * Never observed: all 179 runs on this disk are uniform. That is exactly why
   * it is asserted — a grouper that took each run's workspace from its FIRST
   * worker would pass every other test in this file and every real fleet on
   * this machine, and would quietly file `eng-3` under the wrong console the
   * first time a run spanned two. The counts must sum, and the run must appear
   * under both headings.
   */
  test("a run spanning two workspaces appears under both, with its workers split", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "eng-1", workspace: WS_OPS }),
          row({ workerId: "eng-2", workspace: WS_DEV }),
          row({ workerId: "eng-3", workspace: WS_OPS }),
        ],
      },
    ]);
    expect(groups.map((g) => g.workspace)).toEqual([WS_OPS, WS_DEV]);
    expect(groups[0]!.runs[0]!.workers.map((w) => w.workerId)).toEqual(["eng-1", "eng-3"]);
    expect(groups[1]!.runs[0]!.workers.map((w) => w.workerId)).toEqual(["eng-2"]);

    // The block header counts what the block LISTS. A split run whose two
    // headers both said "3 workers" would be a frame that contradicts itself.
    const frame = renderFleet(model([
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "eng-1", workspace: WS_OPS }),
          row({ workerId: "eng-2", workspace: WS_DEV }),
          row({ workerId: "eng-3", workspace: WS_OPS }),
        ],
      },
    ])).join("\n");
    expect(frame).toContain(`run ${RUN_A} — 2 workers`);
    expect(frame).toContain(`run ${RUN_A} — 1 worker`);
  });

  /**
   * A run with NO workers still reaches the frame.
   *
   * It has no worker to take a workspace from, so a grouper driven purely by
   * workers has nowhere to put it and the run silently disappears — taking
   * with it the one line that says the run exists at all. That is the same
   * class of loss as a dropped worker and is easier to introduce.
   */
  test("a workerless run keeps its heading", () => {
    const frame = renderFleet(model([{ runId: RUN_A, models: [], modelsNote: null, workers: [] }])).join("\n");
    expect(frame).toContain(`run ${RUN_A} — 0 workers`);
  });

  /**
   * The all-null world — a headless fleet, or any fleet running on a machine
   * where cmux has never been involved. 81 of 183 live records look like this.
   *
   * The rows must be BYTE-IDENTICAL to what they were before grouping existed:
   * grouping adds heading lines and must not move a column. Asserted against
   * the row shape rather than against a remembered string.
   */
  test("with no workspace anywhere, every worker still renders and no row moves", () => {
    const runs: RunRow[] = [
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "eng-1", workspace: null }),
          row({ workerId: "eng-2", workspace: null, phase: "busy" }),
        ],
      },
    ];
    const frame = renderFleet(model(runs));
    expect(renderedWorkerIds(frame)).toEqual(["eng-1", "eng-2"]);
    expect(frame).toContain("  * eng-1   wrote 42s ago       Idle      Up    no task");
    expect(frame).toContain("  * eng-2   wrote 42s ago       Busy      Up    no task");
  });
});

// ---------------------------------------------------------------------------
// R3, second half — the degradation requirement, met by construction
// ---------------------------------------------------------------------------

describe("cmux is not consulted, so it cannot be a dependency", () => {
  /**
   * The requirement was "if the cmux CLI is absent, not running, or errors,
   * degrade to the ungrouped view". **This design has no cmux call to fail**,
   * which is a stronger property than degrading well, and it is asserted as an
   * absence rather than demonstrated by simulating a broken cmux.
   *
   * ISC-469 already pins the monitor to exactly one subprocess argv
   * (`monitor/read/docker.ts`) and `monitor-readonly.test.ts` enforces it. This
   * names the specific temptation this feature creates: `workspaceListArgv` and
   * `listPanesArgv` exist and would have answered the question, and reaching
   * for either would have put a second spawn in a viewer whose whole claim is
   * that it cannot issue a command.
   */
  test("no monitor module imports the cmux backend or names its verbs", () => {
    const SRC = new URL("../../src/", import.meta.url).pathname;
    const modules = [
      "monitor/views/fleet.tsx",
      "monitor/views/chrome.tsx",
      "monitor/read/worker.ts",
      "monitor/model.ts",
      "monitor/compose.ts",
    ];
    const offenders: string[] = [];
    for (const rel of modules) {
      const source = readFileSync(join(SRC, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of ["backends/", "workspaceListArgv", "listPanesArgv", "CmuxClient", "Bun.spawn"]) {
        if (source.includes(forbidden)) offenders.push(`${rel}: ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * TESTING THE TESTER. The check above is worthless if it is looking at the
   * wrong files or at nothing — a typo in a path would make it pass by
   * vacuity. `read/docker.ts` genuinely does contain `Bun.spawn`, so the same
   * predicate applied to it must FAIL.
   */
  test("the import check can actually fail — the docker reader trips it", () => {
    const SRC = new URL("../../src/", import.meta.url).pathname;
    const source = readFileSync(join(SRC, "monitor/read/docker.ts"), "utf8");
    expect(source).toContain("Bun.spawn");
  });

  /**
   * And the behavioural half: a frame renders from a model literal, with no
   * runs root, no container, no cmux and no terminal. Whatever cmux is doing —
   * running, quit, never installed — cannot reach this.
   */
  test("a full grouped frame renders from a literal, touching nothing", () => {
    const frame = renderFleet(
      model([
        { runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "eng-1", workspace: WS_OPS })] },
        { runId: RUN_B, models: [], modelsNote: null, workers: [row({ workerId: "rev-1", runId: RUN_B, workspace: null })] },
      ]),
    );
    expect(renderedWorkerIds(frame)).toEqual(["eng-1", "rev-1"]);
  });
});

// ---------------------------------------------------------------------------
// Order — the model's, never the view's
// ---------------------------------------------------------------------------

describe("grouping preserves the model's order and imposes none of its own", () => {
  /**
   * `fleet.tsx`'s header is explicit: *"Runs and workers render in the order
   * the model carries them ... a sort here would be that design, arrived at by
   * accident because sorting a list before printing it looks like tidiness."*
   * §6.2 needs a stable `(run, worker)` selection for a later action key, and a
   * grouping that re-sorted on every tick would destroy it.
   *
   * So groups appear in order of FIRST APPEARANCE, which is a function of the
   * model's own order and of nothing else. The fixture is built so that
   * alphabetical, reverse-alphabetical and null-last orderings would each give
   * a different answer from the correct one.
   */
  test("groups appear in the order their first worker does", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "eng-1", workspace: WS_DEV }),  // 3200… — second alphabetically
          row({ workerId: "eng-2", workspace: null }),    // would sort last under a null-last rule
          row({ workerId: "eng-3", workspace: WS_OPS }),  // 72D0… — first alphabetically
        ],
      },
    ]);
    expect(groups.map((g) => g.workspace)).toEqual([WS_DEV, null, WS_OPS]);
  });

  /**
   * The detached group is NOT forced to the bottom, and that is a decision
   * rather than an omission.
   *
   * Sinking it would be a sort — the one thing this view forbids — and it would
   * also bury the group an operator is most often looking for. It sits where
   * the model put it.
   */
  test("the detached group is not sunk to the end", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "eng-1", workspace: null }),
          row({ workerId: "eng-2", workspace: WS_OPS }),
        ],
      },
    ]);
    expect(groups[0]!.workspace).toBeNull();
  });

  /**
   * A ROW WITH `workspace: undefined` GROUPS WITH THE NULLS — found by the
   * pinned frame in `monitor-render.test.ts`, recorded here rather than quietly
   * patched.
   *
   * The first version of this feature rendered the heading `workspace
   * undefined` on that fixture, because its `base` row predated the field and
   * `undefined === null` is false. `bunx tsc` names every such site — the field
   * is required and four fixtures were caught that way — but `bun test` does
   * not typecheck, and a model built by a cast or a JSON round-trip carries no
   * compiler at all.
   *
   * `workspace undefined` is `phaseCell("")`'s failure in different clothes: a
   * heading indistinguishable from one that broke. The cast below is
   * deliberate and the test is honest about being about a type-violating input
   * — that is the only kind that can produce this.
   */
  test("an undefined workspace groups with the nulls rather than becoming its own", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "eng-1", workspace: undefined as unknown as null }),
          row({ workerId: "eng-2", workspace: null }),
        ],
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.workspace).toBeNull();
    expect(groups[0]!.runs[0]!.workers.map((w) => w.workerId)).toEqual(["eng-1", "eng-2"]);

    // And it never reaches the frame as the word `undefined`.
    const frame = renderFleet(
      model([
        { runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "eng-1", workspace: undefined as unknown as null })] },
      ]),
    ).join("\n");
    expect(frame).toContain(NO_WORKSPACE);
    expect(frame).not.toContain("undefined");
  });

  test("run order and worker order inside a group are the model's", () => {
    const groups = groupByWorkspace([
      { runId: RUN_B, models: [], modelsNote: null, workers: [row({ workerId: "z-1", runId: RUN_B })] },
      { runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "a-2" }), row({ workerId: "a-1" })] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs.map((r) => r.runId)).toEqual([RUN_B, RUN_A]);
    expect(groups[0]!.runs[1]!.workers.map((w) => w.workerId)).toEqual(["a-2", "a-1"]);
  });
});

// ---------------------------------------------------------------------------
// R2 — bold yellow, from the palette, and PLAIN stays escape-free
// ---------------------------------------------------------------------------

describe("the workspace heading is bold yellow, and only when colour is on", () => {
  /**
   * The style is asserted through the PALETTE rather than by looking for an
   * SGR escape in a frame, on `monitor-row-colour.test.ts`'s stated reasoning:
   * whether escapes appear at all depends on chalk's level, computed from the
   * real `process.stdout`, so under a piped test runner an escape assertion
   * "would pass vacuously exactly where it is run".
   */
  test("with colour on it is yellow and bold", () => {
    expect(COLOUR.workspace).toBe("yellow");
    expect(workspaceHeadingStyle(COLOUR)).toEqual({ color: "yellow", bold: true });
  });

  /**
   * THE NO-TTY PATH. `PLAIN` exists so a piped frame is escape-free; a palette
   * entry that carried a colour in `PLAIN` would put one on every workspace
   * heading in every redirected frame.
   */
  test("with colour off it carries no colour and no bold", () => {
    expect(PLAIN.workspace).toBeUndefined();
    expect(workspaceHeadingStyle(PLAIN)).toEqual({ color: undefined, bold: false });
  });

  /**
   * THE CONTROL, REWRITTEN AFTER IT WAS FOUND TO BE THE THING IT WARNED ABOUT.
   *
   * The previous version said in its own docblock: *"`COLOUR.warn` is ALREADY
   * yellow. Had the heading reused `warn` instead of getting its own entry,
   * both assertions above would pass"* — and then compared `workspace` against
   * `heading`, `dim` and `live` and never against `warn`. It named the one
   * collision that matters and omitted it. A reviewer's mutation
   * (`fleet.tsx` `p.workspace` -> `p.warn`) survived the full unit AND
   * integration suites.
   *
   * **The repair is NOT to assert they differ, because they do not.**
   * `chrome.tsx` sets `warn: "yellow"` and `workspace: "yellow"`, and that is
   * correct: the owner asked for a bold yellow workspace name. Two names for
   * one colour was always the design, and the docblock there says so — what
   * the separate entry buys is INDEPENDENCE, not distinctness. An assertion
   * that they differ would fail against a correct palette.
   *
   * So the discrimination moves to where it can exist: an ASYMMETRIC palette
   * in which the two are deliberately different, passed to the exported
   * `workspaceHeadingStyle`. Under the real palette no test can tell
   * `p.workspace` from `p.warn`; under this fixture only the correct one
   * answers. That is the degenerate-fixture lesson applied to a palette — the
   * fixture has to make the candidates distinguishable before an assertion
   * about them means anything.
   */
  test("the heading reads `workspace`, not `warn` — proved on a palette where they differ", () => {
    // The real palette CANNOT discriminate, and saying so is the point.
    expect(COLOUR.workspace).toBe(COLOUR.warn);

    // So: a palette where they differ. Only a `p.workspace` read gives yellow.
    const asym = { ...COLOUR, workspace: "yellow", warn: "magenta" };
    expect(workspaceHeadingStyle(asym).color).toBe("yellow");

    // And the mirror, so a mutation to a CONSTANT rather than to `p.warn`
    // cannot pass by coincidence.
    const swapped = { ...COLOUR, workspace: "magenta", warn: "yellow" };
    expect(workspaceHeadingStyle(swapped).color).toBe("magenta");
  });

  /**
   * The tiers that MUST stay visually apart, which is a different claim from
   * the one above and is still worth pinning: a workspace heading painted the
   * region heading's cyan would merge two levels of the frame to the eye.
   */
  test("it does not collide with the region heading or the row severities", () => {
    expect(COLOUR.workspace).not.toBe(COLOUR.heading);
    expect(COLOUR.workspace).not.toBe(COLOUR.dim);
    expect(COLOUR.workspace).not.toBe(COLOUR.live);
    expect(COLOUR.workspace).not.toBe(COLOUR.alarm);
  });

  /**
   * The plain frame carries no ESC byte anywhere. Weaker than it looks under a
   * piped runner (see above), so it is a floor and not the argument — but it is
   * the assertion that fails outright if someone hard-codes `\x1b[33m` into the
   * heading, which is the specific thing R2 forbids.
   */
  test("the plain frame contains no escape byte", () => {
    const frame = renderFleet(
      model([{ runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "eng-1", workspace: WS_OPS })] }]),
    ).join("\n");
    expect(frame).not.toContain("");
  });

  /**
   * And no view hard-codes a colour name or an escape. The palette is the only
   * source; a literal `"yellow"` in the view would satisfy every rendering
   * assertion above while making `PLAIN` a lie.
   */
  test("the fleet view names no colour and no escape of its own", () => {
    const source = readFileSync(
      new URL("../../src/monitor/views/fleet.tsx", import.meta.url).pathname,
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const literal of ['"yellow"', "'yellow'", "\\u001b", "\\x1b", "[33m"]) {
      expect(source, `fleet.tsx hard-codes ${literal}`).not.toContain(literal);
    }
  });

  /**
   * COLOUR CHANGES ESCAPES, NEVER TEXT — view 1's own version of the property
   * `monitor-views.test.ts` asserts for views 2-4 and does not assert for this
   * one. The two permitted glyph differences (the rule and the bullet) are
   * normalised out rather than excused, so a third divergence fails.
   */
  test("the coloured frame carries the same text as the plain one", () => {
    const m = model([
      { runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "eng-1", workspace: WS_OPS })] },
      { runId: RUN_B, models: [], modelsNote: null, workers: [row({ workerId: "rev-1", runId: RUN_B, workspace: null })] },
    ]);
    const strip = (s: string) =>
      s.replace(/\[[0-9;]*m/g, "").replace(/[─-]/g, "-").replace(/●/g, "*");
    expect(strip(renderFleet(m, { colour: true }).join("\n"))).toBe(
      strip(renderFleet(m).join("\n")),
    );
  });
});

// ---------------------------------------------------------------------------
// The heading text
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE NAME — what the owner actually asked for, and the fallback that keeps it
// honest when there is no name to show
// ---------------------------------------------------------------------------

describe("the heading prefers the workspace's name and falls back to its ref", () => {
  /**
   * THE REQUEST, at its simplest: a named workspace renders its name.
   *
   * `development`, not `72D01454-0368-4978-91B2-DD0B68BD8D3A`. The name is
   * cmux's `custom_title`, so the heading now matches what the operator sees in
   * cmux's own sidebar, which is the point of showing it rather than the id.
   */
  test("a named workspace renders its name, not its ref", () => {
    const frame = renderFleet(
      model([
        { runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "eng-1", workspace: WS_DEV, workspaceName: "development" })],
        },
      ]),
    ).join("\n");
    expect(frame).toContain("development");
    expect(frame).not.toContain(WS_DEV);
  });

  /**
   * THE FALLBACK, and it is the COMMON path rather than an edge case: every one
   * of the 183 records on the operator's disk carries no name, because `up`
   * records one only for a workspace it created and all 179 runs were adopted
   * into one cmux already owned.
   *
   * The fallback is the REF — not a shortened ref, not a prettified one, not
   * anything derived. A UUID announces itself as an identifier; an invented
   * label reads as a fact.
   */
  test("a nameless workspace falls back to its ref", () => {
    expect(workspaceHeading(WS_OPS, null)).toBe(WS_OPS);
    const frame = renderFleet(
      model([
        { runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "eng-1", workspace: WS_OPS, workspaceName: null })] },
      ]),
    ).join("\n");
    expect(frame).toContain(WS_OPS);
  });

  /**
   * THE ASSERTION THE COORDINATOR ASKED FOR BY NAME. A nameless record must not
   * render `undefined`, `null`, or an empty heading — a class of failure this
   * suite has already caught once, when a fixture predating `workspace` printed
   * `workspace undefined`.
   *
   * All four spellings are checked because they fail differently: `undefined`
   * and `null` come from a missing field reaching the template, `workspace `
   * with nothing after it from an empty-string name, and a bare `workspace`
   * from a heading that dropped its subject entirely.
   */
  test("a nameless record never renders undefined, null or an empty heading", () => {
    for (const name of [null, undefined as unknown as null, ""]) {
      const heading = workspaceHeading(WS_OPS, name);
      expect(heading).toBe(WS_OPS);
      expect(heading).not.toContain("undefined");
      expect(heading).not.toContain("null");
      // The word itself is gone (owner's request, 2026-09-05), so the empty
      // heading to guard against is a blank line, not a dangling `workspace `.
      expect(heading.trim()).not.toBe("");
    }

    const frame = renderFleet(
      model([
        { runId: RUN_A, models: [], modelsNote: null, workers: [
            row({ workerId: "eng-1", workspace: WS_OPS, workspaceName: undefined as unknown as null }),
            row({ workerId: "eng-2", workspace: WS_DEV, workspaceName: "" }),
          ],
        },
      ]),
    ).join("\n");
    expect(frame).not.toContain("undefined");
    expect(frame).not.toContain("null");
    expect(frame).toContain(WS_OPS);
    expect(frame).toContain(WS_DEV);
  });

  /**
   * THE IDENTITY IS THE REF, THE LABEL IS THE NAME — and conflating them merges
   * two workspaces into one group.
   *
   * Nothing stops an operator having two workspaces titled `review`. A grouper
   * keyed on the name would file both under one heading and the frame would
   * claim a fleet that does not exist. The workers must stay in two groups even
   * though the heading text is identical.
   */
  test("two workspaces sharing a name stay two groups", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "eng-1", workspace: WS_OPS, workspaceName: "review" }),
          row({ workerId: "eng-2", workspace: WS_DEV, workspaceName: "review" }),
        ],
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.workspace)).toEqual([WS_OPS, WS_DEV]);
    expect(groups.map((g) => g.name)).toEqual(["review", "review"]);
  });

  /**
   * A group whose runs DISAGREE takes the first name it can find.
   *
   * This is the ordinary state of a live fleet rather than a corner: 26 of the
   * 29 workspaces on this disk span more than one run, and the field is new, so
   * a workspace routinely holds one run that knows its name and several older
   * ones that do not. Refusing to label unless all agree would show a UUID for
   * a workspace pifleet demonstrably knows the name of.
   */
  test("a name on any worker labels the whole group", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "old-1", workspace: WS_OPS, workspaceName: null })] },
      { runId: RUN_B, models: [], modelsNote: null, workers: [row({ workerId: "new-1", runId: RUN_B, workspace: WS_OPS, workspaceName: "operations" })],
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("operations");
    expect(workspaceHeading(groups[0]!.workspace, groups[0]!.name)).toBe("operations");
  });

  /**
   * FIRST non-null, and the fixture is asymmetric so that "first" and "last"
   * give different answers.
   *
   * **Added after a mutation survived.** The test above has exactly one named
   * worker, so first and last are the same worker and a `.pop()` in place of
   * `.find()` passed it — the degenerate-fixture failure, where a rule about
   * ordering is asserted on data that has no order to get wrong. Two different
   * names in one group is the smallest fixture that can tell them apart.
   *
   * A workspace CAN legitimately carry two names over time: cmux lets an
   * operator retitle a workspace, so an older run may record `dev` where a
   * newer one records `development`. Model order is what the rest of this view
   * uses, so the heading follows it too rather than inventing a recency rule
   * the model does not carry.
   */
  test("the FIRST name in model order wins, not the last", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "a-1", workspace: WS_OPS, workspaceName: "dev" }),
          row({ workerId: "a-2", workspace: WS_OPS, workspaceName: "development" }),
        ],
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("dev");
    expect(groups[0]!.name).not.toBe("development");
  });

  /**
   * And a null FIRST worker does not veto a later name — the two rules
   * together ("skip nulls" and "take the first") need a fixture where each
   * could fail alone.
   */
  test("a null on the first worker does not suppress a later name", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [
          row({ workerId: "a-1", workspace: WS_OPS, workspaceName: null }),
          row({ workerId: "a-2", workspace: WS_OPS, workspaceName: "operations" }),
          row({ workerId: "a-3", workspace: WS_OPS, workspaceName: "later" }),
        ],
      },
    ]);
    expect(groups[0]!.name).toBe("operations");
  });

  /**
   * And the name never leaks onto the group that has no workspace. `no
   * workspace recorded` is a statement about the absence of a ref; a name
   * appearing there would be a label on nothing.
   */
  test("the detached group is never given a name", () => {
    const groups = groupByWorkspace([
      { runId: RUN_A, models: [], modelsNote: null, workers: [row({ workerId: "eng-1", workspace: null, workspaceName: "development" })],
      },
    ]);
    expect(workspaceHeading(groups[0]!.workspace, groups[0]!.name)).toBe(NO_WORKSPACE);
  });
});

// ---------------------------------------------------------------------------
// R4 (round 2) — where the NAME comes from, and where it honestly cannot
// ---------------------------------------------------------------------------

describe("up records the name only for a workspace it named itself", () => {
  const NAME = "pifleet-2026-09-04T10-00-00Z-aaaa";

  /**
   * The path where a name exists: pifleet called `ensureWorkspace(name)`, so
   * the name is the INPUT and is known with no I/O at all.
   */
  test("a workspace pifleet created carries its ref and its name", () => {
    expect(presentedWorkspace(null, { id: WS_DEV }, NAME)).toEqual({
      ref: WS_DEV,
      name: NAME,
    });
  });

  /**
   * THE ADOPTED PATH, which is every run on this machine.
   *
   * `up --attach-here` takes over a workspace cmux already owned. The ref
   * arrives from `CMUX_WORKSPACE_ID`; the NAME is not obtainable — probed
   * against the installed cmux 0.64.x, the binary exports `CMUX_WORKSPACE_ID`,
   * `CMUX_SURFACE_ID` and `CMUX_PANE_ID` and nothing carrying a title. So the
   * honest record is a ref with no name, and the view falls back.
   *
   * **`createdName` is passed and must be IGNORED.** It is a perfectly good
   * string in that scope — `pifleet-<runId>` — and writing it here would label
   * the operator's `development` console with a name it does not have. That is
   * the single most tempting wrong answer in this function, so it is asserted
   * directly rather than left to the shape.
   */
  test("an adopted workspace carries its ref and NO name", () => {
    expect(presentedWorkspace({ workspace: WS_OPS }, { id: null }, NAME)).toEqual({
      ref: WS_OPS,
      name: null,
    });
    // Even when a workspace WAS created alongside, the handed-over one wins and
    // still contributes no name.
    expect(presentedWorkspace({ workspace: WS_OPS }, { id: WS_DEV }, NAME)).toEqual({
      ref: WS_OPS,
      name: null,
    });
  });

  /**
   * Headless with nothing handed over: no workspace at all, so no name. The
   * arm exists separately from the adopted one because `createdName` is still
   * in scope and still a valid string — a bare `handedOver === null` test would
   * attach a name to a workspace that does not exist.
   */
  test("no workspace means no name", () => {
    expect(presentedWorkspace(null, { id: null }, NAME)).toEqual({ ref: null, name: null });
  });

  /**
   * THE CONSOLE'S OWN NAME, supplied by the caller — the route that finally
   * puts a real title on the operator's fleet.
   *
   * `up` cannot discover it (cmux exports no name variable) and must not ask
   * cmux for it (ISC-137, and `--attach-here` needs no socket). But the console
   * SCRIPT knows: `operations`, `development` and `review` are compile-time
   * constants and the script is what asked cmux to create or match that title.
   * So it travels as an argument from the one place that holds it.
   */
  test("a declared name is recorded on the adopted path", () => {
    expect(presentedWorkspace({ workspace: WS_OPS }, { id: null }, NAME, "review")).toEqual({
      ref: WS_OPS,
      name: "review",
    });
  });

  /**
   * THE TRUTHFULNESS GATE, and it is gated on the REF rather than on the flag.
   *
   * A caller can pass `--workspace-name review` from a terminal that is not a
   * cmux pane at all — a hand-typed `up --attach-here` in Terminal.app, or a
   * script run outside its console. There is then no `CMUX_WORKSPACE_ID` and no
   * ref, and a name recorded against nothing would be a label the monitor files
   * under `no workspace recorded` while claiming to be `review`.
   *
   * So an absent ref takes the name with it. The invariant holds by
   * construction rather than by the caller being careful, which is the only
   * version of it worth having.
   */
  test("a declared name without a ref is discarded, not recorded", () => {
    expect(presentedWorkspace({ workspace: null }, { id: null }, NAME, "review")).toEqual({
      ref: null,
      name: null,
    });
  });

  /**
   * The flag does NOT override a workspace pifleet named itself.
   *
   * `ensureWorkspace(createdName)` is the call that set cmux's `custom_title`,
   * so recording anything else would put a name in `presentation.json` that
   * contradicts the workspace it describes. The flag supplies a name that is
   * otherwise unknowable; it is not a rename.
   */
  test("a declared name never overrides the name pifleet gave the workspace", () => {
    expect(presentedWorkspace(null, { id: WS_DEV }, NAME, "review")).toEqual({
      ref: WS_DEV,
      name: NAME,
    });
  });

  /**
   * And omitting it is the ordinary case — every hand-typed `up --attach-here`
   * and every console that has not been taught to pass it. Both spellings of
   * "nobody said" behave the same.
   */
  /**
   * AN EMPTY DECLARED NAME IS NOT A NAME — added after a battery arm survived.
   *
   * `--workspace-name ""`, or a shell expansion that produced nothing, arrives
   * as `""`, which `??` does not catch. The record would then carry
   * `workspace_name: ""` — a value shaped like "there is a name and it is
   * empty". The view already falls back on it (that is what the fallback is
   * for), so this was invisible on screen; it was still a false record.
   */
  test("an empty declared name is recorded as no name at all", () => {
    expect(presentedWorkspace({ workspace: WS_OPS }, { id: null }, NAME, "").name).toBeNull();
  });

  test("no declared name leaves the adopted record nameless, as before", () => {
    for (const absent of [undefined, null, ""]) {
      expect(presentedWorkspace({ workspace: WS_OPS }, { id: null }, NAME, absent)).toEqual({
        ref: WS_OPS,
        name: null,
      });
    }
  });

  /**
   * THE INVARIANT, swept over every combination rather than spot-checked: a
   * name is never recorded without its ref. A label attached to no group is
   * either dropped silently or merged into `no workspace recorded` while
   * claiming to be something else.
   */
  test("a name is never recorded without a ref", () => {
    /*
     * SWEPT OVER THE DECLARED NAME TOO, and widening it was not optional: the
     * flag adds a third input, so a sweep that fixed it at `undefined` would
     * have stopped covering every path the moment `--workspace-name` existed —
     * the shape where a criterion silently narrows while still reading as a
     * sweep.
     */
    for (const handedOver of [null, { workspace: null }, { workspace: WS_OPS }]) {
      for (const created of [{ id: null }, { id: WS_DEV }]) {
        for (const declared of [undefined, null, "review", ""]) {
          const r = presentedWorkspace(handedOver, created, NAME, declared);
          const where = JSON.stringify([handedOver, created, declared]);
          if (r.name !== null) {
            expect(r.ref, `name ${r.name} recorded with no ref at ${where}`).not.toBeNull();
          }
        }
      }
    }
  });

  /**
   * TESTING THE TESTER. The sweep above only means something if some
   * combination actually produces a name — a function that returned `name:
   * null` for everything would satisfy it completely.
   */
  test("the invariant sweep is not vacuous — some combination does yield a name", () => {
    const named = [
      presentedWorkspace(null, { id: WS_DEV }, NAME).name,
      presentedWorkspace({ workspace: WS_OPS }, { id: null }, NAME, "review").name,
    ];
    expect(named).toEqual([NAME, "review"]);
  });
});

// ---------------------------------------------------------------------------
// The schema — old records must still parse
// ---------------------------------------------------------------------------

describe("the presentation schema stays backward compatible", () => {
  /**
   * THE ASSERTION THE COORDINATOR ASKED FOR BY NAME.
   *
   * All 183 `presentation.json` records on the operator's disk predate
   * `workspace_name`. A required field would fail every one of them — and that
   * failure is not "no name", it takes `adopted_terminal`, `surface_ref` and
   * the workspace itself down with it, on every historical run at once, because
   * the whole record fails to parse.
   */
  test("a record written before the field existed still parses", () => {
    const old = {
      schema: "pifleet.presentation/v1",
      worker: "eng-1",
      backend: "headless",
      workspace_ref: WS_OPS,
      surface_ref: "068FDE04-AEE8-4C00-BA3B-4AC315A7AAEA",
      window_ref: null,
      adopted_terminal: true,
    };
    const parsed = PresentationSchema.parse(old);
    expect(parsed.workspace_name).toBeNull();
    // And the rest of the record survives — the point of the default.
    expect(parsed.workspace_ref).toBe(WS_OPS);
    expect(parsed.adopted_terminal).toBe(true);
  });

  test("a record carrying a name round-trips it", () => {
    const parsed = PresentationSchema.parse({
      schema: "pifleet.presentation/v1",
      worker: "eng-1",
      backend: "cmux",
      workspace_ref: WS_DEV,
      workspace_name: "development",
    });
    expect(parsed.workspace_name).toBe("development");
  });

  /**
   * TESTING THE TESTER. The backward-compatibility case above is only
   * meaningful if this schema actually rejects something — a `.parse` that
   * accepted anything would make it vacuous.
   */
  test("the schema still refuses a record it should", () => {
    expect(() =>
      PresentationSchema.parse({ schema: "pifleet.presentation/v1", worker: "eng-1" }),
    ).toThrow();
  });
});

describe("the heading says what it is, in both frames", () => {
  /**
   * The plain frame has no colour to carry meaning, so the WORD has to. A
   * heading that were the bare ref would be indistinguishable from a run id in
   * a piped frame, which is the frame a grep or a diff reads.
   */
  test("a known workspace is labelled and named", () => {
    expect(workspaceHeading(WS_OPS)).toBe(WS_OPS);
  });

  /**
   * `null` is "pifleet never recorded a workspace for this worker", which is
   * NOT the same claim as "this worker is detached from a console it once had"
   * — a headless run never had one. The wording says what is true of the
   * RECORD, because that is the only thing this monitor knows.
   */
  test("no workspace is stated as a fact about the record, not a verdict", () => {
    expect(workspaceHeading(null)).toBe(NO_WORKSPACE);
    expect(NO_WORKSPACE).toContain("no workspace");
  });

  /**
   * The two never collide. A `workspaceHeading` that returned the same string
   * for a real workspace and for the absence of one would merge two groups on
   * screen while the model kept them apart.
   */
  test("a real workspace never renders as the absent one", () => {
    expect(workspaceHeading(WS_OPS)).not.toBe(workspaceHeading(null));
  });
});

// ---------------------------------------------------------------------------
// R4 — where the workspace comes from, end to end
// ---------------------------------------------------------------------------

describe("the workspace is read from presentation.json, not asked of cmux", () => {
  const bases: string[] = [];

  async function makeRoot(tag: string): Promise<string> {
    const b = await mkdtemp(join(tmpdir(), `pifleet-ws-${tag}-`));
    bases.push(b);
    return join(b, "runs");
  }

  async function makeRun(root: string, runId: string) {
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }));
    return run;
  }

  async function makeWorker(
    run: ReturnType<typeof runPaths>,
    worker: string,
    ws: string | null,
    name: string | null = null,
  ) {
    const wp = workerPaths(run, worker);
    await mkdir(wp.dir, { recursive: true });
    await writeFile(
      wp.stateJson,
      JSON.stringify(
        WorkerStateSchema.parse({
          schema: "pifleet.state/v1",
          worker,
          run_id: run.runId,
          pid: process.pid,
          pgid: process.pid,
          started_at: new Date().toISOString(),
          phase: "idle",
          epoch: 0,
        }),
      ),
    );
    if (ws !== undefined) {
      await writeFile(
        wp.presentationJson,
        JSON.stringify(
          PresentationSchema.parse({
            schema: "pifleet.presentation/v1",
            worker,
            backend: "headless",
            workspace_ref: ws,
            workspace_name: name,
          }),
        ),
      );
    }
    return wp;
  }

  function expectOk<T>(region: { status: string } & Record<string, unknown>): T {
    if (region.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(region)}`);
    return region["value"] as T;
  }

  test("the ref on disk reaches the row", async () => {
    const root = await makeRoot("disk");
    const run = await makeRun(root, RUN_A);
    await makeWorker(run, "eng-1", WS_OPS);

    const read = expectOk<{ row: WorkerRow }>(
      (await readWorkerRow(run, "eng-1")) as never,
    );
    expect(read.row.workspace).toBe(WS_OPS);
  });

  /**
   * A record with `workspace_ref: null` — the majority shape on this disk —
   * must produce `null` and NOT be defaulted to anything. There is no
   * permissive value to fall back to and inventing one would file the worker
   * under a console it was never in.
   */
  test("a null ref stays null", async () => {
    const root = await makeRoot("null");
    const run = await makeRun(root, RUN_A);
    await makeWorker(run, "eng-1", null);

    const read = expectOk<{ row: WorkerRow }>((await readWorkerRow(run, "eng-1")) as never);
    expect(read.row.workspace).toBeNull();
  });

  /**
   * THE FAST-CLOCK PATH, and it is the one that fails silently.
   *
   * `refreshWorkerRow` runs on the 500 ms clock and re-reads only `state.json`,
   * carrying the satellites forward. A refresh that forgot the workspace would
   * render a correctly grouped frame for the first half-second after `up` and
   * then collapse the whole fleet into `no workspace recorded` — a regression
   * that appears only in a live pane, never in a one-shot render, and never in
   * a test that only calls `readWorkerRow`.
   */
  test("the fast refresh carries the workspace forward rather than losing it", async () => {
    const root = await makeRoot("fast");
    const run = await makeRun(root, RUN_A);
    await makeWorker(run, "eng-1", WS_OPS);

    const first = expectOk<{ row: WorkerRow; evidence: never }>(
      (await readWorkerRow(run, "eng-1")) as never,
    );
    expect(first.row.workspace).toBe(WS_OPS);

    const next = expectOk<{ row: WorkerRow }>(
      (await refreshWorkerRow(run, "eng-1", first.evidence)) as never,
    );
    expect(next.row.workspace).toBe(WS_OPS);
  });

  /**
   * The derivation itself, as a pure function, because both call sites go
   * through it — the same discipline `deriveVia` is held to, for the same
   * reason: one expression in this repository turns a presentation record into
   * a workspace, so a fast path cannot drift from a slow one.
   */
  /**
   * THE NAME, END TO END — added after a mutation survived, and the survival is
   * the reason this test exists rather than a nicety.
   *
   * The round-2 battery replaced `deriveWorkspaceName`'s body with `return
   * null` and the whole 317-test suite stayed green. Every assertion about the
   * name was on `presentedWorkspace` (the writer) or on `workspaceHeading` and
   * `groupByWorkspace` (the view); nothing joined the two, so a reader that
   * silently answered "no name" for every record would have shipped, and the
   * heading would have fallen back to a UUID forever while every test agreed it
   * was fine. Round 1 had exactly this test for `workspace` and it was not
   * mirrored for the name.
   */
  test("a name on disk reaches the row", async () => {
    const root = await makeRoot("name");
    const run = await makeRun(root, RUN_A);
    await makeWorker(run, "eng-1", WS_DEV, "development");

    const read = expectOk<{ row: WorkerRow }>((await readWorkerRow(run, "eng-1")) as never);
    expect(read.row.workspace).toBe(WS_DEV);
    expect(read.row.workspaceName).toBe("development");
  });

  /**
   * A record with a ref and NO name — the shape of all 183 records on the
   * operator's disk — reads back as a null name, not as an absent field, an
   * `undefined`, or a throw.
   */
  test("a record with no name reads back a null name, and still reads its ref", async () => {
    const root = await makeRoot("noname");
    const run = await makeRun(root, RUN_A);
    await makeWorker(run, "eng-1", WS_OPS, null);

    const read = expectOk<{ row: WorkerRow }>((await readWorkerRow(run, "eng-1")) as never);
    expect(read.row.workspace).toBe(WS_OPS);
    expect(read.row.workspaceName).toBeNull();
  });

  /**
   * THE FAST-CLOCK PATH FOR THE NAME. The second survivor: dropping the name
   * from `refreshWorkerRow` killed nothing, and the failure it hides is the one
   * that only appears in a live pane — a correctly named heading for half a
   * second after `up`, then a silent collapse to UUIDs on the first refresh.
   */
  test("the fast refresh carries the name forward as well as the ref", async () => {
    const root = await makeRoot("fastname");
    const run = await makeRun(root, RUN_A);
    await makeWorker(run, "eng-1", WS_DEV, "development");

    const first = expectOk<{ row: WorkerRow; evidence: never }>(
      (await readWorkerRow(run, "eng-1")) as never,
    );
    expect(first.row.workspaceName).toBe("development");

    const next = expectOk<{ row: WorkerRow }>(
      (await refreshWorkerRow(run, "eng-1", first.evidence)) as never,
    );
    expect(next.row.workspace).toBe(WS_DEV);
    expect(next.row.workspaceName).toBe("development");
  });

  /**
   * The name's derivation as a pure function, mirroring the ref's below.
   *
   * `deriveWorkspaceName` was IMPORTED by this file and never called until the
   * battery pointed it out — a dead import reads as coverage and is not.
   */
  test("the name derivation is one function with three honest answers", () => {
    expect(deriveWorkspaceName({ workspace_name: "development" } as never)).toBe("development");
    expect(deriveWorkspaceName({ workspace_name: null } as never)).toBeNull();
    expect(deriveWorkspaceName(null)).toBeNull();
  });

  /**
   * THE WRITE SITE, asserted STRUCTURALLY — and the limit is stated rather than
   * papered over.
   *
   * A third mutation survived: replacing `workspace_name: presented.name` with
   * `workspace_name: null` in `up.ts` killed nothing, because `up` cannot be
   * invoked from a unit test — it needs a config, a backend, a container
   * runtime and a runs root. So the helper is proved by value and the WIRING
   * from helper to record is proved only by reading the source.
   *
   * That is weaker than a behavioural test and it is not nothing: it fails if
   * someone writes a literal, drops the field, or reaches past the helper for
   * `workspaceName`/`handedOver` directly — which are the ways this actually
   * goes wrong. The honest verification is an integration test that runs `up`,
   * and `test/integration/up-wiring.test.ts` is where it would live; it is
   * another engineer's file this round.
   */
  test("up's write site takes both fields from the helper, not from literals", () => {
    const source = readFileSync(
      new URL("../../src/cli/commands/up.ts", import.meta.url).pathname,
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).toContain(
      "const presented = presentedWorkspace(handedOver, workspace, workspaceName, opts.workspaceName)",
    );
    expect(source).toContain("workspace_ref: presented.ref,");
    expect(source).toContain("workspace_name: presented.name,");
    // The flag is registered, or `opts.workspaceName` is permanently undefined
    // and the whole console route is dead while every assertion above passes.
    expect(source).toContain('"--workspace-name <name>"');
    expect(source).toContain("workspaceName?: string");
    // And the name pifleet passes to cmux is the same string it records, not a
    // second spelling of the template.
    expect(source).toContain("const workspaceName = `pifleet-${runId}`");
    expect(source).toContain("backend.ensureWorkspace(workspaceName)");
  });

  test("the derivation is one function with three honest answers", () => {
    expect(deriveWorkspace({ workspace_ref: WS_OPS } as never)).toBe(WS_OPS);
    expect(deriveWorkspace({ workspace_ref: null } as never)).toBeNull();
    // No record at all — `presentation.json` absent or unreadable.
    expect(deriveWorkspace(null)).toBeNull();
  });

  test("cleanup", async () => {
    for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
    expect(true).toBe(true);
  });
});
