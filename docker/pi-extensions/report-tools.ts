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
 * `sendUserMessage` and `appendEntry`. Only `registerTool` has a caller in this
 * phase — the session entries are SRD task 3.2/3.3 and the bounded nag is 4.1 —
 * and the other three are declared now rather than three times later because
 * §7.6 specifies the surface as one thing and because all four were read out of
 * the real `.d.ts` on 2026-09-08 rather than copied from the document:
 * `dist/core/extensions/types.d.ts:840` (`registerTool`), `:824` (`agent_end`),
 * `:867` (`sendUserMessage`), `:871` (`appendEntry`), in
 * `pifleet/pi-worker:0.79.6-base-b722edcf4699`.
 *
 * The declaration is a SUBSET, so it cannot drift into claiming Pi has a method
 * it does not — only into failing to mention one this file never calls.
 * `test/integration/report-tools-image.test.ts` (SRD task 2.5) reads the real
 * `.d.ts` out of the image and fails if it has.
 */
export interface ExtensionAPI {
  registerTool(tool: ToolDefinitionLike): void;
  on(event: "agent_end", handler: (...args: unknown[]) => unknown): void;
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
  };
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
  pi.registerTool({
    name: "submit_report",
    label: "Submit report",
    description: SUBMIT_REPORT_DESCRIPTION,
    parameters: SUBMIT_REPORT_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const outcome = submitReport(params, ctx.sessionManager.getSessionId(), {
        ...mounts,
        workdir: ctx.cwd,
      });
      return {
        content: [
          { type: "text", text: `Report delivered: ${outcome.bytes} bytes at ${outcome.path}.` },
        ],
        details: {
          path: outcome.path,
          bytes: outcome.bytes,
          status: outcome.status,
        },
      };
    },
  });
}
