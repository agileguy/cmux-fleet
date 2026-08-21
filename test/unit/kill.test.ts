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
  confirmGroup,
  GroupReadError,
  runKillLadder,
  signalIfSame,
  TaskDeadlineError,
  type ProcessOps,
} from "../../src/safety/kill.ts";

/**
 * Fake OS: a pid table, a GROUP table, and a signal log; time advances only
 * through sleep.
 *
 * The group table is the ISC-272 half. It is what the kernel would answer for
 * "which group is this pid in", and it is deliberately a SEPARATE map from the
 * recorded pgid a caller passes in — the whole defect was that those two were
 * assumed to be the same number and never compared.
 */
function harness() {
  const table = new Map<number, string>();
  const groups = new Map<number, number>();
  const signals: Array<{ pid: number; sig: string }> = [];
  const ops: ProcessOps = {
    startTime: (pid) => Promise.resolve(table.get(pid) ?? null),
    groupId: (pid) => Promise.resolve(groups.get(pid) ?? null),
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
  /** The live process is alive AND leads its own group, as a supervisor does. */
  const alive = (started = TARGET.started): void => {
    table.set(TARGET.pid, started);
    groups.set(TARGET.pid, TARGET.pid);
  };
  return { table, groups, signals, ops, now, sleep, alive };
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
    expect(sent).toBe("gone");
    expect(h.signals).toEqual([]);
  });

  /**
   * Fails if: group addressing is dropped — a SIGKILL to the leader alone
   * leaves the container-side process tree running (SRD §13.1 kills groups).
   *
   * The recorded pgid is the leader's own pid, and that is not a convenience:
   * a process group is NAMED by its leader, and `confirmGroup` requires the
   * identity-validated process to be that leader (ISC-272). This test used to
   * pass `pgid: 200` against a target at pid 100 — a group the target could
   * not possibly have led — and expected `-200` to be signalled anyway, which
   * is the defect stated as an expectation.
   */
  test("a confirmed pgid addresses the group as a negative pid", async () => {
    const h = harness();
    h.alive();
    await signalIfSame(TARGET, "SIGKILL", { pgid: TARGET.pid, ops: h.ops });
    expect(h.signals).toEqual([{ pid: -TARGET.pid, sig: "SIGKILL" }]);
  });

  /**
   * The half the group test above does NOT cover: identity is validated on the
   * LEADER, and delivery is to the GROUP. Those are different pids, and for a
   * long time only one of them was checked.
   *
   * What must hold is that a FAILED leader check spares the group as well: a
   * mismatched leader means no signal at all, not a signal to `-pgid` on the
   * theory that the group is still ours.
   *
   * Fails if: the pgid path is ever allowed to bypass the identity check —
   * an unvalidated process group is a far wider blast radius than an
   * unvalidated pid, since it reaches every process in it.
   */
  test("a mismatched leader spares the GROUP too, not just the pid", async () => {
    const h = harness();
    h.table.set(100, "some OTHER process's start time");
    h.groups.set(100, 100);
    const sent = await signalIfSame(TARGET, "SIGKILL", { pgid: TARGET.pid, ops: h.ops });
    expect(sent).toBe("gone");
    // Neither 100 nor -100. The negative assertion is the load-bearing one.
    expect(h.signals).toEqual([]);
  });

  /**
   * Fails if: the check-then-signal race stops being tolerated. A process
   * dying inside that window surfaces as ESRCH — the same fact arriving
   * late, not an error.
   */
  test("ESRCH between check and signal reads as already gone", async () => {
    const h = harness();
    h.alive();
    const ops: ProcessOps = {
      startTime: h.ops.startTime,
      groupId: h.ops.groupId,
      signal() {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    };
    expect(await signalIfSame(TARGET, "SIGTERM", { ops })).toBe("gone");
  });
});

// ---------------------------------------------------------------------------
// The GROUP half (ISC-272)
// ---------------------------------------------------------------------------

/**
 * A validated leader does not vouch for an arbitrary integer.
 *
 * `sameIdentity` proves the process at `target.pid` is the one this run
 * launched. It proves NOTHING about `-pgid`, which is a different number,
 * reaches every process in that group rather than one, and was read from a
 * state file that `down` reads precisely because it may be stale. These are
 * the fake-OS half of the proof; the "a process GROUP is proved against real
 * process groups" block in `test/integration/down-identity.test.ts` runs the
 * same refusals against REAL spawned groups, because a fake group table cannot
 * show that a real signal did not travel.
 */
describe("confirmGroup: a group is addressable only when it is the target's own", () => {
  /**
   * Fails if: the recorded pgid is taken on trust again — the criterion's
   * exact words, "never a pgid taken on trust from a state file". Here the OS
   * says the target leads group 100 and the record says 200; signalling 200
   * would reach a group this run never launched.
   */
  test("a recorded group the OS disagrees with is a mismatch, and is never signalled", async () => {
    const h = harness();
    h.alive();
    expect(await confirmGroup(TARGET, 200, h.ops)).toEqual({ ok: false, why: "mismatch" });
    expect(await signalIfSame(TARGET, "SIGKILL", { pgid: 200, ops: h.ops })).toBe(
      "group_unconfirmed",
    );
    expect(h.signals).toEqual([]);
  });

  /**
   * THE unit form of the scar `down-prune.test.ts` carries in its comments.
   * Record and OS agree perfectly — and the group belongs to somebody else,
   * because the target is a MEMBER of it rather than its leader. That is
   * exactly the shape of a supervisor sharing the launching shell's group, and
   * `-pgid` would have reached the shell and every one of its children. In the
   * historical case that shell was the test runner, and it died.
   *
   * Fails if: the leadership condition is dropped — agreement between two
   * numbers that are both wrong is not confirmation.
   */
  test("a group the target does not LEAD is refused even when the record agrees", async () => {
    const h = harness();
    h.table.set(TARGET.pid, TARGET.started);
    h.groups.set(TARGET.pid, 55); // a member of 55, not its leader
    expect(await confirmGroup(TARGET, 55, h.ops)).toEqual({ ok: false, why: "not_led" });
    expect(await signalIfSame(TARGET, "SIGKILL", { pgid: 55, ops: h.ops })).toBe(
      "group_unconfirmed",
    );
    expect(h.signals).toEqual([]);
  });

  /**
   * The capture-failed sentinels. `supervisor/index.ts` records `0` when `ps`
   * could not tell it its own group and `launchDetached` returns `-1`; neither
   * is a group.
   *
   * The load-bearing half is that it does NOT silently narrow to the leader
   * pid. The caller asked for a group signal; delivering a different, narrower
   * action and reporting it as the requested one is the collapse this whole
   * criterion exists to prevent.
   *
   * Fails if: a non-positive pgid degrades to `target.pid` again.
   */
  test("a capture-failed group signals nothing at all, and does not narrow to the pid", async () => {
    for (const sentinel of [0, -1]) {
      const h = harness();
      h.alive();
      expect(await confirmGroup(TARGET, sentinel, h.ops)).toEqual({ ok: false, why: "unrecorded" });
      expect(await signalIfSame(TARGET, "SIGKILL", { pgid: sentinel, ops: h.ops })).toBe(
        "group_unconfirmed",
      );
      expect(h.signals).toEqual([]);
    }
  });

  /**
   * `null` is the OTHER meaning of "no group", and it is not the same one: it
   * is a caller DECLARING that this rung addresses the validated leader and
   * nothing else. `down`'s daemon rung means exactly this, because
   * `daemon.pid` records no group to get wrong.
   *
   * Fails if: the two meanings are collapsed — either the daemon rung stops
   * being able to signal at all, or a capture-failed sentinel starts being
   * treated as a deliberate leader-only rung.
   */
  test("no group requested addresses the validated leader alone", async () => {
    const h = harness();
    h.alive();
    expect(await signalIfSame(TARGET, "SIGTERM", { pgid: null, ops: h.ops })).toBe("signalled");
    expect(await signalIfSame(TARGET, "SIGTERM", { ops: h.ops })).toBe("signalled");
    expect(h.signals).toEqual([
      { pid: TARGET.pid, sig: "SIGTERM" },
      { pid: TARGET.pid, sig: "SIGTERM" },
    ]);
  });

  /**
   * The leader dying between the identity read and the group read is the same
   * `gone` the ESRCH case is, arriving one call later. Reporting it as a group
   * refusal would fail a `down` that has nothing left to do.
   *
   * THE FIXTURE HAS TO MOVE THE WORLD, which the version of this test that
   * stood here until now did not. It set the target alive in the identity
   * table and merely absent from the GROUP table, and called that "a pid that
   * died in between" — but a pid that died is absent from BOTH. What it
   * actually described was a group read that came back empty about a process
   * still running, which is `read_failed` (below), not `gone`. It passed only
   * because those two facts used to collapse into the same answer.
   *
   * Fails if: a vanished target reads as an unconfirmed group.
   */
  test("a leader that really vanishes between the two reads is gone, not unconfirmed", async () => {
    const h = harness();
    h.alive();
    // The group read is where the world moves: the leader exits inside it, so
    // `ps` finds no group AND the identity is gone by the time it is asked.
    const vanishing: ProcessOps = {
      ...h.ops,
      groupId() {
        h.table.delete(TARGET.pid);
        h.groups.delete(TARGET.pid);
        return Promise.resolve(null);
      },
    };
    expect(await confirmGroup(TARGET, TARGET.pid, vanishing)).toEqual({ ok: false, why: "gone" });

    h.alive(); // wind the fixture back for the signalling pass
    expect(await signalIfSame(TARGET, "SIGKILL", { pgid: TARGET.pid, ops: vanishing })).toBe("gone");
    expect(h.signals).toEqual([]);
  });

  /**
   * THE F4 SPLIT. `ps` produced no group and the process is STILL THERE, so
   * what failed is the READ, not the process.
   *
   * This is far past a naming quibble. `down` maps a `gone` group verdict to
   * the one anchor answer that reports `stopped: true`, calls `reapContainer()`
   * (`docker rm -f`) and makes the worker prunable. A transient `ps` failure
   * against a live supervisor therefore reported it stopped, destroyed its
   * container and let `--prune` delete the checkout it was still writing to.
   * Unknown IDENTITY already refused; unknown GROUP-because-the-read-failed
   * declared success and deleted.
   *
   * Fails if: a failed read is called `gone` again. The `group_unconfirmed`
   * assertion is the one that keeps `down` from reporting a stop.
   */
  test("a silent group read on a process that is still there is a failed read", async () => {
    const h = harness();
    h.alive();
    h.groups.delete(TARGET.pid); // `ps` says nothing about the group…
    // …while the identity still holds, so the process is demonstrably alive.
    expect(await confirmGroup(TARGET, TARGET.pid, h.ops)).toEqual({
      ok: false,
      why: "read_failed",
    });
    expect(await signalIfSame(TARGET, "SIGKILL", { pgid: TARGET.pid, ops: h.ops })).toBe(
      "group_unconfirmed",
    );
    expect(h.signals).toEqual([]);
  });

  /**
   * The other half of the split: `ps` failed LOUDLY rather than silently — it
   * could not be run, or answered with something that is not a group.
   * `processGroupId` throws for those, and a thrown read is never a dead
   * process.
   *
   * Fails if: the throw escapes (a failed `ps` would crash a `down` that still
   * has other workers to stop) or is swallowed into `gone`.
   */
  test("a group read that throws is refused, and the throw does not escape", async () => {
    const h = harness();
    h.alive();
    const broken: ProcessOps = {
      ...h.ops,
      groupId() {
        return Promise.reject(new GroupReadError(TARGET.pid, "Resource temporarily unavailable"));
      },
    };
    expect(await confirmGroup(TARGET, TARGET.pid, broken)).toEqual({
      ok: false,
      why: "read_failed",
    });
    expect(await signalIfSame(TARGET, "SIGKILL", { pgid: TARGET.pid, ops: broken })).toBe(
      "group_unconfirmed",
    );
    expect(h.signals).toEqual([]);
  });

  /**
   * The refusal has to survive the LADDER, not just the primitive. A reaper
   * that climbed on through a failed read would reach SIGKILL against a group
   * nothing ever vouched for.
   *
   * Fails if: `read_failed` reaches `runKillLadder` as anything but
   * `group_unconfirmed`. `already_gone` and `terminated` would both report a
   * stop that never happened, and since F1 both of those authorise
   * `docker rm -f` and deregistration.
   */
  test("runKillLadder reports group_unconfirmed for a failed read, and signals nothing", async () => {
    const h = harness();
    h.alive();
    const broken: ProcessOps = {
      ...h.ops,
      groupId() {
        return Promise.reject(new GroupReadError(TARGET.pid, "Resource temporarily unavailable"));
      },
    };
    const outcome = await runKillLadder({
      target: TARGET,
      pgid: TARGET.pid,
      abort: null,
      dead: () => Promise.resolve(false),
      ...FAST,
      ops: broken,
      now: h.now,
      sleep: h.sleep,
    });
    expect(outcome).toBe("group_unconfirmed");
    expect(h.signals).toEqual([]);
  });

  /**
   * Every rung, not the top one. The group is re-confirmed before EVERY
   * signal, so a group that stops being ours part-way through the climb stops
   * being signalled part-way through the climb.
   *
   * Fails if: the confirmation is hoisted out of `signalIfSame` and computed
   * once — the SIGKILL below would be delivered to a group the OS had already
   * stopped agreeing about.
   */
  test("the group is re-confirmed at every rung, not carried forward", async () => {
    const h = harness();
    h.alive();
    expect(await signalIfSame(TARGET, "SIGTERM", { pgid: TARGET.pid, ops: h.ops })).toBe(
      "signalled",
    );
    // The world moves: the target is still itself, and no longer leads 100.
    h.groups.set(TARGET.pid, 55);
    expect(await signalIfSame(TARGET, "SIGKILL", { pgid: TARGET.pid, ops: h.ops })).toBe(
      "group_unconfirmed",
    );
    expect(h.signals).toEqual([{ pid: -TARGET.pid, sig: "SIGTERM" }]);
  });

  /**
   * The ladder's answer for the same fact. `group_unconfirmed` is NOT one of
   * the outcomes that mean the target is gone — the reaper must not record a
   * live supervisor as reaped because the group it was asked to signal could
   * not be vouched for.
   *
   * Fails if: an unconfirmable group returns `already_gone` or `terminated` —
   * either would report a stop that never happened.
   */
  test("runKillLadder reports group_unconfirmed rather than climbing", async () => {
    const h = harness();
    h.table.set(TARGET.pid, TARGET.started);
    h.groups.set(TARGET.pid, 55);
    const outcome = await runKillLadder({
      target: TARGET,
      pgid: 55,
      abort: null,
      dead: () => Promise.resolve(false),
      ...FAST,
      ops: h.ops,
      now: h.now,
      sleep: h.sleep,
    });
    expect(outcome).toBe("group_unconfirmed");
    expect(h.signals).toEqual([]);
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
    // Alive and leading its own group, which is what a detached supervisor is
    // and what `confirmGroup` requires before any rung may address `-pgid`.
    h.alive();
    let aborts = 0;
    const outcome = await runKillLadder({
      target: TARGET,
      pgid: TARGET.pid,
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
      { pid: -TARGET.pid, sig: "SIGTERM" },
      { pid: -TARGET.pid, sig: "SIGKILL" },
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
      groupId: h.ops.groupId,
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
