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
import { readFileSync } from "node:fs";

import { REPLIES_MOUNT } from "../../src/run/replies.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
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

  test("the reviewer is told WHY — the artifact's contents do not cross", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("PUT YOUR WHOLE REVIEW"));
    expect(block).toContain("not the contents");
    expect(block).toContain("/outbox/<task-id>/files/review.md");
  });

  /**
   * The other end. Two prompts is the whole mitigation, so a probe that asserted
   * only one would stay green through half of it being deleted — and the half
   * that survived would look like a complete guard.
   */
  test("the collator is still told to repeat the instruction in every brief", () => {
    expect(COLLATOR).toContain("put its whole review in its result envelope's `notes`");
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
  test("the mitigation is labelled as a mitigation, not as the design", () => {
    expect(REVIEWER).toContain("This is a workaround");
    const src = readFileSync(`${ROOT}src/run/collation.ts`, "utf8");
    expect(src).toContain("THE GAP THIS CONTRACT CANNOT CLOSE");
    expect(src).toContain("must not be read as a fix");
  });

  test("the design note names both candidate fixes and picks one", () => {
    const src = readFileSync(`${ROOT}src/run/collation.ts`, "utf8");
    const note = src.slice(src.indexOf("THE GAP THIS CONTRACT CANNOT CLOSE"));
    expect(note).toContain("A — inline the artifact contents");
    expect(note).toContain("B — give the reply a contents channel");
    expect(note).toContain("Take A.");
    // The cost of the recommendation, not just the recommendation.
    expect(note).toContain("A's cost");
  });
});

describe("the reviewer is not told to use capabilities it does not have", () => {
  /**
   * `tools: [read, grep, find, ls]` — read out of the config rather than
   * restated, so widening the grant is what retires this probe rather than a
   * reader deciding it has.
   */
  test("the reviewer role still has no bash in fleet.yaml", () => {
    const fleet = readFileSync(`${ROOT}fleet.yaml`, "utf8");
    const block = fleet.slice(fleet.indexOf("\n  reviewer:"), fleet.indexOf("\n  collator:"));
    expect(block, "the reviewer block moved — the probe has rotted").toContain("tools:");
    const tools = /tools:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? "";
    expect(tools).not.toContain("bash");
    expect(tools).toContain("read");
  });

  test("the document says plainly that there is no diff", () => {
    expect(REVIEWER).toContain("There is no diff");
  });

  /**
   * ASYMMETRIC against the probe above. Saying "there is no diff" once while
   * still instructing the reviewer to review one would satisfy it, and the
   * briefing would contradict itself inside a single prompt.
   */
  test("ASYMMETRIC: no document in the briefing still instructs reviewing THE diff", () => {
    const offenders: string[] = [];
    for (const [name, text] of REVIEWER_BRIEFING) {
      for (const bad of ["Review the diff", "Read past the diff", "the diff touches"]) {
        if (text.includes(bad)) offenders.push(`${name}: ${bad}`);
      }
    }
    expect(
      offenders,
      `the reviewer's briefing instructs work on a diff it is never given: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("no document in the briefing points the reviewer at the task envelope", () => {
    const offenders: string[] = [];
    for (const [name, text] of REVIEWER_BRIEFING) {
      if (text.includes("task envelope states") || text.includes("task envelope says")) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      `these tell the reviewer to read a document it never receives: ${offenders.join(", ")}`,
    ).toEqual([]);
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

describe("the reviewer document names only paths this worker has", () => {
  /**
   * `isolation: shared-ro`, `tools: [read, grep, find, ls]`. `/replies` is
   * mounted for every worker but is the COLLATOR's channel and nothing points a
   * reviewer at it, so it is deliberately absent from this set — a reviewer told
   * to read a sibling's reply would be reading another reviewer's report before
   * writing its own, which is the sequential fan-out §6.6 forbids.
   */
  const MOUNTS = new Set(["/workspace", "/outbox", "/policy", "/skills", "/sessions"]);
  const ORDINARY = new Set(["/tmp", "/run", "/etc", "/usr", "/var", "/home", "/dev", "/proc"]);

  test("every backticked top-level path is a mount or an ordinary container dir", () => {
    const offenders: string[] = [];
    let examined = 0;
    for (const [name, text] of REVIEWER_BRIEFING) {
      // The class admits `<` and `>`: every interesting path in these documents
      // carries a placeholder, and a class without them ends the match early and
      // examines nothing — the decorative failure ISC-364's own probe had.
      for (const m of text.matchAll(/`(\/[a-zA-Z0-9<][a-zA-Z0-9/._<>-]*)`/g)) {
        examined += 1;
        const top = `/${m[1]!.split("/")[1]!}`;
        if (ORDINARY.has(top) || MOUNTS.has(top)) continue;
        offenders.push(`${name}: ${m[1]!}`);
      }
    }
    expect(examined, "the path extractor examined nothing — the regex has rotted")
      .toBeGreaterThanOrEqual(2);
    expect(
      offenders,
      `the reviewer's briefing names paths it does not have: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /** CONTROL: an extractor matching nothing would satisfy the probe above. */
  test("CONTROL: the extractor reaches the outbox path the instruction turns on", () => {
    const cited = [...REVIEWER.matchAll(/`(\/[a-zA-Z0-9<][a-zA-Z0-9/._<>-]*)`/g)].map((m) => m[1]!);
    expect(cited).toContain("/outbox/<task-id>/files/review.md");
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
  test("the reviewer is told to give the path repo-relative and the line bare", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("Quote file and line"));
    expect(block).toContain("repo-relative");
    expect(block).toContain("bare number");
  });

  /**
   * Both ends again. The collator's document tells it to split `src/foo.ts:12`
   * because a reviewer may still hand one over; the reviewer's tells it not to.
   * Removing either leaves a location the collation drops.
   */
  test("the collator is still told what to do with a `path:line` it is handed", () => {
    expect(COLLATOR).toContain("src/foo.ts:12");
  });
});
