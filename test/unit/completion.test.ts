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
import { CompletionTracker } from "../../src/rpc/completion.ts";
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
