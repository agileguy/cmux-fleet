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
      worker: "tick-1",
      epoch: 1,
    });

    // The literal id, not a slug of the title — the failure ISC-349 measured
    // was a worker inventing `list-tickets-2026-08-29` from the title.
    expect(rendered).toContain("my-iteration-2");
    expect(rendered).toContain("/outbox/my-iteration-2");
    expect(rendered).toContain("List the open tickets");
    expect(rendered).toContain("Do the thing.");
  });

  test("it delivers worker and epoch, which the ticket-ops schema requires and nothing else supplies", () => {
    // MEASURED 2026-08-30. `TicketOpsArtifactSchema` requires `worker` and
    // `epoch`; the worker's environment carries neither (`env` holds
    // PIFLEET_LLM_*, PIFLEET_SECRET_NAMES, the proxy vars and the two ticket
    // FILE paths, and no worker id at all), and the system-append never names
    // them. Three runs wrote artifacts missing exactly these fields, each
    // clamped to `harvest_status: "partial"` and `verdict: "unknown"`.
    //
    // The same shape as ISC-349's finding, in a third place: a document asking
    // for something the system did not supply. Interpolation is asserted, not
    // just the parameter, because a destructured-and-dropped field is the
    // defect this closes.
    const body = functionBody(SUPERVISOR, "renderPrompt")!;
    expect(body).toMatch(/\$\{envelope\.worker\}/);
    expect(body).toMatch(/\$\{envelope\.epoch\}/);

    const rendered = renderPrompt({
      title: "t",
      brief: "b",
      acceptance: [],
      task_id: "t-1",
      outbox: "/outbox/t-1",
      worker: "tick-7",
      epoch: 3,
    });
    expect(rendered).toContain("tick-7");
    expect(rendered).toContain("epoch:   3");
  });

  test("the DISPATCHED epoch is rendered, never the envelope's", () => {
    /*
     * MEASURED 2026-08-30 on the first live ticketing run after this criterion
     * put the identifiers in the prompt. The call site was
     * `renderPrompt(envelope)`, so the prompt carried `envelope.epoch` — the
     * value the CALLER put on the task envelope, which for every `dispatch` is
     * the schema default of 0. The epoch a task actually runs under is
     * allocated by the supervisor and is what goes on the wire
     * (`epoch: decision.epoch`) and what the harvester validates against.
     *
     * The prompt said `epoch: 0`. The worker did exactly as it was told and
     * wrote `"epoch": 0`. The harvest refused it — "envelope epoch 0 is stale
     * (expected 1)" — clamping a task that had produced a correct, fully-paged
     * answer to `verdict=unknown`.
     *
     * THIS CRITERION'S OWN LESSON, landing on this criterion: the repair for
     * an unbindable placeholder is the VALUE, and a value delivered but WRONG
     * is worse than one missing, because the worker has no way to doubt it. A
     * missing epoch produced no envelope; a wrong one produces a REFUSED
     * envelope, and a refused envelope degrades the harvest where an absent one
     * does not.
     *
     * Pinned at the CALL SITE, because that is where the defect was — the
     * function was always correct, it was handed the wrong number. A test that
     * only calls `renderPrompt` with good input cannot see this, which is why
     * every existing test in this file stayed green through the whole failure.
     */
    const body = functionBody(SUPERVISOR, "handleDispatch") ?? SUPERVISOR;
    // Spread-then-override: the envelope supplies title/brief/acceptance and
    // the supervisor supplies the epoch it actually allocated.
    expect(body).toMatch(/renderPrompt\(\{\s*\.\.\.envelope,\s*epoch:\s*decision\.epoch\s*\}\)/);
    // …and NOT the bare form. Asserting the absence too, because the fix and
    // the defect can coexist — a second `renderPrompt(envelope)` elsewhere on
    // the dispatch path would restore it with this test still green.
    expect(SUPERVISOR).not.toMatch(/renderPrompt\(envelope\)/);
  });

  test("the identifiers are fenced, so a skimming model cannot read them as brief prose", () => {
    const rendered = renderPrompt({
      title: "t",
      brief: "b",
      acceptance: [],
      task_id: "t-1",
      outbox: "/outbox/t-1",
      worker: "w-1",
      epoch: 0,
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
    // All four, not the original two: a field moved out of the block is
    // invisible to a check that only knows about the ones that shipped first.
    expect(block).toContain("w-1");
    expect(block).toContain("epoch:");
  });

  test("the brief still leads — identity is appended, never prepended", () => {
    const rendered = renderPrompt({
      title: "t",
      brief: "THE-BRIEF",
      acceptance: [],
      task_id: "t-1",
      outbox: "/outbox/t-1",
      worker: "w-1",
      epoch: 0,
    });
    // A worker reads top-down under a budget. Pushing the brief below a block
    // of metadata is a behavioural change nobody asked for.
    expect(rendered.indexOf("THE-BRIEF")).toBeLessThan(rendered.indexOf("task_id:"));
  });
});
