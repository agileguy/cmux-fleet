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

/** `EXIT.BUDGET` when the run halted on a ceiling; `EXIT.SUCCESS` otherwise. */
export function budgetExitCode(state: BudgetState): number {
  return state.halted_at !== null ? EXIT.BUDGET : EXIT.SUCCESS;
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
