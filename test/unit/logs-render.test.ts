/**
 * `pifleet logs --render` line rendering.
 *
 * The renderer is total: it runs inside a pane over a file a worker's output
 * is mirrored into, so any input a worker can produce — malformed JSON, a
 * half-written record, an escape sequence, a megabyte on one line — must
 * come out as a bounded, legible, terminal-safe string rather than a crash.
 * A renderer that can be crashed by stream content is a denial-of-view any
 * worker could trigger.
 */

import { describe, expect, test } from "bun:test";
import { renderEventLine } from "../../src/cli/commands/logs.ts";

const line = (rec: unknown): string => JSON.stringify(rec);

const ESC = String.fromCharCode(0x1b);

describe("renderEventLine — known shapes", () => {
  test("a wrapped RPC event renders what HAPPENED, not the event's name", () => {
    // It used to render `12:03:44 event #12 agent_start` — the wrapper's own
    // type and sequence number, with whatever the event carried thrown away.
    // See the `message_update` block below for what that cost in practice.
    const out = renderEventLine(
      line({
        ts: "2026-07-27T12:03:44.120Z",
        type: "event",
        seq: 12,
        event: { type: "agent_start" },
      }),
    );
    expect(out).toBe("12:03:44 ▶▶ agent started");
  });

  test("message_update is SUPPRESSED — it is the flood, and it carries nothing new", () => {
    /*
     * MEASURED on a live ticketing task: 5,429 events, of which 5,220 rendered
     * to nothing under this rule and 209 survived. The suppressed majority were
     * `message_update` — TOKEN-LEVEL deltas of a partially-built assistant
     * message — and the old renderer printed one line per delta carrying the
     * event's NAME and none of its content. The pane scrolled furiously and
     * said nothing about what the agent was doing.
     *
     * Dropping them loses NO information: the complete content of every delta
     * arrives again, assembled, on `turn_end`. That is the property that makes
     * this a suppression rather than a truncation, and it is why the two are
     * tested together.
     */
    expect(
      renderEventLine(
        line({
          ts: "2026-07-27T12:03:44Z",
          type: "event",
          seq: 13,
          event: { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
        }),
      ),
    ).toBeNull();
  });

  test("turn_end renders the assistant's thinking and text — the assembled message", () => {
    const out = renderEventLine(
      line({
        ts: "2026-07-27T12:03:44Z",
        type: "event",
        event: {
          type: "turn_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should read the skill first." },
              { type: "text", text: "Reading the skill." },
              // A toolCall part is deliberately NOT rendered here: the same
              // call arrives as `tool_execution_start` WITH its arguments, and
              // printing both puts every command on the pane twice.
              { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
            ],
          },
        },
      }),
    );
    expect(out).toBe(
      "12:03:44 · I should read the skill first.\n12:03:44 » Reading the skill.",
    );
  });

  test("a tool call renders its ARGUMENT, not the args object", () => {
    // `bash` is where these workers spend their time and the command is the
    // whole story. Rendering `{"command":"…"}` buries a 200-character curl in
    // JSON quoting, which is the difference between a readable pane and a
    // wall of escapes.
    const out = renderEventLine(
      line({
        ts: "2026-07-27T12:03:44Z",
        type: "event",
        event: {
          type: "tool_execution_start",
          toolName: "bash",
          args: { command: "curl -sS https://example.invalid/defect" },
        },
      }),
    );
    expect(out).toBe("12:03:44 ▶ bash  curl -sS https://example.invalid/defect");
  });

  test("a tool result renders its OUTPUT, and an empty one says so", () => {
    const withText = renderEventLine(
      line({
        ts: "2026-07-27T12:03:45Z",
        type: "event",
        event: {
          type: "tool_execution_end",
          toolName: "bash",
          result: { content: [{ type: "text", text: "TotalResultCount: 8" }] },
        },
      }),
    );
    expect(withText).toBe("12:03:45 ✔ bash  TotalResultCount: 8");

    // Reported as empty rather than omitted: a tool that returned nothing and
    // a tool whose output this renderer failed to find look identical
    // otherwise, and the first is a real finding.
    const empty = renderEventLine(
      line({
        ts: "2026-07-27T12:03:45Z",
        type: "event",
        event: { type: "tool_execution_end", toolName: "bash", result: { content: [] } },
      }),
    );
    expect(empty).toBe("12:03:45 ✔ bash  (no output)");
  });

  test("an UNKNOWN event type still appears, by name", () => {
    // Pi is a moving target. Silently dropping what this build has not seen is
    // how a pane starts omitting the one event that mattered — and the
    // suppression list above makes that a live risk rather than a theoretical
    // one, because dropping is now a thing this function does.
    const out = renderEventLine(
      line({ ts: "2026-07-27T12:03:44Z", type: "event", event: { type: "brand_new_thing" } }),
    );
    expect(out).toBe("12:03:44 · brand_new_thing");
  });

  test("a settle renders task, epoch, verdict and reason", () => {
    const out = renderEventLine(
      line({
        ts: "2026-07-27T12:05:01Z",
        type: "settled",
        task_id: "T-004",
        epoch: 3,
        verdict: "success",
        reason: "clean diff",
      }),
    );
    expect(out).toContain("12:05:01");
    expect(out).toContain("T-004");
    expect(out).toContain("epoch 3");
    expect(out).toContain("success");
    expect(out).toContain("clean diff");
    // Legible lines, not raw JSON — the point of the flag.
    expect(out?.startsWith("{")).toBe(false);
  });

  test("a stderr mirror shows the worker's line", () => {
    const out = renderEventLine(
      line({ ts: "2026-07-27T12:00:00Z", type: "stderr_line", line: "warning: probe flapped" }),
    );
    expect(out).toContain("stderr");
    expect(out).toContain("warning: probe flapped");
  });

  test("an unknown event type still renders its type and compact detail", () => {
    const out = renderEventLine(
      line({ ts: "2026-07-27T12:00:00Z", type: "deadline_exceeded", task_id: "T-9", epoch: 1 }),
    );
    expect(out).toContain("deadline_exceeded");
    expect(out).toContain("T-9");
  });

  test("a record without a timestamp renders with a placeholder, not a crash", () => {
    const out = renderEventLine(line({ type: "settled", task_id: "T-1", verdict: "failed" }));
    expect(out).toContain("--:--:--");
    expect(out).toContain("failed");
  });
});

describe("renderEventLine — hostile and degenerate input", () => {
  test("blank lines render as nothing", () => {
    expect(renderEventLine("")).toBeNull();
    expect(renderEventLine("   ")).toBeNull();
  });

  test("malformed JSON is returned as text, not thrown", () => {
    expect(renderEventLine("not json at all")).toBe("not json at all");
  });

  test("a half-written record — normal when tailing an append-only file — does not crash", () => {
    // The splitter usually withholds the partial last line, but the renderer
    // must survive one anyway.
    const out = renderEventLine('{"ts":"2026-07-27T12:00:00Z","type":"even');
    expect(typeof out).toBe("string");
  });

  test("JSON that is not an object renders as its raw text", () => {
    expect(renderEventLine("42")).toBe("42");
    expect(renderEventLine('"just a string"')).toBe('"just a string"');
    expect(renderEventLine("[1,2,3]")).toBe("[1,2,3]");
  });

  test("escape sequences in worker-authored text are neutralized", () => {
    // stderr_line carries worker-controlled bytes. ESC [2J clears the
    // operator's screen; rendered raw it would let a worker forge or destroy
    // what the pane shows — the ISC-245 failure class on a different surface.
    const out = renderEventLine(
      line({ ts: "2026-07-27T12:00:00Z", type: "stderr_line", line: `ok${ESC}[2Jgone` }),
    );
    expect(out).not.toContain(ESC);
    expect(out).toContain("�");
    expect(out).toContain("ok");
    expect(out).toContain("gone");
  });

  test("escape sequences survive even in malformed non-JSON lines", () => {
    const out = renderEventLine(`garbage ${ESC}]0;owned${ESC} more`);
    expect(out).not.toContain(ESC);
    expect(out).toContain("�");
  });

  test("a huge payload is clipped to a pane-legible length", () => {
    const out = renderEventLine(
      line({ ts: "2026-07-27T12:00:00Z", type: "stderr_line", line: "x".repeat(100_000) }),
    );
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(400);
    expect(out).toContain("…");
  });
});
