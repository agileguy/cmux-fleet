/**
 * Budget accounting and admission control (ISC-114, ISC-115, ISC-193).
 *
 * Tokens are the primary axis; dollars are advisory. Every model here is local
 * (SRD §5.9), local models have no price table, and `get_session_stats.cost`
 * is therefore 0 for the entire life of every run. A budget that watches
 * dollars never trips locally — it looks like a safety mechanism and is
 * actually a comment. ISC-115 pins the inversion: the ceiling must halt a run
 * whose reported cost is 0 throughout, which only a token ceiling can do.
 *
 * The second problem is that admission and accounting are not simultaneous.
 * Usage is learned when a task settles (or on the ~60s stats poll), so a task
 * admitted at 99% of the ceiling would run to completion and blow straight
 * through it — F24, the overshoot-between-polls failure. Admission therefore
 * subtracts a RESERVATION up front, held in `BudgetStateSchema.reserved` keyed
 * by task id, and settle reconciles the hold against actuals and releases it.
 * The reservation is also the admission slot: a task id present in `reserved`
 * is in flight, which is how `max_concurrent` is enforced (SRD §9.3) and how
 * the stall policy in `safety/kill.ts` tells a QUEUED worker from a WEDGED one
 * (ISC-110) — queued workers hold no reservation and their event silence is
 * expected, not pathological.
 *
 * Crossing the ceiling halts *dispatch*, not the world: `halted_at` is set
 * once, every later admission is refused `budget_halted`, and the run exits 5
 * — but artifacts are still harvested (ISC-114). That is why nothing in this
 * module throws when the ceiling is crossed. `settle` reports the trip and
 * keeps accounting; the CLI raises `BudgetCeilingError` AFTER harvest, so a
 * budget trip cannot destroy the evidence of what the tokens bought. This
 * module is `EXIT.BUDGET`'s producer — before it, the code sat in the severity
 * ladder with nothing anywhere able to yield it (ISC-193).
 *
 * The class mutates a `BudgetState` and exposes `snapshot()` for the caller to
 * persist, the same shape `EpochManager` uses: decisions are pure state
 * transitions here, durability is the caller's problem, and the schema in
 * `contracts.ts` is the only shape — inventing a sibling would put two budget
 * vocabularies on one seam.
 *
 * No timing lives here. `halted_at` is an ISO LABEL (isoNow), never subtracted
 * from anything; deadlines and stall windows belong to `safety/kill.ts` on the
 * monotonic clock (ISC-146/155).
 */

import {
  BudgetStateSchema,
  EXIT,
  type AdmissionDecision,
  type BudgetState,
  type ExitCode,
  type ExitCoded,
} from "../contracts.ts";
import { isoNow } from "../util/clock.ts";

/** What a task actually spent, learned at settle from the session stats. */
export interface ActualUsage {
  tokens: number;
  /** Advisory. Always 0 for local models (SRD §5.9). */
  usd?: number;
}

/** Per-admission knobs, resolved by the caller from config (§6 `run.budget`). */
export interface AdmitOptions {
  /** Tokens held up front; reconciled and released at settle. */
  reserveTokens: number;
  /** In-flight cap, bounded by oMLX throughput, not pane count (F40). */
  maxConcurrent: number;
}

/**
 * A crossed ceiling, as a diagnosed failure the CLI can exit on.
 *
 * Structural `ExitCoded` rather than a subclass registry, per contracts.ts:
 * the entry point recognises any error carrying a numeric `exitCode`. Raised
 * by the CLI after harvest completes — never by `settle`, which must keep
 * accounting through the trip.
 */
export class BudgetCeilingError extends Error implements ExitCoded {
  readonly exitCode = EXIT.BUDGET;

  constructor(reason: string) {
    super(`budget ceiling crossed: ${reason}; dispatch halted, artifacts retained`);
    this.name = "BudgetCeilingError";
  }
}

/**
 * `EXIT.BUDGET` when the run halted on a ceiling; `EXIT.SUCCESS` otherwise.
 *
 * Typed `ExitCode` rather than `number` so it composes with `worstExit`
 * directly — the fold at the end of `runSchedule` and the one in `wait` are
 * the callers this exists for, and a plain `number` made the seam that gives
 * `EXIT.BUDGET` its producer a cast site.
 */
export function budgetExitCode(state: BudgetState): ExitCode {
  return state.halted_at !== null ? EXIT.BUDGET : EXIT.SUCCESS;
}

/**
 * A `budget.json` belonging to a different run — never adopted, always loud.
 *
 * Silently taking another run's spend would either refuse a fresh run for
 * tokens it never burned or, worse, hand it a `halted_at` it never earned.
 * The only way this file reaches a run directory is a copy or a hand edit, so
 * it is a corrupt-state diagnosis (`EXIT.BACKEND_UNAVAILABLE`, the same code
 * `StateReadError` uses for an unreadable state file), not a usage error.
 */
export class ForeignBudgetError extends Error implements ExitCoded {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(expected: string, found: string) {
    super(`budget.json belongs to run '${found}', not '${expected}'; refusing to adopt its spend`);
    this.name = "ForeignBudgetError";
  }
}

/**
 * The budget a run resumes with — THE restart decision, in one place.
 *
 * Three rules, each with a different answer to "is the persisted value
 * authoritative?", because the three fields are three different kinds of fact.
 *
 * 1. **Spend is RECOMPUTED, never carried.** `openingTokens` is what the
 *    caller has just OBSERVED the run's workers to have burned — the sum over
 *    workers of the A6 usage in their transcripts and state files, the same
 *    quantity the live loop books deltas against as tasks settle. The
 *    transcripts are the durable evidence of what was actually spent;
 *    `tokens_spent` in `budget.json` is a published snapshot of a derived
 *    quantity, not an independent accumulator. Carrying it forward AND
 *    booking deltas against a fresh observation would double-count every
 *    resumed worker; carrying it and skipping the re-observation would lose
 *    whatever was spent between the last snapshot write and the crash. One
 *    observation point feeding both the total and the caller's per-worker
 *    baselines is the only arrangement with neither hole.
 *
 * 2. **The halt IS carried.** A crossed ceiling is a run-level VERDICT, set
 *    once (see `#halt`), not an arithmetic result to be re-litigated. A
 *    transcript that was rotated, truncated, or lost would otherwise silently
 *    un-halt a run that had already blown its budget — turning the one fact
 *    the operator most needs to survive a restart into the one most easily
 *    erased.
 *
 * 3. **Reservations are DROPPED.** A hold is an admission slot owned by the
 *    process that took it. That process is gone; nothing will ever settle
 *    those task ids in this one, so carrying them would permanently consume
 *    `max_concurrent` slots and deadlock the resumed run. The tasks
 *    themselves are not lost — they are re-offered, and the supervisor's own
 *    attempt dedup replays anything that already completed (ISC-85).
 *
 * Opening spend already past the ceiling halts HERE rather than waiting for a
 * settle that may never come: without it a resumed over-budget run refuses
 * every admission on `would_exceed`, dispatches nothing, and exits 7 — a
 * ceiling crossing reported as a generic partial failure, which is exactly
 * the ISC-114 outcome inverted.
 */
export function resumeBudget(args: {
  runId: string;
  tokensCeiling: number | null;
  /** Tokens this run's workers are OBSERVED to have already burned. */
  openingTokens: number;
  /** The last snapshot on disk, or null for a run with no budget yet. */
  persisted: BudgetState | null;
}): BudgetState {
  const { runId, tokensCeiling, openingTokens, persisted } = args;
  if (persisted !== null && persisted.run_id !== runId) {
    throw new ForeignBudgetError(runId, persisted.run_id);
  }
  const state = emptyBudget(runId, { tokensCeiling });
  state.tokens_spent = Math.max(0, Math.floor(openingTokens));
  if (persisted !== null && persisted.halted_at !== null) {
    state.halted_at = persisted.halted_at;
    state.halted_reason = persisted.halted_reason;
  } else if (tokensCeiling !== null && state.tokens_spent > tokensCeiling) {
    state.halted_at = isoNow();
    state.halted_reason = `tokens_ceiling: resumed spend ${state.tokens_spent} > ${tokensCeiling}`;
  }
  return BudgetStateSchema.parse(state);
}

/** A fresh budget for a run. Ceilings are nullable: null means unbounded. */
export function emptyBudget(
  runId: string,
  ceilings: { tokensCeiling: number | null; usdCeiling?: number | null },
): BudgetState {
  return BudgetStateSchema.parse({
    schema: "pifleet.budget/v1",
    run_id: runId,
    tokens_ceiling: ceilings.tokensCeiling,
    usd_ceiling: ceilings.usdCeiling ?? null,
  });
}

export class BudgetManager {
  #s: BudgetState;

  constructor(restored: BudgetState) {
    // Re-parse rather than trust: the restored state crossed a process
    // boundary (budget.json on disk), which makes it untrusted input by the
    // same rule every envelope follows (SRD §12.5).
    this.#s = BudgetStateSchema.parse(restored);
  }

  /** Serializable state. The caller persists this after acting on a decision. */
  snapshot(): BudgetState {
    return structuredClone(this.#s);
  }

  get halted(): boolean {
    return this.#s.halted_at !== null;
  }

  /** Task ids currently holding a reservation — the in-flight set. */
  inFlight(): string[] {
    return Object.keys(this.#s.reserved);
  }

  /**
   * Whether a task holds an admission slot. The stall policy's discriminator:
   * a silent worker WITH a slot is generating and may be wedged (ISC-117); a
   * silent worker WITHOUT one is queued and silence is what queueing looks
   * like (ISC-110).
   */
  holdsSlot(taskId: string): boolean {
    return taskId in this.#s.reserved;
  }

  /** Sum of all outstanding reservations. */
  #reservedTotal(): number {
    let total = 0;
    for (const v of Object.values(this.#s.reserved)) total += v;
    return total;
  }

  /**
   * Decide an admission. Pure state transition — on `ok` the reservation is
   * recorded and the caller must persist the snapshot before dispatching, so
   * a crash between decision and dispatch cannot leak an unaccounted slot the
   * restart would double-admit against.
   *
   * Order matters: a halted run refuses everything, even a task that would
   * fit — the halt is a run-level verdict, not a per-task arithmetic check.
   */
  admit(taskId: string, opts: AdmitOptions): AdmissionDecision {
    if (this.#s.halted_at !== null) {
      return {
        ok: false,
        reason: "budget_halted",
        detail: this.#s.halted_reason ?? "ceiling crossed",
      };
    }

    // Re-admitting a task that already holds a slot would stack a second
    // reservation under the same key and silently lose the first at release.
    // The epoch layer dedups attempts; this is the budget layer's own guard.
    if (taskId in this.#s.reserved) {
      return { ok: true, reserved: this.#s.reserved[taskId]! };
    }

    if (this.inFlight().length >= opts.maxConcurrent) {
      return {
        ok: false,
        reason: "max_concurrent",
        detail: `${this.inFlight().length} in flight >= max_concurrent ${opts.maxConcurrent}`,
      };
    }

    // The projection is spent + every outstanding hold + this hold. Checking
    // spent alone is the ISC-114 failure with extra steps: two tasks admitted
    // back-to-back would each individually fit and jointly overshoot.
    const ceiling = this.#s.tokens_ceiling;
    if (ceiling !== null) {
      const projected = this.#s.tokens_spent + this.#reservedTotal() + opts.reserveTokens;
      if (projected > ceiling) {
        return {
          ok: false,
          reason: "would_exceed",
          detail: `projected ${projected} tokens > ceiling ${ceiling}`,
        };
      }
    }

    this.#s.reserved = { ...this.#s.reserved, [taskId]: opts.reserveTokens };
    return { ok: true, reserved: opts.reserveTokens };
  }

  /**
   * Reconcile a settled task: release its hold, book actuals, trip the
   * ceiling if actual spend crossed it.
   *
   * Settling a task with no reservation still books the actuals — the spend
   * happened whether or not this process remembers admitting it (a restart
   * between admit and settle loses the in-memory hold but not the ledger),
   * and dropping real usage on the floor is how a ceiling gets overshot
   * silently. Returns whether the run is halted so the caller can stop
   * dispatching without re-reading state.
   */
  settle(taskId: string, actual: ActualUsage): { halted: boolean } {
    if (taskId in this.#s.reserved) {
      const reserved = { ...this.#s.reserved };
      delete reserved[taskId];
      this.#s.reserved = reserved;
    }

    this.#s.tokens_spent += Math.max(0, Math.floor(actual.tokens));
    this.#s.usd_spent += Math.max(0, actual.usd ?? 0);

    // Tokens first: it is the ceiling that exists locally (ISC-115). The usd
    // check only fires when a usd ceiling was explicitly configured, which no
    // local run does — it is kept because the schema keeps the field, not
    // because any current config can set it.
    if (
      this.#s.halted_at === null &&
      this.#s.tokens_ceiling !== null &&
      this.#s.tokens_spent > this.#s.tokens_ceiling
    ) {
      this.#halt(`tokens_ceiling: spent ${this.#s.tokens_spent} > ${this.#s.tokens_ceiling}`);
    }
    if (
      this.#s.halted_at === null &&
      this.#s.usd_ceiling !== null &&
      this.#s.usd_spent > this.#s.usd_ceiling
    ) {
      this.#halt(`usd_ceiling: spent ${this.#s.usd_spent} > ${this.#s.usd_ceiling}`);
    }

    return { halted: this.#s.halted_at !== null };
  }

  /** Set once; later trips must not overwrite the first reason (schema doc). */
  #halt(reason: string): void {
    this.#s.halted_at = isoNow();
    this.#s.halted_reason = reason.slice(0, 4_096);
  }
}
