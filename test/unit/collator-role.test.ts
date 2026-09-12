/**
 * `roles/collator.md` says only things that are true — ISC-364's discipline,
 * applied to the one role document that describes a wire format.
 *
 * ## Why this file exists, and it is not hypothetical
 *
 * The version of `roles/collator.md` this replaces told the collator to write
 * its fan-out to `/outbox/fanout.json` and to read three reports from
 * `/outbox/reports/rev-arch-1.md`. **Neither path has ever existed.** The fan-out
 * is `/outbox/<task-id>/dispatch-request.json` (`dispatch-request.ts`) and the
 * reports arrive at `/replies/<child-task-id>.json` (`replies.ts`), and a grep of
 * `src/`, `test/` and `scripts/` for the two documented names returns nothing at
 * all. A collator following that document writes a file no poller reads, reports
 * `partial`, and is never dispatched again — and every layer downstream records a
 * healthy console that reviewed nothing.
 *
 * That is exactly ISC-364's finding: *"An SRD that is wrong misleads a human who
 * can push back. A `SKILL.md` that is wrong is an instruction executed by an
 * agent that cannot."* `worker-docs-currency.test.ts` makes that check for
 * `skills/`, over a hard-coded list of two documents. This is the same check for
 * the role file that carries the most checkable content of any of them.
 *
 * ## What is checkable, and what is deliberately not
 *
 * Most of a role document is judgement. Four things in this one are not, and all
 * four are load-bearing:
 *
 * 1. The CONTAINER PATHS it names — a path the worker does not have costs an
 *    epoch to discover, and a path nothing reads costs the whole review.
 * 2. The WIRE TAGS and FILE NAMES — spelled once in TypeScript and once in this
 *    prose, which is the drift `DISPATCH_REQUEST_FILE`'s docblock exists about.
 * 3. The DERIVED IDS — the document tells the collator to name `T-arch`,
 *    `T-context`, `T-lang` and `T-collate` in its envelope, and those come from
 *    `REVIEW_CONSOLE_ASPECTS` and `COLLATION_ASPECT`.
 * 4. The EXAMPLE DOCUMENTS — which are parsed here against the real schemas
 *    rather than eyeballed. An example that does not validate is worse than no
 *    example: a model copies its shape confidently.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispatchRequest,
  submitReport,
  type DispatchRequestParams,
} from "../../docker/pi-extensions/report-tools.ts";

import { StatusSchema } from "../../src/contracts.ts";
import { findingLocationProblem } from "../../src/harvest/collation-census.ts";
import {
  COLLATION_ARTIFACT_NAME,
  COLLATION_SCHEMA,
  CollationSchema,
  collationArtifactPath,
} from "../../src/run/collation.ts";
import {
  DISPATCH_REQUEST_FILE,
  DISPATCH_REQUEST_SCHEMA,
  REVIEW_CONSOLE_ROSTER,
  parseDispatchRequest,
} from "../../src/run/dispatch-request.ts";
import {
  COLLATION_ASPECT,
  REVIEW_CONSOLE_ASPECTS,
  childTaskId,
  collationTaskId,
} from "../../src/run/relay.ts";
import { REPLIES_MOUNT, replyMountPath } from "../../src/run/replies.ts";
import {
  ARTIFACT_NAMES,
  citedPaths,
  unknownPaths,
} from "../support/role-docs.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const ROLE = readFileSync(`${ROOT}roles/collator.md`, "utf8");

/** Every fenced JSON block in the document, in order. */
function jsonBlocks(): string[] {
  return [...ROLE.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/**
 * Blocks are selected by CONTENT, never by index.
 *
 * They used to be `jsonBlocks()[0]` and `[1]`. Task 7.2 added a third example —
 * the `submit_report` call that carries the pair — and every positional test
 * silently re-aimed at the wrong document: eleven failed at once, none of them
 * because the thing they were about had changed. Selecting on a field each block
 * uniquely has makes a new example inert here instead of destructive.
 */
function blockWith(marker: string): string {
  const found = jsonBlocks().filter((b) => b.includes(marker));
  if (found.length !== 1) {
    throw new Error(`expected exactly one JSON block containing ${marker}, found ${found.length}`);
  }
  return found[0]!;
}

const EXAMPLE_TASK_ID = "T-collate-fixture";

function policyFixture(): { dir: string; mounts: { policyPath: string; outboxRoot: string; repliesPolicyPath: string; repliesRoot: string } } {
  const dir = mkdtempSync(join(tmpdir(), "pifleet-collator-role-"));
  const policyPath = join(dir, "policy-task");
  writeFileSync(policyPath, `${EXAMPLE_TASK_ID}\n1\n`);
  const outboxRoot = join(dir, "outbox");
  mkdirSync(outboxRoot, { recursive: true });
  const repliesRoot = join(dir, "replies");
  mkdirSync(repliesRoot, { recursive: true });
  return {
    dir,
    mounts: { policyPath, outboxRoot, repliesPolicyPath: join(dir, "policy-replies"), repliesRoot },
  };
}

function fanoutExample(): DispatchRequestParams {
  return JSON.parse(blockWith('"requests"')) as DispatchRequestParams;
}

/** The document with every run of whitespace collapsed, for probes about MEANING. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * The one index at which `marker` occurs, refusing ABSENCE and AMBIGUITY alike.
 *
 * ## The half `between()` closed, kept
 *
 * `indexOf` returns -1 for a heading that has moved, and `slice(start, -1)` then
 * runs to the end of the document — so a scoped assertion quietly becomes a
 * whole-file one and keeps passing. Task 7.2 renamed the two artifact headings
 * and did exactly that to the `Field rules` slice; `rev-lang-1` found it on the
 * review cycle for the same commit.
 *
 * ## The half it did not, which is this function's reason for existing
 *
 * A refusal on `-1` sees a marker that occurs ZERO times. It is blind to one
 * that occurs TWICE, and `indexOf` silently takes the first — so every slice is
 * right only for as long as nothing upstream acquires the same words.
 *
 * **Measured, live in this file.** `"Turn one"` occurred twice in
 * `roles/collator.md`: the `### Turn one` heading and a body mention of "turn
 * one" inside the turn-one section itself. Five call sites passed the bare
 * `between("Turn one", "Turn two")` and all five were correct, by the accident
 * of which occurrence came first. Reword the HEADING and nothing throws: the
 * marker re-anchors onto the body mention a hundred lines down, every one of
 * those slices silently narrows to a fraction of the section, and the `.not`
 * assertions among them go green on a slice that no longer contains the text
 * they are watching for. That is the same fail-open the docblock above
 * describes, one level up — surviving inside the helper written to prevent it.
 *
 * ## The fix is a more specific MARKER, never a looser helper
 *
 * The refusal is deliberately not "take the first" or "take the outermost". A
 * caller whose marker went ambiguous has lost the ability to say which region it
 * meant, and there is no rule this function can apply that recovers the
 * intention — only the caller knows it. `### Turn one` is what that looks like
 * in practice: four characters, unambiguous, and it stays unambiguous when the
 * prose around it changes. Same shape and same argument as `blockWith()` above,
 * which has refused anything but exactly one match since task 7.2.
 */
function onlyIndexOf(marker: string): number {
  const occurrences = ROLE.split(marker).length - 1;
  if (occurrences === 0) throw new Error(`roles/collator.md no longer contains ${marker}`);
  if (occurrences > 1) {
    throw new Error(
      `roles/collator.md contains ${marker} ${occurrences} times; a slice marker must be ` +
        `unique or the slice is whichever one comes first. Make the marker more specific — a ` +
        `heading's \`### \` prefix usually does it — rather than loosening this check.`,
    );
  }
  return ROLE.indexOf(marker);
}

/**
 * A slice of the document between two sentinels, where a missing OR AMBIGUOUS
 * sentinel is an error rather than a silently different slice.
 *
 * (This docblock had drifted onto `flat()` below it and described a function it
 * was not attached to. Moved back, unchanged; the argument it carried now lives
 * on `onlyIndexOf` above, which both slicers share.)
 */
function between(startMarker: string, endMarker: string): string {
  const start = onlyIndexOf(startMarker);
  const end = onlyIndexOf(endMarker);
  if (end < start) throw new Error(`${endMarker} precedes ${startMarker} in roles/collator.md`);
  return ROLE.slice(start, end);
}

/**
 * The TAIL of the document from a sentinel, with the same refusal — the
 * one-sentinel half of `between()`, which task 7.2 left unconverted.
 *
 * `between()` closed this for two-sentinel slices. Two one-sentinel slices were
 * left on the raw `ROLE.slice(ROLE.indexOf(m))` form, and they are the more
 * dangerous half, because what a missing marker does here depends entirely on
 * the polarity of the assertion underneath it. `indexOf` returns -1, `slice(-1)`
 * yields the document's LAST CHARACTER, and then:
 *
 * - a `toContain` fails, but names a missing SENTENCE when what actually
 *   happened was a renamed HEADING — a true failure with a misleading cause; and
 * - a `.not.toContain` PASSES UNCONDITIONALLY. Every substring is absent from a
 *   one-character string.
 *
 * The second is the worst polarity this defect has, and it was live in this
 * file: "the stop instruction is inside turn one" is a drift detector whose only
 * assertion is a `.not.toContain`. Reword "Turn two" and it goes permanently,
 * silently green while still claiming to watch for exactly the drift it can no
 * longer see. A detector that cannot see is indistinguishable from one reporting
 * nothing to see. Measured before this change: with the marker perturbed, that
 * test reported `1 pass, 0 fail`.
 *
 * Same refusal as `sliceFrom` in `test/unit/reviewer-role.test.ts`, which took
 * eight of these on the sibling commit — deliberately the same NAME so a grep
 * finds both. That one carries a document and a name because it scopes into four
 * documents; this one needs neither, because every slice here is of
 * `roles/collator.md`.
 *
 * There is no `sliceTo` here: this file takes no head slices. Add it with the
 * index-0 refusal its counterpart carries if that ever changes.
 *
 * **The AMBIGUOUS marker goes through `onlyIndexOf` for the same reason.** A
 * tail slice re-anchored onto a later duplicate of its own marker is strictly
 * worse than the two-sentinel case: it does not narrow to a wrong region, it
 * narrows to the document's tail, and the `.not.toContain` polarity this
 * docblock is already about passes just as unconditionally on a short tail as
 * on one character. Both slicers share the one guard so neither can drift into
 * holding half of it.
 */
function sliceFrom(marker: string): string {
  return ROLE.slice(onlyIndexOf(marker));
}

/**
 * THE SLICE GUARDS ACTUALLY REFUSE — pinned here, because until this block
 * existed nothing committed said they did.
 *
 * ## Why these needed writing down, given that they are correct today
 *
 * Every marker at every call site in this file resolves uniquely against
 * `roles/collator.md`, and every `between()` pair is in document order. That is
 * not an accident, it is the point — and it is also what makes these refusals
 * **dormant**: deleting the `occurrences === 0` arm, the `occurrences > 1` arm,
 * or `between`'s ordering check leaves every other test in this file passing.
 * Measured before this block was written: all three deletions gave 84 pass /
 * 0 fail.
 *
 * They were correct because somebody perturbed a marker by hand once and
 * watched what happened. A manual perturbation leaves nothing behind. The next
 * person to decide this guard is fussy — and its own docblock anticipates that
 * person, which is why it argues at length against "take the first" — gets a
 * green suite for removing it. So the refusals are asserted directly, three
 * cheap probes that stay true for as long as the functions do.
 *
 * ## Why the MARKERS are synthetic and the document is not
 *
 * `onlyIndexOf` here closes over `ROLE` by design — the sibling
 * `test/unit/reviewer-role.test.ts` takes a document and a name because it
 * scopes into four, and this one deliberately does not. So the synthetic half
 * available here is the marker, not the text. That is enough: what is under
 * test is the ARITHMETIC on the occurrence count, and a marker chosen for its
 * multiplicity exercises it exactly as a synthetic document would.
 *
 * The non-unique marker is `"\n"` rather than a quoted phrase on purpose. A
 * phrase that happens to occur twice today is one edit away from occurring
 * once, and then this probe reddens for a reason that has nothing to do with
 * the guard it is watching. A newline is non-unique by CONSTRUCTION in any
 * document with more than one line, and the count is asserted below so the
 * probe cannot go vacuous if that ever stops being true.
 */
describe("the slice helpers refuse the inputs they promise to refuse", () => {
  test("an ABSENT marker is an error, not a silent -1", () => {
    expect(() =>
      onlyIndexOf("### A heading roles/collator.md has never carried"),
    ).toThrow(/no longer contains/);
  });

  test("a NON-UNIQUE marker is an error, not silently the first occurrence", () => {
    // Non-vacuous: the marker really does occur more than once, so the refusal
    // below is the thing being observed rather than an accident of the fixture.
    expect(ROLE.split("\n").length - 1, "roles/collator.md has more than one line").toBeGreaterThan(
      1,
    );
    expect(() => onlyIndexOf("\n")).toThrow(/a slice marker must be unique/);
  });

  /**
   * The pair is the one five call sites in this file already depend on, used
   * BACKWARDS. Reusing markers the file is already coupled to means this probe
   * adds no new coupling of its own: if `### Turn one` or `Turn two` is ever
   * reworded, those five call sites fail first and for the right reason, and
   * this test does not become an independent thing to remember to update.
   */
  test("between() refuses a slice whose end precedes its start", () => {
    expect(() => between("Turn two", "### Turn one")).toThrow(/precedes/);
  });
});

describe("the mechanism the document describes is the one that exists", () => {
  /**
   * The two paths the previous version invented. Asserted by ABSENCE, which is
   * the only form available: nothing in the code can be pointed at to prove a
   * document does not name a thing that was never built.
   */
  test("the invented fan-out and report paths are gone", () => {
    expect(ROLE).not.toContain("/outbox/fanout.json");
    expect(ROLE).not.toContain("/outbox/reports/");
  });

  test("the fan-out file is named as the poller spells it", () => {
    expect(ROLE).toContain(`/outbox/<task-id>/${DISPATCH_REQUEST_FILE}`);
  });

  /**
   * INVERTED by task 7.2, and the inversion is the point.
   *
   * The document used to spell the wire tag because the collator typed it into a
   * file it wrote itself. `dispatch_request` composes it now, and a document that
   * still showed it would teach a model to send a field `additionalProperties:
   * false` refuses. So the assertion flips: naming the tag here is the defect.
   */
  test("the document does NOT spell the wire tag the tool composes", () => {
    expect(ROLE).not.toContain(DISPATCH_REQUEST_SCHEMA);
  });

  /**
   * The POSITIVE TWIN, and the inversion above is incomplete without it.
   *
   * `not.toContain` pins an absence, and an absence is satisfied by a document
   * that says nothing at all — delete the guidance and the assertion still
   * passes while a model is left to guess whether the two fields are its job.
   * Raised by `rev-lang-1` on 7.2's own review cycle, against the commit that
   * wrote the inversion.
   */
  test("and it DOES tell the collator not to send the two fields", () => {
    const f = flat(ROLE);
    expect(f, "nothing tells the collator to omit the two host-composed fields").toContain(
      "Do not send `schema` and do not send `parent_task_id`",
    );
    expect(f, "nothing says who composes them instead").toContain("The tool composes both");
  });

  test("the collation's wire tag matches the schema", () => {
    expect(ROLE).toContain(COLLATION_SCHEMA);
  });

  test("the collation artifact is named where the grader looks for it", () => {
    expect(ROLE).toContain(`/outbox/<task-id>/files/${COLLATION_ARTIFACT_NAME}`);
    // The same string, built by the module rather than typed twice here.
    expect(collationArtifactPath("X").endsWith(`/files/${COLLATION_ARTIFACT_NAME}`)).toBe(true);
  });

  test("the reply path is the one the collation brief will actually print", () => {
    expect(ROLE).toContain(replyMountPath("T-arch"));
    expect(ROLE).toContain(REPLIES_MOUNT);
  });
});

describe("the collator document names only paths that exist", () => {
  /**
   * BY CONSTRUCTION, and the first-segment version this replaces was the defect.
   *
   * That version classified only a path's leading segment against a set of mount
   * roots, so `/outbox/reports-v2/<child-task-id>.json` — a path that has never
   * existed — passed, because `/outbox` is a mount. The historical
   * `/outbox/reports/` defect was caught only by the literal denylist below it.
   * A denylist of past mistakes cannot catch a future one; the allowlist in
   * `test/support/role-docs.ts` is derived from the builders and constants that
   * produce these paths, so an invented one fails whatever it is called.
   */
  test("every backticked path is one the code produces", () => {
    expect(
      unknownPaths(ROLE),
      `roles/collator.md names paths nothing in the code produces: ${unknownPaths(ROLE).join(", ")}`,
    ).toEqual([]);
  });

  /**
   * CONTROL, and it is the exact string the review used to demonstrate the hole.
   * A rule that matched nothing would report no offenders just as happily.
   */
  test("CONTROL: a fresh invented path under a real mount is caught", () => {
    const poisoned = `${ROLE}\n\nThe reports live at \`/outbox/reports-v2/<child-task-id>.json\`.\n`;
    expect(unknownPaths(poisoned)).toContain("/outbox/reports-v2/<child-task-id>.json");
  });

  test("CONTROL: the extractor really does reach the reply mount", () => {
    expect(citedPaths(ROLE)).toContain(`${REPLIES_MOUNT}/<child-task-id>.json`);
  });

  /**
   * The two artifact names the document tells the collator to write, checked
   * against the constants rather than against each other. A name that exists
   * only in prose cannot be verified; both are now spelled in `collation.ts`.
   */
  test("both artifact names come from the code", () => {
    expect(ROLE).toContain(`/outbox/<task-id>/files/${ARTIFACT_NAMES.structural}`);
    expect(ROLE).toContain(`/outbox/<task-id>/files/${ARTIFACT_NAMES.prose}`);
  });
});

/**
 * THE `file` FIELD IS A PATH, AND THE DOCUMENT'S TWO EXAMPLES ARE RUN THROUGH
 * THE REAL PREDICATE.
 *
 * `collation-census.ts` added a SHAPE rule: a `file` carrying whitespace, no
 * directory separator and no extension on its final component is read as prose,
 * and the finding stops counting as located. It closes a real hole — a relative
 * `file` is JOINED onto the workdir, so the sentence "the error handling could
 * be tightened" resolved inside `/workspace` and was counted as an anchor for a
 * finding that points at nothing.
 *
 * The refusal message teaches a collator this AFTER it has spent the turn. The
 * briefing teaches it before, which is the only one of the two that prevents the
 * cost.
 *
 * ## Why the examples are EXECUTED rather than quoted
 *
 * A probe asserting the document contains the sentence "file must be a path"
 * pins prose to prose. These assertions instead run `findingLocationProblem`
 * over the exact strings the document offers as its counted and uncounted
 * examples, so the guidance and the grader cannot drift: loosen or tighten the
 * rule and the document's own worked example becomes wrong here, in this file,
 * rather than in a live review six weeks from now.
 */
describe("the document's account of a usable location matches the grader's", () => {
  const WORKDIR = "/workspace";

  test("the rule is stated where the collator writes findings", () => {
    const rules = between("Field rules", "### `review.md`");
    expect(rules, "nothing tells the collator `file` must be a path").toContain(
      "`file` MUST NAME A PATH",
    );
    expect(rules, "the collator is not told where prose goes instead").toContain(
      "**Prose belongs in `statement`**",
    );
    expect(rules, "the collator is not told the 1-based line rule").toContain("at least 1");
  });

  /** The example the document says COUNTS really is accepted by the grader. */
  test("the document's counted example is one the census counts", () => {
    expect(ROLE).toContain("`/workspace/src/run/relay.ts` with `line: 800` counts");
    expect(findingLocationProblem("/workspace/src/run/relay.ts", 800, WORKDIR)).toBeNull();
  });

  /** And the one it says does NOT is really refused, for the reason given. */
  test("the document's uncounted example is one the census refuses", () => {
    expect(ROLE).toContain("`the error handling could be tightened` does not");
    const problem = findingLocationProblem("the error handling could be tightened", 12, WORKDIR);
    expect(problem, "the census now counts the sentence the document says it will not").not.toBeNull();
    expect(problem).toContain("is a sentence, not a path");
  });

  /**
   * CONTROL for the three conjuncts the document summarises. Stating "whitespace,
   * no directory separator and no extension" is only honest if all three are
   * required — a document that said "whitespace" alone would have the collator
   * believe `docs/design notes` and `design notes.md` are refused, and it would
   * stop writing locations it is entitled to write.
   */
  test("CONTROL: the rescues the document implies really are rescued", () => {
    for (const rescued of ["Makefile", "docs/design notes", "design notes.md"]) {
      expect(
        findingLocationProblem(rescued, 1, WORKDIR),
        `${rescued} is refused, so the document's three-conjunct summary is wrong`,
      ).toBeNull();
    }
  });

  test("the line rule the document states is the one the census applies", () => {
    expect(findingLocationProblem("/workspace/src/a.ts", 0, WORKDIR)).toContain("1-based");
    expect(findingLocationProblem("/workspace/src/a.ts", 1, WORKDIR)).toBeNull();
  });
});

describe("the ids the document tells the collator to name are the derived ones", () => {
  const PARENT = "T";

  test("every aspect's child id appears", () => {
    for (const seat of REVIEW_CONSOLE_ASPECTS) {
      const id = childTaskId(PARENT, seat.aspect);
      expect(ROLE, `the document never names the derived id ${id}`).toContain(id);
    }
  });

  /**
   * Scoped to the TURN-ONE section, and the battery is why.
   *
   * `T-collate` also appears in the worked collation example further down, so an
   * assertion over the whole document stayed green with the id deleted from the
   * instruction that actually matters. §6.6 makes that line the whole of D5's
   * mitigation — it is the only thing linking the request a person made to the
   * collation they will read — so it has to be asserted where it is load-bearing
   * rather than wherever the string happens to occur.
   */
  test("the collation id appears in the turn-one instruction", () => {
    const turnOne = between("### Turn one", "Turn two");
    expect(turnOne).toContain(collationTaskId(PARENT));
    expect(collationTaskId(PARENT)).toBe(`${PARENT}-${COLLATION_ASPECT}`);
  });

  /** The same scoping for the three child ids, for the same reason. */
  test("every child id appears in the turn-one instruction, not merely somewhere", () => {
    const turnOne = between("### Turn one", "Turn two");
    for (const seat of REVIEW_CONSOLE_ASPECTS) {
      expect(turnOne, `turn one never names ${childTaskId(PARENT, seat.aspect)}`).toContain(
        childTaskId(PARENT, seat.aspect),
      );
    }
  });

  test("every reviewer in the roster is named, and no worker outside it", () => {
    for (const w of REVIEW_CONSOLE_ROSTER.reviewers) {
      expect(ROLE, `the document never names ${w}`).toContain(w);
    }
    const named = new Set([...ROLE.matchAll(/`(rev-[a-z0-9-]+)`/g)].map((m) => m[1]!));
    const outside = [...named].filter((w) => !REVIEW_CONSOLE_ROSTER.reviewers.includes(w));
    expect(outside, `the document names workers outside the console: ${outside.join(", ")}`)
      .toEqual([]);
  });
});

/**
 * The examples are PARSED, not read.
 *
 * A worked example is the part of a prompt a model copies most literally, so an
 * example that the real schema refuses is a document that teaches the exact
 * shape the fleet rejects. Both blocks are therefore run through the schema that
 * will judge the real thing.
 */
describe("every worked example in the document validates", () => {
  test("every JSON example in the document parses as JSON", () => {
    const blocks = jsonBlocks();
    expect(blocks).toHaveLength(3);
    for (const b of blocks) expect(() => JSON.parse(b)).not.toThrow();
  });

  /**
   * The fan-out example is no longer graded as a DOCUMENT, because it is no
   * longer one: `dispatch_request` composes `schema` and `parent_task_id` from
   * `/policy/task`, and an example carrying either would be refused by
   * `additionalProperties: false` in the hands of a model that copied it.
   *
   * So drive the REAL tool with the block and parse what it wrote with the REAL
   * host parser. That is a stronger claim than the old one, not a weaker
   * substitute: it says the example, passed to the tool this role now names,
   * produces a file the host accepts.
   */
  test("the fan-out example carries no host-composed field", () => {
    const block = blockWith('"requests"');
    expect(block).not.toContain(DISPATCH_REQUEST_SCHEMA);
    expect(block).not.toContain("parent_task_id");
  });

  test("the fan-out example, driven through the tool, is accepted by the host parser", () => {
    const f = policyFixture();
    const out = dispatchRequest(fanoutExample(), f.mounts);
    const read = parseDispatchRequest(readFileSync(out.path, "utf8"), {
      sender: REVIEW_CONSOLE_ROSTER.collators[0]!,
      taskId: out.taskId,
      roster: REVIEW_CONSOLE_ROSTER,
    });
    rmSync(f.dir, { recursive: true, force: true });
    if (read.kind !== "ok") {
      throw new Error(
        `roles/collator.md's example is refused ${read.kind === "refused" ? read.code : read.kind}: ` +
          `${read.kind === "refused" ? read.reason : ""}`,
      );
    }
    expect(read.request.requests).toHaveLength(REVIEW_CONSOLE_ROSTER.reviewers.length);
  });

  test("the fan-out example names each reviewer exactly once", () => {
    const workers = fanoutExample().requests.map((r) => r.worker).sort();
    expect(workers).toEqual([...REVIEW_CONSOLE_ROSTER.reviewers].sort());
  });

  test("the collation example is a legal collation", () => {
    const doc = JSON.parse(blockWith('"finding_count"'));
    const r = CollationSchema.safeParse(doc);
    expect(r.error?.message ?? "accepted").toBe("accepted");
  });

  /**
   * The example carries a lens that did NOT report, which is the case the whole
   * denominator argument exists for. An example where all three reported would
   * be a worked example of the easy half, and the missing-lens row — the one a
   * collator is most likely to omit — would never be demonstrated.
   */
  test("ASYMMETRIC: the collation example demonstrates a MISSING lens", () => {
    const doc = CollationSchema.parse(JSON.parse(blockWith('"finding_count"')));
    expect(doc.lenses.length).toBe(REVIEW_CONSOLE_ASPECTS.length);
    expect(doc.lenses.filter((l) => !l.reported)).toHaveLength(1);
    expect(doc.lenses.filter((l) => !l.reported)[0]!.note).toBeTruthy();
  });

  /**
   * And it demonstrates a contradiction, for the same reason: a collator with
   * only agreeing examples in front of it records a disagreement as agreement,
   * which is the one thing the role file says is the worst available outcome.
   */
  test("ASYMMETRIC: the collation example demonstrates a CONTRADICTION", () => {
    const doc = CollationSchema.parse(JSON.parse(blockWith('"finding_count"')));
    expect(doc.findings.some((f) => f.disputed_by.length > 0)).toBe(true);
    expect(doc.findings.some((f) => f.raised_by.length > 1)).toBe(true);
  });

  test("the example's own finding_count agrees with its list", () => {
    const doc = CollationSchema.parse(JSON.parse(blockWith('"finding_count"')));
    expect(doc.finding_count).toBe(doc.findings.length);
  });
});

/**
 * THE SPLIT THE DOCUMENT INSTRUCTS IS THE ONE `submit_report` PERFORMS.
 *
 * ## What these replace, and why the replacement is executable
 *
 * Task 8.2 deleted three claims from the fan-out brief because `submit_report`
 * had made them false, and a deletion justified by a mechanism is only as good
 * as the evidence that the mechanism does what the deletion assumed. Each probe
 * below DRIVES THE REAL TOOL and asserts the fact the deleted sentence used to
 * assert in prose, so the justification lives in the suite rather than in a
 * commit message:
 *
 *  - *"declare that file in its envelope's `artifacts` array"* — redundant
 *    because `composeEnvelope` appends every `report` file itself.
 *  - *"a reviewer … wrote a FILE called `notes`"* — unreachable because `notes`
 *    is a typed parameter of a tool the role cannot bypass, not a path.
 *  - *"An invalid escape in a quoted regex broke one"* — unreachable because the
 *    tool serialises the envelope, so no character of the prose can reach the
 *    JSON as syntax.
 *
 * **These are the arm the string probes above cannot be.** Everything else in
 * this file quotes the document; a quotation cannot tell you whether the thing
 * quoted is still true. Deleting a true sentence and deleting a false one look
 * identical to a `toContain`, which is exactly how a Phase C cut goes wrong.
 */
describe("the mechanism that retired the deleted prose really does what it claimed", () => {
  const REPORT_CONTENT = "# review\n\nfindings go here.\n";

  function submitWithReport(params: {
    notes?: string;
    artifacts?: { kind: "file" | "diff" | "log" | "note"; path: string }[];
  }) {
    const f = policyFixture();
    const out = submitReport(
      {
        status: "success",
        summary: "a collated review",
        ...params,
        report: [{ filename: ARTIFACT_NAMES.prose, content: REPORT_CONTENT }],
      },
      "col-1",
      { ...f.mounts, workdir: null },
    );
    const envelope = JSON.parse(readFileSync(out.path, "utf8"));
    return { dir: f.dir, out, envelope };
  }

  /**
   * THE DESTINATION, derived rather than retyped.
   *
   * The document names `/outbox/<task-id>/files/review.md` and the reviewer is
   * told to file its long review there. That is now a claim about where
   * `submit_report` puts a `report` entry, so it is checked by putting one there
   * — with `<task-id>` substituted for the fixture's own id, which is the only
   * part of the string that is not literal.
   */
  test("the path the document names is the path the tool writes a `report` file to", () => {
    const { dir, out } = submitWithReport({});
    expect(ROLE, "the document no longer names the review's destination").toContain(
      `/outbox/<task-id>/files/${ARTIFACT_NAMES.prose}`,
    );
    expect(out.reportPaths).toHaveLength(1);
    expect(
      out.reportPaths[0]!.endsWith(`/${EXAMPLE_TASK_ID}/files/${ARTIFACT_NAMES.prose}`),
      `the tool wrote ${out.reportPaths[0]}, which is not the shape the document promises`,
    ).toBe(true);
    expect(readFileSync(out.reportPaths[0]!, "utf8")).toBe(REPORT_CONTENT);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * THE REDUNDANCY, asserted on a call that declares NOTHING.
   *
   * `artifacts` is deliberately absent here. If the envelope still claims the
   * review, the instruction to declare it by hand was work the tool was already
   * doing — which is the whole justification for cutting it from the brief.
   */
  test("the tool declares the report file with no `artifacts` in the call", () => {
    const { dir, envelope } = submitWithReport({});
    const claimed = (envelope.artifacts ?? []).map((a: { path: string }) => a.path);
    expect(claimed, "the envelope does not claim the file the tool just wrote").toContain(
      `files/${ARTIFACT_NAMES.prose}`,
    );
    // ONCE, not twice. A collator that also declared it by hand would double the
    // claim, and an operator reading two entries for one file cannot tell a
    // duplicate from a second document that was overwritten.
    expect(claimed.filter((p: string) => p === `files/${ARTIFACT_NAMES.prose}`)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * THE UNREACHABILITY, which is the deleted paragraph's own claim inverted.
   *
   * The document used to say an invalid escape in a quoted regex destroyed an
   * envelope. That required a model composing JSON by hand with `write`. The
   * role holds no `write` and `notes` is a string parameter, so the bytes below
   * — a backslash escape that is invalid in JSON, quotes, a brace, a newline —
   * must survive into the envelope as DATA and must not reach it as syntax.
   *
   * If this ever fails, the deleted paragraph was right and should come back.
   */
  test("prose in `notes` cannot break the envelope it rides in", () => {
    const nasty = 'a regex like /\\w+"{2}/ and a stray \\ plus a brace } and a newline\nhere';
    const { dir, out, envelope } = submitWithReport({ notes: nasty });
    expect(envelope.notes, "`notes` did not survive serialisation byte-exact").toBe(nasty);
    expect(envelope.schema).toBe("pifleet.result/v1");
    expect(envelope.task_id).toBe(EXAMPLE_TASK_ID);
    // And the file beside it is untouched by what the envelope carried.
    expect(readFileSync(out.reportPaths[0]!, "utf8")).toBe(REPORT_CONTENT);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `notes` IS NOT A PATH, which is what retires the `notes`-as-a-filename
   * anecdote. The tool writes exactly two things — the report file and the
   * envelope — and no argument to it can add a third called `notes`.
   */
  test("nothing named `notes` is ever written beside the review", () => {
    const { dir, out } = submitWithReport({ notes: "a short summary" });
    const filesDir = out.reportPaths[0]!.slice(0, out.reportPaths[0]!.lastIndexOf("/"));
    expect(readdirSync(filesDir).sort()).toEqual([ARTIFACT_NAMES.prose]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the statuses the document instructs are ones the schema accepts", () => {
  test("every backticked status word in the document is a legal status", () => {
    const legal = new Set<string>(StatusSchema.options);
    const found = [...ROLE.matchAll(/`(success|partial|blocked|failed|done|ok|error)`/g)].map(
      (m) => m[1]!,
    );
    expect(found.length, "no status words found — the probe has rotted").toBeGreaterThanOrEqual(4);
    const bogus = found.filter((s) => !legal.has(s));
    expect(bogus, `the document instructs statuses the schema refuses: ${bogus.join(", ")}`)
      .toEqual([]);
  });

  /**
   * §6.6 step 1: the fan-out task settles `success`. The document this replaces
   * said `partial`, which was the SRD's own earlier reading and is now wrong —
   * and a collator that claims `partial` on turn one puts a floor under the
   * whole review that nothing downstream can lift, because the lattice combines
   * by `min`.
   */
  test("turn one is instructed to claim success", () => {
    const turnOne = between("### Turn one", "Turn two");
    expect(turnOne).toContain('`status: "success"`');
  });

  test("the zero-findings rule is stated where the collator will read it", () => {
    expect(ROLE).toContain("Zero findings");
    expect(ROLE).toContain("`partial`");
  });
});

/**
 * D8's line, in the document the collator actually reads.
 *
 * The schema refuses an `acceptance` field, but a schema refusal arrives after
 * the model has spent a turn writing one. The instruction is what stops it being
 * written, and §6.8 asks for the distinction to be stated rather than merely
 * enforced.
 */
describe("the document does not spell the structural check as acceptance", () => {
  /*
   * LAZY, for the reason `turnOne` below is lazy. A `const` in a describe body
   * evaluates at COLLECTION time, so a throwing helper there would abort the
   * whole file — 47 tests reporting one error about a heading — instead of
   * reddening the three tests that actually depend on the marker.
   *
   * SCOPE, recorded rather than narrowed: this runs to the END of the document,
   * so it also covers `## THE PROPRIETARY-REMOTE CHECK IS NOT YOURS TO MAKE`,
   * which follows the grading section. All four phrases the tests below look for
   * are inside the grading section today (roles/collator.md:421-427), so the
   * over-reach changes no result — but a future `accepted`/`verified`/`proven`
   * landing in the proprietary-remote section would satisfy the third test from
   * outside the section it names. Narrowing the slice would change what these
   * assert, which this pass deliberately does not do.
   */
  const graded = (): string => sliceFrom("HOW THIS IS GRADED");

  test("it says plainly that this is not acceptance", () => {
    expect(graded().includes("not acceptance"), "the grading section never says so").toBe(true);
  });

  test("it does not instruct the collator to write acceptance criteria", () => {
    expect(
      // Matched WITHOUT the leading "do not", which the document's own wrapping
      // splits across a newline. A probe pinned to a line break is a probe that
      // reddens on a reflow.
      graded().includes("put acceptance commands on a review task"),
      "the grading section no longer refuses acceptance commands",
    ).toBe(true);
  });

  /**
   * The three words the schema refuses by name. A document that used one of them
   * approvingly would teach the model to write a field the parser rejects — and
   * a rejected collation is a review recorded as `partial` for a vocabulary
   * mistake.
   */
  test("it names the words the schema will refuse", () => {
    const g = graded();
    for (const w of ["accepted", "verified", "proven"]) {
      expect(g.includes(w), `the grading section never names "${w}"`).toBe(true);
    }
  });
});

describe("the house rule on attribution holds in the document itself", () => {
  test("no AI or assistant attribution anywhere in the role file", () => {
    // The document instructs the collator to REFUSE such attribution, so the
    // bare words appear. What must not appear is the attribution itself.
    expect(ROLE).not.toContain("Co-Authored-By");
    expect(ROLE).not.toContain("Generated with");
    expect(ROLE).not.toContain("Generated by");
  });

  test("the refusal the collator is given is still there", () => {
    expect(ROLE).toContain("github.gwd.broadcom.net");
    expect(ROLE).toContain("github.com/appneta/");
    expect(ROLE).toContain("github.com/dan-elliott-appneta/");
  });
});

/**
 * TURN ONE SCOPES; IT DOES NOT REVIEW.
 *
 * ## The failure this was written from
 *
 * A live collator on this console, briefed to fan out a review of a 3742-line
 * deletion, spent turn one reading the change instead of scoping it. Its own
 * transcript recorded the moment it had enough — *"Actually, I have enough to
 * write good briefs"* — and it kept reading anyway, then degenerated into an
 * exact repeat: the same `read` and the same `grep`, same arguments, nine times
 * in twenty seconds. 40 tool calls, 21 reads, 19 greps, ZERO writes; context
 * grew by exactly +4046 tokens per iteration, 64K to 207K, until it was killed.
 * No `dispatch-request.json` was ever written and no reviewer was ever
 * dispatched.
 *
 * The prior document invited this. Turn one's step 1 read *"Read what is under
 * review"* with no bound and no stopping rule, and its example of a good brief —
 * *"naming the two functions that touch untrusted input"* — is an act of review.
 * The document asked the collator to do the analysis and then not report it.
 *
 * ## What these probes see, and what they cannot
 *
 * They are STRING probes over prose, and prose is the collator's only control
 * surface — it has no bash and nothing host-side bounds its reading. So state
 * the limit plainly rather than implying coverage:
 *
 * - They see whether the RULES ARE PRESENT and are inside turn one, which is the
 *   regression that matters: these paragraphs are long, they read as commentary,
 *   and the next person to tighten this file will be tempted to cut them.
 * - They CANNOT see whether a collator obeys them. Only a live run does that,
 *   and `Docs/SRD-REVIEW-CONSOLE.md` records the run this came from.
 * - The independence probe is the strongest of the three because it is a
 *   CONSISTENCY check between two parts of the document rather than a quotation
 *   of one: the file claims three-vendor agreement is evidence, and that claim is
 *   only true if the briefs did not carry the answer. Deleting the independence
 *   argument while keeping the consensus claim is the silent way to break this,
 *   and it is the arm a single grep for either sentence alone would miss.
 */
describe("turn one scopes the change rather than reviewing it", () => {
  const turnOne = (): string => between("### Turn one", "Turn two");

  test("turn one denies the collator standing to make findings", () => {
    expect(turnOne()).toContain("findings are not yours");
  });

  test("turn one bounds the reading with a stopping rule", () => {
    const t = turnOne();
    expect(t, "no stopping rule").toContain("stop reading and write the file");
    expect(t, "nothing refuses a repeated tool call").toContain(
      "Never issue a tool call you have already issued with the same arguments",
    );
  });

  /**
   * The consistency arm. `ROLE` asserts that agreement between the three vendors
   * is evidence; that assertion is FALSE if the collator seeds them with its own
   * conclusion. Both halves must be present, so removing either reddens.
   */
  test("the consensus claim is paired with the independence that makes it true", () => {
    expect(ROLE, "the document no longer claims agreement is evidence").toContain(
      "that agreement is evidence",
    );
    expect(turnOne(), "turn one no longer says why the reads must be independent").toContain(
      "independent",
    );
    expect(turnOne(), "turn one no longer refuses a brief that carries a conclusion").toContain(
      "is not a brief; it is a prior",
    );
  });
});

/**
 * TURN ONE ENDS, AND THE DOCUMENT SAYS WHAT ENDING LOOKS LIKE.
 *
 * ## The failure this was written from, measured on run 5
 *
 * A collator wrote `dispatch-request.json` and `result.json` correctly and then
 * spent its LAST TWELVE TOOL CALLS looking for something to do: `ls /replies`,
 * `find /replies`, `ls /`, `ls /briefing`, `ls /policy`, and re-reads of its own
 * briefing and its own task. It settled on its own, so the cost was tokens and a
 * confusing transcript rather than a wrong review — but the document had claimed
 * that behaviour would not happen, and it happened.
 *
 * ## Why the old wording did not land, which is what these probes pin
 *
 * The document already said *"You never wait"* and *"there is no version of this
 * where you sit and poll for the reports."* Both are PROHIBITIONS, and both sit
 * in the protocol preamble as description. What turn one never carried was:
 *
 *  - **What done looks like** — that the envelope is the last tool call, after
 *    which there is nothing.
 *  - **What happens next and who does it** — that the second dispatch arrives as
 *    a NEW PROMPT, so the model is not being left to work out its own next move.
 *  - **Why looking is futile rather than merely forbidden** — that the reply
 *    mount is legitimately empty during turn one, so an empty listing confirms
 *    nothing and a model checking it learns nothing either way.
 *
 * A model that has just written a file and holds no next instruction will go and
 * look for one. Telling it not to is weaker than telling it there is nothing to
 * find, and weaker again than telling it what is coming instead.
 *
 * **These are string probes over prose and cannot see whether a collator obeys.**
 * Only a live run does that. What they catch is the regression: these paragraphs
 * are long, they read as commentary, and the next person to tighten this file
 * will be tempted to cut them.
 */
describe("turn one tells the collator what DONE looks like, not just what not to do", () => {
  const turnOne = (): string => between("### Turn one", "Turn two");

  test("the envelope is named as the last tool call of the turn", () => {
    expect(turnOne(), "turn one never says the envelope ends it").toContain("LAST TOOL CALL");
  });

  /**
   * THE POSITIVE HALF, and the one the prohibitions never had. A collator told
   * only "do not poll" still has an unanswered question about what becomes of
   * its request; a collator told the second turn arrives as a new prompt has
   * been answered and has no reason to look.
   */
  test("it says the second dispatch arrives as a NEW PROMPT, so nothing here is missing", () => {
    const t = turnOne();
    expect(t, "turn one never says how the collator is dispatched again").toContain(
      "arrives as a NEW PROMPT",
    );
    expect(t, "turn one never says that prompt is the next instruction").toContain(
      "your next instruction",
    );
  });

  /**
   * THE FUTILITY, which is the arm that makes the rule survivable under budget
   * pressure. "Do not check" is a rule to be broken when a model feels uncertain;
   * "checking returns the same thing whether it worked or not" removes the
   * uncertainty that motivates the check.
   *
   * Matched on the clause the wrap does not split.
   */
  test("it says why checking is uninformative, not merely that it is forbidden", () => {
    const t = turnOne();
    // Matched on REFLOWED text. The literal used to carry the hard line break
    // this document happened to have, so an unrelated rewrap -- which the file's
    // own discipline invites -- reddened a probe about meaning. `rev-lang-1`
    // raised it on the 7.2 cycle.
    expect(flat(t), "turn one never says an empty reply mount is the correct state").toContain(
      "empty is the CORRECT state",
    );
    expect(t, "turn one never says no observation distinguishes the two outcomes").toContain(
      "observation available in this turn that separates a fan-out that worked from one that did",
    );
  });

  /**
   * SCOPED TO TURN ONE, for the reason the collation-id probe above is scoped:
   * the whole document is long and these strings must be where the collator is
   * when it finishes, not merely somewhere in the file. An instruction about
   * ending turn one that lived in turn two would be green here and useless
   * there.
   */
  test("the stop instruction is inside turn one, where the collator will be reading", () => {
    // `sliceFrom`, NOT `ROLE.slice(ROLE.indexOf(...))`. The assertion below is a
    // `.not.toContain`, which is satisfied by the one-character slice a missing
    // marker produces — so on the raw form this probe's failure mode was to pass.
    const turnTwo = sliceFrom("Turn two");
    expect(turnTwo, "the stop instruction drifted out of turn one").not.toContain("LAST TOOL CALL");
  });
});
