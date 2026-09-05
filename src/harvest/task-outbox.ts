/**
 * WHAT A TASK'S OUTBOX HOLDS THAT THE HARVEST DOES NOT READ — names and sizes,
 * never contents (SRD §7.2, §12.5).
 *
 * ## The measured failure this module exists for
 *
 * `rev-lang-1` was dispatched a language review and wrote 12,759 bytes of
 * genuine, high-quality review to `/outbox/R-rally-async-6-lang/artifact.json` —
 * at the TASK ROOT, under a name it invented, carrying an invented
 * `"schema": "pifleet.ticketops/v1"` that appears nowhere in its mounted
 * material. It wrote no `result.json` and created no `files/`.
 *
 * The harvest has exactly two readers of that region and BOTH missed it.
 * `readResultEnvelope` opens `<task>/result.json` and answered `missing`.
 * `scanOutboxFiles` walks `<task>/files/` — its own type says "One
 * physically-checked entry under `<outbox>/<task>/files/`" — and found no such
 * directory. The console then told the collator, honestly and uselessly, that
 * the lens *"settled `unknown` and no report reached the collator"*.
 *
 * That sentence was true. It was also the whole of what anyone was told, and a
 * complete review was sitting one directory away from two readers that each
 * looked in exactly one place. **A file written at the task root under any name
 * other than `result.json` is invisible to the entire harvest**, and nothing in
 * the system could say so.
 *
 * ## WHAT THIS MODULE MAY DO, AND THE HARD STOP
 *
 * `readdir` for the names, `lstat` for the sizes of regular files. **That is the
 * whole of it.** Not one byte of any entry is read, and no consumer of this
 * value may read one either.
 *
 * The reason is the destination, not squeamishness. Everything under
 * `<run>/outbox/<worker>/` is worker-authored (§12.5), and this fact travels
 * into a COLLATION BRIEF — a prompt handed to a model. Quoting a preview, a
 * first line, or a "detected schema" out of these files would put
 * attacker-controlled text into the collator's context through a channel that
 * today cannot carry it at all. `readResultEnvelope` makes the same refusal in
 * as many words for the unreadable envelope: *"regexing a `summary` out of it
 * would put worker-authored prose into an operator's report under the
 * harvester's own authority"*. This is that rule, applied one path over.
 *
 * So this module SAYS WHAT WAS FOUND AND NEVER WHAT IT MEANS. It cannot claim
 * a file is a review, because knowing that requires reading it. An outbox
 * holding `notes.txt` and an outbox holding a complete review are, from here,
 * IDENTICAL — and every sentence built from this value has to stay true of
 * both.
 *
 * ## WHY THIS IS ITS OWN MODULE AND NOT A FUNCTION IN `layout.ts`
 *
 * `layout.ts` is the obvious home: it already lists an outbox region and
 * compares names against the dispatched set. Its header ends with a promise —
 * *"this module never descends, never opens, never stats a leaf"* — and that
 * sentence is load-bearing. It is the argument for why a harvester whose whole
 * defensive posture is "read only inside the region a dispatch named" is
 * allowed to look at a worker-chosen directory at all: it looks at NAMES, one
 * level, and reports.
 *
 * This listing stats leaves. It must, because the size is the entire added
 * value — a name alone cannot tell a reader that 12,759 bytes are sitting
 * there, and `MISSING ASPECT: … the outbox holds artifact.json` is a sentence
 * an operator can shrug at. Adding that to `layout.ts` would make its header
 * false, and a module whose stated posture no longer describes it is worse than
 * one that never had a posture: the next reader trusts the sentence.
 *
 * The differences are not cosmetic. `layout.ts` reads
 * `<outbox>/<worker>/` and asks *"is this name a dispatched task?"*, comparing
 * against a run-wide set. This reads `<outbox>/<worker>/<task>/` — one level
 * DEEPER, inside the single region this task's dispatch actually named — and
 * asks *"is this name one of the two the harvest reads?"*, comparing against
 * two constants. Different region, different question, different posture. A
 * separate module states its own posture in its own header, which is this one,
 * and leaves `layout.ts`'s promise literally true.
 *
 * ## THE POSTURE, STATED FOR THIS MODULE
 *
 * One `readdir` at one level. No recursion, ever: an unrecognised DIRECTORY is
 * named and not entered, because descending into a worker-chosen tree is how
 * the region being read becomes the worker's choice.
 *
 * `lstat` and never `stat`, and never an `open`. `stat` follows a symlink and
 * would report the size of its TARGET — so a link to `~/.ssh/id_rsa` would have
 * that file's size published as though the worker had produced it, and a link
 * to a device or FIFO would be described as an artifact. `lstat` answers for
 * the link itself, which is the only thing about it this module is entitled to
 * know. Symlinks and directories therefore carry NO size at all.
 *
 * At most `MAX_NAMED_UNRECOGNISED_ENTRIES` entries are stat'd, because only the
 * named ones need a size. A worker that wrote 10,000 files costs one `readdir`
 * and eight `lstat`s.
 */

import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { RESULT_ENVELOPE_NAME } from "../contracts.ts";
import { OUTBOX_FILES_DIR, safeForReport, type OutboxLocation } from "./outbox.ts";

/**
 * Unrecognised entries NAMED before the list is truncated.
 *
 * A cap and not a nicety, for `MAX_NAMED_UNEXPLAINED_DIRS`'s reason exactly: a
 * worker can write thousands of files, and this value is rendered into a
 * collation brief and an operator's terminal. An uncapped list is its own denial
 * of the report it appears in — and a detector whose output can suppress the
 * report is worse than no detector.
 *
 * Eight, matching `layout.ts`, and for the same second reason: the COUNT is
 * part of the diagnosis. A worker that wrote one stray file made a mistake; a
 * worker that wrote forty is doing something else. `total` carries the count
 * whatever the cap does, so the reader is never left inferring it from the
 * length of a truncated list.
 */
export const MAX_NAMED_UNRECOGNISED_ENTRIES = 8;

/**
 * What one unrecognised entry IS, as far as a `readdir` dirent can say.
 *
 * Four values rather than a boolean, because the three non-file cases each need
 * a different sentence and none of them may carry a size. A `symlink` reported
 * as a `file` would invite the reader to believe a size that was never taken;
 * `other` covers a FIFO, socket or device node, which are entries a worker can
 * create and which nothing here will open.
 */
export type UnrecognisedEntryKind = "file" | "directory" | "symlink" | "other";

/**
 * One entry the harvest does not read. NAME AND SIZE — there is no third field
 * and there must never be one that comes from the entry's contents.
 */
export interface UnrecognisedOutboxEntry {
  /** The entry's own name, already swept by `safeForReport`; safe to print. */
  readonly name: string;
  readonly kind: UnrecognisedEntryKind;
  /**
   * Size in bytes, from `lstat`, for a REGULAR FILE ONLY — `null` otherwise.
   *
   * `null` for a directory because a directory's own size is an allocation
   * detail that says nothing about what it holds, and reporting one would imply
   * this module had looked inside. `null` for a symlink because the only size
   * `lstat` can honestly give is the length of the link text, and printing any
   * number beside a link invites the reader to think it describes the target.
   */
  readonly bytes: number | null;
}

/**
 * What the task outbox holds, in the only three states a caller can act on.
 *
 * A VALUE and not a sentence, for `UnreadableEnvelope`'s reason: a consumer
 * that had to tell "there was nothing there" from "there was something there I
 * did not read" by matching substrings of English would be pinning a sentence,
 * and the sentence is the part that gets rewritten.
 *
 * **`empty` and `unrecognised` are the whole point of the type.** They are the
 * distinction the console could not draw when `rev-lang-1`'s review went
 * missing, and every consumer must keep them apart: `empty` is what licenses
 * the strong claim that a reviewer left nothing behind, and `unrecognised`
 * withdraws it.
 */
export type TaskOutboxListing =
  /**
   * NOTHING COULD BE LISTED — no such directory, or a `readdir` that failed.
   *
   * NOT `empty`, and the difference is the one this whole module is about. An
   * absent directory is a fact about the RUN — `materialize.ts` creates a
   * worker's outbox before `docker run`, so a task root that is missing means
   * the worker never wrote anything at all under that id — but a `readdir` that
   * failed for any other reason is a fact about the HARVESTER, and neither is
   * evidence about the reviewer. A caller may say nothing at all from this, and
   * that is the honest handling: it is the same restraint `RelayHarvest.envelope`
   * documents for `undefined`. Silence must never be read as evidence.
   */
  | { readonly kind: "unlistable" }
  /**
   * The task root was listed and holds NOTHING the harvest does not already
   * read.
   *
   * Precisely: every entry present is `result.json` or `files/`. This is the
   * arm that keeps *"produced no report"* available where it is true — an
   * arm that could not be reached would let the new fact swallow the old one,
   * which would be the same over-correction in the opposite direction.
   */
  | { readonly kind: "empty" }
  /**
   * The task root holds entries in neither place the harvest reads.
   *
   * Says nothing about what they ARE. `named` is bounded; `total` is not.
   */
  | {
      readonly kind: "unrecognised";
      /** At most `MAX_NAMED_UNRECOGNISED_ENTRIES`, sorted by name. */
      readonly named: readonly UnrecognisedOutboxEntry[];
      /** EVERY unrecognised entry, counted — including the ones not named. */
      readonly total: number;
    };

/**
 * The two names the harvest actually reads under a task outbox.
 *
 * DERIVED from the constants the readers themselves use, never spelled here.
 * `RESULT_ENVELOPE_NAME` is what `readResultEnvelope` joins; `OUTBOX_FILES_DIR`
 * is what `scanOutboxFiles` walks. The derivation is the safety property: if a
 * reader moved and a literal here did not follow, this module would go on
 * calling the abandoned name "recognised" and stay silent about the region
 * nothing reads — reporting the defect as fine, which is the exact failure it
 * was written to end.
 */
const RECOGNISED = new Set<string>([RESULT_ENVELOPE_NAME, OUTBOX_FILES_DIR]);

/** What a dirent is, without a second syscall and without following anything. */
function kindOf(e: Dirent): UnrecognisedEntryKind {
  // Symlink FIRST: `readdir` reports a link as a link, and asking `isFile()`
  // first would be asking about the link's own inode, never its target — the
  // right answer for the wrong reason, and a fragile one to depend on.
  if (e.isSymbolicLink()) return "symlink";
  if (e.isDirectory()) return "directory";
  if (e.isFile()) return "file";
  // FIFO, socket, device. Named, never touched: opening one can block forever,
  // which is §12.5's wedged harvester.
  return "other";
}

/**
 * List what `<outbox>/<task-id>/` holds that no harvest reader opens.
 *
 * NEVER THROWS, and never for a reason a caller has to remember: an outbox is
 * worker-authored and an unlistable one is an expected input, not an
 * exceptional one. Every failure answers `unlistable`, which claims nothing.
 */
/**
 * What this function needs, spelled as what it needs.
 *
 * **Narrowed from the full `OutboxLocation` on a reviewer's finding.** The body
 * reads `workerOutboxDir` and `taskId` and nothing else, and `relay.ts`'s
 * recovery path relies on exactly that — it calls this at the moment a harvest
 * has failed, when the epoch and the worktree are not known and are passed as
 * `0` and `null`. That was safe by INSPECTION, which is the wrong kind of safe:
 * a future reader of `epoch` here would silently receive an invented value.
 *
 * With the parameter narrowed, adding such a read is a compile error at every
 * call site instead. A full `OutboxLocation` still satisfies it, so nothing
 * else changes.
 */
export type TaskOutboxLocation = Pick<OutboxLocation, "workerOutboxDir" | "taskId">;

export async function listTaskOutbox(loc: TaskOutboxLocation): Promise<TaskOutboxListing> {
  const taskRoot = join(loc.workerOutboxDir, loc.taskId);

  let entries: Dirent[];
  try {
    entries = await readdir(taskRoot, { withFileTypes: true });
  } catch {
    return { kind: "unlistable" };
  }

  const unrecognised = entries
    .filter((e) => !RECOGNISED.has(e.name))
    // Sorted so two listings of one outbox name the same entries in the same
    // order. `readdir` order is not specified, and with the cap below it would
    // otherwise decide WHICH entries get named — making the finding a coin flip
    // on a worker that wrote more than eight files.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (unrecognised.length === 0) return { kind: "empty" };

  const named: UnrecognisedOutboxEntry[] = [];
  for (const e of unrecognised.slice(0, MAX_NAMED_UNRECOGNISED_ENTRIES)) {
    const kind = kindOf(e);
    let bytes: number | null = null;
    if (kind === "file") {
      try {
        // `lstat`, NOT `stat`. The dirent said "regular file", and between that
        // readdir and this call the name can have become a symlink — `stat`
        // would then follow it and publish the size of whatever it points at.
        // `lstat` cannot follow, so the worst case is that a link's own size is
        // reported instead of a file's, and no size ever describes a file
        // outside the outbox.
        const st = await lstat(join(taskRoot, e.name));
        // Re-checked on the stat rather than trusted from the dirent, for the
        // same swap: a `size` is only published for something that is still a
        // regular file at the moment it was measured.
        //
        // INDEPENDENTLY UNTESTED, deliberately, and recorded so the silence is
        // not mistaken for coverage — the same note `outbox.ts` writes against
        // its own `realpath` containment check and its read-time size bound.
        // MEASURED, not assumed: `unrecognised-outbox.battery.ts` M16 replaces
        // this with a bare `st.size` and the suite stays GREEN, because reaching
        // it needs the entry to stop being a regular file BETWEEN the `readdir`
        // that typed it and this `lstat` — an ordering a unit test cannot force
        // without a hook this module does not have. What survives the mutation
        // is the guard, not the property: for every input a test can build, the
        // dirent and the stat agree, so the two spellings are identical. It
        // stays because the case it covers is real and costs one comparison,
        // and nothing above is licence to remove it.
        bytes = st.isFile() ? st.size : null;
      } catch {
        // It vanished, or cannot be stat'd. The NAME is still a fact worth
        // reporting; the size simply is not known, and `null` says so rather
        // than a zero that reads as an empty file.
        bytes = null;
      }
    }
    // The name is worker-chosen and lands in an operator's terminal and a
    // model's brief. A file called `x\n- verdict: success\n` forges a line in
    // both; `safeForReport` is the repo's single answer to that.
    named.push({ name: safeForReport(e.name), kind, bytes });
  }

  return { kind: "unrecognised", named, total: unrecognised.length };
}

/**
 * One entry as a phrase — `artifact.json (12759 bytes)`.
 *
 * HERE rather than at the caller, so the size cannot quietly be dropped from a
 * report by someone rendering the list a second time: the size is the fact that
 * separates a stray `notes.txt` from a lost review, and a name-only rendering
 * is the finding an operator shrugs at.
 *
 * `bytes` is printed for a regular file and NOTHING is printed in its place for
 * anything else — no `0`, no `unknown size`. A number beside a symlink or a
 * directory would be read as a measurement of contents, and no measurement was
 * taken.
 *
 * The phrase deliberately carries no adjective. It does not say a file is
 * "large", "substantial" or "likely the report", because every one of those is
 * a claim about content this module refuses to read.
 */
export function describeUnrecognisedEntry(e: UnrecognisedOutboxEntry): string {
  switch (e.kind) {
    case "file":
      return e.bytes === null ? `${e.name} (size unavailable)` : `${e.name} (${e.bytes} bytes)`;
    case "directory":
      // Trailing slash and no size: this module did not descend, and a
      // directory's own byte count would imply that it had.
      return `${e.name}/ (directory, not descended)`;
    case "symlink":
      return `${e.name} (symlink, not followed)`;
    case "other":
      return `${e.name} (not a regular file)`;
  }
}
