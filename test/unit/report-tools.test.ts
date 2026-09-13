/**
 * `submit_report`, and the property every one of its refusals shares.
 *
 * ## What is being pinned, and why the second half of each assertion matters
 *
 * SRD §12's block for this file asks for a criterion per refusal, and each one
 * is phrased the same way: *"assert a throw and that nothing was written"*. The
 * second half is not decoration. An implementation that opened `result.json`,
 * truncated it, and only then noticed the artifact path escaping the outbox
 * would satisfy every throw assertion here and would have destroyed a
 * previously delivered envelope on its way to being correct — which is the
 * `rev-ctx-1` shape (`src/contracts.ts:203-216`): a worker whose report graded
 * as never written. So every refusal is asserted twice, against two different
 * starting states:
 *
 * - **against an EMPTY outbox**, where the assertion is that nothing appears; and
 * - **against an outbox holding a good envelope**, where the assertion is that
 *   its bytes are unchanged. The second is the one that catches a
 *   truncate-then-validate implementation, because the first is green for it.
 *
 * The `listAll` helper walks the whole tree rather than checking for
 * `result.json`, because "nothing was written" includes the temp file the
 * atomic write uses and the `files/` directory the report path would create.
 * A refusal that leaves a `.result.json.tmp` behind has written something, and
 * `src/harvest/task-outbox.ts:209` will report it to an operator as an
 * unrecognised entry.
 *
 * ## The fixtures are asymmetric on purpose
 *
 * The task id in `/policy/task`, the worker id from the session, and every
 * string in the call are distinct and none is a substring of another. An
 * implementation that read the epoch out of the parameters, or the worker out
 * of the task id, cannot pass by coincidence — which is the failure the
 * `truncation-recovery` suite's own header records having designed against.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

/*
 * The HOST side of every mirrored constant, imported under a `HOST_` prefix so
 * the two names cannot be confused at a call site. `report-tools.ts` cannot
 * import these — it is COPYied into the image and runs there — which is exactly
 * why the comparison belongs in a test that can import both.
 */
import { SESSION_ID_RE } from "../../src/contracts.ts";
import {
  DISPATCH_REQUEST_FILE as HOST_DISPATCH_REQUEST_FILE,
  DISPATCH_REQUEST_SCHEMA as HOST_DISPATCH_REQUEST_SCHEMA,
  DispatchRequestSchema,
  MAX_DISPATCH_ID_CHARS as HOST_MAX_DISPATCH_ID_CHARS,
  MAX_DISPATCH_REQUEST_ITEMS as HOST_MAX_DISPATCH_REQUEST_ITEMS,
  MAX_DISPATCH_SERVICES as HOST_MAX_DISPATCH_SERVICES,
  MAX_DISPATCH_TEXT as HOST_MAX_DISPATCH_TEXT,
} from "../../src/run/dispatch-request.ts";

import register, {
  artifactPathProblem,
  capProblem,
  composeEnvelope,
  composeNoSubmitEntry,
  composeSubmitEntry,
  createEpochTracker,
  declaredReplyFile,
  DEFAULT_MOUNTS,
  emptyTally,
  filenameProblem,
  GET_REPLIES_PARAMETERS,
  getReplies,
  DISPATCH_ID_RE,
  DISPATCH_REQUEST_NAME,
  DISPATCH_REQUEST_PARAMETERS,
  DISPATCH_REQUEST_SCHEMA,
  dispatchRequest,
  MAX_DISPATCH_ID_CHARS,
  MAX_DISPATCH_REQUEST_ITEMS,
  MAX_DISPATCH_SERVICES,
  MAX_DISPATCH_TEXT,
  MAX_ENTRIES,
  MAX_REPORT_FILES,
  NAG_TEXT,
  NO_REPLIES_DECLARED,
  NO_SUBMIT_ENTRY_SCHEMA,
  OUTBOX_ROOT,
  parseRepliesPolicy,
  parseTaskPolicy,
  readTaskPolicy,
  REPLIES_POLICY_PATH,
  REPLIES_POLICY_SCHEMA,
  REPLIES_ROOT,
  RESULT_SCHEMA,
  shouldNag,
  submitReport,
  SUBMIT_ENTRY_SCHEMA,
  SUBMIT_REPORT_PARAMETERS,
  SubmitRefusal,
  TASK_POLICY_NONE,
  TASK_POLICY_PATH,
  taskPaths,
  type EpochTally,
  type ExtensionAPI,
  type ExtensionContextLike,
  type MountRoots,
  type Roots,
  type SubmitReportParams,
  type ToolDefinitionLike,
} from "../../docker/pi-extensions/report-tools.ts";
/**
 * The HOST half of the `/policy/replies` contract, imported on purpose.
 *
 * Nothing else in this file reaches into `src/`, and the exception is the point
 * rather than a convenience. `get_replies` reads a document
 * `src/run/replies-policy.ts` writes, across a mount, between a host on one
 * clock and an image pinned by tag on another — and the one property no
 * hand-written fixture can establish is that the two ends agree. A fixture I
 * typed myself proves this file parses what I believe the host emits; these
 * three functions prove it parses what the host actually emits, including the
 * task-id spelling that failure mode 9.6's equality turns on.
 *
 * Hand-written bytes are still used, and only, for documents the host renderer
 * CANNOT produce: a wrong schema tag, a malformed entry, a stale declaration.
 */
import {
  renderRepliesPolicy,
  REPLIES_POLICY_MOUNT,
  REPLIES_POLICY_SCHEMA as HOST_REPLIES_POLICY_SCHEMA,
  type DeclaredReply,
} from "../../src/run/replies-policy.ts";
import { replyHostPath, replyMountPath, REPLIES_MOUNT } from "../../src/run/replies.ts";
import { renderTaskPolicy } from "../../src/run/task-policy.ts";

/** The fixture identities, deliberately sharing no substring with each other. */
const TASK_ID = "T-sweep-7-slice1";
const EPOCH = 12;
const WORKER = "obs-t1";

/** The declared replies the `get_replies` fixtures publish, sharing no substring. */
const CHILD_A: DeclaredReply = { task_id: "T-obs-alpha", worker: "obs-t1", aspect: "kafka" };
const CHILD_B: DeclaredReply = { task_id: "T-obs-beta", worker: "obs-t2", aspect: "postgres" };
/** Never declared. Its file is published anyway — that is Finding E in a fixture. */
const CHILD_UNDECLARED: DeclaredReply = { task_id: "T-obs-gamma", worker: "obs-t3", aspect: "redis" };

interface Fixture {
  dir: string;
  roots: Roots;
  outbox: string;
  taskDir: string;
  /** The reply PLANE, standing in for `/replies`. */
  repliesRoot: string;
  /** The DECLARATION, standing in for `/policy/replies`. Not written by default. */
  repliesPolicyPath: string;
  /** Exactly what `register` is handed — the four mounts, without the workdir. */
  mounts: MountRoots;
}

/**
 * A tmpdir carrying a `/policy/task`, an `/outbox` and an empty `/replies`.
 *
 * `policy` defaults to a live task; passing a string writes those exact bytes,
 * which is how the `<none>` and malformed cases are reached without a second
 * helper. Passing `null` writes no file at all — the unmounted case.
 *
 * **`/policy/replies` is deliberately NOT written here.** An absent declaration
 * is a real state — it is what every `submit_report` fixture in this file should
 * present, and it is one of `get_replies`'s three refusals — so a fixture that
 * created one by default would make the absent case unreachable without a second
 * helper and would quietly seed every unrelated test with a document.
 */
function fixture(policy: string | null = `${TASK_ID}\n${EPOCH}\n`): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pifleet-report-tools-"));
  const policyPath = join(dir, "policy-task");
  if (policy !== null) writeFileSync(policyPath, policy);
  const outbox = join(dir, "outbox");
  mkdirSync(outbox, { recursive: true });
  const workdir = join(dir, "workspace");
  mkdirSync(workdir, { recursive: true });
  const repliesRoot = join(dir, "replies");
  mkdirSync(repliesRoot, { recursive: true });
  const repliesPolicyPath = join(dir, "policy-replies");
  const mounts: MountRoots = {
    policyPath,
    outboxRoot: outbox,
    repliesPolicyPath,
    repliesRoot,
  };
  return {
    dir,
    roots: { ...mounts, workdir },
    outbox,
    taskDir: join(outbox, TASK_ID),
    repliesRoot,
    repliesPolicyPath,
    mounts,
  };
}

/**
 * Create a file a fixture is about to DECLARE, and return its path.
 *
 * `submitReport` refuses an `artifacts` entry naming a file that is not there.
 * Three tests in this file declared `patch.diff` and never wrote it, and passed
 * for as long as nothing asked — which is the same shape as the loss that put
 * the check in: `rev-lang-1` declared `files/review.md`, wrote nothing, and its
 * envelope was accepted and collated with the review simply gone. None of the
 * three meant to assert that a claim about a missing file is allowed; they meant
 * to assert delivery, containment and log shape, and each still does.
 */
function declaredFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "--- a/x\n+++ b/x\n");
  return path;
}

/**
 * Write `/policy/replies` with the HOST's own renderer — the honest path.
 *
 * `taskId` is passed through `renderRepliesPolicy` untouched, so the `task_id`
 * that lands is whatever `renderTaskPolicy` would put on line 1 of
 * `/policy/task` — which is the equality failure mode 9.6 turns on, established
 * here by construction instead of by my retyping it.
 *
 * **Named `declareSet` and not `declare`, and the reason is measured rather than
 * stylistic.** Bun's TypeScript transpiler (1.3.11) treats a bare
 * `declare(...);` CALL STATEMENT as an ambient declaration and ERASES it. The
 * function itself survives — `typeof declare` is `"function"` — so the symptom
 * is ten tests failing as though the fixture had never been written, with no
 * error and nothing in the stack to point at. `tsc --noEmit` is green
 * throughout, and `void declare(...)` or `const x = declare(...)` both run
 * normally; only the statement form disappears. Any helper in this repository
 * whose name is a TypeScript contextual keyword is one rename away from the same
 * silence.
 */
function declareSet(f: Fixture, taskId: string | null, replies: readonly DeclaredReply[]): void {
  writeFileSync(f.repliesPolicyPath, renderRepliesPolicy(taskId, replies));
}

/** Write `/policy/replies` verbatim — for documents the host renderer cannot produce. */
function declareRaw(f: Fixture, body: string): void {
  writeFileSync(f.repliesPolicyPath, body);
}

/**
 * Put a reply on the plane, at the path `replies.ts` names.
 *
 * `replyHostPath` rather than `join(root, id + ".json")`, for the reason that
 * module gives for exporting it at all: a second spelling of the reply filename
 * agrees with the first until the suffix moves, and then this file would be
 * publishing where nothing reads.
 */
function publish(f: Fixture, child: DeclaredReply, body: string): void {
  writeFileSync(replyHostPath(f.repliesRoot, child.task_id), body);
}

/**
 * A `RegExp` matching one literal string.
 *
 * `toThrow(string)` is a SUBSTRING match in bun, which is what is wanted — but
 * the messages asserted below carry backticks, brackets and a `/` in
 * `pifleet.replies/v1`, and writing those into a hand-built pattern is how a
 * test ends up matching less than it reads as matching. Escaping the constant
 * cannot drift from the constant.
 */
function reOf(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
}

/** The refusal every malformed `/policy/replies` produces — asserted in four places. */
const NOT_A_DECLARATION = /is not a `pifleet\.replies\/v1` document/;

/** Every path under `root`, relative and sorted. Empty means nothing was written. */
function listAll(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      out.push(relative(root, full));
      if (e.isDirectory()) walk(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

const minimal: SubmitReportParams = { status: "success", summary: "nineteen tickets, all Accepted" };

/**
 * Drive one refusal against both starting states.
 *
 * The good call that seeds the second state uses a summary no assertion below
 * shares, so a comparison that accidentally reads the refused call's summary
 * fails rather than matching.
 */
function expectRefusal(params: SubmitReportParams, matcher: RegExp): void {
  const empty = fixture();
  expect(() => submitReport(params, WORKER, empty.roots)).toThrow(matcher);
  expect(listAll(empty.outbox)).toEqual([]);
  rmSync(empty.dir, { recursive: true, force: true });

  const seeded = fixture();
  submitReport({ status: "partial", summary: "SEEDED-BASELINE" }, WORKER, seeded.roots);
  const before = readFileSync(join(seeded.taskDir, "result.json"), "utf8");
  const treeBefore = listAll(seeded.outbox);
  expect(() => submitReport(params, WORKER, seeded.roots)).toThrow(matcher);
  expect(readFileSync(join(seeded.taskDir, "result.json"), "utf8")).toBe(before);
  expect(listAll(seeded.outbox)).toEqual(treeBefore);
  rmSync(seeded.dir, { recursive: true, force: true });
}

/** One `pi.appendEntry` call, as a recording `pi` saw it. */
interface RecordedEntry {
  customType: string;
  data: unknown;
}

/** One `pi.on` subscription, as a recording `pi` saw it. */
interface RecordedHandler {
  event: string;
  handler: (event: unknown, ctx: ExtensionContextLike) => unknown;
}

/**
 * One `pi.sendUserMessage` call — layer 3's only observable.
 *
 * `options` is recorded and not discarded because §11 Q1 measured
 * `{deliverAs: "followUp"}` specifically: that spelling lands as a
 * `queue_update` and Pi runs another agent cycle. Nothing measured says a
 * `steer` — or an omitted `options` — extends the turn, so dropping the argument
 * would be dropping the half of the call that was tested in the real image.
 */
interface RecordedMessage {
  content: string;
  options: { deliverAs?: "steer" | "followUp" } | undefined;
}

/**
 * The event objects Pi really passes, cut down to what this file's handlers
 * touch — which is nothing.
 *
 * Both handlers ignore their payload entirely: the count comes from
 * `/policy/task` and the tracker, never from `event.toolName`, and the entry
 * comes from the tracker, never from `AgentEndEvent.messages`. The payloads are
 * here so `fire` passes something of the right SHAPE, and their being ignored is
 * the point — a handler that read `messages` would be counting the retained
 * transcript rather than this epoch (see the header of the no-submit block).
 */
const EVENT_PAYLOADS: Record<"agent_end" | "tool_call", unknown> = {
  agent_end: { type: "agent_end", messages: [] },
  tool_call: { type: "tool_call", toolName: "ls", toolCallId: "call-ls-1", input: {} },
};

/**
 * A `pi` that records instead of running one.
 *
 * Module-scope rather than local to `describe("registration")` because layers 2
 * and 4 both drive `execute` and both need it, and because `entries` is the only
 * window either has: `pi.appendEntry` writes into the session JSONL, which is
 * Pi's to own, so the recording stub IS the assertion surface. `handlers` is the
 * same window onto `pi.on`, which is how the `agent_end` and `tool_call`
 * subscriptions are reached at all.
 *
 * `appendEntry` may be swapped for one that throws — see the delivery-survives
 * tests for why that case is not hypothetical, and note that the swap is
 * per-`customType` in one of them, because a stub that threw on everything could
 * not tell "the entry was never composed" from "the entry could not be written".
 */
function stubPi(
  appendEntry?: ExtensionAPI["appendEntry"],
  sendUserMessage?: ExtensionAPI["sendUserMessage"],
): {
  pi: ExtensionAPI;
  tools: ToolDefinitionLike[];
  entries: RecordedEntry[];
  handlers: RecordedHandler[];
  messages: RecordedMessage[];
} {
  const tools: ToolDefinitionLike[] = [];
  const entries: RecordedEntry[] = [];
  const handlers: RecordedHandler[] = [];
  const messages: RecordedMessage[] = [];
  const pi: ExtensionAPI = {
    registerTool: (tool) => void tools.push(tool),
    on: (event, handler) => void handlers.push({ event, handler }),
    sendUserMessage:
      sendUserMessage ?? ((content, options) => void messages.push({ content, options })),
    appendEntry: appendEntry ?? ((customType, data) => void entries.push({ customType, data })),
  };
  return { pi, tools, entries, handlers, messages };
}

/** `register` against a fixture, plus the `ctx` `execute` and the handlers are really handed. */
function registered(
  f: Fixture,
  appendEntry?: ExtensionAPI["appendEntry"],
  sendUserMessage?: ExtensionAPI["sendUserMessage"],
): {
  tool: ToolDefinitionLike;
  /** `get_replies`, found by name for the reason `byName` gives. */
  replies: ToolDefinitionLike;
  entries: RecordedEntry[];
  messages: RecordedMessage[];
  ctx: ExtensionContextLike;
  /**
   * `payload` overrides the canned event object. It exists for one assertion —
   * that the nag is identical across DIFFERING transcripts — which cannot be
   * made while every `agent_end` this file fires carries the same bytes.
   */
  fire(event: "agent_end" | "tool_call", payload?: unknown): unknown;
} {
  const { pi, tools, entries, handlers, messages } = stubPi(appendEntry, sendUserMessage);
  register(pi, f.mounts);
  const ctx: ExtensionContextLike = {
    cwd: f.roots.workdir ?? "",
    sessionManager: { getSessionId: () => WORKER },
  };
  /**
   * By NAME and not by index, now that two tools are registered.
   *
   * `tools[0]` was unambiguous while there was one; with two it is a claim about
   * registration ORDER that no test here means to make, and reordering the two
   * `registerTool` calls would silently point every `submit_report` assertion in
   * this file at `get_replies`. The `toBeDefined` is the anti-vacuity guard —
   * without it, dropping a `registerTool` would surface as a cryptic throw on
   * the next line rather than as a named failure here.
   */
  const byName = (name: string): ToolDefinitionLike => {
    const found = tools.find((t) => t.name === name);
    expect(found).toBeDefined();
    return found!;
  };
  return {
    tool: byName("submit_report"),
    replies: byName("get_replies"),
    entries,
    messages,
    ctx,
    fire: (event, payload) => {
      const matching = handlers.filter((r) => r.event === event);
      // Without this line every assertion driven through `fire` would be green
      // by VACUITY the moment a subscription was dropped: no handler runs, no
      // entry appears, and "no entry appears" is what several of the tests below
      // are asserting. Unsubscribing `agent_end` is a one-word deletion and it
      // must not be able to make this file greener.
      expect(matching.length).toBeGreaterThan(0);
      let last: unknown;
      const body = payload === undefined ? EVENT_PAYLOADS[event] : payload;
      for (const r of matching) last = r.handler(body, ctx);
      return last;
    },
  };
}

describe("parseTaskPolicy", () => {
  test("reads the two lines task-policy.ts writes", () => {
    expect(parseTaskPolicy(`${TASK_ID}\n${EPOCH}\n`)).toEqual({ taskId: TASK_ID, epoch: EPOCH });
  });

  test("epoch zero is a live task, not a falsy one", () => {
    expect(parseTaskPolicy(`${TASK_ID}\n0\n`)).toEqual({ taskId: TASK_ID, epoch: 0 });
  });

  test("the idle spelling is not a task", () => {
    expect(parseTaskPolicy(`${TASK_POLICY_NONE}\n0\n`)).toBeNull();
  });

  test("a missing or non-integer epoch line is not a task", () => {
    expect(parseTaskPolicy(`${TASK_ID}\n`)).toBeNull();
    expect(parseTaskPolicy(`${TASK_ID}\nlater\n`)).toBeNull();
    expect(parseTaskPolicy(`${TASK_ID}\n-1\n`)).toBeNull();
    expect(parseTaskPolicy(`${TASK_ID}\n1.5\n`)).toBeNull();
  });

  /**
   * The host-bug guard. `renderTaskPolicy` strips control characters and
   * nothing else, and `task_id` is `shortStr` with no charset rule — so a task
   * id that is a path would silently redirect every derived write into another
   * worker's outbox, and the envelope would look well-formed to everyone.
   */
  test("a task id that is not a bare name is refused rather than joined", () => {
    expect(parseTaskPolicy("../other-worker\n1\n")).toBeNull();
    expect(parseTaskPolicy("a/b\n1\n")).toBeNull();
    expect(parseTaskPolicy("..\n1\n")).toBeNull();
    expect(parseTaskPolicy(".\n1\n")).toBeNull();
  });
});

describe("readTaskPolicy", () => {
  test("an unreadable policy file and an idle one refuse differently", () => {
    const missing = fixture(null);
    expect(() => readTaskPolicy(missing.roots.policyPath)).toThrow(/could not be read/);
    rmSync(missing.dir, { recursive: true, force: true });

    const idle = fixture(`${TASK_POLICY_NONE}\n0\n`);
    expect(() => readTaskPolicy(idle.roots.policyPath)).toThrow(/says `<none>`/);
    rmSync(idle.dir, { recursive: true, force: true });
  });

  test("refusals are SubmitRefusal, so a caller can tell them from an ENOENT", () => {
    const idle = fixture(`${TASK_POLICY_NONE}\n0\n`);
    expect(() => readTaskPolicy(idle.roots.policyPath)).toThrow(SubmitRefusal);
    rmSync(idle.dir, { recursive: true, force: true });
  });
});

describe("filenameProblem — §6.2.1's three cases", () => {
  test("a bare name is accepted", () => {
    expect(filenameProblem("review.md")).toBeNull();
    expect(filenameProblem("observer-ops.json")).toBeNull();
  });

  test("a slash, a dot-dot and a leading @ are each refused", () => {
    expect(filenameProblem("files/review.md")).toMatch(/bare name/);
    expect(filenameProblem("../review.md")).toMatch(/bare name/);
    expect(filenameProblem("@review.md")).toMatch(/@/);
  });

  test("the leading-@ message names the fix rather than calling it a path", () => {
    // `@review.md` IS a legal filename. Telling a model it "is not a path"
    // would be true of nothing it did wrong; the fix is one character.
    expect(filenameProblem("@review.md")).toMatch(/without the `@` prefix/);
    expect(filenameProblem("@review.md")).not.toMatch(/not a path/);
  });

  /**
   * `..` ANYWHERE, not only as a leading segment — and this test exists because
   * the battery found the line dead without it.
   *
   * Every other dot-dot fixture here (`../review.md`) also carries a slash, so
   * the slash rule refused it and the dot-dot rule was never reached: removing
   * the dot-dot line left the suite green. That is the degenerate-fixture shape,
   * and the fix is a name that reaches only the rule under test.
   *
   * The rule is genuinely over-strict — `notes..md` cannot traverse anything
   * once `/` and `\` are already refused, and a name like `backup..md` is a
   * legal file. It is kept because §6.2.1 says *"containing `..`"* and because
   * the cost is one retry, which §11 Q4 measured at about a second on every
   * model in the fleet. A rule a model can restate in one sentence is worth
   * more here than the handful of filenames it turns away.
   */
  test("dot-dot is refused even where no slash makes it a traversal", () => {
    expect(filenameProblem("notes..md")).toMatch(/bare name/);
    expect(filenameProblem("..hidden")).toMatch(/bare name/);
  });

  test("an empty name, a backslash and a control character are the same class", () => {
    expect(filenameProblem("")).not.toBeNull();
    expect(filenameProblem("a\\b.md")).not.toBeNull();
    expect(filenameProblem("a\u0000b.md")).not.toBeNull();
    expect(filenameProblem(".")).not.toBeNull();
  });
});

describe("artifactPathProblem — the host's rule, not a stricter one", () => {
  const taskDir = "/outbox/T-x";
  const workdir = "/workspace";

  test("a path inside the task outbox is accepted, absolute or relative", () => {
    expect(artifactPathProblem("/outbox/T-x/files/review.md", taskDir, workdir)).toBeNull();
    expect(artifactPathProblem("files/review.md", taskDir, workdir)).toBeNull();
  });

  /**
   * The deviation this file argues for. `src/harvest/outbox.ts`'s
   * `artifactPathProblem` accepts outbox OR worktree; §6.2.1's message column
   * reads as outbox-only. A call-site check stricter than the host's would
   * refuse an engineer reporting a diff the host would have accepted, which
   * §6.5 property 2 forbids: the tool's validation is a courtesy, the host's
   * decides.
   */
  test("a path inside the container workdir is accepted, as the host accepts it", () => {
    expect(artifactPathProblem("/workspace/patch.diff", taskDir, workdir)).toBeNull();
  });

  test("with no code mount, the workdir arm simply is not there", () => {
    expect(artifactPathProblem("/workspace/patch.diff", taskDir, null)).toMatch(/outside/);
  });

  test("an escape is refused whichever spelling reaches it", () => {
    expect(artifactPathProblem("../../etc/passwd", taskDir, workdir)).toMatch(/outside/);
    expect(artifactPathProblem("/etc/passwd", taskDir, workdir)).toMatch(/outside/);
    expect(artifactPathProblem("/outbox/T-other/result.json", taskDir, workdir)).toMatch(/outside/);
    // Segment boundary: `/outbox/T-x2` must not pass as `/outbox/T-x`.
    expect(artifactPathProblem("/outbox/T-x2/f.md", taskDir, workdir)).toMatch(/outside/);
  });

  test("a backslash and a control character are refused before resolution", () => {
    expect(artifactPathProblem("files\\review.md", taskDir, workdir)).toMatch(/backslash/);
    expect(artifactPathProblem("files/a\u0000b", taskDir, workdir)).toMatch(/control character/);
  });
});

describe("capProblem", () => {
  test("the cap is inclusive and names the field and both numbers", () => {
    expect(capProblem({ ...minimal, blockers: new Array<string>(MAX_ENTRIES).fill("x") })).toBeNull();
    expect(capProblem({ ...minimal, blockers: new Array<string>(MAX_ENTRIES + 1).fill("x") })).toBe(
      `\`blockers\` has ${MAX_ENTRIES + 1} entries; cap is ${MAX_ENTRIES}.`,
    );
  });

  test("every capped field is walked, not just the first", () => {
    const over = MAX_ENTRIES + 1;
    expect(capProblem({ ...minimal, acceptance: new Array(over).fill({ criterion: "c", met: true }) }))
      .toMatch(/^`acceptance`/);
    expect(capProblem({ ...minimal, commands_run: new Array(over).fill({ cmd: "c", exit_code: 0 }) }))
      .toMatch(/^`commands_run`/);
    expect(capProblem({ ...minimal, artifacts: new Array(over).fill({ kind: "note", path: "n" }) }))
      .toMatch(/^`artifacts`/);
  });
});

describe("the schema", () => {
  /**
   * §12: *"`submit_report` composes `task_id` and `epoch` from `/policy/task`,
   * never from parameters. Reddened by adding either as a parameter."* This is
   * that mutation stated where it can be caught statically, at the shape of the
   * schema rather than at the bytes of one envelope.
   */
  test("the four host-composed fields are not parameters", () => {
    const props = Object.keys(SUBMIT_REPORT_PARAMETERS.properties);
    for (const forbidden of ["schema", "task_id", "epoch", "worker"]) {
      expect(props).not.toContain(forbidden);
    }
  });

  test("additionalProperties is closed, so a model cannot pass them anyway", () => {
    expect(SUBMIT_REPORT_PARAMETERS.additionalProperties).toBe(false);
  });

  /**
   * The `StringEnum` spelling, which is the whole of §6.2's instruction about
   * enums: `type` + `enum`, never `anyOf`/`const`. Measured in the image
   * 2026-09-08: `StringEnum(["success","partial"])` returns exactly
   * `{"type":"string","enum":["success","partial"]}`.
   */
  test("enums are spelled type+enum, never anyOf or const", () => {
    const json = JSON.stringify(SUBMIT_REPORT_PARAMETERS);
    expect(json).not.toContain("anyOf");
    expect(json).not.toContain("const");
    expect(SUBMIT_REPORT_PARAMETERS.properties.status).toEqual({
      type: "string",
      enum: ["success", "partial", "blocked", "failed"],
    });
  });

  test("report.content carries no length cap — §11 Q8's failures precede execute", () => {
    expect(SUBMIT_REPORT_PARAMETERS.properties.report.items.properties.content).toEqual({ type: "string" });
  });
});

describe("composeEnvelope", () => {
  test("the four host fields come from host state and the rest from the call", () => {
    const env = composeEnvelope(minimal, { taskId: TASK_ID, epoch: EPOCH }, WORKER, []);
    expect(env.schema).toBe(RESULT_SCHEMA);
    expect(env.task_id).toBe(TASK_ID);
    expect(env.epoch).toBe(EPOCH);
    expect(env.worker).toBe(WORKER);
    expect(env.status).toBe("success");
    expect(env.summary).toBe(minimal.summary);
  });

  test("absent optional fields are omitted, not defaulted", () => {
    const env = composeEnvelope(minimal, { taskId: TASK_ID, epoch: EPOCH }, WORKER, []);
    expect(Object.keys(env).sort()).toEqual(
      ["epoch", "schema", "status", "summary", "task_id", "worker"],
    );
  });

  test("a written report is appended to artifacts, beside what the call declared", () => {
    const env = composeEnvelope(
      { ...minimal, artifacts: [{ kind: "diff", path: "files/patch.diff" }] },
      { taskId: TASK_ID, epoch: EPOCH },
      WORKER,
      ["files/review.md"],
    );
    expect(env.artifacts).toEqual([
      { kind: "diff", path: "files/patch.diff" },
      { kind: "file", path: "files/review.md" },
    ]);
  });
});

describe("taskPaths", () => {
  test("all three paths are derived from the mount and the task id", () => {
    expect(taskPaths(OUTBOX_ROOT, TASK_ID)).toEqual({
      taskDir: `/outbox/${TASK_ID}`,
      filesDir: `/outbox/${TASK_ID}/files`,
      envelopePath: `/outbox/${TASK_ID}/result.json`,
    });
  });
});

describe("submitReport — the delivery", () => {
  test("writes an envelope whose identity came from /policy/task", () => {
    const f = fixture();
    const out = submitReport({ ...minimal, notes: "the long form" }, WORKER, f.roots);
    const env = JSON.parse(readFileSync(out.path, "utf8")) as Record<string, unknown>;
    expect(env["schema"]).toBe(RESULT_SCHEMA);
    expect(env["task_id"]).toBe(TASK_ID);
    expect(env["epoch"]).toBe(EPOCH);
    expect(env["worker"]).toBe(WORKER);
    expect(env["notes"]).toBe("the long form");
    expect(out.bytes).toBe(Buffer.byteLength(readFileSync(out.path, "utf8"), "utf8"));
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("the report file lands in files/ and declares itself in artifacts", () => {
    const f = fixture();
    const out = submitReport(
      { ...minimal, report: [{ filename: "review.md", content: "# a review\n" }] },
      WORKER,
      f.roots,
    );
    expect(out.reportPaths).toEqual([join(f.taskDir, "files", "review.md")]);
    expect(readFileSync(out.reportPaths[0] ?? "", "utf8")).toBe("# a review\n");
    const env = JSON.parse(readFileSync(out.path, "utf8")) as { artifacts: unknown };
    // RELATIVE, and this assertion is the reason. An absolute `/outbox/...`
    // claim would be right only inside the image; `artifactClaimToHost`
    // resolves a relative one against the task outbox wherever it is, so the
    // value asserted here is the value production writes.
    expect(env.artifacts).toEqual([{ kind: "file", path: "files/review.md" }]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The write is a REPLACEMENT, and the inode is what proves it.
   *
   * This is `test/unit/task-policy.test.ts`'s assertion turned exactly around,
   * and the pair is worth reading together. There, the inode must SURVIVE a
   * rewrite, because `/policy/task` is a FILE bind mount and a rename would
   * swap the file the host sees while the container went on reading the old
   * one. Here it must CHANGE, because `/outbox` is a DIRECTORY bind mount and
   * the harvester opens `result.json` by path on its own schedule — an
   * in-place `writeFileSync` is readable by the host while half-written, and a
   * half-written envelope is not "retry later" but `unreadable`, which grades
   * the worker as having produced garbage.
   *
   * An in-place write passes every other assertion in this file. This is the
   * only one it fails.
   */
  test("the envelope is replaced, not rewritten in place", () => {
    const f = fixture();
    const first = submitReport({ status: "partial", summary: "first" }, WORKER, f.roots);
    const inodeBefore = statSync(first.path).ino;
    submitReport({ status: "success", summary: "second" }, WORKER, f.roots);
    expect(statSync(first.path).ino).not.toBe(inodeBefore);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A HANDLED failure leaves no litter.
   *
   * The target is made a non-empty directory, so the write succeeds and the
   * rename cannot. Only a crash between those two should be able to leave a
   * temp behind — and that one is meant to be visible, because
   * `src/harvest/task-outbox.ts:209` reports it to an operator as an
   * unrecognised entry under the task outbox.
   */
  /**
   * The report file lands BEFORE the envelope, and this is how that order is
   * observable without a crash.
   *
   * `result.json` is made a non-empty directory, so the envelope write is
   * guaranteed to fail. The report file must nevertheless be on disk when it
   * does: an envelope naming a file that has not been written yet is a false
   * claim, while a file with no envelope is just a report that has not landed —
   * a state this fleet's harvest already reads correctly. Swap the two writes
   * and this is the assertion that notices.
   */
  test("the report file is written before the envelope", () => {
    const f = fixture();
    const blocked = join(f.taskDir, "result.json");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "occupied"), "x");
    expect(() =>
      submitReport(
        { ...minimal, report: [{ filename: "review.md", content: "# a review\n" }] },
        WORKER,
        f.roots,
      ),
    ).toThrow();
    expect(existsSync(join(f.taskDir, "files", "review.md"))).toBe(true);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("a failed rename cleans up its own temp file", () => {
    const f = fixture();
    const blocked = join(f.taskDir, "result.json");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "occupied"), "x");
    expect(() => submitReport(minimal, WORKER, f.roots)).toThrow();
    expect(listAll(f.outbox).filter((p) => p.includes(".tmp"))).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("nothing is left behind — the atomic write's temp does not survive", () => {
    const f = fixture();
    submitReport({ ...minimal, report: [{ filename: "review.md", content: "x" }] }, WORKER, f.roots);
    expect(listAll(f.outbox).filter((p) => p.includes(".tmp"))).toEqual([]);
    expect(listAll(f.outbox).sort()).toEqual(
      [TASK_ID, join(TASK_ID, "files"), join(TASK_ID, "files", "review.md"), join(TASK_ID, "result.json")].sort(),
    );
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * §12: *"A second `submit_report` in one epoch overwrites and does not throw.
   * This asserts a deliberate non-refusal and is the criterion that stops
   * someone 'fixing' it into an error."* `roles/observer-k8s.md` asks for
   * exactly this behaviour in prose — *"A first version on disk at call twenty
   * and a second at call forty is strictly better than one perfect version that
   * never lands"* — so a tool that punished it would be punishing the thing the
   * role document begs for.
   */
  test("a second call in the same epoch overwrites and does not throw", () => {
    const f = fixture();
    submitReport({ status: "partial", summary: "first pass" }, WORKER, f.roots);
    const second = submitReport({ status: "success", summary: "second pass" }, WORKER, f.roots);
    const env = JSON.parse(readFileSync(second.path, "utf8")) as Record<string, unknown>;
    expect(env["summary"]).toBe("second pass");
    expect(env["status"]).toBe("success");
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("an artifact inside the container workdir is delivered, not refused", () => {
    const f = fixture();
    const out = submitReport(
      { ...minimal, artifacts: [{ kind: "diff", path: declaredFile(join(f.roots.workdir ?? "", "patch.diff")) }] },
      WORKER,
      f.roots,
    );
    expect(existsSync(out.path)).toBe(true);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

describe("submitReport — every refusal throws AND writes nothing", () => {
  test("no task is live", () => {
    const idle = fixture(`${TASK_POLICY_NONE}\n0\n`);
    expect(() => submitReport(minimal, WORKER, idle.roots)).toThrow(/No task is live/);
    expect(listAll(idle.outbox)).toEqual([]);
    rmSync(idle.dir, { recursive: true, force: true });
  });

  test("the policy file is not mounted", () => {
    const unmounted = fixture(null);
    expect(() => submitReport(minimal, WORKER, unmounted.roots)).toThrow(/could not be read/);
    expect(listAll(unmounted.outbox)).toEqual([]);
    rmSync(unmounted.dir, { recursive: true, force: true });
  });

  test("report.filename contains a slash", () => {
    expectRefusal({ ...minimal, report: [{ filename: "files/r.md", content: "x" }] }, /bare name/);
  });

  test("report.filename contains ..", () => {
    expectRefusal({ ...minimal, report: [{ filename: "../r.md", content: "x" }] }, /bare name/);
  });

  test("report.filename starts with @", () => {
    expectRefusal({ ...minimal, report: [{ filename: "@r.md", content: "x" }] }, /@/);
  });

  test("an artifact path escapes the task outbox", () => {
    expectRefusal({ ...minimal, artifacts: [{ kind: "file", path: "../../etc/passwd" }] }, /outside/);
  });

  test("an artifact path is absolute and outside every mount", () => {
    expectRefusal({ ...minimal, artifacts: [{ kind: "file", path: "/etc/passwd" }] }, /outside/);
  });

  test("an array is over the cap", () => {
    expectRefusal(
      { ...minimal, blockers: new Array<string>(MAX_ENTRIES + 1).fill("x") },
      /cap is 64/,
    );
  });

  /**
   * The ordering assertion, stated where it can fail on its own.
   *
   * A call carrying BOTH a valid `report` and an inadmissible artifact must
   * write neither. An implementation that wrote the report file first and
   * validated artifacts second would leave a file in `files/` that no envelope
   * declares — the undeclared-artifact discrepancy the harvest's reverse pass
   * reports as *"which the envelope does not claim"*
   * (`src/harvest/reconcile.ts`), produced by the very tool that exists to make
   * it impossible.
   */
  test("a refused call carrying a valid report writes no report file either", () => {
    const f = fixture();
    expect(() =>
      submitReport(
        {
          ...minimal,
          report: [{ filename: "review.md", content: "# a review\n" }],
          artifacts: [{ kind: "file", path: "/etc/passwd" }],
        },
        WORKER,
        f.roots,
      ),
    ).toThrow(/outside/);
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The T-rv-155 loss, as a test.
   *
   * `rev-lang-1` submitted a review whose envelope declared `files/review.md`
   * and whose outbox held `result.json` and no `files/` directory at all. The
   * collator recorded the lens as `reported: true`, then had to note that the
   * artifact "was not harvested", and eleven findings survived only as the one
   * paragraph the envelope's summary happened to carry. Every check this tool
   * ran had passed: the path is well shaped, inside the task outbox, under the
   * cap. Shape was the only question anyone was asking.
   */
  test("an artifact naming a file that was never written", () => {
    expectRefusal(
      { ...minimal, artifacts: [{ kind: "file", path: "files/review.md" }] },
      /does not exist/,
    );
  });

  /** The same question on the OTHER branch `artifactPathProblem` admits. */
  test("a missing artifact inside the container workdir is refused too", () => {
    const f = fixture();
    expect(() =>
      submitReport(
        { ...minimal, artifacts: [{ kind: "diff", path: join(f.roots.workdir ?? "", "gone.diff") }] },
        WORKER,
        f.roots,
      ),
    ).toThrow(/does not exist/);
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The exemption, pinned so it cannot be simplified away.
   *
   * Phase 1 reads before phase 2 writes, so the report file this very call is
   * about to create does not exist when the artifact loop runs. A caller that
   * passes `report` AND redundantly declares its file is making a claim that IS
   * true by the time the envelope lands, and refusing it would punish a call
   * that did everything right. The cheapest way to satisfy the two tests above
   * is a blanket `existsSync` over every claim, and that breaks exactly here —
   * which is why this one success assertion sits in a describe block full of
   * refusals rather than beside the other delivery tests.
   */
  test("the report file this call is about to write is not refused as missing", () => {
    const f = fixture();
    const out = submitReport(
      {
        ...minimal,
        report: [{ filename: "review.md", content: "# a review\n" }],
        artifacts: [{ kind: "file", path: "files/review.md" }],
      },
      WORKER,
      f.roots,
    );
    expect(existsSync(out.path)).toBe(true);
    expect(existsSync(join(f.taskDir, "files", "review.md"))).toBe(true);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

describe("registration", () => {
  /**
   * §12, as of phase 5: the registered set EQUALS `PI_EXTENSION_TOOLS`.
   *
   * The enum itself is not imported here — `docker/pi-extensions/` may not
   * depend on `src/`, and a unit test asserting against a recording `pi` cannot
   * see the image anyway. `test/integration/report-tools-image.test.ts` is where
   * the two sets are compared, and it was tightened from a subset assertion to
   * `toEqual(new Set(PI_EXTENSION_TOOLS))` in this same commit. What this test
   * pins is the half that lives in this repository: BOTH tools are registered,
   * with their own parameter schemas, and no third.
   *
   * The names are asserted as a sorted set rather than in registration order,
   * for `byName`'s reason: the order is not a property this file means to fix.
   */
  test("exactly submit_report, dispatch_request and get_replies are registered", () => {
    const { pi, tools } = stubPi();
    register(pi);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "dispatch_request",
      "get_replies",
      "submit_report",
    ]);
    expect(tools.find((t) => t.name === "submit_report")?.parameters).toBe(
      SUBMIT_REPORT_PARAMETERS,
    );
    expect(tools.find((t) => t.name === "dispatch_request")?.parameters).toBe(
      DISPATCH_REQUEST_PARAMETERS,
    );
    expect(tools.find((t) => t.name === "get_replies")?.parameters).toBe(GET_REPLIES_PARAMETERS);
  });

  /**
   * `dispatch_request` must NOT end the turn, and this is the assertion for it.
   *
   * `roles/triage.md` closes turn one with *"Then stop. `submit_report` is the
   * LAST TOOL CALL of turn one"* — the fan-out and then the envelope. Layer 2
   * makes delivering the cheapest way to end a turn; ending it on the fan-out
   * would settle the parent task with a request written and no envelope, and D5
   * settles the parent the moment that file appears. The absence is asserted
   * rather than assumed, exactly as `get_replies`' is.
   */
  test("dispatch_request does not terminate the turn; submit_report does", async () => {
    const f = fixture();
    const { pi, tools } = stubPi();
    register(pi, f.mounts);
    const fanout = tools.find((t) => t.name === "dispatch_request");
    const out = (await fanout?.execute?.(
      "call-1",
      { requests: [REQUEST] },
      undefined,
      undefined,
      { cwd: f.roots.workdir ?? "", sessionManager: { getSessionId: () => WORKER } },
    )) as { terminate?: boolean };
    expect(out.terminate).toBeUndefined();
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("the default mounts are the real ones, so the image needs no caller to pass them", () => {
    expect(DEFAULT_MOUNTS).toEqual({
      policyPath: TASK_POLICY_PATH,
      outboxRoot: OUTBOX_ROOT,
      repliesPolicyPath: REPLIES_POLICY_PATH,
      repliesRoot: REPLIES_ROOT,
    });
  });

  /**
   * The mirrored mount constants are the paths `src/` actually mounts.
   *
   * `docker/pi-extensions/` may not import from `src/`, so these are copies —
   * and a copy with no comparison is a spelling that drifts the first time a
   * mount moves. This test is the comparison. `REPLIES_POLICY_PATH` and
   * `REPLIES_ROOT` are the two `get_replies` reads and the two that are new;
   * `TASK_POLICY_PATH` is already pinned through `renderTaskPolicy` elsewhere in
   * this file, and `/outbox` has no exported constant on the host side to
   * compare against (`render.ts` spells it inline).
   *
   * **The test above cannot make this claim, and that was measured rather than
   * assumed.** `DEFAULT_MOUNTS` is BUILT from these constants, so an assertion
   * comparing it to them compares each one to itself: mutating
   * `REPLIES_POLICY_PATH` to `/policy/reply` leaves that test green and reddens
   * only this one. What the `DEFAULT_MOUNTS` test does catch is a wrong WIRING —
   * a field pointed at the wrong constant — and mutating `repliesPolicyPath` to
   * `TASK_POLICY_PATH` reddens it alone. Two tests, two failures, and neither
   * substitutes for the other.
   */
  test("the mirrored mount constants are the paths src/ mounts", () => {
    expect(REPLIES_POLICY_PATH).toBe(REPLIES_POLICY_MOUNT);
    expect(REPLIES_ROOT).toBe(REPLIES_MOUNT);
    expect(REPLIES_POLICY_SCHEMA).toBe(HOST_REPLIES_POLICY_SCHEMA);
  });

  /**
   * The two subscriptions layer 4 needs, and no third.
   *
   * `agent_end` is where non-delivery becomes a record and `tool_call` is the
   * only source of the count that record carries. A third subscription would be
   * a hook with no reader — and `session_start`/`session_shutdown` in particular
   * belong to `dispatch-trigger.ts`, which owns the poll they arm.
   */
  test("exactly agent_end and tool_call are subscribed", () => {
    const { pi, handlers } = stubPi();
    register(pi);
    expect(handlers.map((h) => h.event).sort()).toEqual(["agent_end", "tool_call"]);
  });

  /**
   * The `ctx` seam, which nothing else here reaches.
   *
   * `render.ts:203` launches every worker with `--session-id <w.id>`, so
   * `ctx.sessionManager.getSessionId()` IS the worker id and is unforgeable
   * from inside the container. If `execute` composed `worker` from anything
   * else — a constant, an env var, the task id — every assertion above would
   * still pass, because they all call `submitReport` directly and hand it the
   * worker themselves.
   */
  test("execute takes worker from the session id and workdir from ctx.cwd", async () => {
    const f = fixture();
    const { pi, tools } = stubPi();
    register(pi, f.mounts);
    const tool = tools.find((t) => t.name === "submit_report");
    expect(tool).toBeDefined();

    const ctx: ExtensionContextLike = {
      cwd: f.roots.workdir ?? "",
      sessionManager: { getSessionId: () => WORKER },
    };
    const result = await tool!.execute(
      "call-1",
      { ...minimal, artifacts: [{ kind: "diff", path: declaredFile(join(f.roots.workdir ?? "", "patch.diff")) }] },
      undefined,
      undefined,
      ctx,
    );

    const env = JSON.parse(readFileSync(join(f.taskDir, "result.json"), "utf8")) as Record<string, unknown>;
    expect(env["worker"]).toBe(WORKER);
    expect(result.content[0]?.text).toMatch(/^Report delivered: \d+ bytes at /);
    expect(result.details).toEqual({
      path: join(f.taskDir, "result.json"),
      bytes: Buffer.byteLength(readFileSync(join(f.taskDir, "result.json"), "utf8"), "utf8"),
      status: "success",
    });
    rmSync(f.dir, { recursive: true, force: true });
  });

});

/**
 * Layer 2 (SRD §6.3, task 3.1) — `terminate: true`.
 *
 * **What this layer is and is not.** `docs/extensions.md` calls it a HINT that
 * *"the automatic follow-up LLM call should be skipped after the current tool
 * batch"*, effective *"only when every finalized tool result in that batch is
 * terminating"*. It cannot make not-delivering fail; it makes delivering the
 * cheapest possible way to end a turn, which is §6.3's own framing — *"it makes
 * the right action the lazy action"*.
 *
 * **It is asserted here and it is measured elsewhere, and neither substitutes
 * for the other.** SRD §11 Q3 ran it in the real image against all four fleet
 * models: `agent_end` fired 2-4ms after the terminating result and every task
 * settled `success` / `quiesced`. What a unit test can pin is that the flag is
 * on the object at all — which is the half that a refactor deletes.
 */
describe("layer 2 — terminate: true", () => {
  test("a delivered report ends the turn", async () => {
    const f = fixture();
    const { tool, ctx } = registered(f);
    const result = await tool.execute("call-1", minimal, undefined, undefined, ctx);
    expect(result.terminate).toBe(true);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * Three keys and no fourth.
   *
   * `details` is what §6.5 property 1 permits to reach the model and the
   * transcript and NOTHING else — no host code reads a tool result — so a
   * field added here is a field with no reader and an invitation to grow one.
   * Pinning the key set is how that stays deliberate: adding a fourth requires
   * changing this line, which is the moment to ask who reads it.
   */
  test("the result is content, details and terminate, and no fourth key", async () => {
    const f = fixture();
    const { tool, ctx } = registered(f);
    const result = await tool.execute("call-1", minimal, undefined, undefined, ctx);
    expect(Object.keys(result).sort()).toEqual(["content", "details", "terminate"]);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

/**
 * Layer 4 (SRD §6.3, task 3.2) — `pifleet.submit/v1`, and the fence around it.
 *
 * **Why this entry exists.** `SweepJoin.claimedSuccess` currently INFERS *"the
 * worker said it was done and wrote nothing"* from the absence of a file plus a
 * `success` verdict. It cannot tell *the worker never called the tool* from
 * *the worker called it and the write failed*, and those two send an operator
 * to different places. The entry is the producer that turns the first into a
 * fact. `pi.appendEntry` *"does NOT participate in LLM context"*
 * (`types.d.ts:871`) and lands in the session JSONL, which is bind-mounted
 * read-write from the run tree (`render.ts:513`) — so the host can read it with
 * no new mount and the model never sees it.
 *
 * **And the fence.** §6.5 property 3: the entry *"may appear in an actor log, in
 * `pifleet monitor`, and in `claimedSuccess`'s message. It may not appear in a
 * verdict, a coverage count, an incident transition or a notification."* The
 * assertions below are about the entry's SHAPE; the authority anti-criterion is
 * a host-side guard and is not this file's to make. What this file can do — and
 * does, in the eight-fields test — is refuse to put anything in the entry that
 * would be worth branching on: no `summary`, no `notes`, nothing the model
 * wrote. An entry carrying only host state and byte counts is one that cannot
 * become a claim.
 */
describe("layer 4 — the pifleet.submit/v1 session entry", () => {
  /** The entry one `execute` wrote, with the customType asserted on the way past. */
  async function deliverAndRead(
    f: Fixture,
    params: SubmitReportParams,
  ): Promise<Record<string, unknown>> {
    const { tool, entries, ctx } = registered(f);
    await tool.execute("call-1", params, undefined, undefined, ctx);
    expect(entries.map((e) => e.customType)).toEqual([SUBMIT_ENTRY_SCHEMA]);
    return entries[0]!.data as Record<string, unknown>;
  }

  test("delivery writes exactly one entry, under §7.1's customType", async () => {
    const f = fixture();
    const { tool, entries, ctx } = registered(f);
    await tool.execute("call-1", minimal, undefined, undefined, ctx);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.customType).toBe("pifleet.submit/v1");
    expect(SUBMIT_ENTRY_SCHEMA).toBe("pifleet.submit/v1");
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * §7.1's eight fields, and no ninth — the anti-criterion of this block.
   *
   * The ninth field somebody will want to add is `summary`, because it is right
   * there and it would make `pifleet monitor` read better. `Docs/SRD.md` §12.6
   * is why it must not be: worker prose is data, and an entry the host reads
   * out of a channel the model cannot see is exactly the place where a claim
   * would ride in wearing a fact's clothes. Every field below is host state, a
   * byte count, or a path the envelope on disk also carries.
   */
  test("§7.1's eight fields, and no ninth", async () => {
    const f = fixture();
    const data = await deliverAndRead(f, { ...minimal, notes: "the long form" });
    expect(Object.keys(data).sort()).toEqual([
      "artifact_files",
      "at",
      "bytes",
      "epoch",
      "schema",
      "status",
      "task_id",
      "worker",
    ]);
    expect(data["schema"]).toBe("pifleet.submit/v1");
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The identity is host state, exactly as the envelope's is.
   *
   * `TASK_ID`, `EPOCH` and `WORKER` share no substring with each other or with
   * anything in the call, so an implementation that read the worker off the
   * task id, or the epoch out of the parameters, cannot pass by coincidence.
   */
  test("task_id, epoch and worker come from /policy/task and the session, not the call", async () => {
    const f = fixture();
    const data = await deliverAndRead(f, minimal);
    expect(data["task_id"]).toBe(TASK_ID);
    expect(data["epoch"]).toBe(EPOCH);
    expect(data["worker"]).toBe(WORKER);
    expect(data["status"]).toBe("success");
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * `bytes` is the envelope ON DISK.
   *
   * This is the field the entry exists for: it is what an operator compares
   * against a missing `result.json` to tell *"never called the tool"* from
   * *"called it and the write failed"*. A number composed for the model rather
   * than measured from the bytes that landed would answer neither question, so
   * it is asserted against the file and not against a constant.
   */
  test("bytes is the envelope that landed, measured from the file", async () => {
    const f = fixture();
    const data = await deliverAndRead(f, { ...minimal, notes: "a much longer second field" });
    const onDisk = Buffer.byteLength(
      readFileSync(join(f.taskDir, "result.json"), "utf8"),
      "utf8",
    );
    expect(data["bytes"]).toBe(onDisk);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * `artifact_files` is the ENVELOPE's claim list, verbatim — which is a
   * superset of the call's, because the tool appends the `report` it wrote.
   *
   * Two mutations this fixture is built to catch, and it is asymmetric for
   * exactly that reason. Reading `params.artifacts` instead of the composed
   * envelope's drops `files/review.md` — the file the tool itself wrote, which
   * is the one an operator is most likely to be hunting. Reducing each entry to
   * a basename yields `["patch.diff", "review.md"]`, which reads fine in a log
   * and cannot be resolved back to a location: `files/x` and `/workspace/x` are
   * the same string once the directory is gone.
   */
  test("artifact_files carries the declared claims and the report the tool appended", async () => {
    const f = fixture();
    declaredFile(join(f.taskDir, "files", "patch.diff"));
    const data = await deliverAndRead(f, {
      ...minimal,
      artifacts: [{ kind: "diff", path: "files/patch.diff" }],
      report: [{ filename: "review.md", content: "# a review\n" }],
    });
    expect(data["artifact_files"]).toEqual(["files/patch.diff", "files/review.md"]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * An EMPTY ARRAY, not an absent key.
   *
   * `composeEnvelope` omits `artifacts` when there are none, deliberately —
   * *"the difference between 'reported none' and 'did not report' is one an
   * operator reading the raw JSON should keep"*. The session entry is the
   * opposite case and the opposite rule applies: it is read by a machine
   * looking for one shape, and a key that is sometimes missing is a key every
   * reader has to guard. `[]` says the same thing without the branch.
   */
  test("artifact_files is an empty array when nothing was claimed, never absent", async () => {
    const f = fixture();
    const data = await deliverAndRead(f, minimal);
    expect(data["artifact_files"]).toEqual([]);
    expect(Object.keys(data)).toContain("artifact_files");
    rmSync(f.dir, { recursive: true, force: true });
  });

  /** `at` is an ISO8601 Z stamp — `new Date().toISOString()`, as every other timestamp here is. */
  test("at is an ISO8601 Z stamp", async () => {
    const f = fixture();
    const before = Date.now();
    const data = await deliverAndRead(f, minimal);
    const at = data["at"];
    expect(typeof at).toBe("string");
    expect(at as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(Date.parse(at as string)).toBeGreaterThanOrEqual(before - 1000);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A REFUSED call appends nothing, and this is the ordering assertion of
   * layer 4.
   *
   * The entry says *"a report was delivered"*. Written before the bytes land —
   * or written from a `finally` — it would say that of a call that threw, and
   * the host would be told the write failed when the tool never got as far as
   * writing. That is a worse diagnosis than none: it points an operator at the
   * filesystem for a problem in the call.
   */
  test("a refused call appends no entry", async () => {
    const f = fixture();
    const { tool, entries, ctx } = registered(f);
    await expect(
      tool.execute(
        "call-1",
        { ...minimal, artifacts: [{ kind: "file", path: "/etc/passwd" }] },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/outside/);
    expect(entries).toEqual([]);
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **A diagnostic write may not un-deliver a report that landed.**
   *
   * Not hypothetical, and not defensive coding for its own sake: §6.5 property
   * 4 is *"a worker that calls `submit_report` and whose file does not land is
   * counted as having produced nothing"*, and the inverse is the property this
   * pins — a worker whose file DID land must not be told it failed. `execute`
   * throwing after `writeAtomic` succeeded would make the model see `isError`
   * on a delivered report, and §11 Q4 measured what happens next: every model
   * retries once. That retry re-delivers the same envelope (legal, §6.2.1) and
   * throws again, so the transcript ends with a worker convinced it could not
   * report, on top of a correct `result.json`.
   *
   * So the append is wrapped, and this test is the only thing that reddens if
   * the wrapper is removed as noise.
   */
  test("an appendEntry that throws does not un-deliver a report that landed", async () => {
    const f = fixture();
    const tools: ToolDefinitionLike[] = [];
    const pi: ExtensionAPI = {
      registerTool: (tool) => void tools.push(tool),
      on: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: () => {
        throw new Error("session store is gone");
      },
    };
    register(pi, f.mounts);
    const result = await tools.find((t) => t.name === "submit_report")!.execute(
      "call-1",
      { status: "partial", summary: "SESSION-STORE-GONE" },
      undefined,
      undefined,
      { cwd: f.roots.workdir ?? "", sessionManager: { getSessionId: () => WORKER } },
    );
    expect(result.terminate).toBe(true);
    const env = JSON.parse(readFileSync(join(f.taskDir, "result.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(env["summary"]).toBe("SESSION-STORE-GONE");
    rmSync(f.dir, { recursive: true, force: true });
  });
});

/**
 * `composeSubmitEntry` on its own, where the mapping is visible without a
 * filesystem in the way.
 *
 * `at` is a PARAMETER rather than a `Date.now()` read inside, for the reason
 * `truncation-recovery.ts` injects `readFull`: a value a test cannot fix is a
 * value a test can only match with a regex. `execute` supplies
 * `new Date().toISOString()` and the ISO-shape assertion above covers that
 * seam; everything else about the entry is asserted here against exact values.
 */
describe("composeSubmitEntry", () => {
  test("every field is the outcome's, and `at` is the caller's", () => {
    const entry = composeSubmitEntry(
      {
        path: "/outbox/T-x/result.json",
        bytes: 2841,
        status: "partial",
        reportPaths: [],
        taskId: TASK_ID,
        epoch: EPOCH,
        artifactFiles: ["files/observer-ops.json", "files/observer-ops.md"],
      },
      WORKER,
      "2026-09-07T23:41:02Z",
    );
    expect(entry).toEqual({
      schema: "pifleet.submit/v1",
      task_id: TASK_ID,
      epoch: EPOCH,
      worker: WORKER,
      status: "partial",
      bytes: 2841,
      artifact_files: ["files/observer-ops.json", "files/observer-ops.md"],
      at: "2026-09-07T23:41:02Z",
    });
  });

  /**
   * The envelope's path is NOT in the entry, and that is not an oversight.
   *
   * `path` is derivable from `task_id` and the mount (§6.4: five of seven
   * fields need no new host contract), and `Docs/SRD-TRIAGE-CONSOLE.md` §7.8's
   * rule applies — *"a value that must always equal a function of two others is
   * one that will one day disagree with them."* It is also a CONTAINER path,
   * and the host reading this entry is on the other side of the mount.
   */
  test("the container path the model was told is not in the entry", () => {
    const entry = composeSubmitEntry(
      {
        path: "/outbox/T-x/result.json",
        bytes: 1,
        status: "success",
        reportPaths: [],
        taskId: TASK_ID,
        epoch: EPOCH,
        artifactFiles: [],
      },
      WORKER,
      "2026-09-07T23:41:02Z",
    );
    expect(JSON.stringify(entry)).not.toContain("/outbox/");
  });
});

/**
 * The per-epoch tally, which is where "nothing was delivered" is decided.
 *
 * **Why a flag and not an inference.** The obvious implementation of layer 4's
 * other half is to look for a `pifleet.submit/v1` entry and, finding none,
 * conclude the tool was never called. It is wrong, and the reason is three
 * screens up in `report-tools.ts`: the `appendEntry` on the delivery path is
 * wrapped in a `try/catch` that SWALLOWS, deliberately, because *"a diagnostic
 * write may not un-deliver a report that landed"*. So a failed session write
 * produces a DELIVERED REPORT WITH NO ENTRY, and an implementation that
 * inferred backwards would file `pifleet.no_submit/v1` against a worker that
 * did its job — the one way a diagnostic record can be worse than no record.
 *
 * The flag is set by `submit_report` itself, in memory, before the entry is
 * attempted. It cannot be wrong about a delivery it performed.
 *
 * **Keyed on task id AND epoch.** `dispatch-trigger.ts` makes this exact
 * argument for its own trigger key — *"`epoch` alone is not unique across
 * workers"* — and the tests below use two task ids at the SAME epoch number so
 * an implementation keyed on the number alone cannot pass.
 */
describe("createEpochTracker — the per-epoch tally", () => {
  const twelve = { taskId: TASK_ID, epoch: EPOCH };
  const thirteen = { taskId: TASK_ID, epoch: EPOCH + 1 };
  /** Same epoch NUMBER, different task. The asymmetry the key must survive. */
  const otherTaskSameEpoch = { taskId: "T-sweep-9-collate", epoch: EPOCH };

  test("a fresh tracker has seen no epoch at all", () => {
    expect(createEpochTracker().current()).toBeNull();
  });

  test("tool calls accumulate across the epoch", () => {
    const t = createEpochTracker();
    t.noteToolCall(twelve);
    t.noteToolCall(twelve);
    t.noteToolCall(twelve);
    expect(t.current()).toEqual({ ...emptyTally(twelve), toolCalls: 3 });
  });

  /**
   * The zero state has ONE definition, and this is what proves it.
   *
   * `emptyTally` is used by the tracker for a newly seen epoch and by the
   * `agent_end` handler for an epoch it observed nothing about — the
   * dispatched-and-did-nothing case. If those two drifted apart, a worker that
   * made no tool calls and a worker whose first tool call had just been counted
   * would be described by differently shaped records.
   */
  test("a newly tracked epoch is exactly the empty tally", () => {
    const t = createEpochTracker();
    t.noteToolCall(twelve);
    expect(t.current()).toEqual({ ...emptyTally(twelve), toolCalls: 1 });
    expect(emptyTally(twelve)).toEqual({
      taskId: TASK_ID,
      epoch: EPOCH,
      toolCalls: 0,
      delivered: false,
      nagged: false,
    });
  });

  test("a delivery marks the epoch, and a later tool call does not unmark it", () => {
    const t = createEpochTracker();
    t.noteDelivery(twelve);
    expect(t.current()?.delivered).toBe(true);
    t.noteToolCall(twelve);
    expect(t.current()).toEqual({ ...emptyTally(twelve), toolCalls: 1, delivered: true });
  });

  test("a delivery for an unseen epoch starts the tally rather than being dropped", () => {
    const t = createEpochTracker();
    t.noteDelivery(twelve);
    expect(t.current()).toEqual({ ...emptyTally(twelve), delivered: true });
  });

  /**
   * A new epoch inherits NOTHING — not the count, and above all not the
   * delivery. Carrying `delivered` forward would silence the very next epoch
   * that reported nothing, which is the failure this whole task exists to make
   * visible.
   */
  test("a new epoch starts fresh and inherits neither the count nor the delivery", () => {
    const t = createEpochTracker();
    t.noteToolCall(twelve);
    t.noteToolCall(twelve);
    t.noteDelivery(twelve);
    t.noteToolCall(thirteen);
    expect(t.current()).toEqual({ ...emptyTally(thirteen), toolCalls: 1 });
  });

  /** `noteNag` marks the epoch, and marks only `nagged`. */
  test("a nag marks the epoch without touching the count or the delivery", () => {
    const t = createEpochTracker();
    t.noteToolCall(twelve);
    t.noteNag(twelve);
    expect(t.current()).toEqual({ ...emptyTally(twelve), toolCalls: 1, nagged: true });
  });

  /**
   * **The nag budget is per epoch, not per worker lifetime**, and this is the
   * assertion that says so.
   *
   * The bound §6.3 sets — one nag — exists to stop a re-prompt LOOP inside one
   * allocation, where the `followUp` extends the turn and the next `agent_end`
   * would nag again. It is not a ration for the container's whole life: a worker
   * runs for weeks and serves many tasks, and a `nagged` that survived into the
   * next dispatch would spend an epoch's one chance on a task that had already
   * ended. The slot is replaced whenever `(task_id, epoch)` changes, so this
   * falls out of the same mechanism that resets the count.
   */
  test("a new epoch may be nagged again — the bound is per epoch, not per session", () => {
    const t = createEpochTracker();
    t.noteToolCall(twelve);
    t.noteNag(twelve);
    t.noteToolCall(thirteen);
    expect(t.current()?.nagged).toBe(false);
    expect(shouldNag(t.current()!)).toBe(true);
  });

  /** Same epoch NUMBER, different task: a nag on one is not a nag on the other. */
  test("a nag does not carry across to a different task at the same epoch number", () => {
    const t = createEpochTracker();
    t.noteToolCall(twelve);
    t.noteNag(twelve);
    t.noteToolCall(otherTaskSameEpoch);
    expect(t.current()).toEqual({ ...emptyTally(otherTaskSameEpoch), toolCalls: 1 });
  });

  test("a different task at the same epoch number is a different epoch", () => {
    const t = createEpochTracker();
    t.noteToolCall(twelve);
    t.noteDelivery(twelve);
    t.noteToolCall(otherTaskSameEpoch);
    expect(t.current()).toEqual({ ...emptyTally(otherTaskSameEpoch), toolCalls: 1 });
  });

  /**
   * `current()` hands out a copy.
   *
   * The tally is the thing that decides whether a worker is accused of
   * delivering nothing. A caller that could reach in and set `delivered` — or
   * `toolCalls` — would be editing the evidence, and the edit would be
   * invisible.
   */
  test("current() is a snapshot, so a reader cannot edit the tally", () => {
    const t = createEpochTracker();
    t.noteToolCall(twelve);
    const snapshot = t.current();
    expect(snapshot).not.toBeNull();
    (snapshot as EpochTally).delivered = true;
    (snapshot as EpochTally).toolCalls = 99;
    expect(t.current()).toEqual({ ...emptyTally(twelve), toolCalls: 1 });
  });
});

/**
 * `composeNoSubmitEntry` — §7.2's shape, on its own.
 *
 * `at` is a parameter for the reason `composeSubmitEntry`'s is: a value a test
 * cannot fix is a value a test can only match with a regex. Everything else
 * comes off the tally, and that is the design — there is no path from a
 * `SubmitReportParams` to this function, so no later edit can put a model's
 * prose in a session entry without first changing this signature. §6.5's fence
 * and `Docs/SRD.md` §12.6 are the same rule said twice.
 */
describe("composeNoSubmitEntry", () => {
  test("§7.2's seven fields, and no eighth", () => {
    const entry = composeNoSubmitEntry(
      { taskId: TASK_ID, epoch: EPOCH, toolCalls: 150, delivered: false, nagged: true },
      WORKER,
      "2026-09-07T23:44:19Z",
    );
    expect(entry).toEqual({
      schema: "pifleet.no_submit/v1",
      task_id: TASK_ID,
      epoch: EPOCH,
      worker: WORKER,
      tool_calls: 150,
      nagged: true,
      at: "2026-09-07T23:44:19Z",
    });
    expect(NO_SUBMIT_ENTRY_SCHEMA).toBe("pifleet.no_submit/v1");
  });

  /**
   * `nagged` is CARRIED, not written — and phase 4 is the proof it was worth
   * writing that way.
   *
   * Task 3.3 shipped this pair while nothing in the tree sent a nag, so both
   * arms were reachable only by hand. The point was that a `nagged: false`
   * hard-coded into the composer would have satisfied every wiring test that
   * existed and would have SURVIVED phase 4 wiring a real nag onto the tally
   * beside it — a green suite over an entry that could never say `true`. Task
   * 4.1 then added `noteNag` and one call site and changed this signature, this
   * entry shape and this test not at all, which is the prediction coming out.
   */
  test("nagged comes off the tally, so phase 4 changed no signature here", () => {
    const tally: EpochTally = {
      taskId: TASK_ID,
      epoch: EPOCH,
      toolCalls: 1,
      delivered: false,
      nagged: false,
    };
    expect(composeNoSubmitEntry(tally, WORKER, "2026-09-07T23:44:19Z").nagged).toBe(false);
    expect(composeNoSubmitEntry({ ...tally, nagged: true }, WORKER, "2026-09-07T23:44:19Z").nagged)
      .toBe(true);
  });

  /**
   * `delivered` is not a field, and it must not become one.
   *
   * The entry is only ever written when `delivered` is false, so a `delivered`
   * key would be a constant `false` on every record ever produced — a column
   * that says nothing, and an invitation for a later reader to branch on it as
   * if it varied.
   */
  test("the tally's delivered flag is a gate, not a field", () => {
    const entry = composeNoSubmitEntry(
      { taskId: TASK_ID, epoch: EPOCH, toolCalls: 0, delivered: false, nagged: false },
      WORKER,
      "2026-09-07T23:44:19Z",
    );
    expect(Object.keys(entry)).not.toContain("delivered");
  });
});

/**
 * Layer 4's other half (SRD §6.3, task 3.3) — `pifleet.no_submit/v1`.
 *
 * **What this entry is for, in one sentence:** an operator should be able to
 * tell the `gpt-oss-20b` that ran one `ls` and quit from the `gemma-4-26b` that
 * made 150 `kubectl` calls, without opening a transcript (§7.2). Those are
 * different failures with different fixes, and `tool_calls` is the only field
 * that separates them.
 *
 * **Where the count comes from, and where it deliberately does not.** It is
 * accumulated from `pi.on("tool_call")`, which fires once per call the model
 * MADE — before execution, so a refused or blocked call still counts, which is
 * right: 150 failing `kubectl` calls are 150 calls. The tempting alternative is
 * `AgentEndEvent.messages`, which is inside §7.6's already-declared surface and
 * is WRONG: that array is the whole session's retained transcript, spanning
 * every epoch this long-lived worker has served and shortened by compaction. It
 * would answer "how many tool calls are still in context", silently, and
 * nothing would ever notice.
 *
 * **Why it fires on a delivered turn too, and writes nothing.** SRD §11 Q3
 * measured `agent_end` firing 2-4ms after a terminating tool result, so the
 * handler runs on the happy path of every single delivery. Its silence there is
 * a property, not an absence of one, and it is asserted.
 *
 * **The count is cumulative across the epoch, and one entry is written per
 * `agent_end` that ends undelivered.** Not once per epoch: Q1 measured that a
 * phase-4 `sendUserMessage(followUp)` from `agent_end` EXTENDS the turn, so an
 * epoch that gets nagged ends more than once. An entry written only at the first
 * `agent_end` could never carry 150 — it would carry whatever the count was
 * before the nag, and the field would lose exactly the discrimination it exists
 * for. The last entry for an epoch is that epoch's final word.
 */
describe("layer 4 — the pifleet.no_submit/v1 session entry", () => {
  /** The entries one `agent_end` wrote under §7.2's customType. */
  function noSubmits(entries: RecordedEntry[]): Record<string, unknown>[] {
    return entries
      .filter((e) => e.customType === NO_SUBMIT_ENTRY_SCHEMA)
      .map((e) => e.data as Record<string, unknown>);
  }

  /**
   * **The acceptance criterion, quoted:** *"a fixture with three tool calls
   * asserting `tool_calls: 3`"* (§12, "The layers (D4)"; task 3.3).
   */
  test("three tool calls and no report produce one entry reading tool_calls: 3", () => {
    const f = fixture();
    const { entries, fire } = registered(f);
    fire("tool_call");
    fire("tool_call");
    fire("tool_call");
    fire("agent_end");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.customType).toBe("pifleet.no_submit/v1");
    expect(noSubmits(entries)[0]?.["tool_calls"]).toBe(3);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("§7.2's seven fields, from host state and a count", () => {
    const f = fixture();
    const { entries, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    const data = noSubmits(entries)[0] ?? {};
    expect(Object.keys(data).sort()).toEqual([
      "at",
      "epoch",
      "nagged",
      "schema",
      "task_id",
      "tool_calls",
      "worker",
    ]);
    expect(data["schema"]).toBe("pifleet.no_submit/v1");
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The identity is `/policy/task`'s and the session's, exactly as the
   * envelope's is. `TASK_ID`, `EPOCH` and `WORKER` share no substring, so an
   * implementation that read the worker off the task id cannot pass by
   * coincidence.
   */
  test("task_id and epoch come from /policy/task and worker from the session", () => {
    const f = fixture();
    const { entries, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    const data = noSubmits(entries)[0] ?? {};
    expect(data["task_id"]).toBe(TASK_ID);
    expect(data["epoch"]).toBe(EPOCH);
    expect(data["worker"]).toBe(WORKER);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **`nagged` MIRRORS the nag, and it mirrors the one this same `agent_end`
   * just sent — which is what pins the order of the two layers.**
   *
   * §6.3 asks for layer 3's bound to be *"mirrored through `pi.appendEntry`"*,
   * and the only mirror this file has is this field. Append first and mark
   * second and the mirror lags by one entry: harmless when the turn extends,
   * total when it does not, because there is then no second `agent_end` to carry
   * the truth and the nag leaves no trace anywhere. §11 Q1 says that case
   * arrives intermittently rather than never — a model slower than the four
   * measured has its delivery land after the settle.
   *
   * This test is the one that reddens if the `sendUserMessage` block is moved
   * below the `appendEntry`.
   */
  test("the entry mirrors the nag the same agent_end sent", () => {
    const f = fixture();
    const { entries, messages, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    expect(messages).toHaveLength(1);
    expect(noSubmits(entries)[0]?.["nagged"]).toBe(true);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **Defect 5's shapes, as the two fields actually read them — and the pair
   * this docblock used to name was wrong.**
   *
   * Task 3.3 left a note here predicting that task 4.2 would make the
   * `gpt-oss-20b` shape read `tool_calls: 1, nagged: false`. It does not, and
   * it should not. 4.2 suppresses the nag for a turn with NO tool call; one `ls`
   * is one tool call, so that worker is nagged and its entry reads
   * `tool_calls: 1, nagged: true`. The prediction confused "did almost nothing"
   * with "did nothing", and §6.3's rule is the second: *"this epoch has seen at
   * least one tool call"*. A worker that held a live task and ran one `ls` is
   * defect 5's exact shape — the case layer 3 exists for — not a worker with
   * nothing to report.
   *
   * So the discrimination §7.2 built `tool_calls` for is unchanged and `nagged`
   * adds a second axis to it. Three shapes, all asserted below:
   *
   * | shape | `tool_calls` | `nagged` |
   * |---|---|---|
   * | dispatched, made no move at all | 0 | false — 4.2 suppressed it |
   * | ran one `ls` and quit (`gpt-oss-20b`) | 1 | true |
   * | 150 `kubectl` calls, no report (`gemma-4-26b`) | 150 | true |
   *
   * The first row is the one that carries 4.2: an entry still exists, because
   * layer 4 is unconditional, and only the courtesy was withheld.
   */
  test("defect 5's shapes read as tool_calls 0/false, 1/true and many/true", () => {
    const silent = fixture();
    const a = registered(silent);
    a.fire("agent_end");
    expect(noSubmits(a.entries)[0]).toMatchObject({ tool_calls: 0, nagged: false });
    expect(a.messages).toEqual([]);
    rmSync(silent.dir, { recursive: true, force: true });

    const oneCall = fixture();
    const b = registered(oneCall);
    b.fire("tool_call");
    b.fire("agent_end");
    expect(noSubmits(b.entries)[0]).toMatchObject({ tool_calls: 1, nagged: true });
    rmSync(oneCall.dir, { recursive: true, force: true });

    const busy = fixture();
    const c = registered(busy);
    for (let i = 0; i < 150; i += 1) c.fire("tool_call");
    c.fire("agent_end");
    expect(noSubmits(c.entries)[0]).toMatchObject({ tool_calls: 150, nagged: true });
    rmSync(busy.dir, { recursive: true, force: true });
  });

  test("at is an ISO8601 Z stamp", () => {
    const f = fixture();
    const before = Date.now();
    const { entries, fire } = registered(f);
    fire("agent_end");
    const at = noSubmits(entries)[0]?.["at"];
    expect(typeof at).toBe("string");
    expect(at as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(Date.parse(at as string)).toBeGreaterThanOrEqual(before - 1000);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A worker that was dispatched and did LITERALLY NOTHING.
   *
   * This is the most severe shape defect 5 has and the one an operator is least
   * likely to guess at, so it gets a record rather than silence: `tool_calls: 0`
   * says the model was handed a live task and made no move at all. It is also
   * the case with no tracker entry — nothing was ever counted — which is why the
   * handler reads `/policy/task` for the epoch rather than relying on having
   * seen one.
   */
  test("a dispatched worker that made no tool calls is reported with tool_calls: 0", () => {
    const f = fixture();
    const { entries, fire } = registered(f);
    fire("agent_end");
    expect(noSubmits(entries)).toHaveLength(1);
    expect(noSubmits(entries)[0]?.["tool_calls"]).toBe(0);
    expect(noSubmits(entries)[0]?.["task_id"]).toBe(TASK_ID);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **An idle worker is nobody's problem** — §6.3's third constraint.
   *
   * `supervisor/index.ts:1075` resets `/policy/task` to `<none>` at settle,
   * with its own comment saying anything the worker runs between settle and the
   * next dispatch *"belongs to NO task"*. There is no task id and no epoch to
   * put in an entry, so §7.2's shape cannot be composed and none is — the shape
   * forces the answer here rather than a policy choosing it.
   */
  test("an idle worker between dispatches is left alone", () => {
    const idle = fixture(`${TASK_POLICY_NONE}\n0\n`);
    const { entries, fire } = registered(idle);
    fire("tool_call");
    fire("agent_end");
    expect(entries).toEqual([]);
    rmSync(idle.dir, { recursive: true, force: true });
  });

  test("an unmounted policy file produces no entry and no throw", () => {
    const unmounted = fixture(null);
    const { entries, fire } = registered(unmounted);
    expect(() => fire("tool_call")).not.toThrow();
    expect(() => fire("agent_end")).not.toThrow();
    expect(entries).toEqual([]);
    rmSync(unmounted.dir, { recursive: true, force: true });
  });

  /**
   * The delivered path, which §11 Q3 measured runs on every successful call.
   *
   * `agent_end` fires 2-4ms after `submit_report`'s terminating result, so this
   * handler executes on the happy path of every delivery in the fleet. Writing
   * a `no_submit` there would accuse every worker that did its job.
   */
  test("a delivered epoch writes no no_submit entry", async () => {
    const f = fixture();
    const { tool, entries, ctx, fire } = registered(f);
    await tool.execute("call-1", minimal, undefined, undefined, ctx);
    fire("agent_end");
    expect(entries.map((e) => e.customType)).toEqual([SUBMIT_ENTRY_SCHEMA]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **THE ONE THAT MATTERS: a delivery whose session write failed is still a
   * delivery.**
   *
   * `execute` swallows a throwing `appendEntry` on purpose — *"a diagnostic
   * write may not un-deliver a report that landed"* — so **a failed session
   * write produces a delivered report with NO `pifleet.submit/v1` entry**. Any
   * implementation that decided "nothing was delivered" from the absence of that
   * entry would, in exactly this situation, file `pifleet.no_submit/v1` against
   * a worker whose `result.json` is sitting on disk, complete and correct. That
   * is a false accusation, and it is worse than no record at all.
   *
   * So the flag is set in memory by `submit_report` itself, BEFORE the entry is
   * attempted, and this test is the only thing that reddens if it is moved
   * after — or inside — the `try`. The stub throws only for the submit entry, so
   * a `no_submit` composed in error would still be recorded and visible; a stub
   * that threw on everything could not tell a wrong entry from an unwritable
   * one.
   */
  test("a delivery whose session write failed is still a delivery", async () => {
    const f = fixture();
    const entries: RecordedEntry[] = [];
    const { tool, ctx, fire } = registered(f, (customType, data) => {
      if (customType === SUBMIT_ENTRY_SCHEMA) throw new Error("session store is gone");
      entries.push({ customType, data });
    });
    const result = await tool.execute(
      "call-1",
      { status: "partial", summary: "SESSION-STORE-GONE" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.terminate).toBe(true);
    // The report really did land, which is what makes an accusation false.
    const env = JSON.parse(readFileSync(join(f.taskDir, "result.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(env["summary"]).toBe("SESSION-STORE-GONE");
    fire("agent_end");
    expect(entries).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A REFUSED `submit_report` is not a delivery, and its call still counts.
   *
   * The model tried and got a validation error back; nothing reached the
   * outbox. `tool_call` fires before `execute`, so the attempt is counted —
   * which is the honest number, and which is what stops a worker that spent its
   * turn arguing with the schema from looking like a worker that sat still.
   */
  test("a refused submit_report leaves the epoch undelivered and counts the attempt", async () => {
    const f = fixture();
    const { tool, entries, ctx, fire } = registered(f);
    fire("tool_call");
    await expect(
      tool.execute(
        "call-1",
        { ...minimal, artifacts: [{ kind: "file", path: "/etc/passwd" }] },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/outside/);
    fire("agent_end");
    expect(noSubmits(entries)).toHaveLength(1);
    expect(noSubmits(entries)[0]?.["tool_calls"]).toBe(1);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The count is the EPOCH's, not the agent loop's, and the second entry is the
   * one that proves it.
   *
   * This is the shape phase 4 creates: `agent_end` fires, a nag extends the
   * turn (Q1 — a `followUp` lands as a `queue_update`), the model does more
   * work, and `agent_end` fires again. If the count reset between loops the
   * second entry would read 2 instead of 5, and `tool_calls` would be a
   * per-loop number wearing an epoch's name — which is the field's whole job
   * lost quietly.
   */
  test("a second agent_end in one epoch carries the epoch's cumulative count", () => {
    const f = fixture();
    const { entries, fire } = registered(f);
    fire("tool_call");
    fire("tool_call");
    fire("tool_call");
    fire("agent_end");
    fire("tool_call");
    fire("tool_call");
    fire("agent_end");
    expect(noSubmits(entries).map((d) => d["tool_calls"])).toEqual([3, 5]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A stale tally must not silence the epoch that is actually live.
   *
   * The tracker holds ONE slot. After a delivered epoch settles and a new task
   * is dispatched, that slot still says "delivered" about the OLD epoch. An
   * `agent_end` that trusted the slot without checking it names the live task
   * would return early and the new epoch's silence would go unrecorded — which
   * is precisely the failure this task exists to make visible, reintroduced by
   * the mechanism meant to prevent it.
   *
   * So the live task decides WHICH epoch the entry names, and the tally is used
   * only when it is about that same epoch.
   */
  test("a delivered previous epoch does not silence the epoch now live", async () => {
    const f = fixture();
    const { tool, entries, ctx, fire } = registered(f);
    await tool.execute("call-1", minimal, undefined, undefined, ctx);
    // The supervisor's next dispatch: `/policy/task` is rewritten in place.
    writeFileSync(f.roots.policyPath, `${TASK_ID}\n${EPOCH + 1}\n`);
    fire("agent_end");
    expect(noSubmits(entries)).toHaveLength(1);
    expect(noSubmits(entries)[0]?.["epoch"]).toBe(EPOCH + 1);
    expect(noSubmits(entries)[0]?.["tool_calls"]).toBe(0);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A tool call belongs to the epoch that was live WHEN IT WAS MADE.
   *
   * `/policy/task` is rewritten in place at every dispatch and nothing
   * coordinates that with a call in flight (`task-policy.ts:33-41`), which is
   * the same hazard `SubmitOutcome` carries its own `taskId`/`epoch` out to
   * avoid. Counting against a freshly read policy on each call is what keeps
   * epoch 13's entry from inheriting epoch 12's work.
   */
  test("tool calls made under the previous epoch are not counted against the new one", () => {
    const f = fixture();
    const { entries, fire } = registered(f);
    fire("tool_call");
    fire("tool_call");
    writeFileSync(f.roots.policyPath, `${TASK_ID}\n${EPOCH + 1}\n`);
    fire("tool_call");
    fire("agent_end");
    expect(noSubmits(entries)[0]?.["epoch"]).toBe(EPOCH + 1);
    expect(noSubmits(entries)[0]?.["tool_calls"]).toBe(1);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

/**
 * `shouldNag` on its own — three clauses, three ways layer 3 becomes a nuisance.
 *
 * Pure and total, so each clause reddens without a filesystem or an event in the
 * way. The fixtures below differ from the base tally in exactly ONE field each,
 * which is what makes a deleted clause show up as a named failure rather than as
 * a count that moved.
 */
describe("shouldNag — layer 3's four suppressions", () => {
  const worked: EpochTally = {
    taskId: TASK_ID,
    epoch: EPOCH,
    toolCalls: 4,
    delivered: false,
    nagged: false,
  };

  test("an epoch with work done and no report is nagged", () => {
    expect(shouldNag(worked)).toBe(true);
  });

  /** §11 Q3: `agent_end` fires 2-4ms after a terminating result, so this is every delivery. */
  test("a delivered epoch is not nagged", () => {
    expect(shouldNag({ ...worked, delivered: true })).toBe(false);
  });

  /**
   * ISC-1107. `delivered` is set by `submit_report` itself, so it cannot see a
   * report filed the OTHER way — and during Phase A both routes are open and
   * legitimate. Measured live 2026-09-08: `col-1` wrote its fan-out and
   * `result.json` with `write`, ended cleanly, and was nagged for a report it
   * had already filed. This is the false accusation the `EpochTally` docblock
   * already warned about — *"a worker whose `result.json` is on disk, complete
   * and correct"* — reached through the nag rather than through the entry.
   */
  test("an epoch whose envelope is already on disk is not nagged", () => {
    expect(shouldNag(worked, true)).toBe(false);
  });

  /** The default must stay false, or every caller silently suppresses the nag. */
  test("the envelope clause defaults to absent", () => {
    expect(shouldNag(worked)).toBe(true);
  });

  /** §6.3: *"One nag, not a loop."* The `followUp` extends the turn, so a second is a third. */
  test("an already-nagged epoch is not nagged again", () => {
    expect(shouldNag({ ...worked, nagged: true })).toBe(false);
  });

  /**
   * SRD task 4.2. *"An idle worker between dispatches must be left alone, and so
   * must a worker whose brief was a question."* Zero is the bar and it is the
   * only value below it.
   */
  test("a zero-tool-call turn is not nagged", () => {
    expect(shouldNag({ ...worked, toolCalls: 0 })).toBe(false);
  });

  /**
   * ONE call is over the bar, and this is the boundary the suppression is most
   * likely to be widened past by someone reading `gpt-oss-20b ran one ls and
   * quit` as "nothing to report". It is the opposite: a worker holding a live
   * task that ran one `ls` and produced no envelope is defect 5, which is what
   * layer 3 exists for. A `> 1` here would silence the case.
   */
  test("one tool call is enough — the bar is a call, not a productive one", () => {
    expect(shouldNag({ ...worked, toolCalls: 1 })).toBe(true);
  });
});

/**
 * Layer 3 (SRD §6.3, tasks 4.1 and 4.2) — the bounded nag.
 *
 * **What it is.** On `agent_end`, an epoch with a live task, no delivery and at
 * least one tool call gets ONE `pi.sendUserMessage` carrying a constant string
 * that names the omission and the tool. Not a veto — §2.3 measured that none
 * exists — and not authority: §6.5 puts layer 3 among the courtesies, and *"the
 * number the loop branches on is the one the host counted"* is untouched by it.
 *
 * **What §11 Q1 measured, because it is why the layer shipped and why the string
 * looks like it does.** `sendUserMessage(text, {deliverAs: "followUp"})` from
 * `agent_end` lands as a `queue_update` and Pi runs a further agent cycle; all
 * four models in `fleet.yaml` called the tool the nag asked for. But the
 * supervisor settled 0.18s (glm), 0.40s (deepseek), 0.84s (gemma) and 1.05s
 * (qwen) after the model acted. **The runway is about a second**, so `NAG_TEXT`
 * tells the model which tool and which two arguments and asks it to work nothing
 * out. A model slower than those four loses the race — which is why the layer is
 * built so that losing it costs nothing: the `pifleet.no_submit/v1` entry is
 * written either way, and §6.3 says so in as many words (*"Layer 3 should
 * therefore be built to make non-delivery a FACT rather than to rely on the nag
 * winning"*).
 *
 * **The bound is per `(task_id, epoch)` and it is held in memory.** §6.3 asks
 * for it to be *"mirrored through `pi.appendEntry`"*, and the mirror is
 * `nagged` on the entry — durable, host-readable, and written by the same
 * handler run that sent the nag. It is NOT a way to restore the bound after a
 * `/reload`: the declared surface (§7.6) cannot read a session entry back. See
 * the extension's header.
 */
describe("layer 3 — the bounded nag", () => {
  /** The `pifleet.no_submit/v1` entries, as the layer-4 block reads them. */
  function noSubmits(entries: RecordedEntry[]): Record<string, unknown>[] {
    return entries
      .filter((e) => e.customType === NO_SUBMIT_ENTRY_SCHEMA)
      .map((e) => e.data as Record<string, unknown>);
  }

  /**
   * **The acceptance criterion of task 4.1, quoted:** *"two `agent_end` events,
   * one message"*.
   *
   * The second `agent_end` is not hypothetical — it is what Q1 measured the
   * first nag CAUSING, since the `followUp` extends the turn. So the unbounded
   * version of this layer is not a no-op that fires twice, it is a loop that
   * runs until the token ceiling ends the run on exit 5
   * (`Docs/SRD-TRIAGE-CONSOLE.md` Finding C). The tool calls between the two
   * ends are there so `shouldNag`'s count clause cannot be the thing suppressing
   * the second message.
   */
  test("two agent_end events in one epoch send exactly one message", () => {
    const f = fixture();
    const { messages, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    fire("tool_call");
    fire("tool_call");
    fire("agent_end");
    expect(messages).toHaveLength(1);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The message is `NAG_TEXT` and the options are Q1's measured spelling.
   *
   * `deliverAs: "followUp"` is asserted rather than left to a default because
   * the measurement is of that spelling: a `followUp` from `agent_end` became a
   * `queue_update` and a further agent cycle. Nothing in §11 says an omitted
   * `options` does the same, so dropping the argument as noise would be dropping
   * the half of the call that was run in the real image.
   */
  /**
   * ISC-1107 — THE WIRING, and it is the probe that matters here.
   *
   * `shouldNag`'s new clause is pure and its unit test passes whether or not
   * anything calls it with a real answer. This drives the actual `agent_end`
   * handler against a real directory: a `result.json` on disk, put there by the
   * `write` route rather than by this extension, and the nag must not be sent.
   * Delete the argument at the call site and this reddens while every clause
   * test above stays green.
   */
  test("no nag is sent when the write route already filed result.json", () => {
    const f = fixture();
    mkdirSync(f.taskDir, { recursive: true });
    writeFileSync(
      join(f.taskDir, "result.json"),
      JSON.stringify({ schema: "pifleet.result/v1", task_id: TASK_ID, status: "success" }),
    );
    const { messages, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    expect(messages).toHaveLength(0);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /** The same fixture WITHOUT the envelope still nags — or the probe above proves nothing. */
  test("the same turn with no envelope on disk is still nagged", () => {
    const f = fixture();
    const { messages, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    expect(messages).toHaveLength(1);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("the message is the constant, delivered as a followUp", () => {
    const f = fixture();
    const { messages, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    expect(messages[0]?.content).toBe(NAG_TEXT);
    expect(messages[0]?.options).toEqual({ deliverAs: "followUp" });
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **The other half of task 4.1's acceptance:** *"the string is identical
   * across differing transcripts"*.
   *
   * The two runs differ in everything a template could reach: a different task
   * id, a different epoch, a different number of tool calls, different
   * `tool_call` payloads and a different `agent_end` transcript. If the nag
   * interpolated ANY of them the two strings would differ, and the comparison —
   * not the `toBe(NAG_TEXT)` beside it — is what reddens. `Docs/SRD.md` §12.6 is
   * the rule: worker prose is data, and feeding a model its own words back
   * through a host channel is what `5dbdafe` was fixing.
   *
   * `task_id` and `epoch` would be LEGAL under §12.6 — they are host state — and
   * are still absent, because the tool the nag asks for reads both out of
   * `/policy/task` itself (§6.4). Putting them in the prompt would hand back the
   * exact two numbers the whole design exists to stop a model copying.
   */
  test("the string is identical across differing transcripts", () => {
    const first = fixture();
    const a = registered(first);
    a.fire("tool_call", { type: "tool_call", toolName: "read", toolCallId: "c1", input: {} });
    a.fire("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", content: "I reviewed the auth module and found three issues." }],
    });

    const second = fixture("T-review-99-lang\n7\n");
    const b = registered(second);
    for (let i = 0; i < 6; i += 1) {
      b.fire("tool_call", { type: "tool_call", toolName: "grep", toolCallId: `c${i}`, input: {} });
    }
    b.fire("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", content: "kubectl returned 47 pods; nothing further." }],
    });

    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(1);
    expect(a.messages[0]?.content).toBe(b.messages[0]?.content);
    expect(a.messages[0]?.content).toBe(NAG_TEXT);
    rmSync(first.dir, { recursive: true, force: true });
    rmSync(second.dir, { recursive: true, force: true });
  });

  /**
   * The text names the omission and the tool — §6.3's requirement of it — and
   * nothing else it could name.
   *
   * The negative half is the fence: no task id, no epoch, and no worker id, so
   * this string cannot become a template later without failing here first.
   */
  test("the text names the tool and carries no dispatch state", () => {
    expect(NAG_TEXT).toContain("submit_report");
    expect(NAG_TEXT).not.toContain(TASK_ID);
    expect(NAG_TEXT).not.toContain(WORKER);
    expect(NAG_TEXT).not.toContain(String(EPOCH));
  });

  /**
   * **Task 4.2's acceptance, quoted:** *"`/policy/task` reading `<none>`
   * produces no nag."*
   *
   * `supervisor/index.ts:1075` resets the policy at settle, with its own comment
   * saying work between settle and the next dispatch *"belongs to NO task"*.
   * There is nothing to report and nobody to report it to, so §6.3's *"an idle
   * worker between dispatches must be left alone"* is met by the handler
   * returning before layer 3 is reached — which is also why no entry appears.
   */
  test("an idle worker reading <none> is not nagged", () => {
    const idle = fixture(`${TASK_POLICY_NONE}\n0\n`);
    const { entries, messages, fire } = registered(idle);
    fire("tool_call");
    fire("agent_end");
    expect(messages).toEqual([]);
    expect(entries).toEqual([]);
    rmSync(idle.dir, { recursive: true, force: true });
  });

  /**
   * **Task 4.2's other half: a zero-tool-call turn is not nagged — but it is
   * still RECORDED.**
   *
   * The two layers part company here and the pair of assertions is the point.
   * Layer 3 is a courtesy and is withheld: a worker that made no move may have
   * been asked a question, and §6.3 says such a worker must be left alone. Layer
   * 4 is evidence and is unconditional: a dispatched worker that did literally
   * nothing is defect 5's most severe shape, and `tool_calls: 0` is exactly the
   * fact an operator needs. Suppressing the entry alongside the nag would delete
   * the record of the worst case in the name of politeness.
   */
  test("a zero-tool-call turn is not nagged, and is still recorded", () => {
    const f = fixture();
    const { entries, messages, fire } = registered(f);
    fire("agent_end");
    expect(messages).toEqual([]);
    expect(noSubmits(entries)).toHaveLength(1);
    expect(noSubmits(entries)[0]?.["tool_calls"]).toBe(0);
    expect(noSubmits(entries)[0]?.["nagged"]).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("an unmounted policy file produces no nag and no throw", () => {
    const unmounted = fixture(null);
    const { messages, fire } = registered(unmounted);
    fire("tool_call");
    expect(() => fire("agent_end")).not.toThrow();
    expect(messages).toEqual([]);
    rmSync(unmounted.dir, { recursive: true, force: true });
  });

  /**
   * A delivered epoch is not nagged, and this runs on the happy path of every
   * delivery in the fleet — §11 Q3 measured `agent_end` firing 2-4ms after
   * `submit_report`'s terminating result. A nag here would tell a worker that
   * had just done its job to do it again, one second before the settle.
   */
  test("a delivered epoch is not nagged", async () => {
    const f = fixture();
    const { tool, ctx, messages, fire } = registered(f);
    fire("tool_call");
    await tool.execute("call-1", minimal, undefined, undefined, ctx);
    fire("agent_end");
    expect(messages).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The bound is per epoch, driven end-to-end rather than through the tracker.
   *
   * The tracker test beside `noteNag` pins the same rule at the unit; this one
   * pins the wiring, because the handler reads `/policy/task` for the epoch and
   * a handler that consulted a session-lifetime flag instead would pass the unit
   * test and fail here.
   */
  test("the next epoch gets its own nag", () => {
    const f = fixture();
    const { messages, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    writeFileSync(f.roots.policyPath, `${TASK_ID}\n${EPOCH + 1}\n`);
    fire("tool_call");
    fire("agent_end");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe(messages[1]?.content);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **A courtesy that fails may not take the evidence with it** — §6.5's fence,
   * as one test.
   *
   * Layer 3 is a courtesy and layer 4 is evidence. If `sendUserMessage` shared
   * the handler's outer `catch`, a throw would skip the `appendEntry` below it
   * and the record of an epoch that reported nothing would be lost — the layer
   * with no authority silencing the layer whose whole job is to be read. So the
   * send has its own `try`, and this test is the only thing that reddens if it
   * is removed as noise.
   *
   * `nagged` reads FALSE, and that is the second half. `noteNag` sits after the
   * call inside that `try`, so a send that threw delivered no message and claims
   * none. An implementation that marked the epoch first would put `nagged: true`
   * in the session for a nag the model never received — a lie in the one record
   * an operator has.
   */
  test("a nag that throws loses neither the entry nor the truth about itself", () => {
    const f = fixture();
    const { entries, fire } = registered(f, undefined, () => {
      throw new Error("no session to steer");
    });
    fire("tool_call");
    expect(() => fire("agent_end")).not.toThrow();
    expect(noSubmits(entries)).toHaveLength(1);
    expect(noSubmits(entries)[0]?.["tool_calls"]).toBe(1);
    expect(noSubmits(entries)[0]?.["nagged"]).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **What a WORKING nag leaves in the session, and the reason the extension's
   * header had to change tense.**
   *
   * Q1's best outcome in full: the nag extends the turn, the model delivers, and
   * the epoch ends a second time. The session then holds a
   * `pifleet.no_submit/v1` carrying `nagged: true` FOLLOWED BY a
   * `pifleet.submit/v1` for the same `(task_id, epoch)`. A host that read
   * no_submit entries alone would call that epoch undelivered — and it is the
   * opposite, it is layer 3 working.
   *
   * So *"a no_submit entry means nothing was delivered"* became *"nothing HAD
   * been delivered when that `agent_end` fired"*, and the entries for one epoch
   * are read in order with a submit settling it. Nothing here is a host-side
   * guard; §6.5 property 3 keeps both entries diagnostic, and this test asserts
   * the SEQUENCE so that whoever writes the reader can see what they must read.
   */
  test("a nag answered by a delivery leaves a no_submit and then a submit", async () => {
    const f = fixture();
    const { tool, entries, ctx, messages, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    expect(messages).toHaveLength(1);
    await tool.execute("call-1", minimal, undefined, undefined, ctx);
    fire("agent_end");
    expect(entries.map((e) => e.customType)).toEqual([
      NO_SUBMIT_ENTRY_SCHEMA,
      SUBMIT_ENTRY_SCHEMA,
    ]);
    expect((entries[0]?.data as Record<string, unknown>)["nagged"]).toBe(true);
    expect((entries[1]?.data as Record<string, unknown>)["epoch"]).toBe(EPOCH);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * Layer 3 writes nothing to the outbox, which is §6.5 property 1 restated
   * where it can fail: the nag is a message to the model, and the only thing
   * that ever creates a file is `submit_report`.
   */
  test("a nag writes nothing to the outbox", () => {
    const f = fixture();
    const { messages, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    expect(messages).toHaveLength(1);
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

/**
 * The counter must never be the reason a tool did not run.
 *
 * **Measured in `pifleet/pi-worker:0.79.6-base-b722edcf4699`, 2026-09-08**, and
 * this is not the same as the `agent_end` case:
 *
 * - `dist/core/extensions/runner.js:639-657` — `emitToolCall` has **no
 *   `try/catch`**, unlike the general `emit` at `:522-551` which catches per
 *   handler and routes to `emitError`.
 * - `dist/core/agent-session.js:184-197` — the caller catches and **RE-THROWS**,
 *   with the message *"Extension failed, blocking execution"*.
 *
 * So a `tool_call` handler that throws BLOCKS THE TOOL. A diagnostic counter
 * that could stop a worker from running `read` is a worse bug than every failure
 * it exists to describe, and the two assertions below are the whole of the
 * defence: it returns nothing, and it does not throw when the mount it reads is
 * not there. `ToolCallEventResult.block` (`types.d.ts:739-743`) is the other
 * door into the same failure — `emitToolCall` returns early on any truthy
 * result carrying `block` — which is why "returns undefined" is asserted rather
 * than assumed.
 */
describe("the tool-call counter never blocks a tool", () => {
  test("the handler returns undefined, so no result can carry block", () => {
    const f = fixture();
    const { fire } = registered(f);
    expect(fire("tool_call")).toBeUndefined();
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("an unreadable policy mount does not throw out of the handler", () => {
    const unmounted = fixture(null);
    const { fire } = registered(unmounted);
    expect(() => fire("tool_call")).not.toThrow();
    rmSync(unmounted.dir, { recursive: true, force: true });
  });

  /**
   * A malformed policy is not an error either — `parseTaskPolicy` returns null
   * for all four of its cases, and null means "no epoch to count this against",
   * not "fail".
   */
  test("a malformed policy file is counted against nothing, quietly", () => {
    const malformed = fixture("../other-worker\nlater\n");
    const { entries, fire } = registered(malformed);
    expect(() => fire("tool_call")).not.toThrow();
    fire("agent_end");
    expect(entries).toEqual([]);
    rmSync(malformed.dir, { recursive: true, force: true });
  });

  /**
   * And the same courtesy at `agent_end`, for a different reason.
   *
   * `emit` (`runner.js:530-548`) already catches a throwing handler, so this
   * wrapper is not what keeps the agent loop alive — Pi does that. What it stops
   * is `emitError`, which would surface an extension error to the operator about
   * a purely diagnostic write. A record that nothing was delivered is not worth
   * an error banner; the missing record is its own evidence.
   */
  test("an agent_end whose appendEntry throws does not escape the handler", () => {
    const f = fixture();
    const { fire } = registered(f, () => {
      throw new Error("session store is gone");
    });
    expect(() => fire("agent_end")).not.toThrow();
    rmSync(f.dir, { recursive: true, force: true });
  });
});

/**
 * `get_replies` — the DECLARED set (SRD §6.2.2, §7.4, D6, task 5.4).
 *
 * ## The one criterion this block exists for
 *
 * §13's task 5.4 names it: *"three files in `/replies`, one declared, one
 * returned"*. Every other test here is a way that criterion could be satisfied
 * by an implementation that was nonetheless wrong, so each is written against a
 * fixture where the wrong implementation and the right one give different
 * answers.
 *
 * **The plane is deliberately over-populated in the criterion's own fixture.**
 * Three replies are published and one is declared, because a `readdir` returns
 * three and the declaration returns one and there is no other way to tell those
 * two implementations apart. Finding E is not a hypothesis about a future
 * console — the triage console is one long-lived RUN publishing into one
 * directory every sweep, so sweep 5's `/replies` really does hold sweeps 1
 * through 5, and every one of those files really does read like a good answer to
 * the question the collator was just asked.
 *
 * ## Why the honest path is built with the host's own renderer
 *
 * See the import block. `renderRepliesPolicy` writes these fixtures wherever the
 * host could write them, so what is asserted is that the two ends of
 * `pifleet.replies/v1` agree — not that this file parses bytes I typed while
 * looking at the writer. `declareRaw` exists only for documents the writer
 * cannot produce: a wrong schema tag, a malformed entry, a declaration whose
 * task id disagrees with `/policy/task`.
 *
 * ## The refusals are refusals, and that matters
 *
 * `docs/extensions.md`: *"To mark a tool execution as failed … throw an error
 * from `execute`. Returning a value never sets the error flag."* A `get_replies`
 * that RETURNED "nothing was declared" as a text block would be a tool the model
 * reads as having succeeded, and §11 Q4 measured what a thrown error actually
 * costs — every model in `fleet.yaml` retried once and none looped. So the empty
 * set throws, and the assertions below are `toThrow` rather than comparisons
 * against a returned message.
 */
describe("get_replies — the declared set, never a listing", () => {
  /** A reply payload naming its own child, so a mix-up is visible rather than plausible. */
  const payload = (child: DeclaredReply): string =>
    JSON.stringify({
      schema: RESULT_SCHEMA,
      task_id: child.task_id,
      worker: child.worker,
      summary: `${child.aspect.toUpperCase()}-PAYLOAD`,
    });

  /**
   * **The acceptance criterion for task 5.4.**
   *
   * Three files on the plane, one of them declared, exactly that one returned.
   * The two undeclared payloads are asserted absent from the WHOLE outcome and
   * not merely from the text, because `details.replies[]` is a second channel to
   * the model and a `readdir` feeding only that half would pass a content-only
   * assertion.
   */
  test("three files on the plane, one declared, one returned", () => {
    const f = fixture();
    publish(f, CHILD_A, payload(CHILD_A));
    publish(f, CHILD_B, payload(CHILD_B));
    publish(f, CHILD_UNDECLARED, payload(CHILD_UNDECLARED));
    declareSet(f, TASK_ID, [CHILD_A]);

    const out = getReplies(f.mounts);

    expect(out.blocks).toHaveLength(1);
    expect(out.readouts).toEqual([
      {
        task_id: CHILD_A.task_id,
        worker: CHILD_A.worker,
        aspect: CHILD_A.aspect,
        bytes: Buffer.byteLength(payload(CHILD_A), "utf8"),
        ok: true,
      },
    ]);
    expect(out.missing).toEqual([]);
    expect(out.blocks[0]).toContain("KAFKA-PAYLOAD");

    // Neither undeclared reply reaches the model through either channel.
    const everything = JSON.stringify(out);
    expect(everything).not.toContain("POSTGRES-PAYLOAD");
    expect(everything).not.toContain("REDIS-PAYLOAD");
    expect(everything).not.toContain(CHILD_B.task_id);
    expect(everything).not.toContain(CHILD_UNDECLARED.task_id);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The other half of the same criterion: a declaration naming two replies gets
   * both, in the declaration's order.
   *
   * Without this, "one declared, one returned" is satisfied by an implementation
   * that returns the FIRST declared reply and stops — which reads identically in
   * a one-entry fixture and loses a slice in production.
   */
  test("every declared reply is returned, in the declaration's order", () => {
    const f = fixture();
    publish(f, CHILD_A, payload(CHILD_A));
    publish(f, CHILD_B, payload(CHILD_B));
    declareSet(f, TASK_ID, [CHILD_B, CHILD_A]);

    const out = getReplies(f.mounts);
    expect(out.readouts.map((r) => r.task_id)).toEqual([CHILD_B.task_id, CHILD_A.task_id]);
    expect(out.blocks[0]).toContain("POSTGRES-PAYLOAD");
    expect(out.blocks[1]).toContain("KAFKA-PAYLOAD");
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * An EMPTY declared array is a value, and refusing on it reports that value
   * rather than losing it (§7.4).
   *
   * The fixture publishes a reply anyway, and that is the whole discrimination:
   * a turn-one collator whose `/replies` already holds the PREVIOUS sweep's
   * files must be told nothing was declared, and an implementation that fell
   * back to the directory when the array was empty would return that stale file
   * and read as helpful.
   */
  test("an empty declaration refuses, even with files on the plane", () => {
    const f = fixture();
    publish(f, CHILD_UNDECLARED, payload(CHILD_UNDECLARED));
    declareSet(f, TASK_ID, []);

    expect(() => getReplies(f.mounts)).toThrow(SubmitRefusal);
    expect(() => getReplies(f.mounts)).toThrow(reOf(NO_REPLIES_DECLARED));
    // And the message tells the model not to go looking, which is what
    // `roles/triage.md` spends six lines on today.
    expect(() => getReplies(f.mounts)).toThrow(/do not go looking/);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * An ABSENT `/policy/replies` and an EMPTY one share a sentence and differ in
   * their clause.
   *
   * They are one fact to the model — nothing was declared — and two different
   * problems to an operator: an empty set is a turn-one dispatch and nobody's
   * fault, while an unreadable mount is a host that did not write the file. The
   * shared prefix is asserted so the model's half cannot drift; the differing
   * clause is asserted so the operator's half cannot be collapsed into it.
   */
  test("an absent declaration refuses with the same sentence and a different clause", () => {
    const f = fixture();
    expect(existsSync(f.repliesPolicyPath)).toBe(false);
    expect(() => getReplies(f.mounts)).toThrow(reOf(NO_REPLIES_DECLARED));
    expect(() => getReplies(f.mounts)).toThrow(/could not be read/);
    expect(() => getReplies(f.mounts)).not.toThrow(/do not go looking/);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The schema tag is checked before a byte of the document is believed.
   *
   * The reader is baked into an image pinned by tag and the writer is on the
   * host: the two are updated on different clocks, so a `pifleet.replies/v2`
   * whose entries happen to still parse has to be a refusal rather than a
   * misparse. The fixture is otherwise a perfectly good declaration, so nothing
   * but the tag can be what refuses it.
   */
  test("a document that is not pifleet.replies/v1 is refused, not parsed", () => {
    const f = fixture();
    publish(f, CHILD_A, payload(CHILD_A));
    declareRaw(
      f,
      JSON.stringify({
        schema: "pifleet.replies/v2",
        task_id: TASK_ID,
        replies: [{ ...CHILD_A, path: replyMountPath(CHILD_A.task_id) }],
      }),
    );
    expect(() => getReplies(f.mounts)).toThrow(NOT_A_DECLARATION);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * Failure mode 9.6 — *"Finding E arriving through the front door"*.
   *
   * A dispatch that rewrote `/policy/task` and not `/policy/replies` leaves a
   * declaration for the PREVIOUS sweep, and every path in it names a file that
   * really is on the plane and really does parse. Nothing downstream can notice:
   * the collator gets five well-formed answers to a question it was not asked.
   * The equality against `/policy/task` is the only thing standing between that
   * and a silent wrong answer, so it is asserted against a fixture where the
   * stale reply is present and readable.
   */
  test("a declaration for another task is refused, however readable its replies", () => {
    const f = fixture();
    publish(f, CHILD_A, payload(CHILD_A));
    declareSet(f, "T-sweep-6-collate", [CHILD_A]);

    expect(() => getReplies(f.mounts)).toThrow(SubmitRefusal);
    expect(() => getReplies(f.mounts)).toThrow(/The declared reply set is stale\./);
    expect(() => getReplies(f.mounts)).toThrow(/T-sweep-6-collate/);
    expect(() => getReplies(f.mounts)).toThrow(reOf(TASK_ID));
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * **The trap in the freshness check, and why both files here are written by
   * the host's own renderers.**
   *
   * `renderTaskPolicy` strips control characters and slices to 200, so a long
   * task id is spelled one way in `/policy/task` and another way in the dispatch
   * that produced it. `renderRepliesPolicy` handles that by CALLING
   * `renderTaskPolicy` and reading line 1 back, so the declaration stores the
   * spelling `/policy/task` uses — and this end must compare the two verbatim.
   *
   * A reader that re-derived the spelling with a second `slice`, `trim` or
   * character class would report a STALE declaration for a set that is perfectly
   * fresh: silent, on the honest path, and indistinguishable from the tool
   * working. This fixture is the discriminator — a short id survives every such
   * mutation and a 200-character one survives none of them.
   */
  test("a task id long enough to be sliced still matches — the honest path", () => {
    const longId = `T-collate-${"x".repeat(300)}`;
    const f = fixture(renderTaskPolicy(longId, EPOCH));
    // The premise: the file really does disagree with the id it came from.
    const lineOne = renderTaskPolicy(longId, EPOCH).split("\n")[0]!;
    expect(lineOne).toHaveLength(200);
    expect(lineOne).not.toBe(longId);

    publish(f, CHILD_A, payload(CHILD_A));
    declareSet(f, longId, [CHILD_A]);

    const out = getReplies(f.mounts);
    expect(out.readouts.map((r) => r.task_id)).toEqual([CHILD_A.task_id]);
    expect(out.missing).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * No live task refuses before the declaration is opened at all.
   *
   * `/policy/task` is reset at settle (`supervisor/index.ts:1075`), so this is
   * an idle worker, and the declaration left over from its last dispatch is the
   * staleness of 9.6 in its most reachable form. Refusing on the task rather
   * than on the id makes that case unreachable rather than merely caught.
   */
  test("an idle worker is refused before its stale declaration is read", () => {
    const f = fixture(`${TASK_POLICY_NONE}\n0\n`);
    publish(f, CHILD_A, payload(CHILD_A));
    declareSet(f, TASK_ID, [CHILD_A]);
    expect(() => getReplies(f.mounts)).toThrow(/No task is live\./);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A declared reply that did not arrive is REPORTED, in `roles/triage.md`'s own
   * words, and the other declared replies still come back.
   *
   * §6.2.2: the block *"says so explicitly rather than being omitted"*. Omitting
   * it would make a fan-out of two that produced one look like a fan-out of one,
   * and `roles/triage.md` is explicit that *"what did not reach you is named for
   * you, so you are never left to notice it"*.
   */
  test("a declared reply that did not arrive is named, not omitted", () => {
    const f = fixture();
    publish(f, CHILD_A, payload(CHILD_A));
    declareSet(f, TASK_ID, [CHILD_A, CHILD_B]);

    const out = getReplies(f.mounts);
    expect(out.blocks).toHaveLength(2);
    expect(out.missing).toEqual([CHILD_B.task_id]);
    expect(out.readouts[1]).toEqual({
      task_id: CHILD_B.task_id,
      worker: CHILD_B.worker,
      aspect: CHILD_B.aspect,
      bytes: 0,
      ok: false,
    });
    expect(out.blocks[1]).toContain("No report was produced.");
    expect(out.blocks[1]).toContain(CHILD_B.worker);
    // The one that did arrive is unaffected.
    expect(out.blocks[0]).toContain("KAFKA-PAYLOAD");
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A reply that is THERE and does not parse is unreadable, never missing.
   *
   * `roles/triage.md` spends six lines establishing that these are different
   * things for a person to do next — one re-runs a seat, the other goes and
   * looks at a file sitting on disk — and calls conflating them *"a specific
   * falsehood worth avoiding"*. `e5d5751` is this fleet's recorded case of the
   * general shape: a right answer to the wrong document.
   *
   * So it carries its byte count, it is `ok: false`, and it is NOT in `missing`.
   * The byte count is the assertion that separates this from the arm above,
   * because `bytes: 0` is what a reader would otherwise infer "missing" from.
   */
  test("a reply that does not parse is unreadable, and is not missing", () => {
    const f = fixture();
    const garbage = "{ this was a report and it is not JSON";
    publish(f, CHILD_A, garbage);
    declareSet(f, TASK_ID, [CHILD_A]);

    const out = getReplies(f.mounts);
    expect(out.missing).toEqual([]);
    expect(out.readouts[0]?.ok).toBe(false);
    expect(out.readouts[0]?.bytes).toBe(Buffer.byteLength(garbage, "utf8"));
    expect(out.blocks[0]).toContain("A report was produced and could not be read.");
    expect(out.blocks[0]).not.toContain("No report was produced.");
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The reply's OWN bytes come back — the parse is a validation, not a
   * transformation.
   *
   * Re-serializing a parse hands the collator a document the host never wrote:
   * key order, whitespace and number formatting all move, and a collator quoting
   * it in a write-up would be quoting something that exists nowhere. The fixture
   * is formatted so that a round trip through `JSON.parse`/`JSON.stringify`
   * cannot reproduce it.
   */
  test("the reply's own bytes come back, not a re-serialization", () => {
    const f = fixture();
    const odd = '{\n   "z" :  1,\n   "a" :  2\n}';
    expect(JSON.stringify(JSON.parse(odd))).not.toBe(odd);
    publish(f, CHILD_A, odd);
    declareSet(f, TASK_ID, [CHILD_A]);

    const out = getReplies(f.mounts);
    expect(out.readouts[0]?.ok).toBe(true);
    expect(out.blocks[0]).toContain(odd);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * ONE malformed entry refuses the WHOLE document.
   *
   * A declaration is a set. Silently returning the entries that parsed would
   * hand the collator a smaller set than the host published while looking
   * exactly like a smaller fan-out — Finding E's cost arriving through a third
   * door, and one nothing downstream can notice. The fixture puts the GOOD entry
   * first, so an implementation that collected as it went would have something
   * to return.
   */
  test("one malformed entry refuses the whole declaration", () => {
    const f = fixture();
    publish(f, CHILD_A, payload(CHILD_A));
    declareRaw(
      f,
      JSON.stringify({
        schema: REPLIES_POLICY_SCHEMA,
        task_id: TASK_ID,
        replies: [
          { ...CHILD_A, path: replyMountPath(CHILD_A.task_id) },
          {
            task_id: CHILD_B.task_id,
            aspect: CHILD_B.aspect,
            path: replyMountPath(CHILD_B.task_id),
          },
        ],
      }),
    );
    expect(() => getReplies(f.mounts)).toThrow(NOT_A_DECLARATION);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A declared path outside `/replies` is not followed, and the document is
   * refused rather than the entry skipped.
   *
   * `renderRepliesPolicy` derives every path from `replyMountPath`, so a path of
   * another shape means the document was not written by that renderer whatever
   * its schema tag claims. **The check is on the PREFIX and the remainder, never
   * on the basename**: taking the basename of `/etc/passwd` would read
   * `<repliesRoot>/passwd` and call the result a reply, which is a host bug
   * turned into a file read. The fixture puts a readable `passwd` exactly where
   * that mistake would land it.
   */
  test("a declared path outside /replies refuses the document", () => {
    const f = fixture();
    writeFileSync(join(f.repliesRoot, "passwd"), "root:x:0:0");
    for (const bad of ["/etc/passwd", `${REPLIES_ROOT}/../passwd`, `${REPLIES_ROOT}/sub/a.json`]) {
      declareRaw(
        f,
        JSON.stringify({
          schema: REPLIES_POLICY_SCHEMA,
          task_id: TASK_ID,
          replies: [{ ...CHILD_A, path: bad }],
        }),
      );
      expect(() => getReplies(f.mounts)).toThrow(NOT_A_DECLARATION);
    }
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * `details` is §6.2.2's two fields and the result carries no `terminate`.
   *
   * The absence of `terminate` is asserted rather than assumed. Layer 2 makes
   * delivering the cheapest way to end a turn; a turn that has just fetched its
   * inputs is the one turn that must not be made cheap to end, and adding
   * `terminate: true` here is a one-word edit nothing else in this file would
   * notice.
   */
  test("the result is content and details, with no terminate", async () => {
    const f = fixture();
    publish(f, CHILD_A, payload(CHILD_A));
    declareSet(f, TASK_ID, [CHILD_A, CHILD_B]);
    const { replies, ctx } = registered(f);

    const result = await replies.execute("call-1", {}, undefined, undefined, ctx);

    expect(Object.keys(result).sort()).toEqual(["content", "details"]);
    expect(result.terminate).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content.every((c) => c.type === "text")).toBe(true);
    expect(result.details).toEqual({
      replies: [
        {
          task_id: CHILD_A.task_id,
          worker: CHILD_A.worker,
          aspect: CHILD_A.aspect,
          bytes: Buffer.byteLength(payload(CHILD_A), "utf8"),
          ok: true,
        },
        {
          task_id: CHILD_B.task_id,
          worker: CHILD_B.worker,
          aspect: CHILD_B.aspect,
          bytes: 0,
          ok: false,
        },
      ],
      missing: [CHILD_B.task_id],
    });
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * A `get_replies` call is a TOOL CALL and is not a delivery.
   *
   * §6.2.2's whole claim for the tool's value is that *"the host now knows
   * whether the collator looked"* — defect 6 was a collator that made zero tool
   * calls. But looking is not reporting: a collator that read its replies and
   * wrote nothing is exactly the turn layers 3 and 4 exist to record, so this
   * call must leave the epoch undelivered and the `pifleet.no_submit/v1` entry
   * must still be written. A `tracker.noteDelivery` in `get_replies`'s `execute`
   * is a one-line edit that would silence layer 4 for every collation turn in
   * the fleet, and this is the only assertion that would notice.
   */
  test("reading replies is not delivering a report", async () => {
    const f = fixture();
    publish(f, CHILD_A, payload(CHILD_A));
    declareSet(f, TASK_ID, [CHILD_A]);
    const { replies, entries, ctx, fire } = registered(f);

    fire("tool_call");
    await replies.execute("call-1", {}, undefined, undefined, ctx);
    fire("agent_end");

    expect(entries.map((e) => e.customType)).toEqual([NO_SUBMIT_ENTRY_SCHEMA]);
    expect((entries[0]?.data as Record<string, unknown>)["tool_calls"]).toBe(1);
    // And it wrote nothing: the only thing in this file that creates a file is
    // `submit_report`.
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The parameter schema: an object with no properties, closed, and no
   * `required` key at all.
   *
   * Measured in the image rather than reasoned about
   * (`pifleet/pi-worker:0.79.6-base-7b18f4213430`, 2026-09-08):
   * `Type.Object({})` renders `{"type":"object","properties":{}}` — no
   * `required` key at all — while `Type.Object({a: Type.String()})` does emit
   * one. §6.2's whole `StringEnum` argument is that the SPELLING reaching the
   * provider is the thing that matters, so `properties: {}` is present because
   * typebox emits it and `required` is absent because typebox does not.
   * `additionalProperties: false` is this file's own addition on top.
   */
  test("get_replies takes no arguments, in typebox's spelling", () => {
    expect(GET_REPLIES_PARAMETERS).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(Object.keys(GET_REPLIES_PARAMETERS)).not.toContain("required");
  });
});

/**
 * The two pure readers `get_replies` is built out of, exercised on their own.
 *
 * Both are total and exported for the reason `shouldNag` is: a clause reachable
 * only through a filesystem fixture is a clause whose mutation is expensive to
 * redden, and these two carry the checks that defend against a HOST bug rather
 * than a worker one.
 */
describe("parseRepliesPolicy and declaredReplyFile", () => {
  test("the host's own renderer round-trips, including the empty set", () => {
    expect(parseRepliesPolicy(renderRepliesPolicy(TASK_ID, [CHILD_A, CHILD_B]))).toEqual({
      schema: REPLIES_POLICY_SCHEMA,
      task_id: TASK_ID,
      replies: [
        { ...CHILD_A, path: replyMountPath(CHILD_A.task_id) },
        { ...CHILD_B, path: replyMountPath(CHILD_B.task_id) },
      ],
    });
    expect(parseRepliesPolicy(renderRepliesPolicy(TASK_ID, []))).toEqual({
      schema: REPLIES_POLICY_SCHEMA,
      task_id: TASK_ID,
      replies: [],
    });
  });

  /**
   * `<none>` parses like any other id here, and is refused upstream.
   *
   * `readTaskPolicy` refuses an idle worker before the declaration is opened, so
   * a special case in the parser would be a second place the idle rule lives —
   * and the two would eventually disagree about which one refuses.
   */
  test("the idle spelling is a task id like any other", () => {
    expect(parseRepliesPolicy(renderRepliesPolicy(null, []))?.task_id).toBe(TASK_POLICY_NONE);
  });

  test("every structural problem is one answer, because the caller has one response", () => {
    const good = { ...CHILD_A, path: replyMountPath(CHILD_A.task_id) };
    const doc = (over: Record<string, unknown>): string =>
      JSON.stringify({ schema: REPLIES_POLICY_SCHEMA, task_id: TASK_ID, replies: [good], ...over });
    expect(parseRepliesPolicy("not json at all")).toBeNull();
    expect(parseRepliesPolicy("[]")).toBeNull();
    expect(parseRepliesPolicy('"a string"')).toBeNull();
    expect(parseRepliesPolicy("null")).toBeNull();
    expect(parseRepliesPolicy(doc({ schema: "pifleet.replies/v2" }))).toBeNull();
    expect(parseRepliesPolicy(doc({ task_id: "" }))).toBeNull();
    expect(parseRepliesPolicy(doc({ task_id: 7 }))).toBeNull();
    expect(parseRepliesPolicy(doc({ replies: "not an array" }))).toBeNull();
    expect(parseRepliesPolicy(doc({ replies: [null] }))).toBeNull();
    expect(parseRepliesPolicy(doc({ replies: [[]] }))).toBeNull();
    expect(parseRepliesPolicy(doc({ replies: [{ ...good, task_id: "" }] }))).toBeNull();
    expect(parseRepliesPolicy(doc({ replies: [{ ...good, worker: "" }] }))).toBeNull();
    expect(parseRepliesPolicy(doc({ replies: [{ ...good, aspect: 3 }] }))).toBeNull();
    expect(parseRepliesPolicy(doc({ replies: [{ ...good, path: 3 }] }))).toBeNull();
    // And the good document itself still parses, so none of the above is green
    // because the fixture was broken to begin with.
    expect(parseRepliesPolicy(doc({}))).not.toBeNull();
  });

  /**
   * An empty `aspect` is legal. `DeclaredReply.aspect` is an unconstrained
   * string on the host side and a console with one slice has nothing to call it,
   * so refusing it here would be this end inventing a rule the writer does not
   * enforce — and the refusal would take the whole declaration with it.
   */
  test("an empty aspect is a value, not a malformed entry", () => {
    const parsed = parseRepliesPolicy(renderRepliesPolicy(TASK_ID, [{ ...CHILD_A, aspect: "" }]));
    expect(parsed?.replies[0]?.aspect).toBe("");
  });

  test("a declared path is the mount prefix plus one bare name, or nothing", () => {
    expect(declaredReplyFile(replyMountPath(CHILD_A.task_id))).toBe(`${CHILD_A.task_id}.json`);
    expect(declaredReplyFile("/etc/passwd")).toBeNull();
    expect(declaredReplyFile("/repliesX/a.json")).toBeNull();
    expect(declaredReplyFile("replies/a.json")).toBeNull();
    expect(declaredReplyFile(`${REPLIES_ROOT}/`)).toBeNull();
    expect(declaredReplyFile(`${REPLIES_ROOT}/sub/a.json`)).toBeNull();
    expect(declaredReplyFile(`${REPLIES_ROOT}/../passwd`)).toBeNull();
    expect(declaredReplyFile(`${REPLIES_ROOT}/..`)).toBeNull();
    expect(declaredReplyFile(`${REPLIES_ROOT}/a\u0000.json`)).toBeNull();
    expect(declaredReplyFile(`${REPLIES_ROOT}/.`)).toBeNull();
    // A SPACE is NOT rejected, and saying so is the point of the line: this
    // check refuses paths, not unusual names. The charset rule for a child
    // task id lives upstream in `replyFileName`, and a second copy here would
    // agree with it until the day one of the two was relaxed.
    expect(declaredReplyFile(`${REPLIES_ROOT}/a b.json`)).toBe("a b.json");
  });
});

/**
 * SRD-WORKER-DISPATCH-EXTENSION §13 task 7.3 — `report` carries a PAIR.
 *
 * ## Why this is a criterion and not a convenience
 *
 * Phase B removes `write` from a role, which makes `submit_report` that role's
 * only route to the filesystem. Three of this fleet's artifact contracts are
 * two files, and `roles/triage.md` states the strongest form of the rule:
 * *"Both files, every time. A run that writes only the `.md` clamps to
 * `failed`."* A single-file `report` and a `terminate: true` result together
 * made that contract unreachable for a write-less role — the first call ends
 * the turn, so the second file has no call to arrive on.
 *
 * **The old shape was not merely inconvenient, it was undetectably wrong.** The
 * one test that looked like coverage — *"a second call in the same epoch
 * overwrites and does not throw"* — calls `submitReport` twice from the test
 * process, where no `terminate` exists and no model has to choose to emit a
 * second call. It is a true statement about the function and says nothing about
 * whether a seat can reach it, which is the distinction this repository has got
 * wrong before by measuring on a plane the code does not run on.
 */
describe("a report is a list of files, because an artifact contract is a pair", () => {
  test("both halves land in one call, and the envelope claims both in order", () => {
    const f = fixture();
    const out = submitReport(
      {
        ...minimal,
        report: [
          { filename: "observer-ops.json", content: '{"schema":"x"}\n' },
          { filename: "observer-ops.md", content: "# ops\n" },
        ],
      },
      WORKER,
      f.roots,
    );
    expect(out.reportPaths).toEqual([
      join(f.taskDir, "files", "observer-ops.json"),
      join(f.taskDir, "files", "observer-ops.md"),
    ]);
    expect(readFileSync(out.reportPaths[0] ?? "", "utf8")).toBe('{"schema":"x"}\n');
    expect(readFileSync(out.reportPaths[1] ?? "", "utf8")).toBe("# ops\n");
    const env = JSON.parse(readFileSync(out.path, "utf8")) as { artifacts: unknown };
    // ORDER IS THE ASSERTION, not just membership. `artifact_files` is what a
    // host reader uses to find a half-delivered pair, and a set-comparison here
    // would pass an implementation that wrote the two claims in the order it
    // happened to iterate a Map.
    expect(env.artifacts).toEqual([
      { kind: "file", path: "files/observer-ops.json" },
      { kind: "file", path: "files/observer-ops.md" },
    ]);
    expect(out.artifactFiles).toEqual(["files/observer-ops.json", "files/observer-ops.md"]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("one file still works, and is a one-element list rather than a special case", () => {
    const f = fixture();
    const out = submitReport(
      { ...minimal, report: [{ filename: "review.md", content: "# a review\n" }] },
      WORKER,
      f.roots,
    );
    expect(out.reportPaths).toEqual([join(f.taskDir, "files", "review.md")]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("an artifact naming the SECOND pending file is accepted, not called missing", () => {
    // The single-file version compared against one path, so this call would
    // have been refused for naming a file that "does not exist" while sitting
    // in the same argument as the content that creates it.
    const f = fixture();
    const out = submitReport(
      {
        ...minimal,
        report: [
          { filename: "observer-ops.json", content: "{}\n" },
          { filename: "observer-ops.md", content: "# ops\n" },
        ],
        artifacts: [{ kind: "file", path: "files/observer-ops.md" }],
      },
      WORKER,
      f.roots,
    );
    expect(existsSync(join(f.taskDir, "files", "observer-ops.md"))).toBe(true);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("the same filename twice is refused — the second would overwrite the first", () => {
    expectRefusal(
      {
        ...minimal,
        report: [
          { filename: "observer-ops.md", content: "first" },
          { filename: "observer-ops.md", content: "second" },
        ],
      },
      /names `observer-ops\.md` twice/,
    );
  });

  test("a bad filename in the SECOND entry is refused, so the loop reads them all", () => {
    expectRefusal(
      {
        ...minimal,
        report: [
          { filename: "observer-ops.json", content: "{}" },
          { filename: "files/observer-ops.md", content: "x" },
        ],
      },
      /bare name/,
    );
  });

  test("more files than the cap is refused, and the message quotes the file cap", () => {
    const tooMany = Array.from({ length: MAX_REPORT_FILES + 1 }, (_v, i) => ({
      filename: `r${i}.md`,
      content: "x",
    }));
    expect(capProblem({ ...minimal, report: tooMany })).toBe(
      `\`report\` has ${MAX_REPORT_FILES + 1} files; cap is ${MAX_REPORT_FILES}.`,
    );
    expectRefusal({ ...minimal, report: tooMany }, /cap is 4/);
  });

  test("the file cap is its own number and is far below the entry cap", () => {
    // Asserted as a RELATION rather than as two literals, because the reason
    // they differ is that one bounds references and the other bounds content.
    // Two literals would go on agreeing with each other after someone raised
    // MAX_REPORT_FILES to 64 for a reason that has nothing to do with bytes.
    expect(MAX_REPORT_FILES).toBeLessThan(MAX_ENTRIES);
    expect(capProblem({ ...minimal, report: [{ filename: "a.md", content: "x" }] })).toBeNull();
  });

  test("the schema declares an array that cannot be empty and cannot exceed the cap", () => {
    const report = SUBMIT_REPORT_PARAMETERS.properties.report;
    expect(report.type).toBe("array");
    // `minItems: 1` and not "an empty list means no report": a model that sent
    // `report: []` decided it had files and named none, and reading that as
    // absence is the silent handling of a mistake the validator can name.
    expect(report.minItems).toBe(1);
    expect(report.maxItems).toBe(MAX_REPORT_FILES);
    expect(report.items.required).toEqual(["filename", "content"]);
    expect(report.items.additionalProperties).toBe(false);
  });
});

/**
 * SRD-WORKER-DISPATCH-EXTENSION task 7.3 — the write-free fan-out.
 *
 * ## The measurement this tool exists for
 *
 * `fleet.yaml`'s `triage` block records 7.3's first attempt and its reversal on
 * 2026-09-09. Narrowed to no `write`, `tri-1` *"composed the fan-out correctly
 * and was refused three times — `Tool write not found` — and the console
 * dispatched nothing for three sweeps."* The outage was the lesser half:
 * *"sweeps 5 and 6 settled `status: success` with the summary 'Dispatched sweep
 * to obs-t1', having written no request at all."*
 *
 * ## Why `submit_report` could not have covered it
 *
 * Its `report` files land in `<task-dir>/files/`; the fan-out is read from
 * `<task-dir>` itself. One directory level is the whole gap, and it is not
 * closable by widening `report` — an entry that could name a parent directory
 * would be a path where the contract says a bare name, which is the containment
 * `filenameProblem` exists for.
 */
const REQUEST = { worker: "obs-t1", title: "Sweep slice 1", brief: "Look at ntfy." };

describe("dispatch_request writes the fan-out a narrowed role cannot", () => {
  test("the document is the host's shape, with schema and parent_task_id composed here", () => {
    const f = fixture();
    const out = dispatchRequest({ requests: [REQUEST] }, f.mounts);
    expect(out.path).toBe(join(f.taskDir, DISPATCH_REQUEST_NAME));
    // AT THE TASK ROOT, not under files/ — the one fact that made this a tool
    // rather than another `report` entry.
    expect(out.path).not.toContain(`${sep}files${sep}`);
    const doc = JSON.parse(readFileSync(out.path, "utf8")) as Record<string, unknown>;
    expect(doc["schema"]).toBe(DISPATCH_REQUEST_SCHEMA);
    expect(doc["parent_task_id"]).toBe(TASK_ID);
    expect(doc["requests"]).toEqual([REQUEST]);
    expect(out.workers).toEqual(["obs-t1"]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("schema and parent_task_id are not parameters, so a model cannot set them", () => {
    const props = Object.keys(DISPATCH_REQUEST_PARAMETERS.properties);
    expect(props).toEqual(["requests"]);
    expect(DISPATCH_REQUEST_PARAMETERS.additionalProperties).toBe(false);
    expect(DISPATCH_REQUEST_PARAMETERS.properties.requests.items.additionalProperties).toBe(false);
  });

  test("an absent services list is OMITTED, not written as null", () => {
    // The host schema is `.strict()` and an EMPTY list is a legal share — "an
    // idle observer is not an error" — so absent and empty must stay
    // distinguishable in the bytes.
    const f = fixture();
    const out = dispatchRequest(
      { requests: [REQUEST, { ...REQUEST, worker: "obs-t2", services: [] }] },
      f.mounts,
    );
    const raw = readFileSync(out.path, "utf8");
    const doc = JSON.parse(raw) as { requests: Record<string, unknown>[] };
    expect("services" in (doc.requests[0] ?? {})).toBe(false);
    expect(doc.requests[1]?.["services"]).toEqual([]);
    expect(raw).not.toContain("null");
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("an empty requests list is refused — a sweep that dispatched nobody", () => {
    const f = fixture();
    expect(() => dispatchRequest({ requests: [] }, f.mounts)).toThrow(/dispatched nobody/);
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("one worker named twice is refused, so the host refuses the entry not the sweep", () => {
    const f = fixture();
    expect(() =>
      dispatchRequest({ requests: [REQUEST, { ...REQUEST, title: "again" }] }, f.mounts),
    ).toThrow(/names `obs-t1` twice/);
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("a worker id that is a traversal is refused before anything is written", () => {
    const f = fixture();
    for (const worker of ["../../control-auth", "obs t1", "", "obs/t1", ".hidden"]) {
      expect(() => dispatchRequest({ requests: [{ ...REQUEST, worker }] }, f.mounts)).toThrow(
        /is not a worker id/,
      );
    }
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("a service name that is a traversal is refused before anything is written", () => {
    const f = fixture();
    expect(() =>
      dispatchRequest({ requests: [{ ...REQUEST, services: ["../../secrets"] }] }, f.mounts),
    ).toThrow(/is not a service\s+name/);
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("over-cap requests and services are refused, each naming its own bound", () => {
    const f = fixture();
    const tooMany = Array.from({ length: MAX_DISPATCH_REQUEST_ITEMS + 1 }, (_v, i) => ({
      ...REQUEST,
      worker: `obs-t${i}`,
    }));
    expect(() => dispatchRequest({ requests: tooMany }, f.mounts)).toThrow(
      new RegExp(`cap is ${MAX_DISPATCH_REQUEST_ITEMS}`),
    );
    const wideShare = Array.from({ length: MAX_DISPATCH_SERVICES + 1 }, (_v, i) => `svc${i}`);
    expect(() =>
      dispatchRequest({ requests: [{ ...REQUEST, services: wideShare }] }, f.mounts),
    ).toThrow(new RegExp(`cap is ${MAX_DISPATCH_SERVICES}`));
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * The mirror assertions. This file is COPYied into the image and cannot import
   * from `src/`, so every bound above is a re-spelling — and a re-spelling that
   * nothing pins is a copy that drifts. Pinned HERE rather than trusted, because
   * a bound that moves on the host without moving here produces a request the
   * host then refuses, which is the exact failure this tool removes arriving one
   * layer further in.
   */
  test("every mirrored constant equals the host module that reads the document", () => {
    expect(DISPATCH_REQUEST_SCHEMA).toBe(HOST_DISPATCH_REQUEST_SCHEMA);
    expect(DISPATCH_REQUEST_NAME).toBe(HOST_DISPATCH_REQUEST_FILE);
    expect(MAX_DISPATCH_REQUEST_ITEMS).toBe(HOST_MAX_DISPATCH_REQUEST_ITEMS);
    expect(MAX_DISPATCH_TEXT).toBe(HOST_MAX_DISPATCH_TEXT);
    expect(MAX_DISPATCH_ID_CHARS).toBe(HOST_MAX_DISPATCH_ID_CHARS);
    expect(MAX_DISPATCH_SERVICES).toBe(HOST_MAX_DISPATCH_SERVICES);
    expect(DISPATCH_ID_RE.source).toBe(SESSION_ID_RE.source);
  });

  /**
   * The document this tool writes is PARSED by the host's own parser, not merely
   * shaped like it. A schema mirror that agrees on every constant and disagrees
   * on a field name would pass every assertion above.
   */
  test("the host's own parser accepts what this tool writes", () => {
    const f = fixture();
    const out = dispatchRequest(
      { requests: [REQUEST, { ...REQUEST, worker: "obs-t2", services: ["ntfy"] }] },
      f.mounts,
    );
    const parsed = DispatchRequestSchema.safeParse(
      JSON.parse(readFileSync(out.path, "utf8")) as unknown,
    );
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    rmSync(f.dir, { recursive: true, force: true });
  });
});
