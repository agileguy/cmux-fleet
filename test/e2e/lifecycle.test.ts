/**
 * The Phase 1 exit criterion (SRD §16): `up → dispatch → wait → artifacts`
 * green on the `headless` backend, entirely against `pifleet-fake-pi` — no
 * Docker, no network, no GUI (ISC-19, ISC-128).
 *
 * The CLI is driven as a real subprocess (`Bun.spawn` on `src/cli/index.ts`),
 * never by importing command functions: the exit-code ladder is part of the
 * contract (SRD §10) and only a real process exercises it. Assertions check
 * the INTEGER, not just the JSON.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import { readTaskRecord, readWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { controlCall } from "../../src/supervisor/launch.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT_URL, "src/cli/index.ts");
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fleet {
  /** Per-test scratch base; `runs/` and task files live under it. */
  base: string;
  /** The PIFLEET_RUNS_DIR — task files must never be written here. */
  root: string;
  runId: string;
  env: Record<string, string>;
}

const fleets: Fleet[] = [];
afterAll(async () => {
  // Belt and braces: every fleet is downed by its own test; this catches the
  // ones a failing test left behind so no supervisor outlives the suite.
  for (const f of fleets) {
    await cli(f, ["down", "--run", f.runId, "--json"]).catch(() => {});
    await rm(f.base, { recursive: true, force: true }).catch(() => {});
  }
});

async function cli(fleet: Fleet, args: string[]): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...fleet.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function json<T>(r: CliResult): T {
  return JSON.parse(r.stdout.trim()) as T;
}

/** `up` a one-worker headless fleet against the named scenario. */
async function fleetUp(scenario: string): Promise<Fleet> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-e2e-"));
  const root = join(base, "runs");
  await mkdir(root, { recursive: true });
  const fleet: Fleet = {
    base,
    root,
    runId: "",
    env: {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, scenario)}`,
    },
  };
  const up = await cli(fleet, ["up", "--workers", "eng-1", "--backend", "headless", "--json"]);
  expect(up.code).toBe(0); // ISC-69/70: up succeeds only once every worker is idle
  const parsed = json<{ run_id: string; workers: Array<{ id: string; phase?: string }> }>(up);
  expect(parsed.run_id).toBeTruthy(); // ISC-69: up returns a run_id
  fleet.runId = parsed.run_id;
  fleets.push(fleet);

  /**
   * ISC-195: the sessions directory is bind-mounted rw into every worker, which
   * runs as uid 10001, so `up` must open its mode. Nothing else pinned the call
   * site — deleting the `makeWorkerAccessible` line from `up.ts` left the whole
   * suite green, because the unit tests cover the helper and the headless path
   * never starts a container. Asserting it here binds the helper to its only
   * production caller.
   */
  const sessionsMode = (await stat(join(root, fleet.runId, "sessions"))).mode & 0o777;
  expect(sessionsMode).toBe(0o777);

  return fleet;
}

async function writeTask(
  fleet: Fleet,
  taskId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  // Task files live BESIDE the runs root, never inside it — the root's
  // directory listing is how `latestRunId` resolves the default run.
  const path = join(fleet.base, `${taskId}.task.json`);
  await writeFile(
    path,
    JSON.stringify({
      task_id: taskId,
      title: `e2e ${taskId}`,
      brief: `Perform the scripted work for ${taskId}.`,
      deadline_s: 300,
      ...extra,
    }),
  );
  return path;
}

interface StatusJson {
  run_id: string;
  workers: Array<{
    id: string;
    alive: boolean;
    phase: string | null;
    task_id: string | null;
    session_path: string | null;
    session_present: boolean;
    pid: number | null;
    completed_epochs: number[];
  }>;
}

interface WaitJson {
  run_id: string;
  exit: number;
  tasks: Array<{ task_id: string; verdict: string; reason: string; epoch: number | null }>;
}

async function waitUntil(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    if (await cond()) return true;
    if (performance.now() - start > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("e2e — the Phase 1 exit criterion", () => {
  test(
    "happy path: up → dispatch → wait → artifacts, idempotent re-dispatch, clean down",
    async () => {
      const fleet = await fleetUp("happy.json");
      const run = runPaths(fleet.runId, fleet.root);
      const wp = workerPaths(run, "eng-1");

      // Dispatch — accepted, epoch 1 (accepted ≠ started, SRD §7.5).
      const taskFile = await writeTask(fleet, "T-001");
      const d = await cli(fleet, ["dispatch", "--worker", "eng-1", "--task", taskFile, "--json"]);
      expect(d.code).toBe(0);
      const dj = json<{ accepted: boolean; epoch: number }>(d);
      expect(dj.accepted).toBe(true);
      expect(dj.epoch).toBe(1);

      // Wait — settles success, exit 0.
      const w = await cli(fleet, ["wait", "--task", "T-001", "--timeout", "15s", "--json"]);
      expect(w.code).toBe(0);
      const wj = json<WaitJson>(w);
      expect(wj.tasks[0]?.verdict).toBe("success");
      expect(wj.tasks[0]?.epoch).toBe(1);

      // Artifacts, harvested from disk:
      // (a) the task record;
      const record = await readTaskRecord(taskRecordPath(wp, "T-001"));
      expect(record?.verdict).toBe("success");

      // (b) the session transcript at the VERBATIM path get_state reported
      // (ISC-95) — the dispatched task appears as a UserMessage (ISC-79);
      const st = json<StatusJson>(await cli(fleet, ["status", "--run", fleet.runId, "--json"]));
      const worker = st.workers[0]!;
      expect(worker.session_path).toBeTruthy();
      expect(existsSync(worker.session_path!)).toBe(true);
      const transcript = await Bun.file(worker.session_path!).text();
      expect(transcript).toContain('"role":"user"');
      expect(transcript).toContain("Perform the scripted work for T-001");

      // (c) the absent→present transition was observed (ISC-96);
      const present = await waitUntil(async () => {
        const s = json<StatusJson>(await cli(fleet, ["status", "--run", fleet.runId, "--json"]));
        return s.workers[0]?.session_present === true;
      }, 3_000);
      expect(present).toBe(true);

      // (d) the event stream exists and recorded the run.
      expect(existsSync(wp.eventsJsonl)).toBe(true);

      // ISC-85: re-dispatching the completed task is a NO-OP, exit 0.
      const again = await cli(fleet, [
        "dispatch",
        "--worker",
        "eng-1",
        "--task",
        taskFile,
        "--json",
      ]);
      expect(again.code).toBe(0);
      const aj = json<{ accepted: boolean; reason: string; verdict: string }>(again);
      expect(aj.accepted).toBe(false);
      expect(aj.reason).toBe("already_completed");
      expect(aj.verdict).toBe("success");

      // ISC-72/73: down leaves neither supervisor nor worker process.
      const supPid = worker.pid!;
      const down = await cli(fleet, ["down", "--run", fleet.runId, "--json"]);
      expect(down.code).toBe(0);
      expect(json<{ clean: boolean }>(down).clean).toBe(true);
      expect(await processStartTime(supPid)).toBeNull();
    },
    45_000,
  );

  test(
    "status reflects busy within 2s of dispatch; abort settles aborted, worker returns to idle",
    async () => {
      const fleet = await fleetUp("aborted.json");
      const run = runPaths(fleet.runId, fleet.root);

      const taskFile = await writeTask(fleet, "T-AB");
      const d = await cli(fleet, ["dispatch", "--worker", "eng-1", "--task", taskFile, "--json"]);
      expect(json<{ accepted: boolean }>(d).accepted).toBe(true);

      // ISC-71: busy visible within 2s of dispatch.
      const t0 = performance.now();
      const st = json<StatusJson>(await cli(fleet, ["status", "--run", fleet.runId, "--json"]));
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(st.workers[0]?.phase).toBe("busy");
      expect(st.workers[0]?.task_id).toBe("T-AB");

      // Abort (the CLI abort command is outside this phase's scope; the
      // control socket is the same path it will use).
      const abortReply = await controlCall(run, "eng-1", { cmd: "abort" });
      expect(abortReply["ok"]).toBe(true);

      // ISC-83: aborted, never success. ISC-81: idle again, well under 10s.
      const w = await cli(fleet, ["wait", "--task", "T-AB", "--timeout", "10s", "--json"]);
      expect(w.code).toBe(7); // aborted ranks as PARTIAL on the ladder
      const wj = json<WaitJson>(w);
      expect(wj.tasks[0]?.verdict).toBe("aborted");
      expect(wj.tasks[0]?.verdict).not.toBe("success");

      const idle = await waitUntil(async () => {
        const s = json<StatusJson>(await cli(fleet, ["status", "--run", fleet.runId, "--json"]));
        return s.workers[0]?.phase === "idle";
      }, 10_000);
      expect(idle).toBe(true);

      await cli(fleet, ["down", "--run", fleet.runId, "--json"]);
    },
    45_000,
  );

  test(
    "will-retry: not reported complete on the first agent_end (ISC-82)",
    async () => {
      const fleet = await fleetUp("will-retry.json");
      const run = runPaths(fleet.runId, fleet.root);
      const wp = workerPaths(run, "eng-1");

      const taskFile = await writeTask(fleet, "T-RT");
      const d = await cli(fleet, ["dispatch", "--worker", "eng-1", "--task", taskFile, "--json"]);
      expect(json<{ accepted: boolean }>(d).accepted).toBe(true);

      /**
       * The first `agent_end{willRetry:true}` is emitted at ack time; the real
       * end comes ~200ms later.
       *
       * This used to `sleep(50)` and assert the record was null, which proved
       * nothing: 50ms is shorter than observe→probe→get_state→settle→write, so
       * the record is null whether or not `willRetry` is honoured. Changing
       * `completion.ts` to ignore `willRetry` entirely left this green.
       *
       * Instead: wait for the retrying `agent_end` to actually be OBSERVED —
       * a positive signal, not a timer — and only then assert that nothing
       * settled.
       *
       * Be clear about what this does and does not prove. It removes the race,
       * but it does NOT discriminate a build that ignores `willRetry`: the
       * double reports `isStreaming: true` for a retrying `agent_end`
       * (`test/fixtures/fake-pi.ts`), so completion condition 4 fails whatever
       * condition 1 decided, and mutating `completion.ts` to ignore `willRetry`
       * leaves this file green. That mutation IS caught — by
       * `test/unit/completion.test.ts`, which fails 3 assertions — and that is
       * where the coverage for ISC-82 actually lives. Claiming it here would be
       * the same fixture-property error this comment block was written to
       * correct, one level up.
       */
      const sawRetryEnd = await waitUntil(async () => {
        const text = await Bun.file(wp.eventsJsonl)
          .text()
          .catch(() => "");
        return text.includes('"agent_end"');
      }, 10_000);
      expect(sawRetryEnd).toBe(true);

      expect(await readTaskRecord(taskRecordPath(wp, "T-RT"))).toBeNull();
      expect((await readWorkerState(wp))?.phase).toBe("busy");

      // And after the retry completes, it settles success.
      const w = await cli(fleet, ["wait", "--task", "T-RT", "--timeout", "15s", "--json"]);
      expect(w.code).toBe(0);
      expect(json<WaitJson>(w).tasks[0]?.verdict).toBe("success");

      await cli(fleet, ["down", "--run", fleet.runId, "--json"]);
    },
    45_000,
  );

  test(
    "the §7.5 interleave: epoch N's work is never attributed to N+1 (ISC-84)",
    async () => {
      const fleet = await fleetUp("interleave.json");
      const run = runPaths(fleet.runId, fleet.root);
      const wp = workerPaths(run, "eng-1");

      // Epoch 1: dispatch, then abort BEFORE the turn's natural completion at
      // +150ms — the scenario's abort lands nowhere (emits nothing), so the
      // natural agent_end arrives after the abort was requested: the SRD §7.5
      // interleaving.
      const t4 = await writeTask(fleet, "T-004");
      const d4 = await cli(fleet, ["dispatch", "--worker", "eng-1", "--task", t4, "--json"]);
      expect(json<{ accepted: boolean; epoch: number }>(d4).epoch).toBe(1);
      await new Promise((r) => setTimeout(r, 30));
      await controlCall(run, "eng-1", { cmd: "abort" });

      const w4 = await cli(fleet, ["wait", "--task", "T-004", "--timeout", "10s", "--json"]);
      const w4j = json<WaitJson>(w4);
      expect(w4j.tasks[0]?.verdict).toBe("aborted");
      expect(w4j.tasks[0]?.epoch).toBe(1);

      // Epoch 2: T-005's prompt emits NOTHING. The only way it could ever
      // "complete" is by stealing epoch 1's straggler terminal event.
      const t5 = await writeTask(fleet, "T-005");
      const d5 = await cli(fleet, ["dispatch", "--worker", "eng-1", "--task", t5, "--json"]);
      expect(json<{ accepted: boolean; epoch: number }>(d5).epoch).toBe(2);

      // Outlive the straggler (at +550ms from epoch 1's prompt) generously.
      await new Promise((r) => setTimeout(r, 900));

      // ISC-84: T-005 must NOT be settled — not by the straggler, not by
      // anything. T-004 keeps its own epoch and verdict.
      expect(await readTaskRecord(taskRecordPath(wp, "T-005"))).toBeNull();
      const st = json<StatusJson>(await cli(fleet, ["status", "--run", fleet.runId, "--json"]));
      expect(st.workers[0]?.task_id).toBe("T-005");
      expect(st.workers[0]?.phase).toBe("busy");
      expect(st.workers[0]?.completed_epochs).toEqual([1]);

      // The straggler was recorded as a prior-epoch event, not discarded
      // silently and not counted toward anything live.
      const events = await Bun.file(wp.eventsJsonl).text();
      expect(events).toContain('"epoch_attribution"');
      expect(events).toContain('"prior"');

      await cli(fleet, ["down", "--run", fleet.runId, "--json"]);
    },
    45_000,
  );

  test(
    "late-failure: prompt acks accepted, then the late success:false fails the epoch (ISC-86)",
    async () => {
      const fleet = await fleetUp("late-failure.json");

      const taskFile = await writeTask(fleet, "T-LF");
      const d = await cli(fleet, ["dispatch", "--worker", "eng-1", "--task", taskFile, "--json"]);
      // Accepted means accepted — the ack arrived before the failure did.
      expect(d.code).toBe(0);
      expect(json<{ accepted: boolean }>(d).accepted).toBe(true);

      // ISC-86 + exit ladder: the failed task makes the run exit 7.
      const w = await cli(fleet, ["wait", "--task", "T-LF", "--timeout", "10s", "--json"]);
      expect(w.code).toBe(7);
      const wj = json<WaitJson>(w);
      expect(wj.tasks[0]?.verdict).toBe("failed");
      expect(wj.tasks[0]?.reason).toContain("late_prompt_failure");

      await cli(fleet, ["down", "--run", fleet.runId, "--json"]);
    },
    45_000,
  );

  test(
    "queue-race: quiet gauge samples never beat queued output; wait times out with exit 4",
    async () => {
      const fleet = await fleetUp("queue-race.json");

      const taskFile = await writeTask(fleet, "T-QR");
      const d = await cli(fleet, ["dispatch", "--worker", "eng-1", "--task", taskFile, "--json"]);
      expect(json<{ accepted: boolean }>(d).accepted).toBe(true);

      // Both get_state reads say quiet, but a non-empty queue_update lands
      // between them every time: the task must never settle (ISC-147), and
      // wait's own deadline is a TIMEOUT — exit 4, not a dead worker.
      const w = await cli(fleet, ["wait", "--task", "T-QR", "--timeout", "1s", "--json"]);
      expect(w.code).toBe(4);
      const wj = json<WaitJson>(w);
      expect(wj.tasks[0]?.verdict).toBe("unknown");
      expect(wj.tasks[0]?.reason).toBe("wait_timeout");

      await cli(fleet, ["down", "--run", fleet.runId, "--json"]);
    },
    45_000,
  );

  test(
    "deadline: a task exceeding deadline_s is timed_out with exit 4",
    async () => {
      const fleet = await fleetUp("aborted.json"); // 30s turn, never finishes alone

      const taskFile = await writeTask(fleet, "T-DL", { deadline_s: 1 });
      const d = await cli(fleet, ["dispatch", "--worker", "eng-1", "--task", taskFile, "--json"]);
      expect(json<{ accepted: boolean }>(d).accepted).toBe(true);

      const w = await cli(fleet, ["wait", "--task", "T-DL", "--timeout", "20s", "--json"]);
      expect(w.code).toBe(4);
      expect(json<WaitJson>(w).tasks[0]?.verdict).toBe("timed_out");

      await cli(fleet, ["down", "--run", fleet.runId, "--json"]);
    },
    45_000,
  );
});
