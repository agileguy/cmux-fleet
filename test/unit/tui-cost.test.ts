/**
 * A `tui` worker's cost, summed from the transcript (SRD §3.5, TUI spec item 7).
 *
 * §3.5 voids `get_session_stats` polling in `tui` mode and says cost is
 * "accounted by summing `usage` from the transcript instead". Both halves of
 * that already exist and are probed elsewhere — `harvest-usage.test.ts` pins
 * the per-message extraction and the element-wise max, and
 * `harvest-transcript.test.ts` pins that `reconstruct()` sums across the whole
 * file. Neither is repeated here.
 *
 * What NOTHING pinned before this file is the CHAIN, which is the only thing
 * a tui worker actually depends on, and which crosses three modules:
 *
 *     WorkerStateSchema's `usage` default   (contracts.ts — permanently zero
 *                                            for a tui worker, because the
 *                                            only writer is an RPC reply)
 *   + reconstruct(transcript).usage         (harvest/transcript.ts)
 *   -> combineUsage -> tokensTotal          (harvest/usage.ts)
 *   =  the number the budget ceiling reads  (cli/commands/dispatch.ts)
 *
 * Each link is checked by its own suite; the JOIN is not, and the join is
 * where a tui worker's spend would go missing. The failure is silent and
 * expensive in exactly the way ISC-114/115 exist to prevent: an under-count
 * feeding a ceiling means the ceiling never trips, so a run that should have
 * halted keeps buying tokens. Nothing throws, nothing logs, and the run looks
 * healthy the whole way down.
 *
 * The controlling fact these assertions rest on: in `tui` mode the supervisor
 * holds none of Pi's three streams, so there is no RPC to answer
 * `get_session_stats`, so `state.usage` is never written and stays at its
 * schema default for the life of the run. The transcript is therefore not
 * merely the source that happens to run (which is what `harvest/usage.ts`
 * records for `rpc` today) — it is the ONLY source that CAN run.
 *
 * NOT CLAIMED: that a tui worker's transcript is findable. `state.session_path`
 * is written only from an RPC `get_state` reply (`recordSessionPath`,
 * supervisor/index.ts), so for a tui worker it is null and this chain has no
 * input. That is spec item 6's deliverable — transcript-derived completion has
 * to locate the same file — and it lives in the supervisor, which is not this
 * file set. These tests take the path as given and prove everything downstream
 * of it; they would pass on the day item 6 lands and on the day before.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerStateSchema, type WorkerState } from "../../src/contracts.ts";
import { readTranscript, reconstruct } from "../../src/harvest/transcript.ts";
import { ZERO_USAGE, combineUsage, tokensTotal } from "../../src/harvest/usage.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const TS = "2026-08-31T00:00:00.000Z";
const FREE_COST = { cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };

function assistant(id: string, parentId: string | null, input: number, output: number): object {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TS,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai",
      provider: "omlx",
      model: "qwen3",
      usage: { ...FREE_COST, input, output, totalTokens: input + output },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

/**
 * A transcript with an ABANDONED BRANCH, because that is the case where a
 * "sum the transcript" implementation can quietly disagree with itself.
 * `reconstruct()` walks the active path for turns and tool calls but totals
 * usage over the whole file — tokens burned on a branch the agent later
 * abandoned were still burned and still billed.
 *
 *   root(a1: 100/50)
 *     +-- a2 (200/70)          <- active leaf
 *     +-- a3 (300/90)          <- abandoned sibling, still spent
 */
async function transcriptFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-tui-cost-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const records = [
    { type: "session", version: 3, id: "sess-tui", timestamp: TS, cwd: "/workspace" },
    assistant("a1", null, 100, 50),
    assistant("a2", "a1", 200, 70),
    assistant("a3", "a1", 300, 90),
  ];
  await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

/** A worker state as a `tui` worker's actually is: no `usage` ever written. */
function tuiState(): WorkerState {
  return WorkerStateSchema.parse({
    schema: "pifleet.state/v1",
    worker: "eng-tui",
    run_id: "run-tui",
    pid: 4242,
    pgid: 4242,
    started_at: TS,
    phase: "idle",
    epoch: 1,
  });
}

describe("the precondition: a tui worker's state.usage is permanently zero", () => {
  /**
   * Asserted rather than assumed, because every other test in this file is
   * only meaningful if it holds. If `usage` ever gains a non-zero default, the
   * merge below stops being an identity on the transcript and a tui worker's
   * reported spend becomes that default plus nothing.
   */
  test("state.usage materializes at its schema default and it is all-zero", () => {
    expect(tuiState().usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      usd: 0,
      priced: false,
    });
    expect(tuiState().usage).toEqual(ZERO_USAGE);
  });

  /**
   * `session_path` is null for a tui worker, and that is the documented input
   * gap item 6 closes. Pinned so the boundary of this file's claim is a test
   * rather than a sentence in a docblock.
   */
  test("session_path starts null — the chain's input is item 6's to supply", () => {
    expect(tuiState().session_path).toBeNull();
  });
});

describe("the chain: transcript alone produces the ceiling's number", () => {
  test("sums every assistant message, abandoned branches included", async () => {
    const usage = reconstruct(await readTranscript(await transcriptFile())).usage;
    // 100+200+300 in, 50+70+90 out. A implementation that totalled only the
    // ACTIVE path would report 300/120 and under-charge the run by a third.
    expect(usage.input_tokens).toBe(600);
    expect(usage.output_tokens).toBe(210);
  });

  /**
   * THE JOIN, and the assertion this file exists for.
   *
   * The merge with a zero `state.usage` must be an identity on the transcript.
   * `harvest/usage.ts` says the element-wise max "reduces to `max(0, x)` on
   * every axis" for exactly this case; that sentence is true of `rpc` by
   * accident (nothing writes source 1 yet) and true of `tui` by construction
   * (nothing CAN). Only the second is a guarantee, and only this asserts it.
   */
  test("combineUsage with a tui worker's zero state.usage is an identity", async () => {
    const transcript = reconstruct(await readTranscript(await transcriptFile())).usage;
    const merged = combineUsage(tuiState().usage, transcript);
    expect(merged).toEqual(transcript);
    expect(tokensTotal(merged)).toBe(810);
  });

  /**
   * The number is NON-ZERO for a worker that spent.
   *
   * Separate from the equality above because the two fail differently: an
   * identity that returns zero for a zero transcript is still an identity, and
   * a chain that silently produced 0 would satisfy every other assertion here
   * while leaving a ceiling that can never trip. This is the ISC-115 shape
   * stated directly.
   */
  test("a tui worker that spent does not report as having spent nothing", async () => {
    const transcript = reconstruct(await readTranscript(await transcriptFile())).usage;
    expect(tokensTotal(combineUsage(tuiState().usage, transcript))).toBeGreaterThan(0);
  });

  /**
   * Local models are unpriced, so the DOLLAR axis is 0 for a real tui run and
   * a ceiling watching dollars never trips (SRD §5.9, ISC-115). `priced`
   * records that the 0 is an absence of a price table rather than a
   * measurement of free work — the distinction a spend report must not lose.
   */
  test("an unpriced local run reports usd 0 with priced false, not a measured zero", async () => {
    const transcript = reconstruct(await readTranscript(await transcriptFile())).usage;
    const merged = combineUsage(tuiState().usage, transcript);
    expect(merged.usd).toBe(0);
    expect(merged.priced).toBe(false);
    // …and tokens are therefore the axis that still carries the run.
    expect(tokensTotal(merged)).toBe(810);
  });
});
