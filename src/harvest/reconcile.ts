/**
 * A1's artifact CLAIMS, reconciled against what the outbox physically holds
 * (SRD §7.2, §8.4, §12.5).
 *
 * The result envelope says which artifacts the worker produced. The outbox
 * scan says which files actually survived validation. Until now nothing
 * compared the two, so `"artifacts": [{"kind":"file","path":"/outbox/T-1/
 * files/report.md"}]` was accepted as testimony about a file the harvester
 * never looked for, and a file sitting in the outbox that the envelope never
 * mentioned was invisible. Both directions are findings, and both land in
 * `discrepancies` — the channel §8.4 already publishes.
 *
 * ## THE ONE RULE THIS MODULE EXISTS TO OBEY
 *
 * §12.5 names `{"kind":"file","path":"/Users/dan/.env"}` as an exfiltration
 * primitive: a path the harvester dereferences, writes into `report.md`, and
 * from there into the orchestrator's context. So a claimed path is NEVER
 * opened, stat'd, `realpath`ed, or otherwise turned into a syscall argument
 * here. It is translated through the mount table, compared AS A STRING against
 * the host paths the scan already accepted, and then either matched to an
 * entry that has already passed `lstat`/`realpath`/`nlink`/`O_NOFOLLOW`, or
 * reported. Content is read ONLY through the descriptor that scan is holding.
 *
 * That inverts the naive shape. The obvious implementation reads the claim and
 * goes looking for it; this one reads the accepted set and asks whether each
 * claim points into it. A claim naming `/etc/passwd` therefore cannot cause a
 * read no matter what the rest of this file does, because there is no code
 * path from a claimed string to an `open`.
 *
 * ## Why a module of its own rather than more of `outbox.ts`
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * `outbox.ts` is the module that decides what is TRUSTWORTHY — it reads
 * untrusted bytes off the disk and refuses. This is a module that COMPARES two
 * already-validated sources and reports where they disagree; it takes no
 * untrusted input that has not already been through the other module's
 * refusals. Keeping the adjudication out of the validator keeps the validator
 * readable as a single argument about containment.
 *
 * ## And why the SCHEMA check lives here too (ISC-332)
 *
 * `TicketOpsArtifactSchema` had the same defect this module was written to
 * cure, one layer along: a contract with no caller. The harvester MEASURED
 * every outbox artifact — real `bytes`, real `sha256`, published — and parsed
 * none of them, so a `ticketing` worker that wrote a document claiming
 * `match: "exact"` beside two differing values produced a green harvest and a
 * `success` verdict, with the malformation waiting for whoever opened the file
 * later.
 *
 * The check belongs at this call site and nowhere else, because this is the
 * only place in the harvest that holds artifact BYTES. `outbox.ts` refuses
 * files without reading them; `adjudicate.ts` is handed derived facts and a
 * claim and never sees a descriptor. Validation needs the content, the content
 * exists only inside this function's read, and it is read here exactly the way
 * the digest reads it — through the descriptor the scan is holding, under the
 * same two byte caps, with no filesystem API imported and no claimed path ever
 * turned into a syscall argument. The rule at the top of this file is not
 * relaxed for it.
 *
 * The second reason is about the evidence. ISC-246's registered claim greps
 * `src/` for the accepted list's field name and EXCLUDES `outbox.ts`, because
 * the field's own definition and pushes obviously mention it. Putting the first
 * consumer inside `outbox.ts` would put it inside that exclusion, so the claim
 * would keep reporting "no production consumer" while one sat three hundred
 * lines above it — the criterion's own evidence quietly falsified by where the
 * code was filed. Here the claim goes red, which is the honest signal that the
 * consumer arrived.
 */

import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { ZodError } from "zod";
import {
  parseTicketOpsArtifact,
  type CollationCensus,
  type ResultEnvelope,
  type Verdict,
} from "../contracts.ts";
import {
  COLLATION_ARTIFACT_NAME,
  readCollation,
  type CollationRead,
} from "../run/collation.ts";
import { censusFromRead } from "./collation-census.ts";
import {
  OUTBOX_FILES_DIR,
  artifactClaimToHost,
  resolvedWithin,
  safeForReport,
  type OutboxFile,
  type OutboxFileScan,
  type OutboxLocation,
} from "./outbox.ts";

/**
 * One entry of the envelope's `artifacts` array.
 *
 * Derived from `ResultEnvelope` rather than re-exported from `contracts.ts`,
 * so the reconciler's input type cannot drift from the field it reconciles: if
 * `ArtifactRefSchema` grows a member, this follows without an edit.
 */
export type ArtifactClaim = ResultEnvelope["artifacts"][number];

/**
 * Bytes digested from any ONE artifact before it is refused by name.
 *
 * Twice `MAX_ENVELOPE_BYTES`, on the reasoning that an artifact is allowed to
 * be a build log where an envelope is not, and still far below anything that
 * costs real time: MEASURED on this machine, read-plus-sha256 through a
 * descriptor runs at 1669 MiB/s (64 MiB in 38.3 ms, 64 KiB buffer), so 8 MiB
 * is about 5 ms.
 *
 * Exceeding it is a NAMED discrepancy and the artifact is left out of the
 * inventory ENTIRELY rather than digested up to the cap. A sha256 over the
 * first 8 MiB, published in a field called `sha256`, is not a partial answer —
 * it is a wrong one, and it would compare unequal to the same file's real
 * digest computed anywhere else.
 */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/**
 * Bytes digested across the WHOLE task before reconciliation stops.
 *
 * §12.5 asks for harvested bytes to be capped "per task and per run", and the
 * per-artifact cap alone does not do it: `MAX_HELD_DESCRIPTORS` is 128, so 128
 * artifacts each just under 8 MiB is 1 GiB of reads for one task, and
 * `harvestAll` loops over every task in the run. 64 MiB is 38 ms of hashing
 * measured above — eight full-size artifacts, or all 128 held descriptors
 * averaging 512 KiB each, which is far more than any legitimate outbox — and
 * it holds a sixteen-worker run's total reconciliation cost near half a second
 * instead of near a minute.
 *
 * Resident memory is NOT what this bounds. The read streams through a fixed
 * 64 KiB buffer, so a 40 GB artifact would never be materialized; the cap
 * bounds TIME and I/O, which is the resource a hostile worker can actually
 * spend on the harvester's behalf.
 */
export const MAX_RECONCILED_BYTES = 64 * 1024 * 1024;

/** Read buffer. Fixed, so artifact size never becomes an allocation. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The artifact filename that opts a document IN to schema validation.
 *
 * ## Why a filename and NOT `worker.role === "ticketing"`
 *
 * Three reasons, in ascending order of how much they matter.
 *
 * The shallow one: the role name is not in scope here and should not be. This
 * function is handed a scan, a claim list and a location — it grades an
 * OUTBOX, and adding the dispatching role to its inputs would let a future
 * edit key any other behaviour off the role too.
 *
 * The real one: a role name is an operator's label in `fleet.yaml`, changed by
 * editing a string. `role: ticketing` renamed to `role: jira` — or a second
 * role that also runs the `ticket-ops` skill — would go SILENTLY unvalidated,
 * and silence is the failure mode this whole module is written against. The
 * path, by contrast, is fixed by the SKILL rather than by the role:
 * `skills/ticket-ops/SKILL.md` instructs the worker to write
 * `/outbox/<task-id>/files/ticket-ops.json`, so every role that adopts the
 * skill inherits the name, and a role that renames itself keeps it.
 *
 * The one that decides it: the name SELECTS, and the document's own declared
 * kind CONFIRMS. `TicketOpsArtifactSchema` opens with
 * `schema: z.literal("pifleet.ticket-ops/v1")`, so a file at this name that
 * does not declare itself a ticket-ops document is not quietly skipped — it is
 * a schema violation, reported like any other. Selecting on the DECLARED kind
 * alone would have inverted that: a worker whose document lost its `schema`
 * field would have escaped validation by exactly the malformation the
 * criterion is about. Selecting on the name and validating the declaration
 * closes both doors, and neither of them is a role name.
 */
export const TICKET_OPS_ARTIFACT_NAME = "ticket-ops.json";

/**
 * The HUMAN half of the same document — the one that opts nothing in.
 *
 * `skills/ticket-ops/SKILL.md` instructs a worker to write
 * `/outbox/<task-id>/files/ticket-ops.json` AND `ticket-ops.md`, "the same
 * content, once for a machine and once for a person". A worker that writes
 * only the `.md` therefore satisfies a reader and bypasses BOTH checks keyed
 * on the name above: the schema validation and the credential sweep. Neither
 * reports a failure, because neither runs.
 *
 * That is the defect this constant exists to make visible, and it is worse
 * than an unvalidated document. The sweep is what looks for the credential the
 * worker was holding while it talked to the ticket system; a document that
 * escapes it has been neither checked nor cleared, and the harvest's silence
 * about it is indistinguishable from a clean result.
 *
 * DERIVED from the JSON name rather than spelled out, so the pair cannot
 * drift. If the validated artifact is ever renamed, the document that must
 * accompany it is renamed in the same edit, and a reader looking for the
 * relationship finds it stated instead of having to notice that two string
 * literals share a stem.
 */
export const TICKET_OPS_DOCUMENT_NAME = `${basename(TICKET_OPS_ARTIFACT_NAME, ".json")}.md`;

/**
 * The verdict a failed ticket-ops validation clamps the task to.
 *
 * `failed` and not `partial`, taken from the role's own table: the `ticket-ops`
 * skill grades a write it could not read back as `failed` — "you do not know
 * the state" — and an artifact that will not parse is that same condition one
 * level up. The artifact IS the role's entire output; when it cannot be read,
 * nothing is known about what the worker did to a system of record other
 * people share, and `partial` would assert more than the harvest can support.
 */
const TICKET_OPS_FAILURE_CEILING: Verdict = "failed";

/** Schema issues named in one finding before it is truncated. */
const MAX_REPORTED_ISSUES = 6;

/** One accepted artifact, with the content facts read off its held inode. */
export interface ReconciledArtifact {
  /**
   * Host path the scan accepted it at, ESCAPED for display — the same
   * treatment, and the same spelling, that refused entries already get.
   *
   * A filename is worker-controlled, and this string is published: it reaches
   * `derived.artifacts` in the harvest and from there an operator's terminal.
   * An artifact named with a newline and an ANSI sequence would otherwise
   * forge lines in the report that is judging it (§12.6) — the same attack
   * `safeForReport` exists for on the refusal path, arriving through the
   * ACCEPTED path instead, where nothing had previously needed to render a
   * name.
   *
   * Escaping it costs nothing precisely because it is not the way to reach the
   * content. The bytes below came from the descriptor; this is a label.
   */
  path: string;
  bytes: number;
  /** sha256 over the whole file, computed from the descriptor. */
  sha256: string;
}

export interface ArtifactReconciliation {
  /** Findings, already safe to print — every worker-controlled span escaped. */
  discrepancies: string[];
  /**
   * What the outbox actually holds, digested.
   *
   * Ordered by path so two harvests of the same outbox produce the same list.
   * Artifacts refused by either byte cap are ABSENT rather than present with a
   * partial digest — see `MAX_ARTIFACT_BYTES`.
   */
  artifacts: ReconciledArtifact[];
  /**
   * The best verdict the outbox's own contents allow, or `null` for no opinion.
   *
   * A SEPARATE channel from `discrepancies` on purpose. Every other finding
   * this module produces is a statement about the ENVELOPE — over-claiming,
   * under-claiming, a path outside the mount table — and the adjudicator
   * already owns how those weigh, so publishing them is the whole job. A
   * malformed ticket-ops document is different: it is a fact about the
   * artifact's CONTENT, which is the one thing the adjudicator cannot see (it
   * is handed derived facts and a claim, never a descriptor). If this module
   * reported the malformation and stopped, the task would come back `success`
   * with a finding printed underneath it, which is the "surprise at read time"
   * the criterion exists to remove.
   *
   * A ceiling rather than a verdict, so it can only ever LOWER what
   * adjudication reached. It cannot rescue a `failed` into something better
   * and it cannot overrule the supervisor's terminal verdicts.
   */
  verdictCeiling: Verdict | null;
  /**
   * WHY the ceiling landed, in the words the harvest's `reasons` should carry.
   * `null` exactly when `verdictCeiling` is.
   *
   * It travels WITH the ceiling rather than being reconstructed at the call
   * site, and that is a correctness fix rather than tidiness. `harvest/index.ts`
   * used to render one fixed sentence for any ceiling this module raised — "a
   * ticket-ops.json artifact in the outbox failed validation" — which was true
   * of the only cause that existed. It is FALSE of a document that was never
   * written: nothing failed validation, and telling an operator it did sends
   * them looking for a malformed file that is not there. A second cause with
   * one shared sentence is how a report starts lying about its own evidence,
   * and the cheapest place to stop that is here, where the cause is known.
   */
  verdictCeilingReason: string | null;
  /**
   * The STRUCTURAL CENSUS of a `collation.json` in this outbox, or `null` when
   * there was none (SRD-REVIEW-CONSOLE §6.8, D8).
   *
   * A MEASUREMENT AND NOT A CEILING, which is the difference from the ticket-ops
   * check beside it and the reason the two are not one mechanism. ISC-332's
   * clamp has to happen here because it is keyed on artifact CONTENT, which the
   * adjudicator structurally cannot see — it is handed derived facts and a claim,
   * never a descriptor. A census is small, structured and serialisable, so it
   * travels INTO the fact bundle and the adjudicator weighs it there like every
   * other fact. That buys the ISC-153 property this module cannot give a clamp:
   * the census is inside `facts_hash`, so a replay reaches the same verdict from
   * the same evidence.
   *
   * The rules that turn it into a verdict live elsewhere and in two places, each
   * because of what it can see: `censusCeiling` weighs the census as a FACT
   * inside `adjudicate`, and `collationCeiling` weighs the parsed DOCUMENT and
   * the task id inside `harvestTask`. This module counts; it does not grade.
   */
  collation: CollationCensus | null;
  /**
   * What `readCollation` said about the artifact, for `collationCeiling`.
   *
   * The census is the SERIALISABLE half and this is the half that is not: §6.8's
   * third rule and its `missing`/`refused` siblings are `src/run/collation.ts`'s,
   * and that function takes a `CollationRead` and a task id — neither of which
   * survives into a fact bundle. Passed through in-process rather than
   * reconstructed, because reconstructing a refusal from a census is a second
   * spelling of one judgement.
   *
   * `{kind: "missing"}` when the outbox held no artifact at that name, which is
   * every task in this fleet but a collation. `collationCeiling` is what makes
   * that harmless: it refuses to act on any task id that is not a collation's.
   */
  collationRead: CollationRead;
}

/** What reading one held descriptor produced. */
type DigestOutcome =
  | {
      kind: "ok";
      bytes: number;
      sha256: string;
      /**
       * The bytes, kept ONLY when the caller asked for them.
       *
       * `null` for every artifact that is not selected for validation, which
       * is the ordinary case — the digest streams through one fixed chunk and
       * the module's "resident memory is not what this bounds" property is
       * unchanged for it.
       */
      retained: Buffer | null;
    }
  | { kind: "too_large"; bytes: number }
  | { kind: "over_budget" }
  | { kind: "unreadable"; code: string };

/**
 * Digest ONE artifact, reading only through the descriptor the scan is holding.
 *
 * `cap` is the smaller of what this artifact is allowed and what the task has
 * left, so one loop enforces both bounds and neither can be overshot by a file
 * that grows underneath the read.
 *
 * The size is taken from `handle.stat()` — the descriptor's own inode, not a
 * second `lstat` on a name — so an oversized artifact is refused before a
 * single byte is read, which is the shape `readResultEnvelope` uses for
 * ISC-122 and the same reason: refusing after buffering is not refusing.
 *
 * The read then RE-ENFORCES the bound rather than trusting the size, because
 * the stat is advisory: the file can grow between the two. Reading `cap + 1`
 * bytes is how the overrun becomes observable — seeing that byte proves the
 * artifact outgrew its allowance, and the buffer never grows past one chunk
 * either way.
 *
 * Every read passes an EXPLICIT position rather than relying on the
 * descriptor's file offset. The descriptor is owned by the scan, not by this
 * function, and a second reader of the same handle would otherwise move the
 * offset out from under this one; positional reads make the digest independent
 * of who else has touched the handle and of how many times this runs.
 */
async function digestHeldArtifact(
  f: OutboxFile,
  cap: number,
  retain: boolean,
): Promise<DigestOutcome> {
  let size: number;
  try {
    size = (await f.handle.stat()).size;
  } catch (e) {
    return { kind: "unreadable", code: errnoOf(e) };
  }
  if (size > MAX_ARTIFACT_BYTES) return { kind: "too_large", bytes: size };
  if (size > cap) return { kind: "over_budget" };

  const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const hash = createHash("sha256");
  /**
   * The retained chunks, when the caller asked for them.
   *
   * Bounded by `cap`, which is the SMALLER of the per-artifact and remaining
   * per-task allowances — so this shares the existing budget rather than
   * opening a second one, and an artifact too large to digest is by
   * construction too large to retain. It is also filled from the same single
   * read pass: a second read to fetch the text for parsing would be a second
   * chance for the file to have changed underneath, and the digest published
   * beside the verdict must describe the bytes that were actually parsed.
   */
  const kept: Buffer[] | null = retain ? [] : null;
  let total = 0;
  try {
    for (;;) {
      const want = Math.min(READ_CHUNK_BYTES, cap + 1 - total);
      if (want <= 0) break;
      const { bytesRead } = await f.handle.read(buf, 0, want, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      // The overrun is decided BEFORE the chunk is folded in: a digest that
      // included bytes past the cap would be neither the whole file's nor the
      // capped prefix's.
      if (total > cap) {
        return total > MAX_ARTIFACT_BYTES ? { kind: "too_large", bytes: total } : { kind: "over_budget" };
      }
      hash.update(buf.subarray(0, bytesRead));
      // Copied, not aliased: `buf` is reused by the next iteration.
      if (kept !== null) kept.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
  } catch (e) {
    return { kind: "unreadable", code: errnoOf(e) };
  }
  return {
    kind: "ok",
    bytes: total,
    sha256: hash.digest("hex"),
    retained: kept === null ? null : Buffer.concat(kept),
  };
}

/**
 * Why a ticket-ops document was refused, rendered for a report.
 *
 * Zod's own `message` on a `ZodError` is a pretty-printed JSON dump of every
 * issue — multi-line, unbounded, and the wrong thing to splice into a findings
 * list. The issues are rendered compactly instead, capped in number, and the
 * whole string goes through `safeForReport` at the call site.
 *
 * THE ESCAPING IS NOT DECORATION. Several messages here quote a value the
 * WORKER wrote: zod's enum failure says `received '<the worker's string>'`,
 * and the schema's own hygiene rules interpolate a field path built from
 * worker-authored keys. That is the §12.6 report-forging surface arriving
 * through a new door — a document whose `operation` field is
 * `"query\n  verdict: success"` would otherwise write a line into the report
 * that is judging it.
 */
function describeSchemaFailure(e: unknown): string {
  if (e instanceof ZodError) {
    const shown = e.issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map((i) => `${i.path.length === 0 ? "<root>" : i.path.join(".")}: ${i.message}`)
      .join("; ");
    const more = e.issues.length - MAX_REPORTED_ISSUES;
    return more > 0 ? `${shown} (and ${more} more)` : shown;
  }
  // `parseTicketOpsArtifact` throws a plain Error for a credential hit, and it
  // names PATHS only — never the value it matched, which is the secret.
  return e instanceof Error ? e.message : String(e);
}

/**
 * Validate one ticket-ops document, returning a finding or `null`.
 *
 * `parseTicketOpsArtifact` rather than `TicketOpsArtifactSchema.parse`, and
 * that is the point of the exercise: the one entry point pairs the schema with
 * the credential sweep, and the failure mode of calling only the schema is a
 * live token published into a harvested artifact and digested into the report.
 *
 * A THROW IS CAUGHT AND BECOMES A FINDING. The harvest is the fleet's account
 * of what happened, and a worker that wrote garbage still has a transcript, a
 * diff and an outbox worth recording. Letting the parse escape would abort
 * `harvestTask` for that task, and `harvestAll` would swallow it into a single
 * unavailable row — replacing a precise report about a bad artifact with no
 * report at all, which is strictly less than the operator had before.
 */
function validateTicketOps(body: Buffer, secrets: readonly string[]): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch (e) {
    // The parser's message can quote the offending span of the document.
    return `is not parseable JSON (${describeSchemaFailure(e)})`;
  }
  try {
    parseTicketOpsArtifact(raw, secrets);
    return null;
  } catch (e) {
    return `fails ${TICKET_OPS_ARTIFACT_NAME} validation (${describeSchemaFailure(e)})`;
  }
}

/** The errno name, never the whole error: `String(err)` carries host paths. */
function errnoOf(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? "unknown";
}

/**
 * Compare the envelope's artifact claims against the outbox, and digest what
 * the outbox holds.
 *
 * ## `claimed === null` means "there is no envelope", and that is not silence
 *
 * A null claim list is a MISSING or REFUSED envelope, not an empty one, and
 * the two are graded differently on purpose. With no envelope there is nothing
 * for the outbox to disagree with: "this file was not claimed" would be true
 * of every artifact on disk, so a worker that died with forty artifacts
 * written — which ISC-94 is explicit is not a failure — would emit forty
 * discrepancies that all restate one fact the harvest has already recorded
 * once, precisely. So no claimed-but-absent findings (there are no claims) and
 * no present-but-unclaimed findings (there is no claim list to be absent
 * from).
 *
 * An EMPTY `artifacts` array is the opposite case and IS graded: the worker
 * wrote an envelope and said it produced nothing, so every file in the outbox
 * contradicts it. That asymmetry is the same one `harvest/index.ts` draws
 * around under-claiming `files_changed`, which SRD §880 calls a hard failure
 * class and this repo's adjudicator calls concealment.
 *
 * The inventory is built either way. Digests are facts about the outbox, not
 * about the claim, and the consumer that attaches artifact bytes needs them
 * whether or not a worker got as far as describing them.
 *
 * ## `kind` is a content hint; every kind is reconciled
 *
 * `ArtifactRefSchema` is `{kind, path}` with `kind` in `file | diff | log |
 * note`, and `readResultEnvelope` runs `artifactPathProblem` over EVERY
 * artifact's path regardless of kind — so all four kinds have already been
 * required to name a mount-table path under the outbox or worktree by the time
 * anything reaches here. Treating only `file` as an outbox reference would
 * therefore report a legitimately-claimed `{"kind":"log","path":"/outbox/T-1/
 * files/build.log"}` as an unclaimed file, inventing a discrepancy out of the
 * worker having labelled its artifact accurately. `kind` is carried into the
 * finding text instead, where an operator can weigh it.
 */
export interface ReconcileOptions {
  /**
   * Known secret VALUES, used as literal needles inside a ticket-ops document.
   *
   * The schema's own hygiene rules catch the two shapes a credential is
   * normally recorded IN — an unelided `Authorization` header and a
   * credential-bearing query parameter — and they need no needles, so they run
   * whatever this holds. This list is what catches the token pasted somewhere
   * a schema cannot anticipate.
   *
   * STILL AN ARGUMENT AND NOT A LOOKUP, now that a supplier exists (ISC-333).
   * `harvestTask` resolves the worker's granted values from the run directory
   * and hands them down; this module does not go and get them, because this
   * module imports no filesystem API at all and that absence is what makes its
   * §12.5 argument checkable rather than asserted. Empty by default, which is
   * what a caller with no run context gets and what the unit suite pins.
   */
  secrets?: readonly string[];
}

export async function reconcileArtifactClaims(
  scan: OutboxFileScan,
  claimed: readonly ArtifactClaim[] | null,
  loc: OutboxLocation,
  opts: ReconcileOptions = {},
): Promise<ArtifactReconciliation> {
  const discrepancies: string[] = [];
  const artifacts: ReconciledArtifact[] = [];
  const secrets = opts.secrets ?? [];
  let verdictCeiling: Verdict | null = null;
  let verdictCeilingReason: string | null = null;
  /**
   * FIRST IN PATH ORDER WINS, and a second `collation.json` anywhere in the tree
   * is recorded as a defect on the first rather than replacing it.
   *
   * The scan walks `files/` recursively, so two collations in two directories is
   * a reachable state. Letting the last one win would make the verdict depend on
   * `readdir` order — which `ordered` below exists to stop mattering — and
   * dropping the extras silently would let a collator publish a clean collation
   * beside the real one and choose which gets counted.
   */
  let collationRead: CollationRead = { kind: "missing" };
  /** Set once `collationRead` has been decided, so a second file cannot re-decide it. */
  let collationSeen = false;
  /**
   * Raise the ceiling and record its cause together, so neither can be set
   * without the other.
   *
   * The two fields are one fact and a `verdictCeiling = X` that forgot its
   * reason would publish a clamp the harvest cannot explain. Kept as a helper
   * rather than as a discipline: there are three call sites already.
   *
   * FIRST CAUSE WINS. All three raise the same `failed`, so the ceiling itself
   * is unaffected by the order; the reason is not, and the earliest one is the
   * one nearest the evidence. Every cause also pushes its own `discrepancies`
   * line, so nothing is lost by naming one in `reasons` — the full set is still
   * printed underneath.
   */
  const clampTo = (v: Verdict, why: string): void => {
    verdictCeiling = v;
    verdictCeilingReason ??= why;
  };

  // The only region a claim may name. Deliberately `files/` and not the task
  // outbox: `result.json` sits beside it and is the envelope, not an artifact,
  // and the worktree — which `artifactPathProblem` also permits, since a
  // worker may legitimately reference a file it edited — is a repository full
  // of things (`.env`, credentials a build wrote) that this module has no
  // business digesting into a report.
  const filesRoot = resolve(join(loc.workerOutboxDir, loc.taskId, OUTBOX_FILES_DIR));

  /**
   * The accepted set, keyed by resolved host path.
   *
   * `resolve` is LEXICAL — it normalizes `.` and `..` segments in a string and
   * touches no filesystem — which is what makes it usable on a claimed path.
   * `realpath` would be the dereference this module refuses to perform.
   */
  const accepted = new Map<string, OutboxFile>();
  for (const f of scan.safe) accepted.set(resolve(f.path), f);

  /** Accepted entries some claim pointed at, so the reverse pass can skip them. */
  const matched = new Set<string>();

  for (const ref of claimed ?? []) {
    // Rendered, never reproduced: the claim is worker-authored text on its way
    // into an operator's terminal (§12.6).
    const named = `${safeForReport(ref.path)} (kind ${ref.kind})`;
    /**
     * THE SAME RESOLUTION THE VALIDATOR USED, and it must stay the same one.
     *
     * These two passes disagreed once. `artifactPathProblem` learned that a
     * relative artifact path means "relative to the task outbox"; this line
     * still called `containerPathToHost`, which answers null for anything
     * non-absolute. So an ACCEPTED claim fell into the branch below and the
     * report said the file was outside the mount table — then the reverse pass,
     * finding it unmatched, said the outbox held a file the envelope never
     * mentioned. One artifact, two false statements, both about a file the
     * envelope had named correctly.
     */
    const host = artifactClaimToHost(ref.path, loc);
    if (host === null) {
      // An absolute path outside the mount table — the §12.5 primitive.
      // Nothing about this path has been or will be dereferenced.
      discrepancies.push(
        `envelope claims artifact ${named}, which is outside the container mount table; not read`,
      );
      continue;
    }
    const target = resolve(host);
    if (!resolvedWithin(filesRoot, target)) {
      // Inside the mount table but not an outbox artifact — a worktree path,
      // or the task outbox's own `result.json`. Legal in the envelope, and
      // still not something to open and hash.
      discrepancies.push(
        `envelope claims artifact ${named}, which is not under the task outbox files/ directory; not read`,
      );
      continue;
    }
    const held = accepted.get(target);
    if (held === undefined) {
      // Either nothing is there, or the scan refused it. Not distinguished
      // here on purpose: a refusal is ALREADY a discrepancy of its own, pushed
      // from the scan's refusal list a few lines earlier in `harvestTask`, and
      // cross-referencing would print the same file twice under two headings.
      discrepancies.push(
        `envelope claims artifact ${named}, which the outbox scan did not accept`,
      );
      continue;
    }
    matched.add(target);
  }

  /**
   * Path order, so the same outbox reconciles the same way twice.
   *
   * `readdir` order is not specified, and the byte budget below makes the
   * order matter for more than tidiness: which artifacts get digested when the
   * cap is reached would otherwise be a property of the filesystem's mood.
   * Plain relational comparison rather than `localeCompare`, which is
   * locale-dependent and would reorder a report across machines.
   */
  const ordered = [...scan.safe].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  /**
   * THE REVERSE DIRECTION, DECIDED BEFORE ANY CONTENT IS READ — and the
   * ordering is a fix, not a style choice.
   *
   * "The outbox holds a file the envelope never mentioned" is a statement
   * about two SETS. It does not depend on a single byte of the file. An
   * earlier revision of this function emitted it from inside the digest loop's
   * success branch, which handed a worker a way to suppress it: make the
   * artifact you want unnoticed larger than `MAX_ARTIFACT_BYTES` and the
   * digest refuses, the success branch never runs, and the concealment finding
   * disappears along with the digest. Deciding membership in its own pass over
   * the same ordered list means no content outcome — cap, errno, or budget —
   * can take a set-membership finding off the report.
   */
  if (claimed !== null) {
    for (const f of ordered) {
      if (matched.has(resolve(f.path))) continue;
      discrepancies.push(
        `the outbox holds artifact ${safeForReport(f.path)}, which the envelope does not claim`,
      );
    }
  }

  /**
   * A `ticket-ops.md` WITH NO `ticket-ops.json` BESIDE IT — the half of the
   * document that opts nothing in, arriving alone.
   *
   * ## The defect, measured
   *
   * `skills/ticket-ops/SKILL.md` tells a worker to write both halves. A live
   * ticketing worker wrote only `files/ticket-ops.md`. Everything downstream
   * read as clean, and the reason it read as clean is that NOTHING RAN: both
   * the schema validation above and the credential sweep inside it are keyed
   * on `TICKET_OPS_ARTIFACT_NAME`, so a document that is never written under
   * that name is never parsed and never swept for the credential the worker
   * was holding while it talked to the ticket system. The harvest's silence
   * was not a clean bill of health; it was the absence of an examination, and
   * the two are indistinguishable in a report that says neither.
   *
   * So the finding's job is to state the consequence rather than the fact. "No
   * ticket-ops.json" is a filing complaint an operator can shrug at; "the
   * schema validation and the credential sweep did not run on this document"
   * is the thing they actually need to know.
   *
   * ## SIBLINGS, and not "somewhere in the outbox"
   *
   * The scan walks `files/` recursively, so `ticket-ops.json` can legitimately
   * live in a subdirectory. Pairing is therefore per-DIRECTORY: a `.json` two
   * directories away is a different document about different work, and
   * accepting it as the pair would let one validated file vouch for any number
   * of unvalidated documents elsewhere in the tree. `dirname` on the RAW host
   * path for the same reason the selection above uses the raw one — an escaped
   * copy is a rendering, and two files must not be able to become siblings, or
   * stop being siblings, by how their names print.
   *
   * ## DECIDED BEFORE ANY CONTENT IS READ, deliberately
   *
   * Same reasoning as the reverse-direction pass above, and the same
   * suppression it closes: this is a statement about which NAMES exist, so it
   * must not sit anywhere a byte-cap refusal or a read errno could skip it. A
   * worker that could turn the finding off by making one of the two files
   * enormous would be choosing whether it is graded.
   *
   * ## A limit, stated rather than left to be discovered
   *
   * `scan.safe` holds only entries the scan ACCEPTED. A `ticket-ops.md` that
   * the scan refused — a symlink, a FIFO, an entry past the descriptor budget
   * — is not seen here and produces no pairing finding; its refusal is already
   * a discrepancy of its own. The converse is the useful case and it does
   * work: a `.md` accepted beside a `.json` the scan REFUSED fires this
   * finding, which is a gap the byte-cap clamp above could never reach,
   * because a refused entry never enters the digest loop at all.
   */
  {
    const jsonDirs = new Set<string>();
    const orphanedDocs: string[] = [];
    for (const f of ordered) {
      const name = basename(f.path);
      if (name === TICKET_OPS_ARTIFACT_NAME) jsonDirs.add(dirname(f.path));
    }
    for (const f of ordered) {
      if (basename(f.path) !== TICKET_OPS_DOCUMENT_NAME) continue;
      if (jsonDirs.has(dirname(f.path))) continue;
      orphanedDocs.push(f.path);
    }
    for (const path of orphanedDocs) {
      discrepancies.push(
        `the outbox holds ${TICKET_OPS_DOCUMENT_NAME} at ${safeForReport(path)} with no ` +
          `${TICKET_OPS_ARTIFACT_NAME} beside it, so the ticket-ops schema validation and the ` +
          `credential sweep DID NOT RUN on it; this document is unchecked, not clean`,
      );
    }
    if (orphanedDocs.length > 0) {
      /**
       * IT CLAMPS, and the argument is the one `TICKET_OPS_FAILURE_CEILING`
       * already makes rather than a new one.
       *
       * That constant exists because an artifact that cannot be read leaves
       * "nothing known about what the worker did to a system of record other
       * people share". A document written only in prose is that same state
       * exactly: the machine-readable half that would say which fields were
       * sent, what came back, and whether the two matched was never produced,
       * so the round-trip result the skill's own table turns into a verdict is
       * unavailable. The block above already treats "too large to check" as
       * distinct from "checked and clean"; "never written in a checkable form"
       * is the same distinction, reached by an easier route.
       *
       * The clamp also carries the credential half, which the malformed-document
       * case does not. A `.json` that fails validation was at least SWEPT — the
       * sweep runs inside `parseTicketOpsArtifact` — and this one was not. A
       * report that graded it `success` would be certifying a document nothing
       * has looked at for the token the worker was granted.
       *
       * WHY A CLAMP RATHER THAN A DISCREPANCY, when the two layout findings in
       * `harvest/index.ts` are discrepancies only: this one is attributable.
       * The file is inside THIS task's `files/` directory, so it is this task's
       * output and this task's verdict is the right thing to lower. An
       * unexplained directory under the worker's outbox belongs to no task, and
       * clamping every task of that worker on it would lower verdicts on
       * evidence that names none of them.
       *
       * It is still a CEILING and the `rank` guard at the call site still
       * applies, so `unknown` (rank -1) is untouched. Nothing is weighed on top
       * of evidence the harvest already refused to certify.
       */
      clampTo(
        TICKET_OPS_FAILURE_CEILING,
        `the outbox holds ${TICKET_OPS_DOCUMENT_NAME} with no ${TICKET_OPS_ARTIFACT_NAME} ` +
          `beside it, so neither the schema validation nor the credential sweep ran on the ` +
          `worker's account of what it did to the ticket system`,
      );
    }
  }

  let spent = 0;

  for (const f of ordered) {
    /**
     * Selection happens on the NAME, before a byte is read — see
     * `TICKET_OPS_ARTIFACT_NAME`. `basename` on the raw host path, not on the
     * escaped copy: `safeForReport` rewrites characters, and a name that
     * escapes to something ending in `ticket-ops.json` must not be able to
     * opt itself in or out by how it renders.
     */
    const isTicketOps = basename(f.path) === TICKET_OPS_ARTIFACT_NAME;
    /**
     * Selected on the raw basename for the identical reason, and the census
     * needs the bytes for the identical reason: the document's content is the
     * only place §6.8's three rules can be checked.
     */
    const isCollation = basename(f.path) === COLLATION_ARTIFACT_NAME;
    const outcome = await digestHeldArtifact(
      f,
      Math.min(MAX_ARTIFACT_BYTES, MAX_RECONCILED_BYTES - spent),
      isTicketOps || isCollation,
    );
    /**
     * A collation the caps refused is a REPORTED gap, not a pass — the same
     * suppression the ticket-ops arm below closes, and closed the same way. "Too
     * large to check" and "checked and clean" are different answers, and a
     * worker that could turn the census off by choosing a file size would be
     * choosing whether it is graded.
     */
    if (isCollation && outcome.kind !== "ok" && !collationSeen) {
      collationSeen = true;
      discrepancies.push(
        `collation artifact ${safeForReport(f.path)} could not be censused: ` +
          `the harvester declined to read it (${outcome.kind})`,
      );
      collationRead = {
        kind: "refused",
        code: "too_large",
        reason:
          `the harvester declined to read ${safeForReport(f.path)} (${outcome.kind}), so the ` +
          `collation was neither censused nor validated`,
      };
    }
    /**
     * A ticket-ops document the caps refused is a REPORTED gap, not a pass.
     *
     * Otherwise "make it bigger than the cap" is the dodge that turns
     * validation off, which is the same suppression the reverse-direction pass
     * above was reordered to close: a worker must not be able to choose
     * whether it is graded by choosing a file size. The cap still holds — the
     * document is not parsed and no unbounded read happens — and the ceiling
     * still lands, because "too large to check" and "checked and clean" are
     * not the same answer.
     */
    if (isTicketOps && outcome.kind !== "ok") {
      discrepancies.push(
        `ticket-ops artifact ${safeForReport(f.path)} could not be validated: ` +
          `the harvester declined to read it (${outcome.kind})`,
      );
      clampTo(
        TICKET_OPS_FAILURE_CEILING,
        `a ${TICKET_OPS_ARTIFACT_NAME} artifact in the outbox failed validation, so what the ` +
          `worker did to the ticket system cannot be read from its own report (ISC-332)`,
      );
    }
    switch (outcome.kind) {
      case "ok": {
        spent += outcome.bytes;
        if (isCollation && outcome.retained !== null) {
          /**
           * THE COLLATION, READ HERE AND GRADED ELSEWHERE.
           *
           * `readCollation` is `src/run/collation.ts`'s — the contract's own
           * reader, with its bounds, its refusal codes and its attribution
           * rules — so this module contributes no second opinion about whether a
           * document is a collation. What it contributes is the BYTES, from the
           * descriptor the scan is holding, which is the one thing that file
           * cannot reach.
           */
          if (!collationSeen) {
            collationSeen = true;
            collationRead = readCollation(outcome.retained.toString("utf8"), { taskId: loc.taskId });
            if (collationRead.kind === "refused") {
              discrepancies.push(
                `collation ${safeForReport(f.path)} was refused (${collationRead.code}): ` +
                  `${safeForReport(collationRead.reason, 512)}`,
              );
            }
          } else {
            /**
             * A SECOND `collation.json` anywhere in the tree is reported and
             * ignored, never allowed to replace the first.
             *
             * The scan walks `files/` recursively, so two collations in two
             * directories is a reachable state. Letting the last one win would
             * make the verdict depend on `readdir` order — which `ordered` above
             * exists to stop mattering — and dropping the extras silently would
             * let a collator publish a clean collation beside the real one and
             * choose which gets counted.
             */
            discrepancies.push(
              `the outbox holds a second ${COLLATION_ARTIFACT_NAME} at ` +
                `${safeForReport(f.path)}; the first in path order is the one read, because a ` +
                `verdict must not depend on readdir order and a worker must not get to pick ` +
                `which collation is graded`,
            );
          }
        }
        if (isTicketOps && outcome.retained !== null) {
          const problem = validateTicketOps(outcome.retained, secrets);
          if (problem !== null) {
            discrepancies.push(
              `ticket-ops artifact ${safeForReport(f.path)} ${safeForReport(problem, 512)}`,
            );
            clampTo(
              TICKET_OPS_FAILURE_CEILING,
              `a ${TICKET_OPS_ARTIFACT_NAME} artifact in the outbox failed validation, so what ` +
                `the worker did to the ticket system cannot be read from its own report ` +
                `(ISC-332)`,
            );
          }
        }
        // The raw path stays the matching key above; only the PUBLISHED copy
        // is escaped, so a hostile filename cannot both evade the comparison
        // and reach the report intact.
        artifacts.push({ path: safeForReport(f.path), bytes: outcome.bytes, sha256: outcome.sha256 });
        if (outcome.bytes === 0 && matched.has(resolve(f.path))) {
          // A claim is the worker offering this file as evidence. Offering an
          // empty one is an over-claim in miniature, and it is only visible
          // because the bytes were actually read. Scoped to CLAIMED artifacts:
          // an empty log nobody pointed at is an ordinary quiet build.
          discrepancies.push(
            `envelope claims artifact ${safeForReport(f.path)}, which is present but empty (0 bytes)`,
          );
        }
        break;
      }
      case "too_large":
        discrepancies.push(
          `artifact ${safeForReport(f.path)} is ${outcome.bytes} bytes; the per-artifact cap is ${MAX_ARTIFACT_BYTES} — not digested`,
        );
        break;
      case "over_budget":
        // One finding names the cause, not one per remaining artifact — the
        // same stance `scanOutboxFiles` takes when its descriptor budget runs
        // out, and for the same reason: a report drowned in repetitions of one
        // fact has reported nothing. The line declares its own truncation, so
        // a reader is not left to infer that the inventory below it is partial.
        discrepancies.push(
          `artifact reconciliation stopped after ${spent} bytes; the per-task cap is ${MAX_RECONCILED_BYTES} — remaining artifacts were not digested`,
        );
        return {
    discrepancies,
    artifacts,
    verdictCeiling,
    verdictCeilingReason,
    collation: censusFromRead(collationRead, loc.containerWorkdir),
    collationRead,
  };
      case "unreadable":
        /**
         * THE DEFECT THIS CATCHES REACHED `main` ONCE ALREADY.
         *
         * A revision that validated each artifact and then closed the handle
         * before pushing it shipped in commit `ec9cf7e`, and the accepted list
         * came back full of dead descriptors while every path-projecting test
         * in the suite stayed green — a path is still correct when the fd
         * behind it is not. Nothing in production noticed, because nothing in
         * production read one.
         *
         * Now something does, and a handle that cannot be read says so in the
         * harvest report rather than in nobody's console.
         */
        discrepancies.push(
          `artifact ${safeForReport(f.path)} could not be read through its held descriptor (${outcome.code})`,
        );
        break;
    }
  }

  return {
    discrepancies,
    artifacts,
    verdictCeiling,
    verdictCeilingReason,
    collation: censusFromRead(collationRead, loc.containerWorkdir),
    collationRead,
  };
}
