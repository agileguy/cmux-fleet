/**
 * A6 usage extraction (SRD §8.1; ISC-114/115).
 *
 * The axis that matters: local models are unpriced, so `usd` is 0 while
 * tokens burn. Every test names the production change that would make it
 * fail; all of them import the functions under test.
 */

import { describe, expect, test } from "bun:test";
import {
  ZERO_USAGE,
  combineUsage,
  tokensTotal,
  usageFromAssistantMessage,
  usageFromSessionStats,
} from "../../src/harvest/usage.ts";

describe("usageFromSessionStats", () => {
  const stats = (cost: number) => ({
    sessionFile: "/x.jsonl",
    tokens: { input: 50_000, output: 10_000, cacheRead: 40_000, cacheWrite: 5_000, total: 105_000 },
    cost,
  });

  test("maps the rpc.md shape onto the seam's usage shape", () => {
    // Fails if the extractor reads a field Pi does not send (e.g. a guessed
    // `tokens.prompt`) or folds cache tokens into input_tokens, which would
    // make this source disagree with the transcript source by construction.
    expect(usageFromSessionStats(stats(0.45))).toEqual({
      input_tokens: 50_000,
      output_tokens: 10_000,
      usd: 0.45,
      priced: true,
    });
  });

  test("zero cost means unpriced, not free (the local-model axis)", () => {
    const u = usageFromSessionStats(stats(0));
    expect(u).not.toBeNull();
    // ISC-115's premise: a ceiling watching dollars never trips locally.
    // Fails if priced defaults to true on cost 0, or if tokens are zeroed
    // when cost is — either would let a local run report "nothing spent".
    expect(u?.priced).toBe(false);
    expect(u?.usd).toBe(0);
    expect(tokensTotal(u!)).toBe(60_000);
  });

  test("a malformed payload degrades to null, not to zeros", () => {
    // Fails if the extractor returns ZERO_USAGE for garbage: a zero total is
    // indistinguishable from "nothing spent" and would silently disable the
    // ceiling for that worker, whereas null lets the caller fall back to the
    // transcript source.
    expect(usageFromSessionStats(null)).toBeNull();
    expect(usageFromSessionStats({})).toBeNull();
    expect(usageFromSessionStats({ tokens: { input: "many", output: 5 }, cost: 1 })).toBeNull();
    expect(usageFromSessionStats({ tokens: { input: -5, output: 5 }, cost: 1 })).toBeNull();
  });
});

describe("usageFromAssistantMessage", () => {
  test("maps the session-format usage shape, cost.total included", () => {
    // Fails if the extractor reads `cost` as a number here — in the
    // transcript (unlike get_session_stats) cost is an OBJECT with a `total`
    // field, and the two shapes are exactly the kind of near-miss a shared
    // extractor would blur.
    expect(
      usageFromAssistantMessage({
        input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      }),
    ).toEqual({ input_tokens: 100, output_tokens: 50, usd: 0.3, priced: true });
  });

  test("a local model's zeroed cost object is unpriced", () => {
    const u = usageFromAssistantMessage({
      input: 812, output: 41, cacheRead: 0, cacheWrite: 0, totalTokens: 853,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(u).toEqual({ input_tokens: 812, output_tokens: 41, usd: 0, priced: false });
  });

  test("garbage usage is null", () => {
    expect(usageFromAssistantMessage(undefined)).toBeNull();
    expect(usageFromAssistantMessage({ input: 5 })).toBeNull();
  });
});

describe("combineUsage", () => {
  test("takes the element-wise max, never a preferred source", () => {
    const stats = { input_tokens: 1_000, output_tokens: 10, usd: 0, priced: false };
    const transcript = { input_tokens: 300, output_tokens: 500, usd: 0.2, priced: true };
    // Fails if the merge prefers one source (stats would win output_tokens
    // wrongly) or sums (1300 input). Both sources can under-count — stats
    // reset on new_session, transcripts are rewritten on switch — and an
    // under-count feeding a token ceiling means the ceiling never trips.
    expect(combineUsage(stats, transcript)).toEqual({
      input_tokens: 1_000,
      output_tokens: 500,
      usd: 0.2,
      priced: true,
    });
    // Same assertion with the winners FLIPPED per field. Without this, a
    // mutant that hardcodes `a.input_tokens` survives the fixture above,
    // because `a` happens to win that axis there — a mutation run proved it.
    expect(
      combineUsage(
        { input_tokens: 300, output_tokens: 500, usd: 0.2, priced: true },
        { input_tokens: 1_000, output_tokens: 10, usd: 0, priced: false },
      ),
    ).toEqual({ input_tokens: 1_000, output_tokens: 500, usd: 0.2, priced: true });
  });

  test("null on either side yields the other; both null yields zero", () => {
    const u = { input_tokens: 1, output_tokens: 2, usd: 0, priced: false };
    expect(combineUsage(null, u)).toEqual(u);
    expect(combineUsage(u, null)).toEqual(u);
    expect(combineUsage(null, null)).toEqual(ZERO_USAGE);
  });

  test("tokensTotal is the ceiling's number: input plus output", () => {
    // Fails if the total starts reading usd — the exact mistake ISC-115
    // exists to forbid, since usd is 0 throughout on local models.
    expect(tokensTotal({ input_tokens: 7, output_tokens: 5, usd: 99, priced: true })).toBe(12);
  });
});
