/**
 * Supervisor integration: real subprocesses, real filesystem, no network.
 *
 * What lives here and not in e2e: the process-tree facts (ISC-75..78), the
 * crash-consistency facts (ISC-156), the (pid, start-time) lease identity
 * (ISC-144), and the double's worker-side epoch fence — things provable
 * without driving the whole CLI lifecycle.
 *
 * macOS note: `ps -o sess=` prints 0 for every process, so a session id
 * cannot be compared directly. A new session is instead evidenced by the
 * conjunction that cannot hold for a pane/CLI child: the supervisor is its
 * own process-group leader (`pgid == pid`), has no controlling terminal
 * (`tty == ??`), and reparents to PID 1 when its launcher dies.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEnvelopeSchema, type TaskEnvelope } from "../../src/contracts.ts";
import { RpcClient } from "../../src/rpc/client.ts";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import {
  initialWorkerState,
  readTaskRecord,
  readWorkerState,
  writeWorkerState,
} from "../../src/run/state.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { identityAlive, processStartTime } from "../../src/run/registry.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");
const LAUNCH_TS = join(ROOT_URL, "src/supervisor/launch.ts");

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  // PIFLEET_INT_KEEP leaves roots and processes in place for post-mortem
  // debugging of a failed run; never set in CI.
  if (process.env["PIFLEET_INT_KEEP"] === "1") return;
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-int-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function piCommand(scenario: string): string {
  return `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, scenario)}`;
}

async function psField(pid: number, field: string): Promise<string> {
  const proc = Bun.spawn(["ps", "-o", `${field}=`, "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

async function waitFor(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    if (await cond()) return true;
    if (performance.now() - start > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function makeEnvelope(runId: string, worker: string, taskId: string): TaskEnvelope {
  return TaskEnvelopeSchema.parse({
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: runId,
    epoch: 0,
    attempt: 1,
    worker,
    dispatched_at: new Date().toISOString(),
    title: "integration task",
    brief: "do the integration thing",
    repo: "unset",
    host_workdir: "unset",
    container_workdir: "/workspace",
    branch: `fleet/${runId}/${worker}`,
    base_ref: "0".repeat(40),
    outbox: `/outbox/${taskId}`,
    deadline_s: 300,
  });
}

async function killSupervisor(pid: number, pgid: number): Promise<void> {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

describe("detached supervisor — process tree (ISC-77/78)", () => {
  test(
    "the supervisor is a session leader: pgid == pid, no controlling tty",
    async () => {
      const root = await freshRoot();
      const runId = "int-run-a";
      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        env: { PIFLEET_PI_COMMAND: piCommand("happy.json") },
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));

      // ISC-77: its own process-group leader — nobody's child group.
      expect(pgid).toBe(pid);
      expect((await psField(pid, "pgid")).trim()).toBe(String(pid));

      // ISC-78: a session distinct from the launcher's. macOS ps reports sess
      // as 0 for everything, so assert the observable session-leader facts:
      // no controlling terminal, unlike any pane/CLI child.
      const tty = await psField(pid, "tty");
      expect(tty).toBe("??");

      // And it must have come up for real: state.json reaches idle.
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const idle = await waitFor(
        async () => (await readWorkerState(wp))?.phase === "idle",
        20_000,
      );
      expect(idle).toBe(true);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    30_000,
  );

  test(
    "the supervisor survives its launcher, reparents to PID 1, and the run re-attaches (ISC-75/76)",
    async () => {
      const root = await freshRoot();
      const runId = "int-run-b";
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");

      // A disposable launcher process — the stand-in for a killed CLI. It
      // launches the supervisor, prints the pid, and exits immediately.
      const launcherCode = [
        `const { processLauncher, supervisorArgv } = await import(${JSON.stringify(LAUNCH_TS)});`,
        `const res = await processLauncher.launchDetached({`,
        `  runId: ${JSON.stringify(runId)},`,
        `  runDir: ${JSON.stringify(join(root, runId))},`,
        `  workerId: "eng-1",`,
        `  argv: supervisorArgv({ runsRoot: ${JSON.stringify(root)}, runId: ${JSON.stringify(runId)}, workerId: "eng-1" }),`,
        `  env: { PIFLEET_PI_COMMAND: ${JSON.stringify(piCommand("happy.json"))} },`,
        `  logPath: ${JSON.stringify(join(root, runId, "workers", "eng-1", "supervisor.log"))},`,
        `});`,
        `console.log(JSON.stringify(res));`,
      ].join("\n");
      const launcher = Bun.spawn([process.execPath, "-e", launcherCode], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(launcher.stdout).text();
      const launcherExit = await launcher.exited;
      expect(launcherExit).toBe(0);
      const { pid, pgid } = JSON.parse(out.trim()) as { pid: number; pgid: number };
      cleanups.push(() => killSupervisor(pid, pgid));

      // ISC-75: the launcher is dead; the supervisor is not.
      expect(await processStartTime(pid)).not.toBeNull();

      // Orphaned-and-detached: reparented to PID 1, still group leader.
      const orphaned = await waitFor(async () => (await psField(pid, "ppid")) === "1", 5_000);
      expect(orphaned).toBe(true);
      expect((await psField(pid, "pgid")).trim()).toBe(String(pid));

      const idle = await waitFor(
        async () => (await readWorkerState(wp))?.phase === "idle",
        20_000,
      );
      expect(idle).toBe(true);

      // ISC-76: a brand-new client re-attaches through the durable files and
      // the control socket — no state from the dead launcher required.
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-INT-1"),
        attempt_id: "int-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      const settled = await waitFor(
        async () => (await readTaskRecord(taskRecordPath(wp, "T-INT-1"))) !== null,
        10_000,
      );
      expect(settled).toBe(true);
      const record = await readTaskRecord(taskRecordPath(wp, "T-INT-1"));
      expect(record?.verdict).toBe("success");

      // And `wait` — the CLI, spawned fresh — returns that verdict (ISC-76).
      const cli = Bun.spawn(
        [
          process.execPath,
          join(ROOT_URL, "src/cli/index.ts"),
          "wait",
          "--run",
          runId,
          "--task",
          "T-INT-1",
          "--timeout",
          "10s",
          "--json",
        ],
        { env: { ...process.env, PIFLEET_RUNS_DIR: root }, stdout: "pipe", stderr: "pipe" },
      );
      const waitOut = await new Response(cli.stdout).text();
      expect(await cli.exited).toBe(0);
      const parsed = JSON.parse(waitOut.trim()) as { tasks: Array<{ verdict: string }> };
      expect(parsed.tasks[0]?.verdict).toBe("success");

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    40_000,
  );
});

describe("state.json durability", () => {
  test("round-trips atomically and leaves no tmp file behind", async () => {
    const root = await freshRoot();
    const run = runPaths("int-run-c", root);
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.dir, { recursive: true });

    const state = initialWorkerState({
      worker: "eng-1",
      runId: "int-run-c",
      pid: 4242,
      pgid: 4242,
      startedAt: new Date().toISOString(),
    });
    state.phase = "idle";
    state.session_path = "/tmp/somewhere/2026_x.jsonl";
    await writeWorkerState(wp, state);

    const back = await readWorkerState(wp);
    expect(back).toEqual(state);

    const leftovers = (await readdir(wp.dir)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test(
    "SIGKILL mid-write: the previous state stays readable and the ledger still parses (ISC-156)",
    async () => {
      const root = await freshRoot();
      const runId = "int-run-d";
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.dir, { recursive: true });
      await mkdir(run.ledgerDir, { recursive: true });

      // A writer child hammering both files through the shared primitives.
      // Killed with SIGKILL — no cleanup handler gets to run, which is the
      // point: the atomic-write protocol itself must leave a readable file.
      const jsonlTs = join(ROOT_URL, "src/util/jsonl.ts");
      const writerCode = [
        `const { writeJsonAtomic, appendJsonl } = await import(${JSON.stringify(jsonlTs)});`,
        `const statePath = ${JSON.stringify(wp.stateJson)};`,
        `const ledgerPath = ${JSON.stringify(join(run.ledgerDir, "eng-1.jsonl"))};`,
        `let i = 0;`,
        `for (;;) {`,
        `  await writeJsonAtomic(statePath, {`,
        `    schema: "pifleet.state/v1", worker: "eng-1", run_id: ${JSON.stringify(runId)},`,
        `    pid: process.pid, pgid: process.pid, started_at: new Date().toISOString(),`,
        `    phase: "busy", epoch: 1, turns: i,`,
        `  });`,
        `  await appendJsonl(ledgerPath, {`,
        `    seq: i, ts: new Date().toISOString(), actor: "eng-1",`,
        `    run_id: ${JSON.stringify(runId)}, event: "tick",`,
        `  });`,
        `  i++;`,
        `}`,
      ].join("\n");
      const writer = Bun.spawn([process.execPath, "-e", writerCode], {
        stdout: "ignore",
        stderr: "pipe",
      });

      // Let it complete at least one full cycle, then kill it mid-flight.
      const wrote = await waitFor(
        async () => (await readWorkerState(wp).catch(() => null)) !== null,
        5_000,
      );
      expect(wrote).toBe(true);
      await new Promise((r) => setTimeout(r, 150));
      writer.kill("SIGKILL");
      await writer.exited;

      // The state file is a COMPLETE previous version — rename is the commit
      // point, so a torn write is impossible by construction.
      const state = await readWorkerState(wp);
      expect(state).not.toBeNull();
      expect(state?.schema).toBe("pifleet.state/v1");
      expect(state?.worker).toBe("eng-1");

      // Every complete ledger line parses; at most the final line may be a
      // partial append cut by the kill — one error, never silent corruption.
      const { records, errors } = await mergeLedger(run);
      expect(records.length).toBeGreaterThan(0);
      expect(errors.length).toBeLessThanOrEqual(1);
      for (const r of records) expect(r.event).toBe("tick");
    },
    15_000,
  );
});

describe("lease identity (ISC-144)", () => {
  test("a live pid with a DIFFERENT start time is not the recorded process", async () => {
    // Pid reuse: the number survives, the process it named does not. The
    // lease must compare start time, not existence.
    const started = await processStartTime(process.pid);
    expect(started).not.toBeNull();

    expect(await identityAlive({ pid: process.pid, started: started! })).toBe(true);
    expect(
      await identityAlive({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970" }),
    ).toBe(false);
  });

  test("a dead pid is dead regardless of the recorded start time", async () => {
    // Spawn-and-reap a child so we hold a pid known to be free.
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
    await child.exited;
    expect(await processStartTime(child.pid)).toBeNull();
    expect(await identityAlive({ pid: child.pid, started: "whenever" })).toBe(false);
  });
});

describe("fake-pi worker-side epoch fence", () => {
  test(
    "a prompt at or below the double's high-water-mark is rejected as stale",
    async () => {
      const root = await freshRoot();
      const sessions = join(root, "sessions");
      const fake = Bun.spawn(
        [
          process.execPath,
          FAKE_PI,
          "--scenario",
          join(SCENARIOS, "stale-epoch.json"),
          "--session-dir",
          sessions,
          "--session-id",
          "w1",
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
      );

      const client = new RpcClient(
        { write: (s) => fake.stdin.write(s), flush: () => fake.stdin.flush() },
        { onEvent: () => {} },
      );
      void (async () => {
        for await (const chunk of fake.stdout) client.feed(chunk as Uint8Array);
        client.feedEof();
      })();

      const first = await client.send("prompt", { message: "go", epoch: 1 });
      expect(first.response.success).toBe(true);

      // Same epoch again: the RESOURCE refuses, whatever any allocator thinks.
      const replay = await client.send("prompt", { message: "go again", epoch: 1 });
      expect(replay.response.success).toBe(false);
      expect(replay.response.error).toContain("stale_epoch");

      // And the next epoch is accepted — the fence is a high-water-mark, not a lock.
      const next = await client.send("prompt", { message: "onward", epoch: 2 });
      expect(next.response.success).toBe(true);

      fake.stdin.end();
      await fake.exited;
    },
    15_000,
  );
});
