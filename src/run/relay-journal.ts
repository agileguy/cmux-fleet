/**
 * The RELAY JOURNAL — the durable record of which dispatch requests have
 * already been acted on (SRD-REVIEW-CONSOLE §6.5, §6.6).
 *
 * §6.5 lists three homes for the actor and calls the choice BLOCKING. It is
 * settled: `pifleet relay`, a restartable host-side process whose state is
 * derived entirely from the run tree. That answer is what makes this module the
 * load-bearing half of the actor rather than a bookkeeping detail — **if state
 * is derived from the run tree, then idempotency IS the supervision story**, and
 * this file is where idempotency lives. The loop around it is thin on purpose.
 *
 * ## The problem, stated exactly
 *
 * A collator's `dispatch-request.json` stays valid and `ok` on every poll tick.
 * `readDispatchRequest` is a pure reader — it has no memory and correctly has
 * none — so an actor that dispatched on `kind: "ok"` would fan out three
 * reviewers per tick, forever, against the most expensive dispatch this fleet
 * makes (§6.7). Something has to record that a request was already performed.
 *
 * ## Two obvious designs, and the reasons they fail ARE the specification
 *
 * **Delete the file after acting on it.** The request lives at
 * `<run>/outbox/<worker>/<task>/dispatch-request.json`, and `/outbox` is the one
 * directory the WORKER owns and can rewrite (`config/render.ts`, `-v
 * <run-dir>/outbox/<worker>:/outbox`, `rw`). A record kept there is a record the
 * subject of the record can restore, and restoring it is one `write` from inside
 * the container. Deletion is not durable against the party it constrains. It is
 * also not durable against the FILESYSTEM: an unlink that fails leaves the actor
 * with a dispatch it performed and no way to say so.
 *
 * **Remember the task id in memory.** The actor is restartable BY DESIGN — that
 * is the whole of §6.5's answer — so memory dies exactly when the record is most
 * needed, and every restart re-fans-out every outstanding request. An in-memory
 * set would make the process correct only while it never crashes, which is the
 * property §6.5 explicitly declines to assume.
 *
 * So: a HOST-OWNED journal, written where the worker cannot reach it, under the
 * run tree so that it is derived state that `pifleet down` reaps with everything
 * else.
 *
 * ## Where it lives, and why it is invisible to the container
 *
 * `<run>/relay/<sender>/<task-id>.json` — a sibling of `outbox/`, `replies/`,
 * `ledger/`, `audit/` and `inbox/`, and it is named in NO mount. That is the
 * same guarantee `RunPaths.auditDir` has and it holds up the same way, so it is
 * worth restating in that directory's own honest terms: `assertNoRunDirMount`
 * refuses a mount that IS or CONTAINS the run dir, but `classifyRunDirExposure`
 * returns `null` for a source strictly UNDER it — that is what lets the outbox,
 * the reply plane and the worktree be mounted at all. **So the guarantee for
 * this directory is an ABSENCE from the §5.5 mount table, not an enforcement,
 * and an absence has to be re-checked rather than assumed.** It is re-checked
 * against the argv `renderWorker` actually produces, in
 * `test/integration/up-wiring.test.ts`.
 *
 * Sharded by SENDER for `verbgateCollectedPath`'s reason: the journal's whole
 * claim is about custody, and two collators writing through one file would make
 * each one's record depend on the other's volume. One file per request rather
 * than one appended log, because the hot path is a poll asking a single question
 * — "has this been acted on?" — which an `open` answers without parsing anything
 * that another request wrote.
 *
 * ## The key, and why a task id alone is not the whole answer
 *
 * The key is `(sender, task id)`, and the accepted request's DIGEST is recorded
 * inside rather than folded into the key. Both halves of that are deliberate and
 * the second one is the one that looks wrong.
 *
 * The tempting design is to key on `(sender, task id, digest)`, so that "this
 * exact request" is identified by its content. **That design is a dispatch
 * amplifier and it must not be built.** The worker owns the outbox: it can
 * rewrite `dispatch-request.json` under the same task id as many times as it
 * likes, and under a content-bearing key every rewrite is a fresh key, so every
 * rewrite buys three more reviewer dispatches on 397B-class models. The bound on
 * that loop is the collator's own judgement, which is model output — which is
 * word for word the hazard D7 refuses when it forbids a collator to dispatch a
 * collator. Nesting is not the only shape that fan-out takes; this is the other
 * one, and it arrives through the journal rather than through the schema.
 *
 * Keyed on `(sender, task id)`, the fan-out is bounded by the number of task
 * directories the HOST created, which is a number the worker cannot influence.
 *
 * **What the digest is for, then.** It is not the key; it is the only durable
 * statement of WHICH document was acted on. The request file is worker-owned and
 * mutable, so after a fan-out the bytes on disk are a claim about the past that
 * the claimant can edit — an operator reading `dispatch-request.json` to find
 * out what was dispatched is reading a document the collator was free to rewrite
 * afterwards. The journal's digest is what makes that detectable: a request that
 * is journalled but whose content no longer matches is a distinguishable state
 * (`rewritten`), reported loudly, and **not dispatched**. So the digest buys
 * detection without buying amplification, which is the whole trade.
 *
 * ## The digest is over the ACCEPTED VALUE, not over the file's bytes
 *
 * Hashing the bytes would be the obvious thing and it is the wrong thing here,
 * for the reason `dispatch-request.ts` spends its header on: the path is
 * resolved EXACTLY ONCE, by an `open` whose flags are themselves two of the
 * checks, and every question is then asked of the descriptor. `readDispatchRequest`
 * returns the validated VALUE and not the buffer, and a journal that wanted the
 * bytes would have to open the same worker-owned name a second time — which is
 * precisely the check-then-use split that defeated all three of that module's
 * original guards. A second read is not a hash; it is a new attack surface.
 *
 * So the digest is taken over a CANONICAL serialization of the accepted object:
 * keys sorted, no insignificant whitespace. Zod's output order is
 * schema-determined and would be stable enough today, but relying on it would
 * make this digest depend on a library's internals, and the failure would be a
 * whole console's worth of requests reading as `rewritten` after a dependency
 * bump.
 *
 * The cost, stated rather than buried: two files that differ only in formatting
 * hash the same, so a collator that rewrites its request with different
 * whitespace is `done` rather than `rewritten`. That is the correct answer — a
 * reformat is not a different request — but it does mean this digest attests to
 * the REQUEST and not to the file, and a reader who wants byte custody of the
 * file wants `harvest/` rather than this.
 *
 * ## The write happens AFTER the dispatch, and that choice is not free
 *
 * There are exactly two orderings and each loses something:
 *
 * - **Journal BEFORE the dispatch.** A crash in the window loses the work: on
 *   restart the request reads as `done` and the fan-out never happens. Under D5
 *   the collator has ALREADY ended its turn, already reported `success`, and
 *   already named three child ids in its envelope — so the operator following
 *   §6.6's one link finds three task ids that will never exist, and the run looks
 *   exactly like a completed review. There is no symptom, no error, and no tick
 *   on which anything retries.
 * - **Journal AFTER the dispatch.** A crash in the window repeats the work: on
 *   restart the request is unjournalled and the fan-out is issued again.
 *
 * **This module chooses AFTER, and takes the duplicate.** Three reasons, in the
 * order they matter:
 *
 * 1. **The failure it accepts is bounded and visible; the other is unbounded in
 *    consequence and silent.** A duplicate dispatch costs tokens and leaves a
 *    second transcript an operator can see. A lost fan-out costs the review, and
 *    leaves nothing at all — and this codebase's standing position is that the
 *    silent failure is the expensive one (`paths.ts` on a divergent mount:
 *    harvest "would simply find an empty directory and report a task that
 *    produced artifacts as having produced none").
 * 2. **The duplicate is largely absorbed rather than merely tolerated.** §6.6's
 *    child ids are DERIVED from the parent rather than minted, so a repeated
 *    fan-out re-dispatches the SAME child task ids, and the epoch fence answers a
 *    repeat of a completed attempt with `already_completed` rather than with a
 *    second run. That is a property of the fence and is asserted there, not here
 *    — it is the reason the cost is small, not the reason the choice is right.
 * 3. **A supervision story built on restart cannot choose the ordering where
 *    restart destroys work.** §6.5's answer is a process that is EXPECTED to die
 *    and come back. Under BEFORE, every crash permanently deletes a review;
 *    under AFTER, every crash costs at most a repeat. Choosing BEFORE would mean
 *    the supervision story and the durability story disagree.
 *
 * **What AFTER does not cover, said plainly.** The record is durable against a
 * PROCESS crash — a `writeFile` that has returned is visible to the next process
 * on the same host — and is deliberately not fsync'd. Host power loss between the
 * write and the flush re-dispatches, which is the same bounded failure the
 * ordering already accepts, so buying an fsync would spend a syscall to narrow a
 * window whose far side is the outcome we already chose. An fsync here would look
 * more careful and change nothing about the failure mode.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { EXIT, SESSION_ID_RE } from "../contracts.ts";
import { writeJsonAtomic } from "../util/jsonl.ts";
import type { DispatchRequest } from "./dispatch-request.ts";

/** The wire tag, so a reader can refuse a shape it does not know. */
export const RELAY_JOURNAL_SCHEMA = "pifleet.relayjournal/v1";

/**
 * The longest id this module will turn into a path segment.
 *
 * 64, the same number `workerId`, `replyFileName` and `MAX_DISPATCH_ID_CHARS`
 * carry, and for the same reason: these are names that become path SEGMENTS on
 * the host.
 */
export const MAX_JOURNAL_ID_CHARS = 64;

/**
 * The journal file's mode, set EXPLICITLY rather than left to the umask.
 *
 * Not because it holds a secret — it does not — but because it is the only
 * durable statement of what the actor actually did, and a control-plane file's
 * mode should be a decision rather than a property of the shell that happened to
 * start the relay. The umask lesson is fresh and measured: `mkdir` under 022
 * yields 0755 and under 077 yields 0700, so a mode nobody sets is a mode that
 * differs between a laptop and CI while every assertion about it passes on both.
 *
 * 0600 rather than 0644 because nothing but the actor ever reads this. The run
 * directory is not a place other accounts have business in, and `control-auth.json`
 * two levels up is 0600 for a stronger version of the same reason.
 */
const JOURNAL_MODE = 0o600;

/**
 * An id that cannot be a path segment, refused before it becomes one.
 *
 * `EXIT.USAGE` on the grade `DispatchIdError` and `ReplyNameError` both carry,
 * and for their reason: the ids on this path arrive from a request a COLLATOR
 * wrote, so the remedy is the operator's, and reporting it as an internal fault
 * would tell a machine caller that pifleet broke — which an orchestrator answers
 * by retrying the identical input forever (ISC-216's shape).
 */
export class RelayJournalIdError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(
      `${field} ${JSON.stringify(value)} cannot name a path segment — a relay journal entry ` +
        `lives at <run>/relay/<worker>/<task-id>.json, so both ids must be 1-` +
        `${MAX_JOURNAL_ID_CHARS} characters of letters, digits, ".", "_" or "-", beginning and ` +
        `ending alphanumeric`,
    );
    this.name = "RelayJournalIdError";
  }
}

/**
 * The grammar every id here must satisfy BEFORE it is joined into a host path.
 *
 * `SESSION_ID_RE` is imported rather than re-spelled, which is the rule
 * `dispatch-request.ts` states and `replies.ts` follows: a security grammar with
 * four spellings holds until one copy is reasonably improved. The
 * character-class test is root-independent, so it is exact for `.` and `..` —
 * which a containment predicate answers "no, it did not escape" for, because the
 * resolved path IS the directory.
 */
function spellableId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_JOURNAL_ID_CHARS && SESSION_ID_RE.test(value);
}

/**
 * `<run>/relay` — the journal root, named in no mount.
 *
 * **This belongs in `paths.ts` beside `workerOutboxDir` and `workerRepliesDir`,
 * and should move there when the actor lands.** It is here today only because
 * `paths.ts` is being edited concurrently on the sibling branch; the module
 * boundary, not the placement, is what matters. `dispatchRequestPath` carries
 * the identical note for the identical reason.
 *
 * Takes the run ROOT as a string, for the reason `workerOutboxDir` does: the
 * relay works from a run dir it is handed, and requiring the full `RunPaths`
 * struct would keep a duplicate alive purely as a type accommodation.
 */
export function relayJournalDir(runRoot: string): string {
  return join(runRoot, "relay");
}

/** `<run>/relay/<sender>` — one shard per collator. */
export function relayJournalSenderDir(runRoot: string, sender: string): string {
  if (!spellableId(sender)) throw new RelayJournalIdError("worker id", sender);
  return join(relayJournalDir(runRoot), sender);
}

/**
 * `<run>/relay/<sender>/<task-id>.json`.
 *
 * **It THROWS on an id it cannot spell, and a bare `join` is why it has to.**
 * `join` is not a containment predicate — it is string arithmetic that resolves
 * `..` cheerfully — so an unchecked task id here writes a file of the caller's
 * choosing into the run directory, which is where `control-auth.json` lives.
 * `dispatchRequestPath` records the same measurement on the reading half of this
 * exchange, and the refusal belongs in the builder rather than in each caller's
 * memory of it, including callers that do not exist yet.
 *
 * `classifyRequest` and `recordDispatch` never reach the throw, because they
 * hold the same ids to the same grammar first and answer with a VALUE — the
 * contract that a poll does not throw is untouched.
 */
export function relayJournalPath(runRoot: string, sender: string, taskId: string): string {
  const dir = relayJournalSenderDir(runRoot, sender);
  if (!spellableId(taskId)) throw new RelayJournalIdError("task id", taskId);
  return join(dir, `${taskId}.json`);
}

/** One journalled fan-out. */
export interface RelayJournalEntry {
  schema: typeof RELAY_JOURNAL_SCHEMA;
  /** The worker whose outbox held the request. Structural identity, never a claim. */
  sender: string;
  /** The task directory the request sat in. */
  parent_task_id: string;
  /** `requestDigest` of the ACCEPTED request — see the module docblock. */
  request_sha256: string;
  /**
   * The child task ids the fan-out issued.
   *
   * Recorded because D5's entire mitigation is that the chain is legible from
   * the run tree: the collator's own envelope names these ids, and this is the
   * host's independent copy of the same list — written by the thing that
   * actually performed the dispatches rather than by the model that asked for
   * them. An operator reconciling "what did `T` cause?" has two sources that
   * were produced by different parties, which is the only way that question gets
   * a trustworthy answer.
   */
  children: readonly string[];
  /** When the fan-out was recorded, ISO-8601. */
  dispatched_at: string;
}

/**
 * The digest of an accepted request — canonical, and over the VALUE.
 *
 * See the module docblock for why this is not a hash of the file's bytes. The
 * canonicalization is a recursive key sort with no insignificant whitespace, so
 * the digest depends on the request's CONTENT and on nothing about how zod, or
 * the collator, chose to order it.
 *
 * `undefined`-valued keys are dropped by `JSON.stringify` in both the sorted and
 * unsorted forms, which is the behaviour wanted here: the schema's D11 refusals
 * are `.optional()` `z.never()`, so an absent forbidden field and a field that
 * was never there are the same request and must digest the same.
 */
export function requestDigest(request: DispatchRequest): string {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}

/** Recursive key-sorted JSON with no whitespace. Arrays keep their order — it is data. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * What the journal says about a request the actor is holding.
 *
 * Shaped like `DispatchRequestRead` and for its reasons: the code is the
 * assertion surface and the prose is the explanation, so a caller — or a test —
 * never has to tell two outcomes apart by matching substrings of English.
 *
 * **Three of the four arms do not dispatch, and only one of those is an error.**
 * That asymmetry is the module's whole behaviour and is worth reading off the
 * type: `done` is the normal state on almost every tick and must be silent,
 * while `rewritten` and `unreadable` happened once and someone needs to know.
 */
export type RelayJournalVerdict =
  /** Never acted on. The caller may fan out. */
  | { kind: "fresh" }
  /** This request was acted on, and the content still matches. Skip, silently. */
  | { kind: "done"; entry: RelayJournalEntry }
  /**
   * Acted on, but the request file's content has CHANGED since.
   *
   * Refused rather than re-dispatched — see the module docblock on why a
   * content-bearing key is a dispatch amplifier. This is the arm that turns a
   * worker rewriting its own record from an invisible event into a reported one.
   */
  | { kind: "rewritten"; entry: RelayJournalEntry; digest: string }
  /**
   * The journal exists and could not be trusted.
   *
   * **Fails CLOSED: the caller must not dispatch.** A journal that cannot be
   * read might say `done`, and treating unreadable as fresh would convert a
   * transient filesystem error into a fan-out repeated on every tick for as long
   * as the error lasts — the unbounded outcome, reached by the failure path
   * rather than by the design. A corrupt entry blocks exactly one task until an
   * operator removes one file, which is bounded, loud, and fixable in one move.
   */
  | { kind: "unreadable"; reason: string };

/**
 * Read one journal entry, or say why not. **Never throws** on the entry — the
 * caller is a polling loop and a half-written file is a state it must survive
 * rather than die on.
 *
 * A missing file is `null` and is the overwhelmingly common answer; it is not an
 * error and must not be logged as one, for `DispatchRequestRead`'s reason: an
 * actor that shouted about every unjournalled task would bury the one line that
 * means something.
 */
export async function readJournalEntry(
  runRoot: string,
  sender: string,
  taskId: string,
): Promise<{ kind: "missing" } | { kind: "ok"; entry: RelayJournalEntry } | { kind: "unreadable"; reason: string }> {
  let file: string;
  try {
    file = relayJournalPath(runRoot, sender, taskId);
  } catch (err) {
    return { kind: "unreadable", reason: String(err) };
  }

  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: `${file} could not be read: ${String(err)}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    return { kind: "unreadable", reason: `${file} is not valid JSON: ${String(err)}` };
  }

  /**
   * Validated by hand rather than by zod, and the list is short because the
   * writer is this module.
   *
   * The three fields checked are the three the caller ACTS on: the schema tag
   * (so a future format cannot be read as this one), and the two identity fields
   * that must agree with the location — because a journal entry that names a
   * different task is either a bug in the writer or a file someone moved, and in
   * both cases believing it would skip a dispatch that was never performed. The
   * digest is checked for TYPE here and compared by the caller.
   */
  const entry = raw as Partial<RelayJournalEntry>;
  if (entry === null || typeof entry !== "object") {
    return { kind: "unreadable", reason: `${file} does not hold an object` };
  }
  if (entry.schema !== RELAY_JOURNAL_SCHEMA) {
    return {
      kind: "unreadable",
      reason: `${file} is not a ${RELAY_JOURNAL_SCHEMA} document (schema: ${JSON.stringify(entry.schema)})`,
    };
  }
  if (entry.sender !== sender || entry.parent_task_id !== taskId) {
    return {
      kind: "unreadable",
      reason:
        `${file} records sender ${JSON.stringify(entry.sender)} / task ` +
        `${JSON.stringify(entry.parent_task_id)}, but sits at the path for ${sender} / ${taskId}. ` +
        `The PATH is the authority because the host built it; an entry that disagrees with its ` +
        `own location cannot be used to skip a dispatch, because it is not about this request.`,
    };
  }
  if (typeof entry.request_sha256 !== "string" || entry.request_sha256 === "") {
    return { kind: "unreadable", reason: `${file} carries no request_sha256` };
  }
  return { kind: "ok", entry: entry as RelayJournalEntry };
}

/**
 * The one question the poll asks: may this request be fanned out?
 *
 * Takes the ACCEPTED request rather than the bytes, so the digest is computed
 * from the value that passed `readDispatchRequest` and nothing re-opens a
 * worker-owned path. See the module docblock.
 */
export async function classifyRequest(
  runRoot: string,
  sender: string,
  taskId: string,
  request: DispatchRequest,
): Promise<RelayJournalVerdict> {
  const read = await readJournalEntry(runRoot, sender, taskId);
  if (read.kind === "missing") return { kind: "fresh" };
  if (read.kind === "unreadable") return { kind: "unreadable", reason: read.reason };

  const digest = requestDigest(request);
  if (read.entry.request_sha256 === digest) return { kind: "done", entry: read.entry };
  return { kind: "rewritten", entry: read.entry, digest };
}

/**
 * Record a fan-out that has ALREADY been performed.
 *
 * The name is imperative about the ordering because the ordering is the
 * durability decision: this is called AFTER `controlCall` has returned for every
 * child, never before. The module docblock argues the choice at length; what
 * matters at the call site is that a caller who moves this line earlier has
 * chosen the silent failure without noticing they chose anything.
 *
 * The mode is set on a SEPARATE `chmod` rather than through `writeFile`'s
 * `mode` option, and the difference is real: that option is masked by the
 * process umask and applies only when the file is CREATED, so a re-recorded
 * entry would silently keep whatever mode the first write happened to get.
 *
 * Returns the path written, so a caller that has to log or correlate does not
 * re-derive it.
 */
export async function recordDispatch(
  runRoot: string,
  sender: string,
  taskId: string,
  request: DispatchRequest,
  children: readonly string[],
  now: Date = new Date(),
): Promise<string> {
  const file = relayJournalPath(runRoot, sender, taskId);
  const entry: RelayJournalEntry = {
    schema: RELAY_JOURNAL_SCHEMA,
    sender,
    parent_task_id: taskId,
    request_sha256: requestDigest(request),
    children: [...children],
    dispatched_at: now.toISOString(),
  };
  await mkdir(relayJournalSenderDir(runRoot, sender), { recursive: true });
  /**
   * ATOMIC, because a TORN JOURNAL FAILS CLOSED.
   *
   * This was a bare `writeFile`. A crash or a full disk partway through leaves
   * a truncated entry, and this journal is read by a reader that refuses on
   * anything it cannot parse — so a half-written file does not degrade the
   * console, it BLOCKS the collator until a person deletes the file by hand.
   * The cost of the failure is therefore paid by the operator, not by the pass.
   *
   * `writeJsonAtomic` renders the identical bytes and lands them by
   * `rename(2)` from a temp file in the SAME directory, so a reader sees either
   * the previous entry or the whole new one and never a prefix of it.
   *
   * **Rename is safe HERE and is forbidden on the reply plane**, which is the
   * distinction worth stating beside the call: `replies/` is bind-mounted and a
   * rename swaps the inode the mount pinned, which is why `replies.ts` writes
   * in place. The journal is host-side state under `relay/` and is mounted into
   * nothing, so it has no inode anyone is holding.
   */
  await writeJsonAtomic(file, entry);
  await chmod(file, JOURNAL_MODE);
  return file;
}
