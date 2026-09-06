/**
 * The fleet frame, asserted as lines and only as lines (D2, ISC-483, ISC-491).
 *
 * ## Why every assertion in this file is a string comparison
 *
 * D2 puts Ink behind `renderFleet(model): string[]` and says the decision is
 * cheap to unwind precisely because "swapping to a hand-rolled renderer later
 * means reimplementing those functions and changing no test". **That promise is
 * only true if no test in this file can tell which toolkit rendered the frame.**
 * So there is no `render()` from `ink-testing-library` here, no component
 * import, no `lastFrame()`, and no assertion on a tree — the only thing this
 * file knows about `src/monitor/views/fleet.tsx` is that some function returns
 * lines. If an assertion ever needs more than that, the seam is wrong and the
 * fix belongs in `render.ts`, not here.
 *
 * The SRD was confident about the opposite (§6.6.1: "a renderer that returns
 * lines is pinnable by exactly that kind of test; a component tree is not") and
 * was measured wrong. That correction is what makes this file ordinary rather
 * than clever, and the ordinariness is the whole benefit of the seam.
 *
 * ## ISC-491, structurally rather than by discipline
 *
 * No terminal, no container, no runs directory, no fleet. Every input below is
 * an object literal typed as `FleetModel`, which is the same bargain
 * `src/monitor/activity.ts` strikes by taking facts rather than a worker
 * directory. `Docs/SRD-TUI-DISPATCH.md` §10 records ISC-377/378/379/387 sitting
 * at `[~]` because their probes needed a real pane; a criterion discovered to be
 * unverifiable at grading time is one that can never go green.
 *
 * ## The fixture is built to defeat a renderer that ignores `activity`
 *
 * Three of the six workers below have `transcriptAgeMs: null` — an `rpc`
 * worker, an attended worker that has never spoken, and an attended worker whose
 * transcript is measured and has never grown. **A renderer that formatted only
 * the age would collapse all three into one string and still pass a suite whose
 * fixtures happened to differ in age.** One more, `rev-1`, is `container-gone`
 * with a THREE-SECOND-OLD transcript, which is the case `activity.ts:186-198`
 * exists to rank: a worker that wrote just before its container vanished must
 * not render `wrote 3s ago`, because that is a liveness claim about a process
 * that is not running. Those four fixtures are the asymmetric ones; without them
 * the anti-collapse sweep passes by accident.
 */

import { describe, expect, test } from "bun:test";

import { failed, never, ok } from "../../src/monitor/model.ts";
import type { FleetModel, RunRow, WorkerRow } from "../../src/monitor/model.ts";
import { renderFleet } from "../../src/monitor/render.ts";
import { COLOUR, PLAIN } from "../../src/monitor/views/chrome.tsx";
import { FLOOR_COLUMNS, planColumns } from "../../src/monitor/views/fleet.tsx";
import { workerContainerName } from "../../src/run/paths.ts";

const NOW = Date.parse("2026-09-02T14:00:00.000Z");
const RUN_A = "2026-09-02T14-43-27Z-3906";
const RUN_B = "2026-09-02T09-11-02Z-1180";

/**
 * An `rpc` worker with a healthy container, because that is the case every other
 * fixture is a DEPARTURE from. A fixture built by spreading over this one states
 * its departure in the same few fields §6.2's own row table uses, so a reader
 * comparing two fixtures reads the difference rather than reconstructing it.
 */
const base: WorkerRow = {
  workerId: "w-0",
  runId: RUN_A,
  activity: "rpc",
  phase: "idle",
  transcriptAgeMs: null,
  containerPresent: true,
  taskId: null,
  /*
   * §6.2's refusal surface and fence, CARRIED BY THE MODEL AND RENDERED BY NO
   * VIEW — stated here rather than left for a reader to notice.
   *
   * `WorkerRow` gained `via` and `fence` so that "a later action button has
   * somewhere to be greyed out and a reason to give" (§6.2's second and third
   * "must be able to see"), and `model.ts:260-294` argues at length that they
   * belong on the ROW rather than on view 2 because a button lives on a row.
   * The argument is right and the fields are unrendered: view 1's ladder
   * (ISC-484) has no tier for them and `WorkerDetail` — view 2's whole payload
   * — carries neither, so view 2 cannot show them either without reading
   * `model.runs`, which is exactly the cross-view read ISC-503 forbids.
   *
   * That is the dead-field shape `contracts.ts:86-118` records, caught while it
   * is still one commit old. The fixtures below vary both fields so that
   * whichever view eventually renders them has asymmetric cases waiting, and so
   * that this comment fails to be true the moment someone acts on it.
   *
   * On THIS fixture both sit at their defaults: an
   * `rpc` worker really would take the socket, and a worker that has taken no
   * epoch really has no fence. Neither is a placeholder — `via: null` and
   * `fence: null` are the "could not determine" values (`model.ts:271-275`) and
   * a base fixture carrying them would make every derived fixture describe an
   * unreadable worker.
   */
  via: "rpc",
  fence: null,
  /*
   * NO WORKSPACE, which is the majority shape on the operator's own disk — 81
   * of 183 `presentation.json` records carry `workspace_ref: null` (measured
   * 2026-09-04). Keeping the base fixture here means the pinned frame below
   * exercises the group that a workspace-aware view is most likely to drop,
   * rather than the one it is most likely to get right.
   */
  workspace: null,
  /* No name either, which is what a record with no workspace must carry. */
  workspaceName: null,
};

const worker = (over: Partial<WorkerRow>): WorkerRow => ({ ...base, ...over });

/** The five ladder states, one worker each, plus the sixth RENDERING of `quiet`. */
const engRpc = worker({ workerId: "eng-1", activity: "rpc", phase: "running", taskId: "t-17" });
const engSilent = worker({
  workerId: "eng-2",
  activity: "no-transcript",
  phase: "idle",
  // Attended: a dispatch would be TYPED into its pane, not sent over a socket.
  via: "pane",
});
const engQuiet = worker({
  workerId: "eng-3",
  activity: "quiet",
  transcriptAgeMs: 11 * 60_000,
  taskId: "t-18",
});
const engActive = worker({
  workerId: "eng-4",
  activity: "active",
  transcriptAgeMs: 4_000,
  taskId: "t-19",
  via: "staged",
  // A LIVE epoch: an action addressed here would be refused `busy`.
  fence: { liveTaskId: "t-19", abortRequested: false, attemptCount: 3 },
});
/** `quiet` whose transcript is MEASURED and has never grown — `status.ts:76`'s "no writes yet". */
const engNeverGrew = worker({
  workerId: "eng-5",
  activity: "quiet",
  runId: RUN_B,
  // `presentation.json` absent. `model.ts:271-275` refuses to default this to
  // `"rpc"`, because an unreadable record would then render as the worker most
  // freely dispatchable — the reassuring lie in different clothes.
  via: null,
});
/** `container-gone` with a FRESH age. The asymmetric fixture; see the header. */
const revGone = worker({
  workerId: "rev-1",
  runId: RUN_B,
  activity: "container-gone",
  phase: "running",
  transcriptAgeMs: 3_000,
  containerPresent: false,
  taskId: "t-9",
});

const RUNS: readonly RunRow[] = [
  { runId: RUN_A, models: [], workers: [engRpc, engSilent, engQuiet, engActive] },
  { runId: RUN_B, models: [], workers: [engNeverGrew, revGone] },
];

/** A whole fleet, every region healthy. Departures spread over this the same way. */
const healthy: FleetModel = {
  runs: ok(RUNS, NOW - 2_000),
  /*
   * REAL container names, built by the production `workerContainerName`.
   *
   * These were `pifleet-3906-eng-1` — the run's SUFFIX, not its id. Nothing
   * read them until the containers region began listing the containers no
   * worker row accounts for, at which point the abbreviation made two workers
   * render as non-workers. A fixture that no assertion depends on drifts from
   * the thing it stands for, and this is what that costs when one arrives.
   *
   * `pifleet-egress-relay-pifleet-egress` is the third: a genuine non-worker,
   * so the region has something true to show and the filter is proved to keep
   * as well as to drop.
   */
  containers: ok(
    [
      workerContainerName(RUN_A, "eng-1"),
      workerContainerName(RUN_A, "eng-2"),
      "pifleet-egress-relay-pifleet-egress",
    ],
    NOW - 12_000,
  ),
  now: NOW,
  columns: 120,
  /*
   * The default view, and the three payloads it does not fetch. `never()` is
   * what "nobody has entered this view" looks like in the model — distinct
   * from `ok` with an empty value, which would claim the reader ran and found
   * nothing (`model.ts:82-88`, `compose.ts`'s `fetchForView`).
   */
  view: { kind: "fleet" },
  history: never(),
  detail: never(),
  report: never(),
};

/**
 * The one row a worker owns, or a failure naming what went wrong.
 *
 * `find` would return the first of two matches and let a renderer that emitted a
 * worker twice pass silently, which is the shape of bug a monitor hides best —
 * the operator sees a plausible row and never counts them. So this asserts the
 * count and reports the id when it is wrong.
 */
function rowFor(lines: readonly string[], workerId: string): string {
  /*
   * The row now opens with a severity bullet — `*` plain, `●` coloured — so the
   * id is no longer the first token. Matching on the id ANYWHERE in the line
   * would be looser than this file wants (a task id could contain one), so the
   * bullet is stripped explicitly and the id must still be the first thing
   * after it. That keeps the helper as strict as it was while surviving the
   * one glyph that was added.
   */
  const hits = lines.filter((l) =>
    l.trimStart().replace(/^[*●]\s*/, "").startsWith(`${workerId} `),
  );
  expect({ workerId, matches: hits.length }).toEqual({ workerId, matches: 1 });
  return hits[0] as string;
}

/**
 * A region's heading line, by NAME rather than by index.
 *
 * `lines[0]` was the fleet heading until a full-width rule was drawn above it,
 * at which point five tests started asserting against a row of dashes. An index
 * is where a line happened to land; the name is what it is — the same argument
 * `operations-plan.test.ts` makes for resolving panes by title.
 */
function headingFor(lines: readonly string[], region: string): string {
  const hits = lines.filter((l) => l.startsWith(`${region} `) || l === region);
  expect({ region, matches: hits.length }).toEqual({ region, matches: 1 });
  return hits[0] as string;
}

/**
 * ISC-483 — the WOW floor, and the only criterion in this block that is about
 * the frame as a whole rather than about one cell.
 *
 * §1.3's first two questions are "is anything stuck?" and "what is this run
 * doing?", and D16's grading rule is that a requirement which cannot fail is not
 * one. The falsifiable form is: EVERY live worker's row carries an activity
 * rendering AND a phase, with no keystroke. **The incumbent fails this on its own
 * fleet** — four of six live attended workers print `idle` and nothing else
 * (SRD §1.2), so the row exists and answers neither question.
 */
describe("ISC-483: the first frame answers both questions for every live worker", () => {
  const ACTIVITY_RENDERINGS = [
    "not measured (rpc)",
    "no transcript",
    "no writes yet",
    "container gone",
  ];

  test("every live worker's row carries an activity rendering and a phase", () => {
    const lines = renderFleet(healthy);
    for (const run of RUNS) {
      for (const w of run.workers) {
        const row = rowFor(lines, w.workerId);
        const hasActivity =
          ACTIVITY_RENDERINGS.some((r) => row.includes(r)) || /wrote \d+[smh] ago/.test(row);
        // Reported as an object so a failure names the worker and the row,
        // rather than printing `false` and leaving the reader to hunt.
        expect({ worker: w.workerId, hasActivity, hasPhase: row.includes(w.phase[0]!.toUpperCase() + w.phase.slice(1)) }).toEqual(
          { worker: w.workerId, hasActivity: true, hasPhase: true },
        );
      }
    }
  });

  /**
   * D9, and the misreading this whole view exists to stop.
   *
   * For an attended worker `phase` is permanently `idle` and that is TRUE — no
   * epoch is allocated (`voided.ts:136-140`, `model.ts:128-134`) — so a frame
   * that let `phase` stand in for activity would report a worker mid-turn as
   * idle. `eng-4` is attended, mid-turn, and `phase: "idle"`: its row must carry
   * BOTH facts, beside each other.
   */
  test("phase sits beside activity and never replaces it", () => {
    const row = rowFor(renderFleet(healthy), "eng-4");
    expect(row).toContain("wrote 4s ago");
    expect(row).toContain("Idle");
  });

  /** The seam's return type, asserted rather than assumed. */
  test("the seam returns lines and nothing else", () => {
    const lines = renderFleet(healthy);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.every((l) => typeof l === "string")).toBe(true);
    expect(lines.length).toBeGreaterThan(RUNS.length);
  });
});

/**
 * ISC-480 at the display layer.
 *
 * `deriveActivity` already keeps the five apart (`monitor-activity.test.ts`
 * pins that). **This asserts they SURVIVE to the frame**, which is a different
 * claim and the one an operator depends on: a ladder that is correct in memory
 * and collapsed on screen is exactly as useless as no ladder.
 */
describe("ISC-480: the five activity states survive to the frame", () => {
  const one = (row: WorkerRow): string =>
    rowFor(renderFleet({ ...healthy, runs: ok([{ runId: row.runId, models: [], workers: [row] }], NOW - 1_000) }), row.workerId);

  const fixtures: ReadonlyArray<readonly [string, WorkerRow]> = [
    ["rpc", engRpc],
    ["no-transcript", engSilent],
    ["quiet", engQuiet],
    ["active", engActive],
    ["container-gone", revGone],
  ];

  /**
   * The anti-collapse assertion, and it is a property of the SET rather than of
   * any one value. A `Set` size check would report that something collapsed
   * without saying which two, which is the report that costs an afternoon.
   */
  test("no two of the five render the same activity cell", () => {
    const collisions: string[] = [];
    for (let i = 0; i < fixtures.length; i++) {
      for (let j = i + 1; j < fixtures.length; j++) {
        const [an, a] = fixtures[i] as readonly [string, WorkerRow];
        const [bn, b] = fixtures[j] as readonly [string, WorkerRow];
        if (activityCellOf(one(a)) === activityCellOf(one(b))) collisions.push(`${an} === ${bn}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  /**
   * The anti-PERMUTATION assertion, which the sweep alone would not catch — a
   * renderer that swapped `quiet` and `active` keeps all ten pairs distinct.
   */
  test("each of the five renders its own string", () => {
    expect(activityCellOf(one(engRpc))).toBe("not measured (rpc)");
    expect(activityCellOf(one(engSilent))).toBe("no transcript");
    expect(activityCellOf(one(engQuiet))).toBe("wrote 11m ago");
    expect(activityCellOf(one(engActive))).toBe("wrote 4s ago");
    expect(activityCellOf(one(revGone))).toBe("container gone");
  });

  /**
   * THE ASYMMETRIC FIXTURE. `rev-1` wrote three seconds ago and its container is
   * absent; `activity.ts:212` ranks `container-gone` above everything for the
   * reason its comment gives. A renderer that reached for `transcriptAgeMs`
   * before `activity` renders `wrote 3s ago` here and passes every other test in
   * this file, because every other fixture makes the two agree.
   */
  test("container-gone outranks a fresh transcript age", () => {
    const row = one(revGone);
    expect(activityCellOf(row)).toBe("container gone");
    expect(row).not.toContain("wrote 3s ago");
  });

  /**
   * ISC-482. Blanking is the failure: an empty cell reads as "nothing to report"
   * and this is the opposite of nothing to report. The finding is NAMED twice,
   * in the activity cell and in the container cell, because it is a
   * contradiction between two sources and each column owns one of them.
   */
  test("an absent container is a named finding on the row, not a blank", () => {
    expect(one(revGone)).toContain("Down");
  });

  /**
   * `null` containerPresent means the slow clock has never completed
   * (`activity.ts:99-107`) — `Region`'s `never` arriving as an absence of fact
   * rather than as a negative. Rendering it as `no container` would put the most
   * actionable finding this monitor has on every worker at startup.
   */
  test("an unchecked container does not render as an absent one", () => {
    const row = one(worker({ workerId: "eng-9", containerPresent: null }));
    // The dash is the third state, and it is NOT `Down` — see `containerCell`.
    expect(row).toContain("—");
    expect(row).not.toContain("Down");
  });

  /**
   * The three `null`-age fixtures, side by side. This is the assertion that
   * fails for a renderer which formats the age and ignores the ladder.
   */
  test("three workers with no transcript age render three different cells", () => {
    const cells = [engRpc, engSilent, engNeverGrew].map((w) => activityCellOf(one(w)));
    expect(cells).toEqual(["not measured (rpc)", "no transcript", "no writes yet"]);
  });
});

/**
 * ISC-478 — the criterion that catches a monitor that lies.
 *
 * §4.3's argument, asserted: a stale value with no marker is indistinguishable
 * from a fresh one, and an operator ACTS on it. `Region.failed` cannot
 * structurally carry a value (`model.ts:47-56`), so the only way to fail this is
 * for the view to keep a previous render around — which is why the assertion is
 * written as a comparison against the healthy frame rather than as a search for
 * the reason alone.
 */
describe("ISC-478: a failed region's reason renders in place of its content", () => {
  const REASON = "unreadable state file /runs/2026-09-02T14-43-27Z-3906/workers/eng-1/state.json";

  /**
   * A correction to this test's own first draft, kept because it is the more
   * interesting half of what the criterion means.
   *
   * It first asserted that the broken frame contained no worker id anywhere, and
   * that FAILED against correct code: `StateReadError`'s message is diagnosable
   * precisely because it names the file it could not read, and that path
   * contains a worker id. **"The id does not appear" was never the requirement
   * — "no ROW appears" is**, and the two differ exactly where the reason is
   * doing its job. Asserting the wrong one would have forced a renderer that
   * withheld the path, which is the value `state.ts:786-804` exists to carry.
   */
  test("the runs region names the failure and renders no worker row", () => {
    const broken = renderFleet({ ...healthy, runs: failed(REASON, NOW - 47_000) });
    expect(broken.join("\n")).toContain(`refresh failed: ${REASON}`);

    // No worker ROW. Compared against the healthy frame so the assertion cannot
    // pass by the rows never having rendered at all.
    // A worker ROW is one that opens with the severity bullet — `*` plain,
    // `●` coloured. Recognising rows by their four-space indent stopped working
    // when the bullet was added, and the bullet is the better marker anyway: it
    // is on every worker row and on nothing else, where the indent was also on
    // continuation lines.
    const rows = (lines: readonly string[]) => lines.filter((l) => /^\s*[*●]\s+\S/.test(l));
    expect(rows(renderFleet(healthy)).length).toBe(6);
    expect(rows(broken)).toEqual([]);

    // And no stale CELL — the confident wrong value is the thing an operator
    // acts on, and it is what survives a renderer that keeps its last model.
    for (const stale of ["wrote 4s ago", "wrote 11m ago", "container gone", "no transcript"]) {
      expect(renderFleet(healthy).join("\n")).toContain(stale);
      expect(broken.join("\n")).not.toContain(stale);
    }
  });

  test("the failed region still carries its age, from when the read failed", () => {
    const broken = renderFleet({ ...healthy, runs: failed(REASON, NOW - 47_000) });
    expect(headingFor(broken, "fleet")).toContain("as of 47s");
  });

  test("a failed docker read says so without blanking the fleet", () => {
    const lines = renderFleet({
      ...healthy,
      containers: failed("docker unavailable: Cannot connect to the Docker daemon", NOW - 30_000),
    });
    const joined = lines.join("\n");
    expect(joined).toContain("refresh failed: docker unavailable");
    // ISC-475's shape at the region layer: one region degrades and no other.
    expect(joined).toContain("eng-1");
    expect(joined).toContain("wrote 4s ago");
  });

});

/**
 * ISC-479 — "I could not look" and "I looked and there was nothing" are
 * different facts and only one of them names a broken monitor.
 *
 * This is the same conflation ISC-216 records at the exit-code layer, and
 * `transcriptNote` (`status.ts:72-80`) already keeps the equivalent pair apart
 * one layer down. Two fixtures, two strings; one string for both fails.
 */
describe("ISC-479: never-read renders differently from read-and-empty", () => {
  test("the runs region distinguishes no data from no live runs", () => {
    const neverRead = headingFor(renderFleet({ ...healthy, runs: never() }), "fleet");
    const empty = headingFor(renderFleet({ ...healthy, runs: ok([], NOW - 2_000) }), "fleet");
    expect(neverRead).toBe("fleet — no data");
    expect(empty).toBe("fleet — as of 2s — no live runs");
    expect(neverRead).not.toBe(empty);
  });

  test("the containers region distinguishes no data from none running", () => {
    const line = (m: FleetModel) => renderFleet(m).find((l) => l.startsWith("containers"));
    expect(line({ ...healthy, containers: never() })).toBe("containers — no data");
    expect(line({ ...healthy, containers: ok([], NOW - 12_000) })).toBe(
      "containers — as of 12s — none running",
    );
  });

  /**
   * A never-read region has NO AGE, and rendering one as `0s` would be the same
   * lie ISC-477 guards against from the other side (`model.ts:75-85`). `as of`
   * must be absent entirely, not present with a zero.
   */
  test("a never-read region carries no age at all", () => {
    expect(headingFor(renderFleet({ ...healthy, runs: never() }), "fleet")).not.toContain("as of");
  });
});

/**
 * ISC-477 at the display layer.
 *
 * The scheduler owns the other half — that `readAt` is the time a read SUCCEEDED
 * and not the time a frame painted — and pins it in `monitor-clocks.test.ts`.
 * What the view owns is that it asks `regionAgeMs` rather than computing an age
 * of its own, and the observable form of that is: freeze the regions, advance
 * `now`, and watch each age move independently.
 */
describe("ISC-477: every region shows an age derived from its own read", () => {
  test("two regions read at two times show two different ages", () => {
    const first = renderFleet(healthy);
    expect(headingFor(first, "fleet")).toContain("as of 2s");
    expect(first.find((l) => l.startsWith("containers"))).toContain("as of 12s");
  });

  test("advancing only `now` ages every region, with the frozen model unchanged", () => {
    // The regions are IDENTICAL objects; only `now` moves. An age computed at
    // paint time would be `0s` in both frames, which is the implementation a
    // reasonable person writes first and the reason this is asserted.
    const later = renderFleet({ ...healthy, now: NOW + 60_000 });
    expect(headingFor(later, "fleet")).toContain("as of 1m");
    expect(later.find((l) => l.startsWith("containers"))).toContain("as of 1m");
  });

  test("the age coarsens the way `ago` does, and never reads as a bug", () => {
    const at = (ms: number) =>
      headingFor(renderFleet({ ...healthy, runs: ok(RUNS, NOW - ms) }), "fleet");
    expect(at(0)).toContain("as of 0s");
    expect(at(59_000)).toContain("as of 59s");
    expect(at(60_000)).toContain("as of 1m");
    expect(at(3_600_000)).toContain("as of 1h");

    /*
     * SUB-SECOND, and it is the assertion the rest of this block was missing.
     *
     * Every other fixture here is an exact multiple of 1000 ms, which makes
     * `Math.round` and `Math.floor` indistinguishable — a mutation swapping them
     * survived the whole suite. `status.ts:41` rounds, and the view's own
     * comment claims the two agree on every boundary so that an operator
     * comparing this pane against `pifleet status` is not made to doubt both.
     * That claim is only worth making if something fails when it stops being
     * true, and 1500 ms is where the two rules part company.
     */
    expect(at(1_500)).toContain("as of 2s");
    expect(at(1_400)).toContain("as of 1s");
    // A region stamped in the FUTURE is a host clock skew, and `-3s` reads as a
    // bug in pifleet rather than as a skew — `status.ts:31-33` clamps for the
    // same reason and `regionAgeMs` already floors at zero (`model.ts:84`).
    expect(headingFor(renderFleet({ ...healthy, runs: ok(RUNS, NOW + 3_000) }), "fleet")).toContain(
      "as of 0s",
    );
  });
});

/**
 * The task column: last, whole, and legible.
 *
 * A task id is the one value on a fleet row an operator must read EXACTLY —
 * it is what they type into `wait`, `artifacts` and `unstage`. In a fixed
 * 12-wide cell between `phase` and `container` it truncated every id this
 * fleet actually issues (`task T-rall…` for `T-rally-accept`), which is not a
 * shorter answer but no answer.
 */
describe("the task column", () => {
  /** `healthy`, with one worker holding a realistically long task id. */
  function withLongTask(taskId: string): FleetModel {
    const [runA, ...rest] = RUNS;
    const [first, ...others] = runA!.workers;
    return {
      ...healthy,
      runs: ok(
        [{ runId: runA!.runId, models: [], workers: [{ ...first!, taskId }, ...others] }, ...rest],
        NOW - 2_000,
      ),
    };
  }

  test("a long task id survives whole", () => {
    const id = "T-rally-accept-with-a-long-name";
    const row = rowFor(renderFleet(withLongTask(id)), "eng-1");
    expect(row).toContain(`task ${id}`);
    // Non-vacuous: the old 12-wide cell produced this prefix and stopped.
    expect(row).not.toContain("task T-rall…");
  });

  test("it is rendered AFTER the container column, not before it", () => {
    /*
     * Order is what makes the width free. Every column left of here is fixed
     * so two frames of the same fleet line up character by character; a
     * variable-width cell in the middle would shift everything to its right
     * as tasks came and went.
     */
    const row = rowFor(renderFleet(healthy), "eng-1");
    expect(row.indexOf("task t-17")).toBeGreaterThan(row.indexOf("Up"));
  });

  test("a worker holding nothing still says so, and still last", () => {
    const row = rowFor(renderFleet(healthy), "eng-2");
    expect(row.indexOf("no task")).toBeGreaterThan(row.indexOf("Up"));
  });

  test("the id is not truncated by the pane either, at a width that fits it", () => {
    // Guards against "last" being implemented as a fixed cell that merely moved.
    const id = "T-a-task-id-that-is-quite-long-indeed";
    const row = rowFor(renderFleet({ ...withLongTask(id), columns: 160 }), "eng-1");
    expect(row).toContain(id);
  });
});

/**
 * The byte-exact pin.
 *
 * §6.6.1's whole refutation was that this assertion form survives Ink, so the
 * file would be incomplete without one. Its value is different from every other
 * test here: the others say what must be true, and this one catches everything
 * nobody thought to say — a column that shifted, a row that gained a space, a
 * line that appeared. When it fails, read the diff and decide; do not update it
 * reflexively.
 *
 * `columns: 100` is stated in the fixture rather than inherited, so the frame
 * below is a property of the model and not of whatever stream happened to carry
 * it. `render.ts` records why it supplies its own capture stream instead of
 * `ink-testing-library`'s, and records that one of the two reasons it first gave
 * was measured false.
 */
describe("the frame, pinned", () => {
  /*
   * UPDATED 2026-09-04, deliberately, and here is the diff that was read.
   *
   * The task column moved from between `phase` and `container` to the END of
   * the row, and stopped being a fixed 12-wide `Cell`:
   *
   *   -  * eng-1  not measured (rpc)  phase running  task t-17   container up
   *   +  * eng-1  not measured (rpc)  phase running  container up         task t-17
   *
   * At 12 wide it truncated every task id this fleet actually issues —
   * `task T-rall…` for `T-rally-accept` — and a task id is the value an
   * operator must read EXACTLY, because it is what they type into `wait`,
   * `artifacts` and `unstage`. Last is the only position where widening it
   * does not move the columns to its right as tasks come and go.
   *
   * What did NOT change then: the indent, the bullet, the id and activity
   * widths, the run headers and the rules.
   *
   * UPDATED A FOURTH TIME the same day: the containers region stopped being a
   * bare count and now lists the containers no worker row accounts for. Two of
   * this fixture's three are `eng-1` and `eng-2`, already on the frame with
   * their own `Up` cells, so the only line worth adding is the relay — which
   * is the point: the count's real content was always the containers the rows
   * do NOT explain, stated as arithmetic the reader had to do.
   *
   * UPDATED A THIRD TIME the same day: `phase idle` became `Idle` and
   * `container up` became `Up`. In both, the first word was a column heading
   * repeated on every value and the state was the half a reader wanted; the
   * columns shrank 18 -> 10 and 21 -> 6, and that width went to the task id.
   * `rev-1` is the row worth reading — `Down` where the others say `Up`, which
   * is the finding the old 21-wide `no container` buried mid-sentence.
   *
   * UPDATED AGAIN the same day: the git strip and the rule above it are gone.
   * The operator's call — a `git status` of the invocation directory polled
   * beside a fleet table was answering a question nobody asked on this screen.
   * Five lines left the frame and nothing else moved with them, which is what
   * makes it a removal rather than a redesign.
   */
  /*
   * UPDATED 2026-09-04, deliberately. ONE LINE WAS ADDED AND NONE MOVED.
   *
   *   + "no workspace recorded"
   *     "  run 2026-09-02T14-43-27Z-3906 — 4 workers"
   *
   * View 1 now groups its workers by the workspace `up` recorded for them
   * (`presentation.json`'s `workspace_ref`), with the workspace as a heading
   * above its group. Every fixture worker here carries `workspace: null` — the
   * majority shape on the operator's disk, 81 of 183 records — so they form one
   * group and it is the DETACHED one, which is the group a workspace-aware view
   * is most likely to drop.
   *
   * **The insertion is the whole diff, and that was a design constraint rather
   * than luck.** The heading sits at column 0 alongside the region heading,
   * leaving the run blocks at 2 and the worker rows at 4. Indenting the runs to
   * 4 to make room would have moved every run header in this fixture and
   * aligned it with the worker text — a change to lines this test exists to
   * guard, bought for nothing. What is asserted below is therefore still every
   * column position, width and glyph this frame had yesterday.
   *
   * WHAT DID NOT CHANGE: the indent, the bullet, the id and activity widths,
   * the run headers, the rules, and the containers region.
   */
  test("a two-run fleet renders exactly these lines", () => {
    const RULE = "-".repeat(100);
    expect(renderFleet({ ...healthy, columns: 100 })).toEqual([
      RULE,
      "fleet — as of 2s — 2 live runs",
      "no workspace recorded",
      "  * eng-1   not measured (rpc)  Running   Up    task t-17",
      "  * eng-2   no transcript       Idle      Up    no task",
      "  * eng-3   wrote 11m ago       Idle      Up    task t-18",
      "  * eng-4   wrote 4s ago        Idle      Up    task t-19",
      "  run 2026-09-02T14-43-27Z-3906 — 4 workers",
      "  * eng-5   no writes yet       Idle      Up    no task",
      "  * rev-1   container gone      Running   Down  task t-9",
      "  run 2026-09-02T09-11-02Z-1180 — 2 workers",
      RULE,
      "containers — as of 12s — 3 seen, 1 not a worker",
      "    Up    pifleet-egress-relay-pifleet-egress",
    ]);
  });

  /**
   * The width is honoured. Not the degradation ladder — ISC-484 owns that and it
   * is not built here — but the frame must at least be a function of
   * `model.columns`, or the ladder has nowhere to live later.
   */
  test("the frame is a function of the model's width", () => {
    const narrow = renderFleet({ ...healthy, columns: 60 });
    const wide = renderFleet({ ...healthy, columns: 200 });
    expect(narrow).not.toEqual(wide);
  });
});

/**
 * The activity cell, extracted from a row by POSITION rather than by pattern.
 *
 * A helper that searched the row for a known activity string would answer the
 * question by assuming its own answer — every collapse the sweep above is meant
 * to detect would still "find" a cell. Slicing the fixed column instead means
 * the helper knows the layout and nothing about the ladder, so a renderer that
 * put a phase verdict in the activity column fails rather than passes.
 *
 * The offsets are the view's own: four spaces of indent, an id column, then the
 * activity column. They are asserted by the pinned frame above, so a layout
 * change breaks that test loudly instead of breaking this helper quietly.
 */
const INDENT = 4;
const ID_COL = 8;
const ACTIVITY_COL = 20;
function activityCellOf(row: string): string {
  return row.slice(INDENT + ID_COL, INDENT + ID_COL + ACTIVITY_COL).trimEnd();
}

// ---------------------------------------------------------------------------
// ISC-484 / ISC-485 — degradation and the floor
// ---------------------------------------------------------------------------

describe("ISC-484: the ladder degrades in a stated order, never at Ink's discretion", () => {
  /**
   * ## Why these assert an ORDER over a swept range rather than breakpoints
   *
   * A test naming the width at which each column disappears passes for a ladder
   * whose rungs are in the wrong order — it would simply record the wrong
   * order and keep recording it. §6.5's requirement is not "task goes at 83", it
   * is that a column NEVER outlives one ranked below it. Asserted as a property
   * over every width from the floor to well past full, the wrong order cannot
   * survive at any width, and the constants stay free to change.
   */
  const widths = Array.from({ length: 90 }, (_, i) => FLOOR_COLUMNS + i);

  test("no column outlives one that is dropped later", () => {
    for (const columns of widths) {
      const plan = planColumns(columns);
      // task is dropped FIRST, so it may never be present when a later rung is
      // already gone.
      if (plan.showTask) {
        expect({ columns, container: plan.showContainer }).toEqual({ columns, container: true });
      }
      if (plan.showContainer) {
        expect({ columns, phase: plan.showPhase }).toEqual({ columns, phase: true });
      }
      // The run-id suffix shares the phase's tier — see `planColumns`' note on
      // the one deviation from §6.5's ordering, and why it is not a rung.
      expect({ columns, full: plan.runIdFull }).toEqual({ columns, full: plan.showPhase });
    }
  });

  test("the plan is monotonic: widening never removes a column", () => {
    for (let i = 1; i < widths.length; i++) {
      const narrow = planColumns(widths[i - 1]!);
      const wide = planColumns(widths[i]!);
      for (const key of ["showTask", "showContainer", "showPhase", "runIdFull"] as const) {
        if (narrow[key]) {
          expect({ at: widths[i], key, kept: wide[key] }).toEqual({ at: widths[i], key, kept: true });
        }
      }
    }
  });

  /**
   * THE HALF §6.5 CARES MOST ABOUT. Between them the worker id and the activity
   * cell are the entire answer to §1.3's first question, so no width above the
   * floor may lose either — and the staleness marker that says how old the
   * answer is must survive with them.
   */
  test("the id, the activity age and the staleness marker survive every width above the floor", () => {
    for (const columns of [FLOOR_COLUMNS, 33, 40, 50, 66, 80, 100, 140]) {
      const lines = renderFleet({ ...healthy, columns });
      const row = rowFor(lines, "eng-3");
      expect({ columns, row }).toEqual({ columns, row: expect.stringContaining("eng-3") });
      // `quiet` reaches the frame as an AGE, never as a verdict word (§6.2).
      expect({ columns, hasAge: row.includes("wrote 11m ago") }).toEqual({ columns, hasAge: true });
      // …and the region's own age, which is what makes the row trustworthy.
      expect({ columns, stale: headingFor(lines, "fleet").includes("as of") }).toEqual({
        columns,
        stale: true,
      });
    }
  });

  test("the columns actually leave the frame in that order", () => {
    /*
     * The widths are DERIVED from `planColumns`, not remembered.
     *
     * This test used to name 120 / 80 / 66 / 40 and match the words `phase`
     * and `container`. Both halves rotted on 2026-09-04 in the same edit: the
     * cells became `Idle` and `Up`, so the markers were gone, and dropping
     * their repeated-heading prefixes shrank the columns (18 -> 10, 21 -> 6),
     * so the breakpoints moved. Remembered numbers and remembered strings fail
     * together, and neither failure tells you the ORDER is still right — which
     * is the only thing ISC-484 claims.
     *
     * `planColumns` is exported for exactly this, as its own docblock says.
     */
    const widthFor = (want: (p: ReturnType<typeof planColumns>) => boolean): number => {
      for (let c = FLOOR_COLUMNS; c <= 300; c += 1) if (want(planColumns(c))) return c;
      throw new Error("no width in [floor, 300] satisfies the predicate");
    };

    const all = widthFor((pl) => pl.showTask && pl.showContainer && pl.showPhase);
    const wide = rowFor(renderFleet({ ...healthy, columns: all }), "eng-3");
    expect(wide).toContain("task t-18");
    expect(wide).toContain("Up");
    expect(wide).toContain("Idle");

    const noTaskAt = widthFor((pl) => !pl.showTask && pl.showContainer && pl.showPhase);
    const noTask = rowFor(renderFleet({ ...healthy, columns: noTaskAt }), "eng-3");
    expect(noTask).not.toContain("task t-18");
    expect(noTask).toContain("Up");

    const noContainerAt = widthFor((pl) => !pl.showContainer && pl.showPhase);
    const noContainer = rowFor(renderFleet({ ...healthy, columns: noContainerAt }), "eng-3");
    expect(noContainer).not.toContain("Up");
    expect(noContainer).toContain("Idle");

    const bare = rowFor(renderFleet({ ...healthy, columns: FLOOR_COLUMNS }), "eng-3");
    expect(planColumns(FLOOR_COLUMNS).showPhase).toBe(false);
    expect(bare).not.toContain("Idle");
    expect(bare).toContain("wrote 11m ago");

    // The ORDER itself, which is the claim: each tier is strictly narrower
    // than the one it survives. Without this the four probes above could all
    // pass on a ladder that dropped things in any sequence.
    expect(noTaskAt).toBeLessThan(all);
    expect(noContainerAt).toBeLessThan(noTaskAt);
  });

  /** The run id shortens to its suffix, which is the label `status` already uses. */
  test("the run id becomes its suffix at the tier that drops the phase", () => {
    const wide = renderFleet({ ...healthy, columns: 120 }).join("\n");
    expect(wide).toContain("run 2026-09-02T14-43-27Z-3906");

    const narrow = renderFleet({ ...healthy, columns: 40 }).join("\n");
    expect(narrow).not.toContain("2026-09-02T14-43-27Z-3906");
    expect(narrow).toContain("run 3906");
  });
});

describe("ISC-485: below the floor it refuses, and the refusal is actionable", () => {
  /**
   * The floor is DERIVED, not probed — it is exactly the width the columns
   * §6.5 forbids dropping require. This pins the derivation rather than the
   * number, so changing a column width moves the floor and this still holds.
   */
  test("the floor is the width the never-dropped columns need, and nothing more", () => {
    expect(FLOOR_COLUMNS).toBe(32);
    // At the floor it still draws: a refusal one column too eager is a monitor
    // that will not run on a pane it could have served.
    const atFloor = renderFleet({ ...healthy, columns: FLOOR_COLUMNS });
    expect(atFloor.join("\n")).toContain("eng-3");
  });

  test("one column below the floor it refuses instead of drawing", () => {
    const lines = renderFleet({ ...healthy, columns: FLOOR_COLUMNS - 1 });
    const text = lines.join(" ");
    // NOT a truncated table. No worker, no run, no region line.
    expect(text).not.toContain("eng-3");
    expect(text).not.toContain("fleet —");
    expect(text).not.toContain("run ");
  });

  /**
   * The sentence names BOTH numbers, on `RunDirMountError`'s pattern
   * (`paths.ts:755-791`): the size required and the size present. "Too narrow"
   * sends an operator to the source to find out what would be wide enough.
   */
  test("the refusal names the required width and the actual one", () => {
    const text = renderFleet({ ...healthy, columns: 20 }).join(" ");
    expect(text).toContain(String(FLOOR_COLUMNS));
    expect(text).toContain("20");
    expect(text.toLowerCase()).toContain("columns");
  });

  /**
   * The refusal WRAPS rather than truncating, which is the one place in this
   * view where wrapping is right. Every other cell truncates to hold the column
   * alignment; a truncated refusal would read `pifleet monitor needs at` and be
   * exactly the unreadable output the refusal exists to avoid.
   */
  test("the refusal stays legible at an absurd width", () => {
    const joined = renderFleet({ ...healthy, columns: 12 }).join(" ").replace(/\s+/g, " ");
    expect(joined).toContain("needs at least 32 columns");
    expect(joined).toContain("has 12");
  });
});


/* ---------------------------------------------------------------------------
 * THE MODEL ON THE RUN LINE (owner's request, 2026-09-05)
 * ------------------------------------------------------------------------- */

describe("the run line names what its workers are running", () => {
  const withModels = (models: readonly string[]): FleetModel => ({
    ...healthy,
    columns: 120,
    runs: ok([{ runId: RUN_A, models, workers: [engRpc] }], NOW - 1_000),
  });
  const runLine = (models: readonly string[], colour = false): string => {
    const line = renderFleet(withModels(models), { colour }).find((l) => l.includes(`run ${RUN_A}`));
    expect(line).toBeDefined();
    return line as string;
  };

  test("a recorded model is printed on the run line, after the worker count", () => {
    const line = runLine(["ollama-cloud/qwen3.5:397b"]);
    expect(line).toContain("1 worker");
    expect(line).toContain("ollama-cloud/qwen3.5:397b");
    // AFTER the count. The run id keeps its position for anyone reading down
    // the column, which is the whole reason the id sits on this line at all.
    expect(line.indexOf("ollama-cloud")).toBeGreaterThan(line.indexOf("1 worker"));
  });

  /*
   * ANTI-DEGENERATE, and the state every run on this operator's disk was in
   * when the field landed: `up` did not record `worker_models` before
   * 2026-09-05, so a run created earlier has none. Nothing is printed — NOT a
   * placeholder, which an operator would have to learn does not name a model
   * called "unknown".
   */
  test("a run that recorded no model prints nothing rather than a placeholder", () => {
    const line = runLine([]);
    expect(line.trimEnd().endsWith("1 worker")).toBe(true);
    expect(line).not.toContain("unknown");
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("null");
  });

  test("a run whose workers differ names each model", () => {
    const line = runLine(["ollama-cloud/deepseek-v4-pro:0813", "ollama-cloud/glm-5.3"]);
    expect(line).toContain("deepseek-v4-pro:0813");
    expect(line).toContain("glm-5.3");
  });

  /*
   * The colour IS the request — dark blue.
   *
   * Asserted on the PALETTE and not on an SGR escape, because the escape is
   * not observable from here and that is by design: `render.ts:176-183` says
   * colour has TWO independent gates, and the second is chalk's own level,
   * computed from the real `process.stdout` when chalk is imported. A test
   * process is not a terminal, so that gate is shut and `colour: true`
   * produces a frame byte-identical to the plain one. A capture stream
   * claiming to be a TTY was already tried in this design and does nothing.
   *
   * So the checkable claim is which colour the palette names. `blue` is SGR 34
   * and `blueBright` is 94; the owner asked for dark, and this is the line
   * that would have to change for it to become bright.
   */
  test("the palette names dark blue for the model, and it is its own entry", () => {
    expect(COLOUR.model).toBe("blue");
    expect(COLOUR.model).not.toBe("blueBright");
    // Its own entry, not a reuse: a later decision about what `dim` or the
    // workspace heading means must not silently repaint this.
    expect(COLOUR.model).not.toBe(COLOUR.dim);
    expect(COLOUR.model).not.toBe(COLOUR.workspace);
    expect(COLOUR.model).not.toBe(COLOUR.heading);
    // And the plain frame carries no escape at all, which is the property
    // every byte-pinned assertion in this file rests on.
    expect(PLAIN.model).toBeUndefined();
  });
});
