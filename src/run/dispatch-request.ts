/**
 * The request plane — a collator's intent, travelling as DATA (SRD-REVIEW-CONSOLE §6.4, D1, D7, D11).
 *
 * The review console needs one thing no other console needs: a worker that can
 * cause work to happen. `col-1` decides what is to be reviewed and three
 * reviewers do the reading, and something has to carry the first decision to
 * the second. D1 settles what that something is NOT — no control socket, no
 * broker socket, no inbound channel of any kind into a worker container —
 * because §4.3's argument is that a granted socket is a prompt-injection
 * channel with a fleet-issued identity, and a review console is the one console
 * whose entire job is reading repositories it did not write.
 *
 * So the intent travels as a FILE the worker writes into a directory it already
 * owns, and this module is the only thing that turns those bytes into something
 * a host process will act on. Everything here is written from the position that
 * the file is hostile, because the cheapest way for it to become hostile is for
 * a reviewer to read a source comment that tells it to write one.
 *
 * ## Why the outbox and not a new mount
 *
 * §6.4 names three properties that come free, and they are the whole argument:
 * the mount already exists and is already writable by exactly this worker
 * (`config/render.ts`, `-v <run-dir>/outbox/<worker>:/outbox`), so there is no
 * new `assertNoRunDirMount` exposure; a host-side reader already polls that
 * subtree on an interval (`VerbgateCollector`), so this is the house pattern
 * with a second path rather than a new mechanism; and the directory is ALREADY
 * the untrusted-content boundary — `harvest/outbox.ts` and `Docs/SRD.md` §12.5,
 * *"The result envelope is untrusted input"* — so the request inherits that
 * posture instead of inventing one.
 *
 * The inheritance is not a figure of speech. `readDispatchRequest` performs the
 * same three steps in the same order as `readOutboxEnvelope`, for the same
 * reasons, and the moment it stops doing so is the moment this file stops being
 * covered by the argument that covers `result.json`.
 *
 * ## The sender is the DIRECTORY, and that is the load-bearing idea
 *
 * There is no `sender` field in this schema and there must never be one. A
 * container can only write its own outbox, so the path a request is found at is
 * an identity the author cannot forge — which is a stronger guarantee than any
 * field could carry, and it is free. `DispatchRequestLocation.sender` is
 * therefore both the directory that is read and the identity that is checked:
 * one value, used twice, so the two cannot disagree. A design that read
 * `<run>/outbox/*` and trusted a `sender` field inside would be the same design
 * with the guarantee deleted.
 *
 * ## What this module refuses, and why the list is short
 *
 * Five semantic rules, and every one of them exists because the alternative is
 * a capability nobody granted:
 *
 * 1. **A target outside the console's reviewers** — the request reaching into
 *    the engineering fleet. `eng-1` is a real worker with a real socket, so
 *    nothing downstream refuses it; the dispatch simply succeeds somewhere the
 *    operator is not looking.
 * 2. **A target that is a collator** — D7, both arms. Nesting is an unbounded
 *    fan-out whose only bound is model judgement; self-dispatch is the same
 *    loop with one participant.
 * 3. **A field that names a host-side or config-side fact** — D11. `model`,
 *    `tools`, `deadline`, `acceptance`, and anything else the schema has not
 *    heard of.
 * 4. **A sender whose role is not `collator`** — §6.10, and the absence of it
 *    is how "any worker can dispatch" arrives by accident.
 * 5. **The same reviewer twice** — §6.9's second argument. The consensus
 *    arithmetic counts independent readers, and two reports from one model are
 *    one reader with two transcripts.
 *
 * **Any of them refuses the WHOLE FILE.** §6.4 is explicit and the reason is
 * not tidiness: a validator that dropped the offending entry would turn a
 * request for three independent reviews into a request for two, and under D5
 * the collator has already ended its turn and will never learn the difference.
 * `DispatchRequestRead` has no arm that can carry a subset, which is what makes
 * partial acceptance unrepresentable rather than merely unimplemented.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not dispatch, and it does not know how. §6.5 — where the actor lives
 * — is BLOCKING and unanswered, and the mechanism is settled independently of
 * it. Keeping the schema and its refusals in a module with no I/O beyond one
 * read means the answer to Q4 changes where this is CALLED and changes nothing
 * about what it decides.
 *
 * It does not sanitize `title` or `brief`. They become the child task's title
 * and brief and are staged verbatim into `/policy/dispatch`, whose own contract
 * is byte-identity with the RPC route (`dispatch-policy.ts`). Stripping here
 * would break exactly that, silently, in the direction of a reviewer being
 * briefed on a document subtly unlike the one the collator wrote.
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { MAX_SHORT, MAX_TEXT, workerId } from "../contracts.ts";
import { workerOutboxDir } from "./paths.ts";

/** The wire tag, so a reader can refuse a shape it does not know. */
export const DISPATCH_REQUEST_SCHEMA = "pifleet.dispatchrequest/v1";

/**
 * The file's name inside `<outbox>/<task-id>/`.
 *
 * A CONSTANT because two ends have to agree on it and only one of them is
 * TypeScript: the collator writes this name from a skill document, and the
 * actor polls for it from here. A name spelled once in source and once in prose
 * is two spellings that drift, and the failure mode is the silent one — the
 * actor finds nothing and a collator that dispatched three reviews looks like a
 * collator that dispatched none.
 */
export const DISPATCH_REQUEST_FILE = "dispatch-request.json";

/**
 * Entries in `requests[]` before the array is refused on shape alone.
 *
 * This is NOT the operative bound and is not trying to be. The roster checks
 * below already cap an ACCEPTED file at the number of reviewers in the console
 * — every entry must name a distinct member of a fixed three-element set — so
 * eight exists only to bound the loop before the roster is consulted, and it
 * sits above the console's three so that adding a reviewer stays a config edit
 * rather than a code edit.
 *
 * `MAX_ITEMS` (1,000) was the obvious alternative and is refused for the reason
 * `MAX_DISPATCH_POLICY_BYTES` names about `acceptance[]`: a bound of
 * `MAX_ITEMS x MAX_TEXT` is not a bound anyone intends, it is two independent
 * limits multiplying. Here it would also break the one property that makes the
 * byte cap below defensible — that a document which VALIDATES is a document
 * that reads.
 */
export const MAX_DISPATCH_REQUEST_ITEMS = 8;

/**
 * Hard byte cap, enforced from `lstat` BEFORE the read.
 *
 * **Deliberately the same number as `harvest/outbox.ts`'s `MAX_ENVELOPE_BYTES`
 * (4 MiB), and the sameness is the argument.** Both files arrive in the same
 * directory, from the same author, under the same untrusted-input posture, and
 * guard against the same failure: buffering a hostile document written by a
 * container into the one host process the console depends on. Two caps on two
 * files in one directory that differ by a factor nobody can explain is a
 * maintenance hazard, and there is no fact here that argues for a different
 * number.
 *
 * **Why it is not the tighter `MAX_DISPATCH_POLICY_BYTES` (256 KiB).** That cap
 * has an anchor this one does not: the drop is read by a MODEL with a context
 * window, and a brief it silently truncates produces a worker that confidently
 * does half a task. The reader of THIS file is the host. The model-facing bound
 * is still enforced, but at the right place and on the right field — `brief` is
 * capped at `MAX_TEXT` (64 KiB), comfortably inside what the drop can stage, so
 * a request that validates here always stages there.
 *
 * The two bounds compose to something worth stating: `MAX_DISPATCH_REQUEST_ITEMS
 * x 2 x MAX_TEXT` is 1 MiB of legal text, so the byte cap sits above any
 * schema-legal document even before JSON escaping, and a cap that refused a
 * schema-legal file would read as a bug and be argued away.
 */
export const MAX_DISPATCH_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Who this console may dispatch TO, and who may ask.
 *
 * **A parameter rather than a module constant, and D7 is why.** The shipping
 * console has one collator, so under it "a collator may not dispatch to a
 * collator" and "a collator may not dispatch to itself" are the same sentence
 * about the same id. A rule written against the literal `col-1` would look
 * correct today and lapse silently the moment a second collator is added — a
 * config edit, made by someone with no reason to open this file. Written over a
 * roster, the rule is about roles, and the nesting arm is reachable in a test
 * before it is reachable in production.
 *
 * Both halves are needed and neither implies the other. `collators` answers "may
 * this worker ask?" and "is this target forbidden by D7?"; `reviewers` answers
 * "is this target inside the console?". A single "known workers" list would
 * collapse them and give a collator the right to dispatch a collator.
 */
export interface ConsoleRoster {
  /** Workers whose role is `collator`: the only senders, and never targets. */
  collators: readonly string[];
  /** Workers whose role is `reviewer`: the only permitted targets. */
  reviewers: readonly string[];
}

/**
 * The `review` console as it actually ships.
 *
 * The ids are `DEFAULT_REVIEW_WORKERS` split by role, and `dispatch-request.test.ts`
 * pins the two together as SETS rather than re-deriving one from the other.
 * Derivation was the alternative — `DEFAULT_REVIEW_WORKERS.slice(1)` is correct
 * today, because pane 1 is the collator's seat — but it makes a role boundary
 * depend on a LAYOUT contract, and the day someone reorders the panes the
 * console keeps starting four healthy workers and refuses every dispatch.
 * Spelling both halves and testing the union is the version whose failure is a
 * red test rather than a working console that does nothing.
 */
export const REVIEW_CONSOLE_ROSTER: ConsoleRoster = {
  collators: ["col-1"],
  reviewers: ["rev-arch-1", "rev-ctx-1", "rev-lang-1"],
};

/**
 * Refused, and declared here rather than left to `.strict()` so the refusal can
 * say why — `config/schema.ts:833-845` made this trade first and for this
 * reason. `.strict()` alone answers with "unrecognized key", which is the same
 * sentence a typo gets and teaches an operator nothing about a field that
 * exists, is spelled correctly, and is deliberately not available here.
 *
 * `.optional()` is what makes the key ABSENT legal; present with any value at
 * all, `z.never()` fails and the custom text is what the operator reads.
 */
const notReachable = (message: string) => z.never({ error: message }).optional();

/**
 * One request: a worker, a title, a brief. **Nothing else** — §6.4.
 *
 * The four named refusals below are D11 in the schema rather than in prose.
 * Each is a decision that was made before the fleet existed, by a gate that
 * cannot re-run:
 *
 * - `model` is checked against `models_allowlist` at `up`, so a request naming
 *   one would name a model no gate has seen. §6.9's first argument is that this
 *   is not even a useful capability — the aspect determines the model and the
 *   model was fixed an hour earlier, so "assigning" one at dispatch time is a
 *   choice with no effect, which is worse than no choice.
 * - `tools` is §12.1's whole surface. The reviewer's `[read, grep, find, ls]`
 *   is what makes three hosted vendors on a private repository tolerable, and
 *   §7.1 lists it under what this design leaves UNCHANGED.
 * - `deadline` / `deadline_s` is §6.7's budget. Both spellings are named
 *   because refusing one and ignoring the other is worse than refusing
 *   neither: the author sees their field accepted and believes it took effect.
 * - `acceptance` is D8's line. A review is graded on structural completeness
 *   and "must not be spelled as" acceptance, because acceptance in this fleet
 *   means a committed command re-run in a container the worker never touched.
 *
 * `.strict()` closes the list against the future, and that is the half that
 * matters most. Without it, `aspect`, `thinking`, `isolation`, `skills` and
 * every field the config grows next year arrive accepted and ignored — and an
 * ignored field reads to its author as an honoured one.
 */
export const DispatchRequestItemSchema = z
  .object({
    /**
     * `workerId` from `contracts.ts`, not a fresh string type. Worker ids are
     * Pi session ids and inherit that grammar; reusing the schema means a
     * target that could never BE a session id is refused before the roster is
     * consulted, and means this file cannot drift from the grammar `up`
     * enforces.
     */
    worker: workerId,
    title: z.string().max(MAX_TEXT),
    brief: z.string().max(MAX_TEXT),
    model: notReachable(
      'a request may not name "model" (SRD-REVIEW-CONSOLE D11, §6.9). The model is pinned to ' +
        "the aspect in fleet.yaml and validated against models_allowlist at `up`, an hour before " +
        "this request exists — naming one here would be assigning a lens to a model that is " +
        "already fixed, which is a choice with no effect. Change the worker's `model:` in " +
        "fleet.yaml.",
    ),
    tools: notReachable(
      'a request may not name "tools" (SRD-REVIEW-CONSOLE D11, §12.1). The reviewer\'s ' +
        "[read, grep, find, ls] grant is what bounds three hosted vendors reading a private " +
        "repository, and §7.1 lists it under what this console leaves unchanged. Tool scope is a " +
        "config-time fact.",
    ),
    deadline_s: notReachable(
      'a request may not name "deadline_s" (SRD-REVIEW-CONSOLE D11, §6.7). The budget is ' +
        "host-side; a request that could set it can pin three of the largest models in the " +
        "catalogue open against the operator's API key.",
    ),
    deadline: notReachable(
      'a request may not name "deadline" (SRD-REVIEW-CONSOLE D11, §6.7). This spelling is ' +
        "refused explicitly alongside `deadline_s` so that neither is silently ignored — an " +
        "ignored budget reads to its author as an honoured one.",
    ),
    acceptance: notReachable(
      'a request may not name "acceptance" (SRD-REVIEW-CONSOLE D11, D8, §6.8). A review is ' +
        "graded on structural completeness and must not be spelled as acceptance: acceptance in " +
        "this fleet is a committed command re-run in a container the worker never touched, and " +
        "this instrument is weaker than that one.",
    ),
  })
  .strict();

export type DispatchRequestItem = z.infer<typeof DispatchRequestItemSchema>;

/** The whole file. `parent_task_id` binds it to the directory it was found in. */
export const DispatchRequestSchema = z
  .object({
    schema: z.literal(DISPATCH_REQUEST_SCHEMA, {
      error: `not a ${DISPATCH_REQUEST_SCHEMA} document. The tag is checked by name rather than ` +
        `inferred from the shape, because pifleet.task/v1 also carries a worker, a title and a ` +
        `brief and is close enough that a reader could hand one over by mistake.`,
    }),
    parent_task_id: z.string().max(MAX_SHORT),
    requests: z
      .array(DispatchRequestItemSchema)
      .min(1, {
        error:
          "requests[] is empty. This file is written only to ask for a fan-out, and under D5 the " +
          "parent task SETTLES the moment it is written — so an accepted empty request is a " +
          "review that reports success having dispatched nobody, which is indistinguishable from " +
          "a completed review until someone opens the report.",
      })
      .max(MAX_DISPATCH_REQUEST_ITEMS, {
        error:
          `requests[] holds more than ${MAX_DISPATCH_REQUEST_ITEMS} entries. The console has ` +
          `three reviewers and every entry must name a distinct one, so a list this long cannot ` +
          `be satisfiable — it is a caller bug rather than an ambitious review.`,
      }),
  })
  .strict();

export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;

/**
 * Why a file was refused, as a value rather than as prose.
 *
 * `harvest/outbox.ts`'s `OutboxRead` carries `reason` alone and that is enough
 * there, because no two of its rules can fire on one document. Here two can: a
 * collator id is by construction not a reviewer id, so a request naming `col-1`
 * violates D7 AND the membership rule, and only ONE of them is the reason an
 * operator should act on. A caller — or a test — that had to tell those apart
 * by matching substrings of English would be pinning a sentence rather than a
 * rule, and the sentence is the part that gets rewritten.
 *
 * So the code is the assertion surface and `reason` is the explanation. The
 * precedence between the two overlapping rules is fixed in
 * `checkRoster` and is the more specific rule first.
 */
export type DispatchRefusal =
  | "not_a_regular_file"
  | "too_large"
  | "unreadable"
  | "sender_not_collator"
  | "not_json"
  | "schema"
  | "parent_task_mismatch"
  | "collator_target"
  | "worker_not_in_console"
  | "duplicate_target";

/**
 * The three outcomes, shaped like `OutboxRead` and for its reasons.
 *
 * **`missing` is not a failure and must stay its own variant.** The actor polls;
 * a collator that dispatched nothing on this tick is the normal state and
 * occurs thousands of times per run, while a collator that wrote something
 * wrong occurred once and someone needs to know. Collapsing the two gives a log
 * that is either silent about real refusals or screaming about nothing.
 *
 * **There is no partial arm, and that is deliberate.** §6.4 refuses the whole
 * file on any violation, and a type with no way to express "these two of three
 * were fine" is how that stays true under maintenance rather than under
 * discipline.
 */
export type DispatchRequestRead =
  | { kind: "missing" }
  | { kind: "refused"; code: DispatchRefusal; reason: string }
  | { kind: "ok"; request: DispatchRequest };

/**
 * Everything needed to judge a request that is already in hand.
 *
 * `sender` is here rather than in the document because the document must never
 * be able to say who wrote it — see the module docblock. `roster` is here
 * rather than imported because D7 is a rule about roles and the console that
 * has two collators must be expressible before it exists.
 */
export interface DispatchRequestContext {
  /** The worker whose outbox held the file. Structural identity, never a claim. */
  sender: string;
  /** The task directory the file sat in; the parent id in the body must match. */
  taskId: string;
  roster: ConsoleRoster;
}

/** A request still on disk. */
export interface DispatchRequestLocation extends DispatchRequestContext {
  /** The run directory, as `paths.ts` means it. */
  runRoot: string;
}

/**
 * `<run-dir>/outbox/<worker>/<task-id>/dispatch-request.json`.
 *
 * Derived from `workerOutboxDir` rather than re-joining `outbox/<id>`, which is
 * the rule `workerVerbgateLedger` in `paths.ts` already follows and states the
 * cost of breaking: a second spelling of the mount path does not throw when it
 * diverges. The poller simply finds an empty directory forever, and a collator
 * that dispatched three reviews is indistinguishable from one that dispatched
 * none (`paths.ts:438-452`, ISC-231).
 *
 * **This belongs beside `workerVerbgateLedger` in `paths.ts` and should move
 * there when the relay actor (§6.5) becomes its second caller.** It is here
 * only because `paths.ts` is being edited concurrently for the `/replies`
 * mount; the module boundary, not the placement, is what matters today.
 */
export function dispatchRequestPath(runRoot: string, sender: string, taskId: string): string {
  return join(workerOutboxDir(runRoot, sender), taskId, DISPATCH_REQUEST_FILE);
}

/**
 * §6.10's sender rule: only a collator may ask for a dispatch.
 *
 * **One function, two call sites, and that is the point.** `readDispatchRequest`
 * calls it before the file's content is read — a document already decided
 * against should not be put through the parser — and `parseDispatchRequest`
 * calls it too, so a caller that reads the bytes some other way cannot arrive
 * with the check skipped. The relay actor (§6.5) does not exist yet and its
 * author has no reason to know that a rule about a document lives in a function
 * about a file, which is exactly the shape of hole that gets found later by
 * someone reading a transcript.
 *
 * Spelling it twice was the alternative and is the hazard `paths.ts` opens with:
 * a duplicated invariant holds until one copy is reasonably improved.
 */
function checkSender(ctx: DispatchRequestContext): DispatchRequestRead | null {
  if (ctx.roster.collators.includes(ctx.sender)) return null;
  return {
    kind: "refused",
    code: "sender_not_collator",
    reason:
      `a ${DISPATCH_REQUEST_FILE} was found in "${ctx.sender}"'s outbox, and only a collator ` +
      `may request a dispatch (SRD-REVIEW-CONSOLE §6.10). The collators on this console are ` +
      `${ctx.roster.collators.join(", ")}. The sender is not a field in the document — it is ` +
      `the directory the document was found in, because a container can write only its own ` +
      `outbox — so this is a worker that genuinely attempted a dispatch it may not make.`,
  };
}

/** First zod issue, rendered with its path so the operator knows which entry. */
function schemaReason(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "schema violation";
  const where = issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
  return `schema violation${where}: ${issue.message}`;
}

/**
 * The roster rules, in the order they must run.
 *
 * **The D7 check comes FIRST and the ordering is the whole of its correctness.**
 * A collator id is not a reviewer id, so a request naming one violates two
 * rules and whichever runs first is the one the operator reads. D7 is the
 * specific rule and "outside the reviewer set" is the general one; running the
 * general rule first would answer a self-dispatch with "col-1 is not one of
 * this console's reviewers", which is true, useless, and points an operator at
 * the roster instead of at the nesting they attempted.
 *
 * The distinctness check comes last because it is the only one that depends on
 * the entries already accepted, and because a duplicate of an ILLEGAL worker
 * should report the illegality rather than the repetition.
 */
function checkRoster(
  request: DispatchRequest,
  ctx: DispatchRequestContext,
): DispatchRequestRead | null {
  const seen = new Set<string>();

  for (const [index, entry] of request.requests.entries()) {
    /** 1-based: three entries differing only in `worker` are otherwise one line in a log. */
    const at = `request ${index + 1}`;
    const target = entry.worker;

    if (ctx.roster.collators.includes(target)) {
      const arm =
        target === ctx.sender
          ? `names "${target}", which is ITSELF — a collator dispatching its own follow-up work ` +
            `is a loop whose only bound is the collator's own judgement, which is model output`
          : `names "${target}", which is another collator — nesting a fan-out inside a fan-out ` +
            `makes the tree unbounded and attribution ambiguous`;
      return {
        kind: "refused",
        code: "collator_target",
        reason:
          `${at} ${arm} (SRD-REVIEW-CONSOLE D7, §6.10). A collator may dispatch only to this ` +
          `console's reviewers: ${ctx.roster.reviewers.join(", ")}.`,
      };
    }

    if (!ctx.roster.reviewers.includes(target)) {
      return {
        kind: "refused",
        code: "worker_not_in_console",
        reason:
          `${at} names worker "${target}", which is not one of this console's reviewers ` +
          `(${ctx.roster.reviewers.join(", ")}) — SRD-REVIEW-CONSOLE D7, §6.10. A worker outside ` +
          `the console has a real socket and a real run, so a dispatch to it would SUCCEED and ` +
          `leave its only trace in a run nobody is watching.`,
      };
    }

    if (seen.has(target)) {
      return {
        kind: "refused",
        code: "duplicate_target",
        reason:
          `${at} names "${target}" a second time (SRD-REVIEW-CONSOLE §6.9). The console's ` +
          `confidence bands count INDEPENDENT readers — 3/3 means three vendors agreed — and two ` +
          `reports from one model are one reader with two transcripts. A collator that could ` +
          `repeat a lens could manufacture the agreement it then reports.`,
      };
    }
    seen.add(target);
  }

  return null;
}

/**
 * Validate bytes already in hand. **Never throws**, for the reason
 * `harvest/outbox.ts` does not either: the caller is a polling loop that
 * performs every dispatch in the console, and a document written by a container
 * is half-written on any tick that catches it mid-write. An exception on a
 * torn read would take down the actor rather than skip a tick.
 *
 * The order is the contract, not an implementation detail:
 *
 *   0. **Sender** — before the document is even parsed. A non-collator's
 *      request is refused whatever it says, so nothing is learned by reading
 *      it first and a hostile document goes through one less parser.
 *   1. **Parse** — before any field is dereferenced.
 *   2. **Schema, strictly** — before any field is BELIEVED. D11's refusals live
 *      here so a forbidden field is refused by the same pass that refuses a
 *      missing one.
 *   3. **Identity** — the body's `parent_task_id` against the directory the
 *      file was found in. `harvest/outbox.ts:486-492` binds the other direction
 *      the same way and for the same reason: the directory was created by the
 *      host and the body is a claim.
 *   4. **Roster** — the rules that need to know who is asking and who exists.
 */
export function parseDispatchRequest(body: string, ctx: DispatchRequestContext): DispatchRequestRead {
  const wrongSender = checkSender(ctx);
  if (wrongSender !== null) return wrongSender;

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    return {
      kind: "refused",
      code: "not_json",
      reason: `${DISPATCH_REQUEST_FILE} is not valid JSON: ${String(err)}`,
    };
  }

  const parsed = DispatchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "refused", code: "schema", reason: schemaReason(parsed.error) };
  }
  const request = parsed.data;

  if (request.parent_task_id !== ctx.taskId) {
    return {
      kind: "refused",
      code: "parent_task_mismatch",
      reason:
        `the request claims parent task "${request.parent_task_id}" but sits in the outbox ` +
        `directory for "${ctx.taskId}". The directory is the authority because the host created ` +
        `it; fanning out under the claimed parent would derive every child id from a task chain ` +
        `that does not exist.`,
    };
  }

  const refused = checkRoster(request, ctx);
  if (refused !== null) return refused;

  return { kind: "ok", request };
}

/**
 * Read and validate `<outbox>/<task-id>/dispatch-request.json`.
 *
 * The first four steps mirror `readOutboxEnvelope` deliberately — a symlinked
 * or non-regular file refused from `lstat`, a size refused from the stat before
 * a byte is buffered — because this file arrives from the same directory, from
 * the same author, under the same §12.5 posture. The primitive is identical:
 * the worker owns this directory, so `dispatch-request.json -> ~/.env` is read
 * by a host process and lands in a refusal message, a log line, and from there
 * in an operator's terminal.
 *
 * **The sender check runs after the file is known to exist and before its
 * content is read, and both halves of that are chosen.**
 *
 * After existence, because the actor polls: a reviewer that has written nothing
 * must be `missing` and silent. If the sender were checked first, every tick
 * would emit a refusal for every non-collator in the console, and the one
 * refusal that means something — a reviewer that actually attempted a dispatch
 * — would be indistinguishable from the noise it was buried in.
 *
 * Before the content, because the sender is a property of the LOCATION and is
 * known before a byte is read. A non-collator's request is refused whatever it
 * says, so validating it first would make the refusal contingent on the content
 * of a document already decided against — and would put a hostile document
 * through the parser for no reason.
 */
export async function readDispatchRequest(
  loc: DispatchRequestLocation,
): Promise<DispatchRequestRead> {
  const file = dispatchRequestPath(loc.runRoot, loc.sender, loc.taskId);

  let st;
  try {
    st = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return {
      kind: "refused",
      code: "unreadable",
      reason: `${DISPATCH_REQUEST_FILE} could not be stat'd: ${String(err)}`,
    };
  }

  if (st.isSymbolicLink()) {
    return {
      kind: "refused",
      code: "not_a_regular_file",
      reason:
        `${DISPATCH_REQUEST_FILE} is a symlink and was not followed. The worker owns this ` +
        `directory, so a link is a request to have the host read a file of the worker's ` +
        `choosing and quote it back in a refusal.`,
    };
  }
  if (!st.isFile()) {
    return {
      kind: "refused",
      code: "not_a_regular_file",
      reason: `${DISPATCH_REQUEST_FILE} is not a regular file (a FIFO would wedge the reader on open)`,
    };
  }
  if (st.size > MAX_DISPATCH_REQUEST_BYTES) {
    return {
      kind: "refused",
      code: "too_large",
      reason:
        `${DISPATCH_REQUEST_FILE} is ${st.size} bytes; the cap is ${MAX_DISPATCH_REQUEST_BYTES}. ` +
        `The schema's own bounds would reject this only after JSON.parse had materialised the ` +
        `whole document, which is the OOM the cap exists to prevent — in the one host process ` +
        `that performs every dispatch in this console.`,
    };
  }

  const wrongSender = checkSender(loc);
  if (wrongSender !== null) return wrongSender;

  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (err) {
    return {
      kind: "refused",
      code: "unreadable",
      reason: `${DISPATCH_REQUEST_FILE} could not be read: ${String(err)}`,
    };
  }

  return parseDispatchRequest(body, loc);
}
