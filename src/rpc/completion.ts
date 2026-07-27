/**
 * Completion detection (SRD §7.4) — the load-bearing piece.
 *
 * `agent_settled` does not exist in Pi 0.79.6. v1.1's normative rule named an
 * event that never arrives; a fleet built on it would have hung on `wait`
 * forever, on every task. A task is complete for its epoch when ALL of:
 *
 *   1. `agent_end` received with `willRetry === false`;
 *   2. no retry pending — no outstanding `auto_retry_start`, no unfinished
 *      `summarization_retry_scheduled`;
 *   3. `queue_update` shows `steering[]` and `followUp[]` both empty;
 *   4. a correlated `get_state` reports `isStreaming: false` and
 *      `pendingMessageCount: 0`.
 *
 * Two hardenings beyond the SRD text, both from review:
 *
 * - **Probe validity is a generation token, not a prayer.** Any activity event
 *   between issuing `get_state` and acting on its response invalidates the
 *   probe. Without this, a `queue_update` with a non-empty `steering[]`
 *   landing between the response and the settle decision would be ignored and
 *   the epoch declared complete while output is still coming.
 *
 * - **One quiet sample proves nothing.** `isStreaming:false` also means "idle
 *   between a tool call and the next turn", and `pendingMessageCount:0` at two
 *   instants says nothing about the interval between them (ABA). Confirmation
 *   therefore requires TWO correlated reads under one unbroken generation
 *   token, with any monotonic counter the state exposes equal across them.
 */

import type { RpcEvent, RpcSessionState } from "../contracts.ts";

/** Events that indicate the agent moved — each invalidates any open probe. */
const ACTIVITY_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "compaction_start",
  "compaction_end",
]);

export class CompletionTracker {
  #endedClean = false;
  #retriesOutstanding = 0;
  #summarizationsOutstanding = 0;
  /** Queues start empty: before any `queue_update`, nothing has been queued. */
  #queueEmpty = true;
  #generation = 0;

  /** Fresh state for a new epoch. Nothing from a prior turn may carry over. */
  reset(): void {
    this.#endedClean = false;
    this.#retriesOutstanding = 0;
    this.#summarizationsOutstanding = 0;
    this.#queueEmpty = true;
    this.#generation++;
  }

  observe(event: RpcEvent): void {
    switch (event.type) {
      case "agent_start":
        // A new turn: whatever end we saw is no longer terminal.
        this.#endedClean = false;
        break;
      case "agent_end":
        // The discriminator (SRD §7.4): willRetry:true means Pi itself will
        // retry — this end is NOT terminal and must not become one (ISC-82).
        this.#endedClean = (event as { willRetry?: unknown }).willRetry === false;
        break;
      case "auto_retry_start":
        this.#retriesOutstanding++;
        this.#endedClean = false;
        break;
      case "auto_retry_end":
        this.#retriesOutstanding = Math.max(0, this.#retriesOutstanding - 1);
        break;
      case "summarization_retry_scheduled":
        this.#summarizationsOutstanding++;
        break;
      case "summarization_retry_finished":
        this.#summarizationsOutstanding = Math.max(0, this.#summarizationsOutstanding - 1);
        break;
      case "queue_update": {
        const steering = (event as { steering?: unknown[] }).steering ?? [];
        const followUp = (event as { followUp?: unknown[] }).followUp ?? [];
        this.#queueEmpty = steering.length === 0 && followUp.length === 0;
        break;
      }
      default:
        break;
    }

    // Any activity invalidates an open probe. An empty queue_update is the one
    // exception: it reports quiet, it does not create it.
    if (event.type === "queue_update") {
      if (!this.#queueEmpty) this.#generation++;
    } else if (ACTIVITY_EVENTS.has(event.type)) {
      this.#generation++;
    }
  }

  /** Conditions 1–3. When true, the caller should issue correlated `get_state`s. */
  get eligible(): boolean {
    return (
      this.#endedClean &&
      this.#retriesOutstanding === 0 &&
      this.#summarizationsOutstanding === 0 &&
      this.#queueEmpty
    );
  }

  /**
   * Capture a probe token. `confirm` only accepts states read while this token
   * is still current — any activity in between makes the samples worthless.
   */
  beginProbe(): number {
    return this.#generation;
  }

  /**
   * Condition 4, doubled. True only when nothing moved since `beginProbe`,
   * conditions 1–3 still hold, both samples are quiet, and every monotonic
   * counter both samples expose is equal across them.
   */
  confirm(token: number, first: RpcSessionState, second: RpcSessionState): boolean {
    if (token !== this.#generation) return false;
    if (!this.eligible) return false;
    if (first.isStreaming !== false || second.isStreaming !== false) return false;
    if (first.pendingMessageCount !== 0 || second.pendingMessageCount !== 0) return false;
    return countersEqual(first, second);
  }
}

/**
 * Monotonic counters the state may expose. Real Pi and the double differ in
 * which they carry; whatever is present in both samples must not have moved.
 */
const MONOTONIC_FIELDS = ["turnsStarted", "messagesConsumed", "eventCount"] as const;

function countersEqual(a: RpcSessionState, b: RpcSessionState): boolean {
  for (const f of MONOTONIC_FIELDS) {
    const av = (a as Record<string, unknown>)[f];
    const bv = (b as Record<string, unknown>)[f];
    if (typeof av === "number" && typeof bv === "number" && av !== bv) return false;
  }
  return true;
}
