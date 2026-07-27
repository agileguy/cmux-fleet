/**
 * The one clock every deadline, stall timer and budget window reads.
 *
 * `Date.now()` is wall clock. It jumps: NTP steps it, the host suspends and
 * resumes, a VM is paused, someone changes the timezone database. A deadline
 * computed as `Date.now() + 1500_000` fires early or late by exactly that jump,
 * and on a laptop that sleeps mid-run — which is the normal case here — it
 * fires the moment the lid opens, aborting a task that had barely started.
 *
 * `performance.now()` is monotonic: it counts forward from an arbitrary origin
 * and is unaffected by any of that. It is therefore the only correct source for
 * an *elapsed* measurement, and the only thing `Deadline` and `Stopwatch` read.
 *
 * Wall clock still has one legitimate use: TIMESTAMPS, the human-readable `ts`
 * on a ledger row or a settled record. Those are labels, never subtracted from
 * each other to decide anything. `isoNow()` exists so that use is explicit and
 * greppable, and so `Date.now()` appearing anywhere in a timing path is
 * unambiguously a bug (ISC-155).
 */

/** Monotonic milliseconds since an arbitrary origin. Never wall clock. */
export function monotonicMs(): number {
  return performance.now();
}

/** An ISO-8601 timestamp for LABELLING only — never for elapsed time. */
export function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Elapsed time from a fixed point, on the monotonic clock.
 *
 * Moved here from `rpc/client.ts` so the clock has one home. It was defined
 * beside the RPC transport, which meant `wait`, `down` and the supervisor all
 * imported a timing primitive from a protocol module — and a second one would
 * inevitably have been written for the Phase 2 budget and reaper work.
 * `rpc/client.ts` re-exports it, so existing importers are unaffected.
 *
 * `restart()` is the stall detector's legitimate need: the stall window resets
 * when an event arrives. Nothing else should call it — restarting a *deadline*
 * is how a bounded task becomes unbounded.
 */
export class Stopwatch {
  readonly #now: () => number;
  #start: number;

  constructor(now: () => number = monotonicMs) {
    this.#now = now;
    this.#start = now();
  }

  elapsedMs(): number {
    return this.#now() - this.#start;
  }

  restart(): void {
    this.#start = this.#now();
  }
}

/**
 * A budget with an expiry, on the monotonic clock.
 *
 * `remainingMs` clamps at zero rather than going negative, so callers can pass
 * it straight to `setTimeout` without a guard — a negative timeout fires
 * immediately on some runtimes and never on others, and that difference has
 * been the whole bug more than once.
 */
export class Deadline {
  readonly #expiresAt: number;

  constructor(
    readonly budgetMs: number,
    private readonly now: () => number = monotonicMs,
  ) {
    this.#expiresAt = now() + budgetMs;
  }

  /** Milliseconds left, floored at 0. */
  remainingMs(): number {
    return Math.max(0, this.#expiresAt - this.now());
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  /**
   * A deadline for a nested operation: the smaller of `ms` and what is left.
   *
   * A sub-operation must never be allowed to outlive its parent's budget —
   * that is how a 25-minute task deadline is silently extended by a 30-second
   * probe that itself waits 30 seconds.
   */
  boundedBy(ms: number): number {
    return Math.min(ms, this.remainingMs());
  }
}
