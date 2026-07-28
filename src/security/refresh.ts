/**
 * The token refresh loop (SRD §5.8, §12.4; acceptance 14; ISC-155).
 *
 * A `token`-mode worker holds a ~1h access token; the supervisor re-mints and
 * re-injects it every `token_refresh` (default 45m), leaving 15 minutes of
 * margin before the old token dies mid-`kubectl`.
 *
 * The scheduling clock is the subtle part. `expires_at` is a wall-clock LABEL
 * from the issuer — it is what Google said, and it is recorded so a probe can
 * answer "was this refreshed before it expired". It is NEVER subtracted from a
 * local clock to decide when to refresh: this fleet runs on a laptop that
 * sleeps mid-run, and a wall-clock comparison would wake to find every token
 * simultaneously "fresh" (clock stepped back) or "dead" (lid closed an hour) —
 * either way scheduling from a lie. So the loop measures elapsed time since
 * the last injection on the MONOTONIC clock and refreshes when `token_refresh`
 * of real process time has passed (ISC-155). After a suspend the elapsed
 * reading is small, the token genuinely may be stale — and the first cloud
 * call failing is recoverable, whereas a refresh storm or a never-refresh is
 * not. The monotonic answer degrades safely; the wall answer degrades weirdly.
 *
 * Failure is the other half (SRD §12.4: the grant is never silent). A failed
 * mint or a failed exec must not quietly leave a dead token in the container —
 * the worker would then fail its TASK with a confusing cloud error, and the
 * operator would debug the task instead of the credential. Every failure is
 * reported through `onFailure`, visible in `status()`, and retried on a short
 * interval rather than waiting out the full 45m with a corpse in the tmpfs.
 */

import type { AdcMode, CredentialInjection } from "../contracts.ts";
import { isoNow, monotonicMs } from "../util/clock.ts";
import {
  recordInjection,
  tokenModeMaterials,
  type Minter,
} from "./adc.ts";

/** Post-failure retry interval: short enough to matter inside the 15m margin. */
export const DEFAULT_RETRY_S = 60;

/** A refresh that could not complete, shaped for the supervisor to surface. */
export interface RefreshFailure {
  worker: string;
  /** The generation that WOULD have been injected had it worked. */
  generation_attempted: number;
  error: string;
  /** Wall-clock label for the human reading the report — never scheduled from. */
  at: string;
}

export type RefreshOutcome =
  | { status: "injected"; record: CredentialInjection }
  | { status: "failed"; failure: RefreshFailure }
  | { status: "not_due"; dueInMs: number };

export interface TokenRefresherOpts {
  worker: string;
  mode: AdcMode;
  /** `cloud.token_refresh` from config, in seconds (schema-normalized). */
  intervalS: number;
  mint: Minter;
  /** Writes the token into the running container (adc.injectToken, bound). */
  inject: (token: string) => Promise<void>;
  /** Supervisor persists the record (which carries no token) to the run dir. */
  onInjected: (record: CredentialInjection) => void;
  /** Supervisor surfaces the failure — status line, log, report. */
  onFailure: (failure: RefreshFailure) => void;
  /** Monotonic clock, injectable for tests. NEVER Date.now (ISC-155). */
  now?: () => number;
  retryS?: number;
}

export class TokenRefresher {
  readonly #opts: TokenRefresherOpts;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #retryMs: number;

  /** Which injection is next; 0 is the initial one (schema: generation 0). */
  #generation = 0;
  /** The single in-flight attempt, so concurrent callers share it. */
  #inFlight: Promise<RefreshOutcome> | null = null;
  /** Monotonic ms of the last SUCCESSFUL injection; null before the first. */
  #lastInjectedMono: number | null = null;
  /** Monotonic ms of the last attempt, success or not — retry schedules here. */
  #lastAttemptMono: number | null = null;
  #lastFailure: RefreshFailure | null = null;
  #consecutiveFailures = 0;

  constructor(opts: TokenRefresherOpts) {
    this.#opts = opts;
    this.#now = opts.now ?? monotonicMs;
    this.#intervalMs = opts.intervalS * 1000;
    this.#retryMs = (opts.retryS ?? DEFAULT_RETRY_S) * 1000;
  }

  /**
   * Milliseconds until the next injection is due, on the monotonic clock.
   * 0 before the first injection (a worker with no token yet is always due),
   * `retryS` after a failure, `intervalS` after a success. No branch here
   * reads a wall clock or an `expires_at` — that is the ISC-155 invariant.
   */
  dueInMs(): number {
    if (this.#lastInjectedMono === null && this.#lastAttemptMono === null) return 0;
    if (this.#consecutiveFailures > 0) {
      const sinceAttempt = this.#now() - (this.#lastAttemptMono ?? 0);
      return Math.max(0, this.#retryMs - sinceAttempt);
    }
    const sinceInject = this.#now() - (this.#lastInjectedMono ?? 0);
    return Math.max(0, this.#intervalMs - sinceInject);
  }

  /**
   * Mint and inject now, unconditionally. The initial injection calls this.
   *
   * Concurrent callers share ONE attempt rather than racing. `#generation` is
   * read at the top, survives two `await`s, and is incremented at the bottom,
   * so two overlapping calls both record the same generation and both inject —
   * the same shape as the overlapping-scan defect that aimed two kill ladders
   * at one pid. Only `run()` calls this today, sequentially, so it is not
   * reachable yet; a guard added before the second caller exists costs
   * nothing, and after it exists costs a debugging session.
   */
  async injectNow(): Promise<RefreshOutcome> {
    if (this.#inFlight !== null) return this.#inFlight;
    const attempt = this.#injectNowUnguarded().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = attempt;
    return attempt;
  }

  async #injectNowUnguarded(): Promise<RefreshOutcome> {
    this.#lastAttemptMono = this.#now();
    try {
      const minted = await this.#opts.mint();
      await this.#opts.inject(minted.token);
      const record = recordInjection({
        worker: this.#opts.worker,
        mode: this.#opts.mode,
        identity: minted.identity,
        expiresAt: minted.expiresAt,
        generation: this.#generation,
        // The record's refresh_token_absent is proven against what actually
        // crossed: the pointer env and this token file. Not assumed.
        materials: tokenModeMaterials(minted.token),
        now: this.#now,
      });
      this.#generation += 1;
      this.#lastInjectedMono = this.#lastAttemptMono;
      this.#lastFailure = null;
      this.#consecutiveFailures = 0;
      // OUTSIDE the try that guards mint/inject, deliberately.
      //
      // By this point the token has already reached the container and the
      // generation counters have already advanced — the injection SUCCEEDED.
      // `onInjected` is the supervisor persisting the record to the run dir,
      // and EACCES/ENOSPC there is ordinary. Inside the try, that ordinary
      // failure was caught by the handler below and reported as
      // `status: "failed"` with `generation_attempted` naming a generation
      // that was never attempted — a healthy credential reported degraded,
      // the record for the generation that DID ship never written, and every
      // 60s retry burning another generation while lying the same way.
      //
      // A record we could not persist is a real problem, but it is a
      // different one from a credential we could not mint, and collapsing the
      // two makes the loud failure describe the wrong subsystem.
      try {
        this.#opts.onInjected(record);
      } catch (err) {
        const failure: RefreshFailure = {
          worker: this.#opts.worker,
          generation_attempted: this.#generation - 1,
          error: `token injected but its record could not be persisted: ${
            err instanceof Error ? err.message : String(err)
          }`,
          at: isoNow(),
        };
        this.#lastFailure = failure;
        this.#opts.onFailure(failure);
      }
      return { status: "injected", record };
    } catch (err) {
      // Report, remember, and keep the loop alive. Swallowing this — or
      // letting it throw out of a timer callback — is how a worker silently
      // loses cloud access and fails its task an hour later (§12.4).
      const failure: RefreshFailure = {
        worker: this.#opts.worker,
        generation_attempted: this.#generation,
        error: err instanceof Error ? err.message : String(err),
        at: isoNow(),
      };
      this.#lastFailure = failure;
      this.#consecutiveFailures += 1;
      this.#opts.onFailure(failure);
      return { status: "failed", failure };
    }
  }

  /** Inject if due, otherwise report how long until due. The loop's step. */
  async tick(): Promise<RefreshOutcome> {
    const due = this.dueInMs();
    if (due > 0) return { status: "not_due", dueInMs: due };
    return this.injectNow();
  }

  /** Supervisor-visible state: a degraded credential is never a quiet one. */
  status(): {
    generation: number;
    degraded: boolean;
    consecutiveFailures: number;
    lastFailure: RefreshFailure | null;
  } {
    return {
      generation: this.#generation,
      degraded: this.#consecutiveFailures > 0,
      consecutiveFailures: this.#consecutiveFailures,
      lastFailure: this.#lastFailure,
    };
  }

  /**
   * Production driver: tick, sleep until due, repeat, until aborted. Tests
   * never call this — they drive `tick()` with a fake clock, because a loop
   * that sleeps real minutes cannot be probed and a mocked sleep proves only
   * the mock. The 250ms floor keeps a pathological clock from busy-spinning.
   */
  async run(
    signal: AbortSignal,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ): Promise<void> {
    while (!signal.aborted) {
      // Raced against the signal, not merely awaited. `tick()` can block on a
      // wedged `gcloud` mint for as long as that process hangs, and an abort
      // arriving mid-attempt was not observed until it returned — so a
      // shutdown awaiting `run()` hung with it. The attempt itself is NOT
      // cancelled (nothing here can safely unwind a half-finished injection);
      // `run` simply stops waiting on it, and the in-flight guard means a
      // later caller joins that same attempt rather than starting a second.
      await Promise.race([this.tick(), aborted(signal)]);
      if (signal.aborted) return;
      // The signal is passed INTO the sleep, not merely re-checked after it.
      // The loop condition alone means abort is observed no sooner than the
      // next wake — at the documented 45-minute interval, `abort()` returned
      // immediately while `run()` was still pending three seconds later and
      // the process would not exit at all.
      await sleep(Math.max(this.dueInMs(), 250), signal);
    }
  }
}

/**
 * Sleep that both wakes early on abort and never keeps the process alive.
 *
 * Two separate defects, one line apart. A bare `setTimeout` resolves only on
 * expiry, so an aborted refresher went on sleeping for the rest of its
 * interval; and an un-`unref`'d timer is itself a reason for the event loop to
 * stay open, so the process outlived every piece of work it had — observed
 * needing SIGKILL after a 3s probe with a 45-minute timer pending.
 *
 * `unref` is the fix for the second and NOT for the first: an unref'd timer
 * still delays whatever awaits it, it just stops being a reason to stay
 * running. Both are needed, and the listener is removed on either path so a
 * long-lived signal does not accumulate one per tick.
 */
/**
 * Resolves when `signal` aborts, and never keeps the process alive by itself.
 * Used to race a hung attempt so `run()` can return on shutdown.
 */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}
