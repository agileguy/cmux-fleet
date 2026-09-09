/**
 * ISC-1126 — the `tui` plane's loop detector.
 *
 * ## What these tests can and cannot prove
 *
 * They grade `readToolLoop` as a fold over entries: what counts as identical,
 * where a streak breaks, and that the bound is where the measurement put it.
 * **They cannot prove the supervisor calls it.** That is not a hedge, it is the
 * specific way this class of module has shipped broken here before — a complete,
 * well-argued file with five green tests and no caller — so the wiring is graded
 * at the outermost surface instead, by a real supervisor settling a real task
 * record in `test/integration/tui-transcript-activity.test.ts`. Deleting the
 * call site leaves everything in THIS file green.
 */

import { describe, expect, test } from "bun:test";

import type { TreeEntry } from "../../src/harvest/transcript.ts";
import {
  TOOL_LOOP_REASON,
  TOOL_LOOP_THRESHOLD,
  isToolLoop,
  readToolLoop,
} from "../../src/supervisor/tool-loop.ts";

let seq = 0;

/** One assistant entry carrying the given tool calls, in the shape Pi writes. */
function calls(...cs: Array<{ name: string; arguments: unknown }>): TreeEntry {
  seq++;
  return {
    type: "message",
    id: `e${seq}`,
    parentId: seq === 1 ? null : `e${seq - 1}`,
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: cs.map((c, i) => ({ type: "toolCall", id: `c${seq}-${i}`, ...c })),
    },
  } as unknown as TreeEntry;
}

/** A bash call on one command string — the shape both measured loops took. */
function bash(command: string): TreeEntry {
  return calls({ name: "bash", arguments: { command } });
}

/** N assistant entries all running the same command, back to back. */
function repeated(command: string, n: number): TreeEntry[] {
  return Array.from({ length: n }, () => bash(command));
}

/** A non-assistant entry — a tool result, which is what sits between calls. */
function result(): TreeEntry {
  seq++;
  return {
    type: "message",
    id: `e${seq}`,
    parentId: `e${seq - 1}`,
    message: { role: "toolResult", toolCallId: "c0-0", content: "ok" },
  } as unknown as TreeEntry;
}

describe("readToolLoop counts CONSECUTIVE identical calls (ISC-1126)", () => {
  test("an epoch with no entries has no streak and names no call", () => {
    expect(readToolLoop([])).toEqual({ streak: 0, call: null });
  });

  test("a single call is a streak of one, and one is not a repeat", () => {
    const r = readToolLoop([bash("kubectl get pods -n x")]);
    expect(r.streak).toBe(1);
    // Naming a call that never repeated would send an operator looking for a
    // loop that is not there.
    expect(r.call).toBeNull();
  });

  test("four of the same command back to back is a streak of four", () => {
    const r = readToolLoop(repeated("kubectl get pods -n x", 4));
    expect(r.streak).toBe(4);
    expect(r.call).toContain("kubectl get pods -n x");
  });

  test("tool results between the calls do not break the streak", () => {
    // The real shape: every one of the 111 measured calls SUCCEEDED, so a
    // result entry sits between each pair. A fold that reset on any
    // non-assistant entry would read 1 for ever and never fire.
    const entries: TreeEntry[] = [];
    for (let i = 0; i < 5; i++) entries.push(bash("kubectl get svc"), result());
    expect(readToolLoop(entries).streak).toBe(5);
  });

  test("the same tool with DIFFERENT arguments is not a repeat", () => {
    const r = readToolLoop([bash("kubectl get pods -n a"), bash("kubectl get pods -n b")]);
    expect(r.streak).toBe(1);
    expect(r.call).toBeNull();
  });

  test("the same arguments under a DIFFERENT tool is not a repeat", () => {
    const r = readToolLoop([
      calls({ name: "bash", arguments: { path: "/policy/dispatch" } }),
      calls({ name: "read", arguments: { path: "/policy/dispatch" } }),
    ]);
    expect(r.streak).toBe(1);
  });

  test("identical calls batched into ONE assistant message still count", () => {
    // The batching is the model's formatting choice; the seat repeated itself
    // three times either way.
    const r = readToolLoop([
      calls(
        { name: "bash", arguments: { command: "date" } },
        { name: "bash", arguments: { command: "date" } },
        { name: "bash", arguments: { command: "date" } },
      ),
    ]);
    expect(r.streak).toBe(3);
  });

  /**
   * THE ASYMMETRIC FIXTURE.
   *
   * Every other case here would stay green if `readToolLoop` counted the
   * CUMULATIVE occurrences of the commonest call instead of its longest run,
   * because in all of them the two numbers are equal. This one separates them:
   * `A` occurs 12 times — over the threshold — but never twice in a row.
   *
   * That is a seat working in a think-probe-think-probe rhythm around one
   * anchor command, which is normal diagnostic behaviour and must not be
   * killed. A degenerate battery would have shipped the cumulative rule and
   * reported a clean sweep.
   */
  test("a call repeated 12 times but never twice in a row does NOT trip", () => {
    const entries: TreeEntry[] = [];
    for (let i = 0; i < 12; i++) {
      entries.push(bash("kubectl get pods -n aodapnc-prometheus-dev"));
      entries.push(bash(`kubectl logs pod-${i}`));
    }
    const r = readToolLoop(entries);
    expect(r.streak).toBe(1);
    expect(isToolLoop(r)).toBe(false);
  });

  test("a broken streak restarts rather than accumulating", () => {
    // A A A B A A A peaks at 3, not 6.
    const r = readToolLoop([
      ...repeated("A", 3),
      bash("B"),
      ...repeated("A", 3),
    ]);
    expect(r.streak).toBe(3);
  });

  test("the LONGEST run wins, not the last one", () => {
    const r = readToolLoop([...repeated("A", 7), bash("B"), ...repeated("C", 2)]);
    expect(r.streak).toBe(7);
    expect(r.call).toContain("A");
  });

  test("non-assistant entries carrying toolCall-shaped content are ignored", () => {
    // A user message quoting a tool call back is not the seat calling it.
    seq++;
    const userEcho = {
      type: "message",
      id: `e${seq}`,
      parentId: null,
      message: {
        role: "user",
        content: [{ type: "toolCall", id: "u1", name: "bash", arguments: { command: "A" } }],
      },
    } as unknown as TreeEntry;
    expect(readToolLoop([bash("A"), userEcho, bash("A")]).streak).toBe(2);
  });
});

describe("the threshold sits in the gap the fleet's own transcripts measured", () => {
  /**
   * Measured 2026-09-09 over every session transcript under `~/.pifleet/runs`
   * on the operator's host — the numbers are in `tool-loop.ts`'s header table.
   * These two constants are the edges of the separation, and the test is what
   * makes the bound falsifiable rather than a number someone liked.
   */
  const WORST_HEALTHY_STREAK = 11;
  const MILDEST_MEASURED_LOOP = 108;

  test("above every streak a DELIVERING sweep has ever produced", () => {
    expect(TOOL_LOOP_THRESHOLD).toBeGreaterThan(WORST_HEALTHY_STREAK);
  });

  test("below the mildest loop that ran an epoch to its deadline", () => {
    expect(TOOL_LOOP_THRESHOLD).toBeLessThan(MILDEST_MEASURED_LOOP);
  });

  test("both measured loops trip it and the worst healthy sweep does not", () => {
    expect(isToolLoop(readToolLoop(repeated("x", 111)))).toBe(true);
    expect(isToolLoop(readToolLoop(repeated("x", 108)))).toBe(true);
    expect(isToolLoop(readToolLoop(repeated("x", WORST_HEALTHY_STREAK)))).toBe(false);
  });

  test("the trip is at the threshold itself, not one past it", () => {
    expect(isToolLoop({ streak: TOOL_LOOP_THRESHOLD - 1, call: "x" })).toBe(false);
    expect(isToolLoop({ streak: TOOL_LOOP_THRESHOLD, call: "x" })).toBe(true);
  });
});

describe("the settle reason is the one the supervisor writes", () => {
  test("it carries the transcript_ prefix every tui reason carries", () => {
    // An operator triaging a tui settle greps this prefix; a reason outside it
    // would be invisible to them.
    expect(TOOL_LOOP_REASON.startsWith("transcript_")).toBe(true);
  });

  test("it is distinct from the reason a quiesced or timed-out epoch gets", () => {
    // The whole point is that the diagnosis stops reading as a deadline.
    expect(TOOL_LOOP_REASON).not.toBe("transcript_quiesced");
  });
});
