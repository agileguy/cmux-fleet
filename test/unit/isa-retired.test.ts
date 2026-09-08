/**
 * ISC-368 — the retired marker `[-]`, and the abuse it must not become.
 *
 * ## What the marker is for
 *
 * `ISA.md` had three states and no fourth. A criterion whose PREMISE had been
 * superseded stayed in the file, kept its grade, and kept being counted, with
 * the supersession recorded in prose inside the entry. Two of those had
 * accumulated by 2026-08-30: ISC-307, whose subject is a value reaching a 0600
 * env file — a delivery mechanism ISC-337 replaced with files — and ISC-360,
 * whose subject is an SRD erratum recording task-scoped cloud authorization as
 * designed-but-not-built, which ISC-366 withdrew outright.
 *
 * Both sat at `[~]`. That is the cost, stated as arithmetic rather than as
 * taste: `N [~]` had come to mean "N criteria are unproven OR withdrawn",
 * which is two different facts reported as one number, and the number a reader
 * reaches for first is the one that had stopped being decomposable.
 *
 * ## What the marker is NOT
 *
 * Retiring is not closing. A retired criterion earns no credit: it leaves the
 * numerator AND the denominator, and `retired:` in the frontmatter says how
 * many left, so the total is reported rather than disappeared.
 *
 * Retiring is not deleting. The entry stays, the text stays, the id is never
 * reused, and — see `test/support/isa-claims.ts` — the registered claims that
 * carried the criterion keep running. Both criteria retired here still carry
 * live guards over shipped code.
 *
 * Retiring is not a way to make a failing or inconvenient criterion go away.
 * This is the one that needs a mechanism rather than a sentence, because it is
 * the only one with an incentive behind it: a hard `[~]` and a superseded
 * `[~]` look identical from the checkbox, and the difference is entirely in
 * whether something REPLACED the premise.
 *
 * ## The guard, and why it is shaped this way
 *
 * A retirement must NAME the criterion that superseded it, that criterion must
 * be DEFINED, must not be the retired one itself, must be graded `[x]`, and
 * must ITSELF NAME what it replaced.
 *
 * The last clause is what makes this more than a formality. Without it, any
 * retirement is unilateral: a hard criterion could be retired by pointing at
 * whatever closed criterion happened to be nearby, and the marker would parse.
 * Requiring the replacement to acknowledge the replaced makes the claim
 * two-sided — it cannot be asserted by editing one line — and puts the edit
 * somewhere a reviewer looks, inside a CLOSED criterion's entry, where a
 * sudden claim to have superseded something hard is conspicuous.
 *
 * It is not proof. Nothing mechanical can distinguish a genuine supersession
 * from a determined forgery of one, and this file does not pretend otherwise;
 * what it does is make the forgery cost two deliberate edits in two places
 * instead of one character, and leave both in the diff.
 */

import { describe, expect, test } from "bun:test";

import { ISA_CLAIMS } from "../support/isa-claims.ts";

const ISA = await Bun.file(new URL("../../ISA.md", import.meta.url)).text();

/** A retired criterion row: `- [-] ISC-307: …`. */
const RETIRED_LINE = /^- \[-\] (ISC-\d+[a-z]?): (.*)$/gm;

/**
 * The retirement marker. The date and the superseding id are both captured
 * because both are asserted: an undated retirement cannot be placed in the
 * project's history, and an unattributed one is the unilateral case above.
 */
const MARKER = /\*\*\[RETIRED (\d{4}-\d{2}-\d{2}) — PREMISE SUPERSEDED BY (ISC-\d+[a-z]?)\b/;

/** Every criterion row in the file, by id, with its marker and its text. */
function entries(isa: string): Map<string, { grade: string; text: string }> {
  const out = new Map<string, { grade: string; text: string }>();
  for (const m of isa.matchAll(/^- \[(.)\] (ISC-\d+[a-z]?): (.*)$/gm)) {
    out.set(m[2]!, { grade: m[1]!, text: m[3]! });
  }
  return out;
}

/** Ids retired in `isa`, in file order. */
export function retiredIds(isa: string): string[] {
  return [...isa.matchAll(RETIRED_LINE)].map((m) => m[1]!);
}

/**
 * Everything wrong with the retirements in `isa`, one sentence each. Empty
 * means every `[-]` in the file is a supersession somebody can check.
 *
 * A function rather than a body of inline assertions, so the checker itself
 * can be driven against synthetic text that is deliberately wrong — a check
 * nobody has watched reject something is indistinguishable from one that
 * cannot reject anything.
 */
export function retirementProblems(isa: string): string[] {
  const all = entries(isa);
  const problems: string[] = [];

  for (const m of isa.matchAll(RETIRED_LINE)) {
    const id = m[1]!;
    const text = m[2]!;
    const marker = MARKER.exec(text);

    if (!marker) {
      problems.push(
        `${id} is retired with no marker. A retirement must read ` +
          `'**[RETIRED <YYYY-MM-DD> — PREMISE SUPERSEDED BY ISC-<n>' in the entry, ` +
          `because a criterion may be retired only when its PREMISE was superseded — ` +
          `never because it is hard, slow, or inconvenient to evidence.`,
      );
      continue;
    }

    const by = marker[2]!;
    if (by === id) {
      problems.push(`${id} names itself as its own superseder, which asserts nothing.`);
      continue;
    }

    const superseder = all.get(by);
    if (!superseder) {
      problems.push(
        `${id} is retired behind ${by}, which ISA.md does not define. ` +
          `A retirement pointing at nothing looks authoritative and is not.`,
      );
      continue;
    }

    if (superseder.grade !== "x") {
      problems.push(
        `${id} is retired behind ${by}, which is graded [${superseder.grade}]. ` +
          `A premise is superseded when the replacement is CLOSED — retiring behind an ` +
          `open, partial or retired criterion withdraws the question without answering it.`,
      );
      continue;
    }

    if (!new RegExp(`\\b${id}\\b`).test(superseder.text)) {
      problems.push(
        `${id} claims ${by} superseded it, but ${by}'s own entry never names ${id}. ` +
          `Supersession is two-sided: the criterion that replaced a premise says so, ` +
          `which is what stops a merely-hard criterion being retired behind whichever ` +
          `closed criterion was nearest.`,
      );
    }
  }

  return problems;
}

/**
 * Retirements that legitimately carry NO registered claim, each with its reason.
 *
 * The test below says *"if a retirement legitimately has none, say so here
 * rather than deleting this"*, so this is that saying-so, and it is a set rather
 * than a loosened assertion: a retirement not named here still has to carry a
 * guard. The distinction is whether the retired premise ever had a mechanism of
 * its own to lose. Both 2026-08-30 retirements did — a grant line that names
 * variables rather than values, an empty policy write, the absence of
 * `PIFLEET_TASK_ID` from `src/` — and dropping those would have used `[-]` to
 * delete a live guard by re-grading the document above it.
 */
const NO_CLAIMS_BY_CONSTRUCTION = new Map<string, string>([
  [
    "ISC-608",
    "Its subject was a BLANKET `--cadence` refusal in `scripts/triage`, and task 6.7a removed the " +
      "blanket: the flag now reaches the actor as `--poll <seconds>`. `scripts/` is invisible to both " +
      "`tsc` and the test loader (ISC-600), so this criterion never had a registry claim to lose — its " +
      "evidence was always a source probe in `fresh-dispatch.test.ts`, and that probe survives as " +
      "ISC-1053's, asserting the half that is still true.",
  ],
  [
    "ISC-1034",
    "Its subject was `actor_unbudgeted`, an EVENT whose whole purpose was to announce that §6.10's " +
      "producer was built and not yet wired — and whose retirement is the wire landing. The event, " +
      "its union arm, its log line and its two tests were deleted together, so there is no shipped " +
      "code left for a claim to guard: the guarantee moved into the type system, where " +
      "`TriageConsolePorts.budget` being REQUIRED is the mechanism and `bun run typecheck` runs it. " +
      "A registry claim here would assert the absence of a deleted event, which is weaker than what " +
      "the compiler already says.",
  ],
  [
    "ISC-698",
    "Its subject was `window_checked`, a FIELD that task 5.3d deleted, and its probe was a " +
      "test asserting that field's two values. There is no shipped code left for a claim to " +
      "guard: the guarantee moved into the type system, where ISC-760's two @ts-expect-error " +
      "directives are the mechanism and `bun run typecheck` is what runs them. A registry " +
      "claim here would have to assert the absence of a deleted field, which is a weaker " +
      "statement than the compiler already makes and would go stale the day the name is reused.",
  ],
]);

describe("every retirement in ISA.md is a supersession (ISC-368)", () => {
  test("each [-] criterion names a closed criterion that names it back", () => {
    const problems = retirementProblems(ISA);
    expect(problems, `${problems.length} retirement problem(s):\n${problems.join("\n\n")}`).toEqual(
      [],
    );
  });

  /**
   * The retired SET is pinned by id, in the shape `test/unit/voided.test.ts`
   * uses for the operator-facing table and for the same reason: the value of
   * a list whose whole job is authority collapses if it can be extended
   * without anyone deciding to.
   *
   * This is a review gate, not a semantic check, and it is written down as
   * one. Retiring a third criterion is a legitimate thing to do; doing it
   * without touching this file is not.
   */
  test("the retired set is exactly the criteria whose premises were superseded", () => {
    expect(retiredIds(ISA)).toEqual(["ISC-307", "ISC-360", "ISC-608", "ISC-698", "ISC-1034"]);
  });

  /**
   * Retirement does not drop guards.
   *
   * Both retired criteria carry registered claims in the ISA claims registry,
   * and both claims are over code that still ships — the stderr grant line
   * that names variables rather than values, the empty policy write, and the
   * absence of `PIFLEET_TASK_ID` from `src/`. If retiring a criterion also
   * removed its claims, `[-]` would be a way to delete a live guard by
   * re-grading the document above it, which is exactly the abuse this
   * criterion refuses. Asserted on the registry rather than described in the
   * ISA, because a sentence in a document is not a mechanism.
   */
  test("a retired criterion's registered claims are still in the registry and still run", () => {
    for (const id of retiredIds(ISA)) {
      const claims = ISA_CLAIMS.filter((c) => c.isc === id);
      expect(
        claims.length > 0 || NO_CLAIMS_BY_CONSTRUCTION.has(id),
        `${id} is retired and has no claims left in test/support/isa-claims.ts. ` +
          `Both criteria retired on 2026-08-30 carried guards over code that still ships; ` +
          `if a retirement legitimately has none, say so here rather than deleting this.`,
      ).toBe(true);
      for (const c of claims) {
        expect(
          c.grade,
          `${id} is retired in ISA.md but a claim records it as ${c.grade}`,
        ).toBe("[-]");
      }
    }
  });
});

/**
 * The checker must be able to REJECT. Every case below is a way a retirement
 * can be wrong, driven through the same function the real file goes through —
 * so the assertions above cannot be passing merely because the checker never
 * finds anything.
 */
describe("the retirement checker rejects what it is for (ISC-368)", () => {
  const GOOD = [
    "- [-] ISC-9: a withdrawn premise. **[RETIRED 2026-08-30 — PREMISE SUPERSEDED BY ISC-10.]**",
    "- [x] ISC-10: the replacement, which names ISC-9 as what it replaced.",
  ].join("\n");

  test("a well-formed retirement produces no problems", () => {
    expect(retirementProblems(GOOD)).toEqual([]);
  });

  test("an unmarked retirement is rejected — the hard-criterion case", () => {
    const text = "- [-] ISC-9: this one was just difficult to evidence.";
    const problems = retirementProblems(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("retired with no marker");
  });

  test("a retirement behind an undefined criterion is rejected", () => {
    const text =
      "- [-] ISC-9: gone. **[RETIRED 2026-08-30 — PREMISE SUPERSEDED BY ISC-9999.]**";
    const problems = retirementProblems(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not define");
  });

  test("a retirement behind a criterion that is not closed is rejected", () => {
    const text = [
      "- [-] ISC-9: gone. **[RETIRED 2026-08-30 — PREMISE SUPERSEDED BY ISC-10.]**",
      "- [~] ISC-10: the replacement, ISC-9, is not itself finished.",
    ].join("\n");
    const problems = retirementProblems(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("graded [~]");
  });

  test("a retirement the superseder does not acknowledge is rejected", () => {
    const text = [
      "- [-] ISC-9: merely hard. **[RETIRED 2026-08-30 — PREMISE SUPERSEDED BY ISC-10.]**",
      "- [x] ISC-10: an unrelated closed criterion about something else entirely.",
    ].join("\n");
    const problems = retirementProblems(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("never names ISC-9");
  });

  test("a self-superseding retirement is rejected", () => {
    const text = "- [-] ISC-9: gone. **[RETIRED 2026-08-30 — PREMISE SUPERSEDED BY ISC-9.]**";
    const problems = retirementProblems(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("names itself");
  });

  /**
   * The acknowledgement check must not be satisfiable by an id that merely
   * shares a prefix. `ISC-36` appearing in a superseder's text is not an
   * acknowledgement of `ISC-360`, and a substring test would have said it was.
   */
  test("a prefix of the retired id does not count as acknowledgement", () => {
    const text = [
      "- [-] ISC-360: gone. **[RETIRED 2026-08-30 — PREMISE SUPERSEDED BY ISC-10.]**",
      "- [x] ISC-10: this entry mentions ISC-36 and nothing else.",
    ].join("\n");
    const problems = retirementProblems(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("never names ISC-360");
  });
});
