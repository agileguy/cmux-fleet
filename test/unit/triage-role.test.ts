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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchRequest, type DispatchRequestParams } from "../../docker/pi-extensions/report-tools.ts";

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
import { OBSERVER_CONTRACT_HEADING } from "../../src/run/triage-envelope.ts";
import { TRIAGE_NOTE_MAX_BYTES } from "../../src/run/triage-verdict.ts";

const ROLE = readFileSync(join(import.meta.dir, "..", "..", "roles", "triage.md"), "utf8");

/** Every fenced JSON block, in document order. */
function jsonBlocks(): string[] {
  return [...ROLE.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/**
 * A `/policy/task` and an outbox, so the real tool can be driven.
 *
 * `declaredParentTaskId` used to live here, reading the id out of the example
 * because `parseDispatchRequest` compares it against the directory the file sits
 * in — and a test that spelled its own id would pass while the document drifted.
 * That hazard is now the tool's to carry rather than the example's: the id comes
 * from host state on both sides of the comparison, so there is no longer a value
 * in the document that a test could get wrong on its behalf.
 */
const EXAMPLE_TASK_ID = "T-sweep-41";

function policyFixture(worker: string): { dir: string; mounts: { policyPath: string; outboxRoot: string; repliesPolicyPath: string; repliesRoot: string } } {
  const dir = mkdtempSync(join(tmpdir(), "pifleet-triage-role-"));
  const policyPath = join(dir, "policy-task");
  writeFileSync(policyPath, `${EXAMPLE_TASK_ID}\n1\n`);
  const outboxRoot = join(dir, "outbox");
  mkdirSync(outboxRoot, { recursive: true });
  const repliesRoot = join(dir, "replies");
  mkdirSync(repliesRoot, { recursive: true });
  void worker;
  return {
    dir,
    mounts: { policyPath, outboxRoot, repliesPolicyPath: join(dir, "policy-replies"), repliesRoot },
  };
}

/**
 * ## The example stopped being a document and became an ARGUMENT (task 7.3)
 *
 * `dispatch_request` composes `schema` and `parent_task_id` from `/policy/task`,
 * so the role's example must NOT carry them — a model that copied them would be
 * refused by `additionalProperties: false`. Grading it therefore cannot mean
 * "parse this block as a document" any more.
 *
 * **It means something stronger instead**: drive the REAL tool with the block,
 * and parse what the tool wrote with the REAL host parser. The old test proved
 * the example was a well-formed document. This proves the example, passed to
 * the tool the role now names, produces a document the host accepts — which is
 * the property the old one was standing in for.
 */
function fanoutExample(): DispatchRequestParams {
  const block = jsonBlocks().find((b) => b.includes('"requests"'))!;
  return JSON.parse(block) as DispatchRequestParams;
}

describe("the fan-out example is a document the real parser accepts", () => {
  test("there is exactly one fan-out example, and it carries no host-composed field", () => {
    const blocks = jsonBlocks().filter((b) => b.includes('"requests"'));
    expect(blocks).toHaveLength(1);
    // The anti-criterion for this whole rewrite: putting either field back into
    // the example reddens here, because a model copying it would be refused.
    expect(blocks[0]).not.toContain(DISPATCH_REQUEST_SCHEMA);
    expect(blocks[0]).not.toContain("parent_task_id");
  });

  /**
   * The whole point. An example that does not validate is worse than no example,
   * because a model copies its shape confidently.
   */
  test("it parses under the TRIAGE roster, which is the one that requires services", () => {
    const f = policyFixture(TRIAGE_CONSOLE_ROSTER.collators[0]!);
    const out = dispatchRequest(fanoutExample(), f.mounts);
    const body = readFileSync(out.path, "utf8");
    const read = parseDispatchRequest(body, {
      sender: TRIAGE_CONSOLE_ROSTER.collators[0]!,
      taskId: out.taskId,
      roster: TRIAGE_CONSOLE_ROSTER,
    });
    rmSync(f.dir, { recursive: true, force: true });
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
    const parsed = fanoutExample() as { requests: { worker: string; services?: unknown }[] };
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
    const parsed = fanoutExample() as { requests: { services: string[] }[] };
    const union = parsed.requests.flatMap((r) => r.services);
    // ONE observer, so the example is one request naming the whole environment.
    // Disjointness is still asserted — it is now disjointness WITHIN the share,
    // which is what `partition_duplicate` spends itself on.
    expect(union).toEqual(["routing", "ingest", "authorization"]);
    expect(new Set(union).size).toBe(union.length);
    expect(parsed.requests.map((r) => r.services.length)).toEqual([3]);
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
  const GRADED_TAGS = [TRIAGE_DOCUMENT_SCHEMA];

  test("there are exactly two, and every one of them is graded by a real parser", () => {
    const blocks = jsonBlocks();
    expect(blocks).toHaveLength(2);

    // ONE of the two no longer declares a schema and must not: it is
    // `dispatch_request`'s arguments, and the tool composes the tag. It is
    // graded by being DRIVEN, in the describe above, which is why the exemption
    // is spelled as "carries requests[]" and not as "is allowed to be ungraded".
    const graded = blocks.filter(
      (b) => GRADED_TAGS.some((tag) => b.includes(tag)) || b.includes('"requests"'),
    );
    expect(
      blocks.filter((b) => !graded.includes(b)).map((b) => b.slice(0, 80)),
      "a fenced JSON example in roles/triage.md is neither a graded schema nor the " +
        "dispatch_request argument block; grade it rather than widening this assertion",
    ).toEqual([]);

    for (const tag of [...GRADED_TAGS, '"requests"']) {
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

/**
 * The turn-one brief section, after ISC-1136 moved the invariant half of the
 * observer contract from the collator's prose into `composeObserverBrief`.
 *
 * **Why these are checkable when the rest of the file's judgement is not.** Each
 * one is a claim this document makes ABOUT THE HOST — that three named paragraphs
 * arrive appended, under a heading it quotes, carrying things the collator
 * therefore need not write. A model reads that and stops writing them. If the
 * host's side moves and this document does not, the collator obeys a promise
 * nobody is keeping, and `roles/` is read by a container and never by `tsc`.
 */
describe("what the host authors, the collator is no longer told to write (ISC-1136)", () => {
  /**
   * The heading is the load-bearing half of the promise: it is how a model
   * reading only this file recognises the appended block as the host's rather
   * than as prose it forgot writing. Quoted here without the `##` because the
   * document quotes it as a phrase mid-sentence.
   */
  test("the heading this document quotes is the heading the host actually writes", () => {
    expect(ROLE).toContain(OBSERVER_CONTRACT_HEADING.replace(/^#+ /, ""));
  });

  /**
   * The two bullets ISC-1136 removed. They asked the collator to spell field
   * names and restate a closed vocabulary that `freshnessEchoDemand` and
   * `COVERAGE_VOCABULARY_DEMAND` now write on every dispatch — so a brief
   * carrying them spends its words twice and, worse, offers the observer a second
   * spelling to choose from. Asserted as absences because that is the direction
   * the regression comes from: this text was here for weeks and reads as correct.
   */
  test("the brief-composition section no longer demands the echo instruction", () => {
    expect(ROLE).not.toContain(
      "The two field names `sweep_id` and `window_opened_at`, spelled exactly that way",
    );
    expect(ROLE).not.toContain("**Write the field names, not a description of them.**");
  });

  /**
   * And what the collator still owes, which is exactly one thing:
   * `readWindowInstant` quotes the window opening out of the collator's own text
   * rather than out of host state, so this bullet is the only reason the freshness
   * demand can name a value at all. The first-match hazard is named with it —
   * the regex takes the earliest ISO instant in the brief, so a second timestamp
   * written above it silently becomes the contract.
   */
  test("the window instant is still demanded, with the first-match hazard named", () => {
    expect(ROLE).toContain("The instant the observation window opened");
    expect(ROLE).toContain("the host takes the FIRST it finds");
  });
});

/**
 * ISC-1147 — the anti-repeat rule is stated where the failure actually happens.
 *
 * The rule existed before this and did not hold, which is the point of pinning
 * its PLACEMENT rather than its presence: it sat inside the turn-one block
 * (`## YOU HAVE EXACTLY ONE OBSERVER` through `### Turn two`), wrapped in prose
 * about a turn where `/replies` is empty by construction — and both measured
 * loops are turn TWO, reading a reply that is present and complete.
 *
 * A prompt cannot bound a model that has stopped being able to stop; the host's
 * `transcript_tool_loop` check is what actually ends these. This is the cheap
 * half, and it is worth having because the rule was already written and was
 * being read as scoped.
 */
describe("the anti-repeat rule is not scoped to one turn (ISC-1147)", () => {
  /*
   * Whitespace-normalised, because every one of these sentences is longer than
   * the file's wrap column and a raw `toContain` is really an assertion about
   * where the line happens to break. That has already cost this suite one false
   * refusal (ISC-1141's blockquote), and the document's meaning does not depend
   * on its reflow.
   */
  const FLAT = ROLE.replace(/\s+/g, " ");

  test("the rule says outright which turn has broken it", () => {
    expect(FLAT).toContain("it is the rule for every turn you will ever take");
    expect(FLAT).toContain("turn two is where it has actually been broken");
  });

  test("the measured instance is named, not just the review console's", () => {
    expect(FLAT).toContain("twenty times in twenty-five seconds");
    expect(FLAT).toContain("/replies/<child-task-id>.json");
  });

  /**
   * The specific shape both loops had: a reply with no `observations` key. The
   * collator reads observations out of the harvest record's inlined artifact,
   * not out of that field, so an absent one is not a reason to re-read.
   */
  test("a reply short of a field is named as still being the whole answer", () => {
    expect(FLAT).toContain("A reply that is missing a field you expected is still the whole answer");
  });
});

/**
 * The refusal a write-less collator actually hit, on the first live sweep after
 * task 7.3 narrowed the grant (2026-09-10, `T-sweep-77-collate`).
 *
 * `tri-1` composed a correct collation and declared `files/triage.json` in
 * `artifacts` — the sequence it had held for its whole life, and the sequence it
 * still composes into every OBSERVER brief it writes. With no `write` the file
 * did not exist, so `artifactMissingProblem` refused, correctly and with the
 * remedy in the message. The seat then sent the identical call twenty times in
 * six minutes and `readToolLoop` killed the turn with no document.
 *
 * **The refusal text is quoted in the role on purpose**, so the model meets the
 * same words in its briefing and in the tool result. These assertions run over a
 * whitespace-normalised copy: every sentence here is longer than the file's wrap
 * column, so a raw `toContain` would be an assertion about where a line breaks.
 */
describe("a write-less collator is told not to declare what it has not written (ISC-1151)", () => {
  const FLAT = ROLE.replace(/\s+/g, " ");

  test("the prohibition names artifacts, report, and the cost", () => {
    expect(FLAT).toContain("DO NOT PUT YOUR OWN TWO DOCUMENTS IN `artifacts`");
    expect(FLAT).toContain("`artifacts` declares files that ALREADY EXIST");
    expect(FLAT).toContain("move the file from `artifacts` to `report` and call once more");
  });

  test("it quotes the refusal the seat will actually receive", () => {
    // The exact string `submit_report` returns. If that message is reworded, the
    // role stops matching the tool and this reddens — which is the point: a
    // briefing that quotes a message it no longer sends is worse than one that
    // quotes none, because the model waits for words that never arrive.
    expect(FLAT).toContain(
      "Declare a file only after writing it, or pass it as `report` and let this tool write and declare it for you.",
    );
  });

  test("the observer's declare-rule is marked as the observer's, not the collator's", () => {
    expect(FLAT).toContain("This sentence is what you tell the observer; it is not how YOU report.");
    expect(FLAT).toContain("The observer holds `write` and declares what it wrote. You do not");
  });

  test("repeating a refused call is named as the failure, not the retry", () => {
    expect(FLAT).toContain("If a call is refused, change what you send. Sending it again is the failure, not the retry.");
  });
});
