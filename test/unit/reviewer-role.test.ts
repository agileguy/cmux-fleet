import { RESULT_ENVELOPE_NAME } from "../../src/contracts.ts";
/**
 * `roles/reviewer.md` says only things that are true, and the one instruction
 * holding the review console together is pinned at BOTH ends.
 *
 * ## The defect this exists to catch, measured rather than imagined
 *
 * A review console's reviewer writes prose that a collator in another container
 * has to read. What actually crosses that gap is the reviewer's result envelope
 * plus `HarvestedArtifactSchema` — `{path, bytes, sha256}`, **no contents** — and
 * the reviewer's `/outbox` is worker-scoped, so nothing else can open it. A
 * reviewer that files its review at `/outbox/<task-id>/files/review.md` and
 * writes a two-line summary beside it produces a document no part of this
 * console can read, with every status green.
 *
 * The mitigation is two prompts saying the same thing: `roles/reviewer.md` tells
 * the reviewer directly, and `roles/collator.md` tells the collator to repeat it
 * in every brief. **Belt and braces, because the failure is invisible** — nothing
 * goes red, and the review simply is not there. So the probe asserts BOTH, and
 * deleting either reddens. `src/run/collation.ts`'s header carries the argument
 * and names the two real fixes; neither is in this phase.
 *
 * ## Three claims in this file were false, and they are why the audit happened
 *
 * The version this replaces opened with *"Review the diff against its stated
 * intent. The task envelope says what the change was supposed to do."* Measured
 * against the code:
 *
 * - **There is no diff.** `fleet.yaml`'s reviewer is `tools: [read, grep, find,
 *   ls]` — no bash — so it cannot run `git diff`, and nothing in `render.ts`,
 *   `task-policy.ts` or `dispatch-policy.ts` delivers one.
 * - **The reviewer never receives the task envelope.** `renderPrompt`
 *   (`supervisor/index.ts`) emits the title, the brief, the acceptance lines and
 *   four identity values. Nothing else.
 * - **`/policy/task` is not the envelope**, which is the trap that makes the
 *   second claim look survivable: it is mounted, it is named for the task, and
 *   `writeTaskPolicy(path, task_id, epoch)` writes two fields into it for the
 *   verbgate's provenance line.
 *
 * Same class as the collator role's invented `/outbox/fanout.json`, in the file
 * next to it, found by grepping each claim rather than by reading the prose
 * again.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { REPLIES_MOUNT } from "../../src/run/replies.ts";
import {
  ROOT,
  exampleConfig,
  grantedTools,
  ungroundedCapabilityClaims,
  unknownPaths,
} from "../support/role-docs.ts";

const REVIEWER = readFileSync(`${ROOT}roles/reviewer.md`, "utf8");
const COLLATOR = readFileSync(`${ROOT}roles/collator.md`, "utf8");
const ASPECTS = ["architecture-security", "cross-file-contracts", "typescript-language"].map(
  (n) => [n, readFileSync(`${ROOT}roles/review/${n}.md`, "utf8")] as const,
);

/**
 * Every document that is concatenated into a reviewer's briefing.
 *
 * `load.ts` concatenates defaults → role → worker (D10's mechanism), so a
 * reviewer reads `roles/reviewer.md` AND its one aspect file as a single
 * instruction. A claim corrected in one and left standing in the other is a
 * briefing that contradicts itself, which is worse than either version alone.
 */
const REVIEWER_BRIEFING: ReadonlyArray<readonly [string, string]> = [
  ["roles/reviewer.md", REVIEWER],
  ...ASPECTS.map(([n, t]) => [`roles/review/${n}.md`, t] as const),
];

describe("the whole review reaches the collator, and both ends say so", () => {
  test("the reviewer is told to put its review in the envelope's notes", () => {
    expect(REVIEWER).toContain("`notes`");
    expect(
      REVIEWER.includes("PUT YOUR WHOLE REVIEW IN THE ENVELOPE"),
      "roles/reviewer.md no longer carries the instruction in its own right",
    ).toBe(true);
  });

  /**
   * **Rewritten when the plane was fixed, and the old assertion deleted rather
   * than kept green.** It required the document to say the contents "do not
   * cross", which stopped being true: `relay.ts` inlines each artifact under
   * `MAX_REPLY_ARTIFACT_BYTES` / `MAX_REPLY_INLINE_BYTES`. A probe that still
   * demanded that sentence would have forced the document to keep describing a
   * defect the code no longer has — coverage in appearance, misinformation in
   * fact.
   *
   * What must still be true is the part that did not change: there IS a bound,
   * and the reviewer is told what it costs.
   */
  test("the reviewer is told the copy is CAPPED, and what happens past the cap", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("PUT YOUR WHOLE REVIEW"));
    expect(block).toContain("64 KiB");
    expect(block).toContain("256 KiB");
    // The consequence, not just the number.
    expect(block).toContain("cut off");
    expect(block).toContain("/outbox/<task-id>/files/review.md");
    /*
     * And WHY `notes` is still the channel to prefer now that files do arrive:
     * only the copied files are capped. Without this the instruction survives as
     * a rule with no reason, which is the first thing a model under budget
     * pressure drops. Added because a battery removed the sentence and nothing
     * reddened.
     */
    // Matched on the clause the wrap does not split.
    expect(block).toContain("only the copied files are capped");
  });

  /**
   * The other end. Two prompts is the whole mitigation, so a probe that asserted
   * only one would stay green through half of it being deleted — and the half
   * that survived would look like a complete guard.
   */
  test("the collator is still told to repeat the instruction in every brief", () => {
    /*
     * REWRITTEN 2026-09-04. This pinned the phrase "put its whole review in its
     * result envelope's `notes`" — and that exact phrasing is what broke a live
     * review. `rev-ctx-1`, holding `write` and no shell, read "the envelope's
     * `notes`" as a FILENAME and wrote a file called `notes`, produced no
     * envelope, and graded as a lens that never reported. So the probe now
     * requires the two things that disambiguate it — the envelope's PATH and the
     * word FIELD — rather than the sentence that misled a reader.
     */
    expect(COLLATOR, "the collator never names the envelope it tells reviewers to write").toContain(
      `/outbox/<task-id>/${RESULT_ENVELOPE_NAME}`,
    );
    expect(COLLATOR, "the collator does not say `notes` is a field").toContain("`notes` FIELD");
  });

  test("the collator is told the reviewer role carries it too, and to say it anyway", () => {
    const block = COLLATOR.slice(COLLATOR.indexOf("put its whole review"));
    expect(block).toContain("roles/reviewer.md");
    expect(block).toContain("Say it");
  });

  /**
   * The label, asserted. A mitigation that stops being described as one is a
   * mitigation that gets counted as a fix, and the next person to read the
   * reply plane concludes the gap was closed.
   */
  /**
   * The mitigation SURVIVES the fix, and the document must say why rather than
   * reading as a leftover. Belt and braces is the deliberate posture for a
   * failure whose whole character is that nothing goes red.
   */
  test("the notes instruction stays, and is justified rather than orphaned", () => {
    expect(REVIEWER).toContain("This instruction stays anyway");
    expect(REVIEWER).toContain("two defences rather than one");
  });

  /**
   * The design note now records a CLOSED gap. Asserting the closure — not just
   * that a note exists — is what stops the code and the note drifting apart in
   * the direction that matters: a doc still describing the defect after the fix
   * sends the next reader to re-solve a solved problem.
   */
  test("the design note records the gap as closed, and how", () => {
    const src = readFileSync(`${ROOT}src/run/collation.ts`, "utf8");
    expect(src).toContain("THE GAP THIS CONTRACT COULD NOT CLOSE — CLOSED");
    const note = src.slice(src.indexOf("THE GAP THIS CONTRACT COULD NOT CLOSE"));
    // The decision, its shape, and the cost it carries.
    expect(note).toContain("Take A shipped");
    expect(note).toContain("inlined_artifacts");
    expect(note).toContain("MAX_REPLY_ARTIFACT_BYTES");
    expect(note).toContain("TRUNCATED");
    // And that B was considered and why it lost — deleting that would leave the
    // next reader to re-litigate a decision D6 already made.
    expect(note).toContain("D6 had already rejected B's shape");
    /*
     * The COST of the cap, not just the cap. A recommendation whose price is not
     * written down cannot be weighed by the next person deciding whether to
     * raise the limit, and a truncated review is worse than an absent one
     * because it reads as a complete review that found less.
     */
    expect(note).toContain("cost is paid, not hidden");
  });
});

/**
 * The grant, member by member, and the two halves independently pinned.
 *
 * A probe that only noticed "the tools list changed" would be satisfied by
 * adding `write` OR by adding `bash`, which would make the battery's bash-refusal
 * mutation stop meaning what its name says. So each member is asserted on its
 * own: `write` present because the role could not write `result.json` without it
 * and the console could not function, `bash` and `edit` absent because §12.1's
 * argument is about a shell and `edit` buys nothing against a `:ro` checkout.
 *
 * **Read from `fleet.example.yaml`, which is TRACKED.** `fleet.yaml` is
 * gitignored and `ci.yml` is checkout → `bun install` → `bun test test/unit` with
 * no step that creates it, so a probe reading it unconditionally is red on every
 * clean checkout — the defect `review-plan.test.ts` documents thirteen tests'
 * worth of, and which this file shipped with. The live file gets its own gated
 * probe below.
 */
describe("the reviewer's grant is what the document says it is", () => {
  const EXAMPLE = exampleConfig();

  test("write IS granted — the role could not report without it", () => {
    expect(grantedTools(EXAMPLE, "reviewer")).toContain("write");
  });

  test("bash is NOT granted", () => {
    expect(grantedTools(EXAMPLE, "reviewer")).not.toContain("bash");
  });

  test("edit is NOT granted", () => {
    expect(grantedTools(EXAMPLE, "reviewer")).not.toContain("edit");
  });

  test("the grant is exactly the five tools the document enumerates", () => {
    expect([...grantedTools(EXAMPLE, "reviewer")].sort()).toEqual([
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  /**
   * The document's own sentence against the grant, both ways: a tool it claims
   * and does not have costs an epoch to discover, and a tool it has and does not
   * mention is a capability the model will not use.
   */
  test("the document's opening tool sentence matches the grant", () => {
    const first = REVIEWER.split("\n")[0]!;
    for (const t of grantedTools(EXAMPLE, "reviewer")) {
      expect(first, `the opening line does not mention the granted tool "${t}"`).toContain(t);
    }
    expect(first).toContain("no bash");
    expect(first).toContain("no edit");
  });

  test("the document bounds the write to the outbox", () => {
    expect(REVIEWER).toContain("The write is for `/outbox` alone");
  });

  /**
   * The LIVE config, GATED. It is what the console actually runs from, so a
   * divergence matters — and it cannot be a hard dependency, for the reason in
   * this block's header.
   */
  describe.skipIf(!existsSync(`${ROOT}fleet.yaml`))("the operator's own fleet.yaml agrees", () => {
    test("the live reviewer grant matches the example's", () => {
      const LIVE = readFileSync(`${ROOT}fleet.yaml`, "utf8");
      expect([...grantedTools(LIVE, "reviewer")].sort()).toEqual(
        [...grantedTools(EXAMPLE, "reviewer")].sort(),
      );
    });
  });
});

describe("the reviewer is not told to use capabilities it does not have", () => {
  /**
   * Derived from the grant rather than hard-coded: these need a SHELL and the
   * reviewer has none. The premise is asserted first, so granting `bash` retires
   * the rule loudly instead of leaving it failing for a reason nobody reads.
   */
  const SHELL_WORDS = ["diff", "git", "tsc", "npm"];

  test("the premise holds — the reviewer still has no bash", () => {
    expect(grantedTools(exampleConfig(), "reviewer")).not.toContain("bash");
  });

  test("the document says plainly that there is no diff", () => {
    expect(REVIEWER).toContain("There is no diff");
  });

  /**
   * THE CLASS, not the instances — and the version this replaces could not catch
   * a new mistake.
   *
   * It was a three-string denylist whose first two entries were verbatim the
   * battery's own replacement strings for RV7 and RV9, so the probe and the
   * mutation had been written to each other. A fresh false claim — *"Start from
   * the diff and work outwards"* — passed it. The rule now is that a sentence may
   * name a shell-only capability ONLY where it denies having it, which catches
   * any wording rather than four.
   *
   * Its limit, stated so the table can repeat it: this is a rule about
   * SENTENCES. A false capability claim expressed without any of these words —
   * asserting a capability by describing its effect — still passes.
   */
  test("no sentence in the briefing instructs a shell-only capability", () => {
    const offenders: string[] = [];
    for (const [name, text] of REVIEWER_BRIEFING) {
      for (const v of ungroundedCapabilityClaims(text, SHELL_WORDS)) {
        offenders.push(`${name} — ${v}`);
      }
    }
    expect(
      offenders,
      `the briefing instructs work the reviewer cannot do:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  test("no sentence points the reviewer at the task envelope", () => {
    const offenders: string[] = [];
    for (const [name, text] of REVIEWER_BRIEFING) {
      for (const v of ungroundedCapabilityClaims(text, ["task envelope"])) {
        offenders.push(`${name} — ${v}`);
      }
    }
    expect(
      offenders,
      `the briefing points at a document the reviewer never receives:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * CONTROL for both. A rule matching nothing reports no offenders just as
   * happily, so it is run against the exact sentence the review used to
   * demonstrate the hole and must find it.
   */
  test("CONTROL: the negation rule catches a FRESH false claim", () => {
    const poisoned = `${REVIEWER}\n\nStart from the diff and work outwards.\n`;
    expect(ungroundedCapabilityClaims(poisoned, SHELL_WORDS).join(" ")).toContain("work outwards");
  });

  /**
   * The trap that made the envelope claim look survivable. `/policy/task` is
   * mounted and is named for the task, and it holds `task_id` and `epoch` for
   * the verbgate's provenance line. A document that pointed the reviewer there
   * would be wrong in a way that reads as a correction.
   */
  test("the document does not point the reviewer at /policy/task for the intent", () => {
    for (const [name, text] of REVIEWER_BRIEFING) {
      expect(text, `${name} points at /policy/task`).not.toContain("/policy/task");
    }
  });

  test("it names the channel that DOES carry the brief on a staged task", () => {
    expect(REVIEWER).toContain("/policy/dispatch");
  });
});

describe("the reviewer document names only paths that exist", () => {
  /**
   * BY CONSTRUCTION, and the first-segment version this replaces was the defect.
   *
   * That version classified only a path's LEADING segment against a set of mount
   * roots, so `/policy/envelope.json` — a path that has never existed — passed,
   * because `/policy` is a mount. The allowlist in `test/support/role-docs.ts` is
   * derived from the builders and constants that produce these paths, so an
   * invented one fails whatever it is called and without anyone predicting it.
   */
  test("every backticked path is one the code produces", () => {
    const offenders: string[] = [];
    for (const [name, text] of REVIEWER_BRIEFING) {
      for (const path of unknownPaths(text)) offenders.push(`${name}: ${path}`);
    }
    expect(
      offenders,
      `the briefing names paths nothing in the code produces: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /** CONTROL, and it is the exact string the review used to show the hole. */
  test("CONTROL: a fresh invented path under a real mount is caught", () => {
    const poisoned = `${REVIEWER}\n\nThe task envelope is at \`/policy/envelope.json\`.\n`;
    expect(unknownPaths(poisoned)).toContain("/policy/envelope.json");
  });

  test("CONTROL: the extractor reaches the outbox path the instruction turns on", () => {
    expect(REVIEWER).toContain("`/outbox/<task-id>/files/review.md`");
  });

  test("no reviewer document points at the reply mount", () => {
    for (const [name, text] of REVIEWER_BRIEFING) {
      expect(text, `${name} points a reviewer at ${REPLIES_MOUNT}`).not.toContain(
        `${REPLIES_MOUNT}/`,
      );
    }
  });
});

describe("the location a reviewer quotes is the one a collation can carry", () => {
  /**
   * `/workspace/...`, not repo-relative. The census resolves a relative path by
   * JOINING it onto the workdir, so any string at all — a prose sentence
   * included — lands "inside" and is counted as located. The absolute form is the
   * only one that can fail when it is wrong, which is the only one worth
   * checking, and `findingLocationArm` in `collation.ts` is the predicate that
   * lets the census publish the two arms apart.
   */
  test("the reviewer is told to quote the container path", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("Quote file and line"));
    expect(block).toContain("/workspace/");
    expect(block).toContain("not** the repo-relative form");
    expect(block).toContain("bare number");
  });

  test("both ends agree on the spelling", () => {
    expect(COLLATOR).toContain("container path");
    expect(COLLATOR).toContain("src/foo.ts:12");
  });
});
