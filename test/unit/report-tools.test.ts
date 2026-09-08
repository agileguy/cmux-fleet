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
  DEFAULT_MOUNTS,
  filenameProblem,
  MAX_ENTRIES,
  OUTBOX_ROOT,
  parseTaskPolicy,
  readTaskPolicy,
  RESULT_SCHEMA,
  submitReport,
  SUBMIT_REPORT_PARAMETERS,
  SubmitRefusal,
  TASK_POLICY_NONE,
  TASK_POLICY_PATH,
  taskPaths,
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
  /** A `pi` that records instead of running one. */
  function stubPi(): { pi: ExtensionAPI; tools: ToolDefinitionLike[] } {
    const tools: ToolDefinitionLike[] = [];
    const pi: ExtensionAPI = {
      registerTool: (tool) => void tools.push(tool),
      on: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: () => undefined,
    };
    return { pi, tools };
  }

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

  /**
   * SRD task 3.1 and 3.2 are NOT in this phase, and this asserts their absence
   * rather than leaving it to a reader to notice. `terminate: true` and
   * `pi.appendEntry("pifleet.submit/v1", …)` are real parts of the design; a
   * later commit adds them, and this test is the thing that has to change when
   * it does — which is better than a phase-2 result that quietly already
   * carried a phase-3 field nobody tested.
   */
  test("terminate and the session entry are phase 3, and are absent", async () => {
    const f = fixture();
    const entries: string[] = [];
    const tools: ToolDefinitionLike[] = [];
    const pi: ExtensionAPI = {
      registerTool: (tool) => void tools.push(tool),
      on: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: (customType) => void entries.push(customType),
    };
    register(pi, { policyPath: f.roots.policyPath, outboxRoot: f.outbox });
    const result = await tools[0]!.execute("call-1", minimal, undefined, undefined, {
      cwd: f.roots.workdir ?? "",
      sessionManager: { getSessionId: () => WORKER },
    });
    expect(Object.keys(result)).toEqual(["content", "details"]);
    expect(entries).toEqual([]);
    rmSync(f.dir, { recursive: true, force: true });
  });
});
