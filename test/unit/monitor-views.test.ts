/**
 * Views 2-4, asserted as lines and only as lines (D2, ISC-503, ISC-504,
 * ISC-505).
 *
 * ## The same bargain `monitor-render.test.ts` strikes, for the same reason
 *
 * D2 puts Ink behind `renderFleet(model): string[]` and says the decision is
 * cheap to unwind precisely because "swapping to a hand-rolled renderer later
 * means reimplementing those functions and changing no test". **That promise is
 * only true if no test in this file can tell which toolkit rendered the frame.**
 * So there is no `render()` from `ink-testing-library` here, no component
 * import, no `lastFrame()`, and no assertion on a tree. The only things imported
 * from `src/monitor/views/*` are the floor descriptors and the layout planners —
 * plain data and pure functions of one number, which a hand-rolled renderer
 * would keep unchanged.
 *
 * ## Every input is a literal, so ISC-491 keeps holding
 *
 * No terminal, no container, no runs directory, no report collector. The three
 * new views are reached by setting `model.view`, which is the whole of what the
 * dispatch in `render.ts` reads.
 *
 * ## The fixture is built to defeat a view that renders the wrong region
 *
 * `healthy` below carries a LIVE fleet, a LIVE history, a LIVE worker detail and
 * a LIVE report all at once, every one of them `ok`. That is not a realistic
 * model — `model.ts:209-230` says three of the four are `never` until the
 * operator asks — and it is the only fixture that can catch ISC-503's failure.
 * A model in which the other regions were `never` would let a view that read the
 * wrong one pass, because the wrong one would have had nothing to say.
 */

import { describe, expect, test } from "bun:test";

import { failed, never, ok } from "../../src/monitor/model.ts";
import type {
  FleetModel,
  RunHistoryRow,
  RunRow,
  WorkerDetail,
  WorkerRow,
} from "../../src/monitor/model.ts";
import { renderFleet } from "../../src/monitor/render.ts";
import { FLEET_FLOOR } from "../../src/monitor/views/fleet.tsx";
import { HISTORY_FLOOR, planHistoryColumns } from "../../src/monitor/views/history.tsx";
import { REPORT_FLOOR } from "../../src/monitor/views/report.tsx";
import { WORKER_FLOOR, planWorkerColumns } from "../../src/monitor/views/worker.tsx";
import { longestRefusalWord } from "../../src/monitor/views/chrome.tsx";
import type { ViewFloor } from "../../src/monitor/views/chrome.tsx";

const NOW = Date.parse("2026-09-02T14:00:00.000Z");
const RUN_A = "2026-09-02T14-43-27Z-3906";
const RUN_B = "2026-09-02T09-11-02Z-1180";

const worker: WorkerRow = {
  workerId: "eng-1",
  runId: RUN_A,
  activity: "active",
  phase: "running",
  transcriptAgeMs: 4_000,
  containerPresent: true,
  taskId: "t-17",
  via: "rpc",
  fence: null,
  workspace: null,
  workspaceName: null,
};

const RUNS: readonly RunRow[] = [{ runId: RUN_A, workers: [worker] }];

const HISTORY: readonly RunHistoryRow[] = [
  { runId: RUN_A, ageMs: 120_000, workerCount: 4, live: true, taskCount: 5, settledCount: 3 },
  { runId: RUN_B, ageMs: 5 * 3_600_000, workerCount: 2, live: false, taskCount: 1, settledCount: 1 },
];

/**
 * The event lines are ALREADY SANITISED AND CLIPPED by the reader
 * (`model.ts:317-323`). They are deliberately ordinary here — the view is not
 * allowed to know anything about their content, so a fixture with special
 * characters in it would be testing `logs.ts` from the wrong side of the seam.
 */
const DETAIL: WorkerDetail = {
  workerId: "eng-1",
  runId: RUN_A,
  eventLines: ["14:43:01 tool_use Bash", "14:43:02 tool_result ok", "14:43:05 assistant done"],
  clippedHead: false,
  eventsPresent: true,
  phase: "running",
  turns: 12,
  inputTokens: 4_210,
  outputTokens: 1_180,
  credentialDegraded: false,
  exit: null,
  /*
   * A `pane` worker with a live epoch — deliberately NOT the quietest values.
   * `via: "rpc"` and `fence: null` are what a worker that has done nothing
   * looks like, and a base fixture carrying them would make every assertion
   * about the refusal surface pass on a row where there was nothing to refuse.
   */
  via: "pane",
  fence: { liveTaskId: "t-7", abortRequested: false, attemptCount: 2 },
};

/**
 * The report lines, as `renderRunReport` already formatted them (D10, §6.2).
 *
 * **The merge-precheck line is here VERBATIM**, and it is the assertion that
 * catches a frame which restyles what it was handed. Its exact wording is
 * `report/render.ts:265`'s, and §6.2 requires it survive to the pane unchanged
 * because a reader skimming for "clean" must not walk away believing something
 * landed (`report/render.ts:8-12`).
 */
const MERGE_LINE =
  "- eng-1 (pifleet/eng-1): would merge cleanly onto main as of this check — NOT merged";
const REPORT_LINES: readonly string[] = [
  `# pifleet run ${RUN_A}`,
  "generated 2026-09-02T15:00:00.000Z",
  "",
  "## ATTENDED — worker eng-1",
  "    a person typed into this pane",
  "",
  "## merge pre-check",
  MERGE_LINE,
];

/** Every region `ok` at once — see the header for why that is the point. */
const healthy: FleetModel = {
  runs: ok(RUNS, NOW - 2_000),
  containers: ok(["pifleet-egress-relay-pifleet-egress"], NOW - 12_000),
  now: NOW,
  columns: 120,
  view: { kind: "fleet" },
  history: ok(HISTORY, NOW - 30_000),
  detail: ok(DETAIL, NOW - 2_000),
  report: ok(REPORT_LINES, NOW - 4_000),
};

const onWorker = (over: Partial<FleetModel> = {}): FleetModel => ({
  ...healthy,
  view: { kind: "worker", runId: RUN_A, workerId: "eng-1" },
  ...over,
});
const onHistory = (over: Partial<FleetModel> = {}): FleetModel => ({
  ...healthy,
  view: { kind: "history" },
  ...over,
});
const onReport = (over: Partial<FleetModel> = {}): FleetModel => ({
  ...healthy,
  view: { kind: "report", runId: RUN_A },
  ...over,
});

const text = (m: FleetModel): string => renderFleet(m).join("\n");

/**
 * The frame as ONE line with runs of whitespace collapsed.
 *
 * Needed wherever the assertion is about a SENTENCE rather than about layout.
 * The floor refusal wraps by design (`chrome.tsx`), so at the widths where it
 * fires — two columns, one below a floor — `needs at least` is genuinely broken
 * across two lines, and a `toContain` against the joined frame fails for
 * entirely correct code. That is the trap this helper exists to keep out of
 * five separate assertions; it was found by writing them without it.
 */
const flat = (m: FleetModel): string => renderFleet(m).join(" ").replace(/\s+/g, " ");

/**
 * A region's heading line, by NAME rather than by index — the same helper
 * `monitor-render.test.ts` argues for, for the same reason: an index is where a
 * line happened to land, and a rule was once drawn above one.
 */
function headingFor(lines: readonly string[], region: string): string {
  const hits = lines.filter((l) => l.startsWith(`${region} `) || l === region);
  expect({ region, matches: hits.length }).toEqual({ region, matches: 1 });
  return hits[0] as string;
}

// ---------------------------------------------------------------------------
// ISC-503 — each view renders only from its own selection
// ---------------------------------------------------------------------------

/**
 * The criterion that keeps four views from becoming one view with four moods.
 *
 * Every region in `healthy` is `ok` and full of content, so a view that reached
 * for the wrong one gets a plausible frame rather than an empty one — which is
 * exactly how this defect would ship. The assertions are therefore written as
 * MUTUAL EXCLUSION over a shared fixture, not as "the worker view contains an
 * event line", which a view rendering everything would also satisfy.
 */
describe("ISC-503: a view renders its own region and cannot reach another", () => {
  /**
   * One string per region that appears NOWHERE else in the fixture, so a hit is
   * unambiguous evidence that a region reached the frame.
   *
   * Chosen rather than generated: `eng-1` is in three regions at once and would
   * prove nothing, and that overlap is realistic — the same worker legitimately
   * appears in the fleet row, the detail and the report.
   */
  const MARKERS = {
    runs: "wrote 4s ago",
    containers: "containers — as of",
    history: "finished",
    detail: "tool_result ok",
    report: "would merge cleanly",
  } as const;

  const EXPECTED: Record<string, ReadonlyArray<keyof typeof MARKERS>> = {
    fleet: ["runs", "containers"],
    worker: ["detail"],
    history: ["history"],
    report: ["report"],
  };

  const FRAMES: ReadonlyArray<readonly [string, FleetModel]> = [
    ["fleet", healthy],
    ["worker", onWorker()],
    ["history", onHistory()],
    ["report", onReport()],
  ];

  /**
   * The whole criterion as one property. Reported per (view, region) pair so a
   * failure names which view leaked which region, rather than printing `false`.
   */
  test("every view carries exactly the regions it owns, and no others", () => {
    for (const [name, model] of FRAMES) {
      const frame = text(model);
      const own = EXPECTED[name] as ReadonlyArray<keyof typeof MARKERS>;
      for (const [region, marker] of Object.entries(MARKERS) as [
        keyof typeof MARKERS,
        string,
      ][]) {
        expect({ view: name, region, present: frame.includes(marker) }).toEqual({
          view: name,
          region,
          present: own.includes(region),
        });
      }
    }
  });

  /**
   * THE ASYMMETRIC CASE, and the one the sweep above cannot make on its own.
   *
   * A view whose own region has never been read must say so rather than falling
   * back on a region that HAS been read. The fleet, history and report regions
   * are all `ok` in this model; only `detail` is `never`. A view 2 that
   * borrowed from `runs` would render a confident worker row here, and every
   * other assertion in this file would still pass.
   */
  test("a never-read region renders as no data, never as a neighbour's content", () => {
    const frame = text(onWorker({ detail: never() }));
    expect(headingFor(frame.split("\n"), "worker")).toBe("worker eng-1 — no data");
    for (const marker of Object.values(MARKERS)) {
      expect({ marker, present: frame.includes(marker) }).toEqual({ marker, present: false });
    }
  });

  /**
   * The selection is NAMED even when the payload is absent, which is the other
   * half of "no view can render without one". A frame that could not say which
   * worker it failed to read would send the operator back to view 1 to find out
   * what they had just selected.
   */
  test("every selection-carrying view names its selection with no payload at all", () => {
    expect(text(onWorker({ detail: never() }))).toContain("eng-1");
    expect(text(onWorker({ detail: never() }))).toContain(RUN_A);
    expect(text(onReport({ report: never() }))).toContain(RUN_A);
  });

  /**
   * THE SELECTION AND THE PAYLOAD CAN DISAGREE, and §6.4's markers do not catch
   * it: every marker in this design answers "how old is this?" and none answers
   * "is this about the thing the heading names?". A detail for the previous
   * worker, freshly read, renders a correctly-aged frame under the wrong name.
   */
  test("a payload for a different worker is called out, not rendered silently", () => {
    const frame = text(
      onWorker({ detail: ok({ ...DETAIL, workerId: "eng-2" }, NOW - 1_000) }),
    );
    expect(frame).toContain("detail is for eng-2");
    expect(frame).toContain("not the selected worker");
  });

  test("a matching payload says nothing about a mismatch", () => {
    expect(text(onWorker())).not.toContain("not the selected worker");
  });

  /**
   * ISC-478 in the new views: a failed region's reason stands IN PLACE of its
   * content, and there is no branch that can append it beside a retained value.
   */
  test("a failed region names the reason and renders no body", () => {
    const frame = text(onHistory({ history: failed("runs root unreadable: EACCES", NOW - 9_000) }));
    expect(frame).toContain("refresh failed: runs root unreadable: EACCES");
    expect(frame).not.toContain("finished");
    expect(frame).toContain("as of 9s");
  });

  /**
   * ISC-479 in the new views: "I could not look" and "I looked and there was
   * nothing" are different facts, and only one of them names a broken monitor.
   * `history` is the view where this bites hardest — `model.ts:209-215` makes it
   * `never` until the operator enters the mode, so the never-read frame is the
   * one they see FIRST, for as long as the walk takes.
   */
  test("never-read and read-and-empty are different sentences in every view", () => {
    const lines = (m: FleetModel) => renderFleet(m);
    expect(headingFor(lines(onHistory({ history: never() })), "history")).toBe("history — no data");
    expect(headingFor(lines(onHistory({ history: ok([], NOW - 30_000) })), "history")).toBe(
      "history — as of 30s — no runs on disk",
    );
    expect(text(onReport({ report: ok([], NOW - 4_000) }))).toContain("rendered no lines");
    expect(text(onReport({ report: never() }))).not.toContain("rendered no lines");
  });
});

// ---------------------------------------------------------------------------
// ISC-504 — View 2 shows `clippedHead`; truncation is never silent
// ---------------------------------------------------------------------------

/**
 * §6.4 is "staleness is displayed, never hidden", and a truncated window is the
 * same class one level over: **a viewer whose history silently starts in the
 * middle is a viewer that lies about what happened.** View 2 is opened to answer
 * "which worker died and why", and that answer is very often above the window.
 */
describe("ISC-504: a clipped event window says so", () => {
  const clipped = (over: Partial<WorkerDetail> = {}) =>
    renderFleet(onWorker({ detail: ok({ ...DETAIL, clippedHead: true, ...over }, NOW - 2_000) }));

  test("the marker is on the frame when clippedHead is true", () => {
    expect(clipped().join("\n")).toContain("events clipped");
  });

  /**
   * THE MUTUAL-EXCLUSION HALF, and it is what makes the assertion above worth
   * making. A view that printed the marker unconditionally would pass a
   * `toContain` and would be useless — the operator would learn to ignore a
   * warning that is always on, which is the same failure `activity.ts:99-107`
   * argues against for `no container` at startup.
   */
  test("and is absent when it is false, so the marker means something", () => {
    expect(text(onWorker())).not.toContain("events clipped");
  });

  /**
   * The marker sits ABOVE the oldest line it applies to, because that is where
   * the missing history would have been. Below the lines it would read as a
   * footer about the newest event, which is the opposite of what it says.
   */
  test("the marker is above the events, not below them", () => {
    const lines = clipped();
    const marker = lines.findIndex((l) => l.includes("events clipped"));
    const oldest = lines.findIndex((l) => l.includes("tool_use Bash"));
    expect({ found: marker >= 0 && oldest >= 0, above: marker < oldest }).toEqual({
      found: true,
      above: true,
    });
  });

  /**
   * IT SURVIVES EVERY WIDTH AT WHICH THE VIEW DRAWS AT ALL.
   *
   * A marker that fits at 120 columns and is truncated away at 40 is a silent
   * truncation about a silent truncation, and it would be found by an operator
   * on a narrow pane — which is the pane most likely to be clipping.
   */
  test("the marker survives every width from the floor upward", () => {
    for (const columns of [WORKER_FLOOR.columns, 30, 40, 60, 80, 120]) {
      const joined = clipped().join("\n");
      const at = renderFleet(
        onWorker({
          columns,
          detail: ok({ ...DETAIL, clippedHead: true }, NOW - 2_000),
        }),
      )
        .join(" ")
        .replace(/\s+/g, " ");
      expect({ columns, marked: at.includes("events clipped") }).toEqual({ columns, marked: true });
      expect(joined).toContain("events clipped");
    }
  });

  /**
   * The three absences §6.2 and `model.ts:326-333` keep apart. One string for
   * all three would tell an operator that a worker nothing has read is the same
   * as one with nothing to say.
   */
  test("no events yet, no events in window, and no data are three sentences", () => {
    const noFile = text(
      onWorker({ detail: ok({ ...DETAIL, eventsPresent: false, eventLines: [] }, NOW - 2_000) }),
    );
    const emptyWindow = text(
      onWorker({ detail: ok({ ...DETAIL, eventsPresent: true, eventLines: [] }, NOW - 2_000) }),
    );
    const unread = text(onWorker({ detail: never() }));
    expect(noFile).toContain("no events yet");
    expect(emptyWindow).toContain("no events in window");
    expect(unread).toContain("no data");
    // …and they are genuinely three, not one string reached three ways.
    expect(new Set([noFile, emptyWindow, unread]).size).toBe(3);
    expect(noFile).not.toContain("no events in window");
    expect(emptyWindow).not.toContain("no events yet");
  });

  /**
   * THE FINDING LINES SURVIVE A NARROW PANE WHOLE, and this was found by
   * LOOKING at a rendered frame rather than by reasoning about one.
   *
   * At 26 columns view 2 rendered `exit code 137 signal SI…` — a truncated
   * SIGNAL NAME, when `SIGKILL` versus `SIGTERM` is most of what the line is
   * for. The rule the fix follows, stated once and applied in both places:
   * **a cell truncates because it is holding a column open for its neighbours,
   * and a finding has no neighbours** — so truncating one buys no alignment and
   * costs the fact. The run line goes the same way: it is §6.2's stable
   * selection, not a summary, and a half-truncated run id names no run.
   *
   * It lives in the ISC-504 block because it is that criterion's own class:
   * information removed by the view without the view saying so.
   */
  test("the exit signal and the run id are not truncated at a narrow width", () => {
    const frame = renderFleet(
      onWorker({
        columns: 26,
        detail: ok(
          { ...DETAIL, exit: { code: 137, signal: "SIGKILL" }, credentialDegraded: true },
          NOW - 2_000,
        ),
      }),
    )
      .join(" ")
      .replace(/\s+/g, " ");
    expect(frame).toContain("SIGKILL");
    expect(frame).toContain("credential DEGRADED");
    expect(frame).toContain(RUN_A);
  });

  /**
   * THE EVENT LINES ARE NOT RE-CLIPPED (§6.2 View 2, ISC-345's hazard).
   *
   * A line longer than the pane must reach the frame whole — wrapped across
   * lines, never shortened. Asserted on the frame with whitespace normalised,
   * because wrapping inserts newlines and the criterion is about characters
   * surviving, not about where they land.
   */
  test("a long event line is wrapped, never shortened", () => {
    const long = `tool_result ${"x".repeat(200)} end-of-line-marker`;
    const frame = renderFleet(
      onWorker({ columns: 60, detail: ok({ ...DETAIL, eventLines: [long] }, NOW - 2_000) }),
    )
      .join("")
      .replace(/\s+/g, "");
    expect(frame).toContain("x".repeat(200));
    expect(frame).toContain("end-of-line-marker");
  });
});

// ---------------------------------------------------------------------------
// ISC-505 — views 2-4 degrade by the same derived-floor rule, and refuse below it
// ---------------------------------------------------------------------------

/**
 * The criterion is about the RULE, not about four numbers.
 *
 * ISC-485 closed §9 Q3 by deriving view 1's floor from the columns §6.5 forbids
 * dropping rather than by measuring a terminal. Three more views could each have
 * acquired a hand-picked constant — and four independently-picked numbers cannot
 * be checked against one another at all. So each view declares WHICH cells it
 * may not drop, and every assertion below is written over all four at once.
 */
describe("ISC-505: every view's floor is derived, and below it the view refuses", () => {
  const FLOORS: ReadonlyArray<readonly [ViewFloor, (over: Partial<FleetModel>) => FleetModel]> = [
    [FLEET_FLOOR, (over) => ({ ...healthy, ...over })],
    [WORKER_FLOOR, onWorker],
    [HISTORY_FLOOR, onHistory],
    [REPORT_FLOOR, onReport],
  ];

  /**
   * THE DERIVATION ITSELF. Pins the rule rather than the numbers, so changing a
   * column width moves a floor and this still holds — which is the property
   * ISC-485 asked for and the reason it could close Q3 without a probe.
   *
   * The gutter is not in `neverDropped` and is not asserted here: view 4 uses a
   * different one (2, not 4) because it has no bullet, and hard-coding either
   * would make this test the fifth place the number lives.
   */
  test("each floor is exactly its own never-dropped cells, or its refusal's width", () => {
    for (const [floor] of FLOORS) {
      const cells = floor.neverDropped.reduce((sum, [, w]) => sum + w, floor.gutter);
      // Re-derived from the descriptor's own inputs, so changing a column width
      // moves the floor and this still holds — which is the property ISC-485
      // asked for and the reason it could close Q3 without probing a terminal.
      expect({ view: floor.view, columns: floor.columns }).toEqual({
        view: floor.view,
        columns: Math.max(cells, longestRefusalWord(floor.view) + 1),
      });
      expect({ view: floor.view, declares: floor.neverDropped.length > 0 }).toEqual({
        view: floor.view,
        declares: true,
      });
    }
  });

  /**
   * THE OFF-BY-ONE THE SWEEP FOUND. A refusal is only shown BELOW the floor, so
   * the widest pane that ever renders it is `floor - 1`; if the longest word
   * does not fit there, the one width at which the operator most deserves a
   * readable sentence is the one width that hard-breaks it. Asserted at
   * `floor - 1` rather than at a convenient width, because a convenient width
   * is what hid this in the first draft.
   */
  test("the refusal is legible at the widest width that shows it", () => {
    for (const [floor, build] of FLOORS) {
      const widest = floor.columns - 1;
      expect({ view: floor.view, fits: longestRefusalWord(floor.view) <= widest }).toEqual({
        view: floor.view,
        fits: true,
      });
      // …and the whole sentence really does survive the wrap at that width.
      expect({ view: floor.view, sentence: flat(build({ columns: widest })).trim() }).toEqual({
        view: floor.view,
        sentence: `pifleet monitor's ${floor.view} view needs at least ${floor.columns} columns; this pane has ${widest}.`,
      });
    }
  });

  /**
   * AT the floor it draws, and ONE COLUMN BELOW it refuses. A refusal one column
   * too eager is a monitor that will not run on a pane it could have served;
   * one column too late is a frame whose first cell starts past the edge.
   */
  test("at the floor every view draws, and one below it every view refuses", () => {
    for (const [floor, build] of FLOORS) {
      const at = flat(build({ columns: floor.columns }));
      const below = flat(build({ columns: floor.columns - 1 }));
      expect({ view: floor.view, drew: !at.includes("needs at least") }).toEqual({
        view: floor.view,
        drew: true,
      });
      expect({ view: floor.view, refused: below.includes("needs at least") }).toEqual({
        view: floor.view,
        refused: true,
      });
    }
  });

  /**
   * The refusal NAMES BOTH NUMBERS and the VIEW, on `RunDirMountError`'s pattern
   * (`paths.ts:755-791`). The view name is new to this design and it is not
   * decoration: there are four floors now and they differ, so an operator who
   * widened a pane until the fleet drew and then pressed a key needs to be told
   * which floor they have just hit.
   *
   * It WRAPS rather than truncating — asserted at an absurd width, because a
   * truncated refusal reading `pifleet monitor's worker view needs at` is
   * exactly the unreadable output the refusal exists to avoid.
   */
  test("the refusal names the view, the required width and the actual one", () => {
    for (const [floor, build] of FLOORS) {
      const joined = flat(build({ columns: floor.columns - 1 }));
      expect({ view: floor.view, named: joined.includes(`${floor.view} view`) }).toEqual({
        view: floor.view,
        named: true,
      });
      expect({
        view: floor.view,
        says: joined.includes(`needs at least ${floor.columns} columns`),
      }).toEqual({ view: floor.view, says: true });
      expect({ view: floor.view, has: joined.includes(`has ${floor.columns - 1}`) }).toEqual({
        view: floor.view,
        has: true,
      });
    }
  });

  /**
   * BELOW THE FLOOR IT IS A REFUSAL AND NOT A TRUNCATED VIEW. The failure this
   * catches is a view that renders its refusal above a table it also drew.
   */
  test("a refusing view draws none of its content", () => {
    const w = text(onWorker({ columns: WORKER_FLOOR.columns - 1 }));
    expect(w).not.toContain("tool_result ok");
    expect(w).not.toContain("phase running");
    const h = text(onHistory({ columns: HISTORY_FLOOR.columns - 1 }));
    expect(h).not.toContain("finished");
    expect(h).not.toContain("3906");
  });

  /**
   * ## Why these assert an ORDER over a swept range rather than breakpoints
   *
   * A test naming the width at which each column disappears passes for a ladder
   * whose rungs are in the wrong order — it would simply record the wrong order
   * and keep recording it. Asserted as a property over every width from the
   * floor to well past full, the wrong order cannot survive at any width, and
   * the constants stay free to change. This is `monitor-render.test.ts`'s
   * argument for ISC-484, applied to the two new planners.
   */
  test("no column outlives one that is dropped later", () => {
    for (let columns = WORKER_FLOOR.columns; columns < WORKER_FLOOR.columns + 90; columns++) {
      const plan = planWorkerColumns(columns);
      // tokens is dropped FIRST, so it may never be present once turns is gone.
      if (plan.showTokens) {
        expect({ columns, turns: plan.showTurns }).toEqual({ columns, turns: true });
      }
    }
    for (let columns = HISTORY_FLOOR.columns; columns < HISTORY_FLOOR.columns + 90; columns++) {
      const plan = planHistoryColumns(columns);
      // Dropped: settled, then tasks, then workers, then the full run id.
      if (plan.showSettled) expect({ columns, t: plan.showTasks }).toEqual({ columns, t: true });
      if (plan.showTasks) expect({ columns, w: plan.showWorkers }).toEqual({ columns, w: true });
      if (plan.showWorkers) expect({ columns, id: plan.runIdFull }).toEqual({ columns, id: true });
    }
  });

  test("the plans are monotonic: widening never removes a column", () => {
    for (let columns = WORKER_FLOOR.columns + 1; columns < WORKER_FLOOR.columns + 90; columns++) {
      const narrow = planWorkerColumns(columns - 1);
      const wide = planWorkerColumns(columns);
      for (const key of ["showTurns", "showTokens"] as const) {
        if (narrow[key]) expect({ columns, key, kept: wide[key] }).toEqual({ columns, key, kept: true });
      }
    }
    for (let columns = HISTORY_FLOOR.columns + 1; columns < HISTORY_FLOOR.columns + 90; columns++) {
      const narrow = planHistoryColumns(columns - 1);
      const wide = planHistoryColumns(columns);
      for (const key of ["runIdFull", "showWorkers", "showTasks", "showSettled"] as const) {
        if (narrow[key]) expect({ columns, key, kept: wide[key] }).toEqual({ columns, key, kept: true });
      }
    }
  });

  /**
   * THE HALF §6.5 CARES MOST ABOUT: the never-dropped cells survive every width
   * above the floor, and so does the staleness marker that says how old the
   * answer is. A compressed monitor that has stopped saying how old it is has
   * become the thing §4.3 argues against.
   */
  test("the never-dropped cells and the staleness marker survive every width", () => {
    for (const columns of [WORKER_FLOOR.columns, 24, 30, 45, 70, 120]) {
      const lines = renderFleet(onWorker({ columns }));
      expect({ columns, phase: lines.some((l) => l.includes("phase running")) }).toEqual({
        columns,
        phase: true,
      });
      expect({ columns, stale: headingFor(lines, "worker").includes("as of") }).toEqual({
        columns,
        stale: true,
      });
    }
    for (const columns of [HISTORY_FLOOR.columns, 40, 55, 70, 90, 120]) {
      const lines = renderFleet(onHistory({ columns }));
      const joined = lines.join("\n");
      expect({ columns, id: joined.includes("3906") }).toEqual({ columns, id: true });
      expect({ columns, age: joined.includes("2m ago") }).toEqual({ columns, age: true });
      expect({ columns, live: joined.includes("live") }).toEqual({ columns, live: true });
      expect({ columns, stale: headingFor(lines, "history").includes("as of") }).toEqual({
        columns,
        stale: true,
      });
    }
  });

  /** The columns actually leave the frame in the stated order. */
  test("the optional columns leave in the order the planners declare", () => {
    const wide = text(onWorker({ columns: 120 }));
    expect(wide).toContain("turns 12");
    expect(wide).toContain("in 4210 out 1180");

    const noTokens = text(onWorker({ columns: WORKER_FLOOR.columns + 16 }));
    expect(noTokens).toContain("turns 12");
    expect(noTokens).not.toContain("in 4210");

    const bare = text(onWorker({ columns: WORKER_FLOOR.columns }));
    expect(bare).not.toContain("turns 12");
    expect(bare).toContain("phase running");

    const fullHistory = text(onHistory({ columns: 120 }));
    expect(fullHistory).toContain(RUN_A);
    expect(fullHistory).toContain("4 workers");
    expect(fullHistory).toContain("5 tasks");
    expect(fullHistory).toContain("3 settled");

    const bareHistory = text(onHistory({ columns: HISTORY_FLOOR.columns }));
    expect(bareHistory).not.toContain(RUN_A);
    expect(bareHistory).toContain("3906");
    expect(bareHistory).not.toContain("4 workers");
  });
});

// ---------------------------------------------------------------------------
// View 4 — the frame must not re-format what it was handed
// ---------------------------------------------------------------------------

/**
 * §6.2 requires the report "in `renderRunReport`'s own order and with its own
 * wording rules preserved". The failure this guards is not a crash: it is a
 * frame that improved the report — re-ordered a section, restyled a heading,
 * shortened a line — and thereby became a second renderer of one fact, which is
 * how two spellings drift (ISC-345).
 */
describe("view 4 frames the report and does not re-render it", () => {
  test("the merge-precheck sentence survives verbatim", () => {
    expect(text(onReport())).toContain(MERGE_LINE);
  });

  /**
   * `renderRunReport`'s ORDER, asserted as the relative position of three lines
   * rather than as a byte-exact frame. §6.2 names the order — attended first —
   * and a positional assertion fails for a frame that sorted or grouped the
   * lines while a `toContain` sweep would not.
   */
  test("the lines keep the order they arrived in", () => {
    const lines = renderFleet(onReport());
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const order = [at("# pifleet run"), at("## ATTENDED"), at("## merge pre-check"), at(MERGE_LINE)];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  /**
   * The report's OWN indentation is part of its wording rules — a reason
   * indented under its heading reads as belonging to it. A frame that stripped
   * or normalised leading whitespace would flatten the structure while keeping
   * every character.
   */
  test("the report's own indentation is preserved, not normalised away", () => {
    const line = renderFleet(onReport()).find((l) => l.includes("a person typed into this pane"));
    expect(line).toBeDefined();
    expect(line as string).toContain("      a person typed"); // 2 frame + 4 report
  });

  /**
   * BLANK SEPARATOR LINES SURVIVE. `renderRunReport` uses them to separate
   * sections, so collapsing them — which a naive key-by-text render would do —
   * closes up the spacing that is part of the order §6.2 requires preserved.
   */
  test("blank separator lines are not collapsed", () => {
    const lines = renderFleet(onReport());
    const blanks = lines.filter((l) => l.trim() === "").length;
    expect(blanks).toBeGreaterThanOrEqual(2);
  });

  /** The line count is named, because a frame that shows N of M silently lies. */
  test("the heading states how many lines the report has", () => {
    expect(headingFor(renderFleet(onReport()), "report")).toContain(
      `${REPORT_LINES.length} lines`,
    );
  });

  /**
   * A long report line is WRAPPED, never truncated. The lines most likely to
   * exceed a pane are the merge-precheck rows whose exact wording §6.2 pins, so
   * truncation here would delete the one thing the criterion names.
   */
  test("a long report line survives a narrow pane whole", () => {
    const frame = renderFleet(onReport({ columns: 40 }))
      .join("")
      .replace(/\s+/g, "");
    expect(frame).toContain(MERGE_LINE.replace(/\s+/g, ""));
  });
});

// ---------------------------------------------------------------------------
// The frames, pinned
// ---------------------------------------------------------------------------

/**
 * The byte-exact pins, one per new view.
 *
 * Their value is different from every other test here: the others say what must
 * be true, and these catch everything nobody thought to say — a column that
 * shifted, a row that gained a space, a line that appeared. When one fails, read
 * the diff and decide; do not update it reflexively.
 */
describe("the new frames, pinned", () => {
  const RULE = "-".repeat(80);

  test("view 2 renders exactly these lines", () => {
    expect(renderFleet(onWorker({ columns: 80 }))).toEqual([
      RULE,
      "worker eng-1 — as of 2s — 3 event lines",
      `  run ${RUN_A}`,
      "  * phase running     turns 12        in 4210 out 1180",
      "  credential ok",
      "  no exit recorded",
      // ISC-508. The refusal surface sits with the other findings, above the
      // rule, because it is a fact about the worker and not part of its log.
      "  dispatch would be typed into this worker's pane",
      "  fence LIVE on t-7 — 2 attempts on record",
      RULE,
      "  14:43:01 tool_use Bash",
      "  14:43:02 tool_result ok",
      "  14:43:05 assistant done",
    ]);
  });

  /**
   * Pinned at 100 rather than 80, and the widths are not interchangeable: the
   * complete history row needs 85 and at 80 the `settled` column is correctly
   * dropped. Pinning the degraded row would make this test assert the ladder as
   * well as the layout, and the ladder already has a swept-range property of its
   * own — a pin that duplicates it would simply break twice for one change.
   */
  const WIDE_RULE = "-".repeat(100);

  test("view 3 renders exactly these lines", () => {
    expect(renderFleet(onHistory({ columns: 100 }))).toEqual([
      WIDE_RULE,
      "history — as of 30s — 2 runs, 1 live",
      "  * 2026-09-02T14-43-27Z-3906  2m ago    live      4 workers   5 tasks   3 settled",
      "  * 2026-09-02T09-11-02Z-1180  5h ago    finished  2 workers   1 task    1 settled",
    ]);
  });

  /**
   * Also 100, for the same kind of reason and a sharper one: the merge-precheck
   * line is 84 characters and the gutter makes 86, so at 80 it WRAPS — correctly
   * — and the pin would be asserting the wrap rather than the framing. The wrap
   * has its own test above ("a long report line survives a narrow pane whole"),
   * which is where that behaviour belongs.
   */
  test("view 4 renders exactly these lines", () => {
    expect(renderFleet(onReport({ columns: 100 }))).toEqual([
      WIDE_RULE,
      `report ${RUN_A} — as of 4s — 8 lines`,
      `  # pifleet run ${RUN_A}`,
      "  generated 2026-09-02T15:00:00.000Z",
      "",
      "  ## ATTENDED — worker eng-1",
      "      a person typed into this pane",
      "",
      "  ## merge pre-check",
      `  ${MERGE_LINE}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The palette stops at the seam, in the new views too
// ---------------------------------------------------------------------------

/**
 * View 1's discipline, carried forward: **the plain and coloured frames must
 * contain the SAME TEXT.** One component tree produces both, so a painted frame
 * cannot drift from the asserted one — what differs between them is escapes and
 * nothing else.
 *
 * The two deliberate exceptions are the ones `fleet.tsx` already argues: the
 * `Rule` (`─` vs `-`, pure decoration nothing parses) and the severity bullet
 * (`●` vs `*`, present in both so the row structure does not change). Both are
 * normalised out below rather than excused, so a THIRD divergence fails.
 *
 * **A LIMIT ON WHAT THIS BLOCK PROVES, stated rather than left for a reader to
 * infer.** Two gates decide whether an escape is emitted: this flag, and
 * `chalk`'s own level, computed once from the REAL `process.stdout`. Under a
 * piped test runner chalk's gate is closed, so the coloured frame carries no
 * SGR escapes to strip and the equality below is a claim about the two glyph
 * differences only. That is not a defect in the test — it is the same ambient
 * mechanism `render.ts:160-176` describes, and it is why the escape pattern is
 * written correctly for the day someone runs the suite attached to a terminal.
 * The `is genuinely the coloured one` case underneath is what keeps the block
 * from being vacuous in the meantime: it proves the FLAG reached the
 * components, via the one text difference the design permits.
 */
describe("colour changes escapes, never text", () => {
  const strip = (s: string) =>
    // eslint-disable-next-line no-control-regex
    s.replace(/\[[0-9;]*m/g, "").replace(/[─-]/g, "-").replace(/●/g, "*");

  test("every new view's coloured frame carries the same text as its plain one", () => {
    for (const [name, model] of [
      ["worker", onWorker()],
      ["history", onHistory()],
      ["report", onReport()],
    ] as const) {
      const plain = renderFleet(model).join("\n");
      const coloured = renderFleet(model, { colour: true }).join("\n");
      expect({ view: name, same: strip(plain) === strip(coloured) }).toEqual({
        view: name,
        same: true,
      });
    }
  });

  /**
   * TESTING THE TESTER. The comparison above is worthless if colour is not
   * actually being applied — a `colour: true` that did nothing would make every
   * pair trivially equal. `chalk`'s own level gates the escapes and is computed
   * from the real stdout, so under a piped test runner there may be none; this
   * asserts the FLAG reaches the components either way, by checking that the
   * one text difference the design permits actually appears.
   */
  test("the coloured frame is genuinely the coloured one", () => {
    const coloured = renderFleet(onWorker(), { colour: true }).join("\n");
    expect(coloured).toContain("─");
    expect(coloured).not.toContain("---");
  });
});

/**
 * ISC-508 — the refusal surface reaches a screen.
 *
 * `WorkerRow.via` and `WorkerRow.fence` were read, joined, mutation-proved and
 * carried by the model in ISC-499, and for one commit **no view rendered
 * either**. View 1's ladder has no tier for them and `WorkerDetail` carried
 * neither, so view 2 could not show them without reading `model.runs` — the
 * cross-view read ISC-503 forbids. The fields were correct, tested, and
 * invisible.
 *
 * The fix carries them in `WorkerDetail` as well, which is a deliberate
 * duplicate of the DATA and never of the DERIVATION: `deriveVia` and
 * `readFenceView` remain the single definitions and `readRefusalSurface` calls
 * both.
 */
describe("ISC-508: the refusal surface is rendered, and `null` never reads as permissive", () => {
  const withSurface = (over: Partial<WorkerDetail>): string =>
    text(onWorker({ detail: ok({ ...DETAIL, ...over }, NOW - 2_000) }));

  /**
   * THE ASSERTION THE WHOLE CRITERION IS FOR.
   *
   * `deriveVia` returns `null` rather than `"rpc"` when the launch record or
   * the presentation cannot be read, because no answer beats the permissive
   * answer. A view that rendered the gap as `rpc` would undo that refusal one
   * layer up — greying IN a button the command behind it would refuse — which
   * is worse than the unrendered field this criterion replaced, because it is
   * confidently wrong instead of merely absent.
   */
  test("an undetermined route says so and never names the permissive one", () => {
    const frame = withSurface({ via: null });
    expect(frame).toContain("dispatch route unknown");
    expect(frame).not.toMatch(/dispatch would go over the control socket/);
  });

  test("the three routes render distinctly, and none is a substring of another", () => {
    const rpc = withSurface({ via: "rpc" });
    const pane = withSurface({ via: "pane" });
    const staged = withSurface({ via: "staged" });
    expect(rpc).toContain("would go over the control socket");
    expect(pane).toContain("typed into this worker's pane");
    expect(staged).toContain("STAGED — a person owns this terminal");
    expect(new Set([rpc, pane, staged]).size).toBe(3);
  });

  /**
   * `no fence yet` and `fence idle` are different facts and the pair that a
   * reasonable implementation collapses: one worker has never taken an epoch,
   * the other has taken some and holds none now. `Region`'s three states exist
   * for the same distinction one layer up.
   */
  test("an absent fence and an idle fence are not the same sentence", () => {
    const absent = withSurface({ fence: null });
    const idle = withSurface({
      fence: { liveTaskId: null, abortRequested: false, attemptCount: 3 },
    });
    expect(absent).toContain("no fence yet");
    expect(idle).toContain("fence idle");
    expect(idle).toContain("3 attempts on record");
    expect(absent).not.toContain("fence idle");
  });

  test("a live epoch names its task, and an outstanding abort is shouted", () => {
    const live = withSurface({
      fence: { liveTaskId: "t-9", abortRequested: false, attemptCount: 1 },
    });
    const aborting = withSurface({
      fence: { liveTaskId: "t-9", abortRequested: true, attemptCount: 1 },
    });
    expect(live).toContain("fence LIVE on t-9");
    expect(live).not.toContain("ABORT");
    expect(aborting).toContain("ABORT REQUESTED");
    // Singular, because "1 attempts" is the tell of a count formatted by
    // concatenation and nobody reading it twice.
    expect(live).toContain("1 attempt on record");
  });

  /**
   * ISC-503 still holds after the addition: view 2 renders its own payload and
   * nothing else. Blanking `runs` entirely must not change one byte of the
   * worker frame — if it does, the view is reading the fleet's region.
   */
  test("view 2 still renders from its own selection alone", () => {
    const withRuns = text(onWorker());
    const withoutRuns = text(onWorker({ runs: never() }));
    expect(withoutRuns).toBe(withRuns);
  });
});
