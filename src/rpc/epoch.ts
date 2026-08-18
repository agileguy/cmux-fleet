/**
 * Epoch fencing (SRD §7.5), corrected to fence on STREAM OFFSET.
 *
 * The SRD's original rule — "terminal events arriving outside an open epoch
 * window are logged and discarded" — is not a causal order. A late `agent_end`
 * for epoch N arriving after N+1 opened is byte-identical to N+1's own: Pi
 * events carry no correlation id. Discard it and a real terminal event is
 * lost (N+1 hangs to timeout); accept it and N+1 reports complete having never
 * run — with N's real diff attached, so derived-facts adjudication *confirms*
 * the false success (the §7.5 interleaving).
 *
 * The fix exploits a fact the SRD did not use: events and responses arrive on
 * ONE ordered stdout stream, so there IS a happens-before relation. Pi acks a
 * `prompt` synchronously on receipt, before any of that epoch's output, so:
 *
 *     an event belongs to epoch N  ⟺  seq(event) > seq(N's prompt ack)
 *
 * Events at or below the ack seq are attributed to prior (settled) epochs and
 * recorded as such — never blindly discarded, never counted toward the live
 * epoch.
 *
 * Three more invariants, each with a failure behind it:
 *
 * - **The high-water-mark is persisted BEFORE the prompt is sent.** The
 *   allocator being "sole" is an assumption, not an invariant — a detached
 *   supervisor plus a CLI relaunch is two allocators. Allocate-then-crash-
 *   then-restart must not re-issue an epoch, so the caller writes the fence
 *   snapshot durably before dispatching (the worker side rejects `<=` its
 *   own high-water-mark as a second line of defence).
 *
 * - **Never advance until the previous epoch is quiesced** by the correlated
 *   double `get_state` (completion.ts). `allocate` refuses while an epoch is
 *   live, so at most one epoch is ever unsettled — which is what makes
 *   seq-based attribution unambiguous.
 *
 * - **Dispatch dedups on `(task_id, attempt_id)`, and replays the stored
 *   answer.** Timeout → retry → the first dispatch actually landed: returning
 *   `already_completed` would leave the caller unable to distinguish "someone
 *   else did it" from "I did it and lost the ack".
 */

import { EXIT, type Verdict } from "../contracts.ts";

/**
 * A requested `epoch` that could never have named an epoch.
 *
 * Epochs are a whole counter starting at 1, with 0 the documented "allocate one
 * for me" placeholder. A negative or fractional value is not a request that
 * happens to be wrong — it is unreadable, and answering it with an ordinary
 * decision hid the author's mistake behind ordinary behaviour: `-1` was
 * normalized to a FRESH ALLOCATION, so a re-dispatch meant to replay ran the
 * task a second time; `1.5` came back `stale_epoch`, which reads as a fence
 * someone else advanced and sends the reader after the wrong bug (ISC-217).
 *
 * It carries `exitCode` so the structural `ExitCoded` protocol (contracts.ts)
 * reports it as the usage error it is — one line and exit 2, rather than the
 * undiagnosed-internal code.
 */
export class MalformedEpochError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(readonly value: number) {
    super(`malformed epoch ${String(value)}: expected a whole number >= 0`);
    this.name = "MalformedEpochError";
  }
}

/** Throw `MalformedEpochError` unless `value` is a whole number >= 0. */
export function assertEpochWellFormed(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new MalformedEpochError(value);
}

export interface CompletedTask {
  task_id: string;
  attempt_id: string;
  epoch: number;
  verdict: Verdict;
  settled_at: string;
}

export type DispatchDecision =
  | { ok: true; epoch: number; replayed: boolean }
  | { ok: false; reason: "already_completed"; epoch: number; verdict: Verdict }
  | { ok: false; reason: "busy"; epoch: number }
  | { ok: false; reason: "stale_epoch"; requested: number; next: number };

/** Durable form of the fence — what `fence.json` holds (run/state.ts persists it). */
export interface FenceSnapshot {
  /** Highest epoch ever handed out. Restart resumes above it, never at it. */
  last_accepted_epoch: number;
  /** Stream seq of the live epoch's prompt ack; null before the ack arrives. */
  ack_seq: number | null;
  /** Highest stream seq observed, for post-restart forensics. */
  last_seq: number;
  live: {
    task_id: string;
    attempt_id: string;
    epoch: number;
    started: boolean;
    abort_requested: boolean;
    timed_out: boolean;
  } | null;
  completed: CompletedTask[];
  /** `(task_id, attempt_id)` -> the accepted epoch, for idempotent replay. */
  attempts: Record<string, number>;
}

export function emptyFence(): FenceSnapshot {
  return {
    last_accepted_epoch: 0,
    ack_seq: null,
    last_seq: 0,
    live: null,
    completed: [],
    attempts: {},
  };
}

/** Where a stream record lands relative to the fence. */
export type Attribution = "live" | "prior";

export interface Settled {
  task_id: string;
  attempt_id: string;
  epoch: number;
  verdict: Verdict;
}

export class EpochManager {
  #s: FenceSnapshot;

  constructor(restored: FenceSnapshot = emptyFence()) {
    this.#s = restored;
  }

  /** Serializable state. The caller persists this BEFORE acting on a decision. */
  snapshot(): FenceSnapshot {
    return structuredClone(this.#s);
  }

  get live(): FenceSnapshot["live"] {
    return this.#s.live;
  }

  /** Window open = live epoch bound to its first `agent_start`. */
  get windowOpen(): boolean {
    return this.#s.live !== null && this.#s.live.started;
  }

  /**
   * Decide a dispatch. Pure — no I/O. On `ok`, the caller must persist the
   * snapshot durably and only then send the prompt.
   */
  allocate(taskId: string, attemptId: string, requestedEpoch: number | null): DispatchDecision {
    // Before anything else, including the replay lookup: an unreadable request
    // must not be laundered into a decision by a path that never examines it.
    if (requestedEpoch !== null) assertEpochWellFormed(requestedEpoch);
    const key = attemptKey(taskId, attemptId);

    // Same attempt seen before: replay the original answer verbatim, whether
    // the task since completed or is still running.
    const prior = this.#s.attempts[key];
    if (prior !== undefined) return { ok: true, epoch: prior, replayed: true };

    const done = this.#s.completed.find((c) => c.task_id === taskId);
    if (done !== undefined) {
      return { ok: false, reason: "already_completed", epoch: done.epoch, verdict: done.verdict };
    }

    if (this.#s.live !== null) {
      return { ok: false, reason: "busy", epoch: this.#s.live.epoch };
    }

    const next = this.#s.last_accepted_epoch + 1;
    if (requestedEpoch !== null && requestedEpoch !== next) {
      const completedEpoch = this.#s.completed.find((c) => c.epoch === requestedEpoch);
      if (completedEpoch !== undefined) {
        return {
          ok: false,
          reason: "already_completed",
          epoch: completedEpoch.epoch,
          verdict: completedEpoch.verdict,
        };
      }
      return { ok: false, reason: "stale_epoch", requested: requestedEpoch, next };
    }

    this.#s.last_accepted_epoch = next;
    this.#s.ack_seq = null;
    this.#s.live = {
      task_id: taskId,
      attempt_id: attemptId,
      epoch: next,
      started: false,
      abort_requested: false,
      timed_out: false,
    };
    this.#s.attempts[key] = next;
    return { ok: true, epoch: next, replayed: false };
  }

  /**
   * Record the stream seq of the live epoch's prompt ack — the fence post.
   *
   * First write wins for a given epoch. The seq is recorded synchronously as
   * the ack line is parsed; a later call carrying the same seq is the awaited
   * fallback path and must not move the fence, and a later call carrying a
   * HIGHER seq would silently orphan every event in between.
   */
  noteAck(seq: number): void {
    if (this.#s.live === null) return;
    this.#s.last_seq = Math.max(this.#s.last_seq, seq);
    if (this.#s.ack_seq !== null) return;
    this.#s.ack_seq = seq;
  }

  /**
   * Attribute a stream record. `live` only when a live epoch exists, its ack
   * seq is known, and the record arrived strictly after it. Everything else is
   * `prior`: it happened before this epoch's prompt was acknowledged, so it
   * cannot be this epoch's output.
   */
  attribute(seq: number): Attribution {
    this.#s.last_seq = Math.max(this.#s.last_seq, seq);
    const live = this.#s.live;
    if (live !== null && this.#s.ack_seq !== null && seq > this.#s.ack_seq) return "live";
    return "prior";
  }

  /** Epoch start binds to the first `agent_start` after dispatch (SRD §7.5). */
  bindStart(seq: number): boolean {
    if (this.#s.live === null || this.#s.live.started) return false;
    if (this.attribute(seq) !== "live") return false;
    this.#s.live.started = true;
    return true;
  }

  noteAbortRequested(): boolean {
    if (this.#s.live === null) return false;
    this.#s.live.abort_requested = true;
    return true;
  }

  get abortRequested(): boolean {
    return this.#s.live?.abort_requested ?? false;
  }

  noteTimedOut(): boolean {
    if (this.#s.live === null) return false;
    this.#s.live.timed_out = true;
    return true;
  }

  get timedOut(): boolean {
    return this.#s.live?.timed_out ?? false;
  }

  /**
   * Close the live epoch with a verdict. The supervisor's verdicts here are
   * `aborted`/`timed_out`/`failed`/`success`; downgrades from derived facts
   * are the harvester's job, not ours (SRD §7.3).
   */
  settle(verdict: Verdict, settledAt: string): Settled | null {
    const live = this.#s.live;
    if (live === null) return null;
    const record: CompletedTask = {
      task_id: live.task_id,
      attempt_id: live.attempt_id,
      epoch: live.epoch,
      verdict,
      settled_at: settledAt,
    };
    this.#s.completed.push(record);
    this.#s.live = null;
    this.#s.ack_seq = null;
    return {
      task_id: record.task_id,
      attempt_id: record.attempt_id,
      epoch: record.epoch,
      verdict,
    };
  }
}

function attemptKey(taskId: string, attemptId: string): string {
  return `${taskId}\0${attemptId}`;
}
