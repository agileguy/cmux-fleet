/**
 * THE STRUCTURAL CENSUS — SRD-REVIEW-CONSOLE §6.8, D8.
 *
 * A review has nothing to re-execute. §6.8 walks the argument and reaches a
 * conclusion this module implements literally: grade a review on the
 * **structural completeness of its collation**, record the consensus counts as a
 * DATUM, and give the instrument its own name because it is not acceptance.
 *
 * ## THE ONE THING THIS MODULE MUST NOT BE MISREAD AS
 *
 * **It reads worker-authored JSON. It bounds the claim's shape; it does not
 * verify the claim.**
 *
 * `adjudicate.ts` describes the harvester's re-run acceptance as *"the one piece
 * of evidence in this function a fabricating worker cannot author"* — commands
 * resolved from the base SHA, re-run in a fresh clone, in a container the worker
 * never touched. Nothing here has any of that. `collation.json` is written by
 * the collator, into the collator's own outbox, describing findings the collator
 * chose to report about reviews the collator chose to summarise. A census of it
 * can prove that a document has the shape of a review; it cannot prove that a
 * review happened, and §6.8 says why no instrument in this class could:
 * *"There is no argv that proves a person's judgement was exercised."*
 *
 * So: no field, type or function in this module is named for acceptance, nothing
 * here writes to `facts.acceptance`, and no review task gets acceptance commands
 * attached to it. §6.8 calls that last one out by name — forcing an argv onto a
 * review would produce *"exactly the ceremony ISC-93 exists to catch — a command
 * that exits 0 and certifies nothing"*, and building it would be using the
 * fabrication guard to launder a fabrication. `CollationSchema` refuses the
 * words `acceptance` and `verified` outright, from the other side of the same
 * seam.
 *
 * ## WHERE THIS MODULE ENDS AND `src/run/collation.ts` BEGINS
 *
 * The document's CONTRACT is `src/run/collation.ts` and this module owns none of
 * it. That file holds the schema, the bounds, the refusal codes, the attribution
 * rules (`raised_by` non-empty, against the lens table, reported lenses only)
 * and §6.8's third rule as `collationCeiling`. Everything below CONSUMES it, and
 * the two things left over are the two that file explicitly delegated:
 *
 *  - **Location containment.** `findingPath` there bounds the string and refuses
 *    control characters, and stops: *"the containment judgement lives there and
 *    this field carries only what makes the string safe to hold"*. It stops
 *    because a schema does not know the run's `container_workdir` and this
 *    module does.
 *  - **The published counts.** `declared` beside `counted`, how many findings
 *    resolve, the agreement histogram, and the lens denominator — the record
 *    §6.8's second rule asks for.
 *
 * **Two rules deliberately NOT re-implemented here, because they exist there.**
 * Rule 3 (zero findings claimed `success`), and its `missing`/`refused`
 * siblings, are `collationCeiling`'s, guarded on `isCollationTaskId` so it cannot
 * be aimed at the fan-out task `T` — which legitimately has no collation. Rule 2
 * (attribution) is enforced by `CollationSchema`'s own `superRefine`, so a
 * document that violates it never reaches `ok` and never reaches a census. A
 * second copy of either here would be a second thing to keep correct, and the
 * second copy is always the one that lapses.
 *
 * ## WHERE "RESOLVES INSIDE /workspace" IS MEASURED, AND WHERE IT CANNOT BE
 *
 * §6.8 asks that each finding carry *"a file path and a line number that resolve
 * inside `/workspace` — the same class of check `readResultEnvelope` already
 * makes on `artifacts[]` paths"*. This module makes that check in the CONTAINER
 * namespace and not on the host, and the difference is forced rather than
 * chosen.
 *
 * `outbox.ts`'s `artifactPathProblem` translates a container path to a host path
 * through the mount table and then contains it. That translation needs
 * `loc.hostWorkdir`, which is the WORKTREE — and the collator is
 * `isolation: shared-ro` (§6.3), so no worktree is created, so `host_workdir` is
 * `"unset"`, so `hasWorktree` is false, so `hostWorkdir` is `null` and the mount
 * table the harvester can compute holds `/outbox` alone. The `/workspace` a
 * `shared-ro` worker reads is the operator's own checkout, bind-mounted `:ro` by
 * `render.ts` — real to the container and absent from the dispatch record the
 * harvester grades against.
 *
 * So the check is LEXICAL and its subject is the container path: does it resolve
 * under the container workdir without climbing out of it, is it shaped like a
 * name rather than a sentence, and is the line a positive integer? **It does not
 * open the file, does not stat it, and therefore does not establish that the
 * file exists or that the line is inside it.** That is a real limit and it is
 * stated here rather than left to be discovered from a green verdict — the same
 * stance `reconcile.ts` takes on "too large to check" versus "checked and clean".
 *
 * ## AND STATTING IS NOT THE MISSING HALF — IT IS A WORSE INSTRUMENT
 *
 * The obvious strengthening is to open the file, and it is refused twice over.
 *
 * **It is unavailable where it matters.** Everything above is the reason: the
 * collator is `shared-ro`, `host_workdir` is `"unset"`, `hostWorkdir` is `null`,
 * and the `/workspace` the reviewers actually read is a bind mount this process
 * has no path to. An existence check for the review console would be an
 * existence check that never runs, which is `harvest/index.ts`'s "tested
 * mechanism with no live call site" wearing the opposite disguise.
 *
 * **And where it IS available it measures the wrong thing.** A review's most
 * valuable finding is frequently about a file the change DELETED — the review
 * this console was built for removed 3742 lines — and every one of those
 * findings quotes a path that no longer exists in the tree. Statting would file
 * them as unlocated and cap the review at `partial` for being right. `located`
 * overstating how much of a review is anchored is a defect; `located`
 * understating it, on exactly the reviews that did the most work, is a worse
 * one. The rule below is chosen to move the first number without touching the
 * second.
 *
 * ## AND IT DEGRADES A FINDING RATHER THAN REFUSING A DOCUMENT
 *
 * That is the division `src/run/collation.ts` asks for in as many words, and it
 * is the reason the check is here rather than in the schema: a whole collation
 * thrown away because one row of fourteen quoted a path outside the checkout is
 * *"a legal-document refusal presenting as a policy"*. `located < counted` names
 * the rows and caps the verdict; the other thirteen findings stay in the record.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { CollationCensus, Verdict } from "../contracts.ts";
import {
  COLLATION_ARTIFACT_NAME,
  collationCeiling,
  lensCoverage,
  type Collation,
  type CollationRead,
} from "../run/collation.ts";
import { safeForReport } from "./outbox.ts";

export { COLLATION_ARTIFACT_NAME };

/**
 * The candidate's NAME INSIDE the container workdir, or `null` when it has none
 * — `outbox.ts`'s `resolvedWithin`, restated rather than imported because its
 * subject here is a CONTAINER path and its argument is the same one.
 *
 * `relative`, not `startsWith`: a prefix test accepts `/workspacex/a.ts` because
 * the strings share eleven characters, and accepts `/workspace/../etc/passwd`
 * because it does too. The first-segment comparison rather than
 * `rel.startsWith("..")` is `resolvedWithin`'s own note — a directory honestly
 * named `..cache` yields `rel === "..cache"`, which a `startsWith` check would
 * refuse.
 *
 * **It returns the relative name rather than a boolean because the caller has a
 * SECOND question to ask of it**, and `rel` is the only spelling that question
 * can be asked in. `src/a.ts` and `/workspace/src/a.ts` are two spellings of one
 * file — `src/run/collation.ts` decided the document accepts both — and they
 * produce the same `rel`. Any judgement made on the RAW string would answer
 * differently for the two, which is how a rule acquires a spelling that launders
 * whatever it refuses. See `looksLikePhrase`.
 */
function workdirRelative(containerWorkdir: string, candidate: string): string | null {
  const root = resolve(containerWorkdir);
  const target = resolve(isAbsolute(candidate) ? candidate : join(root, candidate));
  const rel = relative(root, target);
  if (rel === "") return null; // the workdir itself is not a file to quote
  if (isAbsolute(rel)) return null;
  return rel.split(sep)[0] === ".." ? null : rel;
}

/**
 * Is this name inside the workdir a SENTENCE rather than a path?
 *
 * ## The hole it closes
 *
 * `findingLocationProblem`'s docblock used to confess this defect against
 * itself and stop there: `join("/workspace", x)` maps every string without a
 * leading `..` to somewhere inside the workdir, so the prose finding
 * `"the error handling could be tightened"` resolved to
 * `/workspace/the error handling could be tightened`, counted as located, and
 * `located` therefore overstated how much of a review was anchored to real code.
 * Containment cannot close it — the string really does resolve inside — so the
 * shape of the name has to.
 *
 * ## The rule, and why all three conjuncts
 *
 * A name is a phrase when it carries **whitespace**, contains **no directory
 * separator**, and its final component carries **no file extension**. All three,
 * because the cost of the two errors is not symmetric. A miss leaves `located`
 * overstated, which is the defect being closed; a FALSE POSITIVE marks a real
 * file unlocated and caps an honest review at `partial`, which is the
 * understatement the module header refuses to trade for. So this fires only when
 * every available signal says "sentence", and each conjunct is the one that
 * rescues a real path the others would condemn:
 *
 *  - whitespace rescues `Makefile`, `LICENSE`, and every other extensionless
 *    single-segment file at the root of a checkout;
 *  - the separator rescues `docs/design notes` — a directory named it, which no
 *    sentence does;
 *  - the extension rescues `design notes.md`, a single-segment file whose name
 *    has a space in it.
 *
 * ## IT IS ASKED OF `rel`, WHICH IS WHAT MAKES IT UNSPELLABLE-AROUND
 *
 * Asked of the raw `file`, the rule would have a bypass and the bypass would be
 * the remedy printed in its own refusal message:
 * `/workspace/the error handling could be tightened` carries separators, so it
 * would pass while the bare sentence failed. Asked of `rel`, both spellings of
 * one name get one answer, which is the property the contract's decision to
 * accept both spellings promised and this defect broke.
 *
 * ## WHAT SURVIVES, NAMED RATHER THAN COUNTED
 *
 * No lexical rule separates a ONE-WORD prose finding (`"unclear"`) from an
 * extensionless file at the root (`Makefile`); they are the same string shape,
 * and refusing the second to catch the first is the trade above, made the wrong
 * way. A sentence that QUOTES a path (`"we should refactor src/a.ts"`) carries
 * both a separator and an extension and survives for the same reason. This rule
 * catches a finding that points at nothing; it does not catch every finding
 * written badly, and `statement` remains where prose belongs.
 */
function looksLikePhrase(rel: string): boolean {
  if (!/\s/.test(rel)) return false;
  if (rel.includes(sep)) return false;
  return !/\.[^.\s]+$/.test(rel);
}

/**
 * Why one finding's location is not usable, or `null` when it is.
 *
 * ## BOTH SPELLINGS RESOLVE, AND CONTAINMENT ALONE COULD NOT TELL A PATH FROM A
 * ## SENTENCE
 *
 * `/workspace/src/a.ts` and `src/a.ts` both resolve, because
 * `src/run/collation.ts` decided the document accepts both and made the
 * argument: refusing a whole collation over a spelling is *"a legal-document
 * refusal presenting as a policy"*. That decision had a price HERE, and this
 * docblock recorded it against itself for a while before it was paid:
 * **`join("/workspace", x)` maps every string without a leading `..` to
 * somewhere inside the workdir**, so the prose finding
 * `"the error handling could be tightened"` resolved to
 * `/workspace/the error handling could be tightened` and counted as located —
 * `located` claiming an anchor for a finding that points at nothing.
 *
 * **`looksLikePhrase` is the answer**, and it is a SHAPE rule on the name inside
 * the workdir rather than an existence check on the file: the module header
 * argues at length why statting is both unavailable to a `shared-ro` collator
 * and, where available, a worse instrument that would file a review's findings
 * about DELETED files as unlocated. The rule's own conjuncts, the paths each one
 * rescues, and what still gets through are argued where it is defined.
 *
 * Two things stand behind it, unchanged. `statement` is where prose belongs, and
 * `line` must be a whole number and, at this check, a positive one — `line: 0`
 * and `line: -3` are the other shapes a model emits when it has nothing to point
 * at, and they are refused here rather than in the schema for the same
 * degrade-don't-refuse reason.
 *
 * Control characters and backslashes are checked again here even though
 * `findingPath` refuses the first document-wide: this function is exported and
 * `censusCollation` is not its only possible caller, and every one of these
 * strings is rendered into a report an operator reads, where a CR and an ANSI
 * introducer let a worker forge lines in the document that is judging it.
 */
export function findingLocationProblem(
  file: string,
  line: number,
  containerWorkdir: string,
): string | null {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  const control = /[\x00-\x1f\x7f]/.exec(file);
  if (control !== null) {
    const code = control[0]!.charCodeAt(0).toString(16).padStart(2, "0");
    // The path is NOT echoed: printing it is the injection this refuses.
    return `finding path contains a control character (0x${code}) at index ${control.index}`;
  }
  const bs = file.indexOf("\\");
  if (bs !== -1) return `finding path contains a backslash (0x5c) at index ${bs}`;
  if (file === "") return "finding carries an empty file path";
  const rel = workdirRelative(containerWorkdir, file);
  if (rel === null) {
    return (
      `finding path ${safeForReport(file)} does not resolve inside ${containerWorkdir}. ` +
      `A finding names a file in the tree that was reviewed, either as an absolute path under ` +
      `${containerWorkdir} or relative to it`
    );
  }
  if (looksLikePhrase(rel)) {
    return (
      `finding path ${safeForReport(file)} is a sentence, not a path: inside ${containerWorkdir} ` +
      `it names ${safeForReport(rel)}, which carries whitespace, no directory and no file ` +
      `extension. Prose belongs in this finding's \`statement\`; \`file\` is the path it points at`
    );
  }
  if (!Number.isInteger(line) || line < 1) {
    return `finding at ${safeForReport(file)} carries line ${line}; a quotable line is 1-based`;
  }
  return null;
}

/**
 * Count a collation that `readCollation` accepted, and record what is wrong with
 * the locations in it.
 *
 * Pure: takes a parsed document and a string, touches nothing. `reconcile.ts`
 * owns the descriptor the outbox scan validated and holds it, and re-opening a
 * worker-owned name to "check the file" is the re-resolution that whole
 * discipline exists to avoid.
 */
export function censusCollation(
  collation: Collation,
  containerWorkdir: string,
): CollationCensus {
  const coverage = lensCoverage(collation);
  const defects: string[] = [];
  let located = 0;
  /** raised_by size → how many findings had that many. §6.8's second rule. */
  const bands = new Map<number, number>();

  for (const [i, f] of collation.findings.entries()) {
    const problem = findingLocationProblem(f.file, f.line, containerWorkdir);
    if (problem === null) located += 1;
    else defects.push(`finding ${i + 1}: ${problem}`);
    /**
     * The band is the array's length and needs no roster filter, which is the
     * whole dividend of consuming `CollationSchema`: its `superRefine` has
     * already refused a `raised_by` that is empty, that repeats a worker, that
     * names a non-lens, or that credits a lens which never reported. Every one
     * of those was a way to manufacture a `3/3` out of fewer than three readers,
     * and none of them can reach this loop.
     */
    const n = f.raised_by.length;
    bands.set(n, (bands.get(n) ?? 0) + 1);
  }

  return {
    readable: true,
    refusal: null,
    declared: collation.finding_count,
    counted: collation.findings.length,
    located,
    lenses_total: coverage.total,
    lenses_reported: coverage.reported,
    lenses_missing: [...coverage.missing],
    agreement: [...bands.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([reviewers, findings]) => ({ reviewers, findings })),
    defects,
  };
}

/**
 * The census of a document that was present and could not be read as a
 * collation — the `refused` arm of `CollationRead`, recorded rather than dropped.
 *
 * A census with `readable: false` and an absent census are different states and
 * both are reachable: a task with no `collation.json` carries `null`, and a task
 * whose artifact is truncated, hostile, or filed against the wrong parent
 * carries this. Folding them together would make "nobody wrote one" and
 * "somebody wrote something unreadable" one answer, which is the shape of
 * silence §6.4 spends its header on.
 *
 * It does NOT clamp from here. `collationCeiling`'s `refused` arm already caps a
 * claimed `success` on exactly this state, guarded on the task id so it cannot
 * be aimed at a task that has no collation to write.
 */
export function censusRefused(code: string, reason: string): CollationCensus {
  return {
    readable: false,
    refusal: code,
    declared: null,
    counted: 0,
    located: 0,
    lenses_total: 0,
    lenses_reported: 0,
    lenses_missing: [],
    agreement: [],
    defects: [`${COLLATION_ARTIFACT_NAME} was refused (${code}): ${safeForReport(reason, 512)}`],
  };
}

/** Build a census from whatever `readCollation` returned. `null` for `missing`. */
export function censusFromRead(
  read: CollationRead,
  containerWorkdir: string,
): CollationCensus | null {
  switch (read.kind) {
    case "missing":
      return null;
    case "refused":
      return censusRefused(read.code, read.reason);
    case "ok":
      return censusCollation(read.collation, containerWorkdir);
  }
}

/**
 * §6.8's THIRD RULE, GATED ON ISC-94 — the wrapper `harvestTask` calls instead
 * of reaching `collationCeiling` directly.
 *
 * ## Why this exists rather than a `??` at the call site
 *
 * The call site used to spell it `collationCeiling(taskId, claimed?.status ??
 * "unknown", read)`, and that expression is load-bearing in a way nothing could
 * test: it is the only thing stopping a MISSING collation from clamping a task
 * with NO RESULT ENVELOPE. **Measured**: a `-collate` task with a worktree, one
 * passing harvester-run acceptance command and no envelope grades `success`
 * unmutated and `partial` with the guard removed — a document the worker never
 * wrote pulling down *"the one piece of evidence in this function a fabricating
 * worker cannot author"*.
 *
 * ISC-94 is explicit that a missing envelope is a NO-OP AND NEVER A DOWNGRADE,
 * and `adjudicate` honours it by making `unknown` the lattice identity. A rule
 * whose antecedent is "the task claims success" has no antecedent at all when
 * there is no claim, so it must decline — not decline *by arithmetic*, which is
 * what the `??` was doing, but by saying so.
 *
 * It does not bite in the SHIPPED config, and that is not a defence. The
 * collator is `shared-ro`, so no worktree, so the acceptance exam never runs, so
 * the verdict never exceeds the claim — a property of `fleet.yaml`, which is
 * mutable, reached by a guard nobody can see. `isCollationTaskId` also matches
 * any operator task named `*-collate`, which is a second door into the same
 * room.
 */
export function collationCeilingFor(
  taskId: string,
  claimed: { status: string } | null,
  read: CollationRead,
): { status: Verdict; reason: string } | null {
  /**
   * NO CLAIM, NO CEILING. The whole of ISC-94, in the one place it can be read
   * and tested. Returning `null` rather than a `{status, reason: null}` shape so
   * a caller cannot accidentally act on it.
   */
  if (claimed === null) return null;
  const ceiling = collationCeiling(taskId, claimed.status as Verdict, read);
  // NARROWED at the boundary: `CollationCeiling.reason` is nullable because that
  // type also spells "no opinion", and this wrapper has already turned that into
  // `null`. Returning the wide type would make every caller re-check a field
  // this one has decided.
  return ceiling.reason === null ? null : { status: ceiling.status, reason: ceiling.reason };
}

/** What the census allows, and why — `null` when it has no opinion. */
export interface CensusCeiling {
  /** `partial`, and only ever `partial`: a census cannot certify. */
  ceiling: "partial";
  reason: string;
}

/**
 * §6.8's FIRST RULE, and only that one — the location half of the instrument.
 *
 * ## What it does and what it deliberately leaves alone
 *
 * §10's probe: *"A collation whose findings carry no resolvable `file:line` is
 * not `success`."* This is that, and it is the one §6.8 rule `src/run/collation.ts`
 * hands over rather than enforcing, because a schema does not know the run's
 * `container_workdir` and cannot resolve a path against it.
 *
 * The other rules are NOT here and must not be added:
 *  - rule 3 (zero findings claimed `success`), with its `missing` and `refused`
 *    siblings, is `collationCeiling`, which is guarded on `isCollationTaskId` so
 *    it cannot be aimed at the fan-out task `T`;
 *  - rule 2 (attribution) is `CollationSchema`'s `superRefine`, so a document
 *    that breaks it is `refused` and never censused at all.
 *
 * ## A CEILING, and `partial` is its whole range
 *
 * A maximum rather than an assignment, for `capFor`'s reason one module over: it
 * can only lower what adjudication reached, so it can never rescue a `failed`,
 * never overrule the supervisor's terminal verdicts, and — since `success` is
 * not in its range at all — never certify anything. `rank("unknown")` is -1, so
 * a harvest that already refused to grade is left exactly as it was.
 *
 * ## WHY IT ASKS ABOUT THE CLAIM
 *
 * The conjunct looks redundant — a ceiling of `partial` only changes a verdict
 * that reached `success`, and a worker claiming less has already downgraded
 * itself. It is load-bearing in one reachable case and that case is the one
 * worth protecting: **`claimed === null` with real derived evidence.** A task
 * whose worker wrote no envelope is graded on the harvester's own re-run
 * acceptance (ISC-94 makes the missing claim a no-op, not a downgrade), and that
 * is the one form of evidence in this pipeline a fabricating worker cannot
 * author. A census — counts read out of a file the worker wrote — must not pull
 * that down. `collationCeiling` takes the claim as its antecedent for the
 * identical reason and says so at greater length.
 *
 * ## AND WHY A `declared` / `counted` DISAGREEMENT IS NOT A DEFECT
 *
 * `finding_count` is required by `CollationSchema` and deliberately not
 * cross-checked there: *"this number exists so the census can put `declared`
 * beside `counted` and let a disagreement be read"*. Capping on the disagreement
 * would make the datum cost something to record, which is how a field like that
 * comes to be quietly omitted. Both numbers are published; a reader who cares
 * that a collator declared four and listed two can see it, and no rule in §6.8
 * asks for more than that.
 */
export function censusCeiling(
  census: CollationCensus | null,
  claimedStatus: string | undefined,
): CensusCeiling | null {
  if (census === null || !census.readable) return null;
  if (claimedStatus !== "success") return null;
  if (census.counted === 0 || census.located === census.counted) return null;
  return {
    ceiling: "partial",
    reason:
      `${census.counted - census.located} of ${census.counted} findings in the collation carry ` +
      `no resolvable file:line, so the record cannot say where they are: ${census.defects[0]}` +
      (census.defects.length > 1 ? ` (and ${census.defects.length - 1} more)` : "") +
      `. Capped at partial — this is a STRUCTURAL census of worker-authored JSON, it bounds the ` +
      `shape of a claim and verifies none of it (SRD-REVIEW-CONSOLE §6.8, D8)`,
  };
}
