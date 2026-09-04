/**
 * The COLLATION ENVELOPE — the review console's third document, and the one
 * §6.8 grades (SRD-REVIEW-CONSOLE §6.8, D8).
 *
 * The console's exchange is three documents and this is the last of them.
 * `dispatch-request.ts` carries the collator's intent out; `replies.ts` carries
 * three harvested reviews back; this module carries the collator's synthesis
 * into a shape a host process can check. Every one of the three is written by a
 * container and read by the host, so all three are untrusted input and all three
 * answer a bad document with a value rather than a throw.
 *
 * ## What this instrument is, stated before what it does
 *
 * **It is not acceptance, and it must not be spelled as acceptance.** §6.8 is
 * explicit and the reason is not stylistic: acceptance in this fleet is a
 * committed argv, resolved from the base SHA, re-run by the harvester in a fresh
 * clone the worker never touched — *"the one piece of evidence in this function a
 * fabricating worker cannot author"* (`adjudicate.ts`). Everything below is a
 * check on JSON the worker wrote. It has none of that independence, and
 * borrowing the word would claim it.
 *
 * So the word is REFUSED rather than merely avoided. A collation naming
 * `acceptance`, `verified` or `status` is rejected with a message saying which
 * document owns that field, on the same argument `DispatchRequestItemSchema`
 * makes at the other end of the exchange: `.strict()` alone answers
 * "unrecognized key", which is the sentence a typo gets and teaches an author
 * nothing about a field that exists elsewhere and is deliberately unavailable
 * here.
 *
 * **What it is instead: a bound on the SHAPE of a claim.** D8's own words are
 * that the recommendation is *"weak on purpose"* and that *"a review's verdict is
 * substantially the worker's own claim, and this design does not fix that."*
 * What the shape buys is narrow and worth stating exactly: a finding has to name
 * somewhere a person can go and look, an agreement has to name who agreed, and a
 * review that found nothing cannot be recorded as a clean pass on its own say-so.
 * A determined fabricator satisfies all three by inventing a plausible
 * `file:line`. The instrument raises the cost of a fabrication and makes the
 * consensus counts legible; it does not detect one.
 *
 * ## The split with the census, and it is a split about WHAT IS REFUSABLE
 *
 * `harvest/collation-census.ts` counts a collation against §6.8's three rules
 * per finding — is this location usable, does this finding name a reviewer —
 * resolving each path against the run's real `container_workdir`. This module
 * decides something different and coarser: **is this document a collation at
 * all.** The line between them is not "shape versus filesystem", it is which
 * failures may cost the WHOLE document.
 *
 * A structural failure must: a document whose lens table double-counts a reader,
 * or that credits a lens which never reported, is not a collation with a defect
 * in it — it is a document whose numbers mean nothing, and admitting it would
 * put a fabricated `3/3` into the record with a green shape check beside it.
 *
 * A locatability failure must NOT. A finding quoting `src/gone.ts:9`, an empty
 * path, a `line: 0`, a `..` that climbs out of the checkout — every one of those
 * is one bad row among fifteen good ones, and the census already grades them as
 * `located < counted` with the reason named. Refusing the document here would
 * throw away fourteen usable findings to punish one, and would do it with a
 * WEAKER test than the census's: a string rule about `..` is not containment,
 * `relative()` against the real workdir is. So this module bounds the TYPE of a
 * location (a string, a whole number) and refuses only what must never be
 * rendered at all, and leaves every judgement about whether a location resolves
 * to the module that can actually resolve it.
 *
 * The failure this division exists to avoid is the one where both modules check
 * containment, disagree by a corner case, and the document is refused by the
 * half with the worse test.
 *
 * ## THE GAP THIS CONTRACT CANNOT CLOSE — the reply plane starves it
 *
 * **Read this before concluding that a thin collation is a bad collator.** The
 * schema below can insist a finding carries a location and a reader. It cannot
 * make the reviewer's findings reach the collator at all, and today they very
 * nearly do not.
 *
 * The measurement, not the suspicion. `relay.ts`'s `harvest` publishes the whole
 * `TaskHarvest` bundle as the reply; that bundle's artifact list is
 * `HarvestedArtifactSchema`, which is `{path, bytes, sha256}` — **no contents**.
 * The reviewer's own `/outbox` is worker-scoped (`render.ts`,
 * `-v <run>/outbox/<worker>:/outbox`), so the collator cannot open it either. A
 * reviewer that files its review at `/outbox/<task-id>/files/review.md` and
 * writes a two-line `summary` beside it has therefore written a document
 * **nothing in this console can read**, and every status stays green while the
 * findings evaporate. That is the same silent-success shape the old
 * `roles/collator.md` had, one document over.
 *
 * The only channel that actually carries prose to the collator is the reviewer's
 * result envelope — `summary`, `notes`, `blockers` — and
 * `skills/pifleet-worker/SKILL.md` tells every worker to *"keep the result
 * envelope itself small"*.
 *
 * **What is in place is a MITIGATION and must not be read as a fix.**
 * `roles/reviewer.md` instructs the reviewer to put its whole review in `notes`,
 * and `roles/collator.md` instructs the collator to repeat that instruction in
 * every brief it writes. Two prompts, deliberately, because the failure is
 * invisible: nothing goes red when a review is unreadable. Both are instructions
 * to a model, and neither is a guarantee.
 *
 * ## The two real fixes, and which one to take
 *
 * Both are changes to the ACTOR (§6.5) and to the reply payload, neither of which
 * is decided yet — `replies.ts`'s own header records that the reply's schema
 * "belongs to the actor" and that §9 Q4 leaves the actor's home BLOCKING.
 *
 * - **A — inline the artifact contents into the reply.** The actor already reads
 *   the outbox to harvest, and `writeReply` takes `unknown`, so this is a payload
 *   change and nothing else: attach each `artifacts[]` entry's text under a byte
 *   cap, beside the digest that already names it.
 * - **B — give the reply a contents channel of its own**, a second mount or a
 *   `/replies/<child-task-id>/` directory the collator lists.
 *
 * **Take A.** Four reasons, in descending order of force. D6 rejected exactly B's
 * shape — a directory the collator enumerates — on the argument that a listing
 * re-introduces the discoverability the outbox contract denies in the other
 * direction, and B would reverse that decision to solve a payload problem. A
 * needs no new mount, so it costs nothing in `assertNoRunDirMount`, nothing in
 * `docker/verbgate`'s policy-integrity loop, and nothing in the mount table; B
 * costs a line in each. `replies.ts` already reserves the payload decision for
 * the actor, so A fills a hole the module left open rather than opening a new
 * one. And the byte cap A needs is a decision that module already records as
 * owed — *"whether the drop needs a byte cap the way `/policy/dispatch` does"* —
 * so A closes two open questions with one number instead of adding a third.
 *
 * **A's cost, stated rather than buried:** the reply grows by the size of every
 * artifact, so a reviewer that writes a 10 MB log makes a reply no model can
 * read. A is only correct WITH the cap, and a cap means truncation — which has
 * to arrive in the collation brief as a named missing thing, the way §6.6
 * already names a missing lens, rather than as prose that quietly stops.
 *
 * ## The finding COUNT is authored AND derived, and that is the point
 *
 * `findings.length` is authoritative — nothing downstream may trust
 * `finding_count` in preference to the list it describes, and `collationCeiling`
 * below counts the array. `finding_count` is kept anyway, required, because it
 * is the COLLATOR'S OWN ARITHMETIC and the census records the two side by side
 * (`declared` against `counted`). A document claiming four findings over a list
 * of two is a truncated report saying so out loud, which is a signal neither
 * number carries alone. Two fields, one authoritative, and the disagreement is
 * a datum rather than a refusal — refusing it here would delete the evidence the
 * census was built to record.
 */
import { z } from "zod";

import { MAX_ITEMS, SESSION_ID_RE, type Verdict, workerId } from "../contracts.ts";
import { collationTaskId, isCollationTaskId } from "./task-ids.ts";

/** The wire tag, so a reader can refuse a shape it does not know. */
export const COLLATION_SCHEMA = "pifleet.collation/v1";

/**
 * The artifact's file name inside `/outbox/<task-id>/files/`.
 *
 * A CONSTANT for `DISPATCH_REQUEST_FILE`'s reason, which applies twice as hard
 * here: two ends have to agree on this name and NEITHER of them is this module.
 * The collator writes it from `roles/collator.md`, the grader looks for it from
 * its own module, and a name spelled once in source and once in a prompt is two
 * spellings that drift. The failure is silent in the worst direction — the
 * grader finds nothing, and a collator that wrote a full structural record is
 * indistinguishable from one that wrote none.
 *
 * `test/unit/collator-role.test.ts` pins the prose to this constant so the drift
 * is a red test rather than a console that reviews correctly and grades blind.
 *
 * `/files/` rather than the task directory root, because that is where the
 * worker skill already sends every non-code artifact and where
 * `TICKET_OPS_ARTIFACT_NAME` already sits. One convention, not two.
 */
export const COLLATION_ARTIFACT_NAME = "collation.json";

/**
 * The longest a `statement` may be, in UTF-16 code units.
 *
 * Smaller than the dispatch request's 32 KiB and for the opposite reason. A
 * brief is instruction and is read once by a model; a statement is a LINE IN A
 * TABLE, read by a person scanning for the finding that matters. 4 KiB is
 * roughly a thousand words, which is already an essay in a field whose job is to
 * say what is wrong in a sentence. The prose report at `/outbox/.../review.md`
 * is where an argument belongs; this document is the index into it.
 */
export const MAX_COLLATION_STATEMENT = 4 * 1024;

/** A repo-relative path is a path. Bounded like the segment sequence it is. */
export const MAX_COLLATION_PATH_CHARS = 1024;

/**
 * The most findings one collation may carry.
 *
 * Bounded, and not by `MAX_ITEMS` (1,000), for the reason
 * `MAX_DISPATCH_REQUEST_ITEMS` gives: `MAX_ITEMS x MAX_COLLATION_STATEMENT` is
 * not a bound anyone intends, it is two independent limits multiplying. 200
 * findings from three readers is already past the point where the role's own
 * instruction — *"do not pad the list; a review with twenty equal-weight items
 * communicates nothing"* — has been ignored, so the bound sits where a document
 * stops being a review and starts being a dump.
 */
export const MAX_COLLATION_FINDINGS = 200;

/**
 * The most lenses a console may have. Eight, matching
 * `MAX_DISPATCH_REQUEST_ITEMS`, because the lens table is the denominator for
 * the fan-out that array describes and two different ceilings on one console's
 * width would be a discrepancy with no cause.
 */
export const MAX_COLLATION_LENSES = 8;

/**
 * Hard byte cap. **Deliberately `MAX_DISPATCH_REQUEST_BYTES`' number and for its
 * argument**: the same directory, the same author, the same untrusted-input
 * posture, and the same failure — buffering a hostile document written by a
 * container into the host process that grades it. Two caps in one outbox that
 * differ by a factor nobody can explain is a maintenance hazard.
 */
export const MAX_COLLATION_BYTES = 4 * 1024 * 1024;

/**
 * `/outbox/<task-id>/files/collation.json`, as the WORKER sees it.
 *
 * Exported for `replyMountPath`'s reason: the collation brief and the role file
 * both have to say this path out loud, and a builder that spelled it at each
 * site would be a second answer to a question this module answers.
 *
 * **It throws on an id it cannot spell**, which is `dispatchRequestPath`'s
 * posture and its argument: a path builder that can silently produce a path
 * outside the subtree it names is a hole at every call site, including the ones
 * that do not exist yet. Nothing on the READ path reaches this throw, because
 * `CollationSchema` holds both ids to the same grammar first and answers with a
 * refusal.
 */
export function collationArtifactPath(taskId: string): string {
  if (!spellable(taskId)) {
    throw new Error(
      `task id ${JSON.stringify(taskId)} cannot name a path segment, so no collation path was ` +
        `built from it — the artifact lives at /outbox/<task-id>/files/${COLLATION_ARTIFACT_NAME} ` +
        `and "join" resolves ".." rather than refusing it`,
    );
  }
  return `/outbox/${taskId}/files/${COLLATION_ARTIFACT_NAME}`;
}

/**
 * Written as an escape rather than as a literal, so the character survives
 * copy-paste, review and every tool between here and the repository. A literal
 * NUL in source is invisible in a diff, which is the wrong property for a
 * character whose whole job is to be refused.
 */
const NUL = String.fromCharCode(0);

/** The grammar every id here is held to before it can become a path segment. */
function spellable(id: string): boolean {
  return id.length > 0 && id.length <= 64 && SESSION_ID_RE.test(id);
}

/**
 * Refused, and declared rather than left to `.strict()` so the refusal can say
 * which document owns the field. `dispatch-request.ts` made this trade first;
 * here it is also D8's line, because the field an author most plausibly reaches
 * for is the one §6.8 says this instrument may not borrow.
 */
const notHere = (message: string) => z.never({ error: message }).optional();

const idField = (label: string) =>
  z
    .string()
    .max(64, { error: `${label} is longer than 64 characters — it names a path segment` })
    .regex(SESSION_ID_RE, {
      error:
        `${label} is not a task id. It must be letters, digits, ".", "_" or "-", beginning and ` +
        `ending alphanumeric — the grammar every name that becomes a host path is held to. A ` +
        `length bound alone accepts "../../control-auth.json".`,
    });

/**
 * One lens of the console, and whether it actually spoke.
 *
 * **This table is the DENOMINATOR.** §6.8 wants `3/3` and `1/3` visible in the
 * record, and a numerator with no denominator is a number: `2` is not `2/3`
 * unless the document says how many lenses there were. So the table is required
 * and its soundness is checked — a duplicate worker would double the
 * denominator, and a duplicate aspect would make two rows for one lens.
 *
 * `reported` is the honest half of §6.6. The collation brief already names which
 * aspects are missing and tells the collator not to write a conclusion implying
 * a lens it did not have; this field is where that instruction becomes a fact in
 * the record instead of a hope about the prose.
 */
export const CollationLensSchema = z
  .object({
    /** The lens' name — the segment the child task id was derived from. */
    aspect: idField("aspect"),
    /** The reviewer that held it. Fixed in config; never chosen here (D11). */
    worker: workerId,
    /** Whether a report for this lens existed to read. */
    reported: z.boolean(),
    /**
     * Why a lens is missing, when one is. Free text and optional, because the
     * collation brief states the reason and copying it forward is worth more
     * than inventing a taxonomy for it.
     */
    note: z.string().max(MAX_COLLATION_STATEMENT).optional(),
  })
  .strict();
export type CollationLens = z.infer<typeof CollationLensSchema>;

/**
 * The path half of a finding's location — bounded, and NOT adjudicated.
 *
 * **Both spellings are accepted**, repo-relative and workdir-absolute, and that
 * is a reversal of the first version of this file worth recording because the
 * first version's argument was good and still lost. It refused an absolute path
 * on the ground that one spelling is better than two — true, and the reason
 * `files_changed[].path` is repo-relative in the result envelope. What it did
 * not weigh is the COST of refusing: a whole collation, fourteen sound findings
 * included, thrown away because a model wrote `/workspace/src/a.ts` instead of
 * `src/a.ts`. That is a legal-document refusal presenting as a policy, which is
 * the failure `MAX_DISPATCH_REQUEST_BYTES` spends a paragraph on: the remedy
 * people reach for is deleting the rule.
 *
 * `findingLocationProblem` in the census resolves both forms against the run's
 * real `container_workdir` with `relative()`, per finding, and reports an
 * unusable one as a defect rather than as a refusal. That is a better test than
 * any string rule available here — it knows the workdir, and a prefix or `..`
 * test does not — so the containment judgement lives there and this field
 * carries only what makes the string safe to hold: a bound, and no control
 * characters.
 *
 * **The control-character refusal stays document-wide, and it is the one rule
 * here that is not about locatability.** A CR or an ANSI introducer in a path is
 * how a worker forges lines in the report that is judging it, and the census's
 * own note says it refuses to ECHO such a path for that reason. A string nobody
 * may safely render has no legitimate form, so it is refused rather than
 * degraded.
 */
const findingPath = z
  .string()
  .max(MAX_COLLATION_PATH_CHARS, {
    error: `a finding's \`file\` is longer than ${MAX_COLLATION_PATH_CHARS} characters`,
  })
  .superRefine((p, ctx) => {
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    const control = /[\x00-\x1f\x7f]/.exec(p);
    if (control !== null) {
      const code = control[0]!.charCodeAt(0).toString(16).padStart(2, "0");
      // The path is NOT echoed back: printing it is the injection this refuses.
      ctx.addIssue({
        code: "custom",
        message:
          `a finding's \`file\` holds a control character (0x${code}) at index ` +
          `${control.index}. A path that cannot be printed cannot be quoted in the report ` +
          `that grades it, and a CR or an ANSI introducer there is a worker writing lines ` +
          `into that report.`,
      });
    }
  });

/**
 * One finding: what is wrong, where, and who said so.
 *
 * The three required fields are §6.8's three requirements, and none of them is
 * optional. **The cost of that, stated rather than buried:** an observation with
 * no location — "the whole approach is wrong", "there is no test strategy" —
 * cannot be recorded here at all. That is a real loss and it is the deliberate
 * side to err on: §10's probe is *"a collation whose findings carry no resolvable
 * `file:line` is not `success`"*, so a location-free entry would be a finding that
 * cannot be graded, sitting in the record as though it had been. The prose report
 * is where a general argument belongs, and the role file says so.
 */
export const CollationFindingSchema = z
  .object({
    /** What is wrong, in a sentence. */
    statement: z
      .string()
      .min(1, { error: "a finding with no statement is not a finding" })
      .max(MAX_COLLATION_STATEMENT),
    file: findingPath,
    /**
     * A whole number here, and 1-BASED at the census.
     *
     * The type is refusable and the value is not, for `findingPath`'s reason:
     * `line: 0` is one unusable row, which the census reports as
     * `located < counted` with the finding named, and refusing the document for
     * it would discard every other finding in the list. A string where a number
     * belongs is a different thing — that is a document that does not have the
     * field §6.8 requires, and it is refused here.
     */
    line: z.number().int({ error: "a finding's `line` must be a whole number" }),
    /**
     * Which lenses raised it. **This is the numerator §6.8 asks for.**
     *
     * Non-empty, because an unattributed finding is the one thing the role file
     * calls "three reviews destroyed to make one". Held against the lens table in
     * the document's own `superRefine`, where both halves are in hand.
     */
    raised_by: z.array(workerId).min(1, {
      error:
        "a finding names no reviewer. §6.8 requires each finding to carry which reviewers " +
        "raised it, so 3/3 and 1/3 are visible in the record; an unattributed finding erases " +
        "the only instrument this console has.",
    }),
    /**
     * Which lenses read the same code and DISAGREED.
     *
     * **Present because the schema would otherwise force a misrepresentation.**
     * §9 Q7's answer is that *"the collator does not vote, it reports who said
     * what"*, and the role file puts contradictions second in the report for that
     * reason. With no way to record dissent, a contradiction can only be entered
     * as a finding both lenses raised — which reads as corroboration and is its
     * exact opposite. Defaulting to empty keeps an ordinary finding free of
     * ceremony.
     */
    disputed_by: z.array(workerId).max(MAX_COLLATION_LENSES).default([]),
  })
  .strict();
export type CollationFinding = z.infer<typeof CollationFindingSchema>;

/**
 * The whole document.
 *
 * The cross-field rules live in one `superRefine` because each of them needs the
 * lens table AND a finding, and a check split across two schemas that each hold
 * half the document is a check that lapses the day one half moves.
 */
export const CollationSchema = z
  .object({
    schema: z.literal(COLLATION_SCHEMA, {
      error:
        `not a ${COLLATION_SCHEMA} document. The tag is checked by name rather than inferred ` +
        `from the shape, because pifleet.result/v1 also carries a task_id and an array and is ` +
        `close enough that a reader could hand one over by mistake.`,
    }),
    /** The COLLATION task's id — `T-collate`, not the review request's `T`. */
    task_id: idField("task_id"),
    /**
     * The review request the operator actually made.
     *
     * **This field is the whole of D5's mitigation.** Under D5 the parent task
     * settles when the fan-out is issued rather than when the review is done, so
     * a reader asking "what came of `T`?" has to follow a link — and the link is
     * arithmetic rather than a lookup. Carrying the parent here means the
     * collation can be tied back to the request from the document alone, with no
     * record that may not exist.
     */
    parent_task_id: idField("parent_task_id"),
    lenses: z
      .array(CollationLensSchema)
      .min(1, {
        error:
          "lenses[] is empty, so the record has no denominator: a finding raised by two " +
          "reviewers is `2`, and §6.8 asks for `2/3`.",
      })
      .max(MAX_COLLATION_LENSES),
    /**
     * The collator's OWN count of what it found — §6.8 rule 1, as authored.
     *
     * **Not authoritative and required anyway.** `findings.length` is what every
     * consumer counts, including `collationCeiling` below; this number exists so
     * the census can put `declared` beside `counted` and let a disagreement be
     * read. A collator that writes a prose report with four findings and a list
     * with two has truncated itself, and neither number says so alone.
     *
     * It is REQUIRED rather than optional because an optional field is one a
     * collator omits on the run where it would have disagreed. Bounded by
     * `MAX_ITEMS` rather than by `MAX_COLLATION_FINDINGS`, so a collator that
     * honestly found more than the list can hold can still say so.
     */
    finding_count: z
      .number()
      .int({ error: "finding_count must be a whole number" })
      .nonnegative({ error: "finding_count cannot be negative" })
      .max(MAX_ITEMS, {
        error:
          `finding_count above ${MAX_ITEMS} is not arithmetic, it is noise — the list itself is ` +
          `capped at ${MAX_COLLATION_FINDINGS} and a declared count this far above it says ` +
          `nothing a reader can act on`,
      }),
    /** The findings themselves. **This array's length is the count that binds.** */
    findings: z.array(CollationFindingSchema).max(MAX_COLLATION_FINDINGS),

    // ── The three fields this document may not have (D8, §6.8) ─────────────
    acceptance: notHere(
      'a collation may not name "acceptance" (SRD-REVIEW-CONSOLE D8, §6.8). Acceptance in this ' +
        "fleet is a committed command re-run by the harvester in a fresh clone the worker never " +
        "touched — the one piece of evidence a fabricating worker cannot author. This document " +
        "is worker-authored JSON and has none of that independence, so calling any part of it " +
        "acceptance would claim an independence it does not possess.",
    ),
    verified: notHere(
      'a collation may not name "verified" (SRD-REVIEW-CONSOLE D8, §6.8). Nothing in this ' +
        "document is verified; it is a claim whose SHAPE is checked. The distinction is the " +
        "whole of D8 and a field asserting the stronger word would erase it.",
    ),
    status: notHere(
      'a collation may not name "status" — that field belongs to pifleet.result/v1, which is ' +
        "the document the harvester reads. A second status here would be a second claim about " +
        "one task, read by nothing, free to disagree with the first.",
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    // ── The denominator has to be sound before anything counts against it. ──
    const seenWorkers = new Set<string>();
    const seenAspects = new Set<string>();
    for (const lens of v.lenses) {
      if (seenWorkers.has(lens.worker)) {
        ctx.addIssue({
          code: "custom",
          path: ["lenses"],
          message:
            `"${lens.worker}" appears as two lenses. The lens table is the denominator §6.8's ` +
            `3/3 is read against, so a repeated worker inflates it and one reader is counted ` +
            `twice — the same fabrication resolveAspects refuses for duplicate seats.`,
        });
      }
      if (seenAspects.has(lens.aspect)) {
        ctx.addIssue({
          code: "custom",
          path: ["lenses"],
          message: `the aspect "${lens.aspect}" appears twice, so one lens has two rows`,
        });
      }
      seenWorkers.add(lens.worker);
      seenAspects.add(lens.aspect);
    }

    const reported = new Set(v.lenses.filter((l) => l.reported).map((l) => l.worker));
    if (reported.size === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["lenses"],
        message:
          "no lens reported, so this collation describes a task that cannot exist: §6.6's join " +
          "dispatches NO collation when zero children succeed. Accepting it would let a review " +
          "be recorded out of a fan-out that produced nothing.",
      });
    }

    // ── Attribution, against the table above. ───────────────────────────────
    v.findings.forEach((f, i) => {
      const claimed = new Set<string>();
      for (const w of f.raised_by) {
        if (claimed.has(w)) {
          ctx.addIssue({
            code: "custom",
            path: ["findings", i, "raised_by"],
            message:
              `"${w}" is named twice as having raised this finding, which turns 1/${v.lenses.length} ` +
              `into 2/${v.lenses.length} in any reader that counts the array`,
          });
        }
        claimed.add(w);
        if (!seenWorkers.has(w)) {
          ctx.addIssue({
            code: "custom",
            path: ["findings", i, "raised_by"],
            message:
              `"${w}" raised this finding but is not a lens of this console. Aspects are ` +
              `assigned by config (D11) and the lens table is the whole set of readers.`,
          });
        } else if (!reported.has(w)) {
          ctx.addIssue({
            code: "custom",
            path: ["findings", i, "raised_by"],
            message:
              `"${w}" is credited with this finding and its lens did not report. A missing ` +
              `reviewer is not a reviewer that agreed: this is how a two-lens review records ` +
              `3/3, which is the exact reading §6.8 exists to make impossible.`,
          });
        }
      }
      for (const w of f.disputed_by) {
        if (claimed.has(w)) {
          ctx.addIssue({
            code: "custom",
            path: ["findings", i, "disputed_by"],
            message:
              `"${w}" is recorded as both raising and disputing this finding. That is not a ` +
              `contradiction, it is one reader counted on both sides of it.`,
          });
        }
        if (!seenWorkers.has(w)) {
          ctx.addIssue({
            code: "custom",
            path: ["findings", i, "disputed_by"],
            message: `"${w}" disputed this finding and is not a lens of this console`,
          });
        } else if (!reported.has(w)) {
          ctx.addIssue({
            code: "custom",
            path: ["findings", i, "disputed_by"],
            message:
              `"${w}" is recorded as disputing this finding and its lens did not report — a ` +
              `lens that produced nothing took no position`,
          });
        }
      }
    });
  });
export type Collation = z.infer<typeof CollationSchema>;

/**
 * Why a collation was refused, as a value rather than as prose.
 *
 * `DispatchRefusal`'s shape and its argument: the code is the assertion surface
 * and `reason` is the explanation, so a caller telling two refusals apart is
 * pinning a rule rather than a sentence.
 *
 * `task_id_mismatch` is separate from `schema` because the two are different
 * facts about different people. A schema failure is a malformed document; an id
 * mismatch is a WELL-FORMED collation filed against the wrong review, and the
 * reason has to name both ids for anyone to act on it.
 */
export type CollationRefusal = "too_large" | "not_json" | "schema" | "task_id_mismatch";

/**
 * The three outcomes, shaped like `DispatchRequestRead` and for its reasons.
 *
 * **`missing` is its own variant and is not a refusal.** A review task with no
 * collation artifact is a fact the grader has to act on differently from one
 * with a broken artifact: the first is a worker that never wrote, the second is
 * a worker that wrote something wrong, and folding them together produces a
 * grader that cannot say which happened.
 */
export type CollationRead =
  | { kind: "missing" }
  | { kind: "refused"; code: CollationRefusal; reason: string }
  | { kind: "ok"; collation: Collation };

/** The first issue, rendered so a refusal reads as a sentence. */
function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) return "the document did not validate";
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

/**
 * Read one collation artifact's bytes.
 *
 * `null` means the file is absent — the grader stats the disk, this module
 * judges what it found, and passing `null` rather than requiring the caller to
 * construct a `{kind: "missing"}` keeps one entry point for every case.
 *
 * **It never throws.** The grader runs over worker-authored files in a poll, and
 * a reader that throws on a hostile document is a reader that takes the grader
 * down with it (ISC-216's shape, one directory over).
 */
export function readCollation(bytes: string | null): CollationRead {
  if (bytes === null) return { kind: "missing" };
  /*
   * Measured in BYTES rather than code units, because the cap is about what the
   * host buffers and a document of astral characters is longer on disk than
   * `.length` says. The grader is expected to have refused an oversize file from
   * `fstat` already; this is the second line, at the same number, for
   * `MAX_DISPATCH_REQUEST_BYTES`' reason — a cap enforced only at the outer edge
   * is a cap that lapses when a second caller appears.
   */
  if (Buffer.byteLength(bytes, "utf8") > MAX_COLLATION_BYTES) {
    return {
      kind: "refused",
      code: "too_large",
      reason: `the collation artifact is larger than ${MAX_COLLATION_BYTES} bytes`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (err) {
    return {
      kind: "refused",
      code: "not_json",
      reason: `the collation artifact is not JSON: ${(err as Error).message}`,
    };
  }
  const result = CollationSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "refused", code: "schema", reason: firstIssue(result.error) };
  }
  const collation = result.data;
  /*
   * The link, checked rather than assumed. `collationTaskId` is IMPORTED from
   * `relay.ts` rather than re-spelled as `${parent}-collate`, because the suffix
   * is already a constant there and a second spelling is how the two documents
   * eventually disagree about which task a collation belongs to. The check is
   * intra-document — both ids are in the file — so it needs nothing from the
   * caller and cannot be forgotten by one.
   */
  const expected = collationTaskId(collation.parent_task_id);
  if (collation.task_id !== expected) {
    return {
      kind: "refused",
      code: "task_id_mismatch",
      reason:
        `the collation claims task_id ${JSON.stringify(collation.task_id)} against parent ` +
        `${JSON.stringify(collation.parent_task_id)}, whose collation is ` +
        `${JSON.stringify(expected)}. The ids are DERIVED rather than minted (§6.6) precisely ` +
        `so the two halves of one review can be tied together without a lookup, and a document ` +
        `filed under the wrong one breaks the only link D5 leaves.`,
    };
  }
  return { kind: "ok", collation };
}

/** How many lenses spoke, and which did not. */
export interface LensCoverage {
  /** Every lens the console has — §6.8's denominator. */
  readonly total: number;
  /** How many produced a report to read. */
  readonly reported: number;
  /** The ASPECTS that did not, named, because a count cannot say which. */
  readonly missing: readonly string[];
}

/**
 * Coverage as a DATUM beside the verdict, never folded into it.
 *
 * §9 Q6 asks whether `partial` is even the right axis for a two-of-three review
 * — *"`partial` in this fleet has meant 'the work was partly done'. A two-lens
 * review is complete work with a missing lens."* That question is open, and this
 * function is what lets it stay open: the coverage is readable on its own terms
 * whichever way the verdict axis is eventually decided, and nothing here forces
 * the answer. **It is not consulted by `collationCeiling`** for exactly that
 * reason — see that function's note on the gap that leaves.
 */
export function lensCoverage(collation: Collation): LensCoverage {
  return {
    total: collation.lenses.length,
    reported: collation.lenses.filter((l) => l.reported).length,
    missing: collation.lenses.filter((l) => !l.reported).map((l) => l.aspect),
  };
}

/**
 * The reviewers a finding may legitimately be attributed to — the roster the
 * census checks `raised_by` against.
 *
 * **Exported so the census does not need a flat `reviewers[]` field beside the
 * lens table.** `collation-census.ts` names three fields it cannot do without
 * and a top-level roster is effectively a fourth; a document carrying both would
 * spell one set twice, and the day they disagree the record says a lens both did
 * and did not read the change.
 *
 * It is the REPORTED lenses and not every lens, which is the same narrowing
 * `CollationSchema`'s attribution rule enforces. The difference matters and is
 * the reason the lens table is richer than a list of ids: a flat roster of the
 * lenses that spoke loses the DENOMINATOR, so a finding raised by two of three
 * readers and one raised by two of two both read as `2` — and §6.8 asks for
 * `2/3`. `lensCoverage` is where the denominator stays legible.
 */
export function reportedReviewers(collation: Collation): readonly string[] {
  return collation.lenses.filter((l) => l.reported).map((l) => l.worker);
}

/** The status a record may carry, and why it is not the claimed one. */
export interface CollationCeiling {
  readonly status: Verdict;
  /** Null when the instrument had nothing to say — i.e. the claim stands. */
  readonly reason: string | null;
}

/**
 * §6.8's third bullet: *"a collation with zero findings and `status: 'success'`
 * is `partial`, not `success` — 'I found nothing' from three readers is a claim
 * that needs a human."*
 *
 * ## It is a CEILING and can never supply a verdict
 *
 * The claimed status is the ANTECEDENT, exactly as §6.8 words it, and that is
 * what makes the direction safe rather than merely intended. A function that
 * took only the document would return `partial` for a claim of `failed` too —
 * and combined through `adjudicate`, where `unknown` is the identity, it would
 * SUPPLY `partial` to a task whose worker never wrote an envelope at all. That
 * is the shape ISC-94 exists to refuse: a missing envelope must not clamp.
 * Taking the claim removes the possibility rather than documenting it.
 *
 * ## The three arms, and why a narrower rule would be worthless
 *
 * `missing` and `refused` are here beside `zero findings` because a rule that
 * fired only on a well-formed empty document would be trivially avoidable in the
 * two directions that cost nothing: write no artifact, or write a broken one.
 * All three are the same claim — "three readers, nothing to show" — arriving by
 * three routes, and §10's grading probes name two of them in as many words.
 *
 * ## Why the TASK ID is a parameter, and it is not defensive programming
 *
 * The `missing` arm is powerful in a way that is dangerous one call site away.
 * Every task in the fleet is missing a collation artifact, so a caller that
 * reached this with a build task's `success` claim would cap it at `partial` —
 * and the caller would be RIGHT to think it was asking a sensible question,
 * because there is no artifact.
 *
 * The specific caller that would be wrong is the one this design creates.
 * §6.6 makes a review TWO tasks: the fan-out task `T`, whose whole job is to
 * issue the request and which settles `success` the moment it has, and the
 * collation task `T-collate`, which is the one that reads three replies and
 * writes a collation. `T` legitimately has no collation artifact and must not be
 * capped for it. Both tasks belong to the same review, run on the same worker,
 * and are graded by the same code — so "apply this only to the second one" is a
 * rule that has to hold in the caller's head on every future edit.
 *
 * `isCollationTaskId` is already the fleet's answer to "is this the collation
 * half?" — `dispatch-request.ts` uses it as T5's depth bound — so the guard is
 * imported rather than restated, and the function cannot be misapplied instead
 * of merely being documented as not-to-be. It carries that predicate's known
 * cost unchanged: an operator task genuinely named `something-collate` is
 * treated as a collation. That is a false RED that names its rule, which is the
 * correct side to err on when the false GREEN is a review graded on nothing.
 *
 * ## What it deliberately does NOT do, so the gap is named rather than found
 *
 * **It does not cap a `success` claimed over a partial fan-out.** The document
 * carries the coverage (`lensCoverage`), so the check is available, and it is
 * not made here: §6.6 already routes that case by putting `partial` in the
 * collation BRIEF, and §9 Q6 has not settled whether coverage belongs on the
 * verdict axis at all. Deciding it inside a §6.8 instrument would be answering
 * an open question in the wrong file. The consequence, stated plainly: a
 * collator that ignores its brief and claims `success` over two lenses is capped
 * by nothing here, and `lensCoverage` is what a grader would use to close it.
 */
export function collationCeiling(
  taskId: string,
  claimed: Verdict,
  read: CollationRead,
): CollationCeiling {
  if (!isCollationTaskId(taskId)) return { status: claimed, reason: null };
  if (claimed !== "success") return { status: claimed, reason: null };
  switch (read.kind) {
    case "missing":
      return {
        status: "partial",
        reason:
          `the task claims success and wrote no ${COLLATION_ARTIFACT_NAME}, so there is no ` +
          `finding count, no location and no attribution to read — a review recorded as a ` +
          `clean pass on nothing but its own say-so`,
      };
    case "refused":
      return {
        status: "partial",
        reason:
          `the task claims success and its ${COLLATION_ARTIFACT_NAME} was refused (${read.code}): ` +
          `${read.reason}`,
      };
    case "ok":
      if (read.collation.findings.length === 0) {
        return {
          status: "partial",
          reason:
            `the collation carries zero findings and the task claims success. "I found nothing" ` +
            `from ${read.collation.lenses.length} readers is a claim that needs a human, not a ` +
            `verdict this console can record on its own.`,
        };
      }
      return { status: "success", reason: null };
  }
}
