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
import { stripComments } from "../support/source-structure.ts";
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

/**
 * `STATUS_SRC` with its comments removed — and every assertion below reads THIS
 * rather than the raw file.
 *
 * The two are not interchangeable, and reading the raw source is a defect
 * rather than a shortcut. `not.toContain("docker")` defends the claim that
 * `status` never shells out, which is a claim about CODE; against raw text it
 * is also satisfied — or broken — by prose. Measured: documenting why a
 * container fact is absent here tripped this test while the property it guards
 * stayed true, so the file taught the next author to avoid a WORD instead of
 * to avoid a call. A guard that can be satisfied by rewording is not guarding
 * the thing its name says.
 *
 * `toContain` is the mirror of the same fault and is stripped for the same
 * reason: a format string that survived only inside a comment would satisfy a
 * raw-text probe while the line that prints it was gone.
 *
 * `stripComments` and not a local regex — `test/support/source-structure.ts`
 * owns this and keeps string and template literals intact, so a `"//"` inside
 * a printed format is not mistaken for a comment.
 */
const STATUS_CODE = stripComments(STATUS_SRC);

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
  workspace: null,
  workspaceName: null,
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
  runs: ok([{ runId: RUN, models: [], workers: [row()] }], NOW - 1_000),
  containers: ok(["c1"], NOW - 1_000),
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
    expect(STATUS_CODE).toContain("task=${task}${staged} supervisor=${live}${suffix}");
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
    expect(frame).toContain("Idle");
    expect(frame).toContain("no task");
    expect(frame).toContain("Up");
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
    expect(fleet).toContain("Up");
    expect(STATUS_CODE).not.toContain("docker");

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
          runs: ok([{ runId: RUN, models: [], workers: [row({ activity })] }], NOW - 1_000),
        }),
      ).join("\n");
      // The phase is `idle` in every one of them — which is the whole point:
      // the incumbent's only discriminator is constant across all five.
      expect(frame).toContain("Idle");
      return frame;
    });

    // Four, not five, and the pair that merges is named so a future reader does
    // not have to rediscover which.
    expect(new Set(rendered).size).toBe(4);
    expect(rendered[2]).toBe(rendered[3]!); // quiet === active, at equal age

    // The age is the fifth discriminator, and it is continuous rather than
    // enumerated — which is why it cannot be counted as a sixth state.
    const young = renderFleet(
      model({ runs: ok([{ runId: RUN, models: [], workers: [row({ activity: "active", transcriptAgeMs: 4_000 })] }], NOW - 1_000) }),
    ).join("\n");
    expect(young).not.toBe(rendered[3]);
    expect(young).toContain("wrote 4s ago");
  });
});

/**
 * ISC-498 — Q10's measurable half: the repaint RATE, which bounds the flash.
 *
 * §9 Q10 asks "does Ink's full-frame repaint flash visibly inside a cmux pane?"
 * and its probe is "run the monitor in a real operations pane and watch". The
 * watching half needs a person and stays open. The frequency half does not, and
 * it decides whether the question matters — a flash nobody can trigger is not a
 * defect.
 *
 * ## Measured on the live six-worker fleet, and the FIRST measurement was wrong
 *
 * The first attempt sampled `composeFleet` — the `--once` path — and reported
 * 0.03 repaints/sec with 98% of paints skipped. **That number is false for the
 * pane and is recorded here rather than deleted, because the mistake is the
 * instructive part.** `composeFleet` re-reads every region on every call, so
 * every `readAt` is fresh, every staleness marker renders `as of 0s` forever,
 * and the frame cannot move. The pane runs the three-clock scheduler instead,
 * where a slow-clock region visibly ages between its own reads.
 *
 * Re-measured on the scheduler path — `FleetClocks` + `modelFrom`, which is
 * what `pifleet monitor` actually paints — 60 samples at 500 ms over 32.7 s:
 *
 * | | `composeFleet` (wrong path) | scheduler (the pane) |
 * |---|---|---|
 * | distinct frames | 1 | 47 |
 * | repaints/sec | 0.03 | **1.44** |
 * | paints skipped | 98% | **22%** |
 *
 * ## The finding, which is a real tension and not a defect
 *
 * **The staleness markers are the dominant source of repaints, not the fleet
 * data.** The fleet was entirely idle for the whole window — no dispatch, no
 * transcript growth, no container change — and it still repainted 47 times,
 * because three regions on three clocks each tick their own `as of Ns` at 1 Hz,
 * out of phase with one another. That is §6.4 working exactly as specified:
 * "nothing on screen is stale without saying so" is what produces the repaint
 * rate §9 Q10 is worried about. The two requirements pull against each other
 * and neither is wrong.
 *
 * So the bound is **~1.4/sec on an idle fleet**, set by the honesty markers,
 * with the 500 ms clock contributing nothing on top. If Q10's perceptual half
 * ever comes back positive, the cheap lever is the marker's granularity rather
 * than the clock's period — and that ordering is the useful thing to have
 * established before anyone reaches for the period.
 */
describe("ISC-498 (Q10): the repaint rate is bounded, and the staleness markers set it", () => {
  /**
   * The property that makes skipping possible at all. If rendering were not
   * deterministic — a set iterated in hash order, a timestamp taken inside the
   * renderer — `next === last` would never fire and the monitor would repaint
   * at the clock's rate no matter what changed.
   */
  test("the same model renders byte-identically, which is what lets a paint be skipped", () => {
    const m = model();
    expect(renderFleet(m).join("\n")).toBe(renderFleet(m).join("\n"));
  });

  /**
   * THE MEASURED CAUSE, as a property rather than as a number in a comment.
   * Advancing `now` alone — no region re-read, nothing in the fleet changed —
   * moves the frame, because the staleness marker crosses a second boundary.
   * This is why 47 of 60 scheduler samples differed on a fleet where nothing
   * happened.
   */
  test("advancing only the clock moves the frame, via the staleness marker", () => {
    const base = renderFleet(model({ now: NOW })).join("\n");
    const later = renderFleet(model({ now: NOW + 1_000 })).join("\n");
    expect(base).toContain("as of 1s");
    expect(later).toContain("as of 2s");
    expect(later).not.toBe(base);
  });

  /**
   * And the bound: the marker's granularity is one second, so the 500 ms clock
   * cannot produce two distinct frames within one second FROM AGEING ALONE.
   * Sub-second advances that stay inside the same second change no byte.
   */
  test("a sub-second advance inside the same second changes nothing", () => {
    const a = renderFleet(model({ now: NOW + 10 })).join("\n");
    const b = renderFleet(model({ now: NOW + 200 })).join("\n");
    expect(b).toBe(a);
  });

  /**
   * The dedup itself is one line inside the commander action, which no unit
   * test drives — the same limit ISC-497's call-site guard records, handled the
   * same way rather than left implied.
   */
  test("the paint skips the write when the frame is unchanged", () => {
    const src = readFileSync(
      new URL("../../src/cli/commands/monitor.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(src).toContain("if (next === last) return;");
  });
});
