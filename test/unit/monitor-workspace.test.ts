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
import { deriveWorkspace, readWorkerRow, refreshWorkerRow } from "../../src/monitor/read/worker.ts";
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
      model([{ runId: RUN_A, workers: [row({ workerId: "eng-1", workspace: null })] }]),
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
        {
          runId: RUN_A,
          workers: [
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
      {
        runId: RUN_A,
        workers: [
          row({ workerId: "eng-1", workspace: WS_OPS }),
          row({ workerId: "eng-2", workspace: null }),
          row({ workerId: "eng-3", workspace: WS_DEV }),
        ],
      },
      {
        runId: RUN_B,
        workers: [
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
      {
        runId: RUN_A,
        workers: [
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
      {
        runId: RUN_A,
        workers: [
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
    const frame = renderFleet(model([{ runId: RUN_A, workers: [] }])).join("\n");
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
      {
        runId: RUN_A,
        workers: [
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
        { runId: RUN_A, workers: [row({ workerId: "eng-1", workspace: WS_OPS })] },
        { runId: RUN_B, workers: [row({ workerId: "rev-1", runId: RUN_B, workspace: null })] },
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
      {
        runId: RUN_A,
        workers: [
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
      {
        runId: RUN_A,
        workers: [
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
      {
        runId: RUN_A,
        workers: [
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
        { runId: RUN_A, workers: [row({ workerId: "eng-1", workspace: undefined as unknown as null })] },
      ]),
    ).join("\n");
    expect(frame).toContain(NO_WORKSPACE);
    expect(frame).not.toContain("undefined");
  });

  test("run order and worker order inside a group are the model's", () => {
    const groups = groupByWorkspace([
      { runId: RUN_B, workers: [row({ workerId: "z-1", runId: RUN_B })] },
      { runId: RUN_A, workers: [row({ workerId: "a-2" }), row({ workerId: "a-1" })] },
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
   * THE TEST'S OWN CONTROL, and it is not decoration.
   *
   * `COLOUR.warn` is ALREADY yellow. Had the heading reused `warn` instead of
   * getting its own entry, both assertions above would pass and the palette's
   * stated discipline — *"the assignment is by SEVERITY and not by category"* —
   * would be broken: every workspace heading would be painted in the colour
   * this design reserves for "has never spoken, needs a look". The entry must
   * be its own, and it must not collide with the region heading either, or the
   * two tiers become one to the eye.
   */
  test("it is its own palette entry, distinct from the region heading", () => {
    expect(COLOUR.workspace).not.toBe(COLOUR.heading);
    expect(COLOUR.workspace).not.toBe(COLOUR.dim);
    expect(COLOUR.workspace).not.toBe(COLOUR.live);
  });

  /**
   * The plain frame carries no ESC byte anywhere. Weaker than it looks under a
   * piped runner (see above), so it is a floor and not the argument — but it is
   * the assertion that fails outright if someone hard-codes `\x1b[33m` into the
   * heading, which is the specific thing R2 forbids.
   */
  test("the plain frame contains no escape byte", () => {
    const frame = renderFleet(
      model([{ runId: RUN_A, workers: [row({ workerId: "eng-1", workspace: WS_OPS })] }]),
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
      { runId: RUN_A, workers: [row({ workerId: "eng-1", workspace: WS_OPS })] },
      { runId: RUN_B, workers: [row({ workerId: "rev-1", runId: RUN_B, workspace: null })] },
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

describe("the heading says what it is, in both frames", () => {
  /**
   * The plain frame has no colour to carry meaning, so the WORD has to. A
   * heading that were the bare ref would be indistinguishable from a run id in
   * a piped frame, which is the frame a grep or a diff reads.
   */
  test("a known workspace is labelled and named", () => {
    expect(workspaceHeading(WS_OPS)).toBe(`workspace ${WS_OPS}`);
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

  async function makeWorker(run: ReturnType<typeof runPaths>, worker: string, ws: string | null) {
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
