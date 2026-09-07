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
import {
  TRIAGE_DOCUMENT_SCHEMA,
  parseTriageDocument,
} from "../../src/run/triage-document.ts";
import { TRIAGE_NOTE_MAX_BYTES } from "../../src/run/triage-verdict.ts";

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

/**
 * ── EVERY WORKED EXAMPLE IN THIS FILE HAS A REAL PARSER BEHIND IT ───────────
 *
 * **ISC-658's lesson, made machine-checkable rather than remembered.** §7.5's own
 * erratum records the shape of the miss: *"Task 5.1b fixed the request example in
 * the same file and did not look at the rest of it … a schema change obliges an
 * audit of every worked example a container reads, not of the one that prompted
 * the change."* Both of this document's examples are now graded — the fan-out
 * request above, and the `triage.json` below — but nothing stopped a THIRD example
 * being added with no parser behind it, which is the same defect returning through
 * a door nobody watched.
 *
 * So the census is asserted: exactly two fenced JSON blocks, each carrying a
 * schema tag this repository can parse, and no block carrying neither. A new
 * example fails here and names itself, and the fix is to grade it rather than to
 * raise a number.
 */
describe("every fenced JSON example is a document some real parser accepts", () => {
  const GRADED_TAGS = [DISPATCH_REQUEST_SCHEMA, TRIAGE_DOCUMENT_SCHEMA];

  test("there are exactly two, and every one of them declares a graded schema", () => {
    const blocks = jsonBlocks();
    expect(blocks).toHaveLength(2);

    const ungraded = blocks.filter((b) => !GRADED_TAGS.some((tag) => b.includes(tag)));
    expect(
      ungraded.map((b) => b.slice(0, 80)),
      "a fenced JSON example in roles/triage.md declares no schema this repository parses; " +
        "grade it rather than widening this assertion",
    ).toEqual([]);

    // And each tag is used ONCE, so two blocks carrying the same tag — a copied
    // example that drifted — is not mistaken for full coverage.
    for (const tag of GRADED_TAGS) {
      expect(blocks.filter((b) => b.includes(tag))).toHaveLength(1);
    }
  });

  /**
   * The `triage.json` example, through the real schema. `triage-document.test.ts`
   * grades its CONTENTS field by field; this asserts only that it parses, so that
   * the census above is a claim about acceptance rather than about a tag string.
   */
  test("the triage.json example parses under §7.5's schema", () => {
    const body = jsonBlocks().find((b) => b.includes(TRIAGE_DOCUMENT_SCHEMA))!;
    const got = parseTriageDocument(body, {
      worker: TRIAGE_CONSOLE_ROSTER.collators[0]!,
      path: "roles/triage.md#triage.json",
    });
    if (got.kind !== "ok") {
      throw new Error(
        `roles/triage.md's triage.json example is refused ${got.code}: ` +
          got.issues.map((i) => `${i.path} ${i.fault}`).join("; "),
      );
    }
    expect(got.document.services.length).toBeGreaterThan(1);
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

/**
 * ── §13 TASK 5.8's PROMPT EDIT, WHICH THE SCHEMA CHANGE OBLIGED ─────────────
 *
 * ISC-651's rule, and this file exists because of it: **a field obliges the
 * model-facing prompt edit regardless of what the wire tag does.** A `note` the
 * host accepts and the document never mentions is a field no worker writes; a
 * `note` the document describes with the wrong bound is a document that instructs
 * a worker to write a file the host refuses.
 *
 * Four claims are graded, and each is one a model ACTS on. The judgement in the
 * surrounding prose is not checkable and is not checked.
 */
describe("the document teaches `note`, and teaches it the way the host enforces it", () => {
  /**
   * THE BOUND, READ FROM THE CODE. A document naming `2000` against a schema
   * enforcing 4,000 teaches a worker to truncate for no reason; one naming
   * `40000` teaches it to write a document that is refused whole. Either way the
   * number in the prose is a claim about this host, so it is compared to this
   * host.
   */
  test("the enforced byte bound in the prose is the one the schema enforces", () => {
    expect(ROLE).toContain(String(TRIAGE_NOTE_MAX_BYTES));
    // In BYTES, said in the document rather than left for a worker to assume —
    // the distinction is invisible until a note of accented text is refused.
    expect(ROLE).toContain("**Bytes, not characters**");
  });

  /**
   * The anti-claim, and it is the one a helpful model is most likely to violate:
   * a note is not evidence and repairs no gap. §6.7 rule 2 grades structure
   * precisely so that a check cannot be satisfied by writing about it.
   */
  test("the prose says a note substitutes for none of the four evidence fields", () => {
    expect(ROLE).toContain("it is not evidence, and it substitutes for nothing above it");
    expect(ROLE).toContain("`coverage`, `selector`, `window` and `evidence_ref` and does");
  });

  /**
   * The containment promise, which this field is what makes non-vacuous.
   *
   * Before task 5.8 the section said prose *"travels inside a marked evidence
   * block"* while the document had no prose field, so the sentence described a
   * mechanism nothing could reach. It now names the field, and it names the two
   * mechanical facts a worker needs in order to trust it: the block is banner-
   * delimited and EVERY line inside it is prefixed.
   */
  test("the notification section names the one field that travels, and how", () => {
    expect(ROLE).toContain("Exactly one string you write can travel with that message");
    expect(ROLE).toContain("prefixes **every** line of it");
    // The old sentence promised this for prose in general and named no field. If
    // it comes back, the promise is vacuous again. Asserted as a single line so
    // the check is about the wording rather than about where the wrap fell.
    expect(ROLE).not.toContain("prose that travels with it travels inside a marked evidence block");
  });

  /**
   * And the smuggling route the field opens, closed in the two places a model
   * reads: the field rules, and the section on who is told. A severity written as
   * a sentence is the same document arguing for the same decision, and it is
   * harder to refuse because a schema cannot see it.
   */
  test("the no-severity rule is restated for prose, where a schema cannot enforce it", () => {
    expect(ROLE).toContain("The `note` field does not reopen this");
    expect(ROLE).toContain("**`note` is now that place, so");
  });
});
