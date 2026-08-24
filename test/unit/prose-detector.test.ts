/**
 * The F39 runtime prose detector and the config road that reaches it (SRD §5.9
 * detector 2 — ISC-108).
 *
 * WHAT THIS FILE IS AND IS NOT. It tests the detector's state machine and the
 * `fleet.yaml` → `run.json` → supervisor road, both of which are cheap and
 * exhaustively testable here. It does NOT close the criterion, and saying so
 * out loud is the point: ISC-108 is about a WORKER being classified
 * `failed:no_tool_calls`, and a unit test over a module the supervisor never
 * called would prove the module and not the criterion. That is the shape that
 * put eight criteria in RC-1. The criterion's evidence is
 * `test/integration/supervisor.test.ts` → "ISC-108: three turns with zero tool
 * calls settle failed:no_tool_calls", which drives a real detached supervisor
 * against `scenarios/no-tool-calls.json` and reads the task record. This file
 * is the fine-grained companion to that, covering the branches a single
 * scenario cannot reach.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NO_TOOL_CALLS_REASON,
  ProseTurnDetector,
} from "../../src/supervisor/prose-detector.ts";
import {
  DEFAULT_PROSE_TURNS_BEFORE_FAIL,
  RunSchema,
  effectiveProseTurnsBeforeFail,
} from "../../src/config/schema.ts";
import { readRunProseTurnsBeforeFail } from "../../src/run/state.ts";
import { runPaths } from "../../src/run/paths.ts";

/** A turn that ran to its own end — the normal case. */
const RAN = { interrupted: false } as const;
/** A turn the supervisor cut short (deadline abort, operator abort). */
const CUT = { interrupted: true } as const;

/**
 * Feed a sequence of event types, returning the indices at which the detector
 * tripped. A LIST rather than a boolean because "trips exactly once" is a real
 * property: `onProseTrip` sends an abort and arms a kill ladder, so a second
 * trip would arm a second timer over the handle holding the first.
 */
function trips(
  d: ProseTurnDetector,
  types: readonly string[],
  ctx: { interrupted: boolean } = RAN,
): number[] {
  const at: number[] = [];
  types.forEach((t, i) => {
    if (d.observe(t, ctx)) at.push(i);
  });
  return at;
}

const PROSE_TURN = ["turn_start", "turn_end"] as const;
const TOOL_TURN = [
  "turn_start",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
] as const;

describe("ProseTurnDetector — the counter (ISC-108)", () => {
  test("three consecutive zero-tool-call turns trip it at the third", () => {
    const d = new ProseTurnDetector(3);
    // The exact shape of scenarios/no-tool-calls.json: three turns, no tools.
    const at = trips(d, [...PROSE_TURN, ...PROSE_TURN, ...PROSE_TURN, "agent_end"]);
    expect(at).toEqual([5]); // the THIRD turn_end, and only it
    expect(d.tripped).toBe(true);
    expect(d.streak).toBe(3);
  });

  test("two prose turns do not trip a threshold of three", () => {
    const d = new ProseTurnDetector(3);
    expect(trips(d, [...PROSE_TURN, ...PROSE_TURN, "agent_end"])).toEqual([]);
    expect(d.tripped).toBe(false);
    expect(d.streak).toBe(2);
  });

  test("the threshold is honoured as a bound, not as the literal 3", () => {
    // Guards the reader end of the config road: if the supervisor ignored
    // `run.json` and hardcoded 3, this would still trip at turn 3.
    const d = new ProseTurnDetector(5);
    expect(trips(d, Array.from({ length: 4 }, () => PROSE_TURN).flat())).toEqual([]);
    expect(trips(new ProseTurnDetector(1), [...PROSE_TURN])).toEqual([1]);
  });

  test("a tool call clears the streak — prose, act, prose is not a trip", () => {
    /**
     * The "different animal" case from the brief, at a threshold that lets it
     * be observed: three prose turns, a productive turn, three more prose
     * turns. At the default of 3 the first run would have tripped before the
     * tool call ever arrived, which is intended (the detector bounds how long a
     * worker may go WITHOUT acting) — but that arithmetic would hide whether
     * the reset works at all, so the threshold is 4 here.
     */
    const d = new ProseTurnDetector(4);
    const at = trips(d, [
      ...PROSE_TURN, ...PROSE_TURN, ...PROSE_TURN,
      ...TOOL_TURN,
      ...PROSE_TURN, ...PROSE_TURN, ...PROSE_TURN,
    ]);
    expect(at).toEqual([]);
    expect(d.tripped).toBe(false);
    expect(d.streak).toBe(3); // counting again from the act, not from zero turns
  });

  test("the streak dies at the tool call, not at the end of its turn", () => {
    // `streak` is what the `no_tool_calls_detected` record reports, so it must
    // not read stale for the remainder of a turn that has already acted.
    const d = new ProseTurnDetector(4);
    trips(d, [...PROSE_TURN, ...PROSE_TURN, "turn_start"]);
    expect(d.streak).toBe(2);
    d.observe("tool_execution_end", RAN);
    expect(d.streak).toBe(0);
  });

  test("one tool call anywhere in a turn makes that turn productive", () => {
    const d = new ProseTurnDetector(2);
    // tool call in turn 1, prose in turn 2 -> streak 1, no trip.
    expect(trips(d, [...TOOL_TURN, ...PROSE_TURN])).toEqual([]);
    expect(d.streak).toBe(1);
  });

  test("an interrupted turn neither increments nor clears the streak", () => {
    /**
     * A `turn_end` after a deadline abort or an operator abort has zero tool
     * calls because the SUPERVISOR ended it. Counting it would report a task
     * that timed out mid-tool-call as a model that never called a tool,
     * routing the operator to change the model when the answer was a longer
     * deadline.
     *
     * Not clearing it either: the abort is not evidence the model recovered.
     */
    const d = new ProseTurnDetector(3);
    trips(d, [...PROSE_TURN, ...PROSE_TURN]); // streak 2
    expect(d.streak).toBe(2);
    expect(trips(d, [...PROSE_TURN], CUT)).toEqual([]); // the cut turn: no trip
    expect(d.streak).toBe(2); // unchanged in BOTH directions
    // And the epoch can still trip afterwards if the model keeps writing prose.
    expect(trips(d, [...PROSE_TURN])).toEqual([1]);
  });

  test("it trips at most once per epoch", () => {
    const d = new ProseTurnDetector(1);
    // Six prose turns at a threshold of 1: one trip edge, not six.
    expect(trips(d, Array.from({ length: 6 }, () => PROSE_TURN).flat())).toEqual([1]);
  });

  test("reset() clears the latch, so one task cannot classify the next", () => {
    const d = new ProseTurnDetector(2);
    expect(trips(d, [...PROSE_TURN, ...PROSE_TURN])).toEqual([3]);
    expect(d.tripped).toBe(true);
    d.reset();
    expect(d.tripped).toBe(false);
    expect(d.streak).toBe(0);
    expect(d.toolCallsThisTurn).toBe(0);
    // A fresh epoch has to earn its own trip from zero.
    expect(trips(d, [...PROSE_TURN])).toEqual([]);
  });

  test("events that are not turn boundaries or tool calls are inert", () => {
    const d = new ProseTurnDetector(1);
    expect(
      trips(d, [
        "agent_start",
        "turn_start",
        "assistant_message",
        "compaction_end",
        "extension_ui_request",
        "auto_retry_start",
        "tool_execution_start", // START is not the completion of a call
        "queue_update",
      ]),
    ).toEqual([]);
    expect(d.streak).toBe(0);
    expect(d.toolCallsThisTurn).toBe(0);
  });
});

describe("ProseTurnDetector — zero and malformed thresholds (ISC-108)", () => {
  test("0 means OFF, not fail-immediately", () => {
    const d = new ProseTurnDetector(0);
    expect(d.enabled).toBe(false);
    // Twenty prose turns and nothing happens. The other reading of 0 — fail
    // before completing any turn — would fire on every task including the ones
    // that work, which is why it is not the reading taken.
    expect(trips(d, Array.from({ length: 20 }, () => PROSE_TURN).flat())).toEqual([]);
    expect(d.tripped).toBe(false);
  });

  test("a threshold that cannot count turns is treated as off, never as -1", () => {
    /**
     * `run.json` is a file another process wrote, so this is defence in depth
     * behind `readRunProseTurnsBeforeFail`'s schema. The direction matters: a
     * negative threshold under a bare `>=` would trip on the FIRST turn of
     * every task ever dispatched — a fail-closed corruption that looks exactly
     * like the detector working, and would be diagnosed as a false positive in
     * the model rather than a bad number.
     */
    for (const bad of [-1, -3, 2.5, NaN, Infinity]) {
      const d = new ProseTurnDetector(bad);
      expect(d.enabled).toBe(false);
      expect(trips(d, [...PROSE_TURN, ...PROSE_TURN, ...PROSE_TURN])).toEqual([]);
    }
  });
});

describe("prose_turns_before_fail reaches the supervisor (ISC-108)", () => {
  test("the schema default is 3 — the number ISC-108 and SRD §5.9 both name", () => {
    expect(DEFAULT_PROSE_TURNS_BEFORE_FAIL).toBe(3);
    expect(RunSchema.shape.prose_turns_before_fail.parse(undefined)).toBe(3);
  });

  test("the schema accepts 0 and refuses values that cannot be a turn count", () => {
    const field = RunSchema.shape.prose_turns_before_fail;
    expect(field.parse(0)).toBe(0); // the off switch must be representable
    expect(field.parse(7)).toBe(7);
    expect(() => field.parse(-1)).toThrow();
    expect(() => field.parse(1.5)).toThrow();
  });

  test("require_native_tool_calls: false zeroes the threshold (§5.9 'disables both')", () => {
    // The runtime half of a sentence that, until ISC-108, had only a startup
    // half to disable.
    expect(
      effectiveProseTurnsBeforeFail({
        run: { prose_turns_before_fail: 3 },
        llm: { require_native_tool_calls: false },
      }),
    ).toBe(0);
    expect(
      effectiveProseTurnsBeforeFail({
        run: { prose_turns_before_fail: 3 },
        llm: { require_native_tool_calls: true },
      }),
    ).toBe(3);
    // The operator's own number survives the gate being ON.
    expect(
      effectiveProseTurnsBeforeFail({
        run: { prose_turns_before_fail: 9 },
        llm: { require_native_tool_calls: true },
      }),
    ).toBe(9);
  });

  test("the reader round-trips run.json, including 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-prose-"));
    try {
      for (const [written, expected] of [
        [9, 9],
        [0, 0], // off survives the road; a `positive()` schema would have lost it
        [1, 1],
      ] as const) {
        const run = runPaths(`r-${written}`, root);
        await mkdir(run.root, { recursive: true });
        await writeFile(
          run.runJson,
          JSON.stringify({ schema: "pifleet.run/v1", prose_turns_before_fail: written }),
        );
        expect(await readRunProseTurnsBeforeFail(run)).toBe(expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a run.json without the key gets the DETECTOR, not silence", async () => {
    /**
     * The direction of this fallback is the decision, not the fallback itself.
     * A run directory written before this key existed — or assembled by hand in
     * a test — falls back to 3 and therefore keeps the guard. Falling back to 0
     * would be the fail-OPEN version: the detector would vanish on exactly the
     * old or hand-built run directories nobody is watching.
     */
    const root = await mkdtemp(join(tmpdir(), "pifleet-prose-"));
    try {
      const run = runPaths("r-absent", root);
      await mkdir(run.root, { recursive: true });
      await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1" }));
      expect(await readRunProseTurnsBeforeFail(run)).toBe(DEFAULT_PROSE_TURNS_BEFORE_FAIL);
      // And a run directory with no run.json at all — the Phase 1 shape.
      const bare = runPaths("r-bare", root);
      await mkdir(bare.root, { recursive: true });
      expect(await readRunProseTurnsBeforeFail(bare)).toBe(DEFAULT_PROSE_TURNS_BEFORE_FAIL);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the settle reason is the exact string ISC-108 names", () => {
    // `failed:no_tool_calls`. Exported rather than written twice so the
    // supervisor and the tests that grade it cannot drift to two spellings.
    expect(NO_TOOL_CALLS_REASON).toBe("no_tool_calls");
  });
});
