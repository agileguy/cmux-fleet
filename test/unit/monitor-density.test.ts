/**
 * ISC-495 — Q9's falsifiable form, and the NEGATIVE result it produced.
 *
 * §3.6's third property is "the density is at least an order of magnitude above
 * the incumbent's", and §9 Q9 asks for the falsifiable form of that figure
 * because "a criterion whose threshold is a rhetorical figure will be graded
 * `[~]` forever". §3.6 also says what to do if the figure does not survive
 * measurement: "If it cannot, the design has failed on its own terms and D16 is
 * where to say so."
 *
 * **It does not survive, and this file is where it is said.**
 *
 * ## The measurement, on the operator's own six-worker fleet
 *
 * | | `status --all` | monitor view 1 |
 * |---|---|---|
 * | lines | 12 | 20 |
 * | field kinds asserted per worker | 5 | 7 |
 *
 * That is **1.4x per worker**, not 10x. Counting whole screens rather than rows
 * moves it to roughly 1.8x and costs 8 more lines to do it. No reading of
 * "density" as facts-per-line or facts-per-screen gets within a factor of five
 * of §3.6's claim, and the honest conclusion is that the figure was rhetorical.
 *
 * ## What the measurement found INSTEAD, which is the part worth keeping
 *
 * The monitor's gain is not volume. It is two things volume cannot express:
 *
 * 1. **Fact classes the incumbent has none of.** Container presence, per-region
 *    staleness, and the dispatch route are not sparser in `status` — they are
 *    absent. A ratio cannot represent a denominator of zero, which is why the
 *    density framing missed them.
 * 2. **Discriminating power within one field.** The incumbent's phase column
 *    prints `idle` for every attended worker, correctly and uselessly: on the
 *    real fleet all six rows read `idle task=- supervisor=up`. The monitor's
 *    activity ladder separates those same six workers in the SAME field and the
 *    same width, and a fact count scores that at zero.
 *
 *    **Measured precisely, because the round figure is wrong here too:** the
 *    ladder renders FOUR distinct cells plus a continuous age, not five. Hold
 *    `transcriptAgeMs` equal and `quiet` and `active` collapse to one string —
 *    they differ in ISC-480's fixtures only because those fixtures carry
 *    different ages. That is correct behaviour, not a defect: §6.2 requires an
 *    age "never a verdict", and giving the two different words would render
 *    exactly the verdict it forbids. The consequence worth recording is that
 *    the `quiet`/`active` distinction is not independently observable on
 *    screen. Four renderings against one word is still the real gain.
 *
 * So the criterion this file pins is NOT "10x". It is the measured ratio, the
 * three absent classes, and the ladder's discriminating power — all of which
 * are checkable, which is what Q9 actually asked for.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { renderFleet } from "../../src/monitor/render.ts";
import {
  never,
  ok,
  type Activity,
  type FleetModel,
  type WorkerDetail,
  type WorkerRow,
} from "../../src/monitor/model.ts";

const NOW = 1_000_000;
const RUN = "2026-09-02T10-00-00Z-aaaa";

/**
 * The incumbent's per-worker line, PINNED BY READING ITS SOURCE rather than
 * copied into this file as a literal.
 *
 * The comparison is only honest while the thing being compared against is the
 * thing that ships. A literal here would keep passing after someone added a
 * sixth field to `status`, and this criterion would go on claiming a ratio
 * against a format that no longer existed. Reading the template means the test
 * fails loudly the moment the incumbent changes, which is the correct outcome:
 * the measurement needs redoing, not the assertion adjusting.
 */
const STATUS_SRC = readFileSync(
  new URL("../../src/cli/commands/status.ts", import.meta.url).pathname,
  "utf8",
);

/** What `status.ts` asserts about ONE worker, in the order it prints them. */
const INCUMBENT_FIELDS = ["worker id", "phase", "task", "supervisor liveness", "transcript age"];

/** What monitor view 1's row asserts about one worker. */
const VIEW1_FIELDS = [
  "worker id",
  "severity",
  "activity state",
  "activity age",
  "phase",
  "task",
  "container presence",
];

/** What view 2 adds, none of which view 1 has room for. */
const VIEW2_ADDS = ["turns", "input tokens", "output tokens", "credential", "exit", "dispatch route", "fence"];

const row = (over: Partial<WorkerRow> = {}): WorkerRow => ({
  workerId: "eng-1",
  runId: RUN,
  activity: "quiet",
  phase: "idle",
  transcriptAgeMs: 42_000,
  containerPresent: true,
  taskId: null,
  via: "rpc",
  fence: null,
  ...over,
});

const DETAIL: WorkerDetail = {
  workerId: "eng-1",
  runId: RUN,
  eventLines: ["14:43:01 tool_use Bash"],
  clippedHead: false,
  eventsPresent: true,
  phase: "busy",
  turns: 12,
  inputTokens: 4210,
  outputTokens: 1180,
  credentialDegraded: false,
  exit: null,
  via: "staged",
  fence: { liveTaskId: "t-1", abortRequested: false, attemptCount: 2 },
};

const model = (over: Partial<FleetModel> = {}): FleetModel => ({
  runs: ok([{ runId: RUN, workers: [row()] }], NOW - 1_000),
  containers: ok(["c1"], NOW - 1_000),
  git: ok(
    {
      branchLine: "## main",
      statusLines: [],
      commitLines: [],
      watchDir: "/repo",
      commitsExpanded: false,
    },
    NOW - 1_000,
  ),
  now: NOW,
  columns: 140,
  view: { kind: "fleet" },
  history: never(),
  detail: never(),
  report: never(),
  ...over,
});

describe("ISC-495 (Q9): the density figure, measured rather than asserted", () => {
  /**
   * The incumbent's field count, taken from its own format string. If this
   * fails, `status` gained or lost a field and every ratio below is stale.
   */
  test("the incumbent asserts exactly five field kinds per worker", () => {
    // `  ${w.id}: ${phase} task=${task}${staged} supervisor=${live}${suffix}`
    expect(STATUS_SRC).toContain("task=${task}${staged} supervisor=${live}${suffix}");
    // `staged` and `suffix` are CONDITIONAL — omitted entirely for a worker
    // with nothing staged and no transcript note (`status.ts` says so at both
    // sites), so neither is a field every row carries. Five is the row's floor
    // and the number the comparison uses.
    expect(INCUMBENT_FIELDS).toHaveLength(5);
  });

  test("view 1 asserts seven, and every one is on the frame", () => {
    const frame = renderFleet(model()).join("\n");
    expect(VIEW1_FIELDS).toHaveLength(7);
    expect(frame).toContain("eng-1"); // worker id
    expect(frame).toMatch(/[*●]/); // severity
    expect(frame).toContain("wrote"); // activity state + age
    expect(frame).toContain("42s ago");
    expect(frame).toContain("phase idle");
    expect(frame).toContain("no task");
    expect(frame).toContain("container up");
  });

  /**
   * THE RESULT. Stated as an inequality against 10 so that it fails if someone
   * later makes the claim true — which would be a good failure, and the only
   * way this entry gets rewritten honestly.
   */
  test("the ratio is 1.4x per worker, and NOT the order of magnitude §3.6 claims", () => {
    const ratio = VIEW1_FIELDS.length / INCUMBENT_FIELDS.length;
    expect(ratio).toBeCloseTo(1.4, 5);
    expect(ratio).toBeLessThan(10);

    // Across views 1 and 2 together, which is the most generous reading
    // available, it is still nowhere near.
    const across = (VIEW1_FIELDS.length + VIEW2_ADDS.length) / INCUMBENT_FIELDS.length;
    expect(across).toBeCloseTo(2.8, 5);
    expect(across).toBeLessThan(10);
  });

  /**
   * The first thing the measurement found instead: three classes with a
   * denominator of zero, which no ratio can represent.
   */
  test("three fact classes exist in the monitor and not at all in the incumbent", () => {
    const fleet = renderFleet(model()).join("\n");
    const worker = renderFleet(
      model({ view: { kind: "worker", runId: RUN, workerId: "eng-1" }, detail: ok(DETAIL, NOW - 1_000) }),
    ).join("\n");

    // 1. Container presence — the docker join (§6.7). `status` never shells out.
    expect(fleet).toContain("container up");
    expect(STATUS_SRC).not.toContain("docker");

    // 2. Per-region staleness (§6.4). The incumbent prints no age for its own read.
    expect(fleet).toMatch(/as of \d+s/);

    // 3. The dispatch route and the fence (§6.2, ISC-508).
    expect(worker).toContain("dispatch would be STAGED");
    expect(worker).toContain("fence LIVE on t-1");
  });

  /**
   * The second thing, and the one a fact count scores at zero: the same field,
   * carrying more distinctions. The incumbent's phase reads `idle` for every
   * attended worker — correctly, because no epoch is allocated — so on the
   * operator's real fleet all six rows read `idle task=- supervisor=up`. The
   * ladder separates them without using one more column.
   *
   * ## A PRECISION ABOUT ISC-480, found by this test and worth stating
   *
   * ISC-480 is titled "the five activity states survive to the frame" and its
   * assertions are true — but the mechanism is not the one the wording implies,
   * and this fixture is the one that shows it. Its `quiet` and `active`
   * fixtures render `wrote 11m ago` and `wrote 4s ago`: they differ **only
   * because the fixtures carry different ages**. Hold `transcriptAgeMs` equal,
   * as this test does, and the two collapse to one string — five states, FOUR
   * renderings.
   *
   * **That is correct behaviour and not a defect.** §6.2 requires the activity
   * column to be "an age with its source named, never a verdict", and giving
   * `quiet` and `active` different WORDS would be rendering exactly the verdict
   * it forbids. What is worth recording is the consequence: the `quiet`/`active`
   * distinction is NOT independently observable on screen. An operator reads an
   * age and draws their own conclusion, which is the design's intent; anyone
   * citing ISC-480 for "the operator can see quiet versus active" would be
   * claiming more than holds.
   *
   * So the honest count of the ladder's discriminating power is **four distinct
   * renderings plus a continuous age**, against the incumbent's one word — and
   * this test asserts four rather than five so that the number in the record is
   * the measured one.
   */
  test("the ladder renders four distinct cells plus an age, where the incumbent has one word", () => {
    const states: readonly Activity[] = [
      "rpc",
      "no-transcript",
      "quiet",
      "active",
      "container-gone",
    ];
    const rendered = states.map((activity) => {
      const frame = renderFleet(
        model({
          runs: ok([{ runId: RUN, workers: [row({ activity })] }], NOW - 1_000),
        }),
      ).join("\n");
      // The phase is `idle` in every one of them — which is the whole point:
      // the incumbent's only discriminator is constant across all five.
      expect(frame).toContain("phase idle");
      return frame;
    });

    // Four, not five, and the pair that merges is named so a future reader does
    // not have to rediscover which.
    expect(new Set(rendered).size).toBe(4);
    expect(rendered[2]).toBe(rendered[3]!); // quiet === active, at equal age

    // The age is the fifth discriminator, and it is continuous rather than
    // enumerated — which is why it cannot be counted as a sixth state.
    const young = renderFleet(
      model({ runs: ok([{ runId: RUN, workers: [row({ activity: "active", transcriptAgeMs: 4_000 })] }], NOW - 1_000) }),
    ).join("\n");
    expect(young).not.toBe(rendered[3]);
    expect(young).toContain("wrote 4s ago");
  });
});
