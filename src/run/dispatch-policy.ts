/**
 * The task drop — a brief delivered as a FILE, for a worker with no wire.
 *
 * `dispatch` has two delivery routes and both need something the adopted
 * terminal does not have. The RPC route needs a client to Pi; the pane route
 * needs a pty pifleet owns. A worker started with `up --attach-here` has
 * neither: the terminal belongs to the person sitting at it, and typing into it
 * would put a brief into whatever they happen to have focused
 * (SRD-TUI-DISPATCH §4.3). So the third route does not deliver at all — it
 * STAGES, by writing the brief where the worker can read it and letting the
 * person press the key.
 *
 * `/policy/dispatch` is that file: a sibling of `/policy/task`, mounted `:ro`
 * at 0444 by the same rule and rewritten by the same in-place recipe. D4
 * records why it is a sibling and not either of the two cheaper shapes:
 *
 * 1. **Not a third line in `/policy/task`.** That file is parsed by POSIX `sh`
 *    with `sed -n 1p`/`sed -n 2p` (`docker/verbgate:57-60`), and
 *    `task-policy.ts` records that the two-line shape is chosen BECAUSE of that
 *    parser. A prompt is multi-line by nature, so appending one would be inert
 *    today and a hazard the first time anything there grows a loop.
 * 2. **Not a directory the worker lists.** That hands the worker a listing to
 *    enumerate and re-introduces the discoverability the outbox contract
 *    deliberately denies (`harvest/layout.ts`: *"this module never descends,
 *    never opens, never stats a leaf"* — the same posture applies in the other
 *    direction).
 *
 * ## What being a sibling buys, and what it therefore obliges
 *
 * Three properties come for free and are the entire argument for the shape:
 * the verbgate's integrity loop already iterates the policy files and exits 78
 * if any is writable, so the loop gains one path rather than a new mechanism;
 * the chmod → truncate-in-place → chmod recipe already exists and is the one a
 * bind mount requires; and the file lands beside `taskPolicy` in the worker's
 * own directory, so `assertNoRunDirMount` stays satisfied.
 *
 * The obligation is the mirror of that: every constraint `task-policy.ts`
 * documents applies here unchanged, and the moment this module stops inheriting
 * one of them is the moment `/policy/dispatch` stops being covered by the
 * argument that covers `/policy/task`.
 *
 * ## The rewrite recipe is load-bearing, for the same reason it is there
 *
 * A bind mount pins the INODE. Tmp-file + rename — which is what nearly all
 * "atomic write" advice recommends, and which looks MORE careful than the code
 * below — swaps the file the HOST sees while the container keeps reading the
 * old one for the life of the container, with both sides believing a new task
 * was staged. Every write here is therefore chmod 0644 → truncate in place →
 * chmod 0444, never rename. `writeFile` with the default `w` flag truncates an
 * existing file rather than replacing it, so the inode survives;
 * `test/unit/dispatch-policy.test.ts` asserts that directly rather than
 * trusting the flag.
 *
 * ## What this module does NOT do: sanitize the prompt
 *
 * `renderTaskPolicy` strips control characters because a task id carrying a
 * newline would shift the epoch onto line 3 and hand `sed` an empty field — a
 * formatting break no care at the reading end can distinguish from a real
 * value. Nothing of the sort applies to the prompt half here. Nothing parses
 * it; it is read by a human or by a model, and the criterion it is held to is
 * that it is BYTE-IDENTICAL to what the RPC route would render for the same
 * envelope (SRD-TUI-DISPATCH §10, "Staging"). Sanitizing would break exactly
 * that, and would do it silently, in the direction of a worker being briefed on
 * a document subtly unlike the one the ledger says it got.
 *
 * The identity half is a different case and is handled by construction rather
 * than by stripping — see `renderDispatchPolicy`.
 */
import { writeFile } from "node:fs/promises";

import { EXIT } from "../contracts.ts";
import { makeWorkerReadable } from "../container/mounts.ts";
import { TASK_POLICY_NONE } from "./task-policy.ts";

/** Where the run-tree file lands inside the worker container. */
export const DISPATCH_POLICY_MOUNT = "/policy/dispatch";

/**
 * The line that fences the machine-readable half off from the prompt.
 *
 * A CONSTANT and exported, because two readers have to agree on it and neither
 * of them is this module: `splitDispatchPolicy` below, and the worker, which
 * reads the file with whatever it has to hand. A separator spelled once in
 * source and once in a skill document is two spellings that drift.
 *
 * The text is deliberately prose-shaped rather than a random sentinel. A worker
 * that opens this file with no instructions at all should be able to see where
 * the header stops without being told, because the failure this whole route
 * exists to remove is a brief that is delivered and half-understood.
 */
export const DISPATCH_POLICY_SEPARATOR = "--- pifleet dispatch prompt ---";

/** The wire tag on the header line, so a reader can refuse a shape it does not know. */
export const DISPATCH_POLICY_SCHEMA = "pifleet.dispatch/v1";

/**
 * Hard byte cap on the drop, enforced at STAGE time — SRD-TUI-DISPATCH Q6.
 *
 * `harvest/outbox.ts`'s `MAX_ENVELOPE_BYTES` guards the other end of this
 * exchange, and Q6 asks for a sibling here. The number is not the same one, and
 * the asymmetry is the answer rather than an oversight.
 *
 * **Why refuse at the writing end.** Q6 says so, and the reason is that this
 * end is the only one that CAN. The drop is read inside a container by `cat`,
 * or by a model with a context window; neither has a way to refuse politely,
 * and a shell that discovers a 40 MB file has already read it. The host knows
 * the size before the first byte is written, so the refusal costs nothing and
 * lands where an operator can act on it.
 *
 * **Why 256 KiB.** Three anchors, in the order they bind:
 *
 * 1. **Above everything the envelope schema admits in the fields the prompt is
 *    built from.** `TaskEnvelopeSchema.title` and `.brief` are `MAX_TEXT`
 *    (65,536) each, so a maximal legal pair is 128 KiB. The cap is twice that,
 *    which leaves the identity header and an acceptance list room and means a
 *    task that VALIDATES is a task that stages. A cap that refused a
 *    schema-legal envelope would read as a bug and would be argued away.
 * 2. **Below what the reader can finish.** A drop is not delivered in pieces —
 *    it enters the worker's context in one gulp, alongside the mounted
 *    `SKILL.md`, the role briefing and whatever transcript already exists. A
 *    200K-token window holds on the order of 700 KB of English prose in total,
 *    so a drop approaching that is one the reader silently TRUNCATES. A brief
 *    that is delivered and partially read produces a worker that confidently
 *    does the first half of a task and reports success, which is the exact
 *    class of invisible failure the policy-file surface exists to remove.
 * 3. **Sixteen times below `MAX_ENVELOPE_BYTES`, deliberately.** That cap (4
 *    MiB) protects a reader from BUFFERING a hostile document written by the
 *    subject being graded — the failure is an OOM. This one protects a worker
 *    from being briefed on a document it cannot finish — the failure is a
 *    misunderstanding. Unreadable starts far lower than unbufferable, so the
 *    tighter cap belongs on the tighter hazard.
 *
 * **What it deliberately refuses.** `acceptance[]` is bounded at
 * `MAX_ITEMS × MAX_TEXT` = 64 MiB, which is not a bound anyone intends — it is
 * two independent limits multiplying. A drop that reaches it is a caller bug,
 * and the refusal names the measured size precisely so the operator can tell
 * that case from a long brief.
 */
export const MAX_DISPATCH_POLICY_BYTES = 256 * 1024;

/**
 * The identity the drop carries beside the prompt.
 *
 * A STRUCTURAL type rather than `TaskEnvelope`, for `renderPrompt`'s own
 * reason: a full envelope satisfies it by subtyping, and the drop then cannot
 * accidentally grow a dependency on a field the route does not have. It is also
 * the reason the header is an identity rather than the whole envelope — the
 * envelope's `title`, `brief` and `acceptance` are already IN the prompt half,
 * and a second copy in the header would be two spellings of the brief that can
 * disagree, in a file whose only job is to be the one the worker read.
 *
 * The four fields `renderPrompt` already puts in its `## This task` block are
 * repeated here on purpose: that block is what the model reads and this line is
 * what a script reads, and a reader of one should not have to parse the other.
 * `run_id`, `attempt` and `dispatched_at` appear only here, because the prompt
 * has no use for them and a correlation tool has nothing else to key on.
 */
export interface DispatchIdentity {
  task_id: string;
  run_id: string;
  worker: string;
  epoch: number;
  attempt: number;
  outbox: string;
  dispatched_at: string;
}

/** The header line, parsed back. `staged: false` is the idle arm. */
export type DispatchHeader =
  | ({ schema: string; staged: true } & DispatchIdentity)
  | { schema: string; staged: false };

/**
 * A brief too large to stage, refused before anything is written.
 *
 * `EXIT.USAGE` and not `EXIT.INTERNAL`: the size comes from the operator's task
 * file, and the remedy is theirs — shorten the brief, or move the bulk of it
 * into the repo where the worker can read it as an input. Reporting this as an
 * internal fault would tell a machine caller that pifleet broke, and an
 * orchestrator answers that by retrying the identical document forever
 * (ISC-216's shape).
 */
export class DispatchPolicyTooLargeError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(
    readonly taskId: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `the staged brief for task "${taskId}" renders to ${bytes} bytes and the drop file is ` +
        `capped at ${limit}; a brief this size is truncated by the reader rather than refused ` +
        `by it, so it is refused here instead — shorten it, or move the bulk into the repo and ` +
        `name it as a task input`,
    );
    this.name = "DispatchPolicyTooLargeError";
  }
}

/**
 * Render the drop: one JSON header line, the separator, then the prompt VERBATIM.
 *
 * **The header is one line by construction, and that is what makes the split
 * safe.** `JSON.stringify` escapes every newline inside a string value, so no
 * operator-supplied field — a task id, an outbox path, a timestamp — can put a
 * second line into the header. The separator is therefore always line 2, which
 * means the FIRST occurrence of a separator LINE in the file is always the real
 * one, and a prompt that quotes the separator (a brief excerpting the SRD
 * section that describes this file is the obvious case) cannot forge a split.
 * The alternative — searching for the LAST occurrence, or sanitizing the prompt
 * — would put the guarantee in the reader, where it depends on getting a search
 * right, instead of in the writer, where it depends on a property JSON already
 * has.
 *
 * Key order is fixed by the object literal so the rendered bytes are
 * deterministic for a given identity. Nothing today compares two renders, and
 * making that possible costs a sentence.
 *
 * `identity === null` is the idle arm — the spelling of "nothing is staged",
 * written by `materialize.ts` before the first dispatch so the bind mount has
 * an inode to pin. The prompt half then reads as the same `<none>` the verbgate
 * falls back to and `/policy/task` writes when idle, imported rather than
 * retyped: one spelling of "nothing" across the whole policy surface means an
 * idle worker and a missing mount cannot be told apart, which is the point.
 * The `staged` field, not the prose, is the discriminator a script keys on — a
 * brief can imitate the prose and cannot imitate the header.
 */
export function renderDispatchPolicy(identity: DispatchIdentity | null, prompt: string): string {
  const header: DispatchHeader =
    identity === null
      ? { schema: DISPATCH_POLICY_SCHEMA, staged: false }
      : {
          schema: DISPATCH_POLICY_SCHEMA,
          staged: true,
          task_id: identity.task_id,
          run_id: identity.run_id,
          worker: identity.worker,
          epoch: identity.epoch,
          attempt: identity.attempt,
          outbox: identity.outbox,
          dispatched_at: identity.dispatched_at,
        };
  const body = identity === null ? `${TASK_POLICY_NONE}\n` : prompt;
  return `${JSON.stringify(header)}\n${DISPATCH_POLICY_SEPARATOR}\n${body}`;
}

/**
 * Recover both halves, exactly.
 *
 * The inverse of `renderDispatchPolicy` and the only supported way to read the
 * file in TypeScript — a caller that splits on the separator itself would have
 * to re-derive the first-occurrence rule above, which is the kind of duplicated
 * invariant that holds until someone reasonably decides `lastIndexOf` is more
 * robust.
 *
 * A body with no separator line THROWS rather than degrading to an empty
 * prompt. A truncated or hand-edited drop is not "a task with an empty brief" —
 * that is a task a worker would attempt.
 */
export function splitDispatchPolicy(body: string): {
  identity: DispatchHeader;
  prompt: string;
} {
  const fence = `\n${DISPATCH_POLICY_SEPARATOR}\n`;
  const at = body.indexOf(fence);
  if (at === -1) {
    throw new Error(
      `the dispatch drop carries no "${DISPATCH_POLICY_SEPARATOR}" line, so its header and its ` +
        `prompt cannot be told apart; the file is truncated or was not written by pifleet`,
    );
  }
  return {
    identity: JSON.parse(body.slice(0, at)) as DispatchHeader,
    prompt: body.slice(at + fence.length),
  };
}

/**
 * Rewrite the drop IN PLACE, preserving the inode the container's bind mount is
 * pinned to.
 *
 * The order of the three steps is the whole contract:
 *
 * 1. **Render and measure FIRST, before the file is touched at all.** A writer
 *    that widened, wrote, and then discovered the size would leave a partial
 *    brief behind at 0644 — a drop the worker can both misread and rewrite, and
 *    one the verbgate answers by refusing every verb. Refusing before the first
 *    chmod is what makes "the file is unmodified when the cap trips" true
 *    rather than approximately true.
 * 2. **Widen.** The file is 0444 between writes — the worker must never hold
 *    write permission on the brief it is being graded against — so the mode is
 *    widened for the write and restored immediately. On POSIX the owner of a
 *    0444 file cannot open it for writing either, so this is not ceremony: skip
 *    it and the second stage of a run fails.
 * 3. **Truncate in place, then restore 0444.** Never rename; see the module
 *    docblock.
 */
export async function writeDispatchPolicy(
  file: string,
  identity: DispatchIdentity | null,
  prompt: string,
): Promise<void> {
  const body = renderDispatchPolicy(identity, prompt);
  /**
   * BYTES, not `.length`. The file is bytes and the cap is about bytes: "…" is
   * one JavaScript character and three of them in UTF-8, so a cap checked
   * against the string length admits a CJK or emoji-heavy brief at three times
   * the size it believes it is measuring.
   */
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_DISPATCH_POLICY_BYTES) {
    throw new DispatchPolicyTooLargeError(
      identity?.task_id ?? TASK_POLICY_NONE,
      bytes,
      MAX_DISPATCH_POLICY_BYTES,
    );
  }

  /**
   * The widen is skipped only when the file does not exist YET — the very first
   * write, which creates the inode the bind mount will pin. Any other chmod
   * failure is real and propagates: a policy file whose mode could not be
   * restored to 0444 must not be papered over, because the next thing that
   * happens is the worker holding write permission on its own brief and the
   * gate refusing every verb it attempts.
   */
  try {
    await makeWorkerReadable(file, true);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await writeFile(file, body);
  await makeWorkerReadable(file, false);
}

/**
 * Establish the drop with nothing staged.
 *
 * Called by `materialize.ts` before `docker run` — the bind-mount source must
 * exist first, or Docker creates a DIRECTORY at the host path and the drop can
 * never have content — and again whenever a staged task settles, so an idle
 * worker's drop does not still name the last brief it was given. That second
 * use is `writeTaskPolicy(…, null, 0)`'s at settle, for the same reason: a
 * stale policy file reads as authoritative and is wrong, which is worse than
 * one that admits it has nothing.
 */
export async function clearDispatchPolicy(file: string): Promise<void> {
  await writeDispatchPolicy(file, null, "");
}
