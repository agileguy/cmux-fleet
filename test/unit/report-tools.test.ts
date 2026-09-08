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
import { join, relative } from "node:path";

import register, {
  artifactPathProblem,
  capProblem,
  composeEnvelope,
  composeNoSubmitEntry,
  composeSubmitEntry,
  createEpochTracker,
  DEFAULT_MOUNTS,
  emptyTally,
  filenameProblem,
  MAX_ENTRIES,
  NO_SUBMIT_ENTRY_SCHEMA,
  OUTBOX_ROOT,
  parseTaskPolicy,
  readTaskPolicy,
  RESULT_SCHEMA,
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
  type Roots,
  type SubmitReportParams,
  type ToolDefinitionLike,
} from "../../docker/pi-extensions/report-tools.ts";

/** The fixture identities, deliberately sharing no substring with each other. */
const TASK_ID = "T-sweep-7-slice1";
const EPOCH = 12;
const WORKER = "obs-t1";

interface Fixture {
  dir: string;
  roots: Roots;
  outbox: string;
  taskDir: string;
}

/**
 * A tmpdir carrying a `/policy/task` and an `/outbox`.
 *
 * `policy` defaults to a live task; passing a string writes those exact bytes,
 * which is how the `<none>` and malformed cases are reached without a second
 * helper. Passing `null` writes no file at all — the unmounted case.
 */
function fixture(policy: string | null = `${TASK_ID}\n${EPOCH}\n`): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pifleet-report-tools-"));
  const policyPath = join(dir, "policy-task");
  if (policy !== null) writeFileSync(policyPath, policy);
  const outbox = join(dir, "outbox");
  mkdirSync(outbox, { recursive: true });
  const workdir = join(dir, "workspace");
  mkdirSync(workdir, { recursive: true });
  return {
    dir,
    roots: { policyPath, outboxRoot: outbox, workdir },
    outbox,
    taskDir: join(outbox, TASK_ID),
  };
}

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
function stubPi(appendEntry?: ExtensionAPI["appendEntry"]): {
  pi: ExtensionAPI;
  tools: ToolDefinitionLike[];
  entries: RecordedEntry[];
  handlers: RecordedHandler[];
} {
  const tools: ToolDefinitionLike[] = [];
  const entries: RecordedEntry[] = [];
  const handlers: RecordedHandler[] = [];
  const pi: ExtensionAPI = {
    registerTool: (tool) => void tools.push(tool),
    on: (event, handler) => void handlers.push({ event, handler }),
    sendUserMessage: () => undefined,
    appendEntry: appendEntry ?? ((customType, data) => void entries.push({ customType, data })),
  };
  return { pi, tools, entries, handlers };
}

/** `register` against a fixture, plus the `ctx` `execute` and the handlers are really handed. */
function registered(
  f: Fixture,
  appendEntry?: ExtensionAPI["appendEntry"],
): {
  tool: ToolDefinitionLike;
  entries: RecordedEntry[];
  ctx: ExtensionContextLike;
  fire(event: "agent_end" | "tool_call"): unknown;
} {
  const { pi, tools, entries, handlers } = stubPi(appendEntry);
  register(pi, { policyPath: f.roots.policyPath, outboxRoot: f.outbox });
  const ctx: ExtensionContextLike = {
    cwd: f.roots.workdir ?? "",
    sessionManager: { getSessionId: () => WORKER },
  };
  return {
    tool: tools[0]!,
    entries,
    ctx,
    fire: (event) => {
      const matching = handlers.filter((r) => r.event === event);
      // Without this line every assertion driven through `fire` would be green
      // by VACUITY the moment a subscription was dropped: no handler runs, no
      // entry appears, and "no entry appears" is what several of the tests below
      // are asserting. Unsubscribing `agent_end` is a one-word deletion and it
      // must not be able to make this file greener.
      expect(matching.length).toBeGreaterThan(0);
      let last: unknown;
      for (const r of matching) last = r.handler(EVENT_PAYLOADS[event], ctx);
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
    expect(SUBMIT_REPORT_PARAMETERS.properties.report.properties.content).toEqual({ type: "string" });
  });
});

describe("composeEnvelope", () => {
  test("the four host fields come from host state and the rest from the call", () => {
    const env = composeEnvelope(minimal, { taskId: TASK_ID, epoch: EPOCH }, WORKER, null);
    expect(env.schema).toBe(RESULT_SCHEMA);
    expect(env.task_id).toBe(TASK_ID);
    expect(env.epoch).toBe(EPOCH);
    expect(env.worker).toBe(WORKER);
    expect(env.status).toBe("success");
    expect(env.summary).toBe(minimal.summary);
  });

  test("absent optional fields are omitted, not defaulted", () => {
    const env = composeEnvelope(minimal, { taskId: TASK_ID, epoch: EPOCH }, WORKER, null);
    expect(Object.keys(env).sort()).toEqual(
      ["epoch", "schema", "status", "summary", "task_id", "worker"],
    );
  });

  test("a written report is appended to artifacts, beside what the call declared", () => {
    const env = composeEnvelope(
      { ...minimal, artifacts: [{ kind: "diff", path: "files/patch.diff" }] },
      { taskId: TASK_ID, epoch: EPOCH },
      WORKER,
      "files/review.md",
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
      { ...minimal, report: { filename: "review.md", content: "# a review\n" } },
      WORKER,
      f.roots,
    );
    expect(out.reportPath).toBe(join(f.taskDir, "files", "review.md"));
    expect(readFileSync(out.reportPath ?? "", "utf8")).toBe("# a review\n");
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
        { ...minimal, report: { filename: "review.md", content: "# a review\n" } },
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
    submitReport({ ...minimal, report: { filename: "review.md", content: "x" } }, WORKER, f.roots);
    expect(listAll(f.outbox).filter((p) => p.includes(".tmp"))).toEqual([]);
    expect(listAll(f.outbox).sort()).toEqual(
      [TASK_ID, join(TASK_ID, "files"), join(TASK_ID, "files", "review.md"), join(TASK_ID, "result.json")].sort(),
    );
    rmSync(f.dir, { recursive: true, force: true });
  });

  /**
   * §12: *"A second `submit_report` in one epoch overwrites and does not throw.
   * This asserts a deliberate non-refusal and is the criterion that stops
   * someone 'fixing' it into an error."* `roles/observer.md:56-58` asks for
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
      { ...minimal, artifacts: [{ kind: "diff", path: join(f.roots.workdir ?? "", "patch.diff") }] },
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
    expectRefusal({ ...minimal, report: { filename: "files/r.md", content: "x" } }, /bare name/);
  });

  test("report.filename contains ..", () => {
    expectRefusal({ ...minimal, report: { filename: "../r.md", content: "x" } }, /bare name/);
  });

  test("report.filename starts with @", () => {
    expectRefusal({ ...minimal, report: { filename: "@r.md", content: "x" } }, /@/);
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
   * declares — which is `roles/reviewer.md:47-52`'s undeclared-artifact
   * discrepancy, produced by the very tool that exists to make it impossible.
   */
  test("a refused call carrying a valid report writes no report file either", () => {
    const f = fixture();
    expect(() =>
      submitReport(
        {
          ...minimal,
          report: { filename: "review.md", content: "# a review\n" },
          artifacts: [{ kind: "file", path: "/etc/passwd" }],
        },
        WORKER,
        f.roots,
      ),
    ).toThrow(/outside/);
    expect(listAll(f.outbox)).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });
});

describe("registration", () => {
  /**
   * §12, from phase 2: *"the registered set is a SUBSET of `PI_EXTENSION_TOOLS`
   * and contains `submit_report`"*. `get_replies` is phase 5 and registering it
   * early would make the phase-2 criterion assert something phase 2 does not
   * ship.
   */
  test("exactly one tool is registered, and it is submit_report", () => {
    const { pi, tools } = stubPi();
    register(pi);
    expect(tools.map((t) => t.name)).toEqual(["submit_report"]);
    expect(tools[0]?.parameters).toBe(SUBMIT_REPORT_PARAMETERS);
  });

  test("the default mounts are the real ones, so the image needs no caller to pass them", () => {
    expect(DEFAULT_MOUNTS).toEqual({ policyPath: TASK_POLICY_PATH, outboxRoot: OUTBOX_ROOT });
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
    register(pi, { policyPath: f.roots.policyPath, outboxRoot: f.outbox });
    const tool = tools[0];
    expect(tool).toBeDefined();

    const ctx: ExtensionContextLike = {
      cwd: f.roots.workdir ?? "",
      sessionManager: { getSessionId: () => WORKER },
    };
    const result = await tool!.execute(
      "call-1",
      { ...minimal, artifacts: [{ kind: "diff", path: join(f.roots.workdir ?? "", "patch.diff") }] },
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
    const data = await deliverAndRead(f, {
      ...minimal,
      artifacts: [{ kind: "diff", path: "files/patch.diff" }],
      report: { filename: "review.md", content: "# a review\n" },
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
    register(pi, { policyPath: f.roots.policyPath, outboxRoot: f.outbox });
    const result = await tools[0]!.execute(
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
        reportPath: null,
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
        reportPath: null,
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
   * `nagged` is CARRIED, not written.
   *
   * Layer 3 is SRD phase 4 and nothing in this tree sends a nag, so every entry
   * the wiring below produces reads `nagged: false`. That is a measurement of
   * the current state and not a placeholder, and this pair of assertions is what
   * makes the difference checkable: a `nagged: false` hard-coded into the
   * composer would satisfy every wiring test in this file and would silently
   * survive phase 4 wiring a real nag onto the tally beside it.
   */
  test("nagged comes off the tally, so phase 4 changes no signature here", () => {
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
   * **`nagged: false`, and it is a fact rather than a stub.**
   *
   * Layer 3 — the bounded `agent_end` re-prompt — is SRD task 4.1 and is NOT in
   * this tree. Nothing calls `sendUserMessage`, so no nag has been sent, so
   * `false` is what actually happened to this epoch. Phase 4 flips it by marking
   * the tally when it sends the nag; the composer, the entry shape and this
   * wiring do not change.
   *
   * Note what phase 4 will make of the pair: task 4.2 suppresses the nag for a
   * zero-tool-call turn, so the `gpt-oss-20b` shape will read
   * `tool_calls: 1, nagged: false` and the `gemma` shape
   * `tool_calls: 150, nagged: true`. Two fields, two failures, no transcript.
   */
  test("nagged is false, because layer 3 does not exist in this tree", () => {
    const f = fixture();
    const { entries, fire } = registered(f);
    fire("tool_call");
    fire("agent_end");
    expect(noSubmits(entries)[0]?.["nagged"]).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
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
