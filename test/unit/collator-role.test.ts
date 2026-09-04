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
import { readFileSync } from "node:fs";

import { StatusSchema } from "../../src/contracts.ts";
import {
  COLLATION_ARTIFACT_NAME,
  COLLATION_SCHEMA,
  CollationSchema,
  collationArtifactPath,
} from "../../src/run/collation.ts";
import {
  DISPATCH_REQUEST_FILE,
  DISPATCH_REQUEST_SCHEMA,
  DispatchRequestSchema,
  REVIEW_CONSOLE_ROSTER,
} from "../../src/run/dispatch-request.ts";
import {
  COLLATION_ASPECT,
  REVIEW_CONSOLE_ASPECTS,
  childTaskId,
  collationTaskId,
} from "../../src/run/relay.ts";
import { REPLIES_MOUNT, replyMountPath } from "../../src/run/replies.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const ROLE = readFileSync(`${ROOT}roles/collator.md`, "utf8");

/** Every fenced JSON block in the document, in order. */
function jsonBlocks(): string[] {
  return [...ROLE.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

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

  test("the dispatch request's wire tag matches the schema", () => {
    expect(ROLE).toContain(DISPATCH_REQUEST_SCHEMA);
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

describe("the document names only paths this worker has", () => {
  /**
   * The collator's mounts, and the reason each is here rather than derived from
   * `render.ts` the way `worker-docs-currency.test.ts` derives them.
   *
   * That test's extractor reads `argv.push("-v", ...)` out of the renderer,
   * which gives every mount ANY role can receive. The collator is
   * `isolation: shared-ro` with `tools: [read, write, grep, find, ls]`, so the
   * interesting failure here is the opposite one: a path that IS a mount for
   * some other role and is not one for this worker. Deriving would accept
   * exactly that. Two of the three are pinned to constants so the derivation is
   * only lost where there is no constant to pin to.
   */
  const MOUNTS = new Set([REPLIES_MOUNT, "/outbox", "/workspace"]);
  const ORDINARY = new Set(["/tmp", "/run", "/etc", "/usr", "/var", "/home", "/dev", "/proc"]);

  test("every backticked top-level path is a mount or an ordinary container dir", () => {
    const offenders: string[] = [];
    let examined = 0;
    /*
     * The character class admits `<` and `>` deliberately. Every interesting
     * path in this document carries a placeholder —
     * `/outbox/<task-id>/dispatch-request.json` is the one the whole fan-out
     * turns on — and the first version of the equivalent probe in
     * `worker-docs-currency.test.ts` was DECORATIVE because a `<` ended the
     * match before the closing backtick, so none of them was ever examined.
     */
    for (const m of ROLE.matchAll(/`(\/[a-zA-Z0-9<][a-zA-Z0-9/._<>-]*)`/g)) {
      const cited = m[1]!;
      examined += 1;
      const top = `/${cited.split("/")[1]!}`;
      if (ORDINARY.has(top) || MOUNTS.has(top)) continue;
      offenders.push(cited);
    }
    // CONTROL: the failure this replaces was an extractor that examined almost
    // nothing while reporting no offenders.
    expect(examined, "the path extractor examined almost nothing — the regex has rotted")
      .toBeGreaterThanOrEqual(5);
    expect(
      offenders,
      `roles/collator.md names paths the collator does not have: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * ASYMMETRIC control for the probe above. If the extractor matched nothing —
   * the decorative failure it was written against — this would pass just as
   * happily, so the specific path the whole second turn depends on is asserted
   * by name.
   */
  test("CONTROL: the extractor really does reach the reply mount", () => {
    const cited = [...ROLE.matchAll(/`(\/[a-zA-Z0-9<][a-zA-Z0-9/._<>-]*)`/g)].map((m) => m[1]!);
    expect(cited).toContain(`${REPLIES_MOUNT}/<child-task-id>.json`);
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
    const turnOne = ROLE.slice(ROLE.indexOf("Turn one"), ROLE.indexOf("Turn two"));
    expect(turnOne).toContain(collationTaskId(PARENT));
    expect(collationTaskId(PARENT)).toBe(`${PARENT}-${COLLATION_ASPECT}`);
  });

  /** The same scoping for the three child ids, for the same reason. */
  test("every child id appears in the turn-one instruction, not merely somewhere", () => {
    const turnOne = ROLE.slice(ROLE.indexOf("Turn one"), ROLE.indexOf("Turn two"));
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
  test("there are exactly two JSON examples, and both parse as JSON", () => {
    const blocks = jsonBlocks();
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(() => JSON.parse(b)).not.toThrow();
  });

  test("the fan-out example is a legal dispatch request", () => {
    const doc = JSON.parse(jsonBlocks()[0]!);
    const r = DispatchRequestSchema.safeParse(doc);
    expect(r.error?.message ?? "accepted").toBe("accepted");
  });

  test("the fan-out example names each reviewer exactly once", () => {
    const doc = DispatchRequestSchema.parse(JSON.parse(jsonBlocks()[0]!));
    const workers = doc.requests.map((r) => r.worker).sort();
    expect(workers).toEqual([...REVIEW_CONSOLE_ROSTER.reviewers].sort());
  });

  test("the collation example is a legal collation", () => {
    const doc = JSON.parse(jsonBlocks()[1]!);
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
    const doc = CollationSchema.parse(JSON.parse(jsonBlocks()[1]!));
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
    const doc = CollationSchema.parse(JSON.parse(jsonBlocks()[1]!));
    expect(doc.findings.some((f) => f.disputed_by.length > 0)).toBe(true);
    expect(doc.findings.some((f) => f.raised_by.length > 1)).toBe(true);
  });

  test("the example's own finding_count agrees with its list", () => {
    const doc = CollationSchema.parse(JSON.parse(jsonBlocks()[1]!));
    expect(doc.finding_count).toBe(doc.findings.length);
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
    const turnOne = ROLE.slice(ROLE.indexOf("Turn one"), ROLE.indexOf("Turn two"));
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
  const GRADED = ROLE.slice(ROLE.indexOf("HOW THIS IS GRADED"));

  test("it says plainly that this is not acceptance", () => {
    expect(GRADED.includes("not acceptance"), "the grading section never says so").toBe(true);
  });

  test("it does not instruct the collator to write acceptance criteria", () => {
    expect(
      // Matched WITHOUT the leading "do not", which the document's own wrapping
      // splits across a newline. A probe pinned to a line break is a probe that
      // reddens on a reflow.
      GRADED.includes("put acceptance commands on a review task"),
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
    for (const w of ["accepted", "verified", "proven"]) {
      expect(GRADED.includes(w), `the grading section never names "${w}"`).toBe(true);
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
