/**
 * A staged task is VISIBLE to the fleet (SRD-TUI-DISPATCH §6.5, ISC-445,
 * ISC-457).
 *
 * ## The claim, and why it needed its own file
 *
 * `stage-verb.test.ts` proves the ALLOCATOR is correct: an epoch is handed out,
 * the fence is durable before the provenance, a replay rewrites nothing, a
 * release does not settle. Every one of those assertions can hold while the
 * rest of the fleet has no idea any of it happened — and it did. Before this
 * block, a staged task was a live epoch, a stamped `/policy/task` and an inbox
 * record that `status` did not mention, `wait` sat on until its timeout, and
 * nothing could cancel from the command line.
 *
 * So this file asserts the OTHER half of §6.5: what every command that reads a
 * worker says about a worker that is holding one.
 *
 * ## The state field is the whole mechanism, and it has exactly three exits
 *
 * `WorkerStateSchema.staged_task_id` carries "the allocator is holding this
 * worker for this task" while `phase` keeps carrying "what the agent is doing",
 * because the two facts genuinely differ for a staged worker — it cannot take
 * another task AND it is not running one. Its docblock names three clear sites
 * and says a stale id is a smaller lie than the reverse and is still a lie.
 * Each of the three is probed here or, where the site is unreachable at unit
 * speed, pinned structurally:
 *
 *   - the TRIGGER — `phase` to `busy`, id to null. Inside `main()`'s
 *     `setInterval`, so structural (see below).
 *   - `unstage` — behavioural, against a real `EpochManager`.
 *   - `settle` — inside `main()`, so structural.
 *
 * ## ISC-455 — nothing here opens a pty, a container, or a socket to one
 *
 * The anti-criterion on the whole ISC-431..458 block, and the property
 * ISC-377/378/379/387 lack and are `[~]` for. Every probe below runs against a
 * temp directory, a real `EpochManager`, and — for the two CLI probes — a real
 * unix socket this process both serves and calls. No Docker, no pty, no cmux,
 * no worker image. The socket is not a compromise of that rule: it is the same
 * `serveJsonlSocket` the supervisor uses, served in-process by a handler that
 * calls the same `handleUnstage`, which is the only way to assert that
 * `pifleet unstage` REACHES `EpochManager.cancel` rather than reimplementing
 * its own release.
 *
 * ## Two probes are structural, and the reason is `supervisor-tui.test.ts`'s
 *
 * That file states the constraint: `src/supervisor/index.ts` is one 2000-line
 * `main()` that spawns a process and opens a socket, so the risk inside it can
 * only be graded by reading the source. The trigger site and `settle`'s clear
 * are both inside that closure — the trigger reads `stagedDeadlineMs`,
 * `deadline` and `tuiReader`, none of which exist outside it. Extracting them
 * to get a behavioural probe would be a refactor performed for the test's
 * benefit on the most load-bearing loop in the tree, which is a worse trade
 * than a source assertion that fails when the line is deleted.
 *
 * The structural probes are written against COMMENT-STRIPPED source and are
 * scoped to the enclosing block rather than to the whole file, so a matching
 * string in a docblock or in an unrelated function cannot satisfy them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EpochManager } from "../../src/rpc/epoch.ts";
import {
  EXIT,
  TaskEnvelopeSchema,
  type TaskEnvelope,
  type WorkerState,
} from "../../src/contracts.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import {
  handleStage,
  handleUnstage,
  type StageDeps,
} from "../../src/supervisor/index.ts";
import { buildProgram, exitCodeForError } from "../../src/cli/index.ts";
import { inboxTaskPath, runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { ensureControlAuth } from "../../src/security/control-auth.ts";
import { serveJsonlSocket, type SocketServer } from "../../src/run/registry.ts";
import { stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUPERVISOR_SRC = stripComments(readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8"));

const RUN_ID = "2026-09-02T09-00-00Z-vis";
const WORKER = "tui-1";

// ---------------------------------------------------------------------------
// The supervisor-side harness, borrowed from `stage-verb.test.ts`
// ---------------------------------------------------------------------------

/**
 * Built through the real schema, so a field rename cannot leave the fixture
 * behind — `stage-verb.test.ts`'s reason, and it applies with more force here
 * because this file's fixtures are also written to DISK and read back through
 * the same schema by `wait` and `status`.
 */
function envelope(taskId: string, overrides: Record<string, unknown> = {}): TaskEnvelope {
  return TaskEnvelopeSchema.parse({
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: RUN_ID,
    epoch: 0,
    attempt: 1,
    worker: WORKER,
    dispatched_at: "2026-09-02T09:00:00Z",
    title: `Do ${taskId}`,
    brief: "Full markdown instructions",
    repo: "/repo",
    host_workdir: "/repo/.worktrees/tui-1",
    container_workdir: "/workspace",
    branch: "fleet/run/tui-1",
    base_ref: "9f1c2ab3e4d5f60718293a4b5c6d7e8f90a1b2c3",
    outbox: `/outbox/${taskId}`,
    deadline_s: 1200,
    ...overrides,
  });
}

interface Harness {
  em: EpochManager;
  state: WorkerState;
  deps: StageDeps & { shuttingDown: boolean; disarmStagedDeadline: () => void };
}

function harness(): Harness {
  const em = new EpochManager();
  const state = initialWorkerState({
    worker: WORKER,
    runId: RUN_ID,
    pid: process.pid,
    pgid: process.pid,
    startedAt: "2026-09-02T09:00:00Z",
  });
  const h = { em, state } as Harness;
  h.deps = {
    em,
    state,
    worker: WORKER,
    persistFence: async () => {},
    flushState: async () => {},
    writeProvenance: async () => {},
    ledgerAppend: async () => {},
    logEvent: () => {},
    armDeadlineOnTrigger: () => {},
    shuttingDown: false,
    disarmStagedDeadline: () => {},
  };
  return h;
}

// ---------------------------------------------------------------------------
// `staged_task_id` — set at the stage, cleared at each of the three exits
// ---------------------------------------------------------------------------

describe("the state file says a task is staged without claiming it is running", () => {
  /**
   * THE CENTRAL ASSERTION OF §6.5, and both halves matter equally.
   *
   * `phase === "idle"` is the half that used to be wrong: `handleStage` wrote
   * `busy` because there was no field to carry the other fact, and a docblock
   * argued for it. `busy` would have made `status` report a turn in progress
   * for however long the operator took to press the key — a liveness claim on
   * disk that no observation supported.
   *
   * `staged_task_id === taskId` is the half that makes the first half safe.
   * Without it, `idle` alone is the mirror-image lie: a worker that cannot take
   * another task, reported as free.
   */
  test("a stage leaves phase idle and names the staged task", async () => {
    const h = harness();
    const answer = await handleStage(h.deps, envelope("T-001"), "a1", null);

    expect(answer).toEqual({ accepted: true, epoch: 1, replayed: false });
    expect(h.state.phase).toBe("idle");
    expect(h.state.staged_task_id).toBe("T-001");
    // `task_id` and `staged_task_id` both name it, and that is not redundant:
    // `task_id` is the epoch's task and stays set through the turn, while
    // `staged_task_id` is cleared the moment the turn begins. They agree here
    // and diverge at the trigger, which is the whole point of there being two.
    expect(h.state.task_id).toBe("T-001");
  });

  /**
   * `phase` must not be INHERITED, which is the failure a "leave it alone"
   * implementation produces.
   *
   * `initialWorkerState` writes `phase: "starting"`, so a `handleStage` that
   * simply declined to touch the field would leave a staged worker reported as
   * still coming up — an honest-looking answer that is wrong in the same
   * direction `busy` was, just less loudly.
   */
  test("phase is written, not inherited from whatever it was", async () => {
    const h = harness();
    expect(h.state.phase).toBe("starting");

    await handleStage(h.deps, envelope("T-001"), "a1", null);
    expect(h.state.phase).toBe("idle");
  });

  /**
   * A REFUSED stage writes nothing, including this field. The allocator owns
   * the refusal, so an implementation that stamped the state first and checked
   * afterwards would leave the second task's id on a worker holding the
   * first's epoch — and `wait` would then settle T-002 as staged on the
   * strength of it, naming a remedy (press the key) that would run T-001.
   */
  test("a stage refused busy does not overwrite the staged id", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);

    const second = await handleStage(h.deps, envelope("T-002"), "b1", null);
    expect(second.accepted).toBe(false);
    expect(h.state.staged_task_id).toBe("T-001");
  });

  test("unstage clears both the staged id and the epoch's task", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);
    expect(h.state.staged_task_id).toBe("T-001");

    const released = await handleUnstage(h.deps, "T-001", "a1");
    expect(released).toEqual({ ok: true, epoch: 1 });
    expect(h.state.staged_task_id).toBeNull();
    expect(h.state.task_id).toBeNull();
    expect(h.state.phase).toBe("idle");
    expect(h.state.epoch).toBe(0);
  });

  /**
   * A REFUSED release leaves the staged id standing, and this is the control
   * arm for the test above.
   *
   * `handleUnstage` clears the field after `cancel` succeeds. An implementation
   * that cleared it first — or that cleared it on every call — would answer
   * `not_the_live_attempt` to the operator while quietly telling `status` the
   * worker was free, which is the worst of both: the epoch still held, and
   * nothing left on disk saying which task is holding it.
   */
  test("a refused release leaves the staged id where it was", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);

    const refused = await handleUnstage(h.deps, "T-001", "WRONG-ATTEMPT");
    expect(refused.ok).toBe(false);
    expect(h.state.staged_task_id).toBe("T-001");
  });
});

// ---------------------------------------------------------------------------
// The trigger, and `settle` — structural, for `supervisor-tui.test.ts`'s reason
// ---------------------------------------------------------------------------

/**
 * The trigger block's source, sliced from `if (stagedDeadlineMs !== null &&
 * grew) {` to its `logEvent(`.
 *
 * Scoped rather than searched file-wide on purpose: `state.staged_task_id =
 * null` appears at three sites, so a whole-file `toContain` would stay green
 * with the trigger's copy deleted as long as `settle`'s survived. The slice is
 * what makes the probe specific to this site.
 */
function triggerBlock(): string {
  const start = SUPERVISOR_SRC.indexOf("if (stagedDeadlineMs !== null && grew) {");
  expect(start).toBeGreaterThan(-1);
  const end = SUPERVISOR_SRC.indexOf("logEvent(", start);
  expect(end).toBeGreaterThan(start);
  return SUPERVISOR_SRC.slice(start, end);
}

describe("the trigger promotes the stage rather than leaving it staged forever", () => {
  /**
   * §9 Q1's trigger is the ONLY moment on this route at which anything
   * observes that a turn has begun, so it is the only moment at which `busy`
   * can be written honestly — and it is therefore also the only moment at
   * which the staged id can be cleared honestly.
   *
   * Both writes are asserted in the same block because they are one fact in
   * two fields: a worker that is `busy` and still holding a staged id reads as
   * two tasks, and a worker that is `idle` with the id cleared reads as
   * nothing at all.
   */
  test("the trigger site sets phase busy AND clears the staged id", () => {
    const block = triggerBlock();
    expect(block).toContain('state.phase = "busy"');
    expect(block).toContain("state.staged_task_id = null");
  });

  /**
   * The promotion must be FLUSHED, and inside the same block.
   *
   * `state` is mutated in place and `status` reads `state.json`, so a
   * promotion that is not written to disk changes nothing an operator can
   * see — the pane keeps saying `idle` with a staged id against a worker that
   * is mid-turn, which is precisely the console defect this whole field exists
   * to avoid, arriving one step later.
   *
   * There is no second chance at this write: `stagedDeadlineMs` has already
   * been consumed by the lines above, so the block cannot run again for this
   * stage.
   */
  test("the promotion is flushed to disk in the same block", () => {
    expect(triggerBlock()).toContain("flushState()");
  });

  /**
   * §9 Q1's honesty requirement, unchanged from `stage-verb.test.ts` and
   * re-asserted here because this block now does MORE than arm a clock. A
   * promotion to `busy` on an unattributable signal is a stronger claim than
   * parking a deadline on one, so the word has to survive the edit that added
   * it.
   */
  test("the approximation is still declared where the promotion happens", () => {
    const raw = readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8");
    expect(raw).toContain("APPROXIMATE");
    expect(raw).toMatch(/APPROXIMATE[\s\S]{0,400}operator's own prompt/);
  });
});

describe("settle clears the staged id on the paths the other two exits miss", () => {
  /**
   * The third clear site. `settle` is reached by a staged epoch that was
   * killed by the deadline the trigger armed, aborted, or failed on restart —
   * none of which pass through the trigger or through `unstage`.
   *
   * Sliced to the region between `settle`'s provenance clear and its
   * `completed_epochs` append, for the same specificity reason as
   * `triggerBlock`.
   */
  test("the settle path clears it beside task_id", () => {
    const start = SUPERVISOR_SRC.indexOf("await writeTaskPolicy(wp.taskPolicy, null, 0);");
    expect(start).toBeGreaterThan(-1);
    const end = SUPERVISOR_SRC.indexOf("state.completed_epochs = [", start);
    expect(end).toBeGreaterThan(start);
    const block = SUPERVISOR_SRC.slice(start, end);
    expect(block).toContain("state.task_id = null");
    expect(block).toContain("state.staged_task_id = null");
  });
});

// ---------------------------------------------------------------------------
// The CLI probes — a temp run tree, and for `unstage` an in-process socket
// ---------------------------------------------------------------------------

let root: string;
let run: RunPaths;

/**
 * `mkdtemp` under the system temp dir rather than under a scratch path,
 * because the control socket's path is derived from the RUN ID by
 * `socketPath()` and lands in `tmpdir()/pifleet/` regardless — so the run tree
 * and the socket stay on the same short-path filesystem and neither can
 * approach the ~104-byte `sun_path` limit that turns a socket bind into an
 * unhelpful `ENAMETOOLONG`.
 */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pf-staged-"));
  run = runPaths(RUN_ID, root);
  await mkdir(run.inboxDir, { recursive: true });
  await mkdir(join(run.workersDir, WORKER), { recursive: true });
  // `resolveRunPaths` and `latestRunId` both key on `run.json` existing.
  await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: RUN_ID }), "utf8");
  // `serveJsonlSocket` binds under `tmpdir()/pifleet/`, which `up` normally
  // creates. Nothing in this file runs `up`.
  await mkdir(join(tmpdir(), "pifleet"), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Put a worker on disk in the state a stage leaves it in.
 *
 * `pid: process.pid` is load-bearing rather than convenient: `wait`'s death
 * check and `requireLiveWorker` both call `processStartTime(state.pid)`, and a
 * fabricated pid reads as a dead supervisor — which would settle the task as
 * `worker_died` and pass the exit-code assertion below for entirely the wrong
 * reason. Using this process's own pid is the only pid a unit test can be sure
 * is alive without spawning something.
 */
async function plantStagedWorker(taskId: string | null): Promise<void> {
  const state = initialWorkerState({
    worker: WORKER,
    runId: RUN_ID,
    pid: process.pid,
    pgid: process.pid,
    startedAt: "2026-09-02T09:00:00Z",
  });
  state.phase = "idle";
  state.epoch = taskId === null ? 0 : 1;
  state.task_id = taskId;
  state.staged_task_id = taskId;
  await writeWorkerState(workerPaths(run, WORKER), state);
}

/** The inbox record a stage writes — what `wait` and `unstage` key on. */
async function plantInbox(taskId: string, attempt = 1): Promise<void> {
  await writeFile(
    inboxTaskPath(run, taskId),
    JSON.stringify({ ...envelope(taskId, { attempt }), epoch: 1 }),
    "utf8",
  );
}

/**
 * Run one `pifleet` command through the real program, capturing stdout and the
 * ladder code the entry point would have exited with.
 *
 * `buildProgram` + `exitCodeForError` rather than a hand-rolled invocation:
 * `exitCodeForError` IS the entry point's policy, and a test that mapped the
 * thrown error itself would prove only that its own copy of the mapping is
 * self-consistent — which is the reason that function is exported.
 */
async function runCli(
  mod: { register: (p: ReturnType<typeof buildProgram>) => void },
  argv: string[],
): Promise<{ exit: number; stdout: string }> {
  const program = buildProgram();
  mod.register(program);
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  const previousRunsDir = process.env["PIFLEET_RUNS_DIR"];
  process.env["PIFLEET_RUNS_DIR"] = root;
  try {
    await program.parseAsync(argv, { from: "user" });
    return { exit: EXIT.SUCCESS, stdout: chunks.join("") };
  } catch (err) {
    return { exit: exitCodeForError(err), stdout: chunks.join("") };
  } finally {
    process.stdout.write = original;
    if (previousRunsDir === undefined) delete process.env["PIFLEET_RUNS_DIR"];
    else process.env["PIFLEET_RUNS_DIR"] = previousRunsDir;
  }
}

// ---------------------------------------------------------------------------
// ISC-445 — `wait` names a staged task instead of consuming its timeout
// ---------------------------------------------------------------------------

describe("wait answers a staged task immediately (ISC-445)", () => {
  /**
   * THE CRITERION, AND THE CLOCK IS HALF OF IT.
   *
   * ISC-445's probe is "assert the exit code and the reason inside a second",
   * and the second is not decoration. Before this, a staged task had no record
   * and looked exactly like a running one, so `wait` polled until `--timeout`
   * and reported `wait_timeout` — a diagnosis that says a clock ran out and
   * sends the reader to investigate a slow task, when the remedy is a keypress
   * at a terminal somebody is sitting at. §6.5: "a `wait` that blocks on a key
   * nobody pressed is the hang this whole design exists to avoid."
   *
   * **`--timeout 10m` is chosen so the assertion cannot pass by accident.** A
   * probe run with a one-second timeout would return in a second whether or
   * not the staged branch exists, and would prove nothing at all — it would
   * measure the timeout, not the fix. Ten minutes is three orders of magnitude
   * above the bound asserted, so a `wait` that fell through to the poll fails
   * this test by hanging rather than by returning the wrong number.
   */
  test("exit 9 with reason staged_untriggered, in well under the timeout", async () => {
    await plantInbox("T-STAGED");
    await plantStagedWorker("T-STAGED");

    const started = Date.now();
    const { exit, stdout } = await runCli(await import("../../src/cli/commands/wait.ts"), [
      "wait",
      "--run",
      RUN_ID,
      "--task",
      "T-STAGED",
      "--timeout",
      "10m",
      "--json",
    ]);
    const elapsedMs = Date.now() - started;

    expect(exit).toBe(9);
    expect(exit).toBe(EXIT.STAGED);
    expect(elapsedMs).toBeLessThan(1_000);

    const payload = JSON.parse(stdout) as {
      exit: number;
      tasks: Array<{ task_id: string; reason: string; verdict: string; worker: string }>;
    };
    expect(payload.exit).toBe(EXIT.STAGED);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0]?.reason).toBe("staged_untriggered");
    // `unknown` and not a verdict of its own: it is the lattice's identity
    // element — "no evidence either way" — which is exactly the state of a task
    // that has not run. The REASON carries the distinction.
    expect(payload.tasks[0]?.verdict).toBe("unknown");
    expect(payload.tasks[0]?.worker).toBe(WORKER);
  });

  /**
   * The exit code is a NUMBER and not only a JSON field, and this arm is why
   * `EXIT.STAGED` was worth adding to the ladder at all.
   *
   * `wait --json` has carried `reason` all along, so a caller that parses JSON
   * could always have seen this. A caller that reads `$?` — every shell script,
   * every CI step, the operations console's own polling — could not, and would
   * have read a staged task as `7 partial`. That is ISC-216's shape: a
   * distinguishable state collapsed into a neighbouring code, answered by
   * investigating a failure that never happened.
   */
  test("the plain-text run reports the same code without --json", async () => {
    await plantInbox("T-STAGED-2");
    await plantStagedWorker("T-STAGED-2");

    const { exit, stdout } = await runCli(await import("../../src/cli/commands/wait.ts"), [
      "wait",
      "--run",
      RUN_ID,
      "--task",
      "T-STAGED-2",
      "--timeout",
      "10m",
    ]);

    expect(exit).toBe(EXIT.STAGED);
    expect(stdout).toContain("staged_untriggered");
    expect(exit).not.toBe(EXIT.PARTIAL);
    expect(exit).not.toBe(EXIT.TIMEOUT);
  });

  /**
   * THE CONTROL ARM, and without it the test above is satisfied by a `wait`
   * that reports every unrecorded task as staged.
   *
   * A worker holding NO staged task, asked about a task with no record, must
   * still wait — that is a running task, and answering it early would turn
   * every in-flight dispatch into a spurious 9. The timeout is deliberately
   * tiny here because the expected behaviour IS to consume it.
   */
  test("a task that is not staged still waits, and times out as before", async () => {
    await plantInbox("T-RUNNING");
    await plantStagedWorker(null);

    const { exit, stdout } = await runCli(await import("../../src/cli/commands/wait.ts"), [
      "wait",
      "--run",
      RUN_ID,
      "--task",
      "T-RUNNING",
      "--timeout",
      "200ms",
      "--json",
    ]);

    expect(exit).toBe(EXIT.TIMEOUT);
    const payload = JSON.parse(stdout) as { tasks: Array<{ reason: string }> };
    expect(payload.tasks[0]?.reason).toBe("wait_timeout");
  });

  /**
   * One worker's staged task must not settle a DIFFERENT task waiting on the
   * same worker — which is why the check is `=== taskId` and not `!== null`.
   *
   * The case is real: a second stage is refused `busy`, so the second task's
   * dispatch failed and it has no record for a reason that has nothing to do
   * with staging. Reporting it as staged would name the wrong remedy — press
   * the key — and pressing it would run the FIRST task.
   */
  test("a different task on a staged worker is not reported as staged", async () => {
    await plantInbox("T-OTHER");
    await plantStagedWorker("T-STAGED");

    const { exit } = await runCli(await import("../../src/cli/commands/wait.ts"), [
      "wait",
      "--run",
      RUN_ID,
      "--task",
      "T-OTHER",
      "--timeout",
      "200ms",
      "--json",
    ]);

    expect(exit).toBe(EXIT.TIMEOUT);
    expect(exit).not.toBe(EXIT.STAGED);
  });
});

// ---------------------------------------------------------------------------
// ISC-457 — `pifleet unstage` reaches `EpochManager.cancel`
// ---------------------------------------------------------------------------

/**
 * A control socket served by THIS process, dispatching `unstage` to the same
 * `handleUnstage` the supervisor dispatches it to.
 *
 * This is the only construction that can answer ISC-457's actual question. The
 * `cancel` property — that a later DIFFERENT attempt against the same
 * `task_id` allocates rather than meeting `already_completed` — belongs to
 * `EpochManager` and is tested there. What is unproven, and what a CLI can get
 * wrong, is whether `pifleet unstage` REACHES it: a command that settled, or
 * that cleared the state file without touching the fence, would leave the
 * worker looking idle and refuse the next stage.
 *
 * The handler is minimal on purpose. Reproducing the supervisor's whole verb
 * table would make this a second implementation of the control plane, and the
 * one line that matters — `handleUnstage` with a real `EpochManager` — is the
 * line the CLI has to arrive at.
 */
async function serveUnstage(
  em: EpochManager,
  state: WorkerState,
): Promise<SocketServer> {
  const secret = (await ensureControlAuth(run)).secret;
  const deps: StageDeps & { shuttingDown: boolean; disarmStagedDeadline: () => void } = {
    em,
    state,
    worker: WORKER,
    persistFence: async () => {},
    flushState: () => writeWorkerState(workerPaths(run, WORKER), state),
    writeProvenance: async () => {},
    ledgerAppend: async () => {},
    logEvent: () => {},
    armDeadlineOnTrigger: () => {},
    shuttingDown: false,
    disarmStagedDeadline: () => {},
  };
  return serveJsonlSocket(
    workerPaths(run, WORKER).controlSock,
    async (msg) => {
      if (msg["cmd"] !== "unstage") return { ok: false, error: `unexpected verb ${String(msg["cmd"])}` };
      return await handleUnstage(
        deps,
        typeof msg["task_id"] === "string" ? msg["task_id"] : "",
        typeof msg["attempt_id"] === "string" ? msg["attempt_id"] : "",
      );
    },
    { secret },
  );
}

describe("pifleet unstage releases the epoch and is not abort (ISC-457)", () => {
  /**
   * ISC-457's probe, run through the command line: stage, cancel, stage a
   * DIFFERENT attempt of the same task, assert it allocates.
   *
   * The third step is the assertion that matters and the reason cancellation
   * must not be `settle`. A settled task pushes a `completed` row into the
   * fence's `attempts` map, and a later attempt would meet `already_completed`
   * — a refusal that reads as "someone else already did this" about a task
   * that never ran once. `cancel` deletes the attempt instead, which is what
   * makes the worker genuinely reusable rather than merely reported as idle.
   */
  test("a released task can be staged again under a different attempt", async () => {
    const em = new EpochManager();
    const state = initialWorkerState({
      worker: WORKER,
      runId: RUN_ID,
      pid: process.pid,
      pgid: process.pid,
      startedAt: "2026-09-02T09:00:00Z",
    });
    const deps: StageDeps = {
      em,
      state,
      worker: WORKER,
      persistFence: async () => {},
      flushState: () => writeWorkerState(workerPaths(run, WORKER), state),
      writeProvenance: async () => {},
      ledgerAppend: async () => {},
      logEvent: () => {},
      armDeadlineOnTrigger: () => {},
    };

    // Stage attempt 1, exactly as `stageForAdoptedTerminal` does: the wire
    // attempt id is `String(envelope.attempt)`, never a fresh uuid (ISC-458).
    const first = await handleStage(deps, envelope("T-CANCEL", { attempt: 1 }), "1", null);
    expect(first).toEqual({ accepted: true, epoch: 1, replayed: false });
    expect(state.staged_task_id).toBe("T-CANCEL");
    await plantInbox("T-CANCEL", 1);

    const server = await serveUnstage(em, state);
    try {
      const { exit, stdout } = await runCli(await import("../../src/cli/commands/unstage.ts"), [
        "unstage",
        "--run",
        RUN_ID,
        "--task",
        "T-CANCEL",
      ]);

      expect(exit).toBe(EXIT.SUCCESS);
      expect(stdout).toContain(`released epoch 1 on worker ${WORKER}`);
      // The second line, and it is printed every time rather than on a flag: an
      // operator told only a number has not been told whether to go looking for
      // a result. There is none — nothing ran.
      expect(stdout).toMatch(/never ran, so nothing was settled/);
    } finally {
      await server.stop();
    }

    // The release reached the FENCE, not just the state file.
    expect(em.live).toBeNull();
    expect(state.staged_task_id).toBeNull();
    expect(state.phase).toBe("idle");

    /**
     * THE PROBE'S THIRD STEP. A different attempt of the SAME task id
     * allocates a fresh epoch. `already_completed` here would mean the CLI had
     * reached `settle` rather than `cancel`, and the worker would be unusable
     * for this task for the rest of the run.
     */
    const retry = await handleStage(deps, envelope("T-CANCEL", { attempt: 2 }), "2", null);
    expect(retry.accepted).toBe(true);
    expect(retry.accepted && retry.replayed).toBe(false);
    expect(retry.accepted && retry.epoch).toBeGreaterThan(1);
  });

  /**
   * The supervisor's OWN refusal sentence reaches the operator, and the
   * `already_started` arm is the one that matters most: it is the single place
   * the CLI tells them to use the other verb.
   *
   * Reconstructing these sentences in the command would be a second spelling
   * that drifts the first time the allocator gains an arm.
   */
  test("a refusal surfaces the supervisor's sentence and exits non-zero", async () => {
    const em = new EpochManager();
    const state = initialWorkerState({
      worker: WORKER,
      runId: RUN_ID,
      pid: process.pid,
      pgid: process.pid,
      startedAt: "2026-09-02T09:00:00Z",
    });
    await writeWorkerState(workerPaths(run, WORKER), state);
    await plantInbox("T-NOTHING", 1);

    const server = await serveUnstage(em, state);
    let message = "";
    try {
      const program = buildProgram();
      (await import("../../src/cli/commands/unstage.ts")).register(program);
      const previous = process.env["PIFLEET_RUNS_DIR"];
      process.env["PIFLEET_RUNS_DIR"] = root;
      try {
        await program.parseAsync(["unstage", "--run", RUN_ID, "--task", "T-NOTHING"], {
          from: "user",
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        expect(exitCodeForError(err)).not.toBe(EXIT.SUCCESS);
      } finally {
        if (previous === undefined) delete process.env["PIFLEET_RUNS_DIR"];
        else process.env["PIFLEET_RUNS_DIR"] = previous;
      }
    } finally {
      await server.stop();
    }

    // `unstageRefusalMessage`'s `no_live_epoch` arm, verbatim from the
    // supervisor rather than reconstructed here.
    expect(message).toContain("has no live epoch");
    expect(message).toContain("nothing staged to release");
  });

  /**
   * `unstage` IS NOT `abort`, and the distinction is asserted rather than left
   * to the reader.
   *
   * `pifleet abort` on a `tui` worker routes to `docker kill --signal=INT`,
   * which the entrypoint's signal trap turns into a graceful STOP of the
   * worker — `src/attended/voided.ts`'s ISC-81 row says so in the table the
   * operator is shown at entry. `unstage` returns the worker to idle with the
   * container still running. An operator who reaches for the wrong one loses a
   * session they are sitting in.
   *
   * Structural, because the alternative is executing `docker kill`. Two
   * assertions: `unstage` never mentions the interrupt machinery, and it says
   * so in the description an operator reads at `pifleet --help`.
   */
  test("unstage neither imports nor mentions the interrupt path", () => {
    const src = readFileSync(`${ROOT}src/cli/commands/unstage.ts`, "utf8");
    const stripped = stripComments(src);
    expect(stripped).not.toContain("planInterrupt");
    expect(stripped).not.toContain("docker kill");
    expect(stripped).not.toContain("INTERRUPT_SIGNAL");
    // The operator-facing half: `--help` has to carry the distinction, because
    // that is where the choice between the two verbs is actually made.
    expect(stripped).toMatch(/NOT abort/);
    expect(stripped).toMatch(/stops the worker/);
  });

  /**
   * ANTI: `abort` is untouched. This block adds a verb beside it and must not
   * have edited it — a `unstage` built by widening `abort` would put the
   * worker-stopping route one flag away from the worker-preserving one.
   */
  test("abort still routes a tui worker to the signal path", () => {
    const abortSrc = stripComments(readFileSync(`${ROOT}src/cli/commands/abort.ts`, "utf8"));
    expect(abortSrc).toContain("planInterrupt");
    expect(abortSrc).toContain("INTERRUPT_SIGNAL");
    expect(abortSrc).not.toContain("unstage");
  });
});

// ---------------------------------------------------------------------------
// `status` names the staged task
// ---------------------------------------------------------------------------

describe("status names the staged task beside the idle phase", () => {
  /**
   * The console defect, read from the other end.
   *
   * `transcriptNote`'s docblock records a status pane printing `tick-1: idle
   * task=- supervisor=up` about a worker that was visibly mid-turn. A worker
   * holding a staged task prints `idle` too — and that reading is CORRECT,
   * because nothing has started. What makes it misleading is what it omits:
   * the epoch is live, the next dispatch will be refused `busy`, and the
   * operator reading `idle` believes the worker is free.
   *
   * The word `staged=` rather than a second bare `task=`: two ids on one line
   * distinguished only by position is a line the reader has to know the format
   * of.
   */
  test("the text line carries staged=<id> next to task=", async () => {
    await plantStagedWorker("T-VISIBLE");

    const { exit, stdout } = await runCli(await import("../../src/cli/commands/status.ts"), [
      "status",
      "--run",
      RUN_ID,
    ]);

    expect(exit).toBe(EXIT.SUCCESS);
    expect(stdout).toContain("staged=T-VISIBLE");
    // The phase is still `idle`, and that is the point: the line does not
    // widen `phase` to say `staged`, it puts the fact beside it (§6.5).
    expect(stdout).toMatch(new RegExp(`${WORKER}: idle .*staged=T-VISIBLE`));
  });

  test("--json carries the field too", async () => {
    await plantStagedWorker("T-VISIBLE");

    const { stdout } = await runCli(await import("../../src/cli/commands/status.ts"), [
      "status",
      "--run",
      RUN_ID,
      "--json",
    ]);

    const payload = JSON.parse(stdout) as {
      workers: Array<{ id: string; phase: string; staged_task_id: string | null }>;
    };
    const w = payload.workers.find((x) => x.id === WORKER);
    expect(w?.staged_task_id).toBe("T-VISIBLE");
    expect(w?.phase).toBe("idle");
  });

  /**
   * THE CONTROL ARM. A worker with nothing staged prints the line it always
   * printed, byte for byte.
   *
   * Every non-`tui` worker in the fleet would otherwise carry a permanently
   * empty column about a mechanism it does not use — the same failure
   * `transcriptNote` returns `null` to avoid, and the reason that function's
   * own control arm asserts the `rpc` line is unchanged.
   */
  test("a worker with nothing staged prints no staged column at all", async () => {
    await plantStagedWorker(null);

    const { stdout } = await runCli(await import("../../src/cli/commands/status.ts"), [
      "status",
      "--run",
      RUN_ID,
    ]);

    expect(stdout).not.toContain("staged=");
    expect(stdout).toContain(`${WORKER}: idle task=- supervisor=up`);
  });
});
