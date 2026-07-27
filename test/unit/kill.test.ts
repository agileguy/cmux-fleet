/**
 * safety/kill.ts — the ladder's identity discipline and the stall policy.
 *
 * Every process here is fake: the ops table decides what `ps` would say and
 * records what would have been signalled, and the clock is injected so no
 * test sleeps. The load-bearing assertions are the NEGATIVE ones — the pids
 * that were never signalled — because ISC-191's failure mode is a signal
 * delivered to an innocent process, and only a recorded absence can prove it
 * didn't happen.
 */

import { describe, expect, test } from "bun:test";
import { EXIT, isExitCoded, type ProcId } from "../../src/contracts.ts";
import {
  classifyStall,
  runKillLadder,
  signalIfSame,
  TaskDeadlineError,
  type ProcessOps,
} from "../../src/safety/kill.ts";

/** Fake OS: a pid table plus a signal log; time advances only through sleep. */
function harness() {
  const table = new Map<number, string>();
  const signals: Array<{ pid: number; sig: string }> = [];
  const ops: ProcessOps = {
    startTime: (pid) => Promise.resolve(table.get(pid) ?? null),
    signal(pid, sig) {
      signals.push({ pid, sig });
    },
  };
  let t = 0;
  const now = () => t;
  const sleep = (ms: number) => {
    t += ms;
    return Promise.resolve();
  };
  return { table, signals, ops, now, sleep };
}

const TARGET: ProcId = { pid: 100, started: "Mon Jul 27 10:00:00 2026" };
const FAST = { abortGraceMs: 50, termGraceMs: 50, killGraceMs: 50, pollMs: 10 };

describe("signalIfSame (ISC-191 primitive)", () => {
  /**
   * Fails if: the identity comparison degrades to pid-liveness — the exact
   * regression the criterion names: a recycled pid would be signalled.
   */
  test("a live pid with a different start time is never signalled", async () => {
    const h = harness();
    h.table.set(100, "some OTHER process's start time");
    const sent = await signalIfSame(TARGET, "SIGTERM", { ops: h.ops });
    expect(sent).toBe(false);
    expect(h.signals).toEqual([]);
  });

  /**
   * Fails if: group addressing is dropped — a SIGKILL to the leader alone
   * leaves the container-side process tree running (SRD §13.1 kills groups).
   */
  test("a pgid addresses the group as a negative pid", async () => {
    const h = harness();
    h.table.set(100, TARGET.started);
    await signalIfSame(TARGET, "SIGKILL", { pgid: 200, ops: h.ops });
    expect(h.signals).toEqual([{ pid: -200, sig: "SIGKILL" }]);
  });

  /**
   * Fails if: the check-then-signal race stops being tolerated. A process
   * dying inside that window surfaces as ESRCH — the same fact arriving
   * late, not an error.
   */
  test("ESRCH between check and signal reads as already gone", async () => {
    const h = harness();
    h.table.set(100, TARGET.started);
    const ops: ProcessOps = {
      startTime: h.ops.startTime,
      signal() {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    };
    expect(await signalIfSame(TARGET, "SIGTERM", { ops })).toBe(false);
  });
});

describe("runKillLadder: identity is re-validated at every rung", () => {
  /**
   * THE ISC-191 regression test. The pid is recycled DURING the abort grace:
   * the ladder saw a valid identity at rung 0, and an implementation that
   * carries that check forward signals pid 100's new owner. Fails if: any
   * rung signals on an identity it validated before an await.
   */
  test("a pid recycled mid-ladder is never signalled", async () => {
    const h = harness();
    h.table.set(100, TARGET.started);
    const outcome = await runKillLadder({
      target: TARGET,
      abort: () => {
        // The target dies and the kernel hands its pid to someone new while
        // the abort grace is still counting down.
        h.table.set(100, "innocent inheritor of pid 100");
        return Promise.resolve();
      },
      dead: () => Promise.resolve(false), // the caller's death signal lags
      ...FAST,
      ops: h.ops,
      now: h.now,
      sleep: h.sleep,
    });
    expect(h.signals).toEqual([]); // nobody was signalled — the whole point
    expect(outcome).toBe("aborted");
  });

  /**
   * Fails if: a rung is skipped or reordered — a target that ignores both
   * abort and SIGTERM must still meet SIGKILL, in that order, or a wedged
   * agent survives the ladder (ISC-117's mechanism).
   */
  test("a target ignoring everything is escalated abort -> SIGTERM -> SIGKILL", async () => {
    const h = harness();
    h.table.set(100, TARGET.started);
    let aborts = 0;
    const outcome = await runKillLadder({
      target: TARGET,
      pgid: 300,
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
      dead: () => Promise.resolve(false),
      ...FAST,
      ops: h.ops,
      now: h.now,
      sleep: h.sleep,
    });
    expect(aborts).toBe(1);
    expect(h.signals).toEqual([
      { pid: -300, sig: "SIGTERM" },
      { pid: -300, sig: "SIGKILL" },
    ]);
    // Identity still present after SIGKILL grace: the only honest answer.
    expect(outcome).toBe("unconfirmed");
  });

  /**
   * Fails if: the ladder stops waiting for the positive death signal after
   * abort and escalates regardless — every clean abort would eat a needless
   * SIGTERM, and a settling task would be killed mid-settle.
   */
  test("an answered abort ends the climb with no signals", async () => {
    const h = harness();
    h.table.set(100, TARGET.started);
    let aborted = false;
    const outcome = await runKillLadder({
      target: TARGET,
      abort: () => {
        aborted = true;
        return Promise.resolve();
      },
      dead: () => Promise.resolve(aborted),
      ...FAST,
      ops: h.ops,
      now: h.now,
      sleep: h.sleep,
    });
    expect(outcome).toBe("aborted");
    expect(h.signals).toEqual([]);
  });

  /**
   * Fails if: SIGKILL is sent without consulting the death signal after
   * SIGTERM — a target that dies on TERM must not also be KILLed, because by
   * then the pid may already be someone else's.
   */
  test("a target that dies on SIGTERM is not also SIGKILLed", async () => {
    const h = harness();
    h.table.set(100, TARGET.started);
    const ops: ProcessOps = {
      startTime: h.ops.startTime,
      signal(pid, sig) {
        h.signals.push({ pid, sig });
        if (sig === "SIGTERM") h.table.delete(100); // dies on TERM
      },
    };
    const outcome = await runKillLadder({
      target: TARGET,
      abort: null,
      dead: null, // default: identity disappearance
      ...FAST,
      ops,
      now: h.now,
      sleep: h.sleep,
    });
    expect(outcome).toBe("terminated");
    expect(h.signals).toEqual([{ pid: 100, sig: "SIGTERM" }]);
  });

  /**
   * Fails if: rung 0 stops checking identity before doing anything — reaping
   * a long-dead registry entry would abort/signal whatever lives at that pid
   * now, and the reaper's idempotence (ISC-118) rests on this exact return.
   */
  test("an absent target is already_gone: no abort, no signals", async () => {
    const h = harness();
    let aborts = 0;
    const outcome = await runKillLadder({
      target: TARGET,
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
      ...FAST,
      ops: h.ops,
      now: h.now,
      sleep: h.sleep,
    });
    expect(outcome).toBe("already_gone");
    expect(aborts).toBe(0);
    expect(h.signals).toEqual([]);
  });
});

describe("classifyStall (ISC-110 / ISC-117): queued and wedged are different", () => {
  const TIMERS = { warnMs: 180_000, killMs: 1_500_000 };

  /**
   * Fails if: the kill branch stops requiring the admission slot — the exact
   * ISC-110 regression: a worker queued behind max_concurrent is silent for
   * exactly as long as the queue is, and killing it executes a healthy
   * worker for standing in the line we put it in (F20 false positive).
   */
  test("a queued worker is never killed for event silence, however long", () => {
    expect(
      classifyStall({ sinceLastEventMs: 10 * TIMERS.killMs, holdsSlot: false, ...TIMERS }),
    ).toBe("warn");
  });

  /**
   * Fails if: the wedged case stops reaching `kill` at event_stall_kill — a
   * live-heartbeat, zero-event agent would hold its oMLX slot forever
   * (ISC-117).
   */
  test("a slot holder silent past event_stall_kill is killed", () => {
    expect(
      classifyStall({ sinceLastEventMs: TIMERS.killMs, holdsSlot: true, ...TIMERS }),
    ).toBe("kill");
  });

  /**
   * Fails if: warn fires early or healthy extends past warn — the warn band
   * is what §5.9 sizes to absorb queueing delay, and moving its edges
   * changes what F40 tuning means.
   */
  test("the warn band sits between event_stall_warn and event_stall_kill", () => {
    expect(
      classifyStall({ sinceLastEventMs: TIMERS.warnMs - 1, holdsSlot: true, ...TIMERS }),
    ).toBe("healthy");
    expect(
      classifyStall({ sinceLastEventMs: TIMERS.warnMs, holdsSlot: true, ...TIMERS }),
    ).toBe("warn");
    expect(
      classifyStall({ sinceLastEventMs: TIMERS.killMs - 1, holdsSlot: true, ...TIMERS }),
    ).toBe("warn");
  });
});

describe("ISC-116: deadline exhaustion is a diagnosed exit-4 failure", () => {
  /**
   * Fails if: TaskDeadlineError stops satisfying ExitCoded or drifts off
   * EXIT.TIMEOUT — the CLI would print a stack trace and exit 1 where §10
   * promises a one-line message and exit 4.
   */
  test("TaskDeadlineError carries EXIT.TIMEOUT through the ExitCoded protocol", () => {
    const err = new TaskDeadlineError("t-9", 1500);
    expect(isExitCoded(err)).toBe(true);
    expect(err.exitCode).toBe(EXIT.TIMEOUT);
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain("timed_out");
  });
});
