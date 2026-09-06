/**
 * `roles/triage.md` says only things that are true — `collator-role.test.ts`'s
 * discipline, applied to the second role document that describes a wire format.
 *
 * ## Why this file exists, and it is not hypothetical either
 *
 * SRD-TRIAGE-CONSOLE §7.3 was settled on 2026-09-06 by growing the fan-out
 * request a `services` field, required on this console. The reasoning recorded
 * there weighed the cost of bumping the wire tag — *"an edit to a model-facing
 * prompt with no test"* — and got the tag right while missing the consequence:
 * **the field obliges that prompt edit regardless of the tag.** For the length of
 * one round this document showed a request with no `services` key and said
 * *"`worker`, `title` and `brief`, and nothing else"*, which is a document that
 * instructs the worker to write a file the host refuses `services_missing` on the
 * first sweep.
 *
 * Nothing could have caught that. Phase 5 is host-side; the schema's own tests
 * pass because they construct their fixtures in TypeScript; and `roles/` is read
 * by a container, never by `tsc`. It is ISC-600's gap in a second directory —
 * *"a `SKILL.md` that is wrong is an instruction executed by an agent that cannot
 * push back"* — and the same answer applies: parse the document's own example
 * through the real parser, so prose and schema cannot drift apart silently.
 *
 * ## What is checkable here
 *
 * The example document, and the two claims around it that a model acts on. The
 * judgement in the rest of the file is not checkable and is not checked.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DISPATCH_REQUEST_FILE,
  DISPATCH_REQUEST_SCHEMA,
  TRIAGE_CONSOLE_ROSTER,
  parseDispatchRequest,
} from "../../src/run/dispatch-request.ts";

const ROLE = readFileSync(join(import.meta.dir, "..", "..", "roles", "triage.md"), "utf8");

/** Every fenced JSON block, in document order. */
function jsonBlocks(): string[] {
  return [...ROLE.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/**
 * The example's own `parent_task_id`, read out of the document rather than
 * restated here.
 *
 * `parseDispatchRequest` requires the body's `parent_task_id` to equal the
 * directory it was written into, so a test spelling its own id would pass while
 * the document drifted — the exact class of failure this file exists for.
 */
function declaredParentTaskId(body: string): string {
  const parsed = JSON.parse(body) as { parent_task_id?: unknown };
  if (typeof parsed.parent_task_id !== "string") {
    throw new Error("the example carries no parent_task_id; the document is broken, not this test");
  }
  return parsed.parent_task_id;
}

describe("the fan-out example is a document the real parser accepts", () => {
  test("there is exactly one fan-out example to grade", () => {
    const withSchema = jsonBlocks().filter((b) => b.includes(DISPATCH_REQUEST_SCHEMA));
    expect(withSchema).toHaveLength(1);
  });

  /**
   * The whole point. An example that does not validate is worse than no example,
   * because a model copies its shape confidently.
   */
  test("it parses under the TRIAGE roster, which is the one that requires services", () => {
    const body = jsonBlocks().find((b) => b.includes(DISPATCH_REQUEST_SCHEMA))!;
    const read = parseDispatchRequest(body, {
      sender: TRIAGE_CONSOLE_ROSTER.collators[0]!,
      taskId: declaredParentTaskId(body),
      roster: TRIAGE_CONSOLE_ROSTER,
    });
    if (read.kind !== "ok") {
      throw new Error(
        `roles/triage.md's example is refused ${read.kind === "refused" ? read.code : read.kind}: ` +
          `${read.kind === "refused" ? read.reason : ""}`,
      );
    }
    expect(read.request.requests).toHaveLength(TRIAGE_CONSOLE_ROSTER.reviewers.length);
  });

  /**
   * The anti-criterion, and it is the one that makes the test above mean
   * something. A parser that accepted anything would pass that test; a document
   * that had merely gained the WORD `services` in prose would too. This asserts
   * the example's own bytes carry the field on every request, so deleting it from
   * one line reddens.
   */
  test("every request in the example carries its own share", () => {
    const body = jsonBlocks().find((b) => b.includes(DISPATCH_REQUEST_SCHEMA))!;
    const parsed = JSON.parse(body) as { requests: { worker: string; services?: unknown }[] };
    for (const r of parsed.requests) {
      expect(Array.isArray(r.services)).toBe(true);
    }
    expect(parsed.requests.map((r) => r.worker)).toEqual([...TRIAGE_CONSOLE_ROSTER.reviewers]);
  });

  /**
   * The partition the example draws is a real one — three observers, five
   * services, no repeats. Asserted BY VALUE across the union, because a fixture
   * where every observer holds the same count is one a `sort`, a `Set` or a
   * `reverse` all survive, and this document is the thing a model copies.
   */
  test("the example's shares are disjoint and its union is asserted by name", () => {
    const body = jsonBlocks().find((b) => b.includes(DISPATCH_REQUEST_SCHEMA))!;
    const parsed = JSON.parse(body) as { requests: { services: string[] }[] };
    const union = parsed.requests.flatMap((r) => r.services);
    expect(union).toEqual(["routing", "ingest", "authorization", "telemetry", "alert-db"]);
    expect(new Set(union).size).toBe(union.length);
    expect(parsed.requests.map((r) => r.services.length)).toEqual([2, 1, 2]);
  });
});

describe("the prose around the example does not contradict it", () => {
  /**
   * The sentence this file was written because of. Asserted by ABSENCE of the old
   * wording and PRESENCE of the new, because the failure mode is a document that
   * lists the field in JSON and then tells the model in English not to send it.
   */
  test("the field list in prose names services", () => {
    expect(ROLE).toContain("`worker`, `title`, `brief` and `services`");
    expect(ROLE).not.toContain("`worker`, `title` and `brief`, and **nothing else**");
  });

  test("the refusal a dropped field earns is named where the model will look", () => {
    expect(ROLE).toContain("services_missing");
  });

  test("the fan-out file is still named as the poller spells it", () => {
    expect(ROLE).toContain(`/outbox/<task-id>/${DISPATCH_REQUEST_FILE}`);
  });
});
