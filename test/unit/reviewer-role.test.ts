import { MAX_TEXT, RESULT_ENVELOPE_NAME, ResultEnvelopeSchema } from "../../src/contracts.ts";
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
import { PI_ALL_TOOLS } from "../../src/config/schema.ts";
import {
  MAX_REPLY_ARTIFACT_BYTES,
  MAX_REPLY_INLINE_BYTES,
} from "../../src/run/relay.ts";
import { REPLIES_MOUNT } from "../../src/run/replies.ts";
import { childTaskId } from "../../src/run/task-ids.ts";
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
 */
describe("the review is a file, notes is a summary, and both ends say so", () => {
  test("the reviewer is told to file the long review AND to keep notes short", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("THE LONG REVIEW GOES IN A FILE"));
    expect(
      block.length,
      "roles/reviewer.md no longer carries the instruction in its own right",
    ).toBeGreaterThan(0);
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
   * The artifact has to be CLAIMED, not merely written. `reconcile.ts` grades an
   * empty `artifacts` array against the files actually in the outbox — "the
   * worker wrote an envelope and said it produced nothing, so every file in the
   * outbox contradicts it" — so a review filed and not declared is a discrepancy
   * on the reviewer's own record.
   */
  test("the reviewer is told to DECLARE the review file in the envelope", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("THE LONG REVIEW GOES IN A FILE"));
    expect(block).toContain("`artifacts` array");
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
  test("the caps the document states are the caps the code actually enforces", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("THE LONG REVIEW GOES IN A FILE"));
    expect(block, "the per-file cap is not the one relay.ts applies").toContain(
      `size cap: ${MAX_REPLY_ARTIFACT_BYTES / 1024} KiB per file`,
    );
    expect(block, "the per-reply cap is not the one relay.ts applies").toContain(
      `and ${MAX_REPLY_INLINE_BYTES / 1024} KiB across all of them`,
    );
    expect(block, "the notes cap is not the one the envelope schema applies").toContain(
      `at the same ${MAX_TEXT} bytes`,
    );
    // The consequence, not just the number.
    expect(block).toContain("cut off");
  });

  /**
   * THE ASYMMETRY, which is the whole argument and the one sentence a model
   * under budget pressure would drop first.
   *
   * `MAX_TEXT` and `MAX_REPLY_ARTIFACT_BYTES` are the SAME 65536, so a document
   * that stated both caps and stopped there would have given the reviewer no
   * reason to prefer either channel. What separates them is what happens at the
   * ceiling: an over-cap artifact arrives truncated and is NAMED in the
   * collation brief, while an over-cap `notes` fails `ResultEnvelopeSchema` and
   * takes the status, the summary, the blockers and the review with it.
   */
  test("the document states the ASYMMETRY, not merely the two caps", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("THE LONG REVIEW GOES IN A FILE"));
    expect(block, "the document does not say the two caps fail differently").toContain(
      "Same ceiling, opposite failure",
    );
    // The premise that makes the asymmetry the point rather than a curiosity.
    expect(MAX_TEXT).toBe(MAX_REPLY_ARTIFACT_BYTES);
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
  test("the document says plainly that the file does NOT rescue a broken envelope", () => {
    const block = REVIEWER.slice(REVIEWER.indexOf("THE LONG REVIEW GOES IN A FILE"));
    expect(block, "the document does not say a broken envelope loses the lens").toContain(
      "It does\nnot rescue the lens",
    );
    expect(block, "the document does not name the mechanism").toContain(
      "no reply published for it",
    );
  });

  /**
   * THE WORKED EXAMPLE IS PARSED, not eyeballed — `collator-role.test.ts`'s
   * discipline applied to the other end. An example a model copies literally is
   * the most load-bearing prose in the file, and one the real schema refuses
   * teaches exactly the shape the harvester throws away.
   */
  test("the example envelope validates, and declares the review as an artifact", () => {
    const blocks = [...REVIEWER.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length, "the document has no worked envelope").toBeGreaterThanOrEqual(1);
    /*
     * THE TWO ID PLACEHOLDERS ARE SUBSTITUTED, and only those two.
     *
     * `task_id` and `worker` are held to `SESSION_ID_RE`, which no angle-bracket
     * placeholder can satisfy — so validating the block verbatim would fail on
     * the document's own teaching device rather than on anything wrong with it.
     * The substitutes are the REAL ids this seat uses, not filler, so the example
     * is checked against values the fleet would actually produce. Everything else
     * — schema tag, status, and the artifact claim this probe exists for — is
     * validated exactly as written.
     */
    const filled = blocks[0]!
      .replace("<your task id>", childTaskId("T", "lang"))
      .replace("<your worker id>", "rev-lang-1");
    const doc = JSON.parse(filled);
    const r = ResultEnvelopeSchema.safeParse(doc);
    expect(r.error?.message ?? "accepted").toBe("accepted");
    const parsed = ResultEnvelopeSchema.parse(doc);
    expect(
      parsed.artifacts.map((a) => a.path),
      "the worked envelope does not claim the review file",
    ).toContain("/outbox/<task-id>/files/review.md");
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

  /**
   * BOTH ENDS SAY THE SAME THING, which is the part a single-ended probe cannot
   * see. The collator repeats this instruction in every brief it writes, so a
   * collator still telling reviewers to put the whole review in `notes` would
   * re-create the defect on a fleet whose reviewer role had already been fixed.
   */
  test("the collator's copy instructs the same split the reviewer's does", () => {
    const block = COLLATOR.slice(COLLATOR.indexOf("file its long review"));
    expect(block.length, "the collator no longer instructs the file split").toBeGreaterThan(0);
    expect(block, "the collator does not name the review's destination").toContain(
      "/outbox/<task-id>/files/review.md",
    );
    expect(block, "the collator does not require the artifact to be declared").toContain(
      "`artifacts` array",
    );
    expect(block).toContain("roles/reviewer.md");
    expect(block).toContain("Say it");
  });

  /**
   * And the collator's copy carries the same correction about WHY, for the same
   * reason the reviewer's does: a collator that believes the artifact rescues a
   * broken envelope writes briefs that say so.
   */
  test("the collator's copy does not promise the file survives a broken envelope", () => {
    const block = COLLATOR.slice(COLLATOR.indexOf("file its long review"));
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
   * those are the ones a model acts on. `roles/reviewer.md:39-138` — the four
   * envelope sections `submit_report` makes redundant — is task 8.1's and stays
   * deferred; deleting it is a size decision that costs nothing when it is late.
   * A false statement of the grant is not that kind of debt.
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
    const cut = LANG!.indexOf("**Which language that is");
    expect(cut, "the angle statement's boundary sentence is gone").toBeGreaterThan(0);
    const opening = LANG!.slice(0, cut);
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
