/**
 * `pifleet steer` against a real detached supervisor (ISC-80).
 *
 * The criterion is ORDERING, not delivery: "injects a message that appears
 * before the next assistant turn." A test that only asserted the CLI's
 * `delivered:true` would still pass with the injection deleted — the ack is
 * the supervisor's, not the agent's. So the load-bearing assertion here reads
 * the worker's session transcript (the event stream Pi itself writes, SRD
 * §8.2's authoritative artifact path) and asserts the steering message's
 * POSITION: after the dispatched prompt, strictly before the next assistant
 * entry. Delete the injection, and the entry is absent; break the ordering,
 * and the index comparison fails. Either way this file goes red.
 *
 * The failure-path tests pin requirement discipline: unknown worker is USAGE
 * naming the worker and the run, dead worker is WORKER_DIED, an idle worker
 * refuses loudly (`no live epoch`) instead of silently succeeding — and none
 * of them may emit a stack trace, because the consumer is an orchestrator
 * switching on the integer (SRD §14.1).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttendedRecordSchema,
  EXIT,
  TaskEnvelopeSchema,
  type TaskEnvelope,
} from "../../src/contracts.ts";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import {
  initialWorkerState,
  readTaskRecord,
  readWorkerState,
  writeWorkerState,
} from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");
const CLI = join(ROOT_URL, "src/cli/index.ts");

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-steer-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Unique per process: socketPath hashes (run_id, worker) into the SHARED
// os.tmpdir(), so a hardcoded run id would collide with a concurrent test
// process and one suite's shutdown would reach the other's supervisor.
const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const testRunId = (name: string): string => `steer-${name}-${RUN_TAG}`;

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
    title: "steer target task",
    brief: "keep working until told otherwise",
    repo: "unset",
    host_workdir: "unset",
    container_workdir: "/workspace",
    branch: `fleet/${runId}/eng-1`,
    base_ref: "0".repeat(40),
    outbox: `/outbox/${taskId}`,
    deadline_s: 300,
  });
}

/** Drive the real CLI, the layer under test — never its internals. */
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

interface TranscriptEntry {
  type: string;
  message?: { role: string; content: Array<{ type: string; text: string }> };
}

function entryText(e: TranscriptEntry): string {
  return (e.message?.content ?? []).map((c) => c.text).join("\n");
}

describe("steer — ISC-80: the message lands before the next assistant turn", () => {
  test(
    "a mid-turn steer appears in the transcript after the prompt and before the assistant entry",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("order");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await launchWorker(root, runId, "slow-turn.json");
      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000),
      ).toBe(true);

      // Dispatch a task whose turn holds the stage for 5s — the window the
      // CLI-spawned steer must land inside.
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "T-STEER-1"),
        attempt_id: "steer-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);
      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "busy", 5_000),
      ).toBe(true);

      // A marker no scenario text contains, so the transcript search cannot
      // false-positive on scripted content.
      const marker = `STEER-MARKER-${RUN_TAG}: prioritize the failing case`;
      const steer = await cli(root, [
        "steer",
        "--worker",
        "eng-1",
        "--run",
        runId,
        "--message",
        marker,
        "--json",
      ]);
      expect(steer.stderr).toBe("");
      expect(steer.code).toBe(0);
      const payload = JSON.parse(steer.stdout.trim()) as Record<string, unknown>;
      expect(payload["delivered"]).toBe(true);
      expect(payload["worker"]).toBe("eng-1");
      expect(payload["run_id"]).toBe(runId);

      // Let the turn complete NATURALLY and the epoch settle.
      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000),
      ).toBe(true);
      expect((await readTaskRecord(taskRecordPath(wp, "T-STEER-1")))?.verdict).toBe("success");

      // The transcript, at the path the SYSTEM recorded (never computed).
      const sessionPath = (await readWorkerState(wp))?.session_path;
      expect(sessionPath).not.toBeNull();
      const lines = (await Bun.file(sessionPath!).text()).trim().split("\n");
      const entries = lines.map((l) => JSON.parse(l) as TranscriptEntry);

      const promptIdx = entries.findIndex(
        (e) => e.message?.role === "user" && entryText(e).includes("steer target task"),
      );
      const steerIdx = entries.findIndex(
        (e) => e.message?.role === "user" && entryText(e).includes(marker),
      );
      const assistantIdx = entries.findIndex((e) => e.message?.role === "assistant");

      // Injection happened at all — absent entry means the steer went nowhere,
      // however confidently the CLI reported delivery.
      expect(steerIdx).toBeGreaterThan(-1);
      // It rode the steering channel, not a second prompt.
      expect(entries[steerIdx]!.type).toBe("steering");
      // THE criterion: after the dispatched prompt...
      expect(steerIdx).toBeGreaterThan(promptIdx);
      // ...and strictly before the next assistant turn (ISC-80). This is the
      // line that fails if steering is buffered until after the turn.
      expect(assistantIdx).toBeGreaterThan(-1);
      expect(steerIdx).toBeLessThan(assistantIdx);

      // The intervention is on the record: the run is now attended-touched.
      const attended = AttendedRecordSchema.parse(await Bun.file(wp.attendedJson).json());
      expect(attended.worker).toBe("eng-1");
      expect(attended.mode).toBe("viewer");
      expect(attended.left_at).not.toBeNull();

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
    },
    // ISC-266 audit: stands. One `steer` spawn derives cliBudget(1) = 11_400 ms;
    // measured idle is 5138 ms, dominated by the real prompt/turn round-trip
    // against fake-pi rather than by startup. Not reduced.
    45_000,
  );

  test(
    "an idle worker refuses the steer by name — never a silent success (requirement 6)",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("idle");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await launchWorker(root, runId, "happy.json");
      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000),
      ).toBe(true);

      const r = await cli(root, [
        "steer",
        "--worker",
        "eng-1",
        "--run",
        runId,
        "--message",
        "anyone listening?",
      ]);
      // Exit 0 here is the silent-success failure this test exists to forbid.
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toContain("no live epoch");
      expect(r.stderr).toContain("eng-1");
      expect(r.stderr).toContain(runId);
      // And no attended record: a refused steer touched nothing.
      expect(await Bun.file(wp.attendedJson).exists()).toBe(false);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
    },
    30_000,
  );
});

describe("steer — worker discipline (requirement 4)", () => {
  test("an unknown worker is USAGE, naming the worker and the run, with no stack trace", async () => {
    const root = await freshRoot();
    const runId = testRunId("ghost");
    await mkdir(join(root, runId), { recursive: true });

    const r = await cli(root, ["steer", "--worker", "ghost", "--run", runId, "-m", "hello"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("ghost");
    expect(r.stderr).toContain(runId);
    // "Never a stack trace": frames look like "    at fn (file:line)".
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  test("a dead worker is WORKER_DIED, not USAGE and not a connect-error trace", async () => {
    const root = await freshRoot();
    const runId = testRunId("dead");
    const run = runPaths(runId, root);
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.dir, { recursive: true });

    // A pid that provably ran and exited: its state file says busy forever,
    // which is exactly what a SIGKILL'd supervisor leaves behind.
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

    const r = await cli(root, ["steer", "--worker", "eng-1", "--run", runId, "-m", "hello"]);
    expect(r.code).toBe(EXIT.WORKER_DIED);
    expect(r.stderr).toContain("eng-1");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});
