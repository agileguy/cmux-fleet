/**
 * The fan-out, the join, and the collation decision — SRD-REVIEW-CONSOLE §6.6,
 * D4, D5, D6, D11.
 *
 * `dispatch-request.ts` decides whether a collator's file may be ACTED ON. This
 * module is what acting on it means: three reviewers dispatched concurrently,
 * joined, harvested, their replies published, and a collation task dispatched
 * back to the collator carrying an honest account of how many lenses actually
 * reported.
 *
 * **Nothing here performs I/O.** Every side effect is a method on an injected
 * `RelayTransport`, and the reason is not testability in the abstract — it is
 * that each of the four effects is unreachable from a unit test for a DIFFERENT
 * reason, so no single trick would have substituted for the seam:
 *
 * - `dispatch` is `sendTaskEnvelope`, which reads the worker's launch record to
 *   decide whether the prompt travels by RPC or is STAGED into an attended
 *   pane, builds the envelope from the run's worktree record, and writes the
 *   durable inbox entry. (It was `controlCall` here until the adapter landed,
 *   and that was wrong: `controlCall(…, {cmd: "dispatch"})` is the RPC half of
 *   a two-plane decision, and every pane on this console is `tui`.)
 * - `awaitSettled` **has no implementation in this repository to import.** There
 *   is no `waitForTerminal` helper: `pifleet wait` polls
 *   `readTaskRecord(taskRecordPath(...))` in a private closure at 100 ms, and
 *   `SchedulerIO.readSettled` is an interface the scheduler's caller supplies.
 *   Whoever owns the poll interval owns this, and that is the process of §6.5 —
 *   which is BLOCKING and unanswered. A module that imported a poller would have
 *   picked the answer to Q4 by accident.
 * - `harvest` is `harvestTask`, which clones a repository and may run acceptance
 *   commands in a container.
 * - `publishReply` writes a `0444` file into the `:ro` `/replies` mount (D6).
 *
 * So §6.5 changes where this is CALLED and changes nothing about what it
 * decides — the same property `dispatch-request.ts` was built for, and the
 * reason both modules can land while Q4 is open.
 *
 * ## The run handle is a type parameter because relay must never read one
 *
 * D4: the console is FOUR runs, not one. `up --attach-here` is the only way to
 * hand a terminal to a worker and it *creates* the run, so every `pane_mode: tui`
 * pane runs its own `pifleet up` and the actor holds a worker→run MAP. The
 * production handle is `RunPaths`; relay never opens it, never reads a secret
 * out of it, and never joins a path from it — it only routes it back to the
 * transport that handed it over.
 *
 * Making that a type parameter rather than importing `RunPaths` is not
 * abstraction for its own sake. It is the difference between a convention and a
 * compile error: a later edit that reached into a run for a socket or a task
 * record would fail to typecheck here, rather than work in production and take
 * the unit suite with it. It also keeps this module free of `paths.ts`, which is
 * what lets a test drive the whole join with three strings.
 *
 * ## Where the idempotency decision goes, and why it is not here
 *
 * **`relayFanOut` fans out every time it is called and holds no memory of having
 * done so. That is the contract, not an omission.**
 *
 * `readDispatchRequest` is idempotent-unfriendly by design: an accepted request
 * stays `ok` on every poll tick, and the file lives in a directory the WORKER
 * owns — so "delete the file after acting on it" and "remember the task id"
 * both fail against a hostile or confused collator, the first because the worker
 * can rewrite it and the second because the actor can restart. The fact that
 * matters ("has parent T already been fanned out?") is durable state with
 * exactly one correct writer, and that writer is `relay-journal.ts`.
 *
 * **The seam is the CALL SITE.** The caller asks the journal, and only enters
 * this function if the answer is no. A private `seen` set in this module would
 * be a second writer of that fact, which is how two components come to disagree
 * about whether a fan-out happened — and the disagreement is silent, because
 * both are individually consistent. `collator-relay.test.ts` pins the absence.
 *
 * ## What this module does NOT bound, so the silence is not read as coverage
 *
 * §6.10's "at most one unsettled fan-out per collator" is the journal's, for the
 * same reason. This module closes the DEPTH arm of that hazard (`isCollationTaskId`,
 * consumed by `dispatch-request.ts`) and leaves the REPEAT arm — a collator
 * rewriting `/outbox/T/dispatch-request.json` under the same parent on a later
 * tick — entirely to the journal. The two are complementary and neither implies
 * the other: the depth bound is a property of an ID and needs no state, and the
 * repeat bound is a property of HISTORY and cannot be had without it.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { existsSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { runsRoot as runsRootEager, runPaths as runPathsEager } from "./paths.ts";

import { SESSION_ID_RE, type Verdict } from "../contracts.ts";
import { replyMountPath } from "./replies.ts";
import type { DispatchRequest } from "./dispatch-request.ts";
import type { RunPaths } from "./paths.ts";
import type { RelayFanOutInput, RelayFanOutResult } from "../cli/commands/relay.ts";

/**
 * The id grammar, RE-EXPORTED from `run/task-ids.ts`.
 *
 * It moved out of this file so that `run/collation.ts` could consult
 * `collationTaskId` and `isCollationTaskId` without reaching this module — which
 * names `cli/commands/relay.ts` in a type import and `import()`s
 * `cli/commands/dispatch.ts` below, and so drags the whole CLI command registry
 * into any closure that reaches it. That closure is the monitor's (ISC-468), and
 * `task-ids.ts`'s header records the exact chain.
 *
 * Re-exported rather than left for callers to re-address, because every existing
 * import of these names is correct and this move is not their business.
 */
export {
  COLLATION_ASPECT,
  MAX_RELAY_TASK_ID_CHARS,
  REVIEW_CONSOLE_ASPECTS,
  RelayAspectError,
  childTaskId,
  collationTaskId,
  isCollationTaskId,
  spellable,
  type AspectSeat,
} from "./task-ids.ts";

import {
  COLLATION_ASPECT,
  MAX_RELAY_TASK_ID_CHARS,
  REVIEW_CONSOLE_ASPECTS,
  RelayAspectError,
  childTaskId,
  collationTaskId,
  isCollationTaskId,
  spellable,
  type AspectSeat,
} from "./task-ids.ts";

/**
 * The table's checks, each closing a hole that reads as obviously correct.
 *
 * Empty is the degenerate one: a console with no lenses dispatches nothing and
 * reports nothing, forever, and looks healthy. Duplicate WORKERS would derive
 * two task ids for one seat holder; duplicate ASPECTS would derive one task id
 * for two workers, so the second dispatch would replay the first's task rather
 * than run — and the consensus arithmetic would then count one reader twice,
 * which is the exact fabrication `duplicate_target` refuses in the request.
 *
 * The collation collision is the subtle one: a seat named `collate` derives a
 * child id `isCollationTaskId` answers `true` for, so T5's depth bound would
 * refuse a legitimate first-round fan-out from that child. Two rules that are
 * each correct, composing into a console that cannot review anything.
 */
function resolveAspects(aspects: readonly AspectSeat[] | undefined): readonly AspectSeat[] {
  const seats = aspects ?? REVIEW_CONSOLE_ASPECTS;
  if (seats.length === 0) throw new RelayAspectError("it names no aspects");

  const workers = new Set<string>();
  const names = new Set<string>();
  for (const seat of seats) {
    if (!spellable(seat.worker)) {
      throw new RelayAspectError(`${JSON.stringify(seat.worker)} is not a legal worker id`);
    }
    if (!spellable(seat.aspect)) {
      throw new RelayAspectError(
        `${JSON.stringify(seat.aspect)} is not a legal aspect name — an aspect becomes a segment ` +
          `of every task id derived for it`,
      );
    }
    if (seat.aspect === COLLATION_ASPECT) {
      throw new RelayAspectError(
        `"${seat.worker}" holds an aspect named "${COLLATION_ASPECT}", which is the suffix a ` +
          `COLLATION id is derived with. Its child id would be indistinguishable from a ` +
          `collation, and the depth bound in dispatch-request.ts would refuse a legitimate ` +
          `first-round fan-out from it`,
      );
    }
    if (workers.has(seat.worker)) {
      throw new RelayAspectError(`"${seat.worker}" holds two aspects`);
    }
    if (names.has(seat.aspect)) {
      throw new RelayAspectError(
        `the aspect "${seat.aspect}" is held by two workers, so both would derive the SAME child ` +
          `task id — the second dispatch would replay the first's task rather than run, and the ` +
          `console would count one reader twice`,
      );
    }
    workers.add(seat.worker);
    names.add(seat.aspect);
  }
  return seats;
}

/** A task, addressed. */
export interface RelayTaskRef {
  readonly worker: string;
  readonly taskId: string;
}

/** A task, addressed and briefed. */
export interface RelayDispatch extends RelayTaskRef {
  readonly title: string;
  readonly brief: string;
}

/** What a settled child turned out to be. */
/**
 * THE PER-ARTIFACT CAP — the most any one artifact may contribute to a reply.
 *
 * 64 KiB, and the number is derived rather than picked. `MAX_DISPATCH_TEXT` is
 * 32 KiB: the largest `brief` a collator may send a reviewer. A review should be
 * able to say more than the request that asked for it, and twice is the smallest
 * ratio that is obviously "more" rather than "the same order". It is also a
 * QUARTER of the reply budget below, which is what guarantees that no single
 * artifact can starve the others: four artifacts always fit at full size, and
 * the fifth onward compete under an allocation that is fair by construction.
 *
 * For scale: 64 KiB of markdown is roughly a 10,000-word review. A reviewer
 * whose honest review exceeds that has written something no collator was going
 * to read in one pass anyway — and it is not silently cut. It arrives truncated,
 * with the omission NAMED in the collation brief, which is the difference
 * between a review the collator knows is partial and one it believes is whole.
 */
export const MAX_REPLY_ARTIFACT_BYTES = 64 * 1024;

/**
 * THE PER-REPLY CAP — the most all artifacts together may contribute.
 *
 * 256 KiB, and it is `MAX_DISPATCH_POLICY_BYTES` deliberately. That constant
 * bounds `/policy/dispatch`, the drop a worker RECEIVES, on the argument that
 * *"a reader that discovers the size has already paid for it"*. This is the
 * return leg of the same exchange, read by the same kind of reader, so it takes
 * the same number: one bound for both directions is one thing to remember and
 * one thing to change.
 *
 * `replies.ts` records this decision as OWED — *"whether the drop needs a byte
 * cap the way `/policy/dispatch` does"* — and reserves it, with the schema, for
 * the actor. This is the actor, and this is the answer.
 *
 * **Both caps, not either.** A per-artifact cap alone bounds nothing: fifty
 * artifacts at 64 KiB is a 3 MiB reply. A per-reply cap alone lets one artifact
 * consume the whole budget and starve every other — and which one wins would
 * then depend on the order the filesystem happened to enumerate them, so which
 * half of a review survives would be decided by `readdir`. That is the class of
 * defect this branch has spent its time removing, and it must not be introduced
 * by the fix for a different one.
 */
export const MAX_REPLY_INLINE_BYTES = 256 * 1024;

/** One artifact's contents, as far as the budget allowed. */
export interface InlinedArtifact {
  /** The artifact's host path, as the harvest recorded it. */
  readonly path: string;
  /** Its size on disk. */
  readonly bytes: number;
  /** How many bytes actually reached the reply. */
  readonly included_bytes: number;
  /**
   * Whether anything was cut. `included_bytes < bytes`.
   *
   * A FIELD and not something a reader infers by comparing two numbers, because
   * the collation brief has to name truncated artifacts the way §6.6 names a
   * missing lens, and a brief that had to do arithmetic to find them would be
   * one refactor away from not doing it.
   */
  readonly truncated: boolean;
  /** Why nothing could be read at all, or `null`. Distinct from truncation. */
  readonly unreadable: string | null;
  /** The contents, up to `included_bytes`. */
  readonly text: string;
}

/**
 * Split a byte budget across artifacts so that ENUMERATION ORDER CANNOT DECIDE
 * WHICH REVIEW SURVIVES.
 *
 * The obvious implementation — walk the list, give each what it wants until the
 * budget is gone — is first-come-first-served, and the "first" is whatever order
 * the artifact list happens to arrive in. Under it a reviewer that writes a
 * large log before its review loses the review, and a reviewer that writes them
 * the other way round keeps it. The console's output would depend on a
 * filesystem detail, and it would look correct every time.
 *
 * This is max-min fair allocation instead. Sort by WANT ascending, and give each
 * artifact in turn the lesser of what it wants and an equal share of what is
 * left; anything an under-budget artifact does not use flows to the ones that
 * do. Small artifacts are always satisfied in full, large ones divide the
 * remainder evenly, and the result depends only on the SET of sizes — reordering
 * the input cannot change any artifact's allocation.
 *
 * Returns a budget per artifact, index-aligned with `sizes`.
 */
export function planInlineBudget(
  sizes: readonly number[],
  opts: { perArtifact?: number; total?: number } = {},
): number[] {
  const perArtifact = opts.perArtifact ?? MAX_REPLY_ARTIFACT_BYTES;
  const total = opts.total ?? MAX_REPLY_INLINE_BYTES;
  const granted = new Array<number>(sizes.length).fill(0);
  if (sizes.length === 0) return granted;

  // What each artifact would take if nothing else existed.
  const want = sizes.map((n) => Math.max(0, Math.min(n, perArtifact)));

  /**
   * Ascending by want, ties broken by INDEX so the order is total and stable.
   * The tie-break matters: two artifacts of identical size must not swap
   * allocations between runs, or a re-harvest of the same task would produce a
   * different reply and the digest that names it would stop meaning anything.
   */
  const order = want
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w === b.w ? a.i - b.i : a.w - b.w));

  let remaining = total;
  order.forEach((entry, seen) => {
    const share = Math.floor(remaining / (order.length - seen));
    const give = Math.min(entry.w, share);
    granted[entry.i] = give;
    remaining -= give;
  });
  return granted;
}

/**
 * WHAT BECAME OF A LENS' RESULT ENVELOPE — and the distinction exists because
 * the console once attributed a serialisation failure to a reviewer.
 *
 * ## The run that made this a type
 *
 * `rev-lang-1` wrote a genuine 3906-byte review into its result envelope. Its
 * seat is regex correctness, so the review quoted a regex into a JSON string —
 * `[\w\\-_]+`. `\w` is not a valid JSON escape, so the envelope did not parse,
 * the harvest answered `unknown`, and this module wrote *"it settled `unknown`
 * and produced no report"* into the collation brief. The collation then recorded
 * `{"reported": false, "note": "the lens settled 'unknown' and produced no
 * report"}` and the result was `partial`.
 *
 * **"Produced no report" was false.** The report existed, at a path, at a size a
 * person could have opened. Every word of the record was about the REVIEWER and
 * every part of the failure was in the TRANSPORT, so the one instruction an
 * operator needed — *re-run this lens, and meanwhile go read the file* — was the
 * one the console had made unavailable.
 *
 * **It is structural rather than unlucky.** The language seat is the seat whose
 * job is quoting code into a JSON string, so it is the seat most likely to put
 * an invalid escape in one. Naming only that instance would leave the next one
 * to be discovered the same way.
 *
 * ## Why three states and not a boolean
 *
 * `absent` and `unreadable` are DIFFERENT INSTRUCTIONS, which is the whole test
 * for whether a distinction is worth a type. `absent` means the reviewer
 * produced nothing and the lens is written off. `unreadable` means a review
 * exists on disk, a human can go and read it, and the lens should be re-run
 * rather than written off. A boolean `reported` collapses them, and prose in a
 * `note` field carries the difference only for as long as nobody rewrites the
 * sentence.
 *
 * `present` is the third rather than an implied default so the union is
 * exhaustive and a `switch` over it is checked. It says the envelope parsed —
 * which is not the same as the task having succeeded, and the note below is
 * careful about that.
 *
 * ## THE SEAM, AND WHOSE IT IS
 *
 * **This module does not classify. It reads a classification the harvester
 * makes**, through `RelayHarvestView` and out through `RelayHarvest`, and it is
 * adapted at exactly one expression in `consoleTransport.harvest` so that
 * reconciling this shape with the harvester's own is a rename rather than a
 * rewrite. Nothing here opens an envelope, and nothing here decides what
 * "unreadable" means — a relay that re-derived that judgement would be a second
 * answer to a question `harvest/outbox.ts` already spends its header on.
 */
/**
 * The harvester's two envelope fields, resolved into one state.
 *
 * A function rather than a ternary because the mapping now has four inputs and
 * two of them deliberately produce nothing; a conditional expression that has to
 * explain two silences is a conditional expression nobody edits correctly.
 */
function relayEnvelopeState(bundle: {
  readonly unreadableEnvelope?: RelayUnreadableEnvelope | null;
  readonly envelopeRead?: "ok" | "missing" | "unreadable" | "refused" | null;
  readonly envelopeRefusal?: string | null;
}): RelayEnvelopeState | undefined {
  if (bundle.unreadableEnvelope != null) {
    return { kind: "unreadable", ...bundle.unreadableEnvelope };
  }
  if (bundle.envelopeRead === "missing") return { kind: "absent" };
  if (bundle.envelopeRead === "ok") return { kind: "present" };
  /**
   * `refused` USED TO LAND HERE AS `undefined`, and that was the same defect
   * the `absent` arm was written to fix, one arm over.
   *
   * `undefined` on this field means NOTHING LOOKED, and a refusal is the
   * opposite of that: an envelope was found, parsed, and rejected for what it
   * said. Collapsing the two gave the strongest signal the console has — a
   * document that exists and is wrong — the weakest sentence it prints. The
   * docblock above said the two silences were deliberate, and a docblock does
   * not bind a reader who branches on `undefined`; the type does.
   *
   * `null` still maps to nothing, and that one IS deliberate: no reader looked,
   * so there is no fact to report.
   */
  if (bundle.envelopeRead === "refused") {
    return { kind: "refused", reason: bundle.envelopeRefusal ?? null };
  }
  /**
   * The harvester said UNREADABLE and the structure did not arrive.
   *
   * Ordered last on purpose: the arm above it consumes the same word when the
   * structure IS present, so this is reached only by the inconsistent bundle.
   * Falling through to `undefined` here would say nothing looked, about an
   * envelope a reader looked at and failed to parse.
   */
  if (bundle.envelopeRead === "unreadable") return { kind: "unreadable_unspecified" };
  return undefined;
}

export type RelayEnvelopeState =
  | { readonly kind: "present" }
  /** The harvest looked for an envelope and there was none. */
  | { readonly kind: "absent" }
  /**
   * An envelope EXISTS and could not be read.
   *
   * No field is decorative: the path is what a person opens, the size is what
   * tells them there is something in it worth opening, and the code and detail
   * are what tell them whether to re-run the lens or fix the reader. A shape
   * carrying only a reason string would be prose with a type annotation, and the
   * note built from it would be as unfalsifiable as the one this replaces.
   */
  | ({ readonly kind: "unreadable" } & RelayUnreadableEnvelope)
  /**
   * An envelope EXISTS, PARSED, and was rejected for what it says.
   *
   * Distinct from `unreadable` on the axis that decides what an operator does
   * next: an unreadable envelope is a transport or serialisation fault and the
   * review may be recoverable off disk, while a refused one is a well-formed
   * document making a claim the console will not accept — a foreign task id, a
   * stale epoch, a path climbing out of the outbox. `reason` is the harvester's
   * own sentence and is `null` only when the refusal reached here without one.
   */
  | { readonly kind: "refused"; readonly reason: string | null }
  /**
   * An envelope EXISTS and could not be read, and the DETAILS did not reach
   * here — a seam-integrity arm, and the reason it is a state rather than a
   * silence.
   *
   * `relayEnvelopeState` takes two independent fields: the harvester's own
   * verdict word, and the structure describing an unreadable one. Today's only
   * producer sets both together, so this arm carries no traffic. The type
   * permitted the combination anyway, and what it used to produce for it was
   * `undefined` — the value that means NOTHING LOOKED. That is the exact
   * substitution that cost a day: a document that exists, described with the
   * sentence for a reviewer who wrote nothing.
   *
   * It is deliberately NOT the `unreadable` arm with blanked fields. Every
   * field there is load-bearing — the path is what a person opens — and a
   * placeholder path is worse than an admission. This arm says the true thing:
   * the lens was applied, its report is unreadable, and where it sits is not
   * known from here. The recovery instruction is unchanged, which is why the
   * brief treats the two together.
   *
   * A transport that serialises `envelopeRead` and drops the nested structure
   * makes this reachable. That is the transport this exists for.
   */
  | { readonly kind: "unreadable_unspecified" };

/**
 * THE HARVESTER'S OWN DESCRIPTION OF AN UNREADABLE ENVELOPE, spelled
 * STRUCTURALLY so `harvest/outbox.ts`'s `UnreadableEnvelope` satisfies it.
 *
 * **The field names are that type's, deliberately.** They could have been
 * translated at the adapter; they are not, because a translation is a second
 * vocabulary for one fact and the day the two drift the console reports a
 * `code` that no longer means what this module thinks it means. Spelling them
 * identically makes the adapter a spread and makes any change to the
 * harvester's shape a COMPILE error here rather than a silent mismatch.
 *
 * **And structural rather than an import**, which is this module's standing rule
 * — `RelayTaskRecordView` and `RelayHarvestView` are structural for the same
 * reason. `relay.ts` is reached BY the CLI through a dynamic import; a static
 * type dependency on `src/harvest/` would put the harvester in the graph of a
 * module that only ever needs its shape.
 */
export interface RelayUnreadableEnvelope {
  /** HOST path of the file. Absolute, and openable by a PERSON — not by the collator. */
  readonly path: string;
  /** Bytes handed to the parser. Legitimately `0`; never a proxy for existence. */
  readonly bytes: number;
  /** Syntax or contract, as a value rather than as a sentence. */
  readonly code: string;
  /** The parser's or validator's own complaint. Never this module's paraphrase. */
  readonly detail: string;
}

/**
 * ONE ENTRY IN A SILENT LENS' OUTBOX — a name, what it is, and a size.
 *
 * **The field names are `harvest/task-outbox.ts`'s, deliberately**, for
 * `RelayUnreadableEnvelope`'s reason exactly: a translation is a second
 * vocabulary for one fact, and the day the two drift the console reports a size
 * that no longer means what this module thinks it means. Spelling them
 * identically makes the adapter a pass-through.
 *
 * **THERE IS NO FOURTH FIELD AND THERE MUST NEVER BE ONE THAT CAME FROM THE
 * ENTRY'S CONTENTS.** This value is rendered into a collation brief, which is a
 * prompt handed to a model, and everything under a worker's outbox is
 * worker-authored (§12.5). A preview, a first line, a "detected schema" — any of
 * them would carry attacker-controlled text into the collator's context through
 * a channel that today cannot carry it at all. The producer takes a `readdir`
 * and an `lstat` and nothing else; this shape is what makes that boundary
 * visible from here.
 */
export interface RelayOutboxEntry {
  /** The entry's own name, already swept for control characters by the harvester. */
  readonly name: string;
  /** `file`, `directory`, `symlink` or `other` — a value, not a paraphrase. */
  readonly kind: string;
  /** Size for a REGULAR FILE only; `null` for everything else. Never inferred. */
  readonly bytes: number | null;
}

/**
 * WHAT A LENS' TASK OUTBOX HELD, when the harvest listed it.
 *
 * ## The fact this type exists to carry
 *
 * `rev-lang-1` wrote a complete 12,759-byte review to
 * `/outbox/<task>/artifact.json` — the task ROOT, under a name it invented —
 * and wrote no `result.json` and no `files/`. The harvest's two readers look at
 * exactly those two names, so both missed it, and the brief said the lens
 * *"settled `unknown` and no report reached the collator"*. True, and the whole
 * of what anybody was told.
 *
 * `empty` and `unrecognised` are the distinction that was missing. Keeping them
 * apart is the entire value: `empty` is what licenses the strong claim that a
 * reviewer left nothing behind, and `unrecognised` withdraws it.
 *
 * ## What a consumer may NOT conclude from `unrecognised`
 *
 * That a review was found. An outbox holding `notes.txt` and an outbox holding
 * a complete review are IDENTICAL through this type, because the bytes were
 * never read — so every sentence built from it has to be true of both. Saying
 * what was found is the whole permission; saying what it means is not granted.
 */
export type RelayOutboxListing =
  /** Nothing could be listed — no directory, or a failed read. Claims NOTHING. */
  | { readonly kind: "unlistable" }
  /** Listed, and holding nothing the harvest does not already read. */
  | { readonly kind: "empty" }
  /** Listed, and holding entries in neither place the harvest reads. */
  | {
      readonly kind: "unrecognised";
      /** Bounded by the harvester; `total` is what says whether it was cut. */
      readonly named: readonly RelayOutboxEntry[];
      /** EVERY unrecognised entry, counted — including any not named. */
      readonly total: number;
    };

export interface RelayHarvest {
  /**
   * The harvester's verdict — `harvestTask(...).harvest.verdict`.
   *
   * `TaskHarvest` also carries `harvestStatus`, which is ORTHOGONAL: it says
   * whether the harvest is trustworthy, not what the task did. It is not needed
   * here, because an untrustworthy harvest already yields `verdict: "unknown"`,
   * and `unknown` is not `success` — so a lens whose harvest was unavailable is
   * a missing lens by the same rule as one that failed, with no second test.
   */
  readonly verdict: Verdict;
  /** The bytes published to `/replies/<child>.json` for the collator to read. */
  readonly reply: unknown;
  /**
   * What was inlined, and what was cut.
   *
   * Carried OUT of the harvest rather than left inside the reply payload,
   * because the collation brief has to name a truncation and the brief is built
   * from `RelayChild`, not from the reply bytes. A brief that had to re-open the
   * reply to discover an omission would be reading the very document whose
   * completeness is in question.
   *
   * **Optional, because the CORE must not require inlining.** `RelayTransport`
   * is a seam over four host effects and a transport that publishes a reply
   * without reading artifacts is legitimate — the fan-out's arithmetic does not
   * depend on it. Requiring the field would make every hand-built transport in
   * the suite carry an empty array to say nothing, which is how a field comes to
   * be filled in without being meant. The production adapter always supplies it.
   */
  readonly inlined?: readonly InlinedArtifact[];
  /**
   * What became of this task's result envelope, when the transport looked.
   *
   * **Optional for `inlined`'s reason, and the consequence of that is stated
   * rather than left to be discovered.** A transport that never inspects an
   * envelope is legitimate, and requiring the field would make every hand-built
   * transport in the suite carry a value to say nothing. What must NOT follow is
   * that silence is read as evidence: `undefined` here means *nobody looked*,
   * and the note built from it says only what is true from the collator's side —
   * that no report reached it. The claim *"produced no report"* is reserved for
   * `absent`, which is the state where somebody did look.
   *
   * That is the difference between this optionality and the defect it closes.
   * The live console asserted the strong claim from exactly this state.
   */
  readonly envelope?: RelayEnvelopeState;
  /**
   * What this task's outbox held, when the transport listed it.
   *
   * **Optional for `envelope`'s reason, and `undefined` means the same thing:
   * NOBODY LOOKED.** It is deliberately not the same value as `unlistable`,
   * which means somebody looked and could not list — and neither of them is
   * `empty`, which is the only one that supports a claim about what a reviewer
   * left behind. Three states, because collapsing any two of them manufactures
   * evidence, which is the failure this whole area is a repair of.
   */
  readonly outbox?: RelayOutboxListing;
}

/**
 * The four host effects, injected.
 *
 * `R` is the run handle and relay never inspects it — see the module docblock.
 * The transport closes over whatever `controlCall` and `harvestTask` need.
 *
 * **`publishReply` is on this interface rather than left to the caller, and the
 * ordering is why.** D6's cost is that the collation brief carries three PATHS,
 * so a brief naming a file that is not on disk yet is a collator reading
 * `ENOENT` and reporting a lens as missing that was never missing. That ordering
 * is a correctness property of the JOIN, so it lives where the join lives.
 * Returning the payloads and trusting a caller to write them before dispatching
 * would put a race in a docstring.
 */
export interface RelayTransport<R> {
  /**
   * Dispatch a task into a worker's own run.
   *
   * REJECTS if the dispatch did not land. The production adapter turns both
   * failure shapes into a rejection: the dispatch path THROWS for an
   * unreachable worker or a terminal that has gone, and RESOLVES with
   * `{accepted: false, reason: ...}` for a supervisor-side refusal. A rejection
   * here costs one lens, not the fan-out.
   *
   * **`pane_mode_tui_has_no_rpc_dispatch` is NOT one of those refusals**, and
   * the correction is worth recording because this docblock used to say it was.
   * D13 makes all four panes `tui`, so if it were, the adapter would be refused
   * for every seat and the console would journal three children it never
   * dispatched. An attended worker simply has no RPC dispatch surface: its
   * envelope is STAGED, and `via: "staged"` is a success. The adapter delegates
   * that choice to `sendTaskEnvelope` and examines only `accepted`.
   */
  dispatch(run: R, dispatch: RelayDispatch): Promise<void>;
  /** Resolve once the task has reached a terminal state, however that is observed. */
  awaitSettled(run: R, task: RelayTaskRef): Promise<void>;
  /** Harvest a settled task. */
  harvest(run: R, task: RelayTaskRef): Promise<RelayHarvest>;
  /** Write `<child>.json` into the collator's `/replies` mount. */
  publishReply(collatorRun: R, childTaskId: string, reply: unknown): Promise<void>;
}

/** One lens after the join. Every seat appears, whether or not it was asked. */
export interface RelayChild {
  readonly worker: string;
  readonly aspect: string;
  /** The derived id, or `null` for a seat the request never named. */
  readonly taskId: string | null;
  /**
   * The harvester's or supervisor's verdict, VERBATIM.
   *
   * `unknown` for a seat that was never dispatched, which is the lattice
   * identity and the honest value: nothing was learned about that lens.
   * `timed_out` and `aborted` are carried unchanged rather than folded to
   * `failed` — see `succeeded`.
   */
  readonly verdict: Verdict;
  readonly succeeded: boolean;
  /**
   * Whether a dispatch for this lens ACTUALLY LANDED.
   *
   * **Distinct from `taskId !== null`, and the distinction is what makes the
   * journal honest.** `taskId` is the id this lens was PLANNED under: it is
   * populated the moment the fan-out decides to ask for the lens, and it
   * survives a dispatch that was refused, so a reader using it as evidence of a
   * dispatch records three reviews for a fan-out that issued none.
   * `relay-journal.ts` documents its `children` as "the child task ids the
   * fan-out issued … written by the thing that actually performed the
   * dispatches", and this is the field that makes that sentence true.
   */
  readonly issued: boolean;
  /**
   * What this lens' artifacts contributed, and what was cut.
   *
   * Empty for a lens that never reported. Carried here because the collation
   * brief names a truncation the way it names a missing lens, and the brief is
   * built from these children.
   */
  readonly inlined: readonly InlinedArtifact[];
  /**
   * What became of this lens' result envelope, or `null` when no harvest ran.
   *
   * **`null` is a fourth state and is not `absent`.** A seat the request never
   * named, a dispatch that was refused and a harvest that threw are all cases
   * where nothing ever looked for an envelope — so they support no claim about
   * one, and folding them into `absent` would manufacture the same evidence the
   * defect above manufactured, at a different seam. Their notes are about
   * dispatch and stay about dispatch.
   *
   * Carried as a FIELD and not left only in `note` for the reason
   * `InlinedArtifact.truncated` is a field: the collation brief has to name the
   * unreadable lenses on their own line, and a brief that had to match English
   * to find them would be pinning a sentence rather than a fact.
   */
  readonly envelope: RelayEnvelopeState | null;
  /**
   * What this lens' task outbox held, or `null` when no harvest listed it.
   *
   * `null` is a FOURTH state beside the listing's own three and is not
   * `unlistable` — a seat the request never named and a dispatch that was
   * refused never reached an outbox at all, so nothing here even attempted the
   * `readdir` that `unlistable` reports the failure of.
   *
   * Carried as a FIELD and not left only in `note` for `envelope`'s reason: a
   * consumer that had to recover "this outbox was not empty" by matching
   * English would be pinning a sentence rather than a fact, and the sentence is
   * the part that gets rewritten.
   */
  readonly outbox: RelayOutboxListing | null;
  /** Why this lens is missing, in a form the collation brief can print. */
  readonly note: string;
}

export type RelayRefusal = "run_unresolved" | "underivable_id";

export type RelayOutcome =
  | { kind: "refused"; code: RelayRefusal; reason: string }
  | { kind: "not_collated"; reason: string; children: readonly RelayChild[] }
  /**
   * Lenses were asked for and NOT ONE dispatch landed.
   *
   * **Split out of `not_collated` because the two shared a `kind` and a child
   * count while meaning opposite things, and the shared one was journalled.**
   * §6.6's `not_collated` is "every lens reported and none survived" — real work
   * happened, three tasks exist, and the journal must record them or the next
   * tick runs them again. This is "nothing was ever started", and journalling it
   * marks a fan-out complete that never occurred: `already_done` on every later
   * tick, the reviews never run, and the operator's row says
   * `dispatched 3 children`. Permanent, silent, and the exact defect class the
   * wrong-verb fix closed once already.
   *
   * **Reachable without anything being broken.** A second review requested while
   * round one's reviewers are mid-turn: every `stage` reaches
   * `EpochManager.allocate`, which answers `busy` while a fence is live
   * (`rpc/epoch.ts`), `stageForAdoptedTerminal` throws on a refused stage, and
   * all three dispatches reject. Three closed reviewer terminals reach it too,
   * through `terminalRefusal`.
   *
   * `children` is carried so the notes survive — each one says why its lens
   * never left the host — and the caller retries, because a busy console is a
   * console that will be free later.
   */
  | { kind: "none_landed"; reason: string; children: readonly RelayChild[] }
  | {
      kind: "collated";
      collation: RelayDispatch;
      /**
       * COVERAGE — how many lenses reported, counted by the HOST.
       *
       * This replaces a `claim: "success" | "partial"` that was handed to the
       * collator as its envelope status, and §9 Q6 is why. Two different
       * questions were sharing one word: a COMPLETE review of shaky code and a
       * BROKEN review of sound code both read `partial`, so the field an
       * operator scans first was the one field that could not separate *the
       * console failed* from *the code has problems*.
       *
       * **The measured consequence was worse than the ambiguity.**
       * `censusCeiling` declines on any claim that is not `success`
       * (`harvest/collation-census.ts`), and the old `claim` told the collator
       * to write `partial` whenever a lens was missing — so the structural
       * quality check was switched OFF for exactly the reviews most likely to
       * be thin, the ones that had just lost a lens. Separating the axes is
       * what lets that ceiling engage where it was always meant to.
       *
       * Counted here rather than asked of the model, because the host is the
       * only party that knows it: it issued the dispatches and harvested the
       * replies. `finding_count`'s precedent — a worker-authored number
       * published beside the counted one so a disagreement can be READ — is
       * deliberately not followed, because coverage was never the worker's to
       * claim.
       */
      coverage: { reported: number; dispatched: number };
      children: readonly RelayChild[];
      /**
       * The seats that produced no review. Empty exactly when
       * `coverage.reported === coverage.dispatched`.
       */
      missing: readonly AspectSeat[];
    }
  /**
   * Everything happened EXCEPT the last hop: the reviews ran, the replies are on
   * disk, and the collation could not be delivered.
   *
   * **A third arm rather than a throw, and the journal is the whole argument.**
   * A throw propagates through `relayPass`, which deliberately does not journal
   * on a throw — correct for a fan-out that aborted early, and exactly wrong
   * here, because by this point three reviews have been dispatched and three
   * `0444` replies published. The next tick would re-read the same request and
   * do it all again, every tick, forever. That is the unbounded repeat the
   * journal exists to prevent, reached through the one dispatch the fan-out did
   * not guard.
   *
   * **And a third arm rather than folding into `collated`**, because the two are
   * different facts and only one of them needs an operator. `collated` means the
   * collator holds a brief; this means it does not, and that the reports are
   * sitting in its `/replies` mount with nothing telling it to read them. A
   * reader that could not tell those apart would see a console that reviewed
   * everything and concluded nothing, with no row anywhere saying why.
   *
   * `missing` is carried unchanged and is usually EMPTY here — every lens can
   * have reported perfectly. The failure is the host's last hop, not any
   * reviewer's, and the shape says so.
   */
  | {
      kind: "collation_failed";
      /** The dispatch that did not land, so a caller need not parse the reason. */
      collation: RelayDispatch;
      coverage: { reported: number; dispatched: number };
      children: readonly RelayChild[];
      missing: readonly AspectSeat[];
      reason: string;
    };

export interface RelayInput<R> {
  /** A request `readDispatchRequest` already answered `ok` for. */
  readonly request: DispatchRequest;
  /** The collator. Structural identity from the outbox directory, never a claim. */
  readonly sender: string;
  /** worker → run. D4: this console is four runs, so this is a map and not a run. */
  readonly runs: ReadonlyMap<string, R>;
  readonly transport: RelayTransport<R>;
  /** Defaults to `REVIEW_CONSOLE_ASPECTS`; see that constant for why it is a parameter. */
  readonly aspects?: readonly AspectSeat[];
}

/** A seat the request actually named, with its derived id and its brief. */
interface Planned {
  readonly seat: AspectSeat;
  readonly taskId: string;
  readonly title: string;
  readonly brief: string;
}

/**
 * §6.6's whole exchange: fan out, join, decide, collate.
 *
 * **Synchronous on its aspect table and asynchronous on everything else.** The
 * table is validated before the returned promise exists, so a malformed one
 * throws at the call rather than rejecting later — a console whose lenses are
 * unusable must not dispatch AT ALL, and an actor that discovers this inside a
 * `.catch` has already been running for an hour.
 */
export function relayFanOut<R>(input: RelayInput<R>): Promise<RelayOutcome> {
  const seats = resolveAspects(input.aspects);
  return fanOut(input, seats);
}

async function fanOut<R>(
  input: RelayInput<R>,
  seats: readonly AspectSeat[],
): Promise<RelayOutcome> {
  const { request, sender, runs, transport } = input;
  const parent = request.parent_task_id;

  // ── Plan, entirely, before anything is dispatched ──────────────────────────
  //
  // Every id is derived and every run resolved up front, because §6.6's "in one
  // pass" is not a property of a pass abandoned partway. A fan-out that issued
  // two of three and then discovered the third worker had no run would leave two
  // reviews running that nobody joins, nobody harvests and nobody reaps.
  //
  // The seats are walked in TABLE order and the request is consulted only to ask
  // whether a seat was named. That is D11 in the control flow: walking
  // `request.requests` instead would let the collator choose the order lenses
  // are reported in, and one refactor later, which lenses exist.
  let collationId: string;
  const planned: Planned[] = [];
  try {
    collationId = collationTaskId(parent);
    for (const seat of seats) {
      const entry = request.requests.find((r) => r.worker === seat.worker);
      if (entry === undefined) continue;
      planned.push({
        seat,
        taskId: childTaskId(parent, seat.aspect),
        title: entry.title,
        brief: entry.brief,
      });
    }
  } catch (err) {
    return {
      kind: "refused",
      code: "underivable_id",
      reason:
        `no child id could be derived from parent task "${parent}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const collatorRun = runs.get(sender);
  if (collatorRun === undefined) {
    return {
      kind: "refused",
      code: "run_unresolved",
      reason:
        `the collator "${sender}" has no run in the worker→run map, and the /replies mount that ` +
        `carries every reply back to it lives in that run (D6). Under D4 this console is FOUR ` +
        `runs — each tui pane runs its own \`pifleet up --attach-here\` — so a missing entry here ` +
        `is a console that was only partly built, not a worker that died.`,
    };
  }

  const routed: Array<Planned & { run: R }> = [];
  for (const p of planned) {
    const run = runs.get(p.seat.worker);
    if (run === undefined) {
      return {
        kind: "refused",
        code: "run_unresolved",
        reason:
          `reviewer "${p.seat.worker}" (aspect "${p.seat.aspect}") has no run in the worker→run ` +
          `map, so no socket could be reached for it. Nothing was dispatched: issuing the other ` +
          `lenses first would leave reviews running that no join is waiting on.`,
      };
    }
    routed.push({ ...p, run });
  }

  // ── Fan out, CONCURRENTLY, in one pass (§6.6, §1.3) ───────────────────────
  //
  // This is an anti-criterion rather than a preference. Every brief is built
  // above, from the request alone, before a single dispatch is issued — so a
  // child's brief is byte-independent of every other child's result by
  // CONSTRUCTION, not by care. And `allSettled`, not `all`: a fan-out that
  // rejected on the first failed dispatch would abandon two perfectly good
  // reviews, so a dispatch that does not land costs its own lens and nothing
  // else.
  //
  // §1.3 is why this must not be relaxed into a loop that reads better: the
  // skill's consensus bands are arithmetic over INDEPENDENT readers, so a
  // sequential fan-out that handed rev-arch's report to rev-ctx would produce a
  // 3/3 that is one reader with three transcripts. It would look like a smarter
  // design and nothing downstream would notice.
  const issued = await Promise.allSettled(
    routed.map((p) =>
      transport.dispatch(p.run, {
        worker: p.seat.worker,
        taskId: p.taskId,
        title: p.title,
        brief: p.brief,
      }),
    ),
  );

  const landed = routed.filter((_, i) => issued[i]?.status === "fulfilled");
  const failedDispatch = new Map<string, string>();
  routed.forEach((p, i) => {
    const outcome = issued[i];
    if (outcome === undefined || outcome.status !== "rejected") return;
    const err: unknown = outcome.reason;
    failedDispatch.set(
      p.seat.aspect,
      `its dispatch never landed (${err instanceof Error ? err.message : String(err)})`,
    );
  });

  // ── Join ──────────────────────────────────────────────────────────────────
  //
  // Concurrently as well, and only over the tasks that exist: waiting on a task
  // whose dispatch was refused is polling for a record that cannot appear.
  await Promise.allSettled(
    landed.map((p) => transport.awaitSettled(p.run, { worker: p.seat.worker, taskId: p.taskId })),
  );

  const harvests = await Promise.allSettled(
    landed.map((p) => transport.harvest(p.run, { worker: p.seat.worker, taskId: p.taskId })),
  );

  const result = new Map<string, RelayHarvest>();
  /**
   * WHY A REJECTED HARVEST IS RECORDED RATHER THAN ONLY ABSENT.
   *
   * The dispatch arm twenty lines up captures its rejection into the child's
   * note; this one used to check `status === "fulfilled"` and let the reason
   * fall on the floor, so every harvest failure printed one fixed sentence. A
   * `StateReadError` from a torn `state.json` — which `readTaskRecord` really
   * does throw — was reported with strictly LESS information than a refused
   * dispatch, and the asymmetry read as an oversight because it was one.
   *
   * This does not change which lenses are lost. It changes whether the operator
   * is told why, which is the difference this console spent a branch learning.
   */
  const failedHarvest = new Map<string, string>();
  landed.forEach((p, i) => {
    const h = harvests[i];
    if (h?.status === "fulfilled") {
      result.set(p.seat.aspect, h.value);
      return;
    }
    const err: unknown = h?.reason;
    failedHarvest.set(p.seat.aspect, err instanceof Error ? err.message : String(err));
  });

  // ── The lattice, and what is NOT put into it ──────────────────────────────
  //
  // `contracts.ts:71-79` is `failed < blocked < partial < success` and `rank()`
  // answers -1 outside it. `timed_out` and `aborted` are SUPERVISOR verdicts —
  // they describe the worker, not the task — so `min` is undefined over them and
  // no comparison here is made against them. The partition is on `success`
  // alone, and every other verdict is carried through VERBATIM.
  //
  // Folding a supervisor verdict to `failed` on the way in is the tempting bug:
  // it makes the value a lattice member and it reads as conservative. What it
  // actually does is record that a reviewer produced a failing review, when what
  // happened is that it never reported at all — and those are different facts
  // for anyone reading the console's output afterwards.
  const children: RelayChild[] = seats.map((seat) => {
    const plan = planned.find((p) => p.seat.aspect === seat.aspect);
    if (plan === undefined) {
      return {
        worker: seat.worker,
        aspect: seat.aspect,
        taskId: null,
        verdict: "unknown",
        succeeded: false,
        issued: false,
        inlined: [],
        envelope: null,
        outbox: null,
        note: "the request never named this reviewer, so the lens was not applied",
      };
    }
    const dispatchNote = failedDispatch.get(seat.aspect);
    if (dispatchNote !== undefined) {
      return {
        worker: seat.worker,
        aspect: seat.aspect,
        taskId: plan.taskId,
        verdict: "unknown",
        succeeded: false,
        // PLANNED but never issued — see `RelayChild.issued`. The id is kept so
        // an operator can correlate the refusal; it is not evidence of a dispatch.
        issued: false,
        inlined: [],
        envelope: null,
        outbox: null,
        note: dispatchNote,
      };
    }
    const harvested = result.get(seat.aspect);
    if (harvested === undefined) {
      return {
        worker: seat.worker,
        aspect: seat.aspect,
        taskId: plan.taskId,
        verdict: "unknown",
        succeeded: false,
        issued: true,
        inlined: [],
        envelope: null,
        outbox: null,
        note: harvestFailureNote(failedHarvest.get(seat.aspect)),
      };
    }
    const envelope = harvested.envelope ?? null;
    const outbox = harvested.outbox ?? null;
    return {
      worker: seat.worker,
      aspect: seat.aspect,
      taskId: plan.taskId,
      verdict: harvested.verdict,
      succeeded: harvested.verdict === "success",
      issued: true,
      inlined: harvested.inlined ?? [],
      envelope,
      outbox,
      note:
        harvested.verdict === "success"
          ? ""
          : missingLensNote(harvested.verdict, envelope, outbox),
    };
  });

  // ── Nothing left the host ─────────────────────────────────────────────────
  //
  // Checked BEFORE the survivor count, because `survived.length === 0` is true
  // of both this and an honest `not_collated` and only one of them may be
  // journalled. `routed.length > 0` is the discriminator that keeps them apart:
  // it says lenses were ASKED FOR. When it is zero the request named no seat
  // this console holds — nothing was attempted and nothing failed, which is a
  // valid no-op that SHOULD be journalled rather than re-evaluated forever.
  if (routed.length > 0 && landed.length === 0) {
    return {
      kind: "none_landed",
      reason:
        `${routed.length} lens/lenses were dispatched and NOT ONE landed, so nothing is running ` +
        `and nothing may be journalled — a record here would mark this fan-out done and the ` +
        `reviews would never run. The pass retries. Per lens: ` +
        children
          .filter((c) => c.taskId !== null)
          .map((c) => `${c.aspect} — ${c.note}`)
          .join("; "),
      children,
    };
  }

  const survived = children.filter((c) => c.succeeded);
  const missing = children.filter((c) => !c.succeeded);

  // ── Zero succeeded: nothing to collate (§6.6) ─────────────────────────────
  //
  // No replies are published either. Three `0444` files in a `:ro` mount that no
  // brief names are three files nothing reads and nothing reaps, and the next
  // fan-out under a different parent would find them still there.
  if (survived.length === 0) {
    return {
      kind: "not_collated",
      reason:
        `no child succeeded, so there is nothing to collate and no collation task was ` +
        `dispatched (SRD-REVIEW-CONSOLE §6.6). The collator's own result for "${parent}" ` +
        `stands. Per lens: ` +
        children.map((c) => `${c.aspect} — ${c.note}`).join("; "),
      children,
    };
  }

  // ── Publish, THEN collate (D6) ────────────────────────────────────────────
  //
  // Ordering, not convention: the brief carries paths, so every path in it names
  // a file already on disk. Only surviving lenses get a reply — a file at a
  // reply path IS a lens as far as the collator can tell, so publishing an empty
  // one for a reviewer that timed out would hand it a fourth thing to read and a
  // reason to believe three lenses reported.
  for (const child of survived) {
    const harvested = result.get(child.aspect);
    if (harvested === undefined || child.taskId === null) continue;
    await transport.publishReply(collatorRun, child.taskId, harvested.reply);
  }

  const missingSeats = missing.map((c) => ({ worker: c.worker, aspect: c.aspect }));
  const coverage = { reported: survived.length, dispatched: children.length };
  const collation: RelayDispatch = {
    worker: sender,
    taskId: collationId,
    title: `Collate the review of ${parent}`,
    brief: collationBrief(parent, children, coverage),
  };

  // The collation is dispatched to a COLLATOR, which D7 forbids a REQUEST from
  // naming. There is no tension: D7 bounds what a container may ask the host to
  // do, and this is the host completing an exchange it started. The collator
  // cannot cause it — it can only cause the fan-out that leads here, once, which
  // is what `isCollationTaskId` above bounds.
  //
  // CAUGHT, and `collation_failed` explains why at length. The short form: a
  // throw from here discards the record of three reviews that actually ran, and
  // the next pass runs them again.
  try {
    await transport.dispatch(collatorRun, collation);
  } catch (err) {
    return {
      kind: "collation_failed",
      collation,
      coverage,
      children,
      missing: missingSeats,
      reason:
        `every lens was dispatched and ${survived.length} reply/replies were published, but the ` +
        `collation "${collation.taskId}" could not be delivered to "${sender}": ` +
        `${err instanceof Error ? err.message : String(err)}. The reviews are NOT re-run — the ` +
        `children are journalled because they happened — so the reports stand in the collator's ` +
        `/replies mount with nothing yet telling it to read them.`,
    };
  }

  return { kind: "collated", collation, coverage, children, missing: missingSeats };
}

/**
 * WHY A HARVESTED LENS IS MISSING — one sentence, and each arm claims only what
 * its state supports.
 *
 * This function is the fix. The sentence it replaces was
 * `it settled \`${verdict}\` and produced no report`, emitted for every
 * non-success harvest, and it made two assertions the console was in no position
 * to make. *"Produced no report"* is a claim about the REVIEWER, and the
 * envelope is the only thing that can support it. *"It settled"* reads as the
 * reviewer having reached a conclusion, when `unknown` is the harvester saying
 * it could not tell.
 *
 * ## The arms, and what each is allowed to say
 *
 * - **`unreadable`** — the strong specific claim, and the only one that names a
 *   file. It says a report EXISTS, gives the three facts needed to act on it,
 *   and puts the failure where it happened. It deliberately does not use the
 *   word "produced", which is the word the false version turned on.
 * - **`absent`** — keeps *"produced no report"*, because here it is a FACT:
 *   something looked for an envelope and there was none. Weakening this arm too
 *   would be the opposite over-correction, leaving a console that can no longer
 *   say the true strong thing about the case where it is true.
 * - **`present`** — the envelope parsed and the task still did not succeed. The
 *   reviewer reported; `fanOut` publishes a reply only for a lens that
 *   SUCCEEDED, so the report exists and did not travel. Saying "produced no
 *   report" here would be the original defect in its second-most-likely form.
 * - **`null`** — nothing looked, so nothing is claimed about the reviewer at
 *   all. Only the collator's own position is stated, which is the one thing
 *   that is true from here regardless.
 *
 * The verdict is quoted in every arm because it is the harvester's own word and
 * an operator correlating a lens against `report` needs it. What changed is that
 * it is no longer the SOURCE of the claim about the report.
 *
 * ## THE OUTBOX CLAUSE — a fact ADDED to two arms, not a fifth arm
 *
 * A second live review lost a second lens and every sentence above stayed true.
 * `rev-lang-1` wrote a complete 12,759-byte review to
 * `/outbox/<task>/artifact.json` — the task ROOT, under a name it invented —
 * and no `result.json`. The harvest looks at `result.json` and at `files/`, so
 * both of its readers missed it, and this function said *"it settled `unknown`
 * and no report reached the collator"*. That is HONEST and it is the whole
 * finding: nothing said that 12,759 bytes were sitting one directory from a
 * reader.
 *
 * So `outboxClause` is appended to the two arms where NO ENVELOPE EXISTS —
 * `null` and `absent` — and to no others. It does not re-decide the taxonomy
 * and it does not weaken an arm:
 *
 *   - **`absent` keeps *"produced no report"***, because it stays a fact: no
 *     result envelope exists. The clause reports a DIFFERENT region and lets a
 *     reader see the tension for themselves rather than resolving it here.
 *   - **`unreadable` and `present` get nothing**, because there the harvest HAS
 *     the worker's account and already names the file to open. A second
 *     inventory beside it would dilute the one actionable path.
 */
/**
 * What to say about a lens whose harvest did not return.
 *
 * A reason is included when there is one, and the sentence stays whole when
 * there is not: `undefined` here means the harvest resolved and produced no
 * entry, which is a different fact from a harvest that threw.
 */
export function harvestFailureNote(reason: string | undefined): string {
  return reason === undefined
    ? "it was dispatched but could not be harvested"
    : `it was dispatched and its harvest FAILED: ${reason}`;
}

function missingLensNote(
  verdict: Verdict,
  envelope: RelayEnvelopeState | null,
  outbox: RelayOutboxListing | null,
): string {
  if (envelope === null) {
    return `it settled \`${verdict}\` and no report reached the collator${outboxClause(outbox)}`;
  }
  switch (envelope.kind) {
    case "unreadable":
      return (
        `it settled \`${verdict}\` and its report WAS WRITTEN AND COULD NOT BE READ: ` +
        `${envelope.path} is ${envelope.bytes} bytes and did not parse ` +
        `(${envelope.code}: ${envelope.detail}). This is a transport failure, not a reviewer ` +
        `that found nothing — the review exists on disk and no report reached the collator`
      );
    case "unreadable_unspecified":
      return (
        `it settled \`${verdict}\` and its report WAS WRITTEN AND COULD NOT BE READ. Where the ` +
        `file sits and why it failed to parse did not reach the collator, so this note cannot ` +
        `name them — but the review exists and this is a transport failure, not a reviewer that ` +
        `found nothing${outboxClause(outbox)}`
      );
    case "absent":
      return (
        `it settled \`${verdict}\` and produced no report — no result envelope exists for it` +
        `${outboxClause(outbox)}`
      );
    case "refused":
      return (
        `it settled \`${verdict}\` and its report WAS WRITTEN AND WAS REFUSED` +
        `${envelope.reason === null ? "" : `: ${envelope.reason}`}. The document parsed — this is ` +
        `a review the console declined to accept, not a reviewer that found nothing and not a ` +
        `file it could not read${outboxClause(outbox)}`
      );
    case "present":
      return (
        `it settled \`${verdict}\`; its result envelope was readable, and no report reached the ` +
        `collator because a reply is published only for a lens that succeeded`
      );
  }
}

/**
 * ONE ENTRY, rendered. `artifact.json (12759 bytes)`.
 *
 * Deliberately carries NO adjective. Not "large", not "substantial", not
 * "likely the report" — every one of those is a claim about content nothing
 * read. The size is a measurement; an adjective is an interpretation, and the
 * whole discipline here is that the interpretation is the reader's.
 *
 * A size is printed for a regular file and NOTHING is printed in its place for
 * anything else. A number beside a symlink would be read as a measurement of
 * its target, and `lstat` never looked at one.
 */
function describeOutboxEntry(e: RelayOutboxEntry): string {
  if (e.kind === "directory") return `${e.name}/ (directory, not descended)`;
  if (e.kind === "symlink") return `${e.name} (symlink, not followed)`;
  if (e.kind !== "file") return `${e.name} (not a regular file)`;
  return e.bytes === null ? `${e.name} (size unavailable)` : `${e.name} (${e.bytes} bytes)`;
}

/**
 * WHETHER THE SILENT LENS' OUTBOX WAS EMPTY — appended to the note, or nothing.
 *
 * ## Every clause has to be true of `notes.txt` AND of a complete review
 *
 * That is the honest edge and it is what most of the wording below is arranged
 * around. The listing is names and sizes taken by `readdir` and `lstat`; the
 * bytes were never read, and must not be, because this sentence is rendered
 * into a prompt handed to a model and everything under a worker's outbox is
 * worker-authored (§12.5). From here, an outbox holding a stray scratch file
 * and one holding the lost review are INDISTINGUISHABLE. So the clause states
 * what was found, states that nothing opened it, and stops — the reader is told
 * where to look and is not told what they will find.
 *
 * ## Silence for the two states that are not evidence
 *
 * `null` (nobody looked) and `unlistable` (somebody looked and could not list)
 * both yield the empty string, so the note is byte-identical to what it was
 * before this clause existed. Neither says anything about the reviewer, and
 * manufacturing a sentence from either would be the original defect committed
 * again at a new seam.
 *
 * ## The empty arm earns its words
 *
 * It is tempting to say nothing when there is nothing there. But *"produced no
 * report"* is a claim someone has to be able to trust, and an operator reading
 * a note with no clause cannot tell whether the outbox was checked and found
 * bare or was never checked at all — which is precisely the ambiguity this
 * whole change exists to remove. So the empty case says so out loud.
 *
 * ## Bounded, and it declares the bound
 *
 * A worker can fill its task root. The harvester caps what it NAMES and carries
 * the true `total`, and this says how many were left unnamed rather than
 * truncating in silence — a reader must never be left inferring that the list
 * is complete.
 */
function outboxClause(outbox: RelayOutboxListing | null): string {
  if (outbox === null || outbox.kind === "unlistable") return "";
  if (outbox.kind === "empty") {
    return (
      `. Its task outbox WAS checked and holds nothing besides what the harvest already ` +
      `reads, so there is no other file to look in`
    );
  }
  const more = outbox.total - outbox.named.length;
  return (
    `. Its task outbox is NOT EMPTY: the task root holds ${outbox.total} ` +
    `entr${outbox.total === 1 ? "y" : "ies"} that the harvest does not read — it reads only ` +
    `the result envelope and the files/ directory. Listed by name and size ONLY; nothing here ` +
    `opened them, so nothing here can say what any of it contains — a person has to look: ` +
    `${outbox.named.map(describeOutboxEntry).join(", ")}` +
    `${more > 0 ? `, and ${more} more not named` : ""}`
  );
}

/**
 * The collation brief — and the missing-lens clause is the load-bearing part.
 *
 * §6.6: *"The collator must be told in its brief which aspects are missing,
 * because a collator that does not know it is missing a lens will write a
 * confident three-lens conclusion from two — and `report` has no way to detect
 * that."*
 *
 * So the missing lenses are named on their own lines, in a form that is ABSENT
 * for the lenses that reported. A brief that listed all three unconditionally
 * would satisfy "the brief names the aspect" and communicate nothing, which is
 * why `collator-relay.test.ts` asserts the negative alongside the positive.
 *
 * The claimed status is stated rather than implied for the same reason it
 * matters at all: because the lattice combines by `min`, an honest `partial` can
 * never be lifted back to `success` by anything downstream
 * (`adjudicate.ts:14`) — and equally, a `success` claimed over two lenses can
 * never be corrected. There is one chance to say this and it is here.
 */
function collationBrief(
  parent: string,
  children: readonly RelayChild[],
  coverage: { reported: number; dispatched: number },
): string {
  const survived = children.filter((c) => c.succeeded);
  const missing = children.filter((c) => !c.succeeded);
  const lines: string[] = [];

  lines.push(`Collate the reviews dispatched from task ${parent}.`);
  lines.push("");
  /**
   * `a report you can read`, and the three words are the sentence's correction.
   *
   * *"N produced a report; M did not"* asserts of the M that they produced
   * nothing, which is the same false claim the per-lens note carried and is
   * false in exactly the same case: a lens whose envelope would not parse
   * produced a report and did not produce one you can read. Qualifying the
   * SURVIVORS' clause makes the missing clause true by subtraction, without the
   * summary having to know which kind of missing each one is — the per-lens
   * lines below carry that.
   */
  lines.push(
    `This console has ${children.length} review lenses. ${survived.length} produced a report ` +
      `you can read; ${missing.length} did not.`,
  );
  lines.push("");
  lines.push("REPORTS — read each of these files. They are the only reports that exist:");
  for (const c of survived) {
    if (c.taskId === null) continue;
    lines.push(`  - ${c.aspect} (${c.worker}): ${replyMountPath(c.taskId)}`);
  }

  if (missing.length > 0) {
    lines.push("");
    for (const c of missing) {
      lines.push(`MISSING ASPECT: ${c.aspect} (${c.worker}) — ${c.note}.`);
    }
    lines.push("");
    lines.push(
      `You are collating WITHOUT ${missing.map((c) => c.aspect).join(", ")}. Do not write a ` +
        `conclusion that implies ${missing.length === 1 ? "that lens was" : "those lenses were"} ` +
        `applied, and say in your findings which lenses each one rests on.`,
    );

    /**
     * ── THE UNREADABLE LENSES, NAMED SEPARATELY FROM THE ABSENT ONES ────────
     *
     * The `MISSING ASPECT` line above already carries the path, the size and
     * the parse error, so this block is not repeating the facts. It carries the
     * INSTRUCTION, which is what differs: an absent lens is written off, and an
     * unreadable one is a review that exists and should be re-run. A collator
     * told only "these lenses are missing" treats both the same way, and the
     * whole point of the distinction is that it should not.
     *
     * **Conditional on there BEING one, for the reason the truncation section
     * one function down had to learn.** An unconditional block emits no per-lens
     * lines when nothing was unreadable, so every positive assertion still
     * passes while every brief warns about a hazard it does not have — and a
     * warning that appears on every brief is one a reader learns to skip.
     *
     * **It does NOT tell the collator to mark the lens `reported: true`.** The
     * collator has not read the review; `reported` is about what reached the
     * collator, and a lens credited here could then be named in `raised_by`,
     * which is the 3/3 fabrication §6.8 exists to make impossible. What changes
     * is the stated REASON, not the row.
     */
    // Both unreadable arms, because the INSTRUCTION is the same one: the lens
    // was applied and its review should be re-run. Only the note above differs,
    // and it differs by naming a file or admitting it cannot.
    const unreadableLenses = missing.filter(
      (c) => c.envelope?.kind === "unreadable" || c.envelope?.kind === "unreadable_unspecified",
    );
    for (const c of unreadableLenses) {
      lines.push("");
      lines.push(
        `UNREADABLE ENVELOPE: ${c.aspect} (${c.worker}) reviewed the change and its report did ` +
          `not reach you. Record it as "reported": false — you have not read it — with the ` +
          `reason above in its note. Do NOT record it as a lens that found nothing or was not ` +
          `applied: it was applied. Say in your prose report that this lens' review exists and ` +
          `was not readable, so that a person can open the file and re-run the lens.`,
      );
    }

    /**
     * ── AND THE REFUSED LENSES, WHICH ARE NOT THE UNREADABLE ONES ───────────
     *
     * The block above exists because "absent" and "unreadable" call for
     * different actions. `refused` is a third action, and collapsing it into
     * either of the other two states something false about a real document.
     *
     * **The distinction is the recovery.** An unreadable envelope is damaged:
     * the reviewer's work may be partly or wholly unrecoverable. A refused one
     * PARSED — it is complete, well-formed, and sitting on disk exactly as the
     * reviewer wrote it. The console declined it over something in what it
     * said, which is usually one field. A person can open that file and read
     * the entire review, and telling them the report was "not readable" would
     * send them looking for damage in a file that has none.
     *
     * **MEASURED, and this is the wording that failed.** A reviewer's envelope
     * carrying a verdict, a summary and fourteen findings — two of them HIGH —
     * was refused over the spelling of a single artifact path. Every surface
     * downstream described that lens the way it describes a reviewer who wrote
     * nothing. The whole cost of the incident was in that description.
     *
     * `reported` stays false here for the same reason it does above: the
     * collator has not read the review, and a lens credited without being read
     * can be named in `raised_by`, which is the §6.8 fabrication. What changes
     * is the REASON and the recovery, not the row.
     */
    const refusedLenses = missing.filter((c) => c.envelope?.kind === "refused");
    for (const c of refusedLenses) {
      lines.push("");
      lines.push(
        `REFUSED ENVELOPE: ${c.aspect} (${c.worker}) reviewed the change and wrote a report that ` +
          `PARSED and was then declined by the console for the reason above. Record it as ` +
          `"reported": false — you have not read it — with that reason in its note. Do NOT ` +
          `record it as a lens that found nothing, was not applied, or could not be read: the ` +
          `review is complete and legible on disk. Say in your prose report that this lens' ` +
          `review was written and rejected, and name the reason, so that a person can open the ` +
          `file and read the findings this collation does not contain.`,
      );
    }
  }

  /**
   * ── TRUNCATION IS NAMED, exactly the way a MISSING LENS is ────────────────
   *
   * §6.6's argument for naming a missing aspect transfers word for word: *"a
   * collator that does not know it is missing a lens will write a confident
   * three-lens conclusion from two — and `report` has no way to detect that."*
   * A collator that does not know a review was CUT writes a confident whole
   * conclusion from a partial document, and nothing downstream can detect that
   * either. It is the worse of the two, because a truncated review reads as a
   * complete review that found less — there is no gap in it to notice.
   *
   * So the cut is a line of its own, per artifact, with both byte counts. Prose
   * that trailed off, or a footer saying "some content was truncated", would
   * satisfy a reader skimming for honesty and tell the collator nothing it can
   * act on. An UNREADABLE artifact is listed separately: the file existed and
   * its bytes did not arrive at all, which is a different fact from a file that
   * arrived short, and folding the two would make the count meaningless.
   *
   * Only SURVIVING lenses are considered. A lens that never reported is already
   * a `MISSING ASPECT` line, and listing its artifacts as truncated as well
   * would name one absence twice.
   */
  const cut = survived.flatMap((c) =>
    c.inlined.filter((a) => a.truncated).map((a) => ({ aspect: c.aspect, a })),
  );
  const unreadable = survived.flatMap((c) =>
    c.inlined.filter((a) => a.unreadable !== null).map((a) => ({ aspect: c.aspect, a })),
  );

  if (cut.length > 0 || unreadable.length > 0) {
    lines.push("");
    for (const { aspect, a } of cut) {
      lines.push(
        `TRUNCATED: ${aspect}'s artifact ${a.path} is ${a.bytes} bytes and only the first ` +
          `${a.included_bytes} reached you. You are reading a PART of that document.`,
      );
    }
    for (const { aspect, a } of unreadable) {
      lines.push(
        `UNREADABLE: ${aspect}'s artifact ${a.path} (${a.bytes} bytes) could not be read — ` +
          `${a.unreadable}. None of it reached you.`,
      );
    }
    lines.push("");
    lines.push(
      `Do not present a conclusion drawn from a truncated or unreadable artifact as though you ` +
        `had the whole of it. Say which findings rest on a partial document.`,
    );
  }

  lines.push("");
  lines.push(
    `COVERAGE: ${coverage.reported} of ${coverage.dispatched} lenses reported. That is the host's ` +
      `own count, taken from what it dispatched and what it harvested, and it is recorded whatever ` +
      `you write.`,
  );
  lines.push("");
  /**
   * Status is the COLLATION's, never coverage restated — §9 Q6.
   *
   * The instruction is spelled as a rule plus its boundary rather than a value
   * to copy, because the value it used to carry was a coverage fact wearing a
   * verdict's clothes. A collator that faithfully collates two reports has done
   * its work; the lens that never arrived is an input it did not choose and is
   * already recorded twice, on the line above and in `lenses[].reported`.
   */
  lines.push(
    `Write your result envelope with status "success" if you have faithfully collated the reports ` +
      `that reached you — INCLUDING when a lens did not report. A missing lens is an input fact, ` +
      `not a failure of yours, and it is already recorded above and in lenses[].reported. Use ` +
      `"partial" only when YOUR OWN collation is incomplete: you could not finish it, or you are ` +
      `presenting conclusions you could not check. Do not restate coverage as your status.`,
  );
  return lines.join("\n");
}

// ===========================================================================
// THE PRODUCTION ADAPTER — `consoleFanOut` and the four host effects.
// ===========================================================================
//
// Everything above this line is pure and holds the run as an opaque type
// parameter. Everything below it is the half that touches the host, and it is
// in THIS file rather than a module of its own for the reason
// `src/cli/commands/relay.ts` gives when it names the symbol it looks up:
// `RelayTransport` is declared here, and splitting an interface from its only
// implementation across two modules is how the two drift.
//
// ## Why the four real modules are imported LAZILY and not at the top
//
// The module docblock says relay is kept free of `paths.ts`, and that "is what
// lets a test drive the whole join with three strings". That property is
// load-bearing for `collator-relay.test.ts`, which imports this file: a static
// import of `harvest/index.ts` would pull the repository-cloning, container-
// running half of the codebase into the import graph of a suite whose whole
// point is that it needs none of it.
//
// So the four production effects are resolved by a memoised dynamic import on
// FIRST USE. The types come in through `import type`, which is erased, so the
// compile-time coupling is complete and the runtime coupling is zero until
// somebody actually dispatches something. `import type { RelayFanOutInput }`
// from the CLI is the same trick doing something sharper: that module
// dynamically imports THIS one, so a value import would be a genuine cycle.

/**
 * A task record, as much of it as the poll needs.
 *
 * Structural rather than `TaskRecord` itself, so nothing here depends on
 * `state.ts` at runtime. The real record satisfies it by having a `verdict`,
 * and the production wiring below is where that is checked by the compiler.
 */
export interface RelayTaskRecordView {
  readonly verdict: Verdict;
}

/** A harvest bundle, likewise — `TaskHarvest` satisfies it. */
export interface RelayHarvestView {
  readonly harvest: {
    readonly verdict: Verdict;
    /**
     * `HarvestedArtifactSchema` narrowed to what the budget needs: a host path
     * and a size. Optional because a task may produce no file artifacts at all,
     * which is a kind of task rather than a degraded harvest.
     */
    readonly artifacts?: readonly { readonly path: string; readonly bytes: number }[];
  };
  /**
   * `TaskHarvest.unreadableEnvelope` — the harvester's own field, by its own
   * name, read in exactly one expression.
   *
   * ## The seam, and the ONE THING IT STILL CANNOT SAY
   *
   * `harvest/outbox.ts` distinguishes four outcomes for a result envelope:
   * `missing`, `unreadable`, `refused` and `ok`. This bundle field surfaces
   * exactly one of them structurally, so **`null` here means "not unreadable"
   * and conflates an ABSENT envelope with a PRESENT one.**
   *
   * That is why the adapter maps `null` to `undefined` and NOT to
   * `{kind: "absent"}`. An absent envelope supports the strong claim *"produced
   * no report"*; a present one does not, and from `null` alone this module
   * cannot tell which it is holding. Manufacturing `absent` from it would be the
   * original defect committed a second time, one seam further down — asserting
   * something about a reviewer that the data does not support. So the console
   * says only what it can: no report reached the collator.
   *
   * **The remedy is one more bit from the harvester, not a guess here.** The
   * `absent` arm of `RelayEnvelopeState` exists, is exercised by the core's own
   * probes, and starts carrying production traffic the day this bundle can say
   * that an envelope was looked for and was not there.
   *
   * Optional so `TaskHarvest` satisfies this interface both before and after
   * that field lands; see `RelayHarvest.envelope` for what silence means.
   */
  readonly unreadableEnvelope?: RelayUnreadableEnvelope | null;
  /**
   * `TaskHarvest.envelopeRead` — the bit the seam above says it is missing,
   * arriving for the SAME question at last.
   *
   * `unreadableEnvelope` cannot tell absent from present, so the adapter
   * declined to guess and `RelayEnvelopeState`'s `absent` arm carried no
   * production traffic: it was written, documented and probed, and nothing
   * could ever reach it. This says which outcome the harvester's own reader
   * reached, so `absent` is now reachable by fact rather than by inference.
   *
   * `"refused"` maps to NOTHING, deliberately. A refusal is not a readability
   * outcome — `harvest/outbox.ts` keeps it separate precisely because a
   * traversal attempt or a stale epoch is a document rejected for WHAT IT IS,
   * not one that could not be read — and none of `present`, `absent` or
   * `unreadable` is true of it.
   *
   * **IT NOW HAS ITS OWN ARM RATHER THAN BEING DECLINED**, and the correction
   * is worth keeping because the first version of this comment argued the
   * opposite. Declining was right about the taxonomy — a refusal really is none
   * of the other three — and wrong about what to do next: mapping it to
   * `undefined` did not record "no arm fits", it recorded "nothing looked",
   * which is the one thing that is definitely false about a document the
   * console read and rejected. The fix was a fourth arm, not a fourth silence.
   *
   * Optional so `TaskHarvest` satisfies this interface both before and after the
   * field landed.
   */
  readonly envelopeRead?: "ok" | "missing" | "unreadable" | "refused" | null;
  /**
   * `TaskHarvest.envelopeRefusal` — the reason behind a `refused`, by its own
   * name. Optional on the same terms as the field above.
   */
  readonly envelopeRefusal?: string | null;
  /**
   * `TaskHarvest.taskOutbox` — the harvester's own field, by its own name.
   *
   * **This is the bit the seam above says it is missing, arriving for a
   * different question.** `unreadableEnvelope` cannot tell absent from present
   * and the adapter therefore declines to guess; this one has no such gap,
   * because the harvester computes it on EVERY harvest and its three states are
   * exhaustive over what a `readdir` can find. So it is carried straight
   * through, and the adapter's only decision is `null`/absent → `undefined`,
   * which is the same "nobody looked" that `RelayHarvest.outbox` documents.
   *
   * It does NOT close the `absent` gap and must not be read as closing it. This
   * says what is in the task root; it says nothing about whether `result.json`
   * was looked for — a `result.json` present but unreadable and one that was
   * never there both leave the listing identical. Two different questions about
   * one directory.
   *
   * Optional so `TaskHarvest` satisfies this interface both before and after the
   * field landed.
   */
  readonly taskOutbox?: RelayOutboxListing | null;
}

/**
 * The host effects, one level below `RelayTransport`.
 *
 * `RelayTransport` is what the JOIN needs; this is what the transport needs.
 * The extra layer earns itself twice. It is where the injectable clock lives —
 * without which the deadline below could only be tested by waiting half an hour
 * for it — and it is what keeps every path derivation out of this module: each
 * method takes a run and a worker and resolves its own path, so `paths.ts` is
 * named in the production wiring and nowhere else.
 */
/**
 * What one dispatch attempt turned out to be — `SendOutcome`, narrowed to the
 * fields the join can act on.
 *
 * **`via` is carried even though nothing here branches on it, and that is the
 * point.** `rpc`, `pane` and `staged` are three different claims about how a
 * prompt reached a worker, and all three can arrive with `accepted: true`. A
 * shape that dropped the field would make a staged dispatch and an RPC one
 * literally indistinguishable to a test — which is precisely how an adapter
 * that could only speak RPC passed a suite that thought it covered dispatch.
 */
/**
 * How a prompt reaches a worker — and the only classification the relay makes.
 *
 * `"typed"` is not a plane `dispatch.ts` names; it is this module's word for
 * `planDispatch`'s `pane` with `adopted_terminal: false`, because from here the
 * interesting property is not which pane it is but that DELIVERY IS A KEYSTROKE
 * STREAM CARRYING THE PAYLOAD.
 */
export type RelayDeliveryPlane = "rpc" | "staged" | "typed" | "unknown";

export interface RelaySendOutcome {
  readonly accepted: boolean;
  readonly via: "rpc" | "pane" | "staged";
  readonly reason: string | null;
  readonly error: string | null;
  readonly epoch: number | null;
}

export interface RelayEffects {
  /**
   * Send one task to one worker, by whatever plane that worker actually has.
   *
   * **This is `sendTaskEnvelope` and it must not be anything narrower.** The
   * seam used to be `controlCall`, which is the RPC half of a two-plane
   * decision — and choosing the plane is not this module's to make. See
   * `consoleTransport`'s `dispatch` for what that cost.
   */
  sendTask(run: RunPaths, worker: string, dispatch: RelayDispatch): Promise<RelaySendOutcome>;
  /**
   * How a prompt would reach this worker, asked BEFORE anything is sent.
   *
   * **A preflight and not a post-check, because on the typed plane the damage is
   * done by the time `sendTask` returns.** `sendViaPane`'s non-adopted branch
   * builds a keystroke plan from the whole rendered prompt and types it line by
   * line, then presses Enter; the `via: "pane"` in its answer is a report of
   * what already happened. Reading it after the fact would name the hazard, not
   * prevent it.
   *
   * `"typed"` is the non-adopted `tui` pane. `"staged"` is the adopted one —
   * safe, because only `STAGED_TRIGGER_LINE` reaches the surface. `"rpc"` is the
   * control socket. `"unknown"` is a launch record whose marks disagree, which
   * `planDispatch` already refuses to guess about, and which this refuses too.
   */
  deliveryPlane(run: RunPaths, worker: string): Promise<RelayDeliveryPlane>;
  /** `readTaskRecord(taskRecordPath(workerPaths(run, worker), taskId))`. */
  readTaskRecord(
    run: RunPaths,
    worker: string,
    taskId: string,
  ): Promise<RelayTaskRecordView | null>;
  /** `harvestTask(run, taskId)` — harvest/index.ts. */
  harvestTask(run: RunPaths, taskId: string): Promise<RelayHarvestView>;
  /**
   * Read up to `maxBytes` of one artifact, or explain why not.
   *
   * An EFFECT rather than a `readFile` inline, for the reason every other effect
   * here is one: the path came out of a document, the file lives in a directory
   * the WORKER owns, and deciding whether it may be opened is exactly the
   * judgement `harvest/outbox.ts` spends its header on. Keeping it behind the
   * seam means the budget arithmetic above is testable with three numbers and
   * the containment check has one home.
   */
  readArtifact(
    run: RunPaths,
    worker: string,
    hostPath: string,
    maxBytes: number,
  ): Promise<{ text: string; unreadable: string | null }>;
  /** `writeReply(workerRepliesDir(run.root, collator), childTaskId, reply)`. */
  writeReply(run: RunPaths, collator: string, childTaskId: string, reply: unknown): Promise<void>;
  /** Milliseconds. Injected so the deadline below needs no wall clock to test. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The poll interval, and it is `wait.ts:25`'s number deliberately.
 *
 * §6.5 records that `pifleet wait` polls `readTaskRecord` in a private closure
 * at 100 ms and that there is no helper to import — which is the whole reason
 * `awaitSettled` is a seam rather than a call. Spelling the same interval is
 * the honest way to reuse a decision that cannot be imported: two pollers over
 * the same file at different rates would be two answers to a question nobody
 * knew had been asked twice.
 */
export const RELAY_SETTLE_POLL_MS = 100;

/**
 * How long the join waits before it stops believing a child will settle.
 *
 * **§6.7's `deadline_s`, which defaults to 1800 (`contracts.ts:1770`) — but
 * armed HERE, at the call, and that difference is the entire reason this bound
 * exists at all.** The supervisor's own deadline is armed at the TRIGGER rather
 * than at stage, which `supervisor/index.ts` defends because "setting
 * `deadlineMs` at stage time would make a 20-minute task `timed_out` before it
 * begins". For a `pane_mode: tui` worker the trigger is a person typing in a
 * pane this process cannot see or reach — so under D13's implementation, where
 * all four panes are `tui`, the supervisor's deadline may never arm, no task
 * record may ever be written, and a poll with no bound of its own never
 * returns.
 *
 * **That premise was overstated and is corrected here.** On the staged route the
 * trigger IS normally typed, the turn starts, and the supervisor's deadline arms
 * like any other — so "the deadline may never arm" is the exception, not the
 * ordinary case. The exception is real but now handled one layer up: a stage
 * whose trigger could not be sent comes back `accepted: true` with an `error`,
 * and `dispatch` rejects it rather than letting the join wait out a keystroke
 * that is not coming.
 *
 * What this bound actually covers is therefore narrower and still worth having:
 * a supervisor that dies mid-turn, a turn that never settles, a task record that
 * never appears for a reason nobody predicted. It is a backstop against an actor
 * that stops, which is the same shape as the FIFO defect Phase 1 nearly shipped.
 *
 * **The ordering against the child's own deadline is what keeps it a backstop.**
 * The envelope this relay sends carries `deadline_s: 1500` — `dispatch.ts`'s
 * default for a task that names none, and the relay names none because D11
 * refuses the field in the request. 1800 > 1500, so the child settles
 * `timed_out` on its own clock first and the join observes a real record. If
 * either number moves, that ordering is the property to re-check.
 *
 * **On expiry this REJECTS rather than resolving, and the caller is why it
 * matters less than it looks.** `fanOut` joins with `Promise.allSettled` and
 * discards the outcomes, so a rejection here does NOT cost the lens directly —
 * the harvest still runs, finds no task record, and the lens goes missing by
 * the ordinary route with `verdict: "unknown"`. What rejecting buys is honesty
 * at this seam: resolving would assert a terminal state was observed, and the
 * next reader to build on `awaitSettled` would inherit that lie. What the bound
 * itself buys is that the actor gets to the harvest at all.
 */
export const RELAY_SETTLE_DEADLINE_MS = 1_800_000;

/**
 * A dispatch that did not land — and it exists because ONE of the two ways to
 * not land looks exactly like success.
 *
 * The dispatch path THROWS for an unreachable worker or a terminal that has
 * gone, which no implementation gets wrong. It also RESOLVES with
 * `{accepted: false, reason}` for a supervisor-side refusal, and an adapter
 * written as `await send(...)` treats that as a delivered prompt. The console
 * then joins, waits and harvests a task no worker was ever told about — every
 * lens reports `unknown`, and the failure is reported against the reviewers
 * rather than against the dispatch.
 *
 * `refusal` is the supervisor's own reason string, kept as a FIELD rather than
 * only in the message, because a caller — or a test — that had to match English
 * to tell one refusal from another would be pinning a sentence rather than a
 * rule.
 *
 * **`pane_mode_tui_has_no_rpc_dispatch` is NOT among the reasons this can now
 * carry, and that is a fix rather than an omission.** It was, when this
 * adapter spoke `cmd: "dispatch"` directly; see `consoleTransport`.
 */
export class RelayDispatchError extends Error {
  constructor(
    readonly worker: string,
    readonly taskId: string,
    /** The supervisor's refusal code, or `null` when the socket itself failed. */
    readonly refusal: string | null,
    detail: string,
    /**
     * THE ORIGINAL THROW, when there was one.
     *
     * Only one of the five sites that raise this has an underlying error: the
     * `catch` around `sendTask`, where a socket failed, a launch record would
     * not read, or a terminal had gone. That site used to keep `err.message`
     * and drop the object, which discards the `errno`, the `syscall`, the
     * stack that says WHERE, and any cause chain beneath it.
     *
     * The cost is the same one this module argues about everywhere else: the
     * paraphrase survives and the evidence does not. `SocketRequestError` reads
     * identically whether the socket path was wrong, the supervisor was gone or
     * the peer hung up mid-write, and telling those apart is the whole content
     * of the diagnosis. `cause` is where a reader who wants the original goes,
     * and it does not change what the message says to a reader who does not.
     */
    options?: { readonly cause?: unknown },
  ) {
    super(`dispatch of ${taskId} to ${worker} did not land: ${detail}`, options);
    this.name = "RelayDispatchError";
  }
}

/**
 * A REPORT COULD NOT BE DELIVERED INTO THE COLLATOR'S `/replies` MOUNT.
 *
 * Typed for `RelayDispatchError`'s reason, which this module states as a rule
 * and had not applied here: *"a caller — or a test — that had to match English
 * to tell one refusal from another would be pinning a sentence rather than a
 * rule."* The publish path threw a bare `Error` carrying a paragraph, so the
 * only way to recognise the one failure mode D6 has was to substring-match that
 * paragraph — and the paragraph is the part most likely to be rewritten.
 *
 * The fields are what a caller would otherwise reconstruct from the message:
 * WHICH collator, WHICH report, and WHICH directory was missing. `cause` keeps
 * the original `ENOENT`.
 *
 * It still PROPAGATES, and nothing about the typing changes that. `fanOut` does
 * not catch it, `relayPass` lets it through without journalling, and the next
 * pass retries — see `writeReply`, where the argument for not repairing the
 * mount lives.
 */
export class RelayReplyError extends Error {
  constructor(
    readonly collator: string,
    readonly childTaskId: string,
    /** The host directory the collator's `/replies` is mounted from. */
    readonly repliesDir: string,
    detail: string,
    options?: { readonly cause?: unknown },
  ) {
    super(detail, options);
    this.name = "RelayReplyError";
  }
}

/** The join gave up on a child. See `RELAY_SETTLE_DEADLINE_MS`. */
export class RelaySettleTimeoutError extends Error {
  constructor(
    readonly worker: string,
    readonly taskId: string,
    readonly waitedMs: number,
  ) {
    super(
      `no task record for ${taskId} appeared under ${worker} within ${waitedMs} ms, so the join ` +
        `stopped waiting. Under §6.7 the supervisor's own deadline_s is armed at the TRIGGER, and ` +
        `a tui worker's trigger is a keystroke — so a task nobody started never settles and an ` +
        `unbounded wait here would wedge the actor rather than fail it.`,
    );
    this.name = "RelaySettleTimeoutError";
  }
}

/**
 * The attempt id for a relayed dispatch — DERIVED from the content, not minted.
 *
 * `dispatch.ts:139` spells this same construction as `attemptIdFor`, and it is
 * respelled here rather than imported for `MAX_RELAY_TASK_ID_CHARS`'s reason
 * one file over: that symbol lives in a commander command module, and importing
 * it would drag the CLI into the runtime graph of a module the CLI dynamically
 * imports.
 *
 * **Derived rather than random because the journal is written LAST.** That
 * ordering is `relay-journal.ts`'s and it is right — journalling first turns a
 * crash into a review that silently never happens — but its cost is that a
 * crash between the dispatch and the journal entry makes the next pass fan out
 * again. With a random attempt id that is three reviews run twice. With a
 * derived one the supervisor recognises the pair and REPLAYS, so the cost of
 * the safe ordering drops from a duplicate review to a no-op.
 *
 * **It does NOT match the staged route's own `attemptIdFor(JSON.stringify(partial))`
 * and an earlier version of this comment claimed it did.** The two strings
 * differ — different inputs, different prefixes. The replay property survives
 * anyway, and for a reason worth stating rather than assuming: `EpochManager`
 * keys attempts on `attemptKey(taskId, attemptId)`, and the task id is derived,
 * stable, and in the key. So each route replays against ITS OWN previous
 * attempt, which is all either of them needs; what would break is a task
 * re-dispatched across two different planes, which this console never does.
 */
function relayAttemptId(worker: string, dispatch: RelayDispatch): string {
  const content = JSON.stringify([worker, dispatch.taskId, dispatch.title, dispatch.brief]);
  return `relay:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

/**
 * The four host effects, satisfied.
 *
 * `collator` is closed over rather than passed, and that is what makes
 * `publishReply(collatorRun, childTaskId, reply)` implementable at all: the
 * reply belongs in the collator's own replies directory, the signature carries
 * the run but not the worker, and the collator is a property of the REQUEST —
 * one per fan-out — rather than of the console. Inverting the worker→run map to
 * recover it would give the wrong answer the moment two workers share a run.
 */
export function consoleTransport(
  collator: string,
  effects: RelayEffects,
  opts: { deadlineMs?: number; pollMs?: number } = {},
): RelayTransport<RunPaths> {
  const deadlineMs = opts.deadlineMs ?? RELAY_SETTLE_DEADLINE_MS;
  const pollMs = opts.pollMs ?? RELAY_SETTLE_POLL_MS;

  return {
    /**
     * **THE PLANE IS NOT THIS MODULE'S TO CHOOSE, AND CHOOSING IT WAS A BUG.**
     *
     * This method used to call `controlCall(run, worker, {cmd: "dispatch", …})`
     * directly. That is the RPC half of a two-plane decision, and the decision
     * belongs to `planDispatch`, which reads the launch record `up` actually
     * wrote. An attended worker has NO RPC dispatch surface — the supervisor
     * answers `pane_mode_tui_has_no_rpc_dispatch`, correctly, because the
     * question is wrong. Its envelope is STAGED instead: written into its
     * read-only policy plane with the allocated epoch, recorded in the inbox,
     * and followed by a one-line trigger at the surface. `via: "staged"` is a
     * success, and a third distinct claim rather than a weaker `pane`.
     *
     * **D13 makes all four review-console panes `tui`, so the old spelling was
     * refused for every seat on the console — not merely for the collation.**
     * Every lens would come back `unknown`, the fan-out would journal three
     * children it never dispatched, and the console would be indistinguishable
     * from a working one on every observable it has. That is §6.4's own failure
     * shape — "a collator that dispatched three reviews is indistinguishable
     * from one that dispatched none" — reached from the host's side.
     *
     * So the effect is `sendTaskEnvelope`, which is THE dispatch path: it reads
     * the launch record, routes, builds the envelope from the worktree record,
     * writes the durable inbox entry on BOTH planes, and appends the ledger
     * row. Nothing about which plane a worker has is decided here, and nothing
     * about an envelope is spelled here twice.
     */
    async dispatch(run: RunPaths, d: RelayDispatch): Promise<void> {
      /**
       * ── PREFLIGHT: is this delivery SAFE? ────────────────────────────────
       *
       * **`d.brief` is written by a container and this is the one plane that
       * TYPES it.** `dispatch-request.ts` says outright that it does not
       * sanitize `title` or `brief` — deliberately, because the staged drop's
       * contract is byte-identity with the RPC route. That is sound while the
       * payload is written to a file. `sendViaPane`'s non-adopted branch instead
       * splits the rendered prompt on newlines and types every line into the
       * surface, then presses Enter. `assertPaneTypeableLine` bounds length and
       * refuses C0/DEL and embedded newlines; it permits every shell
       * metacharacter there is.
       *
       * And the surface is not reliably the agent. `docker attach
       * --detach-keys=ctrl-]` makes detach a single keypress pifleet cannot
       * observe, and after it — or after the container exits — the pane hosts
       * the operator's own shell. `stageForAdoptedTerminal`'s safety argument
       * says this in as many words: what may land in a shell is
       * `STAGED_TRIGGER_LINE`, which begins `#` and cannot execute, *"rather
       * than a markdown brief delivered line by line"*. On this branch it is
       * exactly the markdown brief, delivered line by line.
       *
       * So it is refused, before a byte is sent, and refused for the run rather
       * than the fleet: one lens is lost and the collation says so.
       *
       * ## Why this is not the mistake the previous docblock warned about
       *
       * That docblock said to examine `accepted` and nothing else, because a
       * guard requiring a particular plane is how the console came to refuse
       * every `tui` worker. It was right about the question it was answering and
       * too broad for the question it was not. There are THREE questions here
       * and only the first is about preference:
       *
       *   1. **Which plane should the relay PREFER?** None. `sendTaskEnvelope`
       *      reads the launch record and decides; the relay must not.
       *   2. **Is this delivery SAFE for container-authored text?** Not on the
       *      typed plane, whatever the launch record prefers. Refusing one plane
       *      because its delivery mechanism is a keystroke stream is not a
       *      preference between planes.
       *   3. **Did it actually HAPPEN?** `accepted` alone does not answer this
       *      either — see the deferred trigger below.
       */
      const plane = await effects.deliveryPlane(run, d.worker);
      if (plane === "typed" || plane === "unknown") {
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          plane === "typed" ? "pane_delivery_types_the_brief" : "delivery_plane_unknown",
          plane === "typed"
            ? `"${d.worker}" is a tui pane with no adopted terminal, so its prompt is DELIVERED BY ` +
              `TYPING — every line of the brief, then Enter. This brief was written by a container ` +
              `and is not sanitized, and a detached or exited pane hosts the operator's shell. ` +
              `Nothing was sent. Give the worker an adopted terminal (\`up --attach-here\`) so its ` +
              `dispatches are STAGED, where only a comment line reaches the surface.`
            : `the launch record for "${d.worker}" names neither a consistent rpc nor a consistent ` +
              `tui shape, so how its prompt would be delivered is unknown. Nothing was sent — a ` +
              `guess here is a guess about whether a container's brief gets typed into a shell.`,
        );
      }

      let outcome: RelaySendOutcome;
      try {
        outcome = await effects.sendTask(run, d.worker, d);
      } catch (err) {
        // Shape one: it threw. An unreachable supervisor, a launch record that
        // names neither plane, a terminal that has gone — from the join's point
        // of view they all cost the same one lens.
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          null,
          err instanceof Error ? err.message : String(err),
          // The message is the paraphrase; this is the evidence. See the field.
          { cause: err },
        );
      }

      // Shape two, and the one that reads as success: a RESOLVED refusal.
      if (!outcome.accepted) {
        const refusal = outcome.reason ?? "rejected";
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          refusal,
          `${refusal} (${outcome.error ?? refusal})`,
        );
      }

      /**
       * BACKSTOP for the preflight. Reached only if the launch record and the
       * route disagree, which the preflight cannot rule out because they are two
       * reads at two moments. It is too late to prevent the typing — that is
       * what the preflight is for — but a lens whose brief was typed into a
       * surface must not then be counted, waited on and collated as though it
       * were a review.
       */
      if (outcome.via === "pane") {
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          "pane_delivery_types_the_brief",
          `the dispatch to "${d.worker}" was delivered by TYPING the brief into its pane. The ` +
            `preflight is meant to make this unreachable; reaching it means the launch record ` +
            `changed under the pass. The lens is dropped rather than collated.`,
        );
      }

      /**
       * ── Shape three: ACCEPTED, and it still did not happen. ──────────────
       *
       * `stageForAdoptedTerminal` returns `accepted: true` with
       * `error: trigger.reason` when the drop is durable but the trigger line
       * could not be typed — which is every adopted terminal that announces no
       * pane id: Terminal.app, ssh, a bare tmux pane. The envelope is on disk and
       * a person can run the task; nothing is running now.
       *
       * **Counting that as landed is a thirty-minute stall and then a lost
       * lens.** `awaitSettled` would poll for a task record that cannot appear
       * until a human types the line, for the full deadline, and `relayPass` is
       * serial — three of them stop the actor for an hour and a half.
       *
       * So it is a rejection, and the trigger instruction travels in the message
       * because it is the one thing that lets the operator rescue the review.
       * The refusal code is the supervisor's own ledger event name, so a caller
       * matches a rule rather than a sentence. On the next pass the derived
       * attempt id makes the re-stage a REPLAY, so retrying costs nothing and
       * may find the trigger has since been typed.
       */
      if (outcome.error !== null) {
        throw new RelayDispatchError(
          d.worker,
          d.taskId,
          "stage_trigger_deferred",
          `"${d.taskId}" was STAGED for "${d.worker}" but its turn was never triggered, so no task ` +
            `record can appear and the join would wait out its whole deadline for a keystroke: ` +
            `${outcome.error}`,
        );
      }
    },

    async awaitSettled(run: RunPaths, task: RelayTaskRef): Promise<void> {
      const started = effects.now();
      for (;;) {
        const record = await effects.readTaskRecord(run, task.worker, task.taskId);
        if (record !== null) return;
        // Checked BEFORE the sleep and against the time already spent, so the
        // bound is the deadline rather than the deadline plus one interval —
        // and so a zero deadline gives up immediately instead of polling once.
        if (effects.now() - started >= deadlineMs) {
          throw new RelaySettleTimeoutError(task.worker, task.taskId, effects.now() - started);
        }
        await effects.sleep(pollMs);
      }
    },

    async harvest(run: RunPaths, task: RelayTaskRef): Promise<RelayHarvest> {
      const bundle = await effects.harvestTask(run, task.taskId);

      /**
       * ── INLINE THE ARTIFACTS, because a digest is not a document ──────────
       *
       * `HarvestedArtifactSchema` is `{path, bytes, sha256}` — no contents — and
       * the reviewer's `/outbox` is worker-scoped, so a review filed at
       * `/outbox/<task>/files/review.md` is a document NOTHING in this console
       * can open. The reply carried the digest of a file the reader cannot
       * reach, every status stayed green, and the findings evaporated.
       *
       * A digest is what you carry when the thing itself is somewhere the reader
       * can get to. Here it is not, so the thing itself travels.
       */
      const artifacts = bundle.harvest.artifacts ?? [];
      const budgets = planInlineBudget(artifacts.map((a: { bytes: number }) => a.bytes));
      const inlined: InlinedArtifact[] = [];
      for (const [i, a] of artifacts.entries()) {
        const budget = budgets[i] ?? 0;
        const read =
          budget === 0
            ? { text: "", unreadable: null }
            : await effects.readArtifact(run, task.worker, a.path, budget);
        const included = read.unreadable === null ? Buffer.byteLength(read.text, "utf8") : 0;
        inlined.push({
          path: a.path,
          bytes: a.bytes,
          included_bytes: included,
          truncated: read.unreadable === null && included < a.bytes,
          unreadable: read.unreadable,
          text: read.text,
        });
      }

      return {
        /**
         * VERBATIM. `timed_out` and `aborted` are supervisor verdicts and are
         * carried through unchanged — folding them to `failed` would make the
         * record say a reviewer produced a failing review when what happened is
         * that it never reported, and it reddens `RelayChild`'s tests one layer
         * up. `harvestStatus` is deliberately not consulted: an untrustworthy
         * harvest already yields `unknown`, so a second test would be a second
         * rule for one fact.
         */
        verdict: bundle.harvest.verdict,
        /**
         * The WHOLE bundle is the reply, not the verdict. `replies.ts` pretty-
         * prints on the argument that "the reader is a model with the file's
         * whole contents in one gulp" and names "a nested harvest record" as
         * the thing it is formatting — this is that record.
         */
        /**
         * The bundle PLUS the contents. `writeReply` takes `unknown`, so this is
         * a payload change and nothing else — no new mount, nothing added to
         * `assertNoRunDirMount`, the verbgate's integrity loop or the §5.5 mount
         * table. That is the whole argument for Take A over a second channel,
         * and it is why the reply schema stays the actor's to decide.
         */
        reply: { ...bundle, inlined_artifacts: inlined },
        inlined,
        /**
         * THE ONE ADAPTER POINT — see `RelayHarvestView.unreadableEnvelope`.
         *
         * A spread and a tag, and nothing else: the harvester's four fields are
         * carried UNTOUCHED, because a relay that re-derived, widened or
         * paraphrased the classification would be a second answer to a question
         * `harvest/outbox.ts` owns. If that type changes shape, this line stops
         * compiling — which is the property the structural spelling buys.
         *
         * `unreadableEnvelope`'s `null` STILL does not decide anything on its
         * own — it means "absent or present" and always did. What decides is
         * `envelopeRead`, the harvester's own outcome, which is why this is a
         * lookup rather than an inference. Before that field existed this arm
         * returned `undefined` for both worlds and `absent` was unreachable.
         *
         * Only `missing` and `ok` are mapped. `refused` and `null` return
         * `undefined` — see `RelayHarvestView.envelopeRead` for why a refusal is
         * none of the three, and why "nobody looked" must not become "looked and
         * found none".
         *
         * `ok` is `present` and not a contradiction: this note is built only for
         * a lens that did NOT succeed, so a readable envelope here is exactly
         * `present`'s case — the reviewer reported and the report did not
         * travel.
         */
        envelope: relayEnvelopeState(bundle),
        /**
         * THE SECOND ADAPTER POINT, and it is a pass-through rather than a
         * classification for the reason the first one is a spread: the
         * harvester decided what "unrecognised" means and re-deriving it here
         * would be a second answer to a question `harvest/task-outbox.ts` spends
         * its header on.
         *
         * `?? undefined` and NEVER `?? { kind: "empty" }`. A bundle that carries
         * no listing is one where nobody looked, and manufacturing `empty` from
         * it would assert that a reviewer left nothing behind on the strength of
         * a `readdir` that never ran — the original defect, one seam further
         * down, in the one direction that reads as helpful.
         */
        outbox: bundle.taskOutbox ?? undefined,
      };
    },

    async publishReply(collatorRun: RunPaths, child: string, reply: unknown): Promise<void> {
      // `writeReply` and never a reimplementation of it: it owns the
      // chmod-0644 → truncate-in-place → chmod-0444 recipe, and the recipe is
      // truncate-in-place because a bind mount pins the INODE. A write-and-
      // rename would leave the collator's mount showing the old file forever.
      await effects.writeReply(collatorRun, collator, child, reply);
    },
  };
}

/**
 * worker → run, for D4's four runs.
 *
 * Every input is injected, so this is testable without a runs directory — and
 * more importantly, so the SEARCH ORDER is testable, which is the part with a
 * wrong answer that works most of the time.
 *
 * The collator's own run is used for the collator without a search, and is
 * tried first for everyone else. That is not an optimisation: a console
 * assembled as one run (a fixture, a `scripts/` driver, any future single-run
 * arrangement) resolves entirely from it, and a console assembled as four
 * resolves the collator from the run the request was READ from — which is the
 * only run in the whole set this process can be certain about.
 *
 * **A worker no run holds is left OUT of the map rather than defaulted.** The
 * core answers a missing entry with `run_unresolved`, which the poll declines
 * to journal and retries on the next tick — and "the console is still coming
 * up" is exactly the state that produces it. The plausible fallback, using the
 * collator's run, is the one that must not be written: the collator's
 * supervisor would ACCEPT a reviewer's task, and three lenses would be one
 * worker with three transcripts.
 */
/**
 * The map, plus the workers it REFUSED to resolve and why.
 *
 * Ambiguity is returned rather than swallowed so the fan-out's refusal can name
 * the competing runs. A worker that is merely absent and one that matched three
 * runs are both missing from `runs`, and only the second is an operator's
 * problem to disambiguate.
 */
export interface ConsoleRunMap {
  readonly runs: ReadonlyMap<string, RunPaths>;
  /** worker → the run ids that all hold it. Never has a single-element entry. */
  readonly ambiguous: ReadonlyMap<string, readonly string[]>;
}

export async function resolveConsoleRuns(input: {
  readonly collator: string;
  readonly collatorRun: RunPaths;
  readonly workers: readonly string[];
  /** Candidate runs. ORDER IS NOT A TIEBREAK — see the scan below. */
  listRuns(): Promise<readonly RunPaths[]>;
  hasWorker(run: RunPaths, worker: string): Promise<boolean>;
}): Promise<ConsoleRunMap> {
  const runs = new Map<string, RunPaths>();
  const ambiguous = new Map<string, readonly string[]>();
  const unresolved: string[] = [];

  for (const worker of input.workers) {
    if (worker === input.collator) {
      runs.set(worker, input.collatorRun);
      continue;
    }
    if (await input.hasWorker(input.collatorRun, worker)) {
      runs.set(worker, input.collatorRun);
      continue;
    }
    unresolved.push(worker);
  }

  // The scan happens at most once, and only if something is actually missing.
  // Listing the runs root per worker would re-stat every run in the fleet three
  // times per tick for an answer that cannot differ between them.
  if (unresolved.length > 0) {
    const candidates = await input.listRuns();
    for (const worker of unresolved) {
      /**
       * EVERY match, then refuse if there is more than one — never "the newest
       * wins".
       *
       * **This is an authority decision wearing the clothes of a lookup.** Worker
       * ids are not unique across runs; two consoles stand side by side and are
       * told apart by run, not by worker id. So a scan that takes the newest
       * candidate resolves `rev-arch-1` to whichever run most recently
       * materialised that id — including an unrelated fleet a colleague brought
       * up a minute ago, and including a dead run, since `down` removes
       * containers and not directories.
       *
       * What follows a wrong answer is not a failed dispatch. It is a review
       * dispatched into ANOTHER run's worker: that run's control secret, that
       * run's tool grant, that run's model, that run's repository graded — and
       * the reply harvested back into this console and collated as this
       * console's lens. D11's whole argument is that the model and the grant
       * were validated at `up`, and that validation is per-run. Nothing
       * downstream can detect the crossing.
       *
       * A refusal costs a tick and names both runs. Picking one costs the
       * property the console exists to provide, silently. The operator's fix is
       * to say which run they meant.
       */
      const matches: RunPaths[] = [];
      for (const run of candidates) {
        if (await input.hasWorker(run, worker)) matches.push(run);
      }
      if (matches.length === 1) {
        runs.set(worker, matches[0]!);
        continue;
      }
      if (matches.length > 1) {
        ambiguous.set(
          worker,
          matches.map((r) => r.runId),
        );
      }
    }
  }
  return { runs, ambiguous };
}

/**
 * `relayFanOut`'s three outcomes, in the two shapes the JOURNAL tells apart.
 *
 * `not_collated` maps to `dispatched` and the direction reads backwards until
 * you hold it against the journal's purpose: a fan-out where zero children
 * succeeded dispatched no COLLATION, but it did dispatch the three children.
 * Recording it as `not_dispatched` would have the relay reissue three reviews
 * on the next tick for a request that already consumed them.
 *
 * `refused` maps to `not_dispatched` for the mirror reason: nothing was
 * issued, so a journal entry would mark a fan-out complete that never happened
 * — and under D5 the collator has already settled, so nothing downstream would
 * ever notice.
 */
function toFanOutResult(outcome: RelayOutcome): RelayFanOutResult {
  /**
   * `none_landed` joins `refused` here, and it is the whole of the fix.
   *
   * Both mean NOTHING IS RUNNING, which is the only question the journal is
   * entitled to ask. `not_collated` reads as their neighbour and is their
   * opposite: three tasks exist and must not be re-issued. Before this arm
   * existed the three shared one code path, and the case that must never be
   * journalled was journalled — `already_done` forever, reviews never run.
   */
  if (outcome.kind === "refused" || outcome.kind === "none_landed") {
    return { kind: "not_dispatched", reason: outcome.reason };
  }
  /**
   * ISSUED ONLY — and filtering on `issued` rather than on `taskId !== null` is
   * the correction, not a tidy-up.
   *
   * `taskId` is populated when a lens is PLANNED and survives a dispatch that
   * was refused, so the null filter alone recorded the ids the fan-out INTENDED.
   * `relay-journal.ts` describes this list as "the child task ids the fan-out
   * issued … written by the thing that actually performed the dispatches" — the
   * host's independent copy of what really happened, and the whole point of
   * having it is that it was produced by the party that did the work rather than
   * by the model that asked for it. A planned id in that slot makes it a second
   * copy of the request.
   *
   * The COLLATION id is deliberately absent too: the collation is the host's own
   * follow-up rather than something the request bought.
   */
  const children = outcome.children
    .filter((c) => c.issued)
    .map((c) => c.taskId)
    .filter((id): id is string => id !== null);
  /**
   * `collation_failed` is `dispatched` PLUS a reason, and both halves matter.
   *
   * `dispatched` is what journals the three children, which is the point of the
   * arm. The reason is what stops that being a silent success: a pass whose last
   * hop failed and a pass that completed are otherwise identical rows — same
   * kind, same children — so without this field the distinction exists in the
   * core and dies at the boundary.
   *
   * `not_collated` deliberately does NOT get one. Zero survivors means there was
   * nothing to collate, which is §6.6 working; attaching a reason there would
   * make the field mean "something went wrong" in one case and "nothing needed
   * doing" in the other, and a field with two meanings is read as neither.
   */
  if (outcome.kind === "collation_failed") {
    return { kind: "dispatched", children, reason: outcome.reason };
  }
  return { kind: "dispatched", children };
}

/**
 * The adapter, over injected composition. `consoleFanOut` is this with the real
 * effects bound; the seam is here so the mapping above can be tested against a
 * fan-out driven by closures rather than by a fleet.
 */
export function makeConsoleFanOut(deps: {
  resolveRuns(input: RelayFanOutInput): Promise<ConsoleRunMap>;
  transport(collator: string): RelayTransport<RunPaths>;
  aspects?: readonly AspectSeat[];
}): (input: RelayFanOutInput) => Promise<RelayFanOutResult> {
  return async (input: RelayFanOutInput): Promise<RelayFanOutResult> => {
    const { runs, ambiguous } = await deps.resolveRuns(input);

    /**
     * FAIL CLOSED on any ambiguity, before a single dispatch.
     *
     * Not "only if this request needs the ambiguous seat": a console in which
     * one worker id resolves to two live runs is a console whose identity is
     * unsettled, and dispatching the seats that happen to be unambiguous would
     * produce a review whose lenses came from two different fleets — with a
     * consensus count that reads as corroboration.
     *
     * `not_dispatched`, so nothing is journalled and the pass retries: the
     * operator's remedy is to say which runs are theirs (`PIFLEET_RELAY_RUNS`),
     * or to bring the other console down.
     */
    if (ambiguous.size > 0) {
      const detail = [...ambiguous.entries()]
        .map(([worker, ids]) => `"${worker}" is held by ${ids.join(", ")}`)
        .join("; ");
      return {
        kind: "not_dispatched",
        reason:
          `the worker→run map is ambiguous, so nothing was dispatched: ${detail}. Worker ids are ` +
          `not unique across runs and this console is four of them (D4), so choosing one would ` +
          `dispatch a review into another fleet's worker — its control secret, its tool grant, ` +
          `its model, its repository — and collate the reply here as though it were this ` +
          `console's lens. Pin the map with PIFLEET_RELAY_RUNS=worker=runId,... or stop the ` +
          `other console.`,
      };
    }

    const outcome = await relayFanOut<RunPaths>({
      request: input.request,
      sender: input.sender,
      runs,
      transport: deps.transport(input.sender),
      ...(deps.aspects === undefined ? {} : { aspects: deps.aspects }),
    });
    return toFanOutResult(outcome);
  };
}

/**
 * Where the production map comes from, as four injected reads.
 *
 * **Extracted from `consoleFanOut`'s closure because that closure was
 * unexecuted by every test in the suite.** The only case touching
 * `consoleFanOut` asserts `typeof === "function"`, which CONSTRUCTS the closure
 * and never calls it — so `runsRoot()`, the run listing, the newest-first
 * ordering and the liveness probe were all unreachable from a unit test while
 * looking covered by association with `resolveConsoleRuns`, which is a
 * different function taking those same things as parameters.
 *
 * That is the producer half of the scan hazard: `resolveConsoleRuns` was well
 * tested on the CONSUMER side (given these candidates, what does it decide) and
 * the side that decides what the candidates ARE had no test at all.
 */
export interface ConsoleRunSources {
  runsRoot(): string;
  /** Run ids, OLDEST first — `runIdsAscending`'s order, reversed below. */
  listRunIds(root: string): Promise<readonly string[]>;
  runPathsFor(runId: string, root: string): RunPaths;
  /** Is this worker LIVE in this run — a supervisor actually holding the seat. */
  isLiveWorker(run: RunPaths, worker: string): Promise<boolean>;
  /** `PIFLEET_RELAY_RUNS`, or undefined. */
  pinnedRuns(): string | undefined;
}

/**
 * The console's worker→run map, from the host.
 *
 * **Newest first, and what that is FOR has changed — so the comment has
 * changed with it.** It used to be the tiebreak: the newest run holding an id
 * won, which is how an unrelated fleet captured a seat. Ambiguity is now
 * REFUSED, so ordering decides nothing about resolution — a worker resolves
 * only when exactly one live run holds it, and one is one in any order.
 *
 * It is kept because it orders the REFUSAL: the operator reading "held by X, Y"
 * sees the most recently started run first, which is almost always the one they
 * just brought up and were thinking of. That is a real property and it is
 * asserted rather than asserted-in-prose — `collator-relay-adapter.test.ts`
 * pins the order of the reported ids, so deleting the `reverse()` reddens.
 */
export async function consoleRunResolution(
  input: RelayFanOutInput,
  src: ConsoleRunSources,
): Promise<ConsoleRunMap> {
  const root = src.runsRoot();
  const workers = [input.sender, ...REVIEW_CONSOLE_ASPECTS.map((s) => s.worker)];

  /**
   * AN EXPLICIT MAP WINS, and it is the shape the SRD actually asked for.
   *
   * §6.5's preferred home is "a new `pifleet relay --console review` process,
   * started by `scripts/review`" whose merit is that it "holds the worker→run
   * map THE SCRIPT ALREADY COMPUTES". The scan below exists because that flag
   * does not, and it is strictly the weaker answer: the script knows which four
   * runs it created, and the scan can only infer from what is on disk.
   */
  /**
   * A PIN IS A HINT THAT DECAYS, not a decision cached for a process lifetime.
   *
   * It used to short-circuit the scan outright, and the consequence is worse
   * than it looks. `PIFLEET_RELAY_RUNS` is fixed at spawn, so a pinned run that
   * later dies — `--restart` on a reviewer, a supervisor that fell over, a
   * `down` on one seat — was resolved to a corpse on every subsequent pass. The
   * fan-out fails closed there (nothing lands, nothing is journalled, the pass
   * retries), so no review is lost, but **it never converges**: the pin cannot
   * be re-derived without restarting the process, and the operator's remedy is
   * to re-run a script that finds a live relay and leaves it alone.
   *
   * The scan it bypassed re-evaluates liveness every pass and therefore
   * converges by construction. So the pin now keeps only the job it was
   * introduced for — telling two consoles apart, which the scan cannot do — and
   * gives up any worker it names that is not live, letting the scan answer for
   * that one instead. `status-runs.ts` argues pins must be computed from live
   * workers; that argument is about the moment of computation and does not
   * survive being cached, which is what this closes.
   */
  const pinned = relayRunPins(src.pinnedRuns());
  if (pinned !== null) {
    const runs = new Map<string, RunPaths>();
    const decayed: string[] = [];
    for (const worker of workers) {
      if (worker === input.sender) {
        runs.set(worker, input.run);
        continue;
      }
      const runId = pinned.get(worker);
      if (runId === undefined) continue;
      const run = src.runPathsFor(runId, root);
      if (await src.isLiveWorker(run, worker)) runs.set(worker, run);
      else decayed.push(worker);
    }
    // Every pinned worker still answers: the pin is whole and the scan is not
    // needed. Any decay and the scan runs, so a seat that came back in a new run
    // is found rather than waited for forever.
    if (decayed.length === 0) return { runs, ambiguous: new Map<string, readonly string[]>() };
  }

  return resolveConsoleRuns({
    collator: input.sender,
    collatorRun: input.run,
    workers,
    listRuns: async () => {
      const ids = [...(await src.listRunIds(root))].reverse();
      return ids.map((id) => src.runPathsFor(id, root));
    },
    hasWorker: (run, worker) => src.isLiveWorker(run, worker),
  });
}

/**
 * `PIFLEET_RELAY_RUNS` — `worker=runId` pairs, comma separated, or `null` when
 * unset.
 *
 * The escape hatch §6.5 wanted and the shipped CLI has no flag for. A malformed
 * entry is ignored rather than fatal for one reason only: this is a hint that
 * REPLACES a guess, and a typo that fell back to the host-wide scan would be
 * worse than one that leaves a worker unresolved. An unresolved worker refuses
 * loudly; a silent fallback is the defect this whole mechanism exists to close.
 */
function relayRunPins(raw: string | undefined): Map<string, string> | null {
  if (raw === undefined || raw.trim() === "") return null;
  const pins = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const worker = pair.slice(0, at).trim();
    const runId = pair.slice(at + 1).trim();
    if (worker !== "" && runId !== "") pins.set(worker, runId);
  }
  return pins;
}

/**
 * The real modules, resolved ONCE on first use.
 *
 * Dynamic and memoised for the reason the section header gives: a static import
 * of `harvest/index.ts` and `supervisor/launch.ts` would put the container- and
 * git-driving half of the repository into the import graph of every test that
 * imports this file — including `collator-relay.test.ts`, whose stated property
 * is that it drives the whole join with three strings.
 *
 * The promise is cached rather than the modules, so two concurrent first calls
 * share one resolution instead of racing to build two.
 */
let effectModules: Promise<{
  dispatch: typeof import("../cli/commands/dispatch.ts");
  harvest: typeof import("../harvest/index.ts");
  state: typeof import("./state.ts");
  paths: typeof import("./paths.ts");
  replies: typeof import("./replies.ts");
  ledger: typeof import("./ledger.ts");
  registry: typeof import("./registry.ts");
  interrupt: typeof import("../container/interrupt.ts");
}> | null = null;

function loadEffectModules(): NonNullable<typeof effectModules> {
  effectModules ??= (async () => ({
    dispatch: await import("../cli/commands/dispatch.ts"),
    harvest: await import("../harvest/index.ts"),
    state: await import("./state.ts"),
    paths: await import("./paths.ts"),
    replies: await import("./replies.ts"),
    ledger: await import("./ledger.ts"),
    registry: await import("./registry.ts"),
    interrupt: await import("../container/interrupt.ts"),
  }))();
  return effectModules;
}

/**
 * The four host effects, for real.
 *
 * Every path in the console is derived HERE and nowhere else, which is what
 * lets the module above stay free of `paths.ts` — the property its docblock
 * calls load-bearing for the unit suite.
 */
export const productionRelayEffects: RelayEffects = {
  /**
   * `sendTaskEnvelope` — THE dispatch path, and the whole of the plane
   * decision.
   *
   * Its own docblock is the argument for calling it rather than reproducing
   * it: *"the single-task command and the `--auto` scheduler both come through
   * it, so envelope defaults, the inbox record and the ledger row cannot drift
   * between them"*. The relay is now the third caller and inherits that
   * property instead of becoming the exception to it — which matters most for
   * the two envelope fields a hand-rolled copy gets wrong quietly:
   * `host_workdir` and `base_ref` come from the worktree record, and an
   * envelope carrying the schema's `"unset"` and forty zeroes harvests
   * `repository: false` for a reviewer that has a perfectly good checkout.
   *
   * It also writes the durable inbox entry on BOTH planes. Without that,
   * `harvestTask` finds no envelope and answers `unavailableHarvest`, so every
   * lens of every fan-out comes back `unknown`.
   *
   * `requestedEpoch: null` always — the supervisor is the sole epoch allocator
   * (§7.5). `attemptId` is derived rather than random so a pass that crashed
   * between the dispatch and the journal REPLAYS instead of running the review
   * twice; on the staged plane `sendTaskEnvelope` derives its own for the same
   * reason, and the two agree by construction.
   *
   * ## `partial` MUST stay `{title, brief}`, and this is the load-bearing part
   *
   * `relay-journal.ts` journals AFTER the dispatch and says so — *"a crash in
   * the window repeats the work: on restart the request is unjournalled and the
   * fan-out is issued again"* — and it accepts that cost on the grounds that the
   * duplicate is absorbed rather than merely tolerated. THAT ABSORPTION IS THIS
   * OBJECT. On the staged plane `sendTaskEnvelope` derives the attempt id as
   * `attemptIdFor(JSON.stringify(partial))`, so a re-issue replays only while
   * these two bytes-identical fields are the whole of it. Add a timestamp, a
   * nonce, a `dispatched_at`, a retry counter — anything that differs between
   * two passes — and the hash differs, the supervisor allocates a FRESH epoch,
   * `stageForAdoptedTerminal` rewrites the drop and types the trigger, and the
   * reviewer runs the whole review a second time. The journal's chosen failure
   * silently stops being bounded.
   *
   * Checked against the recorded corpus on 2026-09-04: across 289 runs in
   * `~/.pifleet/runs` there is not one duplicate `dispatched` ledger event for
   * any `(worker, task_id)`, no run started a second relay process, and no
   * worker's `events.jsonl` records a task staged or triggered more than once.
   * So the window has never opened in anything recorded — the mechanism is
   * latent, and the field list above is what keeps it that way.
   *
   * It is NOT the cause of the duplicate turns seen on `rev-arch-1`; that was
   * one allocation with two doorbells, and it is written up on
   * `sendStagedTrigger` in `cli/commands/dispatch.ts`.
   */
  async sendTask(run, worker, d) {
    const m = await loadEffectModules();
    const out = await m.dispatch.sendTaskEnvelope({
      run,
      worker,
      taskId: d.taskId,
      // Title and brief ONLY. Every other field is host-side, and `deadline_s`
      // especially so: D11 refuses both spellings of it in the request document
      // because "a request that could set it can pin three of the largest
      // models in the catalogue open against the operator's API key".
      partial: { title: d.title, brief: d.brief },
      attemptId: relayAttemptId(worker, d),
      requestedEpoch: null,
      ledger: new m.ledger.LedgerWriter(run, `relay-${process.pid}`),
    });
    return {
      accepted: out.accepted,
      via: out.via,
      reason: out.reason,
      error: out.error,
      epoch: out.epoch,
    };
  },
  /**
   * The two reads `sendViaPane` makes, made one moment earlier.
   *
   * `launchPaneMode` is imported rather than reproduced — it owns the
   * field-plus-two-marks agreement rule, and a second copy here is how this
   * module and `dispatch.ts` would come to disagree about which plane a worker
   * has. `launch === null` is the `PIFLEET_PI_COMMAND` double, which `planDispatch`
   * and the supervisor both call `rpc`; this agrees with them rather than
   * re-deriving it.
   *
   * The `adopted_terminal` read is the one that matters: it is the exact
   * predicate `sendViaPane` branches on, so "staged" here means "that function
   * will take the staged fork" rather than a guess about it.
   */
  async deliveryPlane(run, worker) {
    const m = await loadEffectModules();
    const wp = m.paths.workerPaths(run, worker);
    const launch = await m.state.readWorkerLaunch(wp);
    if (launch === null) return "rpc";
    const mode = m.interrupt.launchPaneMode(launch);
    if (mode === "rpc") return "rpc";
    if (mode === "unknown") return "unknown";
    const presentation = await m.state.readPresentation(wp);
    return presentation?.adopted_terminal === true ? "staged" : "typed";
  },
  async readTaskRecord(run, worker, taskId) {
    const m = await loadEffectModules();
    return m.state.readTaskRecord(
      m.paths.taskRecordPath(m.paths.workerPaths(run, worker), taskId),
    );
  },
  async harvestTask(run, taskId) {
    const m = await loadEffectModules();
    return m.harvest.harvestTask(run, taskId);
  },
  /**
   * One artifact's bytes, bounded, with containment re-checked HERE.
   *
   * `harvest/outbox.ts` already validated these files when it scanned them, and
   * it did so holding descriptors open precisely because a path validated and
   * then re-opened is a different file from a path validated and held. This read
   * happens after that scan has closed, so the guarantee does not carry, and the
   * check is made again rather than assumed: the path came out of a document,
   * and the directory it names is one the WORKER owns.
   *
   * Three refusals, each closing a way the bytes could be someone else's:
   * outside the worker's own outbox, a symlink, or not a regular file. A FIFO is
   * the one that matters most — `open` on it blocks forever, which would wedge
   * the actor exactly the way the unbounded join would have, and `harvest`'s own
   * header names it as the reason that module opens with `O_NONBLOCK`.
   *
   * A refusal is a VALUE, never a throw: an artifact that cannot be read costs
   * its own contents and is named in the brief, and must not cost the lens or
   * the fan-out.
   */
  async readArtifact(run, worker, hostPath, maxBytes) {
    const m = await loadEffectModules();
    const root = m.paths.workerOutboxDir(run.root, worker);
    if (!m.paths.isPathUnder(hostPath, root)) {
      return { text: "", unreadable: `it is not inside ${worker}'s outbox` };
    }
    let handle: Awaited<ReturnType<typeof import("node:fs/promises").open>> | null = null;
    try {
      /**
       * ONE RESOLUTION OF THIS PATH, NOT TWO — and that is the whole change.
       *
       * This used to `lstat` for a symlink and then `open` the same path. The
       * two calls resolve the name INDEPENDENTLY, and the directory between
       * them belongs to the worker whose artifact this is: a container that
       * replaces its own `review.md` with a symlink after the `lstat` and
       * before the `open` is read at the target instead. `isPathUnder` does not
       * catch it, because that check is over the path the manifest NAMED, not
       * over whatever the name resolves to at open time. The reachable target
       * that matters is `control-auth.json` at the run root, which a relative
       * link climbs to with `..` — the control-socket credential, inlined into
       * a brief and handed to whichever vendor holds the collator seat.
       *
       * The window cannot be narrowed into safety, because the attacker sets
       * the pace: renaming in a loop costs a container nothing and it only has
       * to win once. So the window is REMOVED instead. `O_NOFOLLOW` refuses a
       * final component that is a symlink at the moment of the open, and every
       * fact used afterwards comes from `fstat` on the returned handle — the
       * inode that was actually opened, which nothing can swap under us. There
       * is no second name resolution left to race.
       *
       * `O_NONBLOCK` stays, and stays for its original reason: `open` on a FIFO
       * blocks forever, which would wedge the actor exactly the way the
       * unbounded join would have.
       *
       * ELOOP is mapped back to the original sentence rather than surfaced as
       * an errno, because the refusal is a VALUE the brief prints and "it is a
       * symlink" is what a reader needs. A raw `ELOOP` would also be the one
       * refusal whose wording depended on which kernel ran it.
       */
      /**
       * EVERY COMPONENT, NOT ONLY THE LAST ONE — and the first version of this
       * fix only did the last one.
       *
       * `O_NOFOLLOW` refuses a final component that is a symlink and says
       * nothing about the directories above it, while `isPathUnder` is purely
       * LEXICAL: it compares strings and never asks the filesystem. So a worker
       * that turns `files/` into a symlink to the run root still passes the
       * containment check and still gets its target opened. The review console
       * found this in the commit that introduced it, which is the whole
       * argument for having pointed it at its own diff.
       *
       * `realpath` resolves every component, so the containment test is applied
       * to the path that will actually be read rather than to the one that was
       * typed. **THIS NARROWS RATHER THAN CLOSES, and the difference is stated
       * because the last comment here over-claimed.** Fully closing it needs a
       * component-wise `openat(O_NOFOLLOW)` walk, which node does not expose;
       * what remains is a race between `realpath` and `open`, which is far
       * harder to win than a lexical check that never looks at the disk at all.
       * `O_NOFOLLOW` stays for the final component, where the guarantee IS
       * absolute.
       */
      const real = await realpath(hostPath);
      /**
       * CONTAINMENT IS TESTED ON THE RESOLVED PATH, against the RESOLVED root.
       *
       * Comparing the resolved path to the typed one — "no symlinks anywhere" —
       * was tried first and is wrong on this platform: macOS makes `/var` a
       * symlink to `/private/var`, so every path under the system temp
       * directory differs from its own realpath and every read would be refused
       * as a symlink. The system's links are not the worker's.
       *
       * So the test is the one that matches the threat. A link that ESCAPES the
       * outbox is refused wherever in the path it sits, including an
       * intermediate directory that `O_NOFOLLOW` cannot see and that
       * `isPathUnder` — purely lexical — never looked at the disk to check. A
       * link that stays INSIDE the outbox is now followed, which is a real
       * change to this function's old "refuse every symlink" rule and is
       * accepted deliberately: that subtree is the worker's own, so resolving
       * within it grants nothing it did not already have.
       */
      if (!m.paths.isPathUnder(real, await realpath(root))) {
        return { text: "", unreadable: `it resolves outside ${worker}'s outbox` };
      }
      handle = await open(
        real,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      const st = await handle.stat();
      if (!st.isFile()) return { text: "", unreadable: "it is not a regular file" };
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return { text: buf.subarray(0, bytesRead).toString("utf8"), unreadable: null };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") {
        return { text: "", unreadable: "it is a symlink" };
      }
      return { text: "", unreadable: err instanceof Error ? err.message : String(err) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  async writeReply(run, collator, childTaskId, reply) {
    const m = await loadEffectModules();
    const dir = m.paths.workerRepliesDir(run.root, collator);
    try {
      await m.replies.writeReply(dir, childTaskId, reply);
    } catch (err) {
      /**
       * A MISSING REPLIES DIRECTORY IS DIAGNOSED, NOT CREATED — and the
       * distinction is the whole of D6's failure mode.
       *
       * `createRepliesDir` is `materialize.ts`'s, called BEFORE `docker run`,
       * and its docblock says why the ordering rather than the mkdir is the
       * point: "Docker CREATES a missing bind-mount source instead of refusing,
       * so a `-v` whose host directory nobody made comes up as an empty
       * `/replies` that can never gain content". So if this directory is absent
       * NOW, the collator's container was never started against it — and an
       * adapter that helpfully created one would write three reports into a
       * directory nothing is mounted from. The host would record a delivered
       * fan-out, the collator would read an empty `/replies`, and the console
       * would collate from nothing while every observable said it worked. That
       * is the silent-empty-mount failure arriving through the repair rather
       * than through the fault.
       *
       * So it propagates. `fanOut` does not catch `publishReply`, `relayPass`
       * lets a throw through without journalling, and the next pass retries —
       * which is the correct handling for a console that is not built yet. All
       * that is added here is a sentence saying which directory and whose job
       * it is, because a bare ENOENT on a path an operator never typed sends
       * them looking in the wrong place.
       */
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RelayReplyError(
          collator,
          childTaskId,
          dir,
          `the collator "${collator}" has no replies directory at ${dir}, so the report for ` +
            `"${childTaskId}" could not be delivered (SRD-REVIEW-CONSOLE D6). That directory is ` +
            `created by \`pifleet up\` before the container starts, and it is NOT created here on ` +
            `purpose: Docker makes a missing bind-mount source rather than refusing, so a run ` +
            `that reached this point has a collator mounted on a different directory — writing ` +
            `here would deliver three reports nothing can read. Nothing was journalled; the pass ` +
            `retries. Rebuild the run with \`pifleet up\`.`,
          { cause: err },
        );
      }
      throw err;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * **THE EXPORT `src/cli/commands/relay.ts` LOOKS UP BY NAME.**
 *
 * That module does `mod["consoleFanOut"]` inside its action and refuses with
 * `EXIT.INTERNAL` when it is not a function, naming the missing symbol. The
 * string is spelled in two files that cannot see each other, so
 * `collator-relay-adapter.test.ts` pins the pair — a rename on either side is a
 * red test rather than a console that comes up, polls forever and dispatches
 * nothing.
 *
 * The composition is the whole of it: resolve the worker→run map for this
 * console (D4 — four runs), build a transport bound to THIS request's collator,
 * hand both to the pure core, and translate its three outcomes into the two the
 * journal tells apart. Every decision is one file up or one file down; none of
 * them is here.
 */
/**
 * The real reads. Every path in the console is derived HERE and nowhere else.
 *
 * `isLiveWorker` is a LIVE worker, not merely a directory that once existed.
 * `existsSync(workerPaths(run, worker).dir)` was the predicate and it is why the
 * scan could capture a stranger: `pifleet down` removes containers and leaves
 * directories, so every run this operator has ever started answered `true` for
 * every worker it ever materialised, and the candidate set was "every run on the
 * host". Liveness narrows it to runs with a supervisor actually holding the
 * seat. It does NOT make the answer unique — two live consoles still collide —
 * which is what the ambiguity refusal is for; the two together are the fix and
 * either alone is not.
 */
export const productionRunSources: ConsoleRunSources = {
  runsRoot: () => {
    // Synchronous by contract, so the lazily-loaded module cannot be used here.
    // `runsRoot` reads one env var and joins a path; duplicating that would be a
    // second definition of where runs live, so it is imported eagerly instead —
    // `paths.ts` pulls in nothing heavy, which is why it is the one exception.
    return runsRootEager();
  },
  listRunIds: async (root) => {
    const m = await loadEffectModules();
    return m.paths.runIdsAscending(root);
  },
  runPathsFor: (runId, root) => runPathsEager(runId, root),
  isLiveWorker: async (run, worker) => {
    const m = await loadEffectModules();
    const wp = m.paths.workerPaths(run, worker);
    if (!existsSync(wp.dir)) return false;
    try {
      const state = await m.state.readWorkerState(wp);
      if (state === null || state.phase === "dead") return false;
      return (await m.registry.processStartTime(state.pid)) !== null;
    } catch {
      return false;
    }
  },
  pinnedRuns: () => process.env["PIFLEET_RELAY_RUNS"],
};

export const consoleFanOut: (input: RelayFanOutInput) => Promise<RelayFanOutResult> =
  makeConsoleFanOut({
    resolveRuns: (input) => consoleRunResolution(input, productionRunSources),
    transport: (collator) => consoleTransport(collator, productionRelayEffects),
  });
