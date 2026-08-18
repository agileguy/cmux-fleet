/**
 * Completion detector (SRD §7.4) against the event shapes the scenarios emit.
 *
 * The single property under test, stated once: the tracker must never allow a
 * settle while there is EVIDENCE of pending output — a retry outstanding, a
 * non-empty queue, a `willRetry:true` end, streaming state, or a moving
 * counter. (No detector can see a future emission that has left no trace; the
 * stream-offset fence in epoch.ts is what contains those.)
 */

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CompletionTracker } from "../../src/rpc/completion.ts";
import { EpochManager } from "../../src/rpc/epoch.ts";
import type { RpcEvent, RpcSessionState } from "../../src/contracts.ts";

const QUIET: RpcSessionState = { isStreaming: false, pendingMessageCount: 0 };
const quiet = (extra: Record<string, unknown> = {}): RpcSessionState => ({ ...QUIET, ...extra });

function replay(tracker: CompletionTracker, events: RpcEvent[]): void {
  for (const e of events) tracker.observe(e);
}

/** The four-condition happy path: end-without-retry, empty queue, double-quiet probe. */
describe("CompletionTracker — happy path", () => {
  test("settles only after agent_end{willRetry:false} + empty queue + quiet probe", () => {
    const t = new CompletionTracker();
    t.reset();
    expect(t.eligible).toBe(false);

    replay(t, [{ type: "agent_start" }]);
    expect(t.eligible).toBe(false);

    replay(t, [
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(t.eligible).toBe(true);

    const token = t.beginProbe();
    expect(t.confirm(token, quiet(), quiet())).toBe(true);
  });

  test("a willRetry field that is absent is not treated as false", () => {
    // Defensive: an agent_end with no discriminator must not settle anything.
    const t = new CompletionTracker();
    t.reset();
    replay(t, [{ type: "agent_start" }, { type: "agent_end" }]);
    expect(t.eligible).toBe(false);
  });
});

describe("CompletionTracker — ISC-82, retries", () => {
  test("agent_end{willRetry:true} does not make the task eligible", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [{ type: "agent_start" }, { type: "agent_end", willRetry: true }]);
    expect(t.eligible).toBe(false);
  });

  test("the will-retry scenario settles only on the second, real end", () => {
    // Mirrors scenarios/will-retry.json: end{true}, auto retry, end{false}.
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "agent_end", willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3 },
    ]);
    expect(t.eligible).toBe(false);

    replay(t, [{ type: "auto_retry_end", success: true, attempt: 1 }]);
    expect(t.eligible).toBe(false); // retry resolved but no clean end yet

    replay(t, [
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(t.eligible).toBe(true);
  });

  test("an outstanding auto_retry_start blocks even after a clean-looking end", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "auto_retry_start", attempt: 1 },
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(t.eligible).toBe(false);
  });

  test("an unfinished summarization retry blocks settlement", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "summarization_retry_scheduled" },
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(t.eligible).toBe(false);

    replay(t, [{ type: "summarization_retry_finished" }]);
    expect(t.eligible).toBe(true);
  });
});

describe("CompletionTracker — queue conditions", () => {
  test("non-empty steering blocks settlement", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: ["fix the tests"], followUp: [] },
    ]);
    expect(t.eligible).toBe(false);
  });

  test("non-empty followUp blocks settlement", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: ["then run bun test"] },
    ]);
    expect(t.eligible).toBe(false);
  });

  test("queue-race: a non-empty queue_update between probe reads voids the probe", () => {
    // Mirrors scenarios/queue-race.json: both get_state samples are quiet, but
    // a queue_update with pending steering lands between them. One quiet
    // sample must not win over evidence of pending output.
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    const token = t.beginProbe();
    const first = quiet();

    replay(t, [{ type: "queue_update", steering: ["late steer"], followUp: [] }]);
    const second = quiet(); // the sample itself looks quiet — the tracker must not care

    expect(t.confirm(token, first, second)).toBe(false);
  });
});

describe("CompletionTracker — probe validity", () => {
  test("any activity between beginProbe and confirm voids the probe", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    const token = t.beginProbe();
    replay(t, [{ type: "agent_start" }]); // agent moved again
    expect(t.confirm(token, quiet(), quiet())).toBe(false);
  });

  test("an empty queue_update does NOT void the probe — it reports quiet", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "agent_end", willRetry: false },
    ]);
    const token = t.beginProbe();
    replay(t, [{ type: "queue_update", steering: [], followUp: [] }]);
    expect(t.confirm(token, quiet(), quiet())).toBe(true);
  });

  test("a streaming sample fails confirmation", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    const token = t.beginProbe();
    expect(t.confirm(token, quiet(), { isStreaming: true, pendingMessageCount: 0 })).toBe(false);
  });

  test("a pending message in either sample fails confirmation", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    const token = t.beginProbe();
    expect(t.confirm(token, { isStreaming: false, pendingMessageCount: 1 }, quiet())).toBe(false);
  });

  test("a monotonic counter moving between the two reads fails confirmation", () => {
    // ABA defence: zero at T1 and zero at T2 says nothing about the interval.
    // A moving counter is the one signal a gauge cannot fake.
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    const token = t.beginProbe();
    expect(t.confirm(token, quiet({ turnsStarted: 3 }), quiet({ turnsStarted: 4 }))).toBe(false);
    expect(t.confirm(token, quiet({ turnsStarted: 4 }), quiet({ turnsStarted: 4 }))).toBe(true);
  });
});

describe("CompletionTracker — hostile sequences", () => {
  test("duplicate-end: a second agent_end{willRetry:false} does not re-arm a stale probe", () => {
    // Mirrors scenarios/duplicate-end.json. The second end is activity: any
    // probe opened before it is void, so the settle decision is re-derived
    // from post-duplicate state rather than smuggled through.
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    const token = t.beginProbe();
    replay(t, [{ type: "agent_end", willRetry: false }]);
    expect(t.confirm(token, quiet(), quiet())).toBe(false);
    // A fresh probe after the duplicate may legitimately succeed.
    const token2 = t.beginProbe();
    expect(t.confirm(token2, quiet(), quiet())).toBe(true);
  });

  test("reset clears every condition — nothing carries into a new epoch", () => {
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(t.eligible).toBe(true);
    t.reset();
    expect(t.eligible).toBe(false);
    // And a probe token from before the reset is void.
    const staleToken = 0;
    expect(t.confirm(staleToken, quiet(), quiet())).toBe(false);
  });

  test("no-tool-calls: three turns with zero tool calls still settle cleanly", () => {
    // Mirrors scenarios/no-tool-calls.json. Settlement is the supervisor's
    // job; classifying this as failed:no_tool_calls is the harvester's
    // (acceptance #61, Phase 2). The detector must not hang on it.
    const t = new CompletionTracker();
    t.reset();
    replay(t, [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "turn_end" },
      { type: "turn_start" },
      { type: "turn_end" },
      { type: "turn_start" },
      { type: "turn_end" },
      { type: "agent_end", willRetry: false },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(t.eligible).toBe(true);
    const token = t.beginProbe();
    expect(t.confirm(token, quiet(), quiet())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The scenario property (ISC-147): completion is never declared while the
// agent will still emit output.
//
// Driven as a table over test/fixtures/scenarios/ so a scenario added later
// FAILS the suite until it declares its expected settles — silently-untested
// hostile scenarios are how false completions come back.
//
// The harness composes the two real machines — EpochManager (stream-offset
// attribution) and CompletionTracker (four-condition detection with the
// double-read probe) — and replays each scenario's emissions with the same
// routing the supervisor uses, answering get_state probes the way fake-pi
// does: honestly from what has been emitted so far, with scripted overrides
// and mid-probe injections honoured.
// ---------------------------------------------------------------------------

interface ScenarioStep {
  on: string;
  respond?: Record<string, unknown>;
  emit?: Array<Record<string, unknown>>;
  emit_after_respond?: Array<Record<string, unknown>>;
}
interface ScenarioFile {
  scenario: string;
  steps: ScenarioStep[];
}

/**
 * Expected settle epochs per scenario. An entry here is a REVIEWED claim
 * about the scenario's semantics; a missing entry fails the suite by design.
 */
const EXPECTED_SETTLES: Record<string, number[]> = {
  "happy.json": [1],
  "will-retry.json": [1],
  "no-tool-calls.json": [1],
  "duplicate-end.json": [1], // one settle; the duplicate end is prior, never a second
  "aborted.json": [1], // the harness never aborts, so the turn ends naturally
  // Like aborted.json: the simulator replays the emitted sequence and does not
  // honour `delay_ms`, and the harness never aborts, so the turn ends naturally
  // on the scenario's own agent_end. The scenario's value is elsewhere — in the
  // supervisor integration test, where a real `abort` goes unanswered and the
  // deadline kill ladder has to fire. Settlement there is a supervisor fact,
  // not a completion-tracker one.
  //
  // I first declared this `[]` and the property test refuted it. Recording that
  // rather than quietly editing it: the table is a reviewed CLAIM, and this is
  // what it is for.
  "deaf-abort.json": [1],
  "stale-epoch.json": [1],
  "bad-correlation.json": [1], // the injected response never reaches the tracker
  "interleave.json": [1], // epoch 2's empty prompt must NEVER settle
  "late-failure.json": [], // no terminal event: the late response fails it elsewhere
  "late-response.json": [], // nothing is ever dispatched or emitted
  "truncated.json": [], // the stream dies mid-record; no settle is fabricated
  "queue-race.json": [], // quiet gauges lose to the queued steer, every probe
  /**
   * Settles exactly once, like `happy.json`. The 5s delay sits INSIDE the
   * turn — long enough for a CLI-spawned steer to land mid-turn, which is
   * what ISC-80 needs — and the turn then ends naturally with
   * `agent_end{willRetry:false}`. A delay is not a reason to expect a
   * different settle count; had it ended by abort, this would be `[]` and
   * would prove abort ordering rather than steer ordering.
   */
  "slow-turn.json": [1],
  /**
   * Three prompt steps, so three settles — one per epoch the simulator walks.
   *
   * The scenario's three steps are alternative SCRIPTS, not a sequence: each
   * is selected by `sessions`, so a real worker runs exactly one of them
   * (ISC-158 needs one fleet where two workers flood a pipe and fourteen do
   * not, and one `PIFLEET_PI_COMMAND` serves them all). This simulator has no
   * session identity and replays every prompt step in order, which is the
   * right thing for the property under test: each script must settle its own
   * epoch cleanly on its own `agent_end`, whichever worker draws it.
   *
   * The `noise` volume does not enter the count, and cannot: every record it
   * produces precedes the terminal event, so conditions 1-3 are still false
   * while it streams and no probe is open for it to invalidate.
   */
  "noisy-fleet.json": [1, 2, 3],
};

function simulate(scenario: ScenarioFile): { settles: number[] } {
  const em = new EpochManager();
  const tracker = new CompletionTracker();
  const settles: number[] = [];

  let seq = 0;
  let streaming = false;
  let turnsStarted = 0;
  let probing = false;

  const getStateSteps = scenario.steps.filter((s) => s.on === "get_state");
  let gsCursor = 0;
  const nextGetState = (): { data: RpcSessionState; after: Array<Record<string, unknown>> } => {
    const step = getStateSteps[Math.min(gsCursor, Math.max(0, getStateSteps.length - 1))];
    if (getStateSteps.length > 0) gsCursor++;
    const data = {
      isStreaming: streaming,
      pendingMessageCount: 0,
      turnsStarted,
      ...(step?.respond ?? {}),
    } as RpcSessionState;
    seq++; // the response occupies a stream position
    return { data, after: step?.emit_after_respond ?? [] };
  };

  const track = (e: Record<string, unknown>): void => {
    if (e["type"] === "agent_start") {
      streaming = true;
      turnsStarted++;
    }
    if (e["type"] === "agent_end") streaming = e["willRetry"] === true;
  };

  const probe = (): void => {
    if (probing) return;
    probing = true;
    // Bounded re-probe, mirroring the supervisor's timer-driven retries.
    for (let attempt = 0; attempt < 4 && em.windowOpen && tracker.eligible; attempt++) {
      const token = tracker.beginProbe();
      const r1 = nextGetState();
      for (const ev of r1.after) feed(ev); // lands BETWEEN the two reads
      const r2 = nextGetState();
      const confirmed = tracker.confirm(token, r1.data, r2.data);
      if (confirmed) {
        const settled = em.settle("success", "sim");
        if (settled !== null) settles.push(settled.epoch);
      }
      for (const ev of r2.after) feed(ev); // lands after the second read
      if (confirmed || !tracker.eligible) break;
    }
    probing = false;
  };

  const feed = (e: Record<string, unknown>): void => {
    seq++;
    if (e["type"] === "response") return; // the client routes these as strays
    track(e);
    const event = e as RpcEvent;
    if (event.type === "agent_start" && em.live !== null && !em.windowOpen) {
      if (em.bindStart(seq)) {
        tracker.reset();
        tracker.observe(event);
        if (!probing) probe();
        return;
      }
      return;
    }
    if (em.attribute(seq) === "live" && em.windowOpen) {
      tracker.observe(event);
      if (!probing) probe();
    }
    // else: prior epoch — recorded by the supervisor, invisible to the tracker.
  };

  const promptSteps = scenario.steps.filter((s) => s.on === "prompt");
  let task = 0;
  for (const step of promptSteps) {
    task++;
    const decision = em.allocate(`T-${task}`, `sim-a${task}`, null);
    if (!decision.ok) continue; // busy: the previous epoch never settled
    seq++; // the prompt ack occupies a stream position
    em.noteAck(seq);
    let dead = false;
    for (const entry of step.emit ?? []) {
      // Markers, not records. `noise` is a VOLUME directive — the double
      // expands it into filler on one pipe — and expanding it here would feed
      // the tracker thousands of `message_update`s to prove a property that
      // the ordering already decides: every one of them lands before the
      // terminal event.
      if ("delay_ms" in entry || "partial" in entry || "noise" in entry) continue;
      if ("exit" in entry) {
        dead = true;
        break; // the process died; nothing further arrives, ever
      }
      feed(entry);
    }
    if (dead) break;
  }

  return { settles };
}

describe("scenario property — never complete while output is still coming (ISC-147)", () => {
  const scenariosDir = join(new URL("../../", import.meta.url).pathname, "test/fixtures/scenarios");

  test("every scenario on disk has a reviewed expectation", async () => {
    const files = (await readdir(scenariosDir)).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      expect(
        EXPECTED_SETTLES[f],
        `${f} has no entry in EXPECTED_SETTLES — a new scenario must declare its expected settles`,
      ).toBeDefined();
    }
    // And no stale expectations for deleted scenarios.
    for (const name of Object.keys(EXPECTED_SETTLES)) {
      expect(files, `${name} is expected but missing from scenarios/`).toContain(name);
    }
  });

  for (const [file, expected] of Object.entries(EXPECTED_SETTLES)) {
    test(`${file}: settles exactly ${JSON.stringify(expected)}`, async () => {
      const scenario = JSON.parse(
        await Bun.file(join(scenariosDir, file)).text(),
      ) as ScenarioFile;
      const { settles } = simulate(scenario);
      expect(settles).toEqual(expected);
    });
  }

  test("will-retry: no settle is possible before the retry chain resolves", async () => {
    // The sharpened form of ISC-82: truncate the scenario right after the
    // first agent_end{willRetry:true} and assert the machine cannot settle.
    const scenario = JSON.parse(
      await Bun.file(join(scenariosDir, "will-retry.json")).text(),
    ) as ScenarioFile;
    const promptStep = scenario.steps.find((s) => s.on === "prompt")!;
    const firstEnd = promptStep.emit!.findIndex((e) => e["type"] === "agent_end");
    const truncated: ScenarioFile = {
      scenario: "will-retry-prefix",
      steps: [
        { ...promptStep, emit: promptStep.emit!.slice(0, firstEnd + 1) },
        ...scenario.steps.filter((s) => s.on !== "prompt"),
      ],
    };
    expect(simulate(truncated).settles).toEqual([]);
  });
});
