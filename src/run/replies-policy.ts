/**
 * The DECLARED REPLY SET — which replies exist for THIS turn, delivered as a
 * HOST-WRITTEN FILE (SRD-WORKER-DISPATCH-EXTENSION §7.4, D6).
 *
 * `get_replies` cannot be a `readdir`, and the reason is Finding E rather than
 * taste. `workerRepliesDir(run.root, worker)` is one directory per worker per
 * RUN, and the triage console is one long-lived run publishing
 * `<childTaskId>.json` per sweep — so sweep 5's collator listing `/replies`
 * would see sweeps 1 through 5 and collate a mixture of five different
 * questions, each of which reads like a perfectly good answer. A directory
 * listing is a freshness bug wearing the shape of a feature.
 *
 * `replies.ts` already refuses the listing from the other direction — *"a
 * listing hands the worker a directory to walk and re-introduces exactly the
 * discoverability the outbox contract denies"* — and this module is the second
 * half of that refusal: the set cannot be DISCOVERED, so it must be DECLARED.
 *
 * ## Declaring and publishing are ONE act, and that is the whole design
 *
 * §7.4 is explicit that the declaration is written by the same composition root
 * that publishes the replies — `productionRelayEffects.publishReplies`, reached by
 * the review console through `fanOut` and by the triage console through
 * `publishRepliesFor`, so ONE FUNCTION rather than two call sites obeying a rule. Not "at the same time" — by the same code, in the
 * same act. That is what makes the set a worker can read BY CONSTRUCTION the set
 * the host published, rather than two lists that agree until the day one of them
 * is edited. Failure mode 9.6 is what a split buys: a dispatch that rewrote
 * `/policy/task` and not this file hands the collator a previous sweep's set —
 * *"Finding E arriving through the front door"*.
 *
 * This module therefore derives each declared `path` from `replyMountPath`, the
 * same function that names the file the brief cites and that `writeReply`'s
 * `replyHostPath` names the host half of. A declaration that spelled
 * `/replies/${id}.json` itself would be a second answer to a question
 * `replies.ts` already answers, and the two would agree until the suffix or the
 * mount moved.
 *
 * ## Why a THIRD policy file rather than a line on one of the two that exist
 *
 * §7.4 records the rejected arms; two are worth repeating here because they are
 * the ones a later editor will re-propose:
 *
 * 1. **Not a third line on `/policy/task`.** Its reader is POSIX `sh` doing
 *    `sed -n 1p`/`2p` inside `docker/verbgate`, and `task-policy.ts` records
 *    that the two-line shape was chosen BECAUSE of that parser. A JSON document
 *    on line 3 is *probably* compatible, and "probably" is not a word a file the
 *    verbgate parses gets to use.
 * 2. **Not `/policy/dispatch`.** That file is *"present and non-empty only when
 *    your task was staged"* (`skills/pifleet-worker/SKILL.md`), and a collation
 *    turn is not staged. Reusing it would make the drop mean two things
 *    depending on how the turn arrived.
 *
 * ## An EMPTY array is a value, not an absence
 *
 * `replies: []` on a turn-one dispatch is the point of the file existing at all.
 * It is what lets `get_replies` answer *"nothing was declared"* instead of
 * *"the directory is empty"* — a distinction `roles/triage.md` and
 * `roles/collator.md` each spend a paragraph establishing — both opening
 * *"So checking cannot tell you anything"* — and one a
 * `readdir` cannot make at all. So the file is written at every dispatch,
 * including the ones with nothing to declare, and it is never deleted.
 *
 * ## The rewrite recipe is load-bearing, and it is the same one a third time
 *
 * A bind mount pins the INODE. Tmp-file + rename — which is what nearly all
 * "atomic write" advice recommends, and which looks MORE careful than the code
 * below — swaps the file the HOST sees while the container keeps reading the old
 * one for the life of the container, with both sides believing the declaration
 * changed. Every write here is therefore chmod 0644 -> truncate in place ->
 * chmod 0444, never rename. `writeFile` with the default `w` flag truncates an
 * existing file rather than replacing it, so the inode survives;
 * `test/unit/replies-policy.test.ts` asserts the inode directly rather than
 * trusting the flag, because this is the one property that cannot be caught by
 * reading the code — the wrong version looks more careful than the right one.
 *
 * **This is the exact INVERSE of the rule for the result envelope**, which
 * `harvest` may read at any moment and which is therefore REPLACED so it is
 * never observed half-written (`test/unit/report-tools.test.ts` asserts the
 * inode CHANGES there). Both assertions are deliberate and they are opposite,
 * because the readers are opposite: a bind-mounted policy file whose inode moves
 * is a file the container stops seeing at all.
 *
 * `task-policy.ts`, `dispatch-policy.ts` and `replies.ts` each record the same
 * hazard for the same reason. Four copies of one recipe is not duplication to be
 * factored away: the hazard belongs to the BIND MOUNT rather than to any one
 * file, and a shared `writePolicyFile` helper would let a fifth caller inherit
 * the recipe without inheriting the argument for it.
 *
 * ## Where the host path is spelled, and why it is spelled in BOTH places
 *
 * The basename lives HERE, in `repliesPolicyHostPath`, beside the mount
 * constant, the mode and the rewrite recipe — the shape `replies.ts` already
 * uses for `replyHostPath`, and the one that keeps those four from drifting
 * apart. `render.ts` calls it directly, which satisfies that file's standing
 * rule that it joins no path under the run directory itself (ISC-188) the same
 * way `workerRepliesDir` does: render is handed a directory it did not compute
 * and asks a single function for the name inside it.
 *
 * `WorkerPaths.repliesPolicy` (`run/paths.ts`) is ALSO that path, and it is not
 * a second spelling — the field is assigned `repliesPolicyHostPath(dir)`. It
 * exists because the FIRST version of this module shipped without it, and
 * ISC-1091 is the bill: `cloudAllow`, `taskPolicy` and `dispatchPolicy` are
 * fields, so `materialize.ts` establishes each as `paths.<name>` before
 * `docker run` — and a mount whose source had no field was a mount nothing
 * established, which Docker answers by creating a DIRECTORY at the host path.
 * Every later `writeRepliesPolicy` then fails `EISDIR` and every `get_replies`
 * reads nothing, permanently and silently. Being a function rather than a field
 * did not cause that, but it is what let the omission look deliberate: three
 * siblings in one list and a fourth somewhere else reads as complete.
 *
 * So the ruling is BOTH, with one direction of derivation: this module names
 * the file, `paths.ts` caches that answer under the name its siblings use, and
 * nothing else joins it. A `join(dir, "replies-policy")` in `paths.ts` would be
 * the drift this section exists to refuse, and `replies-policy.test.ts` asserts
 * the field against the function so that it cannot be written.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeWorkerReadable } from "../container/mounts.ts";
import { EXIT } from "../contracts.ts";
import { replyMountPath } from "./replies.ts";
import { TASK_POLICY_NONE, renderTaskPolicy } from "./task-policy.ts";

/** Where the run-tree file lands inside the worker container. */
export const REPLIES_POLICY_MOUNT = "/policy/replies";

/**
 * The schema tag `get_replies` checks before it believes a byte of this file.
 *
 * Versioned in the shape every other pifleet wire document is
 * (`pifleet.result/v1`, `pifleet.submit/v1`): the reader is baked into an image
 * pinned by tag, so the host and the extension are updated on different clocks
 * and a mismatch has to be a refusal rather than a misparse.
 */
export const REPLIES_POLICY_SCHEMA = "pifleet.replies/v1";

/**
 * The basename, beside `task-policy` and `dispatch-policy` in the worker's own
 * directory. `-policy` and not `replies`, so that a `ls` of the worker
 * directory reads as the three files of one surface and so that it cannot be
 * confused with `<run>/replies/<worker>/`, which is the reply PLANE and a
 * different object.
 */
const REPLIES_POLICY_FILE = "replies-policy";

/** The host half of the mount, under a worker's `WorkerPaths.dir`. */
export function repliesPolicyHostPath(workerDir: string): string {
  return join(workerDir, REPLIES_POLICY_FILE);
}

/**
 * One reply the host is publishing this turn, as its publisher knows it.
 *
 * No `path`. The publisher does not get to name the file, because a publisher
 * that named it would be the second thing naming it; `renderRepliesPolicy`
 * derives it from `replyMountPath`, which is the same call `replies.ts` makes to
 * tell the brief where the file is. Declaring and publishing are one act only if
 * they cannot disagree about where.
 */
export interface DeclaredReply {
  /** The CHILD task whose harvested result this is — the reply file's name. */
  task_id: string;
  /** The worker that produced it, for the collator's attribution. */
  worker: string;
  /** Which lens or slice it covers — `roles/collator.md`'s vocabulary. */
  aspect: string;
}

/** One entry as it appears on disk: a `DeclaredReply` plus the derived path. */
export interface DeclaredReplyEntry extends DeclaredReply {
  /** The container path — `replyMountPath`'s answer, never a second spelling. */
  path: string;
}

/** The whole document, as `get_replies` parses it. */
export interface RepliesPolicy {
  schema: typeof REPLIES_POLICY_SCHEMA;
  /**
   * The task this set belongs to, spelled EXACTLY as `/policy/task` line 1
   * spells it — see `renderRepliesPolicy`. 9.6's staleness check is an equality
   * against that file, and an equality between two different normalizations of
   * one id is a check that fails on the honest path.
   */
  task_id: string;
  replies: DeclaredReplyEntry[];
}

/**
 * Two declared replies naming ONE child task.
 *
 * Refused rather than deduplicated, because the duplicate is never harmless: the
 * `path` is derived from the child task id, so two entries with the same id name
 * the SAME file with different `worker`/`aspect` attributions — and only one of
 * the two publishes actually survives, since the second `writeReply` truncates
 * the first. A collator reading that set attributes one file's contents to two
 * workers and has no way to notice. Silently dropping one entry would hide the
 * same bug one layer down.
 *
 * `EXIT.USAGE` for `ReplyNameError`'s reason: the ids reach here from a dispatch
 * request the COLLATOR wrote, so the remedy is the operator's — fix the request
 * or the role that produced it — and reporting it as an internal fault would
 * tell a machine caller pifleet broke, which an orchestrator answers by retrying
 * the identical document forever.
 */
export class DuplicateReplyError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(readonly childTaskId: string) {
    super(
      `child task ${JSON.stringify(childTaskId)} is declared twice in one reply set — each ` +
        `declared reply names ${JSON.stringify(REPLIES_POLICY_MOUNT)} entry derived from its ` +
        `own task id, so two entries with one id name one file and the second publish ` +
        `overwrites the first`,
    );
    this.name = "DuplicateReplyError";
  }
}

/**
 * Spell a task id the way `/policy/task` line 1 spells it.
 *
 * NOT a re-implementation of `renderTaskPolicy`'s normalization — a CALL to it,
 * reading line 1 back. The two ends have to agree exactly, because failure mode
 * 9.6 is answered by `get_replies` comparing this file's `task_id` against
 * `/policy/task`'s, and any id that the two normalized differently would fail
 * that comparison forever on the HONEST path: the tool would report a stale
 * declaration for a set that is perfectly fresh, which is the most expensive way
 * a freshness check can be wrong.
 *
 * A copied regex and a copied `slice(200)` would agree today and drift the first
 * time either bound moved. Reading line 1 of the real renderer cannot.
 */
function asTaskPolicySpellsIt(taskId: string | null): string {
  const [line] = renderTaskPolicy(taskId, 0).split("\n");
  return line === undefined || line === "" ? TASK_POLICY_NONE : line;
}

/**
 * Render the declaration.
 *
 * Pretty-printed, two spaces, for the reason `writeReply` gives and one more of
 * its own: this file is read beside `/policy/task` by whoever is debugging what
 * a worker was told, and a two-line text file next to a single thousand-character
 * JSON line is a pair nobody reads as a pair.
 *
 * NOTHING here is sanitized, and that is a decision rather than an omission.
 * `renderTaskPolicy` strips control characters because its format breaks — an id
 * carrying a newline shifts the epoch onto line 3 and hands `sed` an empty
 * field. JSON has no such failure: `JSON.stringify` escapes every control
 * character, and the fields below are read by a model that is already reading
 * the reply payloads themselves, which are strictly less trusted than these
 * three short strings. The one field that DOES get held to a grammar is the
 * child task id, and it is held to it by `replyMountPath` — because that one
 * becomes a filename on the host.
 */
export function renderRepliesPolicy(
  taskId: string | null,
  replies: readonly DeclaredReply[],
): string {
  const seen = new Set<string>();
  const entries: DeclaredReplyEntry[] = replies.map((r) => {
    if (seen.has(r.task_id)) throw new DuplicateReplyError(r.task_id);
    seen.add(r.task_id);
    // `replyMountPath` throws `ReplyNameError` for an id that cannot be a
    // filename. Letting it out is the point: a declaration naming a path no
    // publish could ever create is worse than a refused dispatch, because the
    // collator answers a missing file by inventing what it thinks it said.
    return { task_id: r.task_id, worker: r.worker, aspect: r.aspect, path: replyMountPath(r.task_id) };
  });
  const doc: RepliesPolicy = {
    schema: REPLIES_POLICY_SCHEMA,
    task_id: asTaskPolicySpellsIt(taskId),
    replies: entries,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Rewrite the declaration IN PLACE, preserving the inode the container's bind
 * mount is pinned to.
 *
 * The three steps, in the order that makes them a contract:
 *
 * 1. **Render FIRST, before the file is touched at all.** A writer that widened
 *    and then discovered a duplicate or an unnameable child id would leave the
 *    PREVIOUS turn's declaration behind at 0644 — stale, and writable by the
 *    worker it is about. That is 9.6 and a verbgate refusal in one artifact.
 *    Refusing before the first chmod is what makes "the file is unmodified when
 *    the write is refused" true rather than approximately true.
 * 2. **Widen.** The file is 0444 between writes — the worker must never hold
 *    write permission on the record of which replies it is allowed to see — so
 *    the mode is widened for the write and restored immediately. On POSIX the
 *    owner of a 0444 file cannot open it for writing either, so this is not
 *    ceremony: skip the widen and the second dispatch of a run fails.
 * 3. **Truncate in place, then restore 0444 — even when the write throws.**
 *    Never rename; see the module docblock.
 *
 * Step 3's "even when the write throws" is `writeReply`'s refinement rather than
 * `writeTaskPolicy`'s simpler shape, and it is taken deliberately. Between the
 * widen and the narrow the file is 0644 AND already truncated (the default `w`
 * flag is `O_TRUNC`), so an ENOSPC or an EIO in that window leaves a declaration
 * that is empty, writable and permanent — the state the whole module exists to
 * prevent. The restore is a `catch` + rethrow rather than a bare `finally` so
 * that a chmod's ENOENT (the file was never created at all) cannot mask the
 * WRITE's error, which is the actionable one.
 */
export async function writeRepliesPolicy(
  file: string,
  taskId: string | null,
  replies: readonly DeclaredReply[],
): Promise<void> {
  const body = renderRepliesPolicy(taskId, replies);

  /**
   * The widen is skipped only when the file does not exist YET — the very first
   * write, which creates the inode the bind mount will pin. Any other chmod
   * failure is real and propagates: a policy file whose mode could not be
   * restored to 0444 must not be papered over, because the next thing that
   * happens is the worker holding write permission on a policy surface and the
   * verbgate answering that by refusing every gated verb it attempts.
   */
  try {
    await makeWorkerReadable(file, true);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  try {
    await writeFile(file, body);
  } catch (writeErr) {
    await makeWorkerReadable(file, false).catch(() => {});
    throw writeErr;
  }
  await makeWorkerReadable(file, false);
}
