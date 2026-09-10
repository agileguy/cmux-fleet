/**
 * `submit_report` and `get_replies` — the envelope written by the host's own
 * hand, and the reply set declared by the host's own hand.
 *
 * Two tools, one file, and they are here together because they are the same
 * argument pointed in opposite directions: the host owns the identity of what a
 * worker writes, and the host owns the identity of what a worker reads. Neither
 * is a convenience wrapper over `write` or `read`; each removes a value the
 * model would otherwise have to copy correctly out of prose.
 *
 * ## What this replaces, and why the replacement is not a convenience
 *
 * Today a worker composes `pifleet.result/v1` as TEXT and writes it with the
 * `write` tool. Four of its eleven fields are things the worker must copy
 * correctly from prose: `schema`, `task_id`, `epoch` and `worker`.
 * `skills/pifleet-worker/SKILL.md:203-215` spends thirteen lines — including a
 * recorded reversal of earlier guidance — instructing a model to *"copy the
 * `epoch:` number off your prompt"*, and `src/harvest/outbox.ts:721-724`
 * refuses envelopes whose `task_id` or `epoch` disagree with the location they
 * were found in. **Thirteen lines of prose and two host-side refusal codes
 * exist to protect two numbers this file can read out of a file the worker
 * cannot write** (`/policy/task`, `src/run/task-policy.ts`).
 *
 * So none of those four is a parameter. They are not "defaulted" or
 * "validated" — they are ABSENT from the schema, and §12's criterion for this
 * file reddens if any of them is added back.
 *
 * ## Every refusal throws, and that was measured rather than assumed
 *
 * `docs/extensions.md` §Tool Definition: *"To mark a tool execution as failed
 * (sets `isError: true` on the result and reports it to the LLM), throw an
 * error from `execute`. Returning a value never sets the error flag."* A
 * refusal that returns is a refusal the model never sees.
 *
 * The open question was whether a thrown error is a CORRECTION or a token
 * sink — SRD §11 Q4. Measured 2026-09-08 against all four models in
 * `fleet.yaml` with a tool that threw on call one and succeeded on call two:
 * every model called it exactly twice, none looped on the invalid call, none
 * abandoned the tool. Retry latency 0.8s (glm) to 2.1s (qwen). **So the
 * refusals here are strict and there is no `prepareArguments` shim**, which
 * would have been the alternative and which would have folded a near-miss into
 * a valid call instead of telling the model what it got wrong.
 *
 * ## VALIDATE EVERYTHING, THEN WRITE — and the order is the testable property
 *
 * Every check runs before the first byte reaches the filesystem. Not for
 * tidiness: §12 asks each refusal to be pinned by a criterion asserting BOTH
 * the throw AND that nothing was written, and an implementation that opened
 * the envelope before checking the artifact list would pass the first half of
 * every one of those and fail the second. The `report` file is written first
 * and the envelope second — an envelope naming a file that is not there yet is
 * a false claim, while a file with no envelope is merely a report that has not
 * landed, which is the failure this fleet already knows how to read.
 *
 * ## Why the envelope is written tmp-then-rename, and why `/policy/task` is NOT
 *
 * These two recipes are exact opposites and the reason is worth stating,
 * because getting them backwards is silent in both directions.
 *
 * `src/run/task-policy.ts` rewrites `/policy/task` IN PLACE — chmod 0644,
 * truncate, write, chmod 0444, never rename — because that path is a FILE bind
 * mount and a bind mount pins the inode: a rename swaps the file the host sees
 * while the container goes on reading the old one, with both sides believing
 * the policy changed.
 *
 * `/outbox` is a DIRECTORY bind mount (`src/config/render.ts:528`). Nothing
 * pins `result.json`'s inode, and the harvester opens it by path on its own
 * schedule, with no coordination with the worker. An in-place write would
 * therefore be readable BY THE HOST while it was half-written, and a
 * half-written envelope is not "retry later" — `readResultEnvelope` grades it
 * `unreadable` and the worker is recorded as having produced garbage. So the
 * bytes are written to a dot-prefixed temp beside the target and renamed onto
 * it, which is atomic within one filesystem and is why a partially delivered
 * report is not a state the host can observe.
 *
 * The temp lives inside `<outbox>/<task-id>/` rather than at the mount root so
 * that a hard crash mid-write leaves its litter attributable to the task that
 * made it. That litter is not silent: `src/harvest/task-outbox.ts:209` knows
 * exactly two names under a task outbox, and anything else is reported to the
 * operator as an unrecognised entry. **That is the correct outcome and not a
 * cost** — an interrupted delivery should be visible. Every handled failure
 * unlinks the temp itself, so only a crash can leave one.
 *
 * ## `parameters` is a JSON Schema literal, and that is a decision, not a shortcut
 *
 * SRD §6.2 (line 670) specifies `Type` from `typebox` and `StringEnum` from
 * `@earendil-works/pi-ai`. Both resolve inside the image — measured — and
 * NEITHER resolves here: this repository has no `typebox` in `node_modules`,
 * so a top-level `import { Type } from "typebox"` makes this file unimportable
 * from `test/`, unimportable by `bun -e "import(...)"`, and therefore
 * unprovable-loadable and untestable. That is precisely the shape
 * `dispatch-trigger.ts:81-102` argues against at length, one level up: a file
 * nothing typechecks and nothing tests, shipped into a container where the
 * first evidence of a mistake is a worker with no writing verb at all
 * (SRD failure mode 9.1).
 *
 * A literal is not a downgrade, and this was measured rather than reasoned:
 *
 * - `@earendil-works/pi-ai/dist/utils/validation.js:257` branches explicitly on
 *   `!hasTypeBoxMetadata(parameters) && isJsonSchemaObject(parameters)` and
 *   runs an ADDITIONAL JSON-Schema coercion pass for that case. A plain object
 *   is a supported first-class shape, not something that happens to work.
 * - `Compile()` (`typebox/compile`) accepts it. Run in the real image
 *   2026-09-08: valid arguments passed; `status: "nope"` was rejected with
 *   *"must be equal to one of the allowed values"*; a missing `status` was
 *   rejected with *"must have required properties status"*.
 * - `StringEnum(["success","partial"])` returns `{"type":"string","enum":
 *   ["success","partial"]}` — byte-identical to what is spelled below.
 *   §6.2's `StringEnum` instruction is about the SPELLING that reaches the
 *   provider (`type`+`enum`, never `anyOf`/`const`, *"`Type.Union`/`Type.Literal`
 *   doesn't work with Google's API"*), and the literal IS that spelling. The
 *   instruction is honoured, not evaded.
 *
 * ## Layers 2, 3 and 4 — delivery is cheap, non-delivery is asked about once,
 * and it is a fact either way
 *
 * §6.3 orders four responses to a turn that ends without a report, and this
 * file carries the second, the third and the fourth. None is a veto; §2.3
 * measured that no veto exists.
 *
 * **Layer 2 is `terminate: true` on the result.** `docs/extensions.md` calls it
 * a hint that *"the automatic follow-up LLM call should be skipped after the
 * current tool batch"*, effective *"only when every finalized tool result in
 * that batch is terminating"*. It cannot make not-delivering fail. What it does
 * is make delivering the cheapest available way to end a turn — no follow-up
 * call, no further tokens — so the right action is also the lazy one. §11 Q3
 * measured it in the real image against all four models in `fleet.yaml`:
 * `agent_end` fired 2-4ms after the terminating result and every task settled
 * `verdict: success, reason: quiesced`, with the supervisor reading nothing as
 * an anomaly — **on the `rpc` plane, which is not the one console seats run on.**
 * Every seat is `pane_mode: tui`, where completion is read off the transcript and
 * this hint leaves the last assistant message on `stopReason: "toolUse"` for ever.
 * That settled three live seats `timed_out` on complete reports before ISC-1105
 * taught `supervisor/tui.ts` to recognise a delivered report as a turn that ended. It did NOT suppress a queued `followUp`, so it is compatible with
 * the bounded nag of layer 3, which is `NAG_TEXT` and `shouldNag` below.
 *
 * **Layer 3 is one `sendUserMessage` per `(task_id, epoch)`** (§6.3, task 4.1).
 * When `agent_end` finds a live task, no delivery, and at least one tool call
 * this epoch, the handler sends a CONSTANT string naming the omission and the
 * tool, marks the epoch, and never sends a second one for it. §11 Q1 measured
 * the whole of what this buys and the whole of what it costs: a
 * `sendUserMessage(text, {deliverAs: "followUp"})` from `agent_end` lands as a
 * `queue_update` and Pi runs a further agent cycle, and all four models in
 * `fleet.yaml` called the tool the nag asked for — but the supervisor settled
 * between 0.18s and 1.05s after they acted. **Layer 3's runway is about a second
 * of slack, not a turn**, which is why `NAG_TEXT` tells the model what to call
 * and what the two required arguments are rather than asking it to work
 * anything out. A model slower than those four loses the race, and layer 3 is
 * built so that losing it costs nothing: the record below is written whether the
 * nag lands or not.
 *
 * **Layer 4 is two session entries**, both written through `pi.appendEntry`,
 * which *"does NOT participate in LLM context"* (`types.d.ts:871`). They land
 * in the session JSONL under `/sessions`, bind-mounted read-write from the run
 * tree (`render.ts:560`), so the host can read them with no new mount and the
 * model never sees either. Together they split one thing
 * `SweepJoin.claimedSuccess` currently cannot: *the worker never called the
 * tool* and *the worker called it and the write failed* look identical from the
 * absence of a file, and they send an operator to different places.
 *
 * - **`pifleet.submit/v1` on delivery** (§7.1, task 3.2).
 * - **`pifleet.no_submit/v1` at `agent_end` when nothing was delivered** (§7.2,
 *   task 3.3), carrying the epoch's `tool_calls`. That field is the one that
 *   separates defect 5's two measured shapes — a `gpt-oss-20b` that ran one
 *   `ls` and quit from a `gemma-4-26b` that made 150 `kubectl` calls — and an
 *   operator should not have to open a transcript to tell them apart. It also
 *   carries `nagged`, and that field is layer 3 MIRRORED THROUGH `appendEntry`
 *   as §6.3 asks: the nag is sent before the entry is composed, so the record
 *   of an epoch that got one is durable in the session even if the extension's
 *   memory is not. **What the mirror does not do is restore the bound** — the
 *   declared surface (§7.6) has no way to read a session entry back, so a
 *   `/reload` really does reset `nagged` to false in memory and a reloaded
 *   extension may nag a second time for the same epoch. §6.3's *"so a `/reload`
 *   cannot reset it"* overstates what one-way `appendEntry` can buy; the entry
 *   is evidence for the host, not state for this file.
 *
 * **Read those two together and a third case appears, which is the whole
 * reason the delivered flag is held in memory rather than inferred:** a submit
 * entry means delivered and recorded, a no_submit entry means nothing HAD been
 * delivered when that `agent_end` fired, and NEITHER entry means delivered with
 * the session write lost.
 *
 * **"had been", and the tense is layer 3's doing.** A nagged epoch ends more
 * than once (Q1: the `followUp` extends the turn), so the sequence a delivery
 * after a nag leaves in the session is a `pifleet.no_submit/v1` carrying
 * `nagged: true` FOLLOWED BY a `pifleet.submit/v1` for the same
 * `(task_id, epoch)`. A host reading no_submit entries alone would call that
 * epoch undelivered, and it is not — it is the case layer 3 exists to produce.
 * **Entries must therefore be read per epoch and in order: a submit entry
 * settles the epoch it names, whatever precedes it.**
 *
 * The third case exists because the append below is wrapped in a `catch` that
 * swallows — a diagnostic write may not un-deliver a report that landed — so
 * the absence of a submit entry is NOT proof the tool was never called, and a
 * `no_submit` inferred from that absence would be a false accusation against a
 * worker that did its job.
 *
 * **Both entries are diagnosis and may not become authority** — §6.5 property 3
 * lists where they may appear (an actor log, `pifleet monitor`,
 * `claimedSuccess`'s message) and where they may not (a verdict, a coverage
 * count, an incident transition, a notification). This file holds up its half
 * of that fence by putting nothing in either entry worth branching on: host
 * state, a byte count measured from the file that landed, the paths the
 * envelope already claims, and a count of calls this file made itself. No
 * `summary`, no `notes`, nothing the model wrote, and nothing read back out of
 * `AgentEndEvent.messages`. §12's authority anti-criterion is a host-side guard
 * and is not asserted here.
 *
 * ## The size of `report.content` is NOT capped here, deliberately
 *
 * §6.2's schema gives `content` no `maxLength`, and SRD §11 Q8 measured why a
 * cap invented at this layer would be a guess: at 64 KB three hosted models
 * emit NO TOOL CALL AT ALL, and at 8 KB `gemma` delivered a SUCCESSFUL call
 * carrying 3219 of 8192 bytes with `isError` false. Both failures happen
 * before `execute` ever runs, so no number written here could detect either.
 * The bound that exists is a role's brief and Phase 7's per-role gate, not a
 * constant in this file.
 *
 * ## `get_replies` — DECLARED, never listed, and the empty set is an answer
 *
 * §6.2.2 and D6. The tool takes no arguments and it never calls `readdir`.
 * `/replies` is one directory per worker per RUN and the triage console is one
 * long-lived run publishing into it every sweep, so **sweep 5's collator listing
 * that directory would be handed sweeps 1 through 5, each of which reads like a
 * perfectly good answer to the question actually asked** — Finding E, and the
 * reason `src/run/replies.ts` refuses a listing from the publishing end. The set
 * cannot be discovered, so it is DECLARED: `/policy/replies`, host-written,
 * `:ro`, rewritten in the same act that publishes the replies
 * (`src/run/replies-policy.ts`).
 *
 * **Three refusals, and the first of them is the point of the file existing.**
 * A declaration carrying `replies: []` is a turn-one dispatch, and the refusal
 * it produces says *"No replies were declared for this task"* — which is a
 * different sentence from *"the directory is empty"* and is the distinction
 * `roles/triage.md` and `roles/collator.md` each spend six lines of prose
 * establishing. A `readdir` cannot make that distinction at all: an empty
 * `/replies` on turn one and an empty `/replies` after a fan-out that silently
 * failed are the same bytes. The empty ARRAY is a value the host wrote on
 * purpose, and refusing on it is reporting that value rather than losing it.
 *
 * **The freshness check is an equality against `/policy/task`, and it compares
 * two strings that are the same string by construction** (failure mode 9.6 —
 * *"Finding E arriving through the front door"*: a dispatch that rewrote
 * `/policy/task` and not `/policy/replies` hands the collator a previous sweep's
 * set). `renderTaskPolicy` strips control characters and slices to 200, so
 * `renderRepliesPolicy` stores the task id **as `/policy/task` spells it** — by
 * calling that renderer and reading line 1 back, not by copying its rules. This
 * end honours the other half of that: it compares `declared.task_id` against the
 * task id `parseTaskPolicy` returns, which IS line 1 verbatim, and it normalizes
 * neither side. A check that re-derived the spelling — a second `slice`, a
 * second character class, a trim — would report a stale declaration for a set
 * that is perfectly fresh, which is the most expensive way a freshness check can
 * be wrong: it is silent, it is on the honest path, and it looks like the tool
 * working.
 *
 * **A declared reply that did not arrive is REPORTED, not omitted**, and in the
 * vocabulary `roles/triage.md` already uses: *"No report was produced"* for a
 * file that is not there, and *"A report was produced and could not be read"*
 * for one that is there and does not parse. Those are different things for a
 * person to do next — one re-runs a seat, the other goes and looks at a file
 * sitting on disk — and `e5d5751` is this fleet's recorded case of the cost of
 * blurring them: a right answer to the wrong document. So the JSON parse here is
 * a VALIDATION and not a transformation; what comes back is the file's own bytes,
 * because re-serializing a parse would hand the collator a document the host
 * never wrote.
 *
 * **`get_replies` writes nothing, terminates nothing, and records nothing.** It
 * does not mark the epoch delivered — a collator that looked and reported
 * nothing is exactly the turn layers 3 and 4 exist to catch, and a read tool that
 * quieted them would be spending `submit_report`'s evidence on a `read`. It sets
 * no `terminate`, because a turn that has just fetched its inputs is the one turn
 * that must not be encouraged to end. **What the host gains is that a
 * `get_replies` call is a tool call**: defect 6 was a collator that made zero
 * tool calls, and under this design that is now a fact in the session rather than
 * an inference from a transcript.
 *
 * **It needs no sixth member of §7.6's surface** — only `registerTool`, which was
 * already declared and already called.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The slice of Pi's `ExtensionAPI` this file uses, declared STRUCTURALLY
 * rather than imported from `@earendil-works/pi-coding-agent`, for the reason
 * `dispatch-trigger.ts:81-102` and `truncation-recovery.ts:118-124` both give:
 * the package lives in the worker image and not in this repository, so a real
 * import would make this file uncheckable here and untestable anywhere.
 *
 * SRD §7.6 names the declared surface as `registerTool`, `on("agent_end")`,
 * `sendUserMessage` and `appendEntry`. **As of SRD task 4.1 all four have
 * callers**, which they did not before: `registerTool`, `on`, `appendEntry`
 * (the `pifleet.submit/v1` entry of task 3.2 and the `pifleet.no_submit/v1`
 * entry of 3.3) and now `sendUserMessage`, which is layer 3's bounded nag in
 * the `agent_end` handler below. It was declared here two tasks before it was
 * called because §7.6 specifies the surface as one thing.
 *
 * **`"tool_call"` is a FIFTH member and §7.6 does not name it.** Task 3.3
 * requires `pifleet.no_submit/v1` to carry the epoch's tool-call count and
 * §7.6's four give no way to observe a tool call. The alternative inside the
 * declared surface is `AgentEndEvent.messages` (`types.d.ts:507-510`), and it
 * is wrong rather than merely awkward: that array is the whole SESSION's
 * retained transcript, spanning every epoch a long-lived worker has served and
 * shortened by compaction, so counting it answers *"how many tool calls are
 * still in context"* — silently, and with nothing to notice. The deviation is
 * flagged rather than hidden; the SRD is the orchestrator's to amend.
 *
 * All five were read out of the real `.d.ts` on 2026-09-08 rather than copied
 * from the document, in `pifleet/pi-worker:0.79.6-base-b722edcf4699`:
 * `dist/core/extensions/types.d.ts:840` (`registerTool`), `:824` (`agent_end`),
 * `:835` (`tool_call`), `:867` (`sendUserMessage`), `:871` (`appendEntry`).
 *
 * The declaration is a SUBSET, so it cannot drift into claiming Pi has a method
 * it does not — only into failing to mention one this file never calls.
 *
 * **`test/integration/extension-declarations-image.test.ts` is what checks that,
 * and until ISC-1073 it did not exist.** This docblock previously named
 * `report-tools-image.test.ts`, which reads the baked file's digest and its
 * registered tool names and never opens a `.d.ts` at all — the same false
 * citation the SRD carried in three places about a different file that was also
 * never written. The check now reads the real `types.d.ts` out of the image and
 * compares this interface's members, and the events every `pi.on` call
 * subscribes to, against it — for all three extensions, not just this one.
 */
export interface ExtensionAPI {
  registerTool<Params>(tool: ToolDefinitionLike<Params>): void;
  /**
   * Both events take Pi's `ExtensionHandler<E, R>` shape — `(event, ctx) =>`
   * (`types.d.ts:804`) — and both handlers here ignore the event entirely, so
   * it is declared `unknown` rather than narrowed per event. `ctx` is not
   * ignored: `agent_end` reads the worker id off it, exactly as `execute` does.
   *
   * The return is `void` because on `tool_call` it must be: `emitToolCall`
   * blocks the tool on any truthy result carrying `block`
   * (`runner.js:648-653`, `types.d.ts:739-743`).
   */
  on(
    event: "agent_end" | "tool_call",
    handler: (event: unknown, ctx: ExtensionContextLike) => void,
  ): void;
  /**
   * Layer 3's only call. `options` is optional in Pi's signature and is passed
   * anyway: `deliverAs: "followUp"` is the SPELLING §11 Q1 measured, and the
   * measurement is of that spelling and not of the default. A `followUp` from
   * `agent_end` lands as a `queue_update` carrying the text and Pi runs another
   * agent cycle; nothing in Q1 says a `steer`, or an omitted `options`, does the
   * same thing, so the argument is not dropped as noise.
   */
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  appendEntry(customType: string, data?: unknown): void;
}

/**
 * The slice of `ExtensionContext` handed to `execute`.
 *
 * `sessionManager.getSessionId()` is the whole reason this is here.
 * `render.ts:219` launches every worker with `--session-id <w.id>`, so the
 * session id IS the worker id, chosen by the host before the container starts
 * and unwritable from inside it. It is the fourth field §6.4 requires and the
 * only one that is not derived from `/policy/task` or from a mount path.
 *
 * `cwd` is the container workdir, and it is read for exactly one purpose: the
 * artifact-path check below needs the same two roots the host's check uses.
 */
export interface ExtensionContextLike {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

/** The slice of `AgentToolResult` this file returns (`pi-agent-core` types.d.ts:305-315). */
export interface ToolResultLike {
  content: { type: "text"; text: string }[];
  details: unknown;
  /**
   * Layer 2 (§6.3). Optional in the type because it is optional in Pi's, and
   * because a required field here would be a claim about every tool this file
   * might one day register rather than about the one it does.
   */
  terminate?: boolean;
}

/**
 * The slice of `ToolDefinition` this file fills in (`types.d.ts:335-366`).
 *
 * Generic as of task 5.4, because this file now registers TWO tools whose
 * parameter shapes have nothing in common — `submit_report` takes eight fields
 * and `get_replies` takes none. Pinned to `SubmitReportParams`, which is what it
 * was while there was one tool, the second tool's `execute` would have been a
 * lie about what it receives.
 *
 * **Pi's own type is generic here too, and that was read out of the image rather
 * than assumed** (`pifleet/pi-worker:0.79.6-base-7b18f4213430`, 2026-09-08,
 * `dist/core/extensions/types.d.ts`):
 *
 *     :335  export interface ToolDefinition<TParams extends TSchema = TSchema, …>
 *     :361      execute(toolCallId: string, params: Static<TParams>, …)
 *     :840      registerTool<TParams extends TSchema = TSchema, …>(tool: …): void;
 *
 * **The one deliberate difference: Pi's parameter is the SCHEMA and derives the
 * arguments with `Static<TParams>`; this one IS the arguments.** `Static<>` and
 * `TSchema` both come from typebox, which does not resolve in this repository
 * (see the header), so a faithful copy of the constraint would make this file
 * unimportable from `test/` — the exact cost the structural declaration exists to
 * avoid. The subset stays assignable to the real type at every call site this
 * file makes, which is all a structural declaration has to be.
 *
 * `unknown` is the default rather than an `any`, so a caller holding a
 * `ToolDefinitionLike` off the registry can pass whatever it likes and the
 * implementation still has to say what it expects.
 */
export interface ToolDefinitionLike<Params = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Params,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContextLike,
  ): Promise<ToolResultLike>;
}

/** Mirrors `TASK_POLICY_MOUNT` (`src/run/task-policy.ts`). */
export const TASK_POLICY_PATH = "/policy/task";
/** Mirrors `TASK_POLICY_NONE` — the spelling of "no task is live". */
export const TASK_POLICY_NONE = "<none>";
/** Mirrors the `/outbox` bind mount (`src/config/render.ts:528`). */
export const OUTBOX_ROOT = "/outbox";
/** Mirrors `OUTBOX_FILES_DIR` (`src/harvest/outbox.ts:83`) and `SWEEP_FILES_DIR`. */
export const OUTBOX_FILES_DIR = "files";
/** Mirrors `RESULT_ENVELOPE_NAME` (`src/contracts.ts:217`). */
export const RESULT_ENVELOPE_NAME = "result.json";
/** Mirrors `ResultEnvelopeSchema`'s `schema` literal (`src/contracts.ts:220`). */
export const RESULT_SCHEMA = "pifleet.result/v1";
/** Mirrors `REPLIES_POLICY_MOUNT` (`src/run/replies-policy.ts`) — the DECLARATION. */
export const REPLIES_POLICY_PATH = "/policy/replies";
/**
 * Mirrors `REPLIES_MOUNT` (`src/run/replies.ts`) — the reply PLANE, which is a
 * different object from the declaration above and is deliberately never listed.
 *
 * It is here for one purpose: a declared `path` is `<REPLIES_ROOT>/<name>` and
 * this end must be able to say so. Every path this tool reads is the host's own
 * spelling with this prefix re-rooted onto the injected mount, so a declaration
 * naming anything else is a document `renderRepliesPolicy` did not write and is
 * refused as malformed rather than followed.
 */
export const REPLIES_ROOT = "/replies";
/** Mirrors `REPLIES_POLICY_SCHEMA` (`src/run/replies-policy.ts`). */
export const REPLIES_POLICY_SCHEMA = "pifleet.replies/v1";

/**
 * §7.1's session entry, used as BOTH `appendEntry`'s `customType` and the
 * entry's own `schema` field.
 *
 * The duplication is the document's — §6.3 writes
 * `pi.appendEntry("pifleet.submit/v1", …)` and §7.1's payload carries
 * `"schema": "pifleet.submit/v1"` — and it is worth keeping rather than
 * tidying. The `customType` is Pi's envelope and belongs to the session
 * format; the `schema` field is this fleet's, and is what makes the payload
 * self-describing once a host has lifted it out of the JSONL. The envelope
 * `submit_report` writes carries its own `schema` for the same reason —
 * `ResultEnvelopeSchema` declares it as a `z.literal` (`src/contracts.ts:220`),
 * so a document whose `schema` says something else is refused rather than read.
 */
export const SUBMIT_ENTRY_SCHEMA = "pifleet.submit/v1";

/**
 * The per-array entry cap, and why it is enforced twice.
 *
 * `src/harvest/outbox.ts:680-698` hoists a length check ahead of its zod parse
 * because `.max()` is not a bound on the work done to reach it: 2,097,101
 * invalid elements cost 2.66 GB and 1.2s before the refusal comes back. That
 * hoist stays, and this makes it the SECOND line of defence rather than the
 * first.
 *
 * 64 rather than the host's `MAX_ITEMS` of 1000 because §6.2.1's schema says
 * 64, and because the two numbers answer different questions: the host's is
 * "what can a machine survive parsing", this one is "how many blockers is a
 * report of a single task plausibly making". The check below is executable —
 * the schema's `maxItems` is enforced by Pi's validator before `execute` runs
 * and is therefore unreachable from a unit test in this repository, so a cap
 * that lived only in the schema would be a cap no test here could assert.
 */
export const MAX_ENTRIES = 64;

/**
 * How many files one `submit_report` call may write into `files/`.
 *
 * **The demand this number answers is a PAIR, not a directory.** Three of this
 * fleet's artifact contracts are two files — `observer-ops.{json,md}`,
 * `ticket-ops.{json,md}`, and a review document beside its envelope — and a
 * role that has lost `write` has no other route to the second one. `roles/
 * triage.md` states the rule in the strongest form any of them use: *"Both
 * files, every time. A run that writes only the `.md` clamps to `failed`."*
 * Four leaves room for a contract that grows a third half; it does not leave
 * room for a model to empty its workspace into a tool argument.
 *
 * **It is deliberately far below {@link MAX_ENTRIES}, and the two are not the
 * same kind of cap.** That one bounds REFERENCES — a `blocker`, an `artifact`
 * path — which cost a line each. This one bounds CONTENT, and every file
 * counted here is bytes inside the same tool argument as all the others. SRD
 * §11 Q8 measured `gemma` delivering 3 219 of 8 192 bytes with `isError` false
 * and the epoch `success`; nothing at this layer can detect having crossed that
 * floor (see the header), so the only lever here is to keep the number of
 * things in one call small.
 */
export const MAX_REPORT_FILES = 4;

/*
 * ── `dispatch_request`'s mirrored constants ────────────────────────────────
 *
 * Every one of these is a re-spelling of a value in `src/run/dispatch-request.ts`,
 * for the reason the mount paths above are re-spelled: this file is COPYied into
 * the image and executed by Pi, and it cannot import from `src/`. The unit suite
 * pins each to the module that reads the document, so a bound that moves on the
 * host reddens here instead of producing a request the host then refuses — which
 * is the failure this tool exists to remove, arriving one layer further in.
 */

/** Mirrors `DISPATCH_REQUEST_SCHEMA` (`src/run/dispatch-request.ts`). */
export const DISPATCH_REQUEST_SCHEMA = "pifleet.dispatchrequest/v1";
/** Mirrors `DISPATCH_REQUEST_FILE`. Written at the TASK ROOT, not under `files/`. */
export const DISPATCH_REQUEST_NAME = "dispatch-request.json";
/** Mirrors `MAX_DISPATCH_REQUEST_ITEMS`. */
export const MAX_DISPATCH_REQUEST_ITEMS = 8;
/** Mirrors `MAX_DISPATCH_TEXT`. */
export const MAX_DISPATCH_TEXT = 32 * 1024;
/** Mirrors `MAX_DISPATCH_ID_CHARS`. */
export const MAX_DISPATCH_ID_CHARS = 64;
/** Mirrors `MAX_DISPATCH_SERVICES`. */
export const MAX_DISPATCH_SERVICES = 8;
/**
 * Mirrors `SESSION_ID_RE` (`src/contracts.ts`).
 *
 * A worker id and a service name both become host path segments — the first a
 * directory under a run's outbox, the second an incident record under
 * `~/.pifleet/triage/` — and both are written by a container. `isBareName`
 * above is not enough for them: it refuses a traversal, this refuses everything
 * that is not a name.
 */
export const DISPATCH_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** `submit_report`'s arguments — `schema`, `task_id`, `epoch` and `worker` are absent and that is the point. */
export interface SubmitReportParams {
  status: "success" | "partial" | "blocked" | "failed";
  summary: string;
  notes?: string;
  blockers?: string[];
  artifacts?: { kind: "file" | "diff" | "log" | "note"; path: string }[];
  acceptance?: { criterion: string; met: boolean; evidence?: string }[];
  commands_run?: { cmd: string; exit_code: number; excerpt?: string }[];
  report?: { filename: string; content: string }[];
}

/**
 * The parameter schema, as JSON Schema — see the header for why this is a
 * literal and for the measurement that says it is a supported shape rather
 * than a workaround.
 *
 * `additionalProperties: false` is the load-bearing line. Without it a model
 * that has read six role documents telling it to put `task_id` and `epoch` in
 * its envelope can pass them here, they are silently ignored, and the first
 * evidence is an operator wondering why the number the model "set" is not the
 * number on disk. With it, the attempt is a validation error naming the field,
 * which Q4 measured every model recovering from on the first retry.
 */
export const SUBMIT_REPORT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["success", "partial", "blocked", "failed"] },
    summary: { type: "string", maxLength: 4000 },
    notes: { type: "string", maxLength: 20000 },
    blockers: {
      type: "array",
      maxItems: MAX_ENTRIES,
      items: { type: "string", maxLength: 4000 },
    },
    artifacts: {
      type: "array",
      maxItems: MAX_ENTRIES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path"],
        properties: {
          kind: { type: "string", enum: ["file", "diff", "log", "note"] },
          path: { type: "string", maxLength: 4096 },
        },
      },
    },
    acceptance: {
      type: "array",
      maxItems: MAX_ENTRIES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "met"],
        properties: {
          criterion: { type: "string", maxLength: 4000 },
          met: { type: "boolean" },
          evidence: { type: "string", maxLength: 20000 },
        },
      },
    },
    commands_run: {
      type: "array",
      maxItems: MAX_ENTRIES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cmd", "exit_code"],
        properties: {
          cmd: { type: "string", maxLength: 4000 },
          exit_code: { type: "integer" },
          excerpt: { type: "string", maxLength: 20000 },
        },
      },
    },
    report: {
      type: "array",
      // `minItems` and not "an empty array means no report". A model that sends
      // `report: []` has decided it has files and then named none of them, and
      // treating that as absence is the silent reading of a mistake the
      // validator can name before `execute` runs.
      minItems: 1,
      maxItems: MAX_REPORT_FILES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["filename", "content"],
        properties: {
          filename: { type: "string", maxLength: 255 },
          // No `maxLength`. See the header: §11 Q8's failures all happen before
          // `execute` runs, so a number here would detect none of them.
          content: { type: "string" },
        },
      },
    },
  },
} as const;

/** What `/policy/task` names when a task is live. */
export interface LiveTask {
  taskId: string;
  epoch: number;
}

/**
 * The four mounts these tools read and write, injectable for the same reason
 * `truncation-recovery.ts` injects `readFull`: without it every assertion in
 * `test/unit/report-tools.test.ts` would have to be made against the real
 * `/policy/task` and the real `/outbox`, which exist on no developer's machine
 * and on no CI runner. The default is the real set, so nothing in the image
 * depends on a caller remembering to pass them.
 *
 * All four are REQUIRED rather than optional-with-a-default-per-field, and that
 * is the property `DEFAULT_MOUNTS`'s own test pins. An optional field would let
 * a future caller pass three and silently inherit the fourth from a constant
 * that is correct only inside the image — which in a test is a read against a
 * path that does not exist, and is exactly the shape of failure the injection
 * exists to remove.
 */
export interface MountRoots {
  policyPath: string;
  outboxRoot: string;
  /** `/policy/replies` — the declared reply set (§7.4), read by `get_replies`. */
  repliesPolicyPath: string;
  /** `/replies` — the plane the declared paths point into. Never listed. */
  repliesRoot: string;
}

export const DEFAULT_MOUNTS: MountRoots = {
  policyPath: TASK_POLICY_PATH,
  outboxRoot: OUTBOX_ROOT,
  repliesPolicyPath: REPLIES_POLICY_PATH,
  repliesRoot: REPLIES_ROOT,
};

/** The mounts plus the workdir, which comes from `ctx` rather than from a constant. */
export interface Roots extends MountRoots {
  /** The container workdir, or null for a role with no code mount (`isolation: none`). */
  workdir: string | null;
}

export const DEFAULT_ROOTS: Roots = { ...DEFAULT_MOUNTS, workdir: null };

/**
 * Read `/policy/task`'s two lines, or null when they do not name a usable
 * live task.
 *
 * Null covers four cases and the caller's response to all four is to refuse
 * the call: the idle spelling `<none>`, a missing epoch line, an epoch that is
 * not a non-negative integer, and a task id that could not be a directory name.
 *
 * **The fourth is a defence against a HOST bug, not a worker one**, and it is
 * here rather than assumed away because it is the one that would be silent.
 * `renderTaskPolicy` strips control characters and nothing else; `task_id` is
 * `shortStr` in `src/contracts.ts` with no charset rule. A task id of
 * `../other-worker` would make the derivation in `taskPaths` below resolve into
 * a DIFFERENT worker's outbox, and the resulting envelope would look entirely
 * well-formed to everyone. One comparison closes it.
 */
export function parseTaskPolicy(body: string): LiveTask | null {
  const lines = body.split("\n");
  const taskId = lines[0] ?? "";
  const epochText = lines[1] ?? "";
  if (taskId === "" || taskId === TASK_POLICY_NONE) return null;
  if (!isBareName(taskId)) return null;
  if (!/^\d+$/.test(epochText.trim())) return null;
  const epoch = Number.parseInt(epochText.trim(), 10);
  if (!Number.isSafeInteger(epoch)) return null;
  return { taskId, epoch };
}

/**
 * A name that is one path segment and nothing else.
 *
 * Shared by the task id above and by `filenameProblem` below because they are
 * the same rule asked about two different strings, and §6.2.1's two rows give
 * it the same reason twice: a value that is spent as a path segment must not
 * be able to become a path.
 */
function isBareName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  // Control characters and DEL: the set `renderTaskPolicy` strips at the
  // writing end, refused here because this end must not trust that it did.
  if (/[\u0000-\u001f\u007f]/u.test(name)) return false;
  return true;
}

/**
 * The refusal thrown by every check in this file, so a caller can tell them
 * apart from an ENOENT.
 *
 * ONE class for both tools, and the name it was given while there was one tool
 * is kept rather than widened. It is the vocabulary a caller matches on, and
 * renaming it would rewrite every assertion in `test/unit/report-tools.test.ts`
 * to buy a word — while a second class would let a caller catch one refusal and
 * miss the other, which is the only outcome that costs anything. What the class
 * means is *"this file refused, and nothing was written"*; that is true of
 * `get_replies`'s three refusals exactly as it is of `submit_report`'s five.
 */
export class SubmitRefusal extends Error {
  override readonly name = "SubmitRefusal";
}

function refuse(message: string): never {
  throw new SubmitRefusal(message);
}

/**
 * Read the live task, or refuse.
 *
 * Two distinguishable messages, because the fixes are different: a mount that
 * is not there is an operator's problem and an idle worker is nobody's. The
 * `<none>` case reproduces §6.2.1's message shape exactly; a malformed file
 * quotes its own first line, which is strictly more useful than pretending it
 * said `<none>`, and which is safe to quote because the worker cannot write it.
 */
export function readTaskPolicy(policyPath: string): LiveTask {
  let body: string;
  try {
    body = readFileSync(policyPath, "utf8");
  } catch {
    refuse(`No task is live. \`${policyPath}\` could not be read.`);
  }
  const live = parseTaskPolicy(body);
  if (live === null) {
    const first = (body.split("\n")[0] ?? "").slice(0, 120);
    refuse(`No task is live. \`${policyPath}\` says \`${first}\`.`);
  }
  return live;
}

/**
 * Why a `report.filename` is not a bare name, or null.
 *
 * The three cases §6.2.1 names are `/`, `..` and a leading `@`. The first two
 * are `src/harvest/outbox.ts`'s escape refusal moved to the call site, where a
 * model can act on it. The third is `docs/extensions.md`'s own warning —
 * *"Some models are idiots and include the @ prefix in tool path arguments"* —
 * and it is REFUSED rather than stripped, because Q4 measured every model
 * recovering from a thrown error on the first retry while a silent strip would
 * make `@notes.md` and `notes.md` the same file with no record of which the
 * model asked for.
 *
 * The leading `@` gets its own message. "Not a path" is unhelpful advice for a
 * name that is not a path — the fix is to drop one character, and saying so is
 * the difference between a correction and a riddle.
 */
export function filenameProblem(filename: string): string | null {
  if (filename.startsWith("@")) {
    return "`filename` must not start with `@` — pass the bare name, without the `@` prefix.";
  }
  if (!isBareName(filename)) {
    return "`filename` is a bare name inside `files/`, not a path.";
  }
  return null;
}

/**
 * Why a declared artifact path is inadmissible, or null.
 *
 * **This mirrors `src/harvest/outbox.ts`'s `artifactPathProblem`, which accepts
 * a path inside the task outbox OR inside the worktree** — not the
 * outbox-only rule §6.2.1's message column reads as. That column and its
 * "Same host refusal, same reasoning" justification disagree, and the
 * justification is the half worth honouring: a call-site check STRICTER than
 * the host's would refuse an `engineer` reporting `/workspace/patch.diff`,
 * which the host accepts today, and §6.5 property 2 is explicit that this
 * validation is *"a courtesy to the model"* while the host's *"is the one that
 * decides"*. A courtesy that refuses what the decider accepts is a new
 * restriction wearing a refusal's clothes. Being LOOSER than the host is the
 * safe direction and being stricter is not.
 *
 * The resolution rule is the host's, spelled once: an absolute path is a
 * CONTAINER path, a relative one is relative to the task outbox
 * (`artifactClaimToHost`). Lexical throughout — nothing here is opened or
 * stat'd, because deciding admissibility must not depend on what happens to
 * exist yet.
 */
export function artifactPathProblem(
  path: string,
  taskDir: string,
  workdir: string | null,
): string | null {
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    return `artifact path contains a control character.`;
  }
  if (path.includes("\\")) {
    return `artifact \`${path}\` uses a backslash; container paths use \`/\`.`;
  }
  const resolved = isAbsolute(path) ? resolve(path) : resolve(taskDir, path);
  if (within(taskDir, resolved)) return null;
  if (workdir !== null && within(workdir, resolved)) return null;
  return `artifact \`${path}\` is outside \`${taskDir}/\`.`;
}

/**
 * Whether an artifact claim names a file that is NOT THERE.
 *
 * Separate from `artifactPathProblem` on purpose. That one is a predicate about
 * the SPELLING of a path — control characters, backslashes, containment — and
 * is pure, which is why it is the one with exhaustive table tests. This one
 * asks the filesystem, and the two answers fail for unrelated reasons: a claim
 * can be perfectly shaped and name nothing, which is exactly the case below.
 *
 * ## The failure this closes, measured
 *
 * `rev-lang-1` submitted T-rv-155's review with
 * `artifacts: [{kind: "file", path: "files/review.md"}]` and **never wrote the
 * file**. Its outbox held `result.json` and no `files/` directory at all. The
 * envelope was accepted, harvested, and collated; the collator recorded the
 * lens as `reported: true` and then had to note that the artifact "was not
 * harvested". Eleven findings survived only as the one-paragraph summary the
 * envelope happened to carry. Nothing refused anything at any point.
 *
 * The docblock on `composeEnvelope` says the auto-append means the
 * declare-what-you-wrote rule "cannot be forgotten — it is no longer something
 * the model has to remember to do." That is true of the `report` parameter and
 * ONLY of it. A hand-composed `artifacts` entry goes nowhere near that path, so
 * the rule was still exactly as forgettable as it had always been for anything
 * a model wrote itself — and §6.3 calls layer 1 a mechanism rather than an
 * incentive precisely because it is supposed to make the false claim
 * unrepresentable rather than merely discouraged.
 *
 * ## Why the pending report is exempt
 *
 * Phase 1 runs before phase 2 has written anything, so the report file this
 * very call is about to create does not exist yet. A caller that passes
 * `report` AND redundantly lists its file in `artifacts` is making a claim that
 * WILL be true by the time the envelope lands, and refusing it would be a false
 * positive on a call that does everything right. `pendingReportPath` is that
 * one path, resolved the same way the claim is, and nothing else is forgiven.
 */
export function artifactMissingProblem(
  path: string,
  taskDir: string,
  pendingReportPaths: readonly string[],
): string | null {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(taskDir, path);
  if (pendingReportPaths.includes(resolved)) return null;
  if (existsSync(resolved)) return null;
  return (
    `artifact \`${path}\` does not exist. Declare a file only after writing it, ` +
    `or pass it as \`report\` and let this tool write and declare it for you.`
  );
}

/** Is `child` at or beneath `root`, lexically? */
function within(root: string, child: string): boolean {
  const rel = relative(resolve(root), child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

/**
 * Why an array in the call is over the cap, or null.
 *
 * Named per field rather than as one count, because "your report has too many
 * things in it" is not actionable and "`blockers` has 91 entries; cap is 64"
 * is. The fields are walked in the schema's own order so two oversized arrays
 * always report the same one first.
 */
export function capProblem(params: SubmitReportParams): string | null {
  const arrays: [string, unknown[] | undefined][] = [
    ["blockers", params.blockers],
    ["artifacts", params.artifacts],
    ["acceptance", params.acceptance],
    ["commands_run", params.commands_run],
  ];
  for (const [field, value] of arrays) {
    if (value !== undefined && value.length > MAX_ENTRIES) {
      return `\`${field}\` has ${value.length} entries; cap is ${MAX_ENTRIES}.`;
    }
  }
  // Checked HERE rather than beside the arrays above because it is a different
  // bound in different units — see {@link MAX_REPORT_FILES}. Folding it into
  // that loop would have made one message quote the wrong number.
  if (params.report !== undefined && params.report.length > MAX_REPORT_FILES) {
    return `\`report\` has ${params.report.length} files; cap is ${MAX_REPORT_FILES}.`;
  }
  return null;
}

/** The three paths every call derives, from the task id and the mount and nothing else (§6.4). */
export function taskPaths(outboxRoot: string, taskId: string): {
  taskDir: string;
  filesDir: string;
  envelopePath: string;
} {
  const taskDir = join(outboxRoot, taskId);
  return {
    taskDir,
    filesDir: join(taskDir, OUTBOX_FILES_DIR),
    envelopePath: join(taskDir, RESULT_ENVELOPE_NAME),
  };
}

/** A `pifleet.result/v1` envelope, as this file composes it. */
export interface ResultEnvelope {
  schema: string;
  task_id: string;
  epoch: number;
  worker: string;
  status: string;
  summary: string;
  notes?: string;
  blockers?: string[];
  artifacts?: { kind: string; path: string }[];
  acceptance?: { criterion: string; met: boolean; evidence?: string }[];
  commands_run?: { cmd: string; exit_code: number; excerpt?: string }[];
}

/**
 * Compose the envelope: four fields from host state, the rest from the call.
 *
 * Optional fields are OMITTED when absent rather than defaulted to `[]` or
 * `""`. `ResultEnvelopeSchema` supplies those defaults itself and is not
 * `.strict()`, so §7.3's rule — *"must not rely on an extra field surviving the
 * round trip, and must not add one"* — cuts both ways: writing `blockers: []`
 * for a worker that mentioned no blockers is this file inventing a claim on the
 * worker's behalf, and the difference between "reported none" and "did not
 * report" is one an operator reading the raw JSON should keep.
 *
 * When a `report` was written, its file is appended to `artifacts`, so the
 * declare-what-you-wrote rule (`roles/reviewer.md:53-58`) cannot be forgotten —
 * it is no longer something the model has to remember to do.
 *
 * **The appended claim is RELATIVE — `files/<name>` — and not the absolute
 * `/outbox/<task-id>/files/<name>` that `roles/reviewer.md:120`'s example
 * shows.** Both are accepted; the relative one is chosen because it is the
 * only spelling that is true in more than one place. An absolute claim is a
 * statement about the container's filesystem, so composing one means either
 * hard-coding `/outbox` — a constant that is correct only inside the image,
 * written into a value every test would then have to special-case — or
 * interpolating the injected mount root, which would leak a tmpdir into the
 * contract. A relative claim resolves against the task outbox wherever the task
 * outbox turns out to be, and is therefore identical in a fixture and in
 * production.
 *
 * This is safe *now* and was not always: `src/harvest/outbox.ts:424` records
 * that the validator once accepted a relative claim the reconciler did not,
 * producing two contradictory discrepancies about one file. Both passes ask
 * `artifactClaimToHost` today (`outbox.ts:533`, `reconcile.ts:626`), so they
 * cannot disagree about this spelling again.
 */
export function composeEnvelope(
  params: SubmitReportParams,
  live: LiveTask,
  worker: string,
  reportArtifactPaths: readonly string[],
): ResultEnvelope {
  const artifacts = [...(params.artifacts ?? [])];
  for (const path of reportArtifactPaths) {
    artifacts.push({ kind: "file", path });
  }
  const envelope: ResultEnvelope = {
    schema: RESULT_SCHEMA,
    task_id: live.taskId,
    epoch: live.epoch,
    worker,
    status: params.status,
    summary: params.summary,
  };
  if (params.notes !== undefined) envelope.notes = params.notes;
  if (params.blockers !== undefined) envelope.blockers = params.blockers;
  if (artifacts.length > 0) envelope.artifacts = artifacts;
  if (params.acceptance !== undefined) envelope.acceptance = params.acceptance;
  if (params.commands_run !== undefined) envelope.commands_run = params.commands_run;
  return envelope;
}

let tempCounter = 0;

/**
 * Write `bytes` to `path` so no reader ever sees a prefix of it.
 *
 * The temp name is dot-prefixed and carries pid plus a counter: two concurrent
 * `submit_report` calls must not share a temp, and the rename that loses is
 * still a complete envelope. `rmSync` on the failure path is what keeps a
 * HANDLED failure from leaving an unrecognised entry behind; only a crash
 * between the write and the rename can, and that one is meant to be visible.
 */
export function writeAtomic(path: string, bytes: string): void {
  tempCounter += 1;
  const temp = `${path}.${process.pid}.${tempCounter}.tmp`;
  try {
    writeFileSync(temp, bytes, { encoding: "utf8", mode: 0o644 });
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** What a delivered report was. */
export interface SubmitOutcome {
  path: string;
  bytes: number;
  status: string;
  /** Every report file's container path, in the order they were written. */
  reportPaths: string[];
  /**
   * The live task it was delivered under, carried out rather than re-read.
   *
   * `submit_report` reads `/policy/task` once, at the top of `submitReport`,
   * and everything downstream — the paths, the envelope, the session entry —
   * is derived from that single read. A second read for the entry could see a
   * DIFFERENT task: `/policy/task` is rewritten in place at every dispatch
   * (`task-policy.ts:33-41`) and nothing coordinates that with a call in
   * flight. The entry would then name a task the envelope does not, which is
   * the one way a diagnostic record could be actively misleading.
   */
  taskId: string;
  epoch: number;
  /**
   * Every path the ENVELOPE's `artifacts[]` claims, verbatim and in its order.
   *
   * The envelope's and not the call's, because the two differ by exactly the
   * files this tool wrote itself: `composeEnvelope` appends every `report`
   * claim. Those are the files an operator hunting a half-delivered report is
   * most likely to be looking for, so dropping them here would empty the field
   * of its best case.
   *
   * Verbatim and not by basename. A basename reads well in a log and cannot be
   * resolved back to anything — `files/notes.md` and `/workspace/notes.md` are
   * both `notes.md` once the directory is gone, and §6.2.1 admits both.
   */
  artifactFiles: string[];
}

/**
 * The whole of `submit_report`, with its roots injected so a test can reach it.
 *
 * The `worker` argument is passed rather than read because its source is
 * `ctx.sessionManager.getSessionId()` — see `ExtensionContextLike`. It is host
 * state exactly as much as the other three are; it simply arrives through a
 * different door.
 *
 * **The two phases below are the file's only real invariant.** Everything that
 * can refuse runs first and touches nothing; then, and only then, bytes are
 * written. §12 asks for a criterion per refusal asserting the throw AND that
 * nothing was written, and this ordering is the only reason the second half of
 * each of those can hold.
 */
export function submitReport(
  params: SubmitReportParams,
  worker: string,
  roots: Roots = DEFAULT_ROOTS,
): SubmitOutcome {
  // ---- Phase 1: refuse. Nothing below this comment writes anything. --------
  const live = readTaskPolicy(roots.policyPath);
  const { taskDir, filesDir, envelopePath } = taskPaths(roots.outboxRoot, live.taskId);

  const cap = capProblem(params);
  if (cap !== null) refuse(cap);

  const reportFiles = params.report ?? [];
  const named = new Set<string>();
  for (const file of reportFiles) {
    const problem = filenameProblem(file.filename);
    if (problem !== null) refuse(problem);
    /*
     * TWO ENTRIES NAMING ONE FILE is the only new way to get this wrong, and it
     * is worth refusing rather than tolerating.
     *
     * Both writes would succeed, the second landing on the first, and the
     * envelope would CLAIM the name twice — so an operator reads a delivered
     * report that names two artifacts, finds one file, and has no way to learn
     * that the other half was overwritten rather than never composed. That is
     * §11 Q8's worst shape (a green epoch carrying a fraction of its content)
     * arriving from inside the call instead of off the wire, and unlike Q8's it
     * is detectable right here.
     */
    if (named.has(file.filename)) {
      refuse(`\`report\` names \`${file.filename}\` twice; each file is written once.`);
    }
    named.add(file.filename);
  }

  // The paths phase 2 is about to write, resolved now so the loop below can tell
  // "you have not written this yet" from "you are never going to".
  const pendingReportPaths = reportFiles.map((file) => resolve(filesDir, file.filename));

  for (const artifact of params.artifacts ?? []) {
    const problem = artifactPathProblem(artifact.path, taskDir, roots.workdir);
    if (problem !== null) refuse(problem);
    const missing = artifactMissingProblem(artifact.path, taskDir, pendingReportPaths);
    if (missing !== null) refuse(missing);
  }

  // ---- Phase 2: write. The report files first, the envelope second. -------
  const reportPaths: string[] = [];
  const reportClaims: string[] = [];
  if (reportFiles.length > 0) {
    mkdirSync(filesDir, { recursive: true });
    for (const file of reportFiles) {
      const reportPath = join(filesDir, file.filename);
      // The path WRITTEN and the path CLAIMED are deliberately different
      // spellings of one location: the first is where this process puts the
      // bytes, the second is what the envelope says about it. See
      // `composeEnvelope` for why the claim is relative.
      reportClaims.push(`${OUTBOX_FILES_DIR}/${file.filename}`);
      writeAtomic(reportPath, file.content);
      // APPENDED AFTER the write, so a throw on file 2 of 3 leaves this list
      // naming the one file that actually landed. The envelope below is never
      // reached in that case, which is the header's ordering property holding:
      // a file with no envelope is a report that has not landed, and this list
      // is what a caller would use to find it.
      reportPaths.push(reportPath);
    }
  }

  mkdirSync(taskDir, { recursive: true });
  const envelope = composeEnvelope(params, live, worker, reportClaims);
  // Pretty-printed: the harvester does not care and an operator reading a
  // failed task's outbox by hand does. Two spaces is what every other
  // JSON this repository writes for a human uses.
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  writeAtomic(envelopePath, bytes);

  return {
    path: envelopePath,
    bytes: Buffer.byteLength(bytes, "utf8"),
    status: params.status,
    reportPaths,
    taskId: live.taskId,
    epoch: live.epoch,
    artifactFiles: (envelope.artifacts ?? []).map((a) => a.path),
  };
}

/** §7.1's session entry — eight fields, and the reason there is no ninth is in the header. */
export interface SubmitEntry {
  schema: string;
  task_id: string;
  epoch: number;
  worker: string;
  status: string;
  bytes: number;
  artifact_files: string[];
  at: string;
}

/**
 * Compose the `pifleet.submit/v1` entry from a delivery that already happened.
 *
 * Takes a `SubmitOutcome` rather than the parameters, and that is the whole
 * design of this function: every field it can reach is either host state or a
 * measurement of the bytes that landed. There is no path from `params` to here,
 * so no amount of later editing can put a model's prose in a session entry
 * without first changing this signature.
 *
 * **`at` is a parameter.** `execute` passes `new Date().toISOString()` —
 * `2026-09-08T05:56:25.442Z`, which is what every other timestamp in this fleet
 * is (`src/util/clock.ts:28`) and is ISO8601 with a `Z`. §7.1's example elides
 * the milliseconds; nothing reads them either way, and matching the fleet's own
 * spelling is worth more than matching an illustration. Injected rather than
 * read inside so the mapping below can be asserted against exact values instead
 * of a regex.
 *
 * **The envelope's `path` is deliberately not a field.** It is a CONTAINER
 * path, and the host reading this entry is on the other side of the mount; it
 * is also derivable from `task_id` and the outbox root, and
 * `Docs/SRD-TRIAGE-CONSOLE.md` §7.8's rule applies — *"a value that must always
 * equal a function of two others is one that will one day disagree with them."*
 */
export function composeSubmitEntry(
  outcome: SubmitOutcome,
  worker: string,
  at: string,
): SubmitEntry {
  return {
    schema: SUBMIT_ENTRY_SCHEMA,
    task_id: outcome.taskId,
    epoch: outcome.epoch,
    worker,
    status: outcome.status,
    bytes: outcome.bytes,
    artifact_files: outcome.artifactFiles,
    at,
  };
}

/**
 * §7.2's session entry, used as BOTH `appendEntry`'s `customType` and the
 * entry's own `schema` field, for the reason `SUBMIT_ENTRY_SCHEMA` gives.
 */
export const NO_SUBMIT_ENTRY_SCHEMA = "pifleet.no_submit/v1";

/**
 * What this extension knows about one epoch, held in memory for its duration.
 *
 * **`delivered` is the whole design of task 3.3 and it is worth saying why it
 * is a FLAG rather than an inference.** The obvious implementation of "nothing
 * was delivered" is to look for a `pifleet.submit/v1` entry and, finding none,
 * conclude the tool was never called. It is wrong, and the counter-example is
 * one screen down in this same file: the `appendEntry` on the delivery path is
 * wrapped in a `try/catch` that SWALLOWS, deliberately, because *"a diagnostic
 * write may not un-deliver a report that landed"*. **So a failed session write
 * produces a delivered report with no entry**, and absence is therefore not
 * proof the tool was never called. An implementation that inferred backwards
 * would file `pifleet.no_submit/v1` against a worker whose `result.json` is on
 * disk, complete and correct — a false accusation, which is the one way a
 * diagnostic record is worse than no record.
 *
 * The flag is set by `submit_report` itself, before the entry is attempted. It
 * cannot be wrong about a delivery it performed.
 *
 * **`nagged` is layer 3's field and SRD task 4.1 gave it its writer.** It lives
 * here, beside the count, because it is per-epoch state of exactly the same
 * kind — and the shape task 3.3 left it in was the right one: phase 4 added
 * `noteNag` and changed no signature, no entry shape and no call site. A
 * `nagged: false` hard-coded into `composeNoSubmitEntry` would have satisfied
 * every test that existed then and would have survived this task silently.
 *
 * **It is a boolean and not a count, and that is §6.3's `MAX_NAGS = 1` spelled
 * once instead of twice.** A counter whose only legal values are 0 and 1, sat
 * beside a bound that says so, is two spellings of one rule and they can
 * disagree; §7.2's entry declares `nagged` a boolean, so the boolean is the
 * spelling that reaches a reader. The bound is not configurable on purpose —
 * §6.3: *"An unbounded re-prompt against a model that will never call the tool
 * is an infinite spend against a token ceiling that ends the run on exit 5."*
 *
 * **It is per EPOCH, not per session.** The slot is replaced whenever a
 * different `(task_id, epoch)` is seen, so a worker nagged on one task is
 * nagged again on the next. That is the intent: the bound exists to stop a loop
 * within one allocation, not to spend a worker's one nag for its lifetime.
 */
export interface EpochTally {
  taskId: string;
  epoch: number;
  /** Calls the model MADE this epoch, counted before execution. */
  toolCalls: number;
  /** Whether `submit_report` reached the end of a write for this epoch. */
  delivered: boolean;
  /** Whether layer 3 re-prompted this epoch. At most once — see the docblock. */
  nagged: boolean;
}

/** §7.2's session entry — seven fields, and the reason there is no eighth is in `composeNoSubmitEntry`. */
export interface NoSubmitEntry {
  schema: string;
  task_id: string;
  epoch: number;
  worker: string;
  tool_calls: number;
  nagged: boolean;
  at: string;
}

/**
 * The live epoch's tally, and the two things that update it.
 *
 * ONE slot, not a map. A worker serves one task at a time — `/policy/task`
 * names exactly one — so epochs are sequential and a map would be an unbounded
 * structure in a process designed to run for weeks, holding rows nothing will
 * read again. The slot is replaced whenever a different epoch is seen, which is
 * also what makes the count and the delivery reset together: they describe the
 * same epoch or they describe nothing.
 *
 * The consequence a caller must handle is that the slot goes STALE. It holds
 * the last epoch this extension saw, which after a settle and a new dispatch is
 * no longer the live one — so `agent_end` reads `/policy/task` for which epoch
 * it is talking about and consults the tally only when the two agree.
 */
export interface EpochTracker {
  noteToolCall(live: LiveTask): void;
  noteDelivery(live: LiveTask): void;
  /**
   * Layer 3's bound, set by the `agent_end` handler after a nag has actually
   * been sent — never before, and never on a send that threw. A flag set
   * speculatively would suppress the one nag this epoch is allowed on the
   * strength of a message the model never received.
   */
  noteNag(live: LiveTask): void;
  /** A snapshot of the current tally, or null if no epoch has been seen. */
  current(): EpochTally | null;
}

/**
 * The zero state of an epoch, defined once.
 *
 * Used by the tracker for a newly seen epoch AND by `agent_end` for an epoch it
 * observed nothing about — the worker that was dispatched and made no tool call
 * at all. Those two must be the same shape: if they drifted, a worker that did
 * nothing and a worker whose first call had just been counted would produce
 * differently shaped records of the same silence.
 */
export function emptyTally(live: LiveTask): EpochTally {
  return { taskId: live.taskId, epoch: live.epoch, toolCalls: 0, delivered: false, nagged: false };
}

/**
 * Is this tally about that task?
 *
 * Task id AND epoch, because neither alone identifies an allocation:
 * `dispatch-trigger.ts` records that *"`epoch` alone is not unique across
 * workers"*, and a task id alone re-fires when the same task is re-staged.
 */
function sameEpoch(tally: EpochTally, live: LiveTask): boolean {
  return tally.taskId === live.taskId && tally.epoch === live.epoch;
}

export function createEpochTracker(): EpochTracker {
  let tally: EpochTally | null = null;
  const slotFor = (live: LiveTask): EpochTally => {
    if (tally === null || !sameEpoch(tally, live)) tally = emptyTally(live);
    return tally;
  };
  return {
    noteToolCall: (live) => void (slotFor(live).toolCalls += 1),
    noteDelivery: (live) => void (slotFor(live).delivered = true),
    noteNag: (live) => void (slotFor(live).nagged = true),
    // A COPY. The tally decides whether a worker is accused of delivering
    // nothing; a caller able to reach in and set `delivered` would be editing
    // the evidence, and the edit would leave no trace.
    current: () => (tally === null ? null : { ...tally }),
  };
}

/**
 * `/policy/task`'s live task, or null — and never a throw.
 *
 * Both callers are diagnostics running inside Pi's event handlers, where a
 * throw is not a report of a problem but a NEW problem: on the `tool_call` path
 * it blocks the tool outright (see `register`), and on `agent_end` it becomes an
 * `emitError` banner about a record nobody asked for. An unreadable, absent or
 * malformed policy all mean the same thing here — there is no epoch to attribute
 * anything to — so they collapse to null rather than to four messages no model
 * and no operator will ever see.
 */
export function readLiveTaskQuietly(policyPath: string): LiveTask | null {
  try {
    return parseTaskPolicy(readFileSync(policyPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Compose the `pifleet.no_submit/v1` entry from a tally that already happened.
 *
 * Takes an `EpochTally` rather than the event, and that is the same design
 * `composeSubmitEntry` has: every field is host state or a count this file kept
 * itself. There is no path from `AgentEndEvent.messages` — or from any model
 * output — to here, so no later edit can put a worker's prose in a session entry
 * without first changing this signature. §6.5 property 3 and `Docs/SRD.md`
 * §12.6 are the same rule stated twice.
 *
 * **`delivered` is a gate, not a field.** The entry is written only when it is
 * false, so carrying it would put a constant on every record ever produced — a
 * column that says nothing and invites a later reader to branch on it as though
 * it varied.
 *
 * **`at` is a parameter**, as `composeSubmitEntry`'s is, so the mapping can be
 * asserted against exact values rather than a regex.
 */
export function composeNoSubmitEntry(
  tally: EpochTally,
  worker: string,
  at: string,
): NoSubmitEntry {
  return {
    schema: NO_SUBMIT_ENTRY_SCHEMA,
    task_id: tally.taskId,
    epoch: tally.epoch,
    worker,
    tool_calls: tally.toolCalls,
    nagged: tally.nagged,
    at,
  };
}

/**
 * Layer 3's message, entire (§6.3, task 4.1).
 *
 * **It is a `const` and not a template, and §6.3 makes that the first of four
 * constraints on this layer:** *"The message is a constant in the extension, not
 * composed from anything the model produced."* `Docs/SRD.md` §12.6 is the rule —
 * worker prose is data — and commit `5dbdafe` is the fix this would undo:
 * re-feeding a model its own text back through a host-shaped channel makes the
 * host look like it agrees. Nothing here interpolates. **Not even `task_id` or
 * `epoch`**, which are host state and would therefore be legal under §12.6: the
 * model is being asked to call a tool that reads both out of `/policy/task`
 * itself, so putting them in the prompt would be handing back the exact two
 * numbers §6.4 exists to stop a model copying. It would also cost the acceptance
 * criterion its teeth — *"the string is identical across differing
 * transcripts"* is checkable by comparison only while there is one string.
 *
 * **Every word is paid for out of about a second.** §11 Q1 measured the
 * supervisor settling 0.18s (glm) to 1.05s (qwen) after the model acted on a
 * nag, so this text has to produce a tool call almost immediately. It therefore
 * says three things and stops: which tool, that the transcript is not a channel,
 * and what the minimum call is. It asks the model to decide nothing and to
 * re-read nothing — a sentence sending it back to `/policy/task`, or to its own
 * brief, would spend the runway on a `read`.
 *
 * The last clause repeats `SUBMIT_REPORT_DESCRIPTION`'s warning about the four
 * host-composed fields because a model that reaches this point has already
 * failed to call the tool once, and §6.2.1's `additionalProperties: false`
 * turns a remembered `task_id:` into a refusal — a second round trip this epoch
 * cannot afford.
 */
export const NAG_TEXT =
  "You have not reported for this task, and prose in this transcript does not " +
  "reach the host. Call `submit_report` now. `status` and `summary` are its only " +
  "required arguments; `task_id`, `epoch` and `worker` are read from host state " +
  "and must not be passed.";

/**
 * Should this epoch be nagged? Three clauses, each of which is a separate way
 * layer 3 could become a nuisance.
 *
 * - **`delivered`** — the report is in. §11 Q3 measured `agent_end` firing 2-4ms
 *   after a terminating tool result, so this handler runs on the happy path of
 *   every delivery in the fleet, and a nag there would tell a worker that just
 *   did its job to do it again.
 * - **`envelopeOnDisk`** — the report is in, by the OTHER route. This clause is
 *   the one the file's own `EpochTally` docblock already argued for and did not
 *   have: an implementation that infers non-delivery *"would file
 *   `pifleet.no_submit/v1` against a worker whose `result.json` is on disk,
 *   complete and correct — a false accusation"*. `delivered` cannot see a
 *   `write`-route envelope, because it is set by `submit_report` itself, and
 *   during Phase A BOTH routes are open and legitimate. Measured live
 *   2026-09-08 (ISC-1107): `col-1` wrote its fan-out and `result.json` with
 *   `write`, ended cleanly, and was nagged for a report it had already filed —
 *   then obeyed, was refused `No task is live`, and spent a turn working out
 *   why. **A worker that reported is never told it did not**, whichever channel
 *   it used.
 * - **`nagged`** — §6.3's *"One nag, not a loop."* Q1 measured the `followUp`
 *   EXTENDING the turn, which is exactly what makes an unbounded version a loop
 *   rather than a no-op: nag, extend, `agent_end`, nag, until the token ceiling
 *   ends the run on exit 5 (`Docs/SRD-TRIAGE-CONSOLE.md` Finding C).
 * - **`toolCalls > 0`** — §6.3's third constraint and SRD task 4.2. A worker
 *   that made no tool call this epoch either was not asked to do anything or was
 *   asked a question, and *"an idle worker between dispatches must be left
 *   alone, and so must a worker whose brief was a question."* The other half of
 *   4.2 is not here because it cannot be: an idle worker has no live task, so
 *   there is no tally to ask about, and the `agent_end` handler returns before
 *   reaching this function.
 *
 * **A worker that ran one `ls` and quit IS nagged**, and that is deliberate. It
 * held a live task and produced nothing, which is defect 5's exact shape and the
 * case layer 3 exists for; one call is not "nothing to report", it is a report
 * not written. The bar is a tool call, not a productive one.
 *
 * Pure, exported and total, so each clause can be reddened on its own without a
 * filesystem or an event in the way.
 */
export function shouldNag(tally: EpochTally, envelopeOnDisk = false): boolean {
  if (tally.delivered) return false;
  if (envelopeOnDisk) return false;
  if (tally.nagged) return false;
  return tally.toolCalls > 0;
}

// ---------------------------------------------------------------------------
// `get_replies` — the declared set (§6.2.2, §7.4, D6). See the header.
// ---------------------------------------------------------------------------

/**
 * One entry of `/policy/replies`, mirroring `DeclaredReplyEntry`
 * (`src/run/replies-policy.ts`) field for field.
 *
 * `path` is the host's spelling and is carried through verbatim into every
 * message this tool composes, because it is the string the collator's brief also
 * cites. This end derives a READ location from it and never a second spelling of
 * the path itself.
 */
export interface DeclaredReplyEntry {
  task_id: string;
  worker: string;
  aspect: string;
  path: string;
}

/** The `/policy/replies` document, mirroring `RepliesPolicy` on the host side. */
export interface RepliesPolicy {
  schema: string;
  /** Spelled as `/policy/task` line 1 spells it — see the header's §9.6 note. */
  task_id: string;
  replies: DeclaredReplyEntry[];
}

/**
 * What one declared reply turned out to be, as `details.replies[]` carries it.
 *
 * `bytes` is measured from the file that was read and is 0 for one that was not
 * there — never absent, so a reader never has to tell a missing field from a
 * zero-length reply. `ok` is *"this is a document I could parse"* and nothing
 * more; it makes no claim about whether the reply says anything useful, which is
 * the collator's judgement and not this tool's.
 */
export interface ReplyReadout {
  task_id: string;
  worker: string;
  aspect: string;
  bytes: number;
  ok: boolean;
}

/** Everything one `get_replies` call produces, before it is shaped into a tool result. */
export interface RepliesOutcome {
  /** One text block per DECLARED reply, in the declaration's order. */
  blocks: string[];
  readouts: ReplyReadout[];
  /**
   * The child task ids whose file was not there at all.
   *
   * A separate list rather than a flag on the readout, because §6.2.2 asks for
   * `missing` by name and because the two failures it separates are not degrees
   * of one thing: `ok: false` with bytes is *"a report was produced and could
   * not be read"*, and membership here is *"no report was produced"*. A reader
   * that had only `ok` would have to infer the difference from `bytes === 0`,
   * which is an inference and would be wrong for a zero-byte file.
   */
  missing: string[];
}

/**
 * The basename inside `/replies` a declared path names, or null when the path
 * is not one this tool will read.
 *
 * The prefix is checked rather than the basename taken, and the remainder is
 * held to `isBareName`. Both halves are a defence against a HOST bug, not a
 * worker one — the worker cannot write `/policy/replies` — and they are here for
 * `parseTaskPolicy`'s reason, restated: `renderRepliesPolicy` derives every path
 * from `replyMountPath`, so a path of any other shape means the document was not
 * written by that renderer whatever its schema tag says. Taking the basename of
 * an unexpected path instead would read `<repliesRoot>/passwd` for a declared
 * `/etc/passwd` and call the result a reply.
 */
export function declaredReplyFile(path: string): string | null {
  const prefix = `${REPLIES_ROOT}/`;
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  return isBareName(name) ? name : null;
}

/** One declared entry, or null when the value is not one. */
function declaredEntry(value: unknown): DeclaredReplyEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const taskId = r["task_id"];
  const worker = r["worker"];
  const aspect = r["aspect"];
  const path = r["path"];
  if (typeof taskId !== "string" || taskId === "") return null;
  if (typeof worker !== "string" || worker === "") return null;
  // `aspect` may legitimately be empty — `DeclaredReply.aspect` is an
  // unconstrained string on the host side and a console with one slice has
  // nothing to call it. It must still be a string, because it is interpolated.
  if (typeof aspect !== "string") return null;
  if (typeof path !== "string" || declaredReplyFile(path) === null) return null;
  return { task_id: taskId, worker, aspect, path };
}

/**
 * `/policy/replies`'s document, or null when the bytes are not one.
 *
 * Null for every structural problem, as `parseTaskPolicy` is, and for the same
 * reason: the caller's response to all of them is the same refusal, so four
 * messages would be four ways of saying one thing to a model that can act on
 * none of them. **One malformed entry refuses the WHOLE document** rather than
 * being skipped — a declaration is a set, and silently returning the subset that
 * parsed would hand a collator a smaller set than the host published while
 * looking exactly like a smaller fan-out. That is Finding E's cost arriving
 * through a third door.
 *
 * The schema tag is checked before anything else is believed, because the reader
 * is baked into an image pinned by tag: the host and this file are updated on
 * different clocks and a `pifleet.replies/v2` has to be a refusal rather than a
 * misparse.
 */
export function parseRepliesPolicy(body: string): RepliesPolicy | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  const taskId = d["task_id"];
  const raw = d["replies"];
  if (d["schema"] !== REPLIES_POLICY_SCHEMA) return null;
  if (typeof taskId !== "string" || taskId === "") return null;
  if (!Array.isArray(raw)) return null;
  const replies: DeclaredReplyEntry[] = [];
  for (const value of raw) {
    const entry = declaredEntry(value);
    if (entry === null) return null;
    replies.push(entry);
  }
  return { schema: REPLIES_POLICY_SCHEMA, task_id: taskId, replies };
}

/**
 * The sentence §6.2.2 specifies, and the prefix all three "no set" refusals
 * share.
 *
 * One sentence for three causes — the mount is not readable, the bytes are not a
 * `pifleet.replies/v1` document, the declared array is empty — because they are
 * one fact to the model: **nothing was declared, so there is nothing to look
 * for.** Each refusal appends its own clause for the operator, who is the only
 * reader who can act on the difference.
 */
export const NO_REPLIES_DECLARED = "No replies were declared for this task.";

/**
 * Read the declaration, or refuse — including the 9.6 staleness check.
 *
 * **The equality is against `parseTaskPolicy`'s `taskId`, which is
 * `/policy/task` line 1 VERBATIM, and neither side is normalized here.** That is
 * the whole of the check and the header explains why adding anything to it is a
 * bug: `renderRepliesPolicy` already stored the id as `renderTaskPolicy` spells
 * it, so the two strings are equal by construction on the honest path, and any
 * second `slice`, `trim` or character class applied at this end would break that
 * equality for exactly the ids the host took care to normalize. The `slice(120)`
 * below is in the MESSAGE only, and it is deliberately not shared with the
 * comparison.
 */
export function readRepliesPolicy(roots: MountRoots, live: LiveTask): RepliesPolicy {
  let body: string;
  try {
    body = readFileSync(roots.repliesPolicyPath, "utf8");
  } catch {
    // One arm for absent, unreadable and not-a-file alike: the tool's answer to
    // all three is the same, and a branch per errno would be three messages
    // about a mount only an operator can fix.
    refuse(`${NO_REPLIES_DECLARED} \`${roots.repliesPolicyPath}\` could not be read.`);
  }
  const declared = parseRepliesPolicy(body);
  if (declared === null) {
    refuse(
      `${NO_REPLIES_DECLARED} \`${roots.repliesPolicyPath}\` is not a ` +
        `\`${REPLIES_POLICY_SCHEMA}\` document.`,
    );
  }
  if (declared.task_id !== live.taskId) {
    refuse(
      `The declared reply set is stale. \`${roots.repliesPolicyPath}\` declares replies for ` +
        `task \`${declared.task_id.slice(0, 120)}\`, and \`${roots.policyPath}\` says the live ` +
        `task is \`${live.taskId.slice(0, 120)}\`. Nothing in \`${REPLIES_ROOT}\` belongs to ` +
        `this task; report that you could not read your inputs.`,
    );
  }
  return declared;
}

/**
 * Read one declared reply and describe it — the three states §6.2.2 names.
 *
 * The JSON parse is a VALIDATION and the raw bytes are what comes back. Parsing
 * and re-serializing would hand the collator a document the host never wrote —
 * key order, whitespace and number formatting all move — and `e5d5751` is this
 * fleet's recorded case of what a right answer to the wrong document costs.
 *
 * The two failing arms use `roles/triage.md`'s own sentences verbatim, because
 * that file spends six lines establishing that they are different things for a
 * person to do next and the collator is being asked to carry the distinction
 * into its write-up. A tool that said "unavailable" for both would take the
 * vocabulary away and then ask for it back.
 */
export function readDeclaredReply(
  entry: DeclaredReplyEntry,
  repliesRoot: string,
): { readout: ReplyReadout; block: string; missing: boolean } {
  const who =
    `\`${entry.worker}\`, aspect \`${entry.aspect}\`, task \`${entry.task_id}\` ` +
    `(\`${entry.path}\`)`;
  const name = declaredReplyFile(entry.path);
  let raw: string | null = null;
  if (name !== null) {
    try {
      raw = readFileSync(join(repliesRoot, name), "utf8");
    } catch {
      raw = null;
    }
  }

  if (raw === null) {
    // `name === null` cannot reach here through `getReplies` — `parseRepliesPolicy`
    // refuses any entry whose path is not `<REPLIES_ROOT>/<bare name>` — so this
    // arm is the file that is not there. It is written to be total anyway, so
    // this function can be called on an entry from anywhere without inventing a
    // read against a path it just rejected.
    return {
      readout: { task_id: entry.task_id, worker: entry.worker, aspect: entry.aspect, bytes: 0, ok: false },
      block: `No report was produced. Nothing was written for ${who}.`,
      missing: true,
    };
  }

  const bytes = Buffer.byteLength(raw, "utf8");
  let ok = true;
  try {
    JSON.parse(raw);
  } catch {
    ok = false;
  }
  const readout = { task_id: entry.task_id, worker: entry.worker, aspect: entry.aspect, bytes, ok };
  if (!ok) {
    return {
      readout,
      block:
        `A report was produced and could not be read. ${who} holds ${bytes} bytes ` +
        `that are not valid JSON.`,
      missing: false,
    };
  }
  return { readout, block: `Reply from ${who}:\n${raw}`, missing: false };
}

/**
 * The whole of `get_replies`, with its roots injected so a test can reach it.
 *
 * Three refusals before a single byte is read out of `/replies`, in the order
 * that makes each of them the most specific true statement available: no live
 * task, then no declaration, then an empty one. The empty case is last because
 * it is the only one that is not a fault — it is a turn-one dispatch, and §6.2.2
 * calls the sentence it produces *"the correct and complete answer"* for that
 * turn.
 *
 * Every declared reply produces a block whether it arrived or not, so the count
 * of blocks is the count of the DECLARED set. A collator can therefore tell what
 * it was promised from what it received without being told the number
 * separately, and an omission cannot look like a shorter fan-out.
 */
export function getReplies(roots: MountRoots): RepliesOutcome {
  const live = readTaskPolicy(roots.policyPath);
  const declared = readRepliesPolicy(roots, live);
  if (declared.replies.length === 0) {
    refuse(
      `${NO_REPLIES_DECLARED} \`${roots.repliesPolicyPath}\` declares an empty set, which is ` +
        `the whole answer for a first-turn dispatch: nothing has been published for you yet. ` +
        `\`${REPLIES_ROOT}\` holds no reply belonging to this task, so do not go looking in it.`,
    );
  }

  const blocks: string[] = [];
  const readouts: ReplyReadout[] = [];
  const missing: string[] = [];
  for (const entry of declared.replies) {
    const read = readDeclaredReply(entry, roots.repliesRoot);
    blocks.push(read.block);
    readouts.push(read.readout);
    if (read.missing) missing.push(read.readout.task_id);
  }
  return { blocks, readouts, missing };
}

/**
 * The parameter schema: an object with no properties, closed.
 *
 * §6.2.2's `Type.Object({})`, spelled as the JSON Schema literal the header
 * argues for. **`required` is OMITTED rather than written as `[]`, and that is
 * measured rather than reasoned** — run against the typebox in the real image
 * (`pifleet/pi-worker:0.79.6-base-7b18f4213430`, 2026-09-08):
 *
 *     Type.Object({})              -> {"type":"object","properties":{}}
 *     Type.Object({a: Type.String()}) -> {"type":"object","required":["a"],…}
 *
 * So the reference implementation emits no `required` key at all for an empty
 * object, and `properties: {}` is present rather than absent. §6.2's whole
 * `StringEnum` argument is that the SPELLING reaching the provider is what
 * matters, and an empty `required: []` is a spelling nothing in this stack
 * produces. `additionalProperties: false` is this file's own addition, for
 * `SUBMIT_REPORT_PARAMETERS`'s reason rather than typebox's.
 *
 * `additionalProperties: false` is kept for `SUBMIT_REPORT_PARAMETERS`'s reason
 * rather than by symmetry. A model that has read a role document about reading
 * `/replies/<child-task-id>.json` will try to pass a `task_id` or a `path`, and
 * the difference between a validation error naming the field and a silently
 * ignored argument is the difference between one retry and a collator convinced
 * it asked for something specific.
 */
export const GET_REPLIES_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

/**
 * `dispatch_request`'s arguments — `schema` and `parent_task_id` are absent for
 * `submit_report`'s reason, one document over.
 */
export interface DispatchRequestParams {
  requests: { worker: string; title: string; brief: string; services?: string[] }[];
}

/** What a written fan-out was. */
export interface DispatchRequestOutcome {
  path: string;
  bytes: number;
  /** The workers the document asks for, in its order. */
  workers: string[];
  taskId: string;
  epoch: number;
}

/**
 * The parameter schema.
 *
 * **`schema` and `parent_task_id` are not parameters**, exactly as
 * `submit_report` omits its four. `parent_task_id` is the one that matters: the
 * host checks it against the DIRECTORY the file was found in and refuses a
 * mismatch, so a model that could supply it could only ever get it right or be
 * refused — a field with one correct value is a way to fail, not a choice. It
 * is read from `/policy/task` here for the same reason the envelope's is.
 */
export const DISPATCH_REQUEST_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["requests"],
  properties: {
    requests: {
      type: "array",
      minItems: 1,
      maxItems: MAX_DISPATCH_REQUEST_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["worker", "title", "brief"],
        properties: {
          worker: { type: "string", maxLength: MAX_DISPATCH_ID_CHARS },
          title: { type: "string", maxLength: MAX_DISPATCH_TEXT },
          brief: { type: "string", maxLength: MAX_DISPATCH_TEXT },
          services: {
            type: "array",
            maxItems: MAX_DISPATCH_SERVICES,
            items: { type: "string", maxLength: MAX_DISPATCH_ID_CHARS },
          },
        },
      },
    },
  },
} as const;

/**
 * Write `/outbox/<task-id>/dispatch-request.json`.
 *
 * ## Why this tool exists at all, in one measurement
 *
 * `fleet.yaml`'s `triage` block records SRD task 7.3's first attempt and its
 * reversal on 2026-09-09: narrowed to no `write`, `tri-1` *"composed the fan-out
 * correctly and was refused three times — `Tool write not found` — and the
 * console dispatched nothing for three sweeps."* And the outage was the lesser
 * half: *"sweeps 5 and 6 settled `status: success` with the summary 'Dispatched
 * sweep to obs-t1', having written no request at all."*
 *
 * `submit_report` could not cover it and still cannot: its `report` files land
 * in `<task-dir>/files/`, and the fan-out is read from `<task-dir>` itself
 * (`dispatchRequestPath`). One directory level is the whole of the gap, and it
 * is not closable by widening `report` — a `report` entry that could write a
 * parent directory would be a path where the contract says a bare name.
 *
 * ## The order is the same testable property `submit_report` has
 *
 * Validate everything, then write. Nothing below the phase marker can refuse,
 * so a refusal never leaves a partial document for the host to read — and this
 * document is read by a host that DISPATCHES on it.
 */
export function dispatchRequest(
  params: DispatchRequestParams,
  roots: MountRoots = DEFAULT_MOUNTS,
): DispatchRequestOutcome {
  // ---- Phase 1: refuse. Nothing below this comment writes anything. --------
  const live = readTaskPolicy(roots.policyPath);
  const { taskDir } = taskPaths(roots.outboxRoot, live.taskId);
  const items = params.requests ?? [];

  if (items.length === 0) {
    refuse(
      "`requests` is empty. This file is written only to ask for a fan-out, and the parent task " +
        "settles the moment it is written — so an empty request is a sweep that reports success " +
        "having dispatched nobody.",
    );
  }
  if (items.length > MAX_DISPATCH_REQUEST_ITEMS) {
    refuse(`\`requests\` has ${items.length} entries; cap is ${MAX_DISPATCH_REQUEST_ITEMS}.`);
  }

  const named = new Set<string>();
  for (const item of items) {
    if (!DISPATCH_ID_RE.test(item.worker) || item.worker.length > MAX_DISPATCH_ID_CHARS) {
      refuse(
        `\`worker\` \`${item.worker}\` is not a worker id. It must be letters, digits, ".", "_" ` +
          `or "-", beginning and ending alphanumeric, and at most ${MAX_DISPATCH_ID_CHARS} ` +
          `characters — it becomes a directory under the run's outbox on the host.`,
      );
    }
    // EACH ENTRY NAMES A DISTINCT WORKER. The host refuses a duplicate too, but
    // it refuses the whole document — so a fan-out that named one observer
    // twice would cost the sweep rather than the entry, and the model would be
    // told about a file it cannot see rather than about the argument it passed.
    if (named.has(item.worker)) {
      refuse(`\`requests\` names \`${item.worker}\` twice; each entry must name a distinct worker.`);
    }
    named.add(item.worker);
    if (item.title.length > MAX_DISPATCH_TEXT) {
      refuse(`\`title\` for \`${item.worker}\` is longer than ${MAX_DISPATCH_TEXT} characters.`);
    }
    if (item.brief.length > MAX_DISPATCH_TEXT) {
      refuse(`\`brief\` for \`${item.worker}\` is longer than ${MAX_DISPATCH_TEXT} characters.`);
    }
    const services = item.services ?? [];
    if (services.length > MAX_DISPATCH_SERVICES) {
      refuse(
        `\`services\` for \`${item.worker}\` holds ${services.length} entries; cap is ` +
          `${MAX_DISPATCH_SERVICES}, which is more services than one environment may declare.`,
      );
    }
    for (const service of services) {
      if (!DISPATCH_ID_RE.test(service) || service.length > MAX_DISPATCH_ID_CHARS) {
        refuse(
          `\`services\` for \`${item.worker}\` holds \`${service}\`, which is not a service ` +
            `name. It keys an incident record under ~/.pifleet/triage/ on the host, so it is ` +
            `bounded like the path segment it becomes rather than like free text.`,
        );
      }
    }
  }

  // ---- Phase 2: write. -----------------------------------------------------
  mkdirSync(taskDir, { recursive: true });
  const document = {
    schema: DISPATCH_REQUEST_SCHEMA,
    parent_task_id: live.taskId,
    requests: items.map((item) => ({
      worker: item.worker,
      title: item.title,
      brief: item.brief,
      // OMITTED rather than sent as null when absent: the host schema is
      // `.strict()` and an empty list is a legal share ("an idle observer is
      // not an error"), so the two must stay distinguishable.
      ...(item.services === undefined ? {} : { services: item.services }),
    })),
  };
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  const path = join(taskDir, DISPATCH_REQUEST_NAME);
  writeAtomic(path, bytes);

  return {
    path,
    bytes: Buffer.byteLength(bytes, "utf8"),
    workers: items.map((item) => item.worker),
    taskId: live.taskId,
    epoch: live.epoch,
  };
}

/**
 * What the model is told about `dispatch_request`.
 *
 * It says the file name, which looks redundant and is not: six role documents
 * still instruct a model to WRITE that path by hand, and a model carrying that
 * instruction needs to recognise that this tool is the same act rather than an
 * additional one.
 */
export const DISPATCH_REQUEST_DESCRIPTION =
  "Ask the host to dispatch workers for this task. This REPLACES writing " +
  "`/outbox/<task-id>/dispatch-request.json` by hand — it writes exactly that file, and it is " +
  "the only route to it. Do not pass schema or parent_task_id; they are read from host state. " +
  "Each entry must name a distinct worker. Call it once, before you deliver your envelope; " +
  "the host dispatches when your task settles.";

/**
 * What the model is told about `get_replies`.
 *
 * Three sentences, and the second is the one that earns its tokens: it tells the
 * model not to list `/replies`, which is the behaviour `roles/collator.md`
 * records a collator spending *"its last twelve tool calls"* on. Saying "there
 * are no arguments" without saying why invites a model to work around the
 * limitation it thinks it has found.
 */
export const GET_REPLIES_DESCRIPTION =
  "Return the replies the host declared for this task. It takes no arguments and you must not " +
  "list or search `/replies` yourself — that directory also holds replies published for other " +
  "tasks, and reading one of those would answer a question nobody asked. A reply that was " +
  "declared and did not arrive is reported to you as missing rather than left out.";

/**
 * What the model is told about the tool.
 *
 * The description names the four fields it must NOT try to supply, because the
 * six role documents this tool is replacing all instruct a model to write them
 * and those documents are still live through SRD phase 8. A model carrying that
 * instruction and finding no parameter for it will either invent one — which
 * `additionalProperties: false` turns into a validation error — or narrate that
 * it cannot comply. One sentence here is cheaper than either.
 */
export const SUBMIT_REPORT_DESCRIPTION =
  "Deliver your result envelope for the task you were dispatched. This is the only " +
  "way to report; the host reads what it writes, not what you say in the transcript. " +
  "Do not pass schema, task_id, epoch or worker — they are read from host state and " +
  "cannot be supplied. Pass `report` to attach documents (a review, a triage write-up " +
  "and its .md); it is a LIST, each entry is written into your outbox and declared in " +
  "`artifacts` for you, and naming one file twice is refused rather than overwritten.";

/**
 * Register `submit_report`, `dispatch_request` and `get_replies` — the whole of
 * `PI_EXTENSION_TOOLS`.
 *
 * **As of SRD phase 5 the registered set EQUALS that enum**, and
 * `test/integration/report-tools-image.test.ts` was tightened from a subset
 * assertion to a set equality in the same commit. §12 held that criterion at a
 * subset from phase 2 *"because a set-equality criterion filed against Phase 2
 * would be red for three phases by construction, which is a criterion that
 * trains its reader to ignore it"* — phase 5 is where the stronger claim, that
 * no name config may request is unserved by the image, is finally made.
 *
 * `worker` and `workdir` come off `ctx` on every call rather than being
 * captured here. A worker id captured at registration would be read before the
 * session it names is necessarily the live one, and the workdir is a property
 * of the context Pi hands to the call.
 */
export default function (pi: ExtensionAPI, mounts: MountRoots = DEFAULT_MOUNTS): void {
  /*
   * Per-`register` rather than module-scope, as `dispatch-trigger.ts` holds its
   * timer: a module-level slot would be shared by every `register` in a test
   * file, so one test's delivered epoch would silence the next test's.
   */
  const tracker = createEpochTracker();

  /**
   * The tally for the epoch `/policy/task` says is live, right now.
   *
   * Re-read rather than captured, because the `agent_end` handler below calls
   * it on both sides of the nag and the nag CHANGES it. A single snapshot taken
   * at the top would compose the entry from a tally that predated `noteNag`, and
   * `nagged` would read `false` on the very entry whose job is to mirror the nag
   * — a lie that only shows up when the turn does not extend, which is the case
   * §11 Q1 warns arrives intermittently.
   *
   * `emptyTally` when the tracker's one slot is about some OTHER epoch. That is
   * the worker dispatched and silent: never counted, so never tracked.
   */
  const tallyFor = (live: LiveTask): EpochTally => {
    const tracked = tracker.current();
    return tracked !== null && sameEpoch(tracked, live) ? tracked : emptyTally(live);
  };

  pi.registerTool({
    name: "submit_report",
    label: "Submit report",
    description: SUBMIT_REPORT_DESCRIPTION,
    parameters: SUBMIT_REPORT_PARAMETERS,
    // Annotated rather than inferred: `ToolDefinitionLike` is generic now that
    // two tools share it, and the annotation is what makes `params` this tool's
    // arguments instead of `unknown`.
    async execute(_toolCallId, params: SubmitReportParams, _signal, _onUpdate, ctx) {
      const worker = ctx.sessionManager.getSessionId();
      // Layer 4's entry is appended only AFTER this call returns — never
      // before it, and never from a `finally`. The entry says a report was
      // delivered, and a refusal leaves here having written nothing; an entry
      // on a refused call would point an operator at the filesystem for a
      // problem that was in the call.
      const outcome = submitReport(params, worker, { ...mounts, workdir: ctx.cwd });
      /*
       * **This line is BEFORE the try, and that is the point of task 3.3.**
       *
       * The report has landed. Layer 4's other half decides "nothing was
       * delivered" from this flag and never from the absence of the entry
       * below, because the `catch` on that entry swallows: a failed session
       * write leaves a delivered report with no `pifleet.submit/v1` record, and
       * a `no_submit` inferred from that absence would be a false accusation
       * against a worker that did its job. Moved inside the `try` — or after
       * it — this line stops running in exactly the case it exists for.
       */
      tracker.noteDelivery({ taskId: outcome.taskId, epoch: outcome.epoch });
      try {
        pi.appendEntry(
          SUBMIT_ENTRY_SCHEMA,
          composeSubmitEntry(outcome, worker, new Date().toISOString()),
        );
      } catch {
        // A diagnostic write may not un-deliver a report that landed. §6.5
        // property 4 counts a worker whose file does not land as having
        // produced nothing; the inverse has to hold too, and throwing here
        // would show the model `isError` on a correct `result.json`. §11 Q4
        // measured what follows: every model retries once, re-delivers the
        // same envelope, throws again, and ends the turn believing it could
        // not report. There is no second channel to report this on — the
        // channel is what failed — so it is swallowed.
        //
        // **Until task 3.3 the cost of that swallow was a conflation**: the
        // missing entry was the only evidence, and it looked exactly like a
        // worker that never called the tool. It no longer does. `noteDelivery`
        // above ran BEFORE this `try`, so `agent_end` knows this epoch was
        // delivered and writes no `pifleet.no_submit/v1`. The three cases are
        // now distinct in the session: a submit entry means delivered and
        // recorded; a no_submit entry means nothing had been delivered when
        // that `agent_end` fired; NEITHER entry means delivered with the
        // session write lost — which is this branch, and which is the case a
        // host reader must not mistake for silence. (The tense in the second is
        // task 4.1's: a nagged epoch can produce a no_submit and then a submit,
        // so the entries for one epoch are read in order and a submit settles
        // it.) The file on disk remains the thing the host decides on.
      }
      return {
        content: [
          { type: "text", text: `Report delivered: ${outcome.bytes} bytes at ${outcome.path}.` },
        ],
        details: {
          path: outcome.path,
          bytes: outcome.bytes,
          status: outcome.status,
        },
        // Layer 2. A hint, batch-conditional, and the cheapest way to end a
        // turn — see the header for §11 Q3's measurement of it.
        terminate: true,
      };
    },
  });

  /*
   * `get_replies` (§6.2.2, D6, task 5.4).
   *
   * **Four things this `execute` deliberately does not do**, each of which is a
   * property rather than an omission:
   *
   * - **No `terminate`.** Layer 2 makes delivering the cheapest way to end a
   *   turn; a turn that has just fetched its inputs is the one turn that must
   *   not be made cheap to end. The absence is asserted, not assumed.
   * - **No `tracker.noteDelivery`.** A collator that read its replies and wrote
   *   nothing is precisely the turn layers 3 and 4 exist to record, and marking
   *   this epoch delivered would spend `submit_report`'s evidence on a read.
   * - **No `appendEntry`.** The `tool_call` handler already counts this call,
   *   which is the whole of what §6.2.2 claims the tool buys the host — *"the
   *   host now knows whether the collator looked"* — and a second record of one
   *   call would be a diagnostic about a diagnostic.
   * - **Nothing off `ctx`.** Unlike `submit_report` this tool composes no
   *   document, so there is no field a worker id or a workdir would fill; a
   *   `getSessionId()` here would be a read with no reader.
   */
  /*
   * `dispatch_request` (SRD-WORKER-DISPATCH-EXTENSION task 7.3).
   *
   * **No `terminate`, and here that is a contract rather than a preference.**
   * `roles/triage.md` turn one is *"two writes, a reply, and silence"* — the
   * fan-out and then the envelope, in that order, with `submit_report` as the
   * last tool call. Layer 2 makes delivering the cheapest way to end a turn;
   * ending it HERE would settle the parent task with a request written and no
   * envelope, which is the one ordering the host cannot read.
   *
   * **No `tracker.noteDelivery`.** Writing a fan-out is not delivering a
   * report, and marking the epoch delivered would spend `submit_report`'s
   * evidence on a request — the same reason `get_replies` does not.
   */
  pi.registerTool({
    name: "dispatch_request",
    label: "Dispatch request",
    description: DISPATCH_REQUEST_DESCRIPTION,
    parameters: DISPATCH_REQUEST_PARAMETERS,
    async execute(_toolCallId, params: DispatchRequestParams, _signal, _onUpdate, _ctx) {
      const outcome = dispatchRequest(params, mounts);
      return {
        content: [
          {
            type: "text",
            text:
              `Fan-out written: ${outcome.workers.length} worker(s) — ` +
              `${outcome.workers.join(", ")} — ${outcome.bytes} bytes at ${outcome.path}.`,
          },
        ],
        details: { path: outcome.path, bytes: outcome.bytes, workers: outcome.workers },
      };
    },
  });

  pi.registerTool({
    name: "get_replies",
    label: "Get replies",
    description: GET_REPLIES_DESCRIPTION,
    parameters: GET_REPLIES_PARAMETERS,
    // The arguments are `unknown` and ignored: the schema above admits an empty
    // object and nothing else, so whatever survives Pi's validator carries no
    // information. Naming a parameter type would be inventing a shape to discard.
    async execute(_toolCallId, _params: unknown, _signal, _onUpdate, _ctx) {
      const outcome = getReplies(mounts);
      return {
        content: outcome.blocks.map((text) => ({ type: "text" as const, text })),
        details: { replies: outcome.readouts, missing: outcome.missing },
      };
    },
  });

  /*
   * The count `pifleet.no_submit/v1` carries, and the one hard constraint on
   * gathering it: **THIS HANDLER MUST NEVER THROW AND MUST NEVER RETURN A
   * VALUE.** Measured in `pifleet/pi-worker:0.79.6-base-b722edcf4699` on
   * 2026-09-08, because the two ways to get it wrong are silent:
   *
   * - `dist/core/extensions/runner.js:639-657` — `emitToolCall` has NO
   *   `try/catch`, unlike the general `emit` at `:522-551`; and
   *   `dist/core/agent-session.js:184-197` catches and RE-THROWS with the
   *   message *"Extension failed, blocking execution"*. A throwing counter
   *   stops the worker running tools at all.
   * - `emitToolCall` returns early on any truthy result whose `block` is set
   *   (`types.d.ts:739-743`), so a handler that returned something shaped like
   *   a veto would be one.
   *
   * A diagnostic that can stop a worker calling `read` is a worse bug than
   * every failure it exists to describe. Hence the total `catch` and the bare
   * return.
   *
   * `/policy/task` is read PER CALL rather than cached, because it is rewritten
   * in place at every dispatch with nothing coordinating that against work in
   * flight (`task-policy.ts:33-41`) — the same hazard `SubmitOutcome` carries
   * its own identity out to avoid. The cost is one `readFileSync` of a
   * two-line file, in page cache, at model speed; `dispatch-trigger.ts` polls a
   * file of the same class twice a second for the life of the container.
   */
  pi.on("tool_call", () => {
    try {
      const live = readLiveTaskQuietly(mounts.policyPath);
      if (live !== null) tracker.noteToolCall(live);
    } catch {
      // **This catch is the OUTER of two and no test can redden it alone.**
      // Measured with the mutation battery: removing `readLiveTaskQuietly`'s
      // own swallow leaves the suite green, because this one holds; removing
      // both reddens two tests. Nothing else in the body can throw today —
      // `noteToolCall` is arithmetic on an object — so this is a guard against
      // the NEXT statement someone adds here, and it is kept for the reason the
      // block comment above gives: "in principle unreachable" is not a standard
      // worth applying when the measured penalty is a worker that cannot call
      // `read`.
    }
  });

  /*
   * Layers 3 and 4 (§6.3, tasks 3.3 and 4.1): non-delivery is asked about once,
   * and it becomes a fact whether or not the asking works.
   *
   * **The live task decides WHICH epoch this is about; the tally supplies only
   * the count and the delivery.** The tracker holds one slot, so after a settle
   * and a new dispatch it still describes the PREVIOUS epoch — and one that may
   * have been delivered. Trusting it unchecked would return early and let the
   * new epoch's silence go unrecorded, which is the exact failure this handler
   * exists to remove, reintroduced by the mechanism meant to prevent it.
   *
   * Four outcomes, in order:
   *
   * - **No live task** — `<none>`, or an unreadable mount. `/policy/task` is
   *   reset at settle (`supervisor/index.ts:1075`, whose own comment says work
   *   between settle and the next dispatch *"belongs to NO task"*), so this is
   *   the idle worker §6.3 says must be left alone. There is no task id and no
   *   epoch, so §7.2's shape cannot be composed and none is.
   * - **The tally is about this epoch and says delivered** — nothing. §11 Q3
   *   measured `agent_end` firing 2-4ms after a terminating tool result, so
   *   this is the happy path of every delivery in the fleet and its silence is
   *   a property, not the absence of one.
   * - **The tally is about this epoch and says otherwise** — layer 3 if
   *   `shouldNag`, then the entry, with the epoch's cumulative count and the
   *   nag it just sent.
   * - **The tally is about some other epoch, or there is none** — an
   *   `emptyTally`, and the entry reads `tool_calls: 0`. That is the worker
   *   that was dispatched and made no move at all: the most severe shape defect
   *   5 has, and the one least likely to be guessed at, so it gets a record
   *   rather than silence. **No nag** — `shouldNag` requires a tool call, task
   *   4.2 — because a worker that did nothing was not necessarily asked to do
   *   anything.
   *
   * ONE ENTRY PER `agent_end`, not one per epoch, and the count is cumulative
   * across the epoch. Q1 measured a `sendUserMessage(followUp)` from here
   * landing as a `queue_update` that EXTENDS the turn, so a nagged epoch ends
   * more than once; an entry written only at the first `agent_end` could never
   * carry 150, and `tool_calls` would lose exactly the discrimination §7.2
   * built it for. The last no_submit entry for an epoch is its last word about
   * non-delivery — **and a `pifleet.submit/v1` after one settles the epoch**,
   * which is what a successful nag looks like from the host's side.
   *
   * The `catch` is narrower in purpose than the one above. `emit`
   * (`runner.js:530-548`) already catches a throwing handler, so this is not
   * what keeps the agent loop alive — Pi does that. What it stops is
   * `emitError` raising a banner about a purely diagnostic write. A record that
   * nothing was delivered is not worth an error dialog; its absence is its own
   * evidence.
   */
  pi.on("agent_end", (_event, ctx) => {
    try {
      const live = readLiveTaskQuietly(mounts.policyPath);
      if (live === null) return;
      if (tallyFor(live).delivered) return;

      /*
       * Layer 3 (§6.3, task 4.1) — the bounded nag, and it runs BEFORE the
       * entry for one reason: §6.3 asks for the bound to be *"mirrored through
       * `pi.appendEntry`"*, and the only mirror this file has is `nagged` on the
       * entry immediately below. Send after the append and the mirror lags by
       * one entry — which is harmless when the turn extends and total when it
       * does not, because there would be no second `agent_end` to carry the
       * truth and the nag would leave no trace at all.
       *
       * **The send is wrapped separately from the outer `catch`, and that is
       * §6.5's fence in code.** Layer 3 is a courtesy and layer 4 is evidence;
       * a courtesy that fails must not take the evidence with it. Sharing the
       * outer `catch` would let a throwing `sendUserMessage` skip the append and
       * lose the record of an epoch that reported nothing — the layer with no
       * authority silencing the layer whose whole job is to be read.
       *
       * `noteNag` is INSIDE the try and after the call, so a send that threw
       * leaves `nagged` false. The entry then says, accurately, that this epoch
       * was not re-prompted, and the next `agent_end` may try again. That retry
       * is not the loop §6.3 forbids: a `sendUserMessage` that throws delivers
       * no message and therefore spends no tokens, so what is bounded — model
       * turns bought with a nag — stays bounded at one.
       */
      /*
       * The envelope is read from DISK here rather than tracked, because the
       * whole point of the clause is the route this extension did not perform:
       * a `write` to `/outbox/<task>/result.json` leaves no trace in memory.
       * Read at `agent_end` and not cached, so a worker that wrote its envelope
       * mid-turn is seen to have reported by the time the turn ends.
       */
      const envelopeOnDisk = existsSync(
        taskPaths(mounts.outboxRoot, live.taskId).envelopePath,
      );
      if (shouldNag(tallyFor(live), envelopeOnDisk)) {
        try {
          pi.sendUserMessage(NAG_TEXT, { deliverAs: "followUp" });
          tracker.noteNag(live);
        } catch {
          // A failed nag is a nag that did not happen. Nothing is recorded and
          // nothing is claimed; the entry below tells the truth either way.
        }
      }

      pi.appendEntry(
        NO_SUBMIT_ENTRY_SCHEMA,
        composeNoSubmitEntry(
          tallyFor(live),
          ctx.sessionManager.getSessionId(),
          new Date().toISOString(),
        ),
      );
    } catch {
      // See above: a failed diagnostic write is not worth an error banner.
    }
  });
}
