/**
 * `submit_report` — the result envelope, written by the host's own hand.
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
 * `/outbox` is a DIRECTORY bind mount (`src/config/render.ts:481`). Nothing
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
 * an anomaly. It did NOT suppress a queued `followUp`, so it is compatible with
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
 * tree (`render.ts:513`), so the host can read them with no new mount and the
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
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * `test/integration/report-tools-image.test.ts` (SRD task 2.5) reads the real
 * `.d.ts` out of the image and fails if it has.
 */
export interface ExtensionAPI {
  registerTool(tool: ToolDefinitionLike): void;
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
 * `render.ts:203` launches every worker with `--session-id <w.id>`, so the
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

/** The slice of `ToolDefinition` this file fills in (`types.d.ts:335-366`). */
export interface ToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: SubmitReportParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContextLike,
  ): Promise<ToolResultLike>;
}

/** Mirrors `TASK_POLICY_MOUNT` (`src/run/task-policy.ts`). */
export const TASK_POLICY_PATH = "/policy/task";
/** Mirrors `TASK_POLICY_NONE` — the spelling of "no task is live". */
export const TASK_POLICY_NONE = "<none>";
/** Mirrors the `/outbox` bind mount (`src/config/render.ts:481`). */
export const OUTBOX_ROOT = "/outbox";
/** Mirrors `OUTBOX_FILES_DIR` (`src/harvest/outbox.ts:83`) and `SWEEP_FILES_DIR`. */
export const OUTBOX_FILES_DIR = "files";
/** Mirrors `RESULT_ENVELOPE_NAME` (`src/contracts.ts:217`). */
export const RESULT_ENVELOPE_NAME = "result.json";
/** Mirrors `ResultEnvelopeSchema`'s `schema` literal (`src/contracts.ts:220`). */
export const RESULT_SCHEMA = "pifleet.result/v1";

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

/** `submit_report`'s arguments — `schema`, `task_id`, `epoch` and `worker` are absent and that is the point. */
export interface SubmitReportParams {
  status: "success" | "partial" | "blocked" | "failed";
  summary: string;
  notes?: string;
  blockers?: string[];
  artifacts?: { kind: "file" | "diff" | "log" | "note"; path: string }[];
  acceptance?: { criterion: string; met: boolean; evidence?: string }[];
  commands_run?: { cmd: string; exit_code: number; excerpt?: string }[];
  report?: { filename: string; content: string };
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
} as const;

/** What `/policy/task` names when a task is live. */
export interface LiveTask {
  taskId: string;
  epoch: number;
}

/**
 * The two mounts this tool reads and writes, injectable for the same reason
 * `truncation-recovery.ts` injects `readFull`: without it every assertion in
 * `test/unit/report-tools.test.ts` would have to be made against the real
 * `/policy/task` and the real `/outbox`, which exist on no developer's machine
 * and on no CI runner. The default is the real pair, so nothing in the image
 * depends on a caller remembering to pass them.
 */
export interface MountRoots {
  policyPath: string;
  outboxRoot: string;
}

export const DEFAULT_MOUNTS: MountRoots = {
  policyPath: TASK_POLICY_PATH,
  outboxRoot: OUTBOX_ROOT,
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

/** The refusal thrown by every check in this file, so a caller can tell them apart from an ENOENT. */
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
 * declare-what-you-wrote rule (`roles/reviewer.md:47-52`) cannot be forgotten —
 * it is no longer something the model has to remember to do.
 *
 * **The appended claim is RELATIVE — `files/<name>` — and not the absolute
 * `/outbox/<task-id>/files/<name>` that `roles/reviewer.md:114`'s example
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
  reportArtifactPath: string | null,
): ResultEnvelope {
  const artifacts = [...(params.artifacts ?? [])];
  if (reportArtifactPath !== null) {
    artifacts.push({ kind: "file", path: reportArtifactPath });
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
  /** The report file's container path, when one was written. */
  reportPath: string | null;
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
   * file this tool wrote itself: `composeEnvelope` appends the `report` claim.
   * That file is the one an operator hunting a half-delivered report is most
   * likely to be looking for, so dropping it here would empty the field of its
   * best case.
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

  if (params.report !== undefined) {
    const problem = filenameProblem(params.report.filename);
    if (problem !== null) refuse(problem);
  }

  for (const artifact of params.artifacts ?? []) {
    const problem = artifactPathProblem(artifact.path, taskDir, roots.workdir);
    if (problem !== null) refuse(problem);
  }

  // ---- Phase 2: write. The report file first, the envelope second. --------
  let reportPath: string | null = null;
  let reportClaim: string | null = null;
  if (params.report !== undefined) {
    mkdirSync(filesDir, { recursive: true });
    reportPath = join(filesDir, params.report.filename);
    // The path WRITTEN and the path CLAIMED are deliberately different
    // spellings of one location: the first is where this process puts the
    // bytes, the second is what the envelope says about it. See
    // `composeEnvelope` for why the claim is relative.
    reportClaim = `${OUTBOX_FILES_DIR}/${params.report.filename}`;
    writeAtomic(reportPath, params.report.content);
  }

  mkdirSync(taskDir, { recursive: true });
  const envelope = composeEnvelope(params, live, worker, reportClaim);
  // Pretty-printed: the harvester does not care and an operator reading a
  // failed task's outbox by hand does. Two spaces is what every other
  // JSON this repository writes for a human uses.
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  writeAtomic(envelopePath, bytes);

  return {
    path: envelopePath,
    bytes: Buffer.byteLength(bytes, "utf8"),
    status: params.status,
    reportPath,
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
  "You have not called `submit_report` for this task, and nothing you wrote in " +
  "this transcript reaches the host — that tool is the only channel. Call it now. " +
  "`status` and `summary` are its only required arguments; `task_id`, `epoch` and " +
  "`worker` are read from host state and must not be passed.";

/**
 * Should this epoch be nagged? Three clauses, each of which is a separate way
 * layer 3 could become a nuisance.
 *
 * - **`delivered`** — the report is in. §11 Q3 measured `agent_end` firing 2-4ms
 *   after a terminating tool result, so this handler runs on the happy path of
 *   every delivery in the fleet, and a nag there would tell a worker that just
 *   did its job to do it again.
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
export function shouldNag(tally: EpochTally): boolean {
  if (tally.delivered) return false;
  if (tally.nagged) return false;
  return tally.toolCalls > 0;
}

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
  "cannot be supplied. Pass `report` to attach one document (a review, a triage " +
  "write-up); it is written into your outbox and declared in `artifacts` for you.";

/**
 * Register `submit_report`, and only `submit_report`.
 *
 * `get_replies` is named alongside it in `PI_EXTENSION_TOOLS` and is SRD phase
 * 5; §12 is explicit that between phase 2 and phase 5 the registered set is a
 * SUBSET of that enum rather than equal to it, *"because a set-equality
 * criterion filed against Phase 2 would be red for three phases by
 * construction, which is a criterion that trains its reader to ignore it."*
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
      if (shouldNag(tallyFor(live))) {
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
