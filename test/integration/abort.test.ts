/**
 * `pifleet abort` against a real detached supervisor (ISC-81).
 *
 * The criterion is a PHASE TRANSITION on a REAL CLOCK: "abort returns the
 * worker to idle within 10s." A test that only asserted the CLI's exit code
 * would pass with the abort deleted — the supervisor acks the request before
 * anything is cancelled. So the load-bearing sequence here is: observe
 * `busy`, start the clock, issue the abort through the real CLI, and poll the
 * real supervisor's `state.json` until `idle`, bounding the elapsed time at
 * 10s against a turn scripted to run for 30s. Delete the abort and the turn
 * runs its full 30s; break the settle path and `idle` never comes. Either
 * way the bound fails.
 *
 * The verdict assertion closes the other escape: a worker that went idle
 * because the turn finished NATURALLY records `success`, so `aborted` proves
 * the abort — not the passage of time — is what ended the epoch.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, TaskEnvelopeSchema, type TaskEnvelope } from "../../src/contracts.ts";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import {
  initialWorkerState,
  readTaskRecord,
  readWorkerState,
  writeWorkerState,
} from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";
import { cliBudget } from "../support/budget.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");
const CLI = join(ROOT_URL, "src/cli/index.ts");

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-abort-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Unique per process: the control socket derives from (run_id, worker) in the
// shared os.tmpdir(), and a hardcoded id collides across test processes.
const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const testRunId = (name: string): string => `abort-${name}-${RUN_TAG}`;

const piCommand = (scenario: string): string =>
  `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, scenario)}`;

async function waitFor(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    if (await cond()) return true;
    if (performance.now() - start > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function launchWorker(root: string, runId: string, scenario: string) {
  const res = await processLauncher.launchDetached({
    runId,
    runDir: join(root, runId),
    workerId: "eng-1",
    argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
    env: { PIFLEET_PI_COMMAND: piCommand(scenario) },
    logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
  });
  cleanups.push(async () => {
    try {
      process.kill(-res.pgid, "SIGKILL");
    } catch {
      try {
        process.kill(res.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  return res;
}

function makeEnvelope(runId: string, taskId: string): TaskEnvelope {
  return TaskEnvelopeSchema.parse({
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: runId,
    epoch: 0,
    attempt: 1,
    worker: "eng-1",
    dispatched_at: new Date().toISOString(),
    title: "abort target task",
    brief: "run for thirty seconds unless stopped",
    repo: "unset",
    host_workdir: "unset",
    container_workdir: "/workspace",
    branch: `fleet/${runId}/eng-1`,
    base_ref: "0".repeat(40),
    outbox: `/outbox/${taskId}`,
    deadline_s: 300,
  });
}

async function cli(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, PIFLEET_RUNS_DIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("abort — ISC-81: busy to idle within 10s, on a real clock", () => {
  test(
    "aborting a 30s turn returns the worker to idle in under 10s with verdict aborted",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("main");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await launchWorker(root, runId, "aborted.json");
      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000),
      ).toBe(true);

      // The scenario's turn is scripted for 30s — three times the ISC-81
      // bound — so idle-within-10s can only be the abort's doing.
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "T-ABORT-1"),
        attempt_id: "abort-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      // The transition under test starts from an OBSERVED busy, not an
      // assumed one — otherwise "returned to idle" could mean "never left".
      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "busy", 5_000),
      ).toBe(true);

      // Clock starts BEFORE the CLI spawns: the operator's 10 seconds
      // include the tool's own overhead, not just the supervisor's.
      const t0 = performance.now();
      const abort = await cli(root, ["abort", "--worker", "eng-1", "--run", runId, "--json"]);
      expect(abort.stderr).toBe("");
      expect(abort.code).toBe(0);
      const payload = JSON.parse(abort.stdout.trim()) as Record<string, unknown>;
      // `requested`, not `aborted`: the ack precedes the cancellation, and
      // the payload must not claim a future as a fact.
      expect(payload["requested"]).toBe(true);
      expect(payload["task_id"]).toBe("T-ABORT-1");

      const idle = await waitFor(
        async () => (await readWorkerState(wp))?.phase === "idle",
        10_000,
      );
      const elapsedMs = performance.now() - t0;
      expect(idle).toBe(true);
      // THE criterion, on the real clock.
      expect(elapsedMs).toBeLessThan(10_000);

      // `aborted`, not `success`: proof the abort ended the epoch, rather
      // than the turn quietly finishing on its own.
      expect((await readTaskRecord(taskRecordPath(wp, "T-ABORT-1")))?.verdict).toBe("aborted");

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
    },
    cliBudget(2),
  );

  test(
    "an idle worker refuses the abort by name — never a silent success",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("idle");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await launchWorker(root, runId, "happy.json");
      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000),
      ).toBe(true);

      const r = await cli(root, ["abort", "--worker", "eng-1", "--run", runId]);
      // Exit 0 would teach the operator abort is a spammable no-op — right
      // up until one lands on a task they wanted kept.
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("no live epoch");
      expect(r.stderr).toContain("eng-1");
      expect(r.stderr).toContain(runId);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
    },
    cliBudget(2),
  );
});

describe("abort — worker discipline (requirement 4)", () => {
  test("an unknown worker is USAGE, naming the worker and the run, with no stack trace", async () => {
    const root = await freshRoot();
    const runId = testRunId("ghost");
    await mkdir(join(root, runId), { recursive: true });

    const r = await cli(root, ["abort", "--worker", "ghost", "--run", runId]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("ghost");
    expect(r.stderr).toContain(runId);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }, cliBudget(1));

  test("a dead worker is WORKER_DIED, not USAGE", async () => {
    const root = await freshRoot();
    const runId = testRunId("dead");
    const run = runPaths(runId, root);
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.dir, { recursive: true });

    const corpse = Bun.spawn(["sh", "-c", "exit 0"]);
    await corpse.exited;
    expect(await processStartTime(corpse.pid)).toBeNull();
    const state = initialWorkerState({
      worker: "eng-1",
      runId,
      pid: corpse.pid,
      pgid: corpse.pid,
      startedAt: new Date().toISOString(),
    });
    state.phase = "busy";
    await writeWorkerState(wp, state);

    const r = await cli(root, ["abort", "--worker", "eng-1", "--run", runId]);
    expect(r.code).toBe(EXIT.WORKER_DIED);
    expect(r.stderr).toContain("eng-1");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }, cliBudget(3));
});
