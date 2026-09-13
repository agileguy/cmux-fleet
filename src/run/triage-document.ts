/**
 * `triage.json`'s schema — SRD-TRIAGE-CONSOLE §7.5; §13 task 5.5a.
 *
 * **The asymmetry this module exists to correct is stated in §7.5 itself**, in a
 * GAP note added while task 5.3 was being implemented: §7.6's per-service records
 * are *"Zod-validated on read, so a malformed record refuses rather than being
 * acted on"*, while this contract *"has no schema, and no task in §13 assigns it
 * one"*. `assessTriageSweep` takes an already-typed {@link TriageDocument}, so
 * *"between the file a container wrote and `assessTriageSweep` … **there is
 * currently no validator at all**. The asymmetry is the wrong way round: §7.6 is
 * written by the host and §7.5 is written by a worker, and it is the untrusted one
 * that is unchecked."*
 *
 * ## What the absent validator was actually costing, measured rather than feared
 *
 * The hole is not theoretical and it is not merely "an unchecked cast". Drive
 * `roles/triage.md:288-324`'s own worked example — the document this fleet's
 * prompt tells `tri-1` to write — into `evidenceGaps` (`triage-verdict.ts:285`)
 * and two things happen, neither of them a refusal:
 *
 *  - `coverage` is spelled there as an array of channel NAMES (`["rollout",
 *    "logs"]`) where {@link CoverageEntry} is `{channel, result}`. `attempted`
 *    reads `entry.result`, gets `undefined`, and `undefined !== "not_attempted"`
 *    is **true** — so every string in that array counts as an attempted channel
 *    and §6.7 rule 2's first condition can never fail. **The evidence gate passes
 *    a row that carries no evidence at all**, which is the exact inversion §6.7
 *    was written to prevent.
 *  - `evidence_ref` is spelled there as a single STRING where {@link TriageRow}
 *    holds a ledger array. `row.evidence_ref.some` is not a function on a string,
 *    so the sweep throws out of the verdict rather than returning one.
 *
 * The two shapes on either side of this boundary DID disagree, one of the
 * disagreements was silent, and the silent one failed OPEN — see
 * {@link TRIAGE_DOCUMENT_HISTORY}, kept after the correction because the failure
 * mode is the interesting part and a fixed bug with no record is one that comes
 * back. `test/unit/triage-document.test.ts` drives `roles/triage.md`'s own
 * example through this schema, so the divergence cannot be outlived by either
 * side changing alone.
 *
 * ## Refused BY NAME, and each name reachable by exactly ONE fault
 *
 * §13 task 5.5a: *"a document with a row missing `assessment`, one with an unknown
 * assessment value, and one that is not an object each refuse by name rather than
 * reaching `assessTriageSweep`"*. Two of those three land on the SAME field path,
 * so a refusal carrying only a path cannot separate them.
 *
 * **And zod cannot separate them either — measured, not assumed.** For a
 * `z.enum` field, zod 4.1 emits a BYTE-IDENTICAL issue for a missing key and for
 * an unknown value: both are `invalid_value` at the same path with the message
 * *"Invalid option: expected one of …"*, and the issue object carries no `input`
 * to tell them apart. So a schema that reported zod's own classification would
 * answer 5.5a's first two cases with one answer — the degenerate fixture, arriving
 * through the validator rather than through a test — and would tell an operator
 * whose worker omitted `assessment` to go and check the SPELLING of a field that
 * is not there.
 *
 * {@link classifyFault} is the repair, and it is sound for a reason particular to
 * this input: the document came through `JSON.parse`, where `undefined` is not
 * representable. So `undefined` at an issue's path means the key was ABSENT and
 * can mean nothing else, while `null` — which JSON can express — is a key that is
 * present and wrong. {@link TriageDocumentIssue} therefore carries a
 * {@link TriageDocumentFault} of this module's own, and the three acceptance cases
 * separate as `not_an_object`, `schema`/`missing` and `schema`/`invalid`.
 *
 * ## Three places this schema is deliberately LOOSER than it could be
 *
 * Each is a gate downstream that a tighter schema would make unreachable — *"a
 * gate whose inputs cannot express the failure is a gate that cannot fail"*
 * ({@link TriageRow}'s own docblock), and a validator that quietly deletes a
 * check is worse than no validator because it looks like more safety:
 *
 *  1. **`coverage: []` and `evidence_ref: []` are legal.** An empty `coverage[]`
 *     and an empty ledger are two of §6.7 rule 2's five conditions. A `.min(1)`
 *     on either would refuse the document the gate exists to downgrade.
 *  2. **`selector`, `window`, `observer` and `sweep_id` accept ABSENT as `null`.**
 *     Their absence is what §6.7 rule 2 and §6.6 layer 3 test for, and
 *     `sweepIdEcho` names an `absent` state outright (`triage-verdict.ts:338`).
 *     Requiring the keys would make `absent` unreachable from a real document and
 *     turn a freshness check into a formality.
 *  3. **Two rows for one service PASS.** `assessTriageSweep` refuses that per
 *     SERVICE and says why at `triage-verdict.ts:574-592` — *"a host that accepted
 *     two rows because they happened to match would be reconciling them, and
 *     reconciling is judging"*. A `.superRefine` dedup here would refuse the whole
 *     document instead and delete a decision that was reached after two mutation
 *     rounds.
 *
 * Everything else is `.strict()` and refused whole, on §6.4's posture for a
 * worker-written file: a key this host does not implement means the writer is
 * working to a contract the reader does not have, and the reader cannot know
 * whether the part it could not read was the load-bearing part.
 *
 * ## The ONE prose field, and the one bound that is measured in bytes
 *
 * §13 task 5.8 grew this contract a `note` — one optional sentence per row, the
 * only worker-authored PROSE the document carries and the only string on it whose
 * purpose is to be read by a person. Everything above is bounded in code units;
 * {@link noteField} is bounded in **bytes**, because it is the one field that is
 * re-emitted into a byte-measured place (`fenceEvidence`'s cap, ntfy's limits,
 * §6.9's header boundary) and a character bound there is nominal.
 *
 * **The field is what makes §6.9's containment machinery reachable at all.** Until
 * it existed the pass had no prose to carry, so it passed `evidence: null` to
 * every announcement and the whole banner-marked block was structurally
 * unreachable in production — a guard standing over a road nobody used. §12's D10
 * marker criterion, which asks for a fixture *"whose prose fields contain a marker
 * string"*, had no prose field to put one in.
 *
 * **And what it deliberately is NOT: an input to the evidence gate.**
 * `evidenceGaps` reads four structured fields and does not read this one. A note
 * that counted toward §6.7 rule 2 would let a worker clear its own `healthy`
 * downgrade by writing a paragraph — the claim-over-count inversion the gate
 * exists to prevent, arriving through the field that is pure claim.
 *
 * ## The document may not say who wrote it
 *
 * `worker` is a field of {@link TriageDocument} and is NOT a field of this schema.
 * It comes from {@link TriageDocumentContext}, which the host fills from the
 * outbox directory the file was found in — `dispatch-request.ts`'s rule, quoted:
 * *"the document must never be able to say who wrote it"*. A `worker` key is
 * refused with a message that says so rather than with `.strict()`'s bare
 * "unrecognized key", because the field EXISTS on the value this parse produces
 * and an operator reading a generic refusal would go looking for a typo.
 */

import { z } from "zod";

import { SESSION_ID_RE } from "../contracts.ts";
import { MAX_SERVICES_PER_ENVIRONMENT } from "./triage-targets.ts";
import {
  COVERAGE_RESULTS,
  OBSERVER_ASSESSMENTS,
  TRIAGE_NOTE_MAX_BYTES,
  type TriageDocument,
  type TriageRow,
} from "./triage-verdict.ts";

/**
 * The tag `roles/triage.md:292` tells the worker to write.
 *
 * Checked by name, on `DISPATCH_REQUEST_SCHEMA`'s precedent
 * (`dispatch-request.ts:132`): the fleet's other worker-written document carries
 * one, and a document that does not declare which contract it was written against
 * is one whose absent fields cannot be told from fields it never had.
 */
export const TRIAGE_DOCUMENT_SCHEMA = "pifleet.triage/v1";

/**
 * The divergence this module found, carried where a reader of the code will meet
 * it — kept after the repair, because a fixed bug with no record is one that
 * comes back.
 *
 * Neither this constant nor the test that drives it changes any behaviour. It is
 * here for `ADVANCE_READS_NO_SUBJECT_FIELD`'s reason (`triage-incident.ts:966`):
 * a promise that lives only in a test file is one a reader of the module never
 * sees.
 *
 * **The clause *"and cannot itself repair"* was dropped by §13 task 5.8, and the
 * deletion is the lesson rather than a tidy-up.** It was written when
 * `roles/triage.md` was outside the editing task's reach, and it hardened a
 * one-round scheduling accident into a sentence that read like a rule. ISC-651
 * names the rule that actually applies: **a schema change obliges the
 * model-facing prompt edit in the SAME task**, whatever the wire tag does — so a
 * task that changes this file and cannot reach `roles/triage.md` is a task scoped
 * wrongly, not a constraint to record.
 */
export const TRIAGE_DOCUMENT_HISTORY =
  "roles/triage.md's worked example disagreed with §7.5's host contract in three places until " +
  "2026-09-06: coverage[] was an array of channel names rather than {channel, result} " +
  "entries, evidence_ref was a single string rather than a ledger array, and unaccounted[] " +
  "was an array of objects rather than of service names. Two of the three would have refused " +
  "the sweep. The coverage one FAILED OPEN and is why this constant is kept after the fix: a " +
  "string entry has no `result`, `undefined !== \"not_attempted\"` is true, and every channel " +
  "NAME therefore counted as an attempted channel — so §6.7 rule 2's first condition could " +
  "never fail and a row carrying no evidence at all passed the gate built to catch it. " +
  "test/unit/triage-document.test.ts now parses the document's own example through this " +
  "schema, so neither side can drift again alone.";

/** Prose the worker chose: bounded, never a path, never a segment. */
const shortStr = z.string().max(4096);

/**
 * A service name, held to the grammar `triage/targets.yaml` holds it to.
 *
 * **This is a traversal refusal one layer earlier than it strictly has to be.**
 * `incidentRecordPath` (`triage-incident.ts`) throws on a segment it cannot spell,
 * so the containment does not rest here — but a document's service names are
 * compared against the declared set and then travel into per-service record
 * paths, and holding them to the same `SESSION_ID_RE` the targets file uses means
 * a legal document can never name a service a legal targets file could not.
 * `triage-targets.ts:102-117` makes the argument in full: *"it becomes a path
 * segment under ~/.pifleet/triage/, so a name carrying a slash, a space or a
 * leading dot is a directory traversal rather than a label"*.
 */
const triageToken = z
  .string()
  .min(1)
  .max(64)
  .regex(
    SESSION_ID_RE,
    "must be a bare token ([A-Za-z0-9] with . _ - inside) — a service name is compared " +
      "against triage/targets.yaml and becomes a path segment under ~/.pifleet/triage/",
  );

/**
 * §7.5's per-channel coverage entry — SRD-OBSERVER-001 §9.1's two fields.
 *
 * `result` is a closed enum derived from {@link COVERAGE_RESULTS} rather than
 * re-spelled, so adding a fifth result to that constant reddens this file instead
 * of silently admitting a value `attempted` has never seen.
 */
const CoverageEntrySchema = z
  .object({
    channel: shortStr.min(1),
    result: z.enum(COVERAGE_RESULTS),
  })
  .strict();

/**
 * One row — §7.5, and the fields §7.4 requires on the `observer-ops.json` row it
 * is derived from.
 *
 * `assessment` is `z.enum(OBSERVER_ASSESSMENTS)` and not a re-typed list. §12's
 * rule for closed sets in this repository is *"assert the enum's members by name
 * … not by count"*, and the schema half of that is to have exactly one place the
 * members are written down. Adding a fifth assessment to
 * `triage-verdict.ts:143` widens this schema in the same commit or not at all.
 */
/**
 * §13 task 5.8's `note`, *"bounded in bytes and refused above the bound by
 * name"*.
 *
 * ## Why this one field does not use {@link shortStr}
 *
 * Every other string on this document is bounded by `z.string().max()`, which
 * counts UTF-16 **code units**. That is adequate for a selector or a ledger
 * reference, whose only job is to be short. It is not adequate here, because this
 * is the one field whose contents are re-emitted into places measured in bytes —
 * `fenceEvidence`'s cap, ntfy's own limits, §6.9's header boundary. 2,048
 * characters of accented prose is 4,096 bytes, so a code-unit bound of 4,096 would
 * admit twice the payload it appears to. {@link TRIAGE_NOTE_MAX_BYTES} carries the
 * value and the reason it is the value it is.
 *
 * ## Refused BY NAME, which is a property of two things together
 *
 * The issue path is `services.<i>.note`, so the refusal points at a field; and the
 * message names the field, the measured size and the bound, so an operator reading
 * only the sentence knows what to cut and by how much. `Buffer.byteLength` is
 * computed once and spent twice deliberately — a message quoting a length the
 * predicate did not test is a message that can be wrong.
 *
 * ## `.nullable().default(null)` and NOT `.optional()`
 *
 * Absent, and present-as-`null`, are the same fact for this field — the worker had
 * nothing to say — so the default collapses them here rather than leaving
 * `undefined` to travel. That is the opposite of the module docblock's point 2,
 * where `selector`, `window` and `sweep_id` keep `null` as a value a downstream
 * gate reads: **nothing gates on `note`**, so there is no check for the
 * distinction to feed.
 */
const noteField = z
  .string()
  .superRefine((note, ctx) => {
    const bytes = Buffer.byteLength(note, "utf8");
    if (bytes <= TRIAGE_NOTE_MAX_BYTES) return;
    ctx.addIssue({
      code: "custom",
      message:
        `note is ${bytes} bytes and §7.5 bounds it at ${TRIAGE_NOTE_MAX_BYTES} — the bound is in ` +
        `BYTES rather than characters, because this string is re-emitted into a byte-measured ` +
        `evidence block. Put the full account in triage.md; this field is one sentence.`,
    });
  })
  .nullable()
  .default(null);

const TriageRowSchema = z
  .object({
    service: triageToken,
    assessment: z.enum(OBSERVER_ASSESSMENTS),
    /** Empty is LEGAL and is §6.7 rule 2's first condition. See the docblock. */
    coverage: z.array(CoverageEntrySchema).max(MAX_SERVICES_PER_ENVIRONMENT),
    selector: shortStr.nullable().default(null),
    window: shortStr.nullable().default(null),
    /** Empty is LEGAL and is §6.7 rule 2's fourth condition. */
    evidence_ref: z.array(shortStr).max(MAX_SERVICES_PER_ENVIRONMENT).default([]),
    /** The observer the WORKER says produced this row. Recorded, never trusted. */
    observer: shortStr.nullable().default(null),
    /** §13 task 5.8's one prose field. See {@link noteField}. */
    note: noteField,
  })
  .strict();

/**
 * Refused, and declared rather than left to `.strict()` so the refusal can say
 * why — `dispatch-request.ts:623-633` made this trade first and for this reason.
 *
 * `.optional()` is what makes the key ABSENT legal; present with any value at all,
 * `z.never()` fails and the custom text is what the operator reads.
 */
const notReachable = (message: string) => z.never({ error: message }).optional();

/** `triage.json` as it arrives — §7.5, minus the two fields the HOST supplies. */
/**
 * EXPORTED so task 7.3's probe can establish its own premise.
 *
 * That probe's first test refuses a document for being over
 * {@link TRIAGE_DOCUMENT_MAX_BYTES}, and the claim it is making — that the
 * per-field bounds do not compose into a document bound — is only true if the
 * fixture satisfies every one of those fields. Without a way to ask the schema
 * directly, a fixture that broke some unrelated field bound would refuse for
 * the wrong reason and read as proof.
 */
export const TriageDocumentSchema = z
  .object({
    schema: z.literal(TRIAGE_DOCUMENT_SCHEMA, {
      error:
        `not a ${TRIAGE_DOCUMENT_SCHEMA} document. The tag is checked by name so that a ` +
        `document written against a future contract is refused rather than read as this one.`,
    }),
    /**
     * §6.6 layer 3's echo. ABSENT resolves to `null`, which `sweepIdEcho` names
     * `absent` and spends as `stale_replay` — see the module docblock's point 2.
     */
    sweep_id: shortStr.nullable().default(null),
    services: z.array(TriageRowSchema).max(MAX_SERVICES_PER_ENVIRONMENT),
    /** §7.5's *"the services it could not account for, named"* — the worker's CLAIM. */
    unaccounted: z.array(triageToken).max(MAX_SERVICES_PER_ENVIRONMENT).default([]),
    worker: notReachable(
      "worker is not a field of this document. The host knows which seat wrote it from the " +
        "outbox directory it was found in, and a document that could name its own author " +
        "could attribute a sweep to a seat that never ran one.",
    ),
  })
  .strict();

/**
 * The whole document's byte cap — SRD-WORKER-DISPATCH-EXTENSION §13 task 7.3.
 *
 * ## Why a document-wide cap when every field is already bounded
 *
 * Because per-field bounds do not compose into a document bound, and when this
 * cap was written they missed by a factor of about sixty: `services` admitted
 * 64 rows and each row's `note` admitted 4 000 bytes, which is 256 000 bytes
 * before any other field is counted — from a schema every one of whose fields
 * was individually "bounded", and with a single row permitted to be very nearly
 * the whole cap below on its own.
 *
 * Task 7.3 therefore moved BOTH of those to sizes this cap can hold — at the
 * time {@link MAX_SERVICES_PER_ENVIRONMENT} 8 against a 4 096-byte cap, with
 * {@link TRIAGE_NOTE_MAX_BYTES} 1 024 — so that every bound is reachable rather
 * than nominal.
 *
 * **The services cap and this document cap were both DOUBLED on 2026-09-12, to
 * 16 and 8 192; the note cap did not move.** The argument survives because the
 * two that moved moved together, which is this constant's own rule — see the
 * note on the constant below and `triage-targets.ts`. They remain un-composable
 * at their extremes, which is inherent: 16 maximal notes cannot fit in 8 192 and
 * no choice of three numbers makes them. What changed is that each bound can now
 * be hit by a document this parser accepts, instead of describing a document it
 * would always refuse.
 *
 * ## Why 4 096 ORIGINALLY, and the one thing this number is NOT
 *
 * (The cap is 8 192 since 2026-09-12. The measurement below is what sized the
 * original 4 096 and is the reason the raise needed an argument rather than a
 * preference — read it before moving this number again.)
 *
 * §11's Q8 probe measured a local model accepting a 4 KB tool argument intact
 * and **silently delivering 39% of an 8 KB one** — `isError` false, epoch
 * `success`, 3 219 bytes of 8 192 arrived. That is the worst failure shape in
 * the whole document: a green sweep carrying a fraction of its content, which
 * nothing downstream can detect. Phase B removes this role's `write`, so
 * `submit_report` becomes its only route and the report becomes a tool
 * ARGUMENT — which is what puts this console on the wrong side of that number
 * and is why the cap arrives in the same task as the withdrawal.
 *
 * §11's census of 119 real envelopes from this console's three producing seats
 * puts the observed maximum at 1 472 bytes, so this was 2.8x the largest
 * collation this console had written when the cap was first set.
 *
 * **RE-MEASURED 2026-09-12: the largest collation on disk is now 1 863 bytes (3
 * rows, T-sweep-4), across all 109 documents, every one written by `tri-1`.**
 * (The mean and per-row figures quoted at the constant below are over the 103 of
 * those that parse with rows; this maximum is over the full 109.)
 * The census figure is left standing rather than overwritten, because it names a
 * population — 119 envelopes from three producing seats — that a count of
 * collation documents does not reproduce, and replacing it would trade a
 * reconcilable number for a confident wrong one. What is certain either way: the
 * observed maximum has grown and is still under a quarter of the cap.
 *
 * **The number is measured on the model these seats actually run, and checking
 * that took reading the operator's file rather than the tracked one.** The
 * measurement above is `gemma-4-26b-a4b-it-bf16`, and the live `fleet.yaml`
 * puts `tri-1` and `obs-t1` on exactly that model — *"ALL omlx workers on bf16,
 * 2026-09-07 by operator"*. So the cap is sized to the wire this console has.
 *
 * `fleet.example.yaml` is the one that disagrees: it still names
 * `gpt-oss-20b-MXFP4-Q8` for these seats, which appears nowhere in Q8's table
 * and has never been size-probed. A fleet stood up from the tracked example is
 * therefore on an UNMEASURED model behind a cap derived from a different one —
 * conservative if that model is at least as good, unknown if it is not. See
 * ISC-1110; it is a gap in the evidence, not in the cap.
 *
 * A refusal is the right side to err on either way: it is loud, it is
 * recoverable, and it is the opposite of the silent short read it prevents.
 */
/*
 * DOUBLED 4096 -> 8192 on 2026-09-12, by operator instruction, in the same edit
 * as `MAX_SERVICES_PER_ENVIRONMENT` 8 -> 16. The two move together or neither
 * moves — that is this constant's own rule, stated at `triage-targets.ts`, and
 * `triage-document.test.ts` is what enforces it.
 *
 * **What made the raise defensible is the two-pair console, not a new
 * measurement.** Until 2026-09-12 one collator wrote ONE `triage.json` covering
 * the whole environment, so the document cap and the service cap bounded the
 * same object and 16 services would have meant a ~9 KB document against a 4 KB
 * wire. With `tri-1` and `tri-2` each collating only its own slice, 16 declared
 * services is two documents of 8 rows, and at the 621 bytes the most expensive
 * real row has ever cost that is ~5.0 KB each — inside 8 192 and roughly where
 * one collation sat before the split. (MEASURED 2026-09-12 across the 103
 * collations on disk that parse with rows, out of 109 files: 415 bytes a row
 * mean, 621 max. The figure here read "~570" until then, which was an estimate
 * quoted as though it were a measurement.)
 *
 * The observed maximum moved with that measurement, and the multiplier moves
 * with it: the largest collation this console has written is 1 863 bytes, so
 * this cap is 4.4x that — not the 5.6x it would be against §11's older 1 472,
 * which counted a different population. The cap is a wire limit, not a target.
 */
export const TRIAGE_DOCUMENT_MAX_BYTES = 8192;

/** Why a `triage.json` was refused, as a value rather than as prose. */
export type TriageDocumentRefusal = "too_large" | "not_json" | "not_an_object" | "schema";

/**
 * What is wrong at one place, in this module's vocabulary rather than in zod's.
 *
 * Three members, and the first two exist because zod conflates them (see the
 * module docblock). They are also the three different things an operator does
 * next: add a field the worker never wrote, correct a value the worker wrote
 * wrongly, or delete a field this contract does not have.
 *
 * Closed and exported so a test can assert the members by name — §12's rule for
 * closed sets in this repository — rather than matching substrings of a sentence
 * that will be rewritten.
 */
export const TRIAGE_DOCUMENT_FAULTS = ["missing", "invalid", "unrecognized"] as const;
export type TriageDocumentFault = (typeof TRIAGE_DOCUMENT_FAULTS)[number];

/**
 * One defect, at one place, classified by fault rather than by zod's issue code.
 *
 * **The `fault` is here because neither the path NOR zod's code separates 5.5a's
 * first two acceptance cases.** A row missing `assessment` and a row carrying an
 * unknown assessment both land on `services.0.assessment` and both arrive from
 * zod as `invalid_value` with the same message. A test asserting either one would
 * pass against a schema that had collapsed the two — a fixture whose two arms
 * agree, which is this branch's most expensive recorded defect in its assertion
 * form.
 */
export interface TriageDocumentIssue {
  /** Dotted, `services.0.assessment`. `""` is the document itself. */
  readonly path: string;
  /** This module's classification. See {@link TRIAGE_DOCUMENT_FAULTS}. */
  readonly fault: TriageDocumentFault;
  readonly message: string;
}

/**
 * The two outcomes. There is no partial arm and there is no `missing` arm.
 *
 * **No partial**, on `DispatchRequestRead`'s rule: §6.4 refuses a document whole
 * on any violation, and a type with no way to express *"these two rows of three
 * were fine"* is how that stays true under maintenance rather than under
 * discipline. **No `missing`**, because an absent `triage.json` is not this
 * module's to interpret: §6.5 counts coverage from the run tree, so a sweep that
 * produced no document is a zero-row sweep the ACTOR names, not a parse result.
 */
export type TriageDocumentRead =
  | { kind: "ok"; document: TriageDocument }
  | {
      kind: "refused";
      code: TriageDocumentRefusal;
      reason: string;
      issues: readonly TriageDocumentIssue[];
    };

/**
 * What the HOST knows about a document, as opposed to what the document claims.
 *
 * `worker` is structural identity — the outbox directory the file sat in — and is
 * the direct copy of `DispatchRequestContext.sender`, for its stated reason.
 * `path` is named in every refusal so an operator is sent to a file rather than to
 * a sweep.
 */
export interface TriageDocumentContext {
  /** The seat whose outbox held the file. Never read from the document. */
  readonly worker: string;
  /** Where it was read from. Prose only — never re-derived from the document. */
  readonly path: string;
}

/**
 * Parse the bytes of a `triage.json` into a value `assessTriageSweep` may be
 * handed.
 *
 * Returns a REFUSAL rather than throwing, on `triage-partition.ts`'s split which
 * this whole console follows: a document a container wrote is untrusted input and
 * gets a value; a host argument that is wrong for the life of the run gets a
 * throw. The caller here is the actor, and a value is what a polling actor can
 * log, count and carry into the next sweep.
 *
 * The four checks are ORDERED and the order is what makes each refusal reachable
 * by exactly one fault: a document over the byte cap never reaches the parser,
 * bytes that are not JSON never reach the object check, and a value that is not
 * an object never reaches the schema, so no fixture has to be wrong in two ways
 * to exercise the fourth code.
 */
export function parseTriageDocument(
  text: string,
  ctx: TriageDocumentContext,
): TriageDocumentRead {
  /*
   * FIRST, and before `JSON.parse`, for the reason the ordering note above
   * gives. A document over the cap is a document that could not have crossed
   * the wire whole, so reporting it as `not_json` — which is what a truncated
   * one arrives as — would name the symptom and hide the cause. Measured in
   * BYTES rather than code units because the cap is about what a tool argument
   * carries, which is `collationCeiling`'s reason in `collation.ts` for the
   * same choice.
   */
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > TRIAGE_DOCUMENT_MAX_BYTES) {
    return {
      kind: "refused",
      code: "too_large",
      reason:
        `${ctx.path} is ${bytes} bytes and this document is bounded at ` +
        `${TRIAGE_DOCUMENT_MAX_BYTES}. Above roughly this size the model these seats run was ` +
        `measured delivering a SHORT report with no error and a green epoch, so a document ` +
        `this large is refused loudly rather than acted on partially.`,
      issues: [],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return {
      kind: "refused",
      code: "not_json",
      reason: `${ctx.path} is not JSON: ${(err as Error).message}`,
      issues: [],
    };
  }

  /*
   * Checked here rather than left to zod so the code is its own, and so that
   * `[]`, `null`, `"ok"` and `42` — four quite different things a worker can
   * write when a turn goes wrong — arrive under one name an actor can count.
   * `typeof null` is `"object"`, and an array is an object; both are spelled out
   * because both are shapes a truncated or half-written turn actually produces.
   */
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "refused",
      code: "not_an_object",
      reason:
        `${ctx.path} is ${describeShape(raw)} rather than a ${TRIAGE_DOCUMENT_SCHEMA} object. ` +
        `§7.5's document is a record of per-service rows; a bare array or scalar is a turn ` +
        `that produced something other than the document it was asked for.`,
      issues: [],
    };
  }

  const result = TriageDocumentSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.flatMap((issue): TriageDocumentIssue[] => {
      const segments = issue.path.map(String);
      if (issue.code === "unrecognized_keys") {
        // Unrolled so the refusal names the KEY rather than the object holding
        // it — `parseTriageConsoleConfig`'s treatment, for its reason: a
        // refusal reading `(root)` sends an operator to the wrong line.
        return (issue as unknown as { keys: string[] }).keys.map((key) => ({
          path: [...segments, key].join("."),
          fault: "unrecognized" as const,
          message: `unrecognized key — §7.5 fixes this document's fields and ${key} is not one`,
        }));
      }
      const fault = classifyFault(raw, issue.path);
      return [
        {
          path: segments.join("."),
          fault,
          /*
           * REWRITTEN when the key is absent. Zod's own sentence for a missing
           * enum is "Invalid option: expected one of …", which describes a
           * spelling mistake in a field that is not there — the misdiagnosis the
           * classification above exists to prevent, so leaving the message
           * alongside a corrected fault would put the two in disagreement.
           */
          message:
            fault === "missing"
              ? `required by §7.5 and absent from the document — the worker wrote no ` +
                `${segments.at(-1) ?? "value"} here`
              : issue.message,
        },
      ];
    });
    return {
      kind: "refused",
      code: "schema",
      reason:
        `${ctx.path} does not satisfy §7.5: ` +
        issues.map((i) => `${i.path === "" ? "(document)" : i.path}: ${i.message}`).join("; "),
      issues,
    };
  }

  /*
   * Built field by field rather than spread, so that `worker` comes from the
   * CONTEXT and `schema` — a validation tag, not a payload field — does not
   * travel on. The annotated return type is the compile-time claim that this
   * schema and §7.5's contract type cannot drift: change either and this
   * assignment stops compiling under `bun run typecheck`.
   */
  const document: TriageDocument = {
    worker: ctx.worker,
    sweep_id: result.data.sweep_id,
    services: result.data.services satisfies readonly TriageRow[],
    unaccounted: result.data.unaccounted,
  };
  return { kind: "ok", document };
}

/**
 * Absent, or present and wrong — the distinction zod does not draw for an enum.
 *
 * **Sound because of where this input came from, and only there.** The value was
 * produced by `JSON.parse`, and JSON cannot express `undefined`: so `undefined` at
 * a path means the key was never written and can mean nothing else, while `null`
 * — which JSON *can* express — is a key that is present and carries a value this
 * contract does not accept. Applying this to a value from any other source would
 * be unsound, which is why it is a private function of a module that parses bytes
 * rather than a general helper.
 *
 * A path that runs through a non-object partway — `services.0.assessment` where
 * `services` is a string — stops there and answers `invalid`, because the fault is
 * the container rather than the leaf.
 */
function classifyFault(raw: unknown, path: readonly PropertyKey[]): TriageDocumentFault {
  let cursor: unknown = raw;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return "invalid";
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor === undefined ? "missing" : "invalid";
}

/** What a non-object actually was, for a refusal an operator can act on. */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a JSON array";
  return `a JSON ${typeof value}`;
}
