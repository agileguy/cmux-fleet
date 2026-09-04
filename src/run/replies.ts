/**
 * The REPLY PLANE — a child task's harvested result, delivered as a HOST-WRITTEN
 * FILE (SRD-REVIEW-CONSOLE §6.4, D6).
 *
 * The review console's collator has an intent and no wire to carry it. §4.3
 * settles why it never gets one: a socket granted to a container is a
 * prompt-injection channel with a fleet-issued identity, so the collator's
 * intent travels as DATA in both directions. Outbound that is
 * `/outbox/<task-id>/dispatch-request.json`, which needs no new mount because
 * the outbox already exists, is already worker-scoped, and is already the
 * untrusted-content boundary. Inbound is this module, and it is the one new
 * mount the design asks for.
 *
 * ## Why a mount at all, rather than the route the outbound half takes
 *
 * The obvious symmetry — put the reply in the worker's own outbox — inverts the
 * one property that makes the outbox safe. `/outbox` is `rw` because the worker
 * writes it, and everything the HOST puts there would be writable by the subject
 * it is about: a reviewer's verdict, dropped into the collator's own writable
 * directory, is a verdict the collator can edit before quoting it. The reply is
 * evidence in the same sense `/policy/task` is, so it lands on the same kind of
 * surface — a read-only bind the worker does not own.
 *
 * ## Why named files and not a directory the collator lists (D6)
 *
 * Rejected: a `/replies` the collator enumerates. A listing hands the worker a
 * directory to walk and re-introduces exactly the discoverability the outbox
 * contract denies in the other direction (`harvest/layout.ts`: *"this module
 * never descends, never opens, never stats a leaf"*). Named files, named in the
 * brief, are the shape `/policy/dispatch` already uses.
 *
 * **The cost D6 records, stated rather than buried:** the collation brief has to
 * carry the three paths, so a reply that arrives AFTER the brief is written is
 * invisible. That is fine under D5, where all three children have settled before
 * the collation brief exists, and it would not be under a streaming design. The
 * day this feature grows a fourth reviewer that reports late is the day D6 needs
 * re-deciding, not the day this module quietly grows a `readdir`.
 *
 * ## The rewrite recipe is load-bearing, and it is the same one twice over
 *
 * A bind mount pins the INODE. Tmp-file + rename — which is what nearly all
 * "atomic write" advice recommends, and which looks MORE careful than the code
 * below — swaps the file the HOST sees while the container keeps reading the old
 * one for the life of the container, with both sides believing the reply
 * changed. Every write here is therefore chmod 0644 -> truncate in place ->
 * chmod 0444, never rename. `writeFile` with the default `w` flag truncates an
 * existing file rather than replacing it, so the inode survives;
 * `test/unit/replies.test.ts` asserts the inode directly rather than trusting
 * the flag, because this is the one property that cannot be caught by reading
 * the code — the wrong version looks more careful than the right one.
 *
 * `task-policy.ts` and `dispatch-policy.ts` each record the same hazard for the
 * same reason. Three copies of one recipe is not duplication to be factored
 * away: the hazard belongs to the BIND MOUNT rather than to any one file, and a
 * shared `writePolicyFile` helper would let a fourth caller inherit the recipe
 * without inheriting the argument for it. What is shared is the mechanism
 * (`makeWorkerReadable`), which is the part that can actually drift.
 *
 * ## What being a sibling of `/policy/*` obliges
 *
 * `docker/verbgate`'s integrity loop refuses EVERY verb (exit 78) when any
 * policy surface is writable by the uid consulting it, and `/replies` is now in
 * that loop. That is not defence in depth against a hostile worker — the gate's
 * own header is honest that a determined worker reaches past it — it is the
 * tripwire for a DROPPED `:ro`, which is one character and has no other symptom.
 * The macOS Docker VM squashes bind-mount ownership to the container user, so a
 * 0444 host file reads as owner-owned inside the container and the mount flag is
 * the only thing left standing between a reply and the worker that is graded
 * against it.
 *
 * ## What this module deliberately does NOT decide
 *
 * The reply's SCHEMA, and whether the drop needs a byte cap the way
 * `/policy/dispatch` does (`MAX_DISPATCH_POLICY_BYTES`, 256 KiB, because a
 * reader that discovers the size has already paid for it). Both belong to the
 * actor — the host-side process that joins the children and writes these files —
 * and SRD-REVIEW-CONSOLE §6.5 records that where the actor lives is BLOCKING and
 * unanswered (§9 Q4). Inventing either here would be inventing a default in the
 * one place the document says not to. This module owns the mount, the name, the
 * mode and the recipe; the payload is the caller's.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeWorkerAccessible, makeWorkerReadable } from "../container/mounts.ts";
import { EXIT, SESSION_ID_RE } from "../contracts.ts";

/** Where the run-tree directory lands inside the worker container. */
export const REPLIES_MOUNT = "/replies";

/**
 * The suffix every reply carries.
 *
 * A CONSTANT because two readers agree on it and neither is this module: the
 * brief that names the file to the collator, and whatever reads it back. A
 * suffix spelled once in source and once in a prompt template is two spellings
 * that drift, and the failure is a brief pointing at a path that does not exist
 * — which a model answers by inventing what it thinks the file said.
 */
export const REPLY_SUFFIX = ".json";

/**
 * A child task id that cannot be a filename.
 *
 * `EXIT.USAGE` and not `EXIT.INTERNAL`, on the grade `DispatchPolicyTooLargeError`
 * carries and for its reason: the id reaches here from a dispatch request the
 * COLLATOR wrote, so the remedy is the operator's — fix the request, or fix the
 * role that produced it — and reporting it as an internal fault would tell a
 * machine caller that pifleet broke, which an orchestrator answers by retrying
 * the identical document forever (ISC-216's shape).
 */
export class ReplyNameError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(readonly childTaskId: string) {
    super(
      `child task id ${JSON.stringify(childTaskId)} cannot name a reply file — a reply is ` +
        `one ordinary entry inside ${REPLIES_MOUNT}, so the id must be 1-64 characters of ` +
        `letters, digits, ".", "_" or "-", beginning and ending alphanumeric`,
    );
    this.name = "ReplyNameError";
  }
}

/**
 * The basename of one child's reply, with the id held to a path-segment grammar.
 *
 * **The validation is here rather than at a call site, and it is not ceremony.**
 * `TaskEnvelopeSchema.task_id` is `shortStr` — a length bound and nothing else
 * (`src/contracts.ts`) — so `../../control-auth.json` is a task id the schema
 * accepts, and the id on this path arrives from a file the COLLATOR wrote. The
 * `join` below becomes `writeFile` and `chmod` on the host, in a run directory
 * that also holds the control-socket secret. `SESSION_ID_RE` is the grammar
 * `materialize.ts`'s `assertContained` already applies to every operator-typed
 * name that becomes a host path, and the argument transfers unchanged: a name
 * that cannot be spelled cannot escape.
 *
 * The character-class check comes FIRST and is root-independent, so it is exact
 * for `.` and `..` — which a containment predicate answers "no, it did not
 * escape" for, because the resolved path IS the directory. `assertContained`
 * records that measurement; this reuses its conclusion rather than re-deriving
 * it.
 */
export function replyFileName(childTaskId: string): string {
  if (!SESSION_ID_RE.test(childTaskId) || childTaskId.length > 64) {
    throw new ReplyNameError(childTaskId);
  }
  return `${childTaskId}${REPLY_SUFFIX}`;
}

/**
 * The path the WORKER reads — what a collation brief has to say out loud.
 *
 * Exported because D6's whole cost is that the brief carries the paths: a
 * builder that spelled `/replies/${id}.json` itself would be a second answer to
 * a question this module answers, and the two would agree until the day the
 * suffix or the mount moved. Same rule as `run/paths.ts`'s first: a path
 * computed in two places is eventually computed differently in two places.
 */
export function replyMountPath(childTaskId: string): string {
  return `${REPLIES_MOUNT}/${replyFileName(childTaskId)}`;
}

/** The host half of the same file, under a worker's `workerRepliesDir`. */
export function replyHostPath(dir: string, childTaskId: string): string {
  return join(dir, replyFileName(childTaskId));
}

/**
 * Establish the reply directory, empty.
 *
 * Called by `materialize.ts` before `docker run`, and the ordering is the point
 * rather than tidiness: Docker CREATES a missing bind-mount source instead of
 * refusing, so a `-v` whose host directory nobody made comes up as an empty
 * `/replies` that can never gain content — the silent-empty-mount failure
 * `container/mounts.ts` exists to describe, arriving one layer earlier.
 *
 * 0755 and not 0777 — `roleSkillsDir`'s mode, and its argument as well.
 * `makeWorkerAccessible(dir, false)` is the read-only arm: the execute
 * bit lets uid 10001 traverse in and read a reply, the OWNER write bit is what
 * lets the host actor deliver one, and group and other get neither. A
 * world-writable replies directory would publish the console's evidence to every
 * account on the host and — through the verbgate's `[ -w "${policy_path}" ]`
 * arm — cost the worker every gated verb it attempts.
 *
 * WHAT STOPS THE WORKER WRITING IT IS `:ro`, NOT THIS MODE, and the distinction
 * is worth keeping straight because it is where a reader will guess wrong — the
 * usual guess being that the macOS VM squashes ownership here the way it does
 * for a bind-mounted FILE. It does not, and the measured behaviour is stranger
 * and reaches the same conclusion by a different route. MEASURED 2026-09-04,
 * uid 10001 inside the worker image, this directory bind-mounted READ-WRITE:
 *
 *     /replies              mode=755 owner=0:0        [ -w ] -> TRUE
 *     /replies/T-arch.json  mode=444 owner=10001:10001 [ -w ] -> false
 *     /replies/T-ctx.json   mode=644 owner=10001:10001 [ -w ] -> TRUE
 *
 * The mount POINT keeps root ownership and this 0755 mode — under which uid
 * 10001 is "other" and should have no write at all — and `access(W_OK)` answers
 * TRUE regardless, because the VM's shared filesystem answers it rather than
 * ordinary DAC. The FILES are the ones squashed to the container user. So the
 * mode genuinely says nothing about what the worker may do here, just not for
 * the reason a reader expects. Re-mounted `:ro` every one of those goes false —
 * `access(W_OK)` returns EROFS regardless of mode or ownership — which is what
 * makes the verbgate's check on this directory a tripwire on the MOUNT FLAG
 * rather than a second opinion about the mode.
 */
export async function createRepliesDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await makeWorkerAccessible(dir, false);
}

/**
 * Write one child's reply IN PLACE, preserving the inode the container's bind
 * mount is pinned to.
 *
 * Takes the DIRECTORY and the child id rather than a finished path, which is the
 * one departure from `writeTaskPolicy`/`writeDispatchPolicy`'s shape and is
 * deliberate. Those two write a fixed name; this one derives a name from
 * untrusted input, and handing the caller a `file` parameter would put the
 * derivation — and therefore `replyFileName`'s grammar check — outside the
 * function that depends on it. Containment is a property of the CONSTRUCTION
 * here, the same posture `exportsDir` takes in `run/paths.ts`: there is no input
 * to get wrong because the caller never supplies a path.
 *
 * The three steps, in the order that makes them a contract:
 *
 * 1. **Render and validate FIRST, before the file is touched at all.** A writer
 *    that widened and then discovered the payload would not serialise would
 *    leave a stale reply behind at 0644 — a file the worker can both misread and
 *    rewrite, and one the verbgate answers by refusing every verb. Refusing
 *    before the first chmod is what makes "the file is unmodified when the write
 *    is refused" true rather than approximately true.
 * 2. **Widen.** The file is 0444 between writes — the worker must never hold
 *    write permission on the evidence it is being graded against — so the mode
 *    is widened for the write and restored immediately. On POSIX the owner of a
 *    0444 file cannot open it for writing either, so this is not ceremony: skip
 *    the widen and a re-delivered reply fails.
 * 3. **Truncate in place, then restore 0444 — even when the write throws.**
 *    Never rename; see the module docblock.
 *
 * Step 3's "even when the write throws" is the part that was missing and is not
 * decoration. Between the widen and the narrow the file is 0644 AND `writeFile`
 * has already truncated it (the default `w` flag is `O_TRUNC`), so an ENOSPC or
 * an EIO in that window used to leave a reply that is empty, writable, and
 * permanent — which is precisely the state this module spends its docblock
 * explaining is worth a whole worker: the collator can now author the evidence
 * it is about to quote, and the verbgate answers a writable reply plane by
 * refusing every gated verb.
 *
 * The restore is a `catch` + rethrow rather than a bare `finally`, and the
 * difference is which error the caller ends up holding. A `finally` that chmods
 * unconditionally throws ENOENT of its own when the write failed because the
 * file was never created at all — masking the write's cause with a message about
 * a chmod. So: on the happy path the narrow is unguarded and any failure is
 * loud, exactly as before; on the failure path the narrow is best-effort and the
 * WRITE's error is what propagates, because that is the actionable one.
 *
 * Returns the host path written, so a caller that has to log or correlate does
 * not re-derive it.
 */
export async function writeReply(
  dir: string,
  childTaskId: string,
  reply: unknown,
): Promise<string> {
  const file = replyHostPath(dir, childTaskId);
  /**
   * Two spaces, and pretty-printed on purpose. The reader is a model with the
   * file's whole contents in one gulp, and the compact form of a nested harvest
   * record is a single line thousands of characters long — which is precisely
   * the shape a truncating reader ruins first.
   */
  const body = JSON.stringify(reply, null, 2);
  /**
   * `JSON.stringify` returns `undefined` — the value, not the string — for
   * `undefined`, a function or a symbol, and `writeFile` would then persist the
   * four characters "undefined" as the reply. A reply that parses as nothing and
   * reads as a word is worse than a missing file, because the missing file is
   * the case the collation brief can describe.
   */
  if (typeof body !== "string") {
    throw new TypeError(
      `the reply for child task "${childTaskId}" does not serialise to JSON, so there is ` +
        `nothing to deliver; a reply file that reads "undefined" is worse than an absent one`,
    );
  }

  /**
   * The widen is skipped only when the file does not exist YET — the very first
   * write, which creates the inode the bind mount will pin. Any other chmod
   * failure is real and propagates: a reply whose mode could not be restored to
   * 0444 must not be papered over, because the next thing that happens is the
   * worker holding write permission on the evidence it is graded against and the
   * gate refusing every verb it attempts.
   */
  try {
    await makeWorkerReadable(file, true);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  try {
    await writeFile(file, `${body}\n`);
  } catch (writeErr) {
    // The window this closes: the file is 0644 and already truncated. Narrow it
    // back before propagating, and swallow only the NARROWING's own failure —
    // never the write's, which is the error that says what actually happened.
    await makeWorkerReadable(file, false).catch(() => {});
    throw writeErr;
  }
  await makeWorkerReadable(file, false);
  return file;
}
