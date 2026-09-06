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
 * The inheritance is not a figure of speech. `readDispatchRequest` refuses the
 * same things `readOutboxEnvelope` refuses, for the same reasons, and the moment
 * it stops doing so is the moment this file stops being covered by the argument
 * that covers `result.json`.
 *
 * **Inheriting the LIST of refusals is not the same as inheriting the
 * MECHANISM, and this module learned that the expensive way.** It first spelled
 * the three checks as `lstat(path)` followed by `readFile(path)` — the same
 * three questions in the same order, asked of the same NAME twice. In a
 * directory the worker owns, a name is not a thing: every answer the `lstat`
 * gave was about an inode the `readFile` was free not to open. All three were
 * defeated in review by swapping the path in between — the size cap buffered
 * 64 MiB against a cap that "passed", the FIFO guard let `readFile` block
 * forever with no timeout (four of those exhaust libuv's default threadpool and
 * the actor stops dispatching AND harvesting, silently), and the symlink guard
 * let `readFile` return `<run>/control-auth.json`, the one file `paths.ts`
 * says a worker must never read.
 *
 * So the path is resolved EXACTLY ONCE, by an `open` whose flags are themselves
 * two of the checks, and the type and size questions are then asked of the FILE
 * DESCRIPTOR. `harvest/outbox.ts:409-433` had already reached the fd half of
 * this and said why — *"The stat is advisory — a worker can append between the
 * lstat and the read"* — and that paragraph is the one this file failed to
 * inherit. `outbox.ts`'s own `collectOutboxFiles` had reached the rest of it:
 * VALIDATE THEN HOLD, `O_NOFOLLOW` so a swap to a symlink is an `ELOOP` at open
 * rather than a followed link, `O_NONBLOCK` so a swap to a FIFO cannot wedge
 * the open.
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
 * 6. **A service share that does not match the console** — SRD-TRIAGE-CONSOLE
 *    §7.3. Absent where an environment is declared, or present where none is.
 *    The two halves are one rule: a field merely optional everywhere makes the
 *    host's completeness check unreachable by the cheapest failure a model has,
 *    which is omitting it.
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
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { EXIT, SESSION_ID_RE, workerId } from "../contracts.ts";
import { workerOutboxDir } from "./paths.ts";
// The DEPTH half of D7. `relay.ts` mints collation ids and this module must
// refuse a fan-out dispatched FROM one, so the predicate is imported rather
// than re-spelled — see `checkDepth`. The dependency runs one way only:
// `relay.ts` takes its `DispatchRequest` from here as a TYPE, which erases, so
// the pair is not a runtime cycle.
import { isCollationTaskId } from "./relay.ts";

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
 * The longest `title` or `brief` an entry may carry, in UTF-16 CODE UNITS.
 *
 * **Not `MAX_TEXT` (64 KiB), and the difference is arithmetic rather than
 * taste.** The byte cap below is only defensible while a document that
 * VALIDATES is a document that READS — a cap that refuses a schema-legal file
 * is a bug that reads as a policy and gets argued away rather than fixed. At
 * `MAX_TEXT` that property was FALSE, and measurably so: a fully schema-legal
 * document came to 6.00 MiB against a 4.00 MiB cap and was refused
 * `too_large`.
 *
 * The arithmetic, because the previous version of this comment got it wrong in
 * both directions and the specific wrongness is worth keeping:
 *
 *  - These bounds count UTF-16 CODE UNITS (`z.string().max` is `value.length`),
 *    not bytes. "1 MiB of legal text" was a count of code units being compared
 *    against a cap measured in bytes.
 *  - JSON escaping makes a file LARGER, never smaller, so "sits above any
 *    schema-legal document even before JSON escaping" had the inequality
 *    backwards. Escaping is not a rounding error here, it is the DOMINANT term:
 *    a code unit costs at most 3 UTF-8 bytes raw (2 for an astral pair, which
 *    spends two units on one character), but every C0 control character and
 *    every lone surrogate escapes to a six-character "backslash-u-XXXX" form
 *    and therefore costs 6. So the multiplier that matters is 6, and it comes
 *    from the encoding of the FILE rather than from the encoding of the text.
 *
 * At 32 KiB the dominant term is exact and checkable by hand:
 *
 *     MAX_DISPATCH_REQUEST_ITEMS x 2 fields x MAX_DISPATCH_TEXT x 6 bytes
 *       = 8 x 2 x 32,768 x 6 = 3,145,728 bytes = 3.00 MiB
 *
 * Everything else in the document is held to `SESSION_ID_RE`, which is ASCII
 * that never escapes: eight `worker` ids and one `parent_task_id` at 64
 * characters each, the schema tag, and the punctuation — together under 1 KiB.
 *
 * **SRD-TRIAGE-CONSOLE §7.3 added a second ASCII term and it is large enough to
 * be worked rather than waved at.** `services` is up to
 * `MAX_DISPATCH_SERVICES` names of `MAX_DISPATCH_ID_CHARS` characters, in every
 * entry:
 *
 *     MAX_DISPATCH_REQUEST_ITEMS x MAX_DISPATCH_SERVICES x (MAX_DISPATCH_ID_CHARS + 3)
 *       = 8 x 64 x 67 = 34,304 bytes = 33.5 KiB
 *
 * — the `+ 3` being the two quotes and the comma each name costs inside the
 * array, and the multiplier being 1 rather than 6 because `SESSION_ID_RE`
 * admits no character JSON escapes.
 *
 * So the worst schema-legal document is under 3.04 MiB against a 4.00 MiB cap,
 * with 0.96 MiB of headroom. `dispatch-request.test.ts` builds that exact
 * document — every text field filled to the bound with the control character
 * U+0001, which is the worst case above, and every `services` list filled to
 * `MAX_DISPATCH_SERVICES` names at the id bound — measures it on disk, and
 * asserts it is ACCEPTED. The invariant is executed rather than asserted, which
 * is the whole of the repair: the previous claim was true-looking prose that no
 * test could have contradicted, and it was false.
 *
 * **Lowering this rather than raising the cap was the choice, and the cap's own
 * argument is why.** The 4 MiB below is deliberately the same number as
 * `MAX_ENVELOPE_BYTES`, and the sameness IS the argument (see below); raising
 * it to clear 6 MiB would spend that argument to buy the host the right to
 * buffer twice as much hostile input, in exchange for briefs no reviewer will
 * ever write. 32 KiB of brief is roughly 8,000 words of instruction for a task
 * whose whole content is "read this and report", and it stays comfortably
 * inside `MAX_DISPATCH_POLICY_BYTES` (256 KiB) — the model-facing bound this
 * value has to compose with, at the drop where a truncation would actually
 * cost something.
 */
export const MAX_DISPATCH_TEXT = 32 * 1024;

/**
 * The longest any id may be — `SESSION_ID_RE`'s companion bound.
 *
 * 64 to match `workerId` in `contracts.ts` and `replyFileName` in `replies.ts`,
 * which is the same number for the same reason: these are names that become
 * path SEGMENTS on the host.
 */
export const MAX_DISPATCH_ID_CHARS = 64;

/**
 * The longest `services` list one request may carry — SRD-TRIAGE-CONSOLE §7.3.
 *
 * 64, which is `MAX_SERVICES_PER_ENVIRONMENT` in `triage-targets.ts`: ONE
 * observer's share may be the whole environment, because §6.5 makes ⌈N/3⌉ the
 * worker's judgement rather than a refusal — *"the partition is the triage
 * worker's to make"* — and a bound below the environment's own cap would refuse
 * a legal partition on arithmetic nobody wrote down.
 *
 * **Spelled here rather than imported, and the duplication is deliberate.** The
 * `DispatchRefusal` block below states the rule this module lives by: the
 * environment is `triage/targets.yaml`, *"a file this module has never heard of
 * and must not grow a dependency on"*. An import for one integer is that
 * dependency arriving through the back door, and `task-ids.ts` duplicates
 * `MAX_RELAY_TASK_ID_CHARS` rather than take the equivalent edge.
 *
 * The pairing is not left to prose. `dispatch-request.test.ts` imports BOTH
 * constants and asserts they are equal, so a divergence is a red test rather
 * than a partition refused as `schema` — a code naming neither file — the day
 * an operator extends an environment past this number.
 */
export const MAX_DISPATCH_SERVICES = 64;

/**
 * Hard byte cap, enforced from `fstat` on the open fd BEFORE the read, and
 * again from the read itself.
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
 * capped at `MAX_DISPATCH_TEXT` (32 KiB), comfortably inside what the drop can
 * stage, so a request that validates here always stages there.
 *
 * **The invariant that makes this cap defensible: a document that VALIDATES is
 * a document that READS.** The arithmetic is worked in full on
 * `MAX_DISPATCH_TEXT` above and comes to 3.00 MiB of worst-case escaped text
 * against this 4.00 MiB — so no schema-legal file is ever refused here. That
 * matters beyond tidiness. A cap that CAN refuse a legal document is a bug that
 * presents as a policy: the operator sees a refusal that names a limit, believes
 * the limit, and the remedy discussed is raising the cap rather than fixing the
 * bounds that overflowed it.
 *
 * This is the one property in this file that cannot be checked by reading it,
 * because it is a claim about two constants and an encoding rather than about
 * any line of code — so it is checked by a test that builds the maximal legal
 * document and asserts it through `readDispatchRequest`. Changing either bound
 * without that test going red is not possible, which is the point.
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
  /**
   * Whether a request must carry `services` — SRD-TRIAGE-CONSOLE §7.3's table,
   * as a value.
   *
   * **THE RULE RATHER THAN THE CONSOLE'S NAME, and the difference is a
   * divergence hazard rather than taste.** §7.3 asks for *"`ConsoleRoster` gains
   * the name and the refinement reads it"*, and a `name` field would work — but
   * `ConsoleSpec.name` already exists one layer up (`cli/commands/relay.ts`) as
   * the `--console` value, and two spellings of one console's name,
   * constructible to disagree, is the failure that interface's own docblock
   * spends its length on. It would also put a literal `"triage"` inside the
   * check, which is precisely the shape this interface exists to avoid: see the
   * argument above about a rule written against the literal `col-1`.
   *
   * Carrying the rule keeps §7.3's survival claim exactly true — *"§10 D5's bet
   * survives: a third console is still a third constant"* — because a third
   * console answers this question in the constant that declares it, with no
   * table, no union and no edit to this file.
   */
  services: ConsoleServicesRule;
}

/**
 * Whether this console's requests carry a service list — §7.3.
 *
 * **Two values and no third, because "optional" is the value that would make
 * the downstream check unreachable.** §7.3: *"A field merely optional
 * everywhere would make `partition_incomplete` unreachable by the cheapest
 * failure available to a model — omitting it — and an unreachable refusal is a
 * check that passes because nothing asked."* So every console either demands
 * the field or refuses it, and there is no arm that shrugs.
 */
export type ConsoleServicesRule = "required" | "refused";

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
  /*
   * §7.3's review row. **This console has no targets file**, so a service list
   * here would be a partition of nothing: accepted, never counted, and read by
   * its author as honoured. Refusing it is §7.3's own promise — *"refused
   * whole, with the field named"* — spent on the new field rather than weakened
   * by it, and it is what makes NO review request change behaviour.
   */
  services: "refused",
};

/**
 * The `triage` console — SRD-TRIAGE-CONSOLE §2.1, D5.
 *
 * **A VALUE, and that is the entire content of that document's Phase 2.** The
 * second console needs no schema change, no new refusal and no branch anywhere in
 * this module, because {@link ConsoleRoster} was already written over roles
 * rather than over `col-1` — see that interface for the argument, which was made
 * against a hypothetical second collator and turns out to have bought a second
 * console. §2.1: *"a value that needs no schema change and no new refusal"*.
 *
 * **Two of the twelve refusals do real work here on their first day.**
 * `duplicate_target` makes a partition that names one observer twice a refused
 * file rather than a lost service, and `worker_not_in_console` makes a triage
 * worker that invents a worker id a refused file rather than a dispatch into the
 * engineering fleet. Both are the host counting rather than the worker claiming,
 * which is the discipline the whole console turns on (§6.5).
 *
 * ## The field names read wrong, and renaming them is refused rather than pending
 *
 * An observer is not a reviewer. D5 records the trade explicitly — *"The cost is
 * two field names that read wrong for the rest of this console's life. Accepted
 * over a rename that would touch a shipped console for no behaviour."* The two
 * halves answer the two questions the interface names, and `obs-t1` is a
 * legitimate answer to *"is this target inside the console?"* whatever the field
 * is called.
 *
 * ## What is NOT pinned here yet, stated so the silence is not read as coverage
 *
 * {@link REVIEW_CONSOLE_ROSTER} is pinned against `DEFAULT_REVIEW_WORKERS` as a
 * SET, so a seat renamed in one and not the other is a red test rather than a
 * console that starts four healthy panes and refuses every dispatch. This console
 * has no such export yet — its pane plan is SRD-TRIAGE-CONSOLE Phase 4 — so the
 * suite pins these four ids against the tracked `fleet.example.yaml` instead, by
 * id AND by role. **When `DEFAULT_TRIAGE_WORKERS` lands, that probe should become
 * the same set equality the review console has**, because the config check
 * catches a rename and does not catch a fifth seat added to only one of them.
 */
export const TRIAGE_CONSOLE_ROSTER: ConsoleRoster = {
  collators: ["tri-1"],
  reviewers: ["obs-t1", "obs-t2", "obs-t3"],
  /*
   * §7.3's triage row, and the half that makes the completeness check
   * REACHABLE. §6.5 puts the count on the host — *"a model that partitions can
   * drop a service and nothing downstream would notice"* — and the cheapest way
   * for a model to drop one is to write no list at all. Required here, that is
   * `services_missing` at the request plane; optional, it would be three idle
   * observers and a sweep refused as `partition_incomplete` naming every
   * service in the environment, which points the operator at the targets file
   * rather than at the request.
   */
  services: "required",
};

/**
 * A roster under which the checks below would not mean what they say.
 *
 * **THROWN, not refused, and the asymmetry with everything else in this file is
 * deliberate.** Every other failure here is a document a container wrote, which
 * is untrusted input, expected, and answered with a value. A roster is a HOST
 * argument written by the author of the actor — it is the same on every tick for
 * the life of the run, so it is either wrong from the first poll or never — and a
 * console whose roster is malformed must not dispatch AT ALL. Answering with a
 * refusal would put a programming error into the same channel as a worker's
 * mistake and let the loop keep running around it; the promise `parseDispatchRequest`
 * makes is that it never throws on the DOCUMENT, and that promise is untouched.
 */
export class ConsoleRosterError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(problem: string) {
    super(
      `the dispatch roster is not usable: ${problem}. A console roster must name at least one ` +
        `collator and at least one reviewer, and no worker may hold both roles — the two halves ` +
        `answer different questions ("may this worker ask?" and "is this target inside the ` +
        `console?") and a worker in both makes the first question answer itself`,
    );
    this.name = "ConsoleRosterError";
  }
}

/**
 * The roster checks, and each one closes a hole that reads as obviously correct.
 *
 * **Disjointness is the important one.** `checkSender` asks whether the sender is
 * in `collators` and `checkRoster` asks whether the target is in `reviewers`;
 * neither can tell that it has been handed a roster where those are the same
 * people. An actor author writing
 *
 *     roster: { collators: [senderFromDirectory], reviewers: allWorkers }
 *
 * has written something that reads correct — the sender IS the collator, the
 * reviewers ARE the workers — and has made `checkSender` a tautology (every
 * sender is trivially a collator, because the roster was built from the sender)
 * while admitting `eng-1` as a target. Both of this module's semantic guarantees
 * are gone and no test of either would notice, because the checks still run and
 * still pass. Disjointness is what makes that roster unconstructible.
 *
 * **Non-emptiness** is the degenerate half of the same thing: `collators: []`
 * refuses every dispatch (a console that silently does nothing) and
 * `reviewers: []` does the same one rule later. Neither is a roster anyone means.
 *
 * ## Case, and why the fold is here rather than on the comparisons
 *
 * `paths.ts:710-741` argues that its case fold must be UNCONDITIONAL because a
 * false GREEN hands a worker `control-auth.json`. That argument applies to this
 * module, and the obvious reading of it — fold the comparisons — is the wrong
 * one, which is worth writing down because it is where a reader will start.
 *
 * Folding `checkSender` would make `Col-1` match the collator `col-1` and ADMIT
 * a sender that is not the collator: a false green, manufactured by the fix.
 * Folding the target check would accept `Rev-Arch-1` and hand the actor an id
 * matching no worker. Exact comparison is correct in both directions, and the
 * false RED it can produce ("that id is not in the set") is a refusal an
 * operator acts on in one move.
 *
 * The real hazard is one level up, and it is the one paths.ts is actually about.
 * `sender` is trustworthy ONLY because a container can write only its own
 * outbox, so the DIRECTORY is an identity that cannot be forged. On a
 * case-insensitive filesystem — APFS by default, which is what this fleet
 * develops on — `<run>/outbox/col-1` and `<run>/outbox/Col-1` are ONE directory,
 * and `config/schema.ts:1396-1405` dedupes worker ids case-SENSITIVELY, so both
 * ids are legal in one fleet. Two workers sharing one outbox is the premise of
 * the whole module failing: `Col-1` writes the file, the actor polls `col-1`,
 * finds it, and `checkSender` correctly answers that `col-1` is a collator.
 * Every check in this file passes and a reviewer has dispatched.
 *
 * No comparison in this file can detect that, because by the time the file is
 * read the two identities have already merged on disk. It is detectable exactly
 * once, HERE, at the boundary where the ids are still two strings — so a roster
 * holding a case-twin pair is refused outright rather than served. Unconditional,
 * on every platform, for paths.ts's reason 4: a `process.platform` branch would
 * make the test for this skip on Linux CI and leave the behaviour evidenced only
 * by a run on a maintainer's laptop.
 *
 * **What this does NOT buy, stated so the silence is not read as coverage.** It
 * bounds the ids in THIS roster. A case-twin pair elsewhere in the fleet is a
 * real bug and is `config/schema.ts`'s to find; it is out of reach from here and
 * is not claimed.
 */
function assertRoster(roster: ConsoleRoster): void {
  if (roster.collators.length === 0) throw new ConsoleRosterError("it names no collators");
  if (roster.reviewers.length === 0) throw new ConsoleRosterError("it names no reviewers");

  const fold = new Map<string, string>();
  for (const id of [...roster.collators, ...roster.reviewers]) {
    const key = id.toLowerCase();
    const first = fold.get(key);
    if (first === undefined) {
      fold.set(key, id);
      continue;
    }
    if (first === id) {
      throw new ConsoleRosterError(
        `"${id}" appears twice — as a collator and as a reviewer, or twice in one half`,
      );
    }
    throw new ConsoleRosterError(
      `"${first}" and "${id}" differ only in case. A worker's outbox directory IS its identity ` +
        `here, and on a case-insensitive filesystem those two ids name ONE directory — so a ` +
        `request written by either would be read as having come from the other`,
    );
  }
}

/**
 * The roster to judge against, defaulting to the console that ships.
 *
 * **The default is the fix, not a convenience.** `roster` was a bare required
 * parameter, so every caller had to answer a question — "who may ask, and who may
 * be asked?" — that has exactly one right answer today, and the plausible wrong
 * answers are the ones above that disable both checks while looking correct. A
 * required parameter with one correct value is an invitation to compute it, and
 * `assertRoster` exists because computing it is how the tautology arrives.
 *
 * It stays a PARAMETER because D7 is a rule about roles rather than about
 * `col-1`, and the two-collator console has to be expressible in a test before it
 * is expressible in config (see `ConsoleRoster`). Optional, not absent.
 */
function resolveRoster(ctx: DispatchRequestContext): ConsoleRoster {
  const roster = ctx.roster ?? REVIEW_CONSOLE_ROSTER;
  assertRoster(roster);
  return roster;
}

/**
 * An id that cannot be a path segment, refused before it becomes one.
 *
 * `EXIT.USAGE` and not `EXIT.INTERNAL`, on the grade `ReplyNameError` carries and
 * for its reason: reaching this means a caller built a location out of something
 * that is not a worker id or a task id, which is an operator- or author-side
 * mistake with an operator-side remedy. Reporting it as an internal fault tells a
 * machine caller that pifleet broke, which an orchestrator answers by retrying
 * the identical input forever.
 */
export class DispatchIdError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(
      `${field} ${JSON.stringify(value)} cannot name a path segment — a dispatch request lives ` +
        `at <run>/outbox/<worker>/<task-id>/${DISPATCH_REQUEST_FILE}, so both ids must be 1-` +
        `${MAX_DISPATCH_ID_CHARS} characters of letters, digits, ".", "_" or "-", beginning and ` +
        `ending alphanumeric`,
    );
    this.name = "DispatchIdError";
  }
}

/**
 * The grammar every id here must satisfy BEFORE it is joined into a host path.
 *
 * **`SESSION_ID_RE` is imported rather than re-spelled, and that is a decision
 * about this file's failure mode rather than about brevity.** It is the grammar
 * `materialize.ts`'s `assertContained` already applies to every operator-typed
 * name that becomes a host path, that `config/schema.ts` applies to every worker
 * key, and that `replies.ts` applies to the child task ids on the RETURN half of
 * this same exchange. A local copy would be a fourth spelling of one security
 * grammar, and this module's own header opens by quoting `paths.ts` on what that
 * costs: a duplicated invariant holds until one copy is reasonably improved. The
 * import is from `contracts.ts`, where the constant lives — not from `replies.ts`,
 * which merely uses it.
 *
 * **The helper below, unlike the grammar, IS a duplicate, and it should not stay
 * one.** `replies.ts:143-148` performs the identical two-part test on the
 * identical constants. Both belong in `paths.ts` beside `dispatchRequestPath`,
 * as one exported predicate, the moment both branches have landed; they are
 * apart today only because the two files are being edited concurrently.
 *
 * The character-class test is root-independent, so it is exact for `.` and `..`
 * — which a containment predicate answers "no, it did not escape" for, because
 * the resolved path IS the directory. `assertContained` recorded that
 * measurement; this reuses its conclusion rather than re-deriving it.
 */
function spellableId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_DISPATCH_ID_CHARS && SESSION_ID_RE.test(value);
}

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
 * One request: a worker, a title, a brief — and, on a console that declares an
 * environment, the share of it this request covers. **Nothing else** — §6.4,
 * SRD-TRIAGE-CONSOLE §7.3.
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
    /**
     * `title` and `brief` are the only unbounded-alphabet fields in the
     * document, so they are the only two that can drive the file's SIZE — every
     * other field is held to `SESSION_ID_RE`, which is ASCII that never escapes.
     * The bound is therefore not a tidiness limit; it is the term the byte cap's
     * headroom argument is computed from, and the error says so, because the
     * next reader to raise it needs to know it is not free.
     */
    title: z.string().max(MAX_DISPATCH_TEXT, {
      error:
        `title is longer than ${MAX_DISPATCH_TEXT} characters. This bound and ` +
        `MAX_DISPATCH_REQUEST_BYTES are one argument, not two: the byte cap is only defensible ` +
        `while every schema-legal document fits under it, and raising this without redoing that ` +
        `arithmetic makes a legal request refusable as "too_large".`,
    }),
    brief: z.string().max(MAX_DISPATCH_TEXT, {
      error:
        `brief is longer than ${MAX_DISPATCH_TEXT} characters. The same arithmetic as title — ` +
        `and this is also the field the /policy/dispatch drop has to stage under ` +
        `MAX_DISPATCH_POLICY_BYTES, so a request that validates here always stages there.`,
    }),
    /**
     * One observer's share of the environment — SRD-TRIAGE-CONSOLE §7.3.
     *
     * **Optional HERE and settled by the roster**, which is the split arm 1
     * chose. The SHAPE of a service list is a document question and belongs to
     * the schema; whether the list must be PRESENT is a question about the
     * console the request arrived at, and no schema in this module knows which
     * console that is. {@link checkServices} answers the second half and spends
     * `services_missing` / `services_not_permitted` rather than `schema`, so an
     * operator can tell *"this console does not take that field"* from *"that
     * field is malformed"* — the same split `DispatchRefusal` exists for.
     *
     * **It is not `notReachable`, and it is the only field here that is not.**
     * The four below are decisions a gate already made that a request must not
     * revisit. This one is a fact only the writer holds: which services its
     * share covers. §6.5 keeps that judgement with the model and moves the COUNT
     * to the host, and a field is the only machine-readable way to carry the
     * first to the second — §7.3 refuses the alternative by name, because
     * recovering the share from the brief's prose is *"the one thing a check
     * against a partitioning model must not depend on."*
     *
     * The names are held to `SESSION_ID_RE` and `MAX_DISPATCH_ID_CHARS` for
     * `parent_task_id`'s reason, one level further out: a service name keys an
     * incident record under `~/.pifleet/triage/` (§6.8) and becomes a path
     * segment there, and this value was written by a container. This is the same
     * grammar `triage-targets.ts` holds a DECLARED name to, and the suite pins
     * the two together against a table of names that pass both and names that
     * fail both.
     *
     * **An EMPTY list is legal and is not `services_missing`.** §6.5's
     * `1 ≤ N < 3` row — *"an idle observer is not an error"* — and completeness
     * belongs to `triage-partition.ts`, which refuses an all-empty fan-out as
     * `partition_incomplete` naming every declared service. A `.min(1)` here
     * would refuse the ordinary small environment AND would answer a question
     * about `triage/targets.yaml` in the module that must not read one.
     */
    services: z
      .array(
        z
          .string()
          .max(MAX_DISPATCH_ID_CHARS, {
            error:
              `a service name is longer than ${MAX_DISPATCH_ID_CHARS} characters. It keys an ` +
              `incident record under ~/.pifleet/triage/ (§6.8), so it is bounded like the path ` +
              `segment it becomes rather than like free text.`,
          })
          .regex(SESSION_ID_RE, {
            error:
              `a service name is not a name. It must be letters, digits, ".", "_" or "-", ` +
              `beginning and ending alphanumeric — the grammar triage/targets.yaml holds a ` +
              `DECLARED service to, and the grammar every name that becomes a host path is held ` +
              `to. A length bound alone accepts "../../control-auth.json", written by a ` +
              `container into a run directory that also holds the control-socket secret.`,
          }),
      )
      .max(MAX_DISPATCH_SERVICES, {
        error:
          `services[] holds more than ${MAX_DISPATCH_SERVICES} entries, which is more services ` +
          `than one environment may declare (§7.1). A share larger than the whole environment ` +
          `cannot be a share OF it.`,
      })
      .optional(),
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
    /**
     * **A GRAMMAR, not a length.** This was `z.string().max(MAX_SHORT)` — a
     * bound and nothing else — which accepts `"../../control-auth.json"`, and
     * the value on this path was written by a container. `replies.ts:124-142`
     * closes exactly this hole on the RETURN half of the same exchange and its
     * prose transfers without amendment: the id becomes a `join` that becomes a
     * `writeFile` on the host, in a run directory that also holds the
     * control-socket secret, and a name that cannot be spelled cannot escape.
     *
     * **This is deliberately redundant with the equality check below and must
     * stay so.** `parent_task_id` has to equal `ctx.taskId`, which `checkIds`
     * has already held to this same grammar — so today nothing can reach a path
     * through this field. That is a property of two OTHER checks standing where
     * they currently stand, not of this field, and a bound that holds only
     * transitively is a bound that lapses the day one of them moves. The field
     * is a document field, so it is judged by the pass that judges document
     * fields, on its own.
     */
    parent_task_id: z
      .string()
      .max(MAX_DISPATCH_ID_CHARS, {
        error:
          `parent_task_id is longer than ${MAX_DISPATCH_ID_CHARS} characters. It names a ` +
          `DIRECTORY the host created under a worker's outbox, so it is bounded like the path ` +
          `segment it is rather than like free text.`,
      })
      .regex(SESSION_ID_RE, {
        error:
          `parent_task_id is not a task id. It must be letters, digits, ".", "_" or "-", ` +
          `beginning and ending alphanumeric — the grammar every other name that becomes a host ` +
          `path is held to. A length bound alone accepts "../../control-auth.json", which is a ` +
          `traversal written by a container into a run directory that also holds the ` +
          `control-socket secret.`,
      }),
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
  | "unspellable_id"
  | "sender_not_collator"
  | "not_json"
  | "schema"
  | "parent_task_mismatch"
  | "collation_parent"
  | "collator_target"
  | "worker_not_in_console"
  | "duplicate_target"
  // ── SRD-TRIAGE-CONSOLE §6.5, D6 — the partition's completeness ─────────────
  //
  // **Emitted by `src/run/triage-partition.ts`, not by this module**, and the
  // codes live here anyway because this is the vocabulary of the request plane
  // and one refusal alphabet is what lets an actor log and a test assert without
  // knowing which check produced the answer. §6.5 puts them here by name:
  // *"Two new refusal codes, joining the twelve at `dispatch-request.ts:669-682`."*
  //
  // Nothing in this file can decide either one, and that is a property of the
  // rules rather than an omission. Both are answers to "does this request cover
  // the environment exactly once?", and the environment is `triage/targets.yaml`
  // — a file this module has never heard of and must not grow a dependency on.
  // The checks that spend these codes are Phase 5's; the ordering is Phase 5's
  // too. What is settled here is that the two exist and are DISTINCT, because
  // §6.5 makes them different failures with different operator responses: a
  // service nobody looked at, versus a service two observers both claimed.
  | "partition_incomplete"
  | "partition_duplicate"
  // ── SRD-TRIAGE-CONSOLE §7.3 — the share, and which console may carry one ────
  //
  // **Spent by `checkServices` in THIS module**, unlike the pair above, and
  // they live here by the same rule §6.5 set rather than by proximity: this is
  // the vocabulary of the request plane, *"whichever module spends them"*. The
  // four are one alphabet so an actor can log and a test can assert without
  // knowing which check produced the answer.
  //
  // They are decidable here — and the pair above is not — because the question
  // is about the console the request arrived at, which `ConsoleRoster` already
  // carries, rather than about `triage/targets.yaml`, which this module has
  // never heard of.
  //
  // `services_missing` is the one that makes `partition_incomplete` reachable.
  // §6.5 predicted the failure one level up — *"a model that partitions can
  // drop a service"* — and the cheapest way to drop every service at once is to
  // write no list. A field merely optional everywhere would make that document
  // legal and the refusal unreachable.
  | "services_missing"
  | "services_not_permitted";

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
  /**
   * Who may ask and who may be asked. **Optional, defaulting to
   * `REVIEW_CONSOLE_ROSTER`** — see `resolveRoster` for why the default is the
   * repair rather than a convenience, and `assertRoster` for what a supplied
   * roster is held to.
   */
  roster?: ConsoleRoster;
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
 *
 * **It THROWS on an id it cannot spell, and a bare `join` is why it has to.**
 * `join` is not a containment predicate — it is string arithmetic that resolves
 * `..` cheerfully — so this function returned `/etc/dispatch-request.json` for
 * `taskId = "../../../../../../etc"` and did it without a word. Measured, not
 * hypothesised. A path builder that can silently produce a path outside the
 * subtree it names is a hole wherever it is called, including from callers that
 * do not exist yet, so the refusal belongs in the builder rather than in each
 * caller's memory of it. `readDispatchRequest` never reaches the throw because
 * it holds the same ids to the same grammar first and answers with a REFUSAL —
 * the contract that it does not throw on a poll is untouched.
 */
export function dispatchRequestPath(runRoot: string, sender: string, taskId: string): string {
  if (!spellableId(sender)) throw new DispatchIdError("worker id", sender);
  if (!spellableId(taskId)) throw new DispatchIdError("task id", taskId);
  return join(workerOutboxDir(runRoot, sender), taskId, DISPATCH_REQUEST_FILE);
}

/**
 * The two ids that become a host path, held to a grammar before either is used.
 *
 * **One function, two call sites, for `checkSender`'s reason** — and this one is
 * the more important of the two, because `parseDispatchRequest` never builds a
 * path and could therefore look exempt. It is not: `ctx.taskId` is what
 * `parent_task_id` is checked AGAINST, so a caller that read the bytes itself
 * and passed a traversal as `taskId` would have the body's traversal accepted as
 * matching. The rule has to hold wherever the context does.
 *
 * Refused rather than thrown, unlike `dispatchRequestPath`: on this path the
 * caller is the polling actor, and a value is what a polling actor can act on.
 */
function checkIds(ctx: DispatchRequestContext): DispatchRequestRead | null {
  for (const [field, value] of [
    ["sender", ctx.sender],
    ["taskId", ctx.taskId],
  ] as const) {
    if (spellableId(value)) continue;
    return {
      kind: "refused",
      code: "unspellable_id",
      reason:
        `${field} ${JSON.stringify(value)} is not a legal id and no path was built from it. ` +
        `Both halves of a request's location become path SEGMENTS under <run>/outbox, and ` +
        `\`join\` resolves ".." rather than refusing it — so an unchecked id here reads a file ` +
        `of the caller's choosing out of the run directory, which is where control-auth.json ` +
        `lives. The grammar is 1-${MAX_DISPATCH_ID_CHARS} characters of letters, digits, ".", ` +
        `"_" or "-", beginning and ending alphanumeric.`,
    };
  }
  return null;
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
function checkSender(sender: string, roster: ConsoleRoster): DispatchRequestRead | null {
  if (roster.collators.includes(sender)) return null;
  return {
    kind: "refused",
    code: "sender_not_collator",
    reason:
      `a ${DISPATCH_REQUEST_FILE} was found in "${sender}"'s outbox, and only a collator ` +
      `may request a dispatch (SRD-REVIEW-CONSOLE §6.10). The collators on this console are ` +
      `${roster.collators.join(", ")}. The sender is not a field in the document — it is ` +
      `the directory the document was found in, because a container can write only its own ` +
      `outbox — so this is a worker that genuinely attempted a dispatch it may not make.`,
  };
}

/**
 * D7's DEPTH arm: a fan-out may not be dispatched FROM a collation.
 *
 * **The measured hole this closes.** D7 as shipped bounds BREADTH — `checkRoster`
 * refuses a collator target, a worker outside the console, and a repeated one.
 * Nothing bounded depth over time. On the collation turn the collator holds all
 * three replies AND its `write` grant, so it can write
 * `<outbox>/<parent>-collate/dispatch-request.json` naming the same three
 * reviewers with reviewer A's findings pasted into reviewer B's brief. Every
 * other check in this file passes that document — the sender is a collator, the
 * targets are reviewers, none repeats, the parent id matches its directory, no
 * forbidden field appears — and the actor fans out a second time. That reopens
 * exactly what D7 exists to prevent, and it defeats §6.6's concurrency
 * anti-criterion on round two, which §10's probe only covers on round one.
 *
 * **Why this and not a per-run fan-out budget**, which was the other candidate:
 *
 *  - A budget is HISTORY, so it needs durable per-run state, and that state has
 *    exactly one correct writer — `relay-journal.ts`. A counter here would be a
 *    second writer of one fact, and two components that stay individually
 *    consistent while disagreeing is a failure nobody sees.
 *  - A budget bounds how MANY fan-outs, not how DEEP. A collator still under
 *    budget can paste A's findings into B's brief on round two, and the
 *    contamination is the damage — the consensus arithmetic dies from that, not
 *    from the count.
 *  - The parent id is already in hand and already held to a grammar. A rule over
 *    a NAME, checked before anything is believed, is the posture of every other
 *    rule in this file, and it costs no state at all.
 *
 * **It is asked of `ctx.taskId`, the DIRECTORY, and not of the body.** The
 * directory was created by the host and the body is a claim; the equality check
 * below makes them agree, but agreeing is a property of two checks standing
 * where they stand today. The structural identity is the one that cannot be
 * edited from inside a container.
 *
 * **What it does not close.** A collator that rewrites the ORIGINAL parent's
 * request on a later tick is refused by nothing here, because that id is legal
 * and this module has no memory. That is the REPEAT arm — §6.10's "at most one
 * unsettled fan-out per parent" — and it belongs to the journal. Depth is a
 * property of an id; repetition is a property of history, and only one of the
 * two can be had without state.
 */
function checkDepth(taskId: string): DispatchRequestRead | null {
  if (!isCollationTaskId(taskId)) return null;
  return {
    kind: "refused",
    code: "collation_parent",
    reason:
      `the request sits in the outbox directory for "${taskId}", which is a COLLATION task, and ` +
      `a fan-out may not be dispatched from one (SRD-REVIEW-CONSOLE D7, §6.6). A collation turn ` +
      `is the one turn on which the collator holds every reviewer's report and its write grant ` +
      `at the same time, so a request written from here can name the same three reviewers with ` +
      `one reviewer's findings in another's brief — which passes every other rule in this file ` +
      `and destroys the independence the console's consensus bands are arithmetic over. The ` +
      `fan-out for this review has already happened, under "${taskId.slice(0, -"-collate".length)}".`,
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
  sender: string,
  roster: ConsoleRoster,
): DispatchRequestRead | null {
  const seen = new Set<string>();

  for (const [index, entry] of request.requests.entries()) {
    /** 1-based: three entries differing only in `worker` are otherwise one line in a log. */
    const at = `request ${index + 1}`;
    const target = entry.worker;

    if (roster.collators.includes(target)) {
      const arm =
        target === sender
          ? `names "${target}", which is ITSELF — a collator dispatching its own follow-up work ` +
            `is a loop whose only bound is the collator's own judgement, which is model output`
          : `names "${target}", which is another collator — nesting a fan-out inside a fan-out ` +
            `makes the tree unbounded and attribution ambiguous`;
      return {
        kind: "refused",
        code: "collator_target",
        reason:
          `${at} ${arm} (SRD-REVIEW-CONSOLE D7, §6.10). A collator may dispatch only to this ` +
          `console's reviewers: ${roster.reviewers.join(", ")}.`,
      };
    }

    if (!roster.reviewers.includes(target)) {
      return {
        kind: "refused",
        code: "worker_not_in_console",
        reason:
          `${at} names worker "${target}", which is not one of this console's reviewers ` +
          `(${roster.reviewers.join(", ")}) — SRD-REVIEW-CONSOLE D7, §6.10. A worker outside ` +
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
 * §7.3's table, as a check — the half the schema cannot answer.
 *
 * | Console | `services` present | `services` absent |
 * |---|---|---|
 * | **triage** | validated against `triage/targets.yaml` (§6.5) | `services_missing` |
 * | **review** | `services_not_permitted` | unchanged — exactly today's shape |
 *
 * **The two rows are ONE rule.** A field merely optional everywhere would make
 * `partition_incomplete` unreachable by the cheapest failure available to a
 * model — omitting it — *"and an unreachable refusal is a check that passes
 * because nothing asked."* So the absent arm and the present arm are both
 * refusals, on the console where each is wrong.
 *
 * **This runs AFTER `checkRoster`, and the ordering is a decision.** The roster
 * rules answer *"may this dispatch happen at all, and to whom"*: a request
 * naming `rev-arch-1` reaches a live worker with a live socket, so the dispatch
 * SUCCEEDS and leaves its only trace in a run nobody is watching. A capability
 * fault of that grade must never be masked by a complaint about a field's
 * absence, and the suite pins the pair — the same missing share with every
 * target legal reports `services_missing`, so swapping the two checks reddens
 * exactly one test.
 *
 * The entry INDEX is named for `checkRoster`'s reason: eight entries differing
 * only in one field are otherwise one line in a log, and the whole file is
 * refused either way (§6.4), so the operator needs to know which one to fix.
 */
function checkServices(
  request: DispatchRequest,
  roster: ConsoleRoster,
): DispatchRequestRead | null {
  for (const [index, entry] of request.requests.entries()) {
    /** 1-based, as `checkRoster` numbers them, so the two refusals agree. */
    const at = `request ${index + 1}`;

    if (roster.services === "required" && entry.services === undefined) {
      return {
        kind: "refused",
        code: "services_missing",
        reason:
          `${at} carries no "services" list, and this console requires one ` +
          `(SRD-TRIAGE-CONSOLE §7.3). The host validates the partition against the targets file ` +
          `before dispatching any of it (§6.5), and this field is the only machine-readable ` +
          `statement of which services a request covers — recovering it from the brief's prose ` +
          `is the one thing a check against a partitioning model must not depend on. The whole ` +
          `file is refused and nothing was dispatched.`,
      };
    }

    if (roster.services === "refused" && entry.services !== undefined) {
      return {
        kind: "refused",
        code: "services_not_permitted",
        reason:
          `${at} carries a "services" list, and this console declares no environment to check ` +
          `one against (SRD-TRIAGE-CONSOLE §7.3). A service list here would be a partition of ` +
          `nothing: accepted, never counted, and read by its author as honoured. Remove the ` +
          `field, or write this request on a console whose targets file declares those services.`,
      };
    }
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
 *   0. **Ids** — before anything else, because `ctx.taskId` is what the body's
 *      `parent_task_id` is checked AGAINST. A caller that read the bytes itself
 *      and passed a traversal as `taskId` would have the body's matching
 *      traversal accepted as agreeing with it.
 *   0b. **Sender** — before the document is even parsed. A non-collator's
 *      request is refused whatever it says, so nothing is learned by reading
 *      it first and a hostile document goes through one less parser.
 *   0c. **Depth** — D7's second arm, and it is here for the sender's reason.
 *      A request from a collation directory is refused whatever it says, so
 *      the one document written by a collator that has already fanned out
 *      once never reaches the parser at all.
 *   1. **Parse** — before any field is dereferenced.
 *   2. **Schema, strictly** — before any field is BELIEVED. D11's refusals live
 *      here so a forbidden field is refused by the same pass that refuses a
 *      missing one.
 *   3. **Identity** — the body's `parent_task_id` against the directory the
 *      file was found in. `harvest/outbox.ts:486-492` binds the other direction
 *      the same way and for the same reason: the directory was created by the
 *      host and the body is a claim.
 *   4. **Roster** — the rules that need to know who is asking and who exists.
 *   5. **The share** — §7.3's table, last, because a request that reaches
 *      outside its console must report the reach rather than a missing field.
 *      See `checkServices` for why that ordering is a decision and how it is
 *      pinned.
 */
export function parseDispatchRequest(body: string, ctx: DispatchRequestContext): DispatchRequestRead {
  const roster = resolveRoster(ctx);

  const badId = checkIds(ctx);
  if (badId !== null) return badId;

  const wrongSender = checkSender(ctx.sender, roster);
  if (wrongSender !== null) return wrongSender;

  const tooDeep = checkDepth(ctx.taskId);
  if (tooDeep !== null) return tooDeep;

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

  const refused = checkRoster(request, ctx.sender, roster);
  if (refused !== null) return refused;

  const wrongShare = checkServices(request, roster);
  if (wrongShare !== null) return wrongShare;

  return { kind: "ok", request };
}

/**
 * Read and validate `<outbox>/<task-id>/dispatch-request.json`.
 *
 * **The path is resolved EXACTLY ONCE and every question is then asked of the
 * descriptor.** This is the correction described in the module header, and the
 * reason it is worth this much prose is that the version it replaces looked
 * right: `lstat` the file, check three things, `readFile` the file. Three
 * correct checks, in the correct order, against the correct constants — and all
 * three were no-ops, because a check and a use that each resolve the same NAME
 * are two operations on two possibly-different inodes, in a directory whose
 * contents the adversary controls. There is no ordering of name-based checks
 * that fixes this; the fix is to stop asking twice.
 *
 * So the `open` below is the only resolution, and its FLAGS carry two of the
 * three checks into the one operation that cannot be raced:
 *
 *  - **`O_NOFOLLOW`** — the final component is not followed. A swap to a symlink
 *    is `ELOOP` (`EMLINK` on some BSDs) at open rather than a link the host
 *    cheerfully reads. This is the arm that returned `<run>/control-auth.json`,
 *    the per-run control-socket secret, into a refusal message and from there
 *    into an operator's terminal — `paths.ts:676-682` is explicit that a worker
 *    must never read that file.
 *  - **`O_NONBLOCK`** — a FIFO opens instead of blocking. Without it the open
 *    waits for a writer that never comes, holding a libuv threadpool slot
 *    forever; the default pool is FOUR, so four of these stop the actor
 *    dispatching AND harvesting, with no error, no timeout and no log line. It
 *    is the quietest failure available in this file.
 *
 * The type and size questions are then answered by `fstat` ON THE DESCRIPTOR,
 * so "is a regular file" and "is under the cap" are statements about the bytes
 * that are actually read rather than about whatever the name meant a moment
 * ago. A FIFO — which `O_NONBLOCK` lets through the open by design — is caught
 * here, which is why the type check must be an `fstat` and not merely an open
 * flag.
 *
 * **THE HONESTY PARAGRAPH — what this does NOT pin.** The size is checked
 * twice: once from the `fstat` and once from the bytes actually read. Neither
 * is INDEPENDENTLY pinned by a test, and that is stated rather than left to be
 * discovered. Disabling BOTH fails the suite, so the cap itself is held.
 * Disabling only one does not, because separating them needs the file to change
 * size between the `fstat` and the read, and forcing that ordering needs a hook
 * this module does not have. `harvest/outbox.ts:421-426` records the identical
 * gap for the identical reason; this is the same note, not a weaker one. What
 * IS directly pinned is every arm that can be built out of a real filesystem
 * object: a real symlink, a real FIFO, a real directory, and a file of exactly
 * the cap.
 *
 * **The sender check runs after the file is known to exist and before its
 * content is read, and both halves of that are chosen.**
 *
 * After existence, because the actor polls: a reviewer that has written nothing
 * must be `missing` and silent. If the sender were checked first, every tick
 * would emit a refusal for every non-collator in the console, and the one
 * refusal that means something — a reviewer that actually attempted a dispatch
 * — would be indistinguishable from the noise it was buried in. The `open` is
 * what answers existence now, so the check sits after it; opening is not
 * reading, and the descriptor is closed on that refusal like any other.
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
  const roster = resolveRoster(loc);

  // BEFORE the path is built, not after. `dispatchRequestPath` throws on an
  // unspellable id and this function does not throw, so the grammar has to be
  // satisfied here — and it has to be satisfied before `join` gets the chance
  // to resolve a `..` into a real path outside the outbox.
  const badId = checkIds(loc);
  if (badId !== null) return badId;

  const file = dispatchRequestPath(loc.runRoot, loc.sender, loc.taskId);

  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP" || code === "EMLINK") {
      return {
        kind: "refused",
        code: "not_a_regular_file",
        reason:
          `${DISPATCH_REQUEST_FILE} is a symlink and was not followed. The worker owns this ` +
          `directory, so a link is a request to have the host read a file of the worker's ` +
          `choosing and quote it back in a refusal. O_NOFOLLOW makes that an error at open ` +
          `rather than a check the worker can invalidate before the read.`,
      };
    }
    if (code === "ENOTDIR") {
      return {
        kind: "refused",
        code: "not_a_regular_file",
        reason:
          `${DISPATCH_REQUEST_FILE} could not be opened because a component of its path is not ` +
          `a directory. The task directory is created by the host; a worker that has replaced ` +
          `it with a file has restructured its own outbox.`,
      };
    }
    return {
      kind: "refused",
      code: "unreadable",
      reason: `${DISPATCH_REQUEST_FILE} could not be opened: ${String(err)}`,
    };
  }

  try {
    // fstat on the DESCRIPTOR. Every property below is therefore a property of
    // the bytes this function goes on to read, which is the whole difference
    // between this and a second `lstat` on the name.
    const st = await fh.stat();

    if (!st.isFile()) {
      return {
        kind: "refused",
        code: "not_a_regular_file",
        reason:
          `${DISPATCH_REQUEST_FILE} is not a regular file. A FIFO reaches here rather than ` +
          `wedging the open only because O_NONBLOCK was set; a directory and a device reach ` +
          `here too, and none of the three holds a document.`,
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

    const wrongSender = checkSender(loc.sender, roster);
    if (wrongSender !== null) return wrongSender;

    // `allocUnsafe`, not `alloc`: every byte is either overwritten by the read
    // or excluded by `subarray(0, total)`, so zero-filling 4 MiB for a document
    // that is almost always a few hundred bytes buys nothing.
    //
    // `cap + 1` is the point of the buffer. The fstat above is ADVISORY — the
    // worker can append between the fstat and the read — so the read re-enforces
    // the bound structurally: the buffer cannot grow, and filling it proves the
    // file outgrew the cap. The loop is here because a single `read` may return
    // short, and a short read would silently truncate a legal document into a
    // JSON syntax error that names the wrong problem.
    const buf = Buffer.allocUnsafe(MAX_DISPATCH_REQUEST_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_DISPATCH_REQUEST_BYTES) {
      return {
        kind: "refused",
        code: "too_large",
        reason:
          `${DISPATCH_REQUEST_FILE} exceeded ${MAX_DISPATCH_REQUEST_BYTES} bytes during the read. ` +
          `The size the fstat reported is advisory — the worker owns this directory and can ` +
          `append after it — so the read enforces the cap a second time, from the bytes.`,
      };
    }

    return parseDispatchRequest(buf.subarray(0, total).toString("utf8"), loc);
  } catch (err) {
    return {
      kind: "refused",
      code: "unreadable",
      reason: `${DISPATCH_REQUEST_FILE} could not be read: ${String(err)}`,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}
