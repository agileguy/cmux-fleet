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

/**
 * A run id no other process on this machine will pick.
 *
 * The scratch ROOT is already unique per test, but the control socket is not
 * derived from it: `socketPath` hashes `(run_id, worker_id)` into
 * `os.tmpdir()`, deliberately, so the CLI can find a live supervisor without a
 * lookup. `os.tmpdir()` is shared by every process on the box — so two test
 * processes using a hardcoded `int-run-a` derive the SAME socket, and one
 * test's `shutdown` reaches the other's supervisor.
 *
 * That is what made these tests flaky, and the symptom pointed the wrong way:
 * the supervisor "died" mid-test, which is exactly what the ISC-212 probe
 * exists to detect, so a cross-process collision read as the defect under
 * test. Unique ids per process fix it at the source; raising the timeouts
 * would only have made the collision rarer.
 */
const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const testRunId = (name: string): string => `int-run-${name}-${RUN_TAG}`;

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

/** The worker's `events.jsonl`, parsed; empty until the supervisor writes one. */
async function readEvents(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await Bun.file(path)
    .text()
    .catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
      const runId = testRunId("a");
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
      //
      // The glyph for "no tty" is platform-specific — BSD ps prints `??`,
      // procps prints `?` — so match the invariant rather than the spelling.
      // Asserting the macOS glyph made this pass locally and fail in CI.
      const tty = (await psField(pid, "tty")).trim();
      expect(tty).toMatch(/^\?+$/);

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
      const runId = testRunId("b");
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
    const run = runPaths(testRunId("c"), root);
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.dir, { recursive: true });

    const state = initialWorkerState({
      worker: "eng-1",
      runId: testRunId("c"),
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
      const runId = testRunId("d");
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

/**
 * The unhandled-rejection guards on `settle()` (ISC-212).
 *
 * Round 2 found two `void settle(...)` sites with no `.catch()`. `settle()`
 * awaits `persistFence`, `writeTaskRecord`, `flushState` and `ledger.append` —
 * four unguarded disk writes — so an ENOSPC or EROFS rejects it, and a bare
 * `void p.finally(...)` re-raises that as an unhandled rejection which exits
 * the supervisor: child killed, no `worker_exit` row, no deregistration, and
 * `state.json` frozen mid-transition leaving the run unreapable.
 *
 * Round 3 then found the fix had NO test — removing either `.catch()` left the
 * suite at 228 pass. This is that test. It makes the writes genuinely fail by
 * revoking write permission on the worker directory, drives the deadline
 * escalation with an agent that ignores `abort`, and asserts the one thing that
 * distinguishes a guarded rejection from an unguarded one: the supervisor is
 * still running afterwards.
 */
describe("settle() failure does not kill the supervisor (ISC-212)", () => {
  test(
    "a deadline escalation whose durable writes all fail leaves the supervisor alive",
    async () => {
      const { chmod } = await import("node:fs/promises");
      const root = await freshRoot();
      const runId = testRunId("settlefail");
      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        env: { PIFLEET_PI_COMMAND: piCommand("deaf-abort.json") },
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));

      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      expect(await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000)).toBe(
        true,
      );

      // A deadline short enough to fire during the test, against an agent that
      // will not answer `abort` — so the 5s escalation ladder is reached.
      const envelope = makeEnvelope(runId, "eng-1", "T-SETTLEFAIL");
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: { ...envelope, deadline_s: 1 },
        attempt_id: "int-attempt-settlefail",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      // Make ONLY the task-record write fail: 0555 on `tasks/` keeps it
      // readable but refuses new files, so writeTaskRecord's temp-file create
      // returns EACCES while state.json and fence.json still write normally.
      //
      // Revoking the whole worker directory does NOT work as a probe: a failed
      // fence write deliberately triggers beginShutdown(), so the supervisor
      // exits on purpose and the test cannot tell an orderly shutdown from an
      // unhandled-rejection death — which is what it exists to distinguish.
      await chmod(wp.tasksDir, 0o555);
      cleanups.push(async () => {
        await chmod(wp.tasksDir, 0o755).catch(() => {});
      });

      // Wait for the escalation to have HAPPENED, rather than sleeping for as
      // long as it usually takes. A fixed `setTimeout(9_000)` here — deadline
      // 1s + ABORT_GRACE_MS 5s + margin — is the same anti-pattern this suite
      // avoids everywhere else: on a loaded machine the escalation lands after
      // the sleep and the assertion below reads a supervisor that has not yet
      // been asked to do the failing write, so the test passes without
      // exercising anything.
      //
      // The observable event is the epoch leaving the fence: the supervisor
      // settles the task (failing to record it) and returns to idle.
      const escalated = await waitFor(async () => {
        const s = await readWorkerState(wp);
        return s !== null && s.phase !== "busy";
      }, 30_000);
      expect(escalated).toBe(true);

      // THE assertion. An unhandled rejection exits the process; a caught one
      // does not. Nothing else here distinguishes the two.
      expect(await processStartTime(pid)).not.toBeNull();

      // And it is still answering, not merely un-exited.
      await chmod(wp.tasksDir, 0o755);
      const pong = await controlCall(run, "eng-1", { cmd: "ping" }).catch(() => null);
      expect(pong).not.toBeNull();

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    45_000,
  );

  /**
   * ISC-228. The ISC-212 fix guarded TWO `void settle(...)` sites, and only the
   * deadline escalation above was ever driven — so the `.catch()` on the
   * `late_prompt_failure` site could be deleted with the suite still green,
   * which is precisely the hole round 3 exists to close. The two are not
   * interchangeable: they are different call sites, reached by different
   * events, and one is a timer while the other runs inside the stray-response
   * handler on the RPC read loop.
   *
   * The condition is scenarios/late-failure.json: `prompt` acks success, then a
   * SECOND response with the same id arrives `success:false` while that epoch is
   * still live. That the late failure FAILS the epoch is proved elsewhere (the
   * e2e lifecycle run asserts the recorded reason); what is proved here is that
   * when the settle it triggers cannot write, the supervisor survives it.
   *
   * The write is broken BEFORE dispatch: the late response lands 150ms after
   * the ack, which leaves no room to revoke permission afterwards.
   */
  test(
    "a late prompt failure whose durable writes fail leaves the supervisor alive",
    async () => {
      const { chmod } = await import("node:fs/promises");
      const root = await freshRoot();
      const runId = testRunId("latefail");
      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        env: { PIFLEET_PI_COMMAND: piCommand("late-failure.json") },
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));

      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      expect(await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000)).toBe(
        true,
      );

      // Same probe as the deadline test: 0555 on `tasks/` refuses the temp file
      // writeTaskRecord creates, while fence.json and state.json — whose
      // failure deliberately triggers an orderly shutdown, which this test
      // could not tell from a crash — keep working.
      await chmod(wp.tasksDir, 0o555);
      cleanups.push(async () => {
        await chmod(wp.tasksDir, 0o755).catch(() => {});
      });

      // The envelope's own deadline (300s) cannot fire inside this test, so the
      // only settle reachable here is the late failure's.
      const envelope = makeEnvelope(runId, "eng-1", "T-LATEFAIL");
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope,
        attempt_id: "int-attempt-latefail",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      // The guard firing IS the observable: `settle_failed` is written by the
      // `.catch()` under test. Without it the rejection is unhandled, which in
      // Bun exits the process — so this never appears and the assertions below
      // never get the chance to run.
      const guarded = await waitFor(async () => {
        const events = await readEvents(wp.eventsJsonl);
        return events.some((e) => e["type"] === "settle_failed");
      }, 30_000);
      expect(guarded).toBe(true);

      const events = await readEvents(wp.eventsJsonl);
      // It is THAT settle: a late, failing response on the live prompt id...
      expect(
        events.some(
          (e) => e["type"] === "stray_response" && e["kind"] === "late" && e["success"] === false,
        ),
      ).toBe(true);
      // ...and not the deadline escalation wearing the same event name.
      expect(events.some((e) => e["type"] === "deadline_exceeded")).toBe(false);

      // THE assertion. An unhandled rejection exits the process; a caught one
      // does not.
      expect(await processStartTime(pid)).not.toBeNull();

      // And it is still answering, not merely un-exited.
      await chmod(wp.tasksDir, 0o755);
      const pong = await controlCall(run, "eng-1", { cmd: "ping" }).catch(() => null);
      expect(pong).not.toBeNull();

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    45_000,
  );
});
