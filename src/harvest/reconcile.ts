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
import { join, resolve } from "node:path";
import type { ResultEnvelope } from "../contracts.ts";
import {
  containerPathToHost,
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

/** One accepted artifact, with the content facts read off its held inode. */
export interface ReconciledArtifact {
  /** Host path the scan accepted it at — the same spelling `refused` reports. */
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
}

/** What reading one held descriptor produced. */
type DigestOutcome =
  | { kind: "ok"; bytes: number; sha256: string }
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
async function digestHeldArtifact(f: OutboxFile, cap: number): Promise<DigestOutcome> {
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
    }
  } catch (e) {
    return { kind: "unreadable", code: errnoOf(e) };
  }
  return { kind: "ok", bytes: total, sha256: hash.digest("hex") };
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
export async function reconcileArtifactClaims(
  scan: OutboxFileScan,
  claimed: readonly ArtifactClaim[] | null,
  loc: OutboxLocation,
): Promise<ArtifactReconciliation> {
  const discrepancies: string[] = [];
  const artifacts: ReconciledArtifact[] = [];

  // The only region a claim may name. Deliberately `files/` and not the task
  // outbox: `result.json` sits beside it and is the envelope, not an artifact,
  // and the worktree — which `artifactPathProblem` also permits, since a
  // worker may legitimately reference a file it edited — is a repository full
  // of things (`.env`, credentials a build wrote) that this module has no
  // business digesting into a report.
  const filesRoot = resolve(join(loc.workerOutboxDir, loc.taskId, "files"));

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
    const host = containerPathToHost(ref.path, loc);
    if (host === null) {
      // Outside the mount table entirely — the §12.5 primitive. Nothing about
      // this path has been or will be dereferenced.
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

  let spent = 0;

  for (const f of ordered) {
    const outcome = await digestHeldArtifact(f, Math.min(MAX_ARTIFACT_BYTES, MAX_RECONCILED_BYTES - spent));
    switch (outcome.kind) {
      case "ok":
        spent += outcome.bytes;
        artifacts.push({ path: f.path, bytes: outcome.bytes, sha256: outcome.sha256 });
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
        return { discrepancies, artifacts };
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

  return { discrepancies, artifacts };
}
