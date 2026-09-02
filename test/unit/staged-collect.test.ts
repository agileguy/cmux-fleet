/**
 * `collect` recognises a staged-but-untriggered task (ISC-451, second half).
 *
 * ## Why this file exists separately from `staged-report.test.ts`
 *
 * It was written because a mutation SURVIVED. `staged-report.test.ts` drives
 * `renderRunReport` with a hand-built `RunReport` whose schedule row already
 * says `staged`, so it proves the renderer says the right thing about a fact
 * somebody else established. Deleting the DETECTION — making `schedStateFor`
 * return `"dispatched"` unconditionally — left every one of those seventeen
 * tests green.
 *
 * That is the degenerate-fixture shape: a probe whose input already contains
 * the answer cannot see the code that was supposed to produce it. So this file
 * starts one step earlier, from files on disk, and asserts the state that comes
 * out the other end.
 *
 * ## The distinction being measured, and the reason it is not "no task record"
 *
 * A task with no task record is one that has not FINISHED, which includes every
 * task currently running. Staged is the narrower fact that nobody has STARTED
 * it. The three fixtures below are identical except for the one field that
 * separates them — `staged_task_id` on the owning worker's state — because a
 * fixture set in which the staged and running cases differ in more than that
 * cannot show which difference the code is reading.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRunReport } from "../../src/report/collect.ts";
import { runPaths } from "../../src/run/paths.ts";

const RUN_ID = `staged-collect-${process.pid.toString(36)}`;
let tmp: string;
let runsDir: string;
let runDir: string;

function envelope(taskId: string, worker: string): Record<string, unknown> {
  return {
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: RUN_ID,
    // NOT 1. A worker's first task allocates 1, so a fixture that uses 1
    // everywhere agrees with a hard-coded default by coincidence — the exact
    // accident the old `tui` route's epoch-0-on-both-sides gate was.
    epoch: 7,
    attempt: 1,
    worker,
    dispatched_at: new Date().toISOString(),
    title: taskId,
    brief: "staged collect fixture",
    repo: "unset",
    host_workdir: "unset",
    container_workdir: "/workspace",
    branch: `fleet/${RUN_ID}/${worker}`,
    base_ref: "d".repeat(40),
    outbox: `/outbox/${taskId}`,
    deadline_s: 1500,
  };
}

/** A supervisor state file, with the one field under test as a parameter. */
async function workerState(worker: string, stagedTaskId: string | null): Promise<void> {
  await mkdir(join(runDir, "workers", worker), { recursive: true });
  await writeFile(
    join(runDir, "workers", worker, "state.json"),
    JSON.stringify({
      schema: "pifleet.state/v1",
      worker,
      run_id: RUN_ID,
      pid: process.pid,
      pgid: process.pid,
      started_at: new Date().toISOString(),
      // `idle` on BOTH fixtures. A staged worker's phase stays idle by design
      // (the agent is not running anything), so phase cannot be the
      // discriminator and the test must not let it become one by accident.
      phase: "idle",
      epoch: stagedTaskId === null ? 0 : 7,
      task_id: stagedTaskId,
      staged_task_id: stagedTaskId,
    }),
  );
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-staged-collect-"));
  runsDir = join(tmp, "runs");
  runDir = join(runsDir, RUN_ID);
  await mkdir(join(runDir, "inbox"), { recursive: true });
  await mkdir(join(runDir, "ledger"), { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID }));

  // T-staged: the epoch is allocated, nobody pressed the key.
  await writeFile(
    join(runDir, "inbox", "T-staged.json"),
    JSON.stringify(envelope("T-staged", "tui-1")),
  );
  await workerState("tui-1", "T-staged");

  // T-running: THE CONTROL. Same shape, same absent task record, same idle
  // phase — and no staged claim. If this renders as staged, the detection is
  // reading "unsettled" rather than "unstarted".
  await writeFile(
    join(runDir, "inbox", "T-running.json"),
    JSON.stringify(envelope("T-running", "rpc-1")),
  );
  await workerState("rpc-1", null);

  // The ledger proves the ROUTE, which is a different fact from the state.
  const row = (event: string, task: string, worker: string, via?: string): string =>
    `${JSON.stringify({
      seq: 0,
      ts: new Date().toISOString(),
      actor: "cli-dispatch-1",
      run_id: RUN_ID,
      event,
      task_id: task,
      worker,
      ...(via === undefined ? {} : { detail: { via } }),
    })}\n`;
  await writeFile(
    join(runDir, "ledger", "cli-dispatch-1.jsonl"),
    row("dispatched", "T-staged", "tui-1", "staged") + row("dispatched", "T-running", "rpc-1", "rpc"),
  );
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const collect = () =>
  collectRunReport(runPaths(RUN_ID, runsDir), { precheck: async () => [] });

describe("a staged task is collected as staged, and a running one is not", () => {
  test("the staged task's schedule row says staged", async () => {
    const { report } = await collect();
    const row = report.schedule.find((r) => r.task_id === "T-staged");
    expect(row, "T-staged is missing from the schedule").toBeDefined();
    expect(row!.state).toBe("staged");
  });

  /**
   * THE CONTROL, and the whole reason this file is not one test. Without it,
   * "returns staged" is satisfied by a function that returns `staged` for
   * everything unsettled — which is most of a live run.
   */
  test("the running task's row still says dispatched", async () => {
    const { report } = await collect();
    const row = report.schedule.find((r) => r.task_id === "T-running");
    expect(row, "T-running is missing from the schedule").toBeDefined();
    expect(row!.state).toBe("dispatched");
  });

  test("the rendered report names the staged task and not the running one", async () => {
    const { report } = await collect();
    const staged = report.schedule.filter((r) => r.state === "staged").map((r) => r.task_id);
    expect(staged).toEqual(["T-staged"]);
  });
});

describe("the route is read from the ledger, not from the state", () => {
  /**
   * `stagedWorkers` and `staged` answer different questions and must not be
   * derived from one another: a worker stays on the staged ROUTE after its
   * task is triggered, at which point `staged_task_id` is cleared. Keying the
   * report's voided table off the state would silently revert a triggered
   * worker's table to the mode's, mid-run.
   */
  test("the worker that took a staged dispatch is named", async () => {
    const { stagedWorkers } = await collect();
    expect(stagedWorkers).toEqual(["tui-1"]);
  });

  test("a worker dispatched by rpc is not", async () => {
    const { stagedWorkers } = await collect();
    expect(stagedWorkers).not.toContain("rpc-1");
  });
});
