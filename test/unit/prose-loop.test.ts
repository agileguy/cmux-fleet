/**
 * ISC-1144 — the `tui` plane's THIRD loop shape, and the only one that settles
 * `success` when nobody is looking.
 *
 * ## What these tests can and cannot prove
 *
 * They grade `readProseLoop` as a fold over entries: what counts as a unit,
 * that the count is a population and not a run, and that the bound sits where
 * the measurement put it. **They cannot prove the supervisor calls it** — the
 * failure this repo has shipped before is a complete, well-argued module with
 * green tests and no caller. So there are two extra probes here that are not
 * about the fold at all: a source-ORDER tripwire (the check must precede the
 * `ended` gate, or it runs after a successful verdict is already decided) and a
 * call-site tripwire. The behavioural proof at the outermost surface lives in
 * `test/integration/tui-transcript-activity.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { TreeEntry } from "../../src/harvest/transcript.ts";
import {
  PROSE_LOOP_REASON,
  PROSE_LOOP_THRESHOLD,
  PROSE_UNIT_MIN_CHARS,
  isProseLoop,
  readProseLoop,
} from "../../src/supervisor/prose-loop.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

let seq = 0;

/** One assistant entry carrying the given prose blocks, in the shape Pi writes. */
function prose(...blocks: Array<{ type: "text" | "thinking"; body: string }>): TreeEntry {
  seq++;
  return {
    type: "message",
    id: `e${seq}`,
    parentId: seq === 1 ? null : `e${seq - 1}`,
    message: {
      role: "assistant",
      stopReason: "endTurn",
      content: blocks.map((b) =>
        b.type === "text" ? { type: "text", text: b.body } : { type: "thinking", thinking: b.body },
      ),
    },
  } as unknown as TreeEntry;
}

/** `n` copies of `line`, each separated by a DIFFERENT filler sentence. */
function nonAdjacent(line: string, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(line);
    out.push(`Filler sentence number ${i} about something else entirely.`);
  }
  return out.join("\n");
}

/** `n` copies of `line`, back to back with nothing between them. */
function adjacent(line: string, n: number): string {
  return new Array(n).fill(line).join("\n");
}

const LOOP_LINE = "Wait, I will write the files now.";

describe("readProseLoop — the fold", () => {
  test("no prose at all reports zero and no line", () => {
    expect(readProseLoop([])).toEqual({ repeats: 0, line: null });
  });

  test("prose that never repeats reports the count and NO line, not a streak of one", () => {
    const reading = readProseLoop([
      prose({ type: "text", body: "One distinct sentence here.\nA second distinct sentence." }),
    ]);
    expect(reading.repeats).toBe(1);
    expect(reading.line).toBeNull();
  });

  test("the repeated sentence is reported, because the count alone is not a diagnosis", () => {
    const reading = readProseLoop([{ ...prose({ type: "thinking", body: nonAdjacent(LOOP_LINE, 5) }) }]);
    expect(reading.repeats).toBe(5);
    expect(reading.line).toBe(LOOP_LINE);
  });

  /**
   * THE discriminating case. Every measured instance of this failure has a
   * maximum consecutive run of 1 — the model returns to the sentence rather
   * than repeating it back to back — so a rule shaped like `readToolLoop`'s
   * scores the floor on all five. If this test can be made to pass by a
   * consecutive-run implementation, the detector is the wrong one.
   */
  test("repeats that are NEVER adjacent still count — the tool-loop rule scores 1 here", () => {
    const body = nonAdjacent(LOOP_LINE, PROSE_LOOP_THRESHOLD);
    const reading = readProseLoop([prose({ type: "thinking", body })]);
    expect(reading.repeats).toBe(PROSE_LOOP_THRESHOLD);
    expect(isProseLoop(reading)).toBe(true);

    // The same body under a longest-consecutive-run reading, spelled out so the
    // contrast is asserted rather than described.
    const units = body.split("\n");
    let best = 1;
    let cur = 1;
    for (let i = 1; i < units.length; i++) {
      cur = units[i] === units[i - 1] ? cur + 1 : 1;
      if (cur > best) best = cur;
    }
    expect(best).toBe(1);
  });

  test("adjacent repeats count the same as scattered ones", () => {
    const a = readProseLoop([prose({ type: "thinking", body: adjacent(LOOP_LINE, 40) })]);
    const b = readProseLoop([prose({ type: "thinking", body: nonAdjacent(LOOP_LINE, 40) })]);
    expect(a.repeats).toBe(40);
    expect(b.repeats).toBe(40);
  });

  test("`thinking` blocks are counted — all five measured loops were thinking, not text", () => {
    const reading = readProseLoop([prose({ type: "thinking", body: nonAdjacent(LOOP_LINE, 30) })]);
    expect(reading.repeats).toBe(30);
  });

  test("`text` blocks are counted too", () => {
    const reading = readProseLoop([prose({ type: "text", body: nonAdjacent(LOOP_LINE, 30) })]);
    expect(reading.repeats).toBe(30);
  });

  /**
   * Per BLOCK. Two messages that each say the same sentence fifty times are two
   * acts of generation, and the diagnosis this makes is about ONE.
   */
  test("counts within a block and does not fold two messages into one population", () => {
    const half = PROSE_LOOP_THRESHOLD - 1;
    const reading = readProseLoop([
      prose({ type: "thinking", body: nonAdjacent(LOOP_LINE, half) }),
      prose({ type: "thinking", body: nonAdjacent(LOOP_LINE, half) }),
    ]);
    expect(reading.repeats).toBe(half);
    expect(isProseLoop(reading)).toBe(false);
  });

  test("the worst block wins, so a loop late in the epoch is not diluted by clean ones", () => {
    const reading = readProseLoop([
      prose({ type: "text", body: "A perfectly ordinary opening sentence goes here." }),
      prose({ type: "thinking", body: nonAdjacent(LOOP_LINE, PROSE_LOOP_THRESHOLD) }),
    ]);
    expect(isProseLoop(reading)).toBe(true);
  });

  test("a unit shorter than the floor is not counted, which is what keeps code fences out", () => {
    const fence = "```ts";
    expect(fence.length).toBeLessThan(PROSE_UNIT_MIN_CHARS);
    const reading = readProseLoop([prose({ type: "text", body: adjacent(fence, 400) })]);
    expect(reading.repeats).toBe(0);
  });

  test("non-assistant entries contribute nothing", () => {
    const userEntry = {
      type: "message",
      id: "u1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: nonAdjacent(LOOP_LINE, 500) }] },
    } as unknown as TreeEntry;
    expect(readProseLoop([userEntry]).repeats).toBe(0);
  });

  test("the reported line is truncated, so a 200 KB block cannot become a 200 KB event", () => {
    const long = `${"x".repeat(5000)}.`;
    const reading = readProseLoop([prose({ type: "thinking", body: adjacent(long, 5) })]);
    expect(reading.line).not.toBeNull();
    expect(reading.line!.length).toBeLessThanOrEqual(120);
  });
});

describe("the bound is where the measurement put it", () => {
  /**
   * Both edges, so moving the threshold in EITHER direction turns this red.
   * Derived from 2,724 assistant prose blocks on this host: worst healthy 48,
   * mildest loop 729.
   */
  test("one below the threshold does not trip", () => {
    const reading = readProseLoop([
      prose({ type: "thinking", body: nonAdjacent(LOOP_LINE, PROSE_LOOP_THRESHOLD - 1) }),
    ]);
    expect(isProseLoop(reading)).toBe(false);
  });

  test("exactly the threshold trips", () => {
    const reading = readProseLoop([
      prose({ type: "thinking", body: nonAdjacent(LOOP_LINE, PROSE_LOOP_THRESHOLD) }),
    ]);
    expect(isProseLoop(reading)).toBe(true);
  });

  test("the WORST HEALTHY block ever measured on this host does not trip", () => {
    // `Actually, wait.` x48, in a 58 KB deliberation that produced real work.
    const reading = readProseLoop([
      prose({ type: "thinking", body: nonAdjacent("Actually, wait, let me reconsider.", 48) }),
    ]);
    expect(reading.repeats).toBe(48);
    expect(isProseLoop(reading)).toBe(false);
  });

  test("the MILDEST loop ever measured on this host trips", () => {
    const reading = readProseLoop([
      prose({ type: "thinking", body: nonAdjacent("Let me do it now, for real.", 729) }),
    ]);
    expect(reading.repeats).toBe(729);
    expect(isProseLoop(reading)).toBe(true);
  });

  test("the threshold sits strictly between the two, with headroom on both sides", () => {
    expect(PROSE_LOOP_THRESHOLD).toBeGreaterThan(48);
    expect(PROSE_LOOP_THRESHOLD).toBeLessThan(729);
  });
});

/**
 * The two probes that are not about the fold.
 *
 * A unit test of a function cannot see where it is called from, and this module
 * has a placement requirement that is a property of the branch ABOVE it: the
 * check must run before `if (reading.phase !== "ended") return`, because a
 * prose-looping seat SATISFIES that gate — its last message carries no tool
 * call — and a check below it would execute after the quiet window had already
 * decided `success`.
 */
describe("the wiring, graded from the source", () => {
  const SUPERVISOR = readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8");

  test("the supervisor calls it, outside this module's own file", () => {
    expect(SUPERVISOR).toContain("readProseLoop(sinceDispatch)");
    expect(SUPERVISOR).toContain("isProseLoop(prose)");
    expect(SUPERVISOR).toContain(PROSE_LOOP_REASON.replace("transcript_", ""));
  });

  /**
   * Anchored on `settle`, NOT on the `ended` gate, and the difference was
   * measured rather than reasoned. Moving the check below the gate, and again
   * to just above the verdict chain, left the integration probe GREEN both
   * times — a prose-looping seat satisfies that gate, unlike the tool-looping
   * seat ISC-1126 was written for. The probe only reddens when the check falls
   * below `await settle(verdict, reason)`, so that is the boundary worth
   * pinning: a tripwire on the gate would fail on placements that work, which
   * teaches a later reader to move it and then to delete it.
   */
  test("the check precedes the settle it must outrank", () => {
    /*
     * `tui_turn_ended` and not `await settle(verdict, reason)`, because that
     * call appears TWICE — once on the rpc path, earlier in the file — and
     * `indexOf` finds the rpc one, which this check has no relationship to and
     * legitimately follows. The event is emitted once, in the tui verdict
     * chain, immediately before the settle this must outrank. Asserted here so
     * the anchor cannot silently acquire a second occurrence.
     */
    expect(SUPERVISOR.split('type: "tui_turn_ended"')).toHaveLength(2);
    const check = SUPERVISOR.indexOf("readProseLoop(sinceDispatch)");
    const tuiVerdict = SUPERVISOR.indexOf('type: "tui_turn_ended"');
    expect(check).toBeGreaterThan(-1);
    expect(tuiVerdict).toBeGreaterThan(-1);
    expect(check).toBeLessThan(tuiVerdict);
  });

  test("the settle reason is the exported constant, not a second spelling of it", () => {
    expect(PROSE_LOOP_REASON).toBe("transcript_prose_loop");
    expect(SUPERVISOR).toContain("PROSE_LOOP_REASON");
    expect(SUPERVISOR).not.toContain('"transcript_prose_loop"');
  });
});
