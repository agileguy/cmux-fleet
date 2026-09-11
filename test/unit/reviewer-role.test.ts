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

/**
 * The tool VOCABULARY, so the reverse direction of the opening-sentence probe is
 * derived rather than a denylist of {write, bash, edit}. A name added to the
 * schema's enum is covered here the day it lands, without anyone remembering to
 * widen a literal list — the argument `role-docs.ts` makes for paths, applied to
 * tools.
 */
import { parseConfig } from "../../src/config/load.ts";
import { PI_ALL_TOOLS } from "../../src/config/schema.ts";
import {
  MAX_REPLY_ARTIFACT_BYTES,
  MAX_REPLY_INLINE_BYTES,
} from "../../src/run/relay.ts";
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
const ASPECTS = ["architecture-security", "cross-file-contracts", "implementation-language"].map(
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

/**
 * The one index at which `marker` occurs in `doc`, refusing ABSENCE and
 * AMBIGUITY alike, and naming the document whichever of the two it caught.
 *
 * Both slicers below route through this, so neither can drift into holding half
 * of the guard.
 *
 * ## The half the slicers refused from the start
 *
 * `indexOf` returns -1 for a heading that has moved, and a slice taken from or
 * to -1 is not an error — it is a DIFFERENT slice that keeps passing. What each
 * polarity does with that is on the two functions below; they have refused it
 * since the commit that introduced them.
 *
 * ## The half they did not, which is this function's reason for existing
 *
 * A refusal on `-1` sees a marker that occurs ZERO times. It is blind to one
 * that occurs TWICE, and `indexOf` silently takes the first — so every slice is
 * right only for as long as nothing upstream acquires the same words. The
 * damage wears the same two polarities as the missing marker and is harder to
 * spot, because nothing is missing: a `toContain` fails naming a sentence that
 * is still in the document, merely outside the re-anchored slice, and a
 * `.not.toContain` passes on a slice that no longer covers the region it was
 * written to watch.
 *
 * **This is the twin of a hole that was LIVE in the sibling file.** `between()`
 * in `test/unit/collator-role.test.ts` carried exactly this gap, and `"Turn
 * one"` occurred twice in `roles/collator.md` — the `### Turn one` heading and
 * a body mention inside that same section — so five call sites were correct
 * only by the accident of which occurrence came first. Rewording the heading
 * would have re-anchored all five onto the body mention and thrown nothing.
 *
 * ## Here the gap was LATENT, and that is not a reason to leave it
 *
 * Every marker at every call site in this file was counted as a substring of
 * the document it is used against before this guard went in. Five distinct
 * (document, marker) pairs across nine call sites — `THE LONG REVIEW GOES IN A
 * FILE` and `Quote file and line` in `roles/reviewer.md`, `file its long
 * review` in `roles/collator.md`, `THE GAP THIS CONTRACT COULD NOT CLOSE` in
 * `src/run/collation.ts`, and `**Which language that is` in
 * `roles/review/implementation-language.md` — and all five occurred exactly
 * once. No slice in this file is currently mis-scoped.
 *
 * That audit is a measurement of one moment, and it is the reason to close the
 * hole rather than to file it: this is the file that scopes into FOUR
 * documents, so it has four independent chances to acquire a duplicate, and
 * when one does the change is in a role document — nowhere near this test's
 * diff. The count above stops needing to be re-run by hand at the moment this
 * guard exists, because a marker that goes non-unique now reddens the suite
 * instead of quietly re-aiming a slice.
 *
 * ## The fix is a more specific MARKER, never a looser helper
 *
 * The refusal is deliberately not "take the first" or "take the outermost". A
 * caller whose marker went ambiguous has lost the ability to say which region
 * it meant, and no rule this function can apply recovers the intention — only
 * the caller knows it. Adding a heading's `### ` prefix is usually the whole
 * fix, and it stays unambiguous when the prose around it changes.
 *
 * Same refusal and deliberately the same error wording as `onlyIndexOf` in
 * `test/unit/collator-role.test.ts`, so a grep finds both. The one difference
 * is the arguments: that file slices only `roles/collator.md` and needs to name
 * nothing, while this one takes the document and its name because it scopes
 * into four different ones — two role documents, an aspect file and a source
 * file — and an error that does not say WHICH is half a diagnosis.
 */
function onlyIndexOf(doc: string, name: string, marker: string): number {
  const occurrences = doc.split(marker).length - 1;
  if (occurrences === 0) throw new Error(`${name} no longer contains ${marker}`);
  if (occurrences > 1) {
    throw new Error(
      `${name} contains ${marker} ${occurrences} times; a slice marker must be unique or the ` +
        `slice is whichever one comes first. Make the marker more specific — a heading's ` +
        `\`### \` prefix usually does it — rather than loosening this check.`,
    );
  }
  return doc.indexOf(marker);
}

/**
 * A slice of a document taken AT a marker, where a missing OR AMBIGUOUS marker
 * is a NAMED ERROR rather than a silently different slice.
 *
 * This is the fail-open shape, and it was in this file eight times:
 *
 * ```ts
 * const block = DOC.slice(DOC.indexOf("a heading someone reworded"));
 * expect(block.length, "the instruction is gone").toBeGreaterThan(0);
 * ```
 *
 * `indexOf` returns -1 for a heading that has moved, and `slice(-1)` yields the
 * LAST CHARACTER of the document. So `block.length` is 1, the sentinel written
 * to catch exactly that condition PASSES, and every `toContain` below it then
 * fails with a message naming the wrong thing — a heading rename reads as a
 * missing sentence. A `.not.toContain` in that position passes outright and the
 * probe goes quietly dark.
 *
 * The identical defect was found in `test/unit/collator-role.test.ts` on task
 * 7.2, by a reviewer, after a heading rename turned a scoped assertion into a
 * whole-file one. `between()` there is this same shape.
 *
 * The AMBIGUOUS marker is `onlyIndexOf`'s half and the argument for it is
 * there. Worth saying here only that a tail slice re-anchored onto a later
 * duplicate does not narrow to a wrong REGION — it narrows to the document's
 * tail, and a `.not.toContain` passes just as unconditionally on a short tail
 * as it does on the one character a missing marker leaves.
 */
function sliceFrom(doc: string, name: string, marker: string): string {
  return doc.slice(onlyIndexOf(doc, name, marker));
}

/**
 * The head of a document, UP TO a marker, with the same two refusals and one
 * more.
 *
 * A marker at index 0 yields the empty string, and every probe written against
 * a head slice asks whether something is ABSENT from it — `.test(opening)` is
 * `false` for "" whatever the pattern, so an empty head slice passes the lot.
 * That is the same fail-open wearing the other polarity, so it throws too. This
 * preserves the `toBeGreaterThan(0)` the one call site already carried, as an
 * error that says what happened.
 *
 * The index-0 refusal survives the move to `onlyIndexOf` deliberately: that
 * function is about WHICH occurrence, and a unique marker sitting at index 0 is
 * a perfectly unambiguous one. It is this polarity, not the lookup, that cannot
 * use it.
 */
function sliceTo(doc: string, name: string, marker: string): string {
  const at = onlyIndexOf(doc, name, marker);
  if (at === 0) throw new Error(`${name} now OPENS with ${marker} — the slice before it is empty`);
  return doc.slice(0, at);
}

/**
 * THE REVIEW IS A FILE AND `notes` IS A SUMMARY OF IT — rewritten 2026-09-05,
 * and the instruction it replaces is recorded rather than quietly dropped.
 *
 * The document used to say *"put your whole review in the envelope's `notes`"*.
 * That cost a lens in two of five live runs, from two different causes and one
 * shared shape:
 *
 * - `rev-lang-1` quoted the regex `[\w\-_]+` into `notes`. `\w` is not a legal
 *   JSON escape, the 3906-byte envelope would not parse, and the lens was graded
 *   as one that never reported. **Its `files/review.md` was on disk, 4849 bytes,
 *   whole** — measured, in the run directory, after the fact.
 * - `rev-ctx-1` wrote 7099 bytes and the object was never closed. `notes` was
 *   complete; the envelope around it was not. That reviewer had written no
 *   artifact, so nothing survived at all.
 *
 * A 7-10 KB review inside one JSON string makes the ENVELOPE's structure depend
 * on every byte of the prose, so any fault anywhere destroys the envelope rather
 * than truncating the review — and a destroyed envelope is a lens that reports
 * nothing, not a lens that reports less.
 *
 * ## The reason the split works is NOT the obvious one, and the probes pin the
 * real one
 *
 * The tempting claim is "the file survives the broken envelope, so the review
 * gets through anyway". **That is false and the document must not say it.**
 * `relay.ts` sets `succeeded: harvested.verdict === "success"`, an unparseable
 * envelope settles `unknown`, and only surviving lenses have a reply published —
 * so a lens with a broken envelope contributes nothing to the collator, artifact
 * or no artifact. What the split actually buys is that the envelope stops being
 * the fragile part: a one-page envelope of summary lines carries no quoted code
 * to mis-escape and is a far smaller target for an interrupted write.
 *
 * The file's survival is real but its beneficiary is a PERSON — the outbox is
 * inventoried whether or not an envelope parsed, which is the only reason the
 * first review above was recoverable at all.
 *
 * ## WHAT PHASE C TOOK OUT OF THIS BLOCK, and what it deliberately left
 *
 * SRD-WORKER-DISPATCH-EXTENSION task 8.1, 2026-09-10. Both losses above happened
 * to a reviewer HAND-COMPOSING `result.json` with the `write` tool. It holds no
 * `write`; `submit_report` serialises the envelope, writes it tmp-then-rename,
 * and reads `schema`, `task_id`, `epoch` and `worker` off host state. A
 * mis-escaped regex and a half-closed object are no longer states this role can
 * reach, so the MECHANICS those two anecdotes taught came out of the role file
 * along with the worked envelope, the `result.json` path, the declare-your-own-
 * artifact instruction and the 65536-byte `notes` ceiling.
 *
 * **The history stays here** — this is the record of why the split exists, and a
 * test file is where a superseded measurement belongs. What stays in the ROLE
 * file is the judgement the losses bought: long review in a file, short summary
 * in `notes`, worst first, and the correction that the file does not rescue a
 * lens that did not report. The probes below are the ones that still pin a
 * property the code holds.
 */
describe("the review is a file, notes is a summary, and both ends say so", () => {
  test("the reviewer is told to file the long review AND to keep notes short", () => {
    const block = sliceFrom(REVIEWER, "roles/reviewer.md", "THE LONG REVIEW GOES IN A FILE");
    // Both halves. A probe on either alone stays green through the other being
    // deleted, and either half alone re-creates one of the two measured losses.
    expect(block, "the review's destination is not named").toContain(
      "/outbox/<task-id>/files/review.md",
    );
    expect(block, "nothing tells the reviewer to keep the envelope short").toContain(
      "SHORT `notes`",
    );
  });

  /**
   * RE-AIMED FROM THE CLAIM TO THE ROUTE (Phase C, task 8.1), because the claim
   * stopped being the reviewer's to make.
   *
   * This used to require the words *"`artifacts` array"*: the artifact had to be
   * CLAIMED and not merely written, because `reconcile.ts` grades an empty
   * `artifacts` array against the files actually in the outbox and a review
   * filed and not declared is a discrepancy on the reviewer's own record. The
   * defect is real — `rev-lang-1` declared `files/review.md` and wrote no file,
   * and nothing refused anything.
   *
   * `composeEnvelope` in `report-tools.ts` now appends every `report` file to
   * `artifacts` itself, so a reviewer that delivers the review through `report`
   * cannot fail to declare it, and one that hand-composes an `artifacts` entry
   * for a file it did not write is refused by `artifactMissingProblem` before
   * the envelope is opened. Instructing the model to declare the file is
   * therefore telling it to do the tool's job.
   *
   * What is still the reviewer's to get wrong is the ROUTE: only `report` gets
   * the declaration for free, so the probe pins the parameter and the sentence
   * saying the tool declares it. A document that stopped naming `report` would
   * send the review out by a route with nothing appending anything.
   */
  test("the review is routed through `report`, which is what declares it", () => {
    const block = sliceFrom(REVIEWER, "roles/reviewer.md", "THE LONG REVIEW GOES IN A FILE");
    expect(block, "the block never names the parameter that carries the review").toContain(
      "`report` file",
    );
    expect(block, "the block does not say the tool makes the declaration").toContain(
      "declares it for you",
    );
  });

  /**
   * THE NUMBERS ARE DERIVED, so the document cannot drift from the code that
   * enforces them. The previous version of this probe hard-coded "64 KiB" and
   * "256 KiB" as string literals, which pins the prose to itself: raising a cap
   * in `relay.ts` would leave the document confidently wrong and every probe
   * green.
   */
  /**
   * MATCHED IN THE SENTENCE THAT STATES THE CAP, not anywhere in the block —
   * and a mutation is why.
   *
   * The first version asserted `toContain("64 KiB")`. The battery changed
   * *"cap: 64 KiB per file"* to *"cap: 32 KiB per file"* and this stayed GREEN,
   * because the block also says *"64 KiB of prose is roughly ten thousand
   * words"* one sentence later and that occurrence satisfied the match. A
   * document stating a cap the fleet does not enforce is exactly what this probe
   * exists to refuse, and it could not see one. So the number is now pinned
   * where it is load-bearing — inside the clause that tells the reviewer what
   * the limit IS.
   */
  /**
   * THE `notes` CEILING CAME OUT (Phase C, task 8.1) and the two relay caps did
   * not, and the difference is the whole reason this probe is worth keeping.
   *
   * The document used to state a third number — *"`notes` is bounded too, at the
   * same 65536 bytes"* — and an asymmetry built on it: an over-cap artifact
   * arrives truncated and is named, while an over-cap `notes` fails
   * `ResultEnvelopeSchema` and takes the status, the summary, the blockers and
   * the review with it. Both halves are now false for this role.
   * `SUBMIT_REPORT_PARAMETERS` caps `notes` at 20000 and the refusal is a typebox
   * validation error thrown in front of the model with its budget intact, which
   * Q4 measured every model recovering from on the first retry. So the ceiling
   * is not 65536, and passing it costs a retry rather than a lens.
   *
   * The two relay caps are the opposite case: `MAX_REPLY_ARTIFACT_BYTES` and
   * `MAX_REPLY_INLINE_BYTES` are applied host-side when the artifact is copied
   * into the collator's reply, nothing in front of the model enforces them —
   * `report.content` deliberately carries no `maxLength` — and a review over
   * them still arrives cut off. They stay in the document and stay derived from
   * the code, so raising one in `relay.ts` cannot leave the prose confidently
   * wrong.
   */
  test("the caps the document states are the caps the code actually enforces", () => {
    const block = sliceFrom(REVIEWER, "roles/reviewer.md", "THE LONG REVIEW GOES IN A FILE");
    expect(block, "the per-file cap is not the one relay.ts applies").toContain(
      `size cap: ${MAX_REPLY_ARTIFACT_BYTES / 1024} KiB per file`,
    );
    expect(block, "the per-reply cap is not the one relay.ts applies").toContain(
      `and ${MAX_REPLY_INLINE_BYTES / 1024} KiB across all of them`,
    );
    // The consequence, not just the number.
    expect(block).toContain("cut off");
  });

  /**
   * THE CLAIM THE DOCUMENT MUST NOT MAKE, asserted positively.
   *
   * A negative assertion ("does not say the file rescues the lens") is
   * unfalsifiable prose-matching — every rewording escapes it. So the probe
   * requires the TRUE mechanism to be present instead: the document must state
   * that a lens whose envelope will not parse has no reply published for it.
   * Deleting that leaves the reviewer believing the artifact is a safety net it
   * is not, which is the more dangerous of the two errors.
   */
  test("the document says plainly that the file does NOT rescue a lens that did not report", () => {
    const block = sliceFrom(REVIEWER, "roles/reviewer.md", "THE LONG REVIEW GOES IN A FILE");
    /*
     * MATCHED INSIDE ONE LINE. This pinned `"It does\nnot rescue the lens"` —
     * the phrase as it happened to wrap — so a re-wrap that changed no word
     * would have reddened it, which is the shape of probe that gets deleted by
     * the first person it inconveniences. The same correction the
     * `submit_report` bound probe below carries, for the same reason.
     */
    expect(block, "the document does not say a lens that did not report is lost").toContain(
      "It does not rescue the lens",
    );
    expect(block, "the document does not name the mechanism").toContain(
      "no reply published for it",
    );
  });

  /**
   * THE WORKED ENVELOPE IS GONE, AND SO IS THE PROBE THAT PARSED IT (Phase C,
   * task 8.1) — recorded here rather than silently dropped, because a deleted
   * probe is lost coverage whatever the reason for it.
   *
   * The document carried a `json` block spelling `pifleet.result/v1`, `task_id`,
   * `epoch`, `worker`, `status`, `summary`, `notes` and `artifacts`, and a probe
   * substituted the two id placeholders and parsed it through
   * `ResultEnvelopeSchema`. The discipline was right: an example a model copies
   * literally is the most load-bearing prose in a role file, and one the real
   * schema refuses teaches exactly the shape the harvester throws away.
   *
   * It had to go because a model copying it now gets a refusal.
   * `SUBMIT_REPORT_PARAMETERS` is `additionalProperties: false` and the first
   * four of those fields are ABSENT from it by design — they are read from
   * `/policy/task` and `ctx`, and `SUBMIT_REPORT_DESCRIPTION` spends a sentence
   * telling the model not to pass them precisely because the role documents
   * still instructed it to. The example was that instruction.
   *
   * **What is not replaced is the class of coverage.** Nothing now parses a
   * worked example in this file against the shape the tool accepts, because
   * there is no worked example. The honest replacement is a `submit_report`
   * ARGUMENT example validated against `SUBMIT_REPORT_PARAMETERS`, which is
   * exported and importable from `test/` for exactly this kind of use — that is
   * a new example rather than a deletion, so it is not task 8.1's, and it is
   * filed here as the gap it is.
   */

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

  /**
   * BOTH ENDS SAY THE SAME THING, which is the part a single-ended probe cannot
   * see. The collator repeats this instruction in every brief it writes, so a
   * collator still telling reviewers to put the whole review in `notes` would
   * re-create the defect on a fleet whose reviewer role had already been fixed.
   *
   * ## THE `artifacts` ASSERTION IS INVERTED, and that inversion is the half of
   * ## task 8.1 that did not land
   *
   * It used to require `` `artifacts` array `` — the collator had to ORDER the
   * hand-declaration, for the reason the docblock on *"the review is routed
   * through `report`"* above records. 8.1 relaxed that requirement on the
   * reviewer's side and deleted the matching sentence from `roles/reviewer.md`.
   * It did not reach `roles/collator.md`, which went on telling the collator to
   * order every reviewer to do the thing the reviewer's own prompt now tells it
   * NOT to do — a fleet whose two role documents issue opposite instructions
   * about the same field. **Both ends stayed green through it**, because each
   * probe only ever read its own end, which is the exact failure this describe
   * block was written to refuse and did not.
   *
   * Keeping the probe and flipping its polarity is what stops it coming back.
   * Dropping it leaves the collator free to re-acquire the order with nothing
   * watching. Asserting the PROHIBITION **positively** — rather than
   * `.not.toContain`-ing one phrasing of the order, which every rewording
   * escapes — reddens both when the sentence goes and when the "Do NOT" is
   * quietly dropped from in front of it.
   *
   * ## MEASURED against `submitReport`, not read off the prose
   *
   * The document now states what obeying the old order costs, so the statement
   * had to be checked against the tool rather than against a reading of it:
   *
   * - `report` + a redundant `files/review.md` claim is **accepted** —
   *   `artifactMissingProblem` exempts the one path phase 2 is about to write —
   *   and `composeEnvelope` then appends its own claim beside the model's, so
   *   the envelope declares the file TWICE.
   * - `report` + the bare `review.md` the model just passed is **refused**:
   *   report files land under `files/`, so the claim resolves to a path that
   *   does not exist and the whole call is rejected before anything is written.
   */
  test("the collator's copy instructs the same split the reviewer's does", () => {
    const block = sliceFrom(COLLATOR, "roles/collator.md", "file its long review");
    expect(block, "the collator does not name the review's destination").toContain(
      "/outbox/<task-id>/files/review.md",
    );
    expect(block, "the collator does not name the route that declares the review").toContain(
      "`report` entry",
    );
    expect(
      block,
      "the collator still orders the hand-declaration `roles/reviewer.md` tells reviewers not to make",
    ).toContain("Do NOT tell it to declare that file in its envelope's `artifacts` array");
    expect(block).toContain("roles/reviewer.md");
    expect(block).toContain("Say it");
  });

  /**
   * And the collator's copy carries the same correction about WHY, for the same
   * reason the reviewer's does: a collator that believes the artifact rescues a
   * broken envelope writes briefs that say so.
   */
  test("the collator's copy does not promise the file survives a broken envelope", () => {
    const block = sliceFrom(COLLATOR, "roles/collator.md", "file its long review");
    expect(block, "the collator's brief does not name the mechanism").toContain(
      "no reply published for it at all",
    );
  });

  /**
   * The mitigation SURVIVES the fix, and the document must say why rather than
   * reading as a leftover. Belt and braces is the deliberate posture for a
   * failure whose whole character is that nothing goes red.
   */
  test("the doubled instruction is justified rather than orphaned", () => {
    expect(REVIEWER).toContain("If your brief tells you all of this as well, that is deliberate");
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
    /*
     * The `toContain` above happens to guard this `indexOf` today — its string
     * is a SUPERSTRING of this marker, so it reddens first. That is a coupling
     * nobody reading either line would notice, and shortening the assertion
     * above would silently re-open the fail-open. The refusal belongs here.
     */
    const note = sliceFrom(src, "src/run/collation.ts", "THE GAP THIS CONTRACT COULD NOT CLOSE");
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
 * own: `write` ABSENT because `submit_report` is now the role's only writing
 * verb, `bash` and `edit` absent because §12.1's argument is about a shell and
 * `edit` buys nothing against a `:ro` checkout.
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

  /**
   * WITHDRAWN 2026-09-08 (SRD-WORKER-DISPATCH-EXTENSION task 7.1, Phase B), and
   * the assertion is INVERTED rather than deleted, because the two states this
   * role has been in are both defects and a deleted probe guards against
   * neither.
   *
   * The grant was real. `config/schema.ts` makes {write, edit, bash} the writer
   * set; a reviewer holding none of them could not write `result.json`, nothing
   * host-side writes it, and the console reported three empty lenses while every
   * status stayed green. That is why the version of this test above the
   * inversion existed at all.
   *
   * What retired it is `submit_report`: `docker/pi-extensions/report-tools.ts`
   * writes the envelope, and the `report` parameter writes the long review into
   * `files/` and claims it — the extension's file access, not the model's grant.
   * So the capability survives the withdrawal and only the general verb goes.
   *
   * **And the withdrawal is what makes the tool's refusals binding.** A bad
   * `status` is refused in typebox before `execute`, in front of the model,
   * while it still has budget — the `rev-lang-1` failure exactly. A
   * hand-written `result.json` meets no schema until the harvester parses it on
   * the host minutes later, and `report-tools.ts` has to stat the envelope on
   * disk at `agent_end` precisely because a `write` past the tool leaves no
   * trace in the extension. While `write` stands the refusal is advice, so this
   * probe reddening means the console has quietly got its bypass back.
   */
  test("write is NOT granted — submit_report is the only writing verb", () => {
    expect(grantedTools(EXAMPLE, "reviewer")).not.toContain("write");
    /*
     * The premise, asserted in the same test rather than assumed. "No `write`"
     * on a role that also lost `submit_report` is the ORIGINAL defect wearing
     * this probe's green tick — a reviewer that cannot report at all — and the
     * withdrawal above is only sound while the replacement is in the grant.
     */
    expect(
      grantedTools(EXAMPLE, "reviewer"),
      "the role has no writing verb at all — this is the pre-2026-09-04 defect",
    ).toContain("submit_report");
  });

  test("bash is NOT granted", () => {
    expect(grantedTools(EXAMPLE, "reviewer")).not.toContain("bash");
  });

  test("edit is NOT granted", () => {
    expect(grantedTools(EXAMPLE, "reviewer")).not.toContain("edit");
  });

  /**
   * FIVE since 2026-09-08 (SRD-WORKER-DISPATCH-EXTENSION task 7.1, Phase B) —
   * six for the four days Phase A ran with both routes open, and four before
   * Phase A added `submit_report`.
   *
   * The list stays a BY-VALUE inventory rather than being loosened to a set of
   * `toContain`s, and the shrink is the reason to say so again: the failure this
   * catches is a grant that GREW without anybody deciding it should, and that
   * failure gets easier to hide, not harder, as the list gets shorter. A
   * `toContain` battery would have accepted every one of the three states above
   * plus `bash`.
   *
   * Phase A opened the new route beside the old one and removed nothing, which
   * left `config validate` warning about the overlap. Phase B removes `write`,
   * so the overlap and the warning go together.
   */
  test("the grant is exactly the five tools the document enumerates", () => {
    expect([...grantedTools(EXAMPLE, "reviewer")].sort()).toEqual([
      "find",
      "grep",
      "ls",
      "read",
      "submit_report",
    ]);
  });

  /**
   * THE WITHDRAWAL IS AN INVARIANT, NOT A VALUE — and until 2026-09-08 it was a
   * value, which is what the architecture lens said on T-rv-155.
   *
   * Every probe above reads the grant the document currently spells. None of
   * them says what happens if the `tools:` line is DELETED, and the answer was:
   * `effectiveToolGrant` resolves an omitted list to every Pi builtin, so the
   * role silently regains `write`, `edit` and `bash` at once and task 7.1
   * reverses by an edit that looks like tidying. The value tests all stayed
   * green in that world, because there is no value left for them to disagree
   * with — they assert about a list that is gone.
   *
   * So this one deletes the line and asserts the DOCUMENT IS REFUSED. It is
   * armed by `read_only: true` on the role, which has no runtime effect at all
   * and exists solely to make ISC-59's check apply here.
   *
   * Note what makes this reddenable rather than decorative: remove `read_only`
   * from `fleet.example.yaml` and this test fails, because the deletion becomes
   * legal again. It is pinned to the mechanism, not to the spelling.
   */
  test("deleting the tools line is refused rather than silently re-granting write", async () => {
    const line = "    tools: [read, grep, find, ls, submit_report]";
    const lines = EXAMPLE.split("\n");

    /*
     * SCOPED TO THE REVIEWER'S BLOCK, and it did not have to be until task 7.3.
     *
     * This filtered the whole document on string equality, which was
     * unambiguous while `reviewer` was the only narrowed role. 7.3 narrowed
     * `triage` to the identical grant, so the same string now matches twice and
     * a whole-document filter would delete BOTH lines — testing something other
     * than the sentence above it, and passing anyway because both roles are
     * `read_only`. The premise assertion caught it rather than letting it
     * through, which is the only reason this is a fix and not a silent drift.
     */
    const from = lines.findIndex((l) => l === "  reviewer:");
    expect(from, "fleet.example.yaml declares no reviewer role").toBeGreaterThan(-1);
    const rest = lines.slice(from + 1).findIndex((l) => /^  [a-z][a-z_]*:\s*$/.test(l));
    const to = rest === -1 ? lines.length : from + 1 + rest;

    const within = lines.slice(from, to).filter((l) => l === line);
    expect(within, "the reviewer's grant line moved").toHaveLength(1);

    const at = lines.slice(from, to).indexOf(line) + from;
    const without = [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n");
    const err = await parseConfig(without, `${ROOT}fleet.example.yaml`).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, "the reviewer's tools line can be deleted without refusal").not.toBeNull();
    for (const tool of ["bash", "write", "edit"]) {
      expect(String(err?.message), `the refusal does not name ${tool}`).toContain(`"${tool}"`);
    }
  });

  /**
   * The document's own sentence against the grant, BOTH WAYS — and the second
   * direction was unenforced until a live cycle priced it.
   *
   * A tool the grant holds and the line omits is a capability the model will not
   * use. A tool the line NAMES and the grant does not hold is worse: the model
   * has no way to discover the lie except by spending a turn on it.
   *
   * ## What the prose-last order was protecting, stated before it is overturned
   *
   * SRD §8.1: *"the rollback boundary is phase B and it is one config line …
   * the prose is still there because phase C has not run for that role. This is
   * why the order is prose-last."* The property is real. While the briefing
   * still described `write`, restoring `write` to one `tools:` entry restored a
   * coherent worker — config and prose agreeing again in a single edit, with no
   * document to re-write under time pressure. That is why the version of this
   * probe above the rewrite looped over the GRANT only, and said so.
   *
   * ## What the first cycle measured (T-rv-152, 2026-09-08)
   *
   * Three reviewers, narrowed grant, prose untouched. `rev-arch-1` and
   * `rev-lang-1` read the config, found no `write`, and delivered 2 091 and
   * 5 691 bytes through `submit_report`. **`rev-ctx-1` believed line 1.** It
   * composed its entire review into a 13 933-byte `write` call, received `Tool
   * write not found`, and reported nothing: layer 3 nagged, layer 4 recorded
   * `pifleet.no_submit/v1` with `tool_calls: 11, nagged: true`, and the console
   * collated **two lens reports out of three** against task 7.1's acceptance
   * criterion of three.
   *
   * The causal claim is kept narrow on purpose. Every turn after the refusal
   * ended `stopReason: error` and every turn before it succeeded, but that
   * correlation does not establish that the refusal caused the stream to fail,
   * and nothing here rests on it. The first-order defect stands either way: the
   * model spent a whole review on a tool it does not hold **because the briefing
   * told it it did**, and that cost is paid whether or not it could have
   * recovered afterwards.
   *
   * ## Why the SENTENCE came forward and §8.1's mechanics did not
   *
   * Only the sentences stating WHAT THE GRANT IS move with the grant, because
   * those are the ones a model acts on. The four envelope sections
   * `submit_report` makes redundant were task 8.1's and stayed deferred until
   * 2026-09-10; deleting them is a size decision that costs nothing when it is
   * late. A false statement of the grant is not that kind of debt.
   *
   * The rollback property survives, kept honestly rather than by leaving a
   * falsehood in place: the document now instructs a reader restoring `write` to
   * the `tools:` line to restore its description in the same commit. That is a
   * one-line coupling written down where the person doing the rollback will read
   * it, instead of a briefing that is wrong in the meantime.
   *
   * ## The splitter is load-bearing
   *
   * The line makes two different claims — what it HOLDS before the em dash, what
   * it DENIES after it — and only the first is checked against the grant. A
   * whole-line check would redden on the document's own *"no write"*, which is
   * the one wording that must stay. So the boundary is asserted first: a line
   * that stops carrying exactly one `—` fails loudly here rather than quietly
   * grading the wrong half.
   */
  test("the document's opening tool sentence matches the grant", () => {
    const first = REVIEWER.split("\n")[0]!;
    const halves = first.split("—");
    expect(
      halves.length,
      "the opening line no longer separates what it HOLDS from what it DENIES with one em dash",
    ).toBe(2);
    const held = halves[0]!;

    const grant = grantedTools(EXAMPLE, "reviewer");
    // Forward: a granted tool the line never mentions is one the model will not
    // reach for.
    for (const t of grant) {
      expect(first, `the opening line does not mention the granted tool "${t}"`).toContain(t);
    }
    // Reverse: a tool the line claims and the grant does not hold. Derived from
    // `PI_ALL_TOOLS` rather than a denylist of {write, bash, edit}, so a name
    // added to the vocabulary is covered without anyone remembering to add it.
    for (const t of PI_ALL_TOOLS) {
      if (grant.includes(t)) continue;
      expect(
        new RegExp(`\\b${t}\\b`).test(held),
        `the opening line claims "${t}", which this role does not hold — the rev-ctx-1 state`,
      ).toBe(false);
    }

    expect(first).toContain("no write");
    expect(first).toContain("no bash");
    expect(first).toContain("no edit");
  });

  /**
   * THE SAME BOUND, RE-POINTED AT THE TOOL THAT NOW CARRIES IT.
   *
   * This probe used to pin *"The write is for `/outbox` alone"*, and it was kept
   * green through Phase B deliberately — the other half of the one-config-line
   * rollback the block above describes. The live cycle retired that argument
   * along with the opening line's, and for the same reason: the sentence bounded
   * a tool the role had already lost, so it was teaching `rev-ctx-1`'s mistake a
   * second time, three lines below the first.
   *
   * Deleting it outright would have been wrong. The BOUND is not stale — a
   * reviewer still needs to know that the one verb it holds writes to its own
   * outbox and not to the code under review, and that nothing about holding it
   * makes the checkout writable. Only the tool's NAME changed. So the sentence
   * is re-pointed at `submit_report`, and the probe follows it.
   *
   * The fragments are matched inside single lines. This document is wrapped
   * prose, and a probe pinning a phrase that happens to straddle a line break
   * reddens on a re-wrap that changed nothing — a probe nobody trusts is one
   * that gets deleted.
   */
  test("the document bounds submit_report's writing to the outbox", () => {
    expect(REVIEWER, "the document does not bound where the writing verb writes").toContain(
      "`submit_report` writes under `/outbox/<task-id>` and nowhere else",
    );
    expect(REVIEWER, "the document no longer refuses the licence reading").toContain(
      "not a licence to change the code you are",
    );
    expect(REVIEWER, "the document drops the reason the licence could not be exercised").toContain(
      "read-only checkout you could not anyway",
    );
  });

  /**
   * AND THE COUPLING IS WRITTEN DOWN, which is what replaces §8.1's protection.
   *
   * The prose-last order guaranteed the rollback stayed one edit. Bringing the
   * grant sentence forward gives that up unless the document says so itself, so
   * this asserts the instruction a person performing the rollback has to see:
   * the `tools:` line and this description move together. Without it the next
   * restore re-creates exactly the state that cost a lens, and the only warning
   * would be in a test file nobody opens while editing yaml.
   */
  test("the document couples a restored write to a restored description", () => {
    expect(REVIEWER, "nothing tells a reader the two edits are one").toContain(
      "are ONE edit",
    );
    expect(REVIEWER, "the document does not say restoring the grant obliges the prose").toContain(
      "restore its description here in the SAME commit",
    );
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

/**
 * THE LANGUAGE SEAT'S ANGLE IS DERIVED FROM THE TARGET, NOT NAMED IN ADVANCE.
 *
 * ## The defect, measured
 *
 * `rev-lang-1` ran `roles/review/typescript-language.md` — an angle whose every
 * example was TypeScript — while the console's integration target,
 * `~/repos/rally-cli`, is a Python project. The seat was reading Python and
 * briefed about `any`, `as` and non-null assertions. The collator had been
 * steering around it inside each brief it wrote, which is a workaround in the
 * one place the console has no leverage: the brief is written fresh every run by
 * a model, so the correction was re-derived or forgotten each time.
 *
 * This console reviews whatever repository it is launched from, so a language
 * fixed in config is wrong for every target but one.
 *
 * ## What these probes hold, and what they deliberately do not
 *
 * They CANNOT check that the angle is sharp — that is judgement, and
 * `review-plan.test.ts` already refuses the shape of the lazy fix by requiring
 * three DIFFERENT aspect files, so the angle cannot be collapsed into the shared
 * discipline. What they can check is that the seat is told to SETTLE the
 * language from evidence and to SAY which one it settled on, because an angle
 * that merely says "consider the language" is the failure this replaces wearing
 * a different name, and a determination nobody states is one nobody can find
 * wrong.
 */
describe("the language seat takes its angle from the repository, not from config", () => {
  const LANG = ASPECTS.find(([n]) => n === "implementation-language")?.[1];

  test("the aspect file exists under its target-neutral name", () => {
    expect(LANG, "roles/review/implementation-language.md is not in the briefing").toBeDefined();
  });

  /**
   * NO LANGUAGE IN THE ANGLE STATEMENT. The heading and the paragraph under it
   * are what a model reads as "what am I for"; a language named there re-creates
   * the defect however even-handed the body is. The body MUST name many
   * languages — that is where the sharpness lives — so the assertion is scoped
   * to the opening, and the boundary is the sentence that hands the choice to
   * the repository.
   *
   * Word-bounded rather than substring: `Go` and `Java` are substrings of
   * ordinary prose, and a probe that reddened on the word "Going" would be
   * deleted by the first person it inconvenienced.
   *
   * CASE-INSENSITIVE, and a mutation is why. The first version used a
   * case-sensitive `\bTypeScript\b`; the battery restored the old heading
   * — `## Your angle: THE TYPESCRIPT AND JAVASCRIPT LANGUAGE SPECIALIST` — and
   * this stayed GREEN, because headings in this file are upper case and
   * `TYPESCRIPT` is not `TypeScript`. The probe was blind to the exact defect it
   * was written for, in the exact form the defect had.
   */
  test("the angle statement names no language, so no target is assumed", () => {
    const opening = sliceTo(
      LANG!,
      "roles/review/implementation-language.md",
      "**Which language that is",
    );
    for (const named of ["TypeScript", "JavaScript", "Python", "Go", "Rust", "Java", "Kotlin"]) {
      expect(
        new RegExp(`\\b${named}\\b`, "i").test(opening),
        `the angle statement pre-commits the seat to ${named}`,
      ).toBe(false);
    }
  });

  test("the seat is told to SETTLE the language, and from what evidence", () => {
    // The instruction, and the cheap evidence that bounds it — an angle that
    // said "work out the language" without saying how invites the unbounded
    // reading that turn one's stopping rule exists to refuse.
    expect(LANG!, "nothing tells the seat to determine the language").toContain(
      "first thing you do is settle it",
    );
    for (const manifest of ["pyproject.toml", "package.json", "go.mod", "Cargo.toml"]) {
      expect(LANG!, `the seat is not told to look at ${manifest}`).toContain(manifest);
    }
  });

  /**
   * AND TO SAY WHICH ONE. A determination the reviewer never states is one the
   * collator cannot attribute and a person cannot find wrong — the same argument
   * `roles/collator.md` makes for attributing every finding to a lens.
   */
  test("the seat is told to state which language it settled on", () => {
    expect(LANG!, "the seat never has to declare the language it chose").toContain(
      "Say which language\nyou settled on in the first line of your review",
    );
  });

  /**
   * THE ANGLE IS STILL SHARP, checked the only way a string probe can: the four
   * defect classes are named as headings. "Consider the language" would pass
   * every assertion above and is worthless; a seat told which four things to
   * look for is not. This is a floor on specificity rather than a measure of it.
   */
  test("the angle names concrete defect classes rather than a general instruction", () => {
    for (const cls of [
      "escape hatches that switch the checker off",
      "Concurrency, and lifetime",
      "Errors that become values instead of stops",
      "Runtime semantics that read wrong",
    ]) {
      expect(LANG!, `the angle no longer names the defect class "${cls}"`).toContain(cls);
    }
  });

  /**
   * THE SIBLINGS AGREE. Both other aspect files open by telling the reviewer
   * what the other two cover, so a rename that left them saying "TypeScript/
   * JavaScript specifics" would put a stale claim in two of the three briefings
   * — and each reviewer reads its own file, so nothing else would notice.
   */
  test("the other two seats describe this one by its new angle", () => {
    for (const [name, text] of ASPECTS) {
      if (name === "implementation-language") continue;
      expect(text, `${name} still describes the third seat as a TypeScript seat`).not.toContain(
        "TypeScript/JavaScript specifics",
      );
      expect(text, `${name} does not name the third seat's angle at all`).toContain(
        "the implementation language",
      );
    }
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
    const block = sliceFrom(REVIEWER, "roles/reviewer.md", "Quote file and line");
    expect(block).toContain("/workspace/");
    expect(block).toContain("not** the repo-relative form");
    expect(block).toContain("bare number");
  });

  test("both ends agree on the spelling", () => {
    expect(COLLATOR).toContain("container path");
    expect(COLLATOR).toContain("src/foo.ts:12");
  });
});
