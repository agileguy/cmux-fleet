/**
 * A6 — cost and usage (SRD §8.1).
 *
 * Two sources are DESIGNED for. Exactly one is consulted:
 *
 * 1. `get_session_stats` — `data.tokens` and `data.cost`, intended to be
 *    persisted by the supervisor into `state.json`'s `usage` field. NOT
 *    WIRED. Nothing in `src/` sends that RPC: every occurrence of the verb
 *    outside a comment is absent, every command name at an
 *    `rpc/client.ts#send` call site is a string literal, and the only
 *    executable `get_session_stats` in the repository is the RESPONDER in
 *    the test double. `WorkerState.usage` is consequently never written by
 *    anything — it materializes at its schema default and stays
 *    `{0, 0, 0, false}` for the life of a run. `usageFromSessionStats`
 *    below parses the payload shape and has no production caller; its unit
 *    tests are what keep it honest until one exists.
 * 2. `AssistantMessage.usage` in the A4 transcript, folded per message. This
 *    is the source that actually runs, and in production it is the only
 *    contributor to any total this module returns.
 *
 * Stated plainly because the sentence this replaces asserted both sources
 * were live and left a reader no way to notice otherwise: `combineUsage` is
 * an identity function on the transcript total today. Its other argument is
 * always zero, so the element-wise `max` below reduces to `max(0, x)` on
 * every axis. The under-count that source 1 exists to correct — a transcript
 * rewritten or branch-pruned on session switch — is therefore uncorrected.
 * Wiring source 1 is deliberately NOT done here: it belongs with the budget
 * work that would read the number, and ISC-114 records that `safety/budget.ts`
 * has no production importer either.
 *
 * The load-bearing fact: **local models are unpriced**. oMLX has no price
 * table, so `cost` is 0 on every response no matter how many tokens burned
 * (SRD §5.9). A ceiling that watches dollars therefore never trips locally —
 * ISC-115 requires the run to halt while reported cost is 0 throughout — so
 * `usd` is advisory, `priced` records whether it means anything, and tokens
 * are the axis budget code must read when budget code reaches a run.
 *
 * The output shape mirrors `WorkerStateSchema.usage` in contracts.ts exactly,
 * so a total computed here can be written into a state file without
 * translation.
 */

/** Mirrors `WorkerStateSchema.usage` — the seam's shape, not a new one. */
export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  /** Always 0 for local models; meaningful only when `priced` is true. */
  usd: number;
  priced: boolean;
}

export const ZERO_USAGE: UsageTotals = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  usd: 0,
  priced: false,
});

/** The one number budget ceilings compare against (ISC-114/115). */
export function tokensTotal(u: UsageTotals): number {
  return u.input_tokens + u.output_tokens;
}

function nonNegNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Extract totals from a `get_session_stats` response's `data` payload.
 *
 * Shape verified against Pi 0.79.6's shipped `docs/rpc.md`:
 * `{tokens: {input, output, cacheRead, cacheWrite, total}, cost: number}`.
 * Cache tokens are deliberately not folded into `input_tokens` — the seam
 * shape has no field for them, and inflating `input_tokens` would make the
 * transcript-derived total and this one disagree by design.
 *
 * Returns `null` for a payload that does not carry usable numbers, so a
 * malformed response degrades to the transcript source instead of silently
 * contributing zeros that read as "nothing spent".
 */
export function usageFromSessionStats(data: unknown): UsageTotals | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { tokens?: unknown; cost?: unknown };
  if (typeof d.tokens !== "object" || d.tokens === null) return null;
  const t = d.tokens as { input?: unknown; output?: unknown };
  const input = nonNegNumber(t.input);
  const output = nonNegNumber(t.output);
  if (input === null || output === null) return null;
  const usd = nonNegNumber(d.cost) ?? 0;
  return {
    input_tokens: Math.round(input),
    output_tokens: Math.round(output),
    usd,
    // Zero cost does not mean free — it means unpriced (local model). The
    // flag is what stops a downstream consumer averaging $0.00 into a
    // spend report as if it were a measurement.
    priced: usd > 0,
  };
}

/**
 * Extract one `AssistantMessage.usage` (A4) as a total.
 *
 * Shape verified against Pi 0.79.6's `docs/session-format.md`:
 * `{input, output, cacheRead, cacheWrite, totalTokens, cost: {total, ...}}`.
 */
export function usageFromAssistantMessage(usage: unknown): UsageTotals | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as { input?: unknown; output?: unknown; cost?: unknown };
  const input = nonNegNumber(u.input);
  const output = nonNegNumber(u.output);
  if (input === null || output === null) return null;
  let usd = 0;
  if (typeof u.cost === "object" && u.cost !== null) {
    usd = nonNegNumber((u.cost as { total?: unknown }).total) ?? 0;
  }
  return {
    input_tokens: Math.round(input),
    output_tokens: Math.round(output),
    usd,
    priced: usd > 0,
  };
}

/**
 * Merge the two A6 sources: element-wise MAX, never min and never preference.
 *
 * Both sources can under-count. `get_session_stats` describes the current
 * session state, and a `new_session`/`switch_session` resets it; the
 * transcript can be rewritten on session switch and loses branches to
 * migration. An under-count feeding a ceiling means the ceiling never trips —
 * the exact failure ISC-115 exists to prevent — so the merge takes the larger
 * claim on every axis. Over-counting trips a budget early, which is loud and
 * cheap; under-counting blows through it silently.
 *
 * The max is the RIGHT rule and is currently a no-op: source 1 is unwired
 * (see the module header), so at the one production call site the `a` side is
 * always the zero default and this returns `b` unchanged. Both null branches
 * below are likewise unreachable from production — that call site passes a
 * schema-defaulted `state.usage` and a `?? ZERO_USAGE` fallback. What keeps
 * the max semantics from rotting is `test/unit/harvest-usage.test.ts` plus
 * one integration fixture that hand-writes a non-zero `state.usage`; delete
 * those and nothing observes this function's actual rule.
 */
export function combineUsage(a: UsageTotals | null, b: UsageTotals | null): UsageTotals {
  if (a === null) return b ?? ZERO_USAGE;
  if (b === null) return a;
  return {
    input_tokens: Math.max(a.input_tokens, b.input_tokens),
    output_tokens: Math.max(a.output_tokens, b.output_tokens),
    usd: Math.max(a.usd, b.usd),
    priced: a.priced || b.priced,
  };
}
