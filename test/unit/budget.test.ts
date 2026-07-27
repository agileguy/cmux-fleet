/**
 * safety/budget.ts — admission, reservation, ceiling, and the EXIT.BUDGET
 * producer.
 *
 * Every test imports the production BudgetManager and asserts on its state
 * transitions; none re-derives the arithmetic in the test body. The one that
 * matters most is ISC-115: the ceiling must trip on TOKENS while reported
 * cost is 0 throughout, because that is the test a dollars-only budget fails
 * and every model here is unpriced (SRD §5.9).
 */

import { describe, expect, test } from "bun:test";
import {
  BudgetStateSchema,
  EXIT,
  isExitCoded,
  type AdmissionDecision,
} from "../../src/contracts.ts";
import {
  BudgetCeilingError,
  BudgetManager,
  budgetExitCode,
  emptyBudget,
} from "../../src/safety/budget.ts";

const OPTS = { reserveTokens: 100, maxConcurrent: 2 };

function manager(tokensCeiling: number | null = 1_000): BudgetManager {
  return new BudgetManager(emptyBudget("r-test", { tokensCeiling }));
}

function refused(d: AdmissionDecision): d is Extract<AdmissionDecision, { ok: false }> {
  return !d.ok;
}

describe("ISC-115: the ceiling trips on tokens while usd stays 0 throughout", () => {
  /**
   * Fails if: the halt check reads `usd_spent`/`usd_ceiling` instead of (or
   * gated on) the token axis — the dollars-only implementation. Local models
   * report cost 0 forever, so such a budget admits until the machine melts.
   */
  test("a run spending only unpriced tokens is halted", () => {
    const m = manager(1_000);
    let halted = false;
    for (let i = 0; i < 20 && !halted; i++) {
      const d = m.admit(`t-${i}`, OPTS);
      if (refused(d)) break;
      // Every settle reports cost 0 — the permanent local-model condition.
      halted = m.settle(`t-${i}`, { tokens: 400, usd: 0 }).halted;
    }
    const s = m.snapshot();
    expect(halted).toBe(true);
    expect(s.usd_spent).toBe(0); // cost really was 0 the whole way
    expect(s.halted_at).not.toBeNull();
    expect(s.halted_reason).toContain("tokens_ceiling");
  });

  /**
   * Fails if: someone "restores" a usd trip wired to spend rather than to an
   * explicitly configured usd ceiling. With no usd ceiling set, dollars are
   * advisory bookkeeping and must never halt anything.
   */
  test("usd spend never halts when no usd ceiling is configured", () => {
    const m = manager(null);
    m.admit("t-1", OPTS);
    const { halted } = m.settle("t-1", { tokens: 10, usd: 9_999_999 });
    expect(halted).toBe(false);
    expect(m.snapshot().usd_spent).toBe(9_999_999);
  });
});

describe("reservation (ISC-114 / F24): admission subtracts the hold up front", () => {
  /**
   * Fails if: admission projects from `tokens_spent` alone and ignores
   * outstanding holds — the overshoot-between-polls bug, where two tasks that
   * each fit individually are admitted jointly past the ceiling.
   */
  test("an outstanding reservation counts against the next admission", () => {
    const m = manager(1_000);
    expect(m.admit("t-1", { reserveTokens: 900, maxConcurrent: 2 }).ok).toBe(true);
    const d = m.admit("t-2", { reserveTokens: 900, maxConcurrent: 2 });
    expect(refused(d) && d.reason).toBe("would_exceed");
  });

  /**
   * Fails if: settle stops releasing the hold — headroom would ratchet down
   * and a run would starve long before its ceiling.
   */
  test("settle releases the hold and books actuals in its place", () => {
    const m = manager(1_000);
    m.admit("t-1", { reserveTokens: 900, maxConcurrent: 2 });
    m.settle("t-1", { tokens: 500 });
    const s = m.snapshot();
    expect(s.reserved).toEqual({});
    expect(s.tokens_spent).toBe(500);
    // 500 spent + 400 reserve fits under 1000 again.
    expect(m.admit("t-2", { reserveTokens: 400, maxConcurrent: 2 }).ok).toBe(true);
  });

  /**
   * Fails if: re-admitting an in-flight task stacks a second reservation
   * under the same key — the first hold would be silently lost at release.
   */
  test("re-admitting an in-flight task returns the existing hold, not a new one", () => {
    const m = manager(1_000);
    m.admit("t-1", { reserveTokens: 300, maxConcurrent: 2 });
    const again = m.admit("t-1", { reserveTokens: 300, maxConcurrent: 2 });
    expect(again.ok && again.reserved).toBe(300);
    expect(m.snapshot().reserved).toEqual({ "t-1": 300 });
  });

  /**
   * Fails if: settle starts dropping usage for tasks it has no hold for. A
   * restart between admit and settle loses the in-memory hold but not the
   * spend; forgetting it is how a ceiling is overshot invisibly.
   */
  test("settling a task with no recorded hold still books its actuals", () => {
    const m = manager(1_000);
    m.settle("t-unknown", { tokens: 250 });
    expect(m.snapshot().tokens_spent).toBe(250);
  });
});

describe("ISC-114: crossing the ceiling halts dispatch", () => {
  /**
   * Fails if: the halt flag stops gating admission, or `settle` starts
   * throwing on the trip (which would destroy the harvest path — the halt
   * must be a refusal at the NEXT dispatch, not an explosion at settle).
   */
  test("after the trip, every admission is refused budget_halted", () => {
    const m = manager(100);
    m.admit("t-1", { reserveTokens: 100, maxConcurrent: 2 });
    const { halted } = m.settle("t-1", { tokens: 150 });
    expect(halted).toBe(true);
    // Even a zero-reserve task is refused: the halt is a run-level verdict.
    const d = m.admit("t-2", { reserveTokens: 0, maxConcurrent: 2 });
    expect(refused(d) && d.reason).toBe("budget_halted");
  });

  /**
   * Fails if: the boundary drifts — "exceeding" means strictly past the
   * ceiling, so landing exactly on it must not halt (and the next token must).
   */
  test("spending exactly the ceiling is not exceeding it", () => {
    const m = manager(100);
    m.admit("t-1", { reserveTokens: 100, maxConcurrent: 2 });
    expect(m.settle("t-1", { tokens: 100 }).halted).toBe(false);
    expect(m.settle("t-extra", { tokens: 1 }).halted).toBe(true);
  });

  /**
   * Fails if: a second trip overwrites `halted_reason` — the FIRST crossing
   * is the diagnosis; later spends are consequences.
   */
  test("the first halt reason is kept", () => {
    const m = manager(100);
    m.settle("t-1", { tokens: 200 });
    const first = m.snapshot().halted_reason;
    m.settle("t-2", { tokens: 999 });
    expect(m.snapshot().halted_reason).toBe(first);
  });
});

describe("admission slots (SRD §9.3): the reservation is the concurrency unit", () => {
  /**
   * Fails if: max_concurrent stops being enforced from the reserved set —
   * six workers would queue on one oMLX server at once (F40).
   */
  test("a third in-flight task is refused at max_concurrent 2", () => {
    const m = manager(null);
    m.admit("t-1", OPTS);
    m.admit("t-2", OPTS);
    const d = m.admit("t-3", OPTS);
    expect(refused(d) && d.reason).toBe("max_concurrent");
  });

  /**
   * Fails if: `holdsSlot` decouples from admit/settle. safety/kill.ts uses
   * this exact predicate to tell a QUEUED worker from a WEDGED one (ISC-110);
   * if it lies, queued workers get killed for standing in line.
   */
  test("holdsSlot is true between admit and settle, false outside", () => {
    const m = manager(null);
    expect(m.holdsSlot("t-1")).toBe(false);
    m.admit("t-1", OPTS);
    expect(m.holdsSlot("t-1")).toBe(true);
    m.settle("t-1", { tokens: 1 });
    expect(m.holdsSlot("t-1")).toBe(false);
  });
});

describe("one shape on the seam", () => {
  /**
   * Fails if: the manager grows private fields outside BudgetStateSchema or
   * stops keying `reserved` by task id — the contract in contracts.ts is the
   * only budget shape, and a snapshot must round-trip it losslessly.
   */
  test("a working snapshot round-trips BudgetStateSchema", () => {
    const m = manager(1_000);
    m.admit("t-1", OPTS);
    m.settle("t-0", { tokens: 5 });
    const s = BudgetStateSchema.parse(m.snapshot());
    expect(s.reserved).toEqual({ "t-1": 100 });
    // And a restored manager continues from it rather than starting fresh.
    const restored = new BudgetManager(s);
    expect(restored.holdsSlot("t-1")).toBe(true);
    expect(restored.snapshot().tokens_spent).toBe(5);
  });
});

describe("ISC-193: EXIT.BUDGET has a producer", () => {
  /**
   * Fails if: the producer is removed again — budgetExitCode is what `wait`
   * folds into `worstExit`, and before this module nothing anywhere could
   * yield 5.
   */
  test("a halted budget yields EXIT.BUDGET; a healthy one yields SUCCESS", () => {
    const m = manager(10);
    expect(budgetExitCode(m.snapshot())).toBe(EXIT.SUCCESS);
    m.settle("t-1", { tokens: 999 });
    expect(budgetExitCode(m.snapshot())).toBe(EXIT.BUDGET);
  });

  /**
   * Fails if: BudgetCeilingError stops satisfying the ExitCoded protocol the
   * CLI entry point recognises — the trip would surface as a stack trace and
   * exit 1 instead of a one-line message and exit 5.
   */
  test("BudgetCeilingError is a diagnosed exit-5 failure", () => {
    const err = new BudgetCeilingError("tokens_ceiling: spent 200 > 100");
    expect(isExitCoded(err)).toBe(true);
    expect(err.exitCode).toBe(EXIT.BUDGET);
    expect(err.exitCode).toBe(5);
  });
});
