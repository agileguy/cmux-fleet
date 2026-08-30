/**
 * ISC-367 — the worker's prompt carries the task id and outbox it was
 * dispatched under. DELIVERY ONLY: it names the values, it does not add an
 * instruction. An earlier version told the worker to write its envelope to the
 * outbox and took ISC-290's live chain from `complete` to `partial`, because a
 * worker that had been writing NO envelope started writing a malformed one —
 * and a refused envelope degrades the harvest where a missing one does not.
 * The repair for an unbindable placeholder is the value, not another
 * imperative; `SKILL.md` is mounted and already carries the instruction.
 *
 * ## The measurement this exists because of
 *
 * ISC-349 recorded a ticketing worker writing its output to
 * `/outbox/list-tickets-2026-08-29/` — a slug of the job it thought it had
 * done, plus the date — while the id it was dispatched under was
 * `my-iteration-2`. Both shipped documents already told it to use
 * `<task-id>`. It was graded `[~]` because what shipped in response was
 * INSTRUCTION, and an instruction is not a mechanism.
 *
 * The re-read on 2026-08-30 found the instruction was not merely weak, it was
 * **unfollowable**, and that all three routes to the value were closed:
 *
 * - `renderPrompt` took `title`, `brief` and `acceptance` and nothing else, so
 *   `task_id` and `outbox` sat in the envelope and never reached the agent.
 * - `PIFLEET_TASK_ID` was set nowhere in production. ISC-362 fixed that for the
 *   verbgate's LEDGER, by mounting a file the gate reads — the agent still
 *   never sees it.
 * - `materialize.ts` creates only the worker-level directory that becomes the
 *   `/outbox` mount, so `<outbox>/<task-id>` cannot be discovered by listing.
 *
 * A worker asked for a path whose middle component it had no route to, by any
 * means available to it, was going to guess. The document was asking for
 * something the system did not supply — the same shape as §5.10, found in the
 * one place where the reader is an agent rather than a person.
 *
 * ## What this test does and does not prove
 *
 * It proves DELIVERY: the value the supervisor dispatched appears in the text
 * the worker is prompted with. It cannot prove OBEDIENCE, and nothing at unit
 * speed can — that is why ISC-349 stays `[~]` and this is filed separately
 * rather than closing it. What changes is that the failure mode is now
 * disobedience rather than impossibility, and only the first of those is the
 * worker's to fix.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { functionBody, stripComments } from "../support/source-structure.ts";
import { renderPrompt } from "../../src/supervisor/index.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUPERVISOR = stripComments(readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8"));

describe("renderPrompt delivers the identifiers the shipped documents ask a worker to bind", () => {
  const body = functionBody(SUPERVISOR, "renderPrompt");

  test("the function is still findable — the probe has not rotted", () => {
    expect(body, "renderPrompt not found in src/supervisor/index.ts").not.toBeNull();
  });

  test("it reads task_id and outbox off the envelope, not just title/brief/acceptance", () => {
    // Both must be INTERPOLATED, not merely named in the signature: a
    // parameter that is destructured and dropped is exactly the shape of the
    // defect this closes.
    expect(body!).toMatch(/\$\{envelope\.task_id\}/);
    expect(body!).toMatch(/\$\{envelope\.outbox\}/);
  });

  test("the rendered text contains the dispatched values verbatim", async () => {
    // Imported and called, not re-implemented: a local copy of the template
    // would drift from the shipped one and the test would keep passing over a
    // prompt nobody sends.
    const rendered = renderPrompt({
      title: "List the open tickets",
      brief: "Do the thing.",
      acceptance: ["a ticket-ops pair exists"],
      task_id: "my-iteration-2",
      outbox: "/outbox/my-iteration-2",
    });

    // The literal id, not a slug of the title — the failure ISC-349 measured
    // was a worker inventing `list-tickets-2026-08-29` from the title.
    expect(rendered).toContain("my-iteration-2");
    expect(rendered).toContain("/outbox/my-iteration-2");
    expect(rendered).toContain("List the open tickets");
    expect(rendered).toContain("Do the thing.");
  });

  test("the identifiers are fenced, so a skimming model cannot read them as brief prose", () => {
    const rendered = renderPrompt({
      title: "t",
      brief: "b",
      acceptance: [],
      task_id: "t-1",
      outbox: "/outbox/t-1",
    });
    // A PAIR of fences, and both identifiers between them. The first version
    // of this assertion took `indexOf("```")` and was satisfied by the CLOSING
    // fence alone, so deleting the opening one left it green — and it checked
    // only `task_id`, so moving `outbox` out of the block was invisible too.
    // Both found by mutating, neither by reading.
    const fences = [...rendered.matchAll(/```/g)].map((m) => m.index!);
    expect(fences.length, "the identity block must be fenced open AND closed").toBe(2);
    const block = rendered.slice(fences[0]!, fences[1]!);
    expect(block).toContain("t-1");
    expect(block).toContain("/outbox/t-1");
  });

  test("the brief still leads — identity is appended, never prepended", () => {
    const rendered = renderPrompt({
      title: "t",
      brief: "THE-BRIEF",
      acceptance: [],
      task_id: "t-1",
      outbox: "/outbox/t-1",
    });
    // A worker reads top-down under a budget. Pushing the brief below a block
    // of metadata is a behavioural change nobody asked for.
    expect(rendered.indexOf("THE-BRIEF")).toBeLessThan(rendered.indexOf("task_id:"));
  });
});
