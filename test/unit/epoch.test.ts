/**
 * Epoch fencing (SRD §7.5, corrected to stream-offset attribution).
 *
 * The central test here is the §7.5 interleaving in the form where the ONLY
 * thing distinguishing the correct answer from the wrong one is the stream
 * offset: two byte-identical terminal events, one at a seq at-or-below the new
 * epoch's prompt-ack seq, one above it. Wall-clock arrival order cannot tell
 * them apart; the offset can.
 */

import { describe, expect, test } from "bun:test";
import { EpochManager, MalformedEpochError, emptyFence } from "../../src/rpc/epoch.ts";
import { EXIT, isExitCoded } from "../../src/contracts.ts";

const now = "2026-07-26T14:00:00.000Z";

describe("EpochManager — allocation", () => {
  test("first dispatch gets epoch 1; a live epoch makes the worker busy", () => {
    const em = new EpochManager();
    const d = em.allocate("T-001", "a1", null);
    expect(d).toEqual({ ok: true, epoch: 1, replayed: false });

    const busy = em.allocate("T-002", "a2", null);
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.reason).toBe("busy");
  });

  test("settle closes the epoch and the next allocation advances", () => {
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    const settled = em.settle("success", now);
    expect(settled).toEqual({ task_id: "T-001", attempt_id: "a1", epoch: 1, verdict: "success" });

    const d2 = em.allocate("T-002", "a2", null);
    expect(d2).toEqual({ ok: true, epoch: 2, replayed: false });
  });

  // ISC-85: re-dispatching a completed (worker, task_id, epoch) is a no-op.
  test("a completed task_id is rejected with already_completed and its verdict", () => {
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    em.settle("aborted", now);

    const again = em.allocate("T-001", "a2", null);
    expect(again).toEqual({ ok: false, reason: "already_completed", epoch: 1, verdict: "aborted" });
  });

  test("a requested epoch that is already completed reports already_completed", () => {
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    em.settle("success", now);

    const d = em.allocate("T-002", "a2", 1);
    expect(d).toEqual({ ok: false, reason: "already_completed", epoch: 1, verdict: "success" });
  });

  test("a requested epoch that skips ahead is stale", () => {
    const em = new EpochManager();
    const d = em.allocate("T-001", "a1", 7);
    expect(d).toEqual({ ok: false, reason: "stale_epoch", requested: 7, next: 1 });
  });
});

/**
 * ISC-217. An epoch is a whole non-negative counter. A negative or fractional
 * one is not a re-dispatch request that happens to be wrong — it is a value
 * that can never have named an epoch, so answering it with a normal decision
 * hides the author's mistake behind ordinary-looking behaviour: `-1` was
 * silently normalized to "allocate a fresh epoch" (so a re-dispatch meant to
 * replay ran the task AGAIN), and `1.5` came back `stale_epoch`, which reads as
 * "someone else advanced the fence" and sends the reader after the wrong bug.
 */
describe("EpochManager — a malformed epoch is named, not normalized (ISC-217)", () => {
  test("a negative requested epoch throws MalformedEpochError", () => {
    const em = new EpochManager();
    expect(() => em.allocate("T-001", "a1", -1)).toThrow(MalformedEpochError);
  });

  test("a fractional requested epoch throws MalformedEpochError", () => {
    const em = new EpochManager();
    expect(() => em.allocate("T-001", "a1", 1.5)).toThrow(MalformedEpochError);
  });

  test("the error names the offending value and is a diagnosed usage failure", () => {
    let caught: unknown;
    try {
      new EpochManager().allocate("T-001", "a1", -3);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedEpochError);
    expect((caught as MalformedEpochError).name).toBe("MalformedEpochError");
    expect((caught as MalformedEpochError).value).toBe(-3);
    expect((caught as Error).message).toContain("-3");
    // Diagnosed, so the CLI prints one line and exits 2 rather than reporting
    // an internal error (ISC-216) for a value the operator supplied.
    expect(isExitCoded(caught)).toBe(true);
    expect((caught as MalformedEpochError).exitCode).toBe(EXIT.USAGE);
  });

  test("a malformed epoch is refused even for an attempt that would replay", () => {
    // The replay lookup must not launder it: the request is unreadable before
    // it is anything else.
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    expect(() => em.allocate("T-001", "a1", -1)).toThrow(MalformedEpochError);
  });

  test("well-formed epochs are untouched: 0 allocates, whole positives request", () => {
    expect(new EpochManager().allocate("T-001", "a1", 0)).toEqual({
      ok: false,
      reason: "stale_epoch",
      requested: 0,
      next: 1,
    });
    expect(new EpochManager().allocate("T-001", "a1", 1)).toEqual({
      ok: true,
      epoch: 1,
      replayed: false,
    });
  });
});

describe("EpochManager — attempt idempotency", () => {
  test("the same (task_id, attempt_id) replays the original answer while live", () => {
    // Timeout → retry → the first dispatch actually landed. The caller must
    // get the SAME answer back, not already_completed or busy — it cannot
    // otherwise distinguish "I did it and lost the ack" from "someone else".
    const em = new EpochManager();
    const first = em.allocate("T-001", "a1", null);
    const retry = em.allocate("T-001", "a1", null);
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.epoch).toBe(first.epoch);
      expect(retry.replayed).toBe(true);
    }
  });

  test("the same attempt replays even after the task settled", () => {
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    em.settle("success", now);
    const retry = em.allocate("T-001", "a1", null);
    expect(retry).toEqual({ ok: true, epoch: 1, replayed: true });
  });

  test("a NEW attempt for a settled task is already_completed, not a replay", () => {
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    em.settle("success", now);
    const fresh = em.allocate("T-001", "a9", null);
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.reason).toBe("already_completed");
  });
});

describe("EpochManager — stream-offset fencing (the §7.5 interleaving)", () => {
  test("identical terminal events are told apart by stream offset alone", () => {
    const em = new EpochManager();

    // Epoch 1: dispatched, acked at seq 10, started at seq 11.
    em.allocate("T-004", "a1", null);
    em.noteAck(10);
    expect(em.bindStart(11)).toBe(true);

    // Deadline fires; abort issued (asynchronous). Before it lands, the turn
    // completes naturally — the supervisor reads that agent_end late, but its
    // STREAM POSITION is 12, inside epoch 1.
    em.noteAbortRequested();
    expect(em.attribute(12)).toBe("live");
    em.settle("aborted", now);

    // Epoch 2 for T-005: prompt acked at seq 20.
    const d2 = em.allocate("T-005", "a2", null);
    expect(d2.ok).toBe(true);
    em.noteAck(20);

    // The straggler duplicate of epoch 1's agent_end sits at seq 19 — read
    // AFTER epoch 2 was allocated, byte-identical to what epoch 2's own end
    // will look like. Offset ≤ ack_seq(2) ⇒ prior epoch, NOT epoch 2.
    expect(em.attribute(19)).toBe("prior");
    expect(em.bindStart(19)).toBe(false); // cannot open epoch 2's window either
    expect(em.windowOpen).toBe(false);

    // The SAME event shape at seq 21 — after the ack — is epoch 2's own.
    expect(em.bindStart(21)).toBe(true);
    expect(em.attribute(22)).toBe("live");
  });

  test("events before the prompt ack never count toward the live epoch", () => {
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    // Ack not yet arrived: nothing is attributable to this epoch.
    expect(em.attribute(5)).toBe("prior");
    expect(em.bindStart(5)).toBe(false);

    em.noteAck(6);
    expect(em.attribute(6)).toBe("prior"); // the ack itself is the fence post
    expect(em.attribute(7)).toBe("live");
  });

  test("with no live epoch every event is prior — nothing is silently dropped into a window", () => {
    const em = new EpochManager();
    expect(em.attribute(1)).toBe("prior");
    em.allocate("T-001", "a1", null);
    em.noteAck(2);
    em.bindStart(3);
    em.settle("success", now);
    // Post-settle stragglers: attributed to history, never a fresh window.
    expect(em.attribute(4)).toBe("prior");
    expect(em.windowOpen).toBe(false);
  });
});

describe("EpochManager — abort and timeout flags", () => {
  test("abort is recorded only against a live epoch", () => {
    const em = new EpochManager();
    expect(em.noteAbortRequested()).toBe(false);
    em.allocate("T-001", "a1", null);
    expect(em.noteAbortRequested()).toBe(true);
    expect(em.abortRequested).toBe(true);
  });

  test("settle with no live epoch is null, not an invented record", () => {
    const em = new EpochManager();
    expect(em.settle("success", now)).toBeNull();
  });
});

describe("EpochManager — durability across restart", () => {
  test("a restored manager resumes above the high-water-mark", () => {
    // Allocate-then-crash-then-restart must not re-issue the same epoch: the
    // snapshot is persisted BEFORE the prompt is sent, so the restart sees
    // epoch 1 as spent even though it never settled.
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    const snap = em.snapshot();

    const restored = new EpochManager(snap);
    // The crashed epoch is still live in the snapshot; fail it first, as the
    // restarting supervisor would.
    restored.settle("failed", now);
    const d = restored.allocate("T-002", "a2", null);
    expect(d).toEqual({ ok: true, epoch: 2, replayed: false });
  });

  test("attempt dedup survives the restart", () => {
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    const restored = new EpochManager(em.snapshot());
    const retry = restored.allocate("T-001", "a1", null);
    expect(retry).toEqual({ ok: true, epoch: 1, replayed: true });
  });

  test("snapshot is a copy, not a live reference", () => {
    const em = new EpochManager();
    em.allocate("T-001", "a1", null);
    const snap = em.snapshot();
    em.settle("success", now);
    expect(snap.live).not.toBeNull();
    expect(emptyFence().live).toBeNull();
  });
});
