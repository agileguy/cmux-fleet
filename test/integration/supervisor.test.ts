/**
 * Supervisor integration: real subprocesses, real filesystem, no network.
 *
 * What lives here and not in e2e: the process-tree facts (ISC-75..78), the
 * epoch high-water-mark's durability across a crash (ISC-143), the
 * (pid, start-time) lease identity (ISC-144), and the double's worker-side
 * epoch fence — things provable without driving the whole CLI lifecycle.
 *
 * ISC-156 — the atomic-write protocol itself under a SIGKILL at each syscall
 * boundary — is pinned one layer down, in `test/unit/jsonl.test.ts`, against
 * `writeJsonAtomic` directly. What the ISC-143 block below adds is the
 * supervisor's USE of it: that the fence reaches disk before a prompt does.
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
import { runPaths, taskRecordPath, workerPaths, type WorkerPaths } from "../../src/run/paths.ts";
import {
  initialWorkerState,
  readFence,
  readTaskRecord,
  readWorkerState,
  writeFence,
  writeWorkerState,
} from "../../src/run/state.ts";
import type { FenceSnapshot } from "../../src/rpc/epoch.ts";
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

/**
 * Wait for a supervisor that is idle AND still running.
 *
 * `state.json` outlives the process that wrote it, so a bare
 * `phase === "idle"` is satisfied by a DEAD supervisor's last words — which is
 * how the restart half of the ISC-143 block first "passed" in 120ms and then
 * failed connecting to a socket nobody was listening on. Every gate in this
 * file goes through here so the next one added inherits the fix; the same gate
 * in production is `up`'s ISC-70 readiness loop.
 *
 * Liveness is the (pid, start-time) identity, not the pid alone: the number is
 * reused, and a bare pid check is exactly the hazard ISC-144 closes.
 */
async function waitForIdle(wp: WorkerPaths, pid: number, budgetMs = 20_000): Promise<boolean> {
  const started = await processStartTime(pid);
  if (started === null) return false; // never came up, or already gone
  return waitFor(async () => {
    const s = await readWorkerState(wp);
    if (s === null || s.phase !== "idle" || s.pid !== pid) return false;
    return identityAlive({ pid, started });
  }, budgetMs);
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
      expect(await waitForIdle(wp, pid)).toBe(true);

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

      expect(await waitForIdle(wp, pid)).toBe(true);

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
});

/**
 * ISC-143, one case per syscall boundary of the fence write.
 *
 * This replaces a test that spawned a writer, slept 150ms, sent SIGKILL, and
 * asserted the state file still parsed. That kill landed wherever the
 * scheduler put it — it proved ONE of the five steps of `writeJsonAtomic` and
 * could not say which, and reported the same PASS for a kill before the first
 * byte as for one after the directory fsync. `test/fixtures/kill-at-boundary.ts`
 * replaces the sleep: the supervisor kills ITSELF the instant a named step of
 * the fence write returns, and the trace it leaves names the step.
 *
 * What is under test here is not `writeJsonAtomic` — `test/unit/jsonl.test.ts`
 * pins that directly — but the supervisor's use of it. The high-water-mark is
 * durable BEFORE the prompt goes out (SRD §7.5), so the invariant a restart
 * must honour is:
 *
 *     the next epoch issued is strictly greater than the highest epoch in
 *     whatever COMPLETE version of fence.json survived the crash
 *
 * with "complete version" doing real work: a torn fence.json is not a smaller
 * high-water-mark, it is an unreadable one, and a supervisor that cannot read
 * its fence cannot safely allocate at all.
 *
 * Each run starts from a seeded fence in which epoch 1 was allocated,
 * dispatched and settled. That epoch is the one that must never come back —
 * a re-issue of 1 would hand a second worker the epoch the first one already
 * ran under, which is precisely the interleaving §7.5 exists to make
 * impossible. Epoch 2, the one being written when the kill lands, may be
 * re-used at the boundaries where the write never committed: its prompt was
 * never sent, because `persistFence()` is awaited first, so no worker has
 * ever seen it.
 */
describe("epoch fence durability across a SIGKILL (ISC-143)", () => {
  const FIXTURE = join(ROOT_URL, "test/fixtures/kill-at-boundary.ts");
  const SUPERVISOR_TS = join(ROOT_URL, "src/supervisor/index.ts");

  /**
   * `attemptKey` from rpc/epoch.ts, which is private to that module.
   *
   * Spelled with `String.fromCharCode` rather than an escape so this file
   * carries no literal NUL byte — one embedded in the source makes `grep`
   * treat the whole test suite as binary.
   */
  const attemptKey = (taskId: string, attemptId: string): string =>
    `${taskId}${String.fromCharCode(0)}${attemptId}`;

  /** The fence as a previous incarnation left it: epoch 1 allocated and settled. */
  const seededFence = (): FenceSnapshot => ({
    last_accepted_epoch: 1,
    ack_seq: null,
    last_seq: 9,
    live: null,
    completed: [
      {
        task_id: "T-FENCE-DONE",
        attempt_id: "a-done",
        epoch: 1,
        verdict: "success",
        settled_at: "2026-08-18T00:00:00.000Z",
      },
    ],
    attempts: { [attemptKey("T-FENCE-DONE", "a-done")]: 1 },
  });

  /**
   * The trace rows for one target, in order.
   *
   * Filtered by target because the fixture traces every rename it sees, and
   * the supervisor is flushing `state.json` on a 250ms heartbeat throughout.
   */
  async function traceFor(path: string, target: string): Promise<string[]> {
    const text = await Bun.file(path)
      .text()
      .catch(() => "");
    return text
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => l.split("\t"))
      .filter((row) => row[1] === target)
      .map((row) => row[0]!);
  }

  /**
   * Per boundary: the steps the fence write must have completed, whether the
   * write committed, and the epoch the restarted supervisor must then issue.
   *
   * `committed` is the whole story in one flag. Before the rename the fence on
   * disk is still the seeded one, so the next epoch is 2 — the interrupted
   * allocation is reclaimed, correctly, because it was never dispatched. From
   * the rename on, epoch 2 is durable and live, so the restart burns it as
   * `supervisor_restarted` and the next epoch is 3.
   */
  interface FenceCase {
    boundary: string;
    committed: boolean;
    nextEpoch: number;
    steps: string[];
  }
  const CASES: FenceCase[] = [
    { boundary: "open", committed: false, nextEpoch: 2, steps: ["open"] },
    { boundary: "write", committed: false, nextEpoch: 2, steps: ["open", "write"] },
    { boundary: "fsync", committed: false, nextEpoch: 2, steps: ["open", "write", "fsync"] },
    {
      boundary: "rename",
      committed: true,
      nextEpoch: 3,
      steps: ["open", "write", "fsync", "rename"],
    },
    {
      boundary: "dirfsync",
      committed: true,
      nextEpoch: 3,
      steps: ["open", "write", "fsync", "rename", "diropen", "dirfsync"],
    },
  ];

  for (const { boundary, committed, nextEpoch, steps } of CASES) {
    test(
      `killed at ${boundary} while persisting the fence: the restart never re-issues a durable epoch`,
      async () => {
        const root = await freshRoot();
        const runId = testRunId(`fence-${boundary}`);
        const run = runPaths(runId, root);
        const wp = workerPaths(run, "eng-1");
        await mkdir(wp.tasksDir, { recursive: true });
        await mkdir(run.sessionsDir, { recursive: true });

        const seeded = seededFence();
        await writeFence(wp, "eng-1", seeded);

        // A real supervisor, launched with the boundary fixture preloaded so it
        // will kill itself inside `persistFence`. Not `launchDetached`: this one
        // has to be awaited, and it is going to die on purpose.
        const trace = join(root, "fence-trace.tsv");
        const doomed = Bun.spawn(
          [
            process.execPath,
            "--preload",
            FIXTURE,
            SUPERVISOR_TS,
            "--runs-root",
            root,
            "--run",
            runId,
            "--worker",
            "eng-1",
          ],
          {
            env: {
              ...process.env,
              PIFLEET_PI_COMMAND: piCommand("happy.json"),
              PIFLEET_TEST_KILL_AT: boundary,
              PIFLEET_TEST_KILL_PATH: wp.fenceJson,
              PIFLEET_TEST_KILL_TRACE: trace,
            },
            // The supervisor's own stdout goes to its log; leaving it piped
            // and undrained is the very thing the stderr note below warns
            // about — a full pipe blocking the process this test is waiting
            // to observe.
            stdout: "ignore",
            stderr: "pipe",
          },
        );
        cleanups.push(async () => {
          doomed.kill("SIGKILL");
        });
        // Drain stderr from the start: an unread pipe that fills would block
        // the very process this test is waiting to observe.
        const doomedErr = new Response(doomed.stderr).text();

        expect(await waitForIdle(wp, doomed.pid)).toBe(true);

        // This dispatch never gets an answer: the supervisor dies inside the
        // `await persistFence()` that precedes the prompt.
        void controlCall(run, "eng-1", {
          cmd: "dispatch",
          envelope: makeEnvelope(runId, "eng-1", "T-FENCE-KILLED"),
          attempt_id: "a-killed",
          requested_epoch: null,
        }).catch(() => {});

        // 128 + SIGKILL. Any other code means the fence write ran to completion
        // and the boundary was never reached.
        expect(await doomed.exited).toBe(137);
        expect(await doomedErr).not.toContain("error:");

        // The kill landed exactly here, and nowhere later.
        expect(await traceFor(trace, wp.fenceJson)).toEqual(steps);

        /**
         * And it landed in the fence write that PRECEDES the prompt, not one of
         * the other four `persistFence()` call sites.
         *
         * Without this the block asserts only "a fence write happened at some
         * point during the run". Delete the `await persistFence()` at the
         * dispatch site — the one whose comment reads "Durable fence BEFORE the
         * prompt … Crash between here and the send burns the epoch — safe" —
         * and the kill simply relocates to the fence write that follows the
         * ack. Every assertion below still passes, while the supervisor has
         * handed a worker an epoch it never made durable: the exact §7.5
         * violation this criterion exists to forbid.
         *
         * `state.json` is what separates them, because the dispatch handler
         * writes it BETWEEN the two fence writes and awaits it:
         *
         *     await persistFence();      <- the kill lands here
         *     state.phase = "busy"; state.epoch = decision.epoch;
         *     await flushState();        <- so this can never have run
         *     await client.send("prompt", ...)
         *     await persistFence();      <- and the kill never reaches here
         *
         * So a surviving state.json that still reads `idle`, epoch 0, no task
         * is proof the process died before the epoch was even recorded locally
         * — which is upstream of the send, whatever the boundary. If the kill
         * had landed in the post-ack fence write, this file would name epoch 2.
         *
         * Deterministic, not lucky: those three fields are assigned after the
         * awaited fence write returns, and the flush that follows is awaited
         * too, so no heartbeat can smear the two cases together.
         */
        const stateAtCrash = await readWorkerState(wp);
        expect(stateAtCrash).not.toBeNull();
        expect(stateAtCrash?.phase).toBe("idle");
        expect(stateAtCrash?.epoch).toBe(0);
        expect(stateAtCrash?.task_id).toBeNull();

        // The surviving fence is a COMPLETE version — `readFence` validates the
        // whole schema, so a torn or half-updated file throws rather than
        // quietly reading as a lower high-water-mark.
        const survivor = await readFence(wp);
        if (committed) {
          expect(survivor.last_accepted_epoch).toBe(2);
          expect(survivor.live).toEqual({
            task_id: "T-FENCE-KILLED",
            attempt_id: "a-killed",
            epoch: 2,
            started: false,
            abort_requested: false,
            timed_out: false,
          });
          // The settled history is carried forward, not replaced.
          expect(survivor.completed).toEqual(seeded.completed);
        } else {
          expect(survivor).toEqual(seeded);
        }

        // A fresh supervisor over the same run directory — the restart.
        const { pid, pgid } = await processLauncher.launchDetached({
          runId,
          runDir: join(root, runId),
          workerId: "eng-1",
          argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
          env: { PIFLEET_PI_COMMAND: piCommand("happy.json") },
          logPath: wp.supervisorLog,
        });
        cleanups.push(() => killSupervisor(pid, pgid));
        expect(await waitForIdle(wp, pid)).toBe(true);

        // An epoch that was durable when the crash happened is burned, never
        // resumed: it MAY have partially run, and "maybe ran" must not look like
        // "never dispatched".
        const burned = await readTaskRecord(taskRecordPath(wp, "T-FENCE-KILLED"));
        if (committed) {
          expect(burned?.epoch).toBe(2);
          expect(burned?.verdict).toBe("failed");
          expect(burned?.reason).toBe("supervisor_restarted");
        } else {
          expect(burned).toBeNull();
        }

        const reply = await controlCall(run, "eng-1", {
          cmd: "dispatch",
          envelope: makeEnvelope(runId, "eng-1", "T-FENCE-NEXT"),
          attempt_id: "a-next",
          requested_epoch: null,
        });
        expect(reply["accepted"]).toBe(true);
        // THE assertion: strictly above everything the surviving fence recorded,
        // and never epoch 1 — the one that was dispatched and settled before the
        // crash, and the only epoch a re-issue could actually corrupt.
        expect(reply["epoch"]).toBe(nextEpoch);
        expect(reply["epoch"] as number).toBeGreaterThan(survivor.last_accepted_epoch);
        expect(reply["epoch"]).not.toBe(1);

        /**
         * And the ledger the crash cut across still reads end to end.
         *
         * Exact — zero unparseable lines, not "at most the last one" — but not
         * because appends are out of reach of the kill. `ledger.append` is a
         * real fire-and-forget call and one can well be in flight here. It is
         * exact because a signal cannot tear the write: `appendJsonl` issues
         * ONE `write(2)` on an O_APPEND fd for a line far below the size at
         * which the kernel returns a short write, and a process dying of
         * SIGKILL dies at a signal-delivery point, never part-way through the
         * kernel's copy. So each record is entirely present or entirely
         * absent.
         *
         * That reasoning is what `test/unit/jsonl.test.ts` pins directly, by
         * killing AT an append boundary rather than hoping to hit one.
         */
        const { records, errors } = await mergeLedger(run);
        expect(errors).toEqual([]);
        expect(records.length).toBeGreaterThan(0);

        await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
        await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
      },
      // ISC-266 audit: stands. Two spawns (the doomed supervisor, then the
      // restart) derive cliBudget(2) = 22_800 ms, and measured idle is
      // 2255-2364 ms — this is the larger number, so it is not reduced.
      60_000,
    );
  }
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
      expect(await waitForIdle(wp, pid)).toBe(true);

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
      // ISC-266 audit: the 45_000 below stands, and this is NOT a spawn-cost
      // test. It performs a single spawn, so cliBudget(1) would be 11_400 ms —
      // narrower than the 11_415 ms it measures idle, because its cost is the
      // deliberate escalation ladder below (1s deadline + 5s ABORT_GRACE_MS +
      // settle), not process startup. Deriving from the spawn count here would
      // tighten a passing test, so the hand-picked number is kept.
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
      expect(await waitForIdle(wp, pid)).toBe(true);

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

/**
 * ISC-116's ABORT conjunct, which nothing else asserted.
 *
 * The criterion is a conjunction of three things — "a task exceeding
 * `deadline_s` is ABORTED and REPORTED `timed_out` with EXIT 4" — and the two
 * halves after the first were already covered:
 * `test/integration/dispatch-auto.test.ts` drives a real `dispatch --auto`
 * against a `deaf-abort` agent and asserts `verdict: "timed_out"` and
 * `EXIT.TIMEOUT`. What that test cannot show is that an abort was ever SENT,
 * precisely because its agent is deaf to abort by construction: delete
 * `client.send("abort")` from the deadline branch and that test still passes,
 * because the escalation timer settles the task either way.
 *
 * So the discriminator has to come from an agent that HONOURS abort.
 * `aborted.json` does. When the abort request lands, the agent ends its turn
 * inside the 5s `ABORT_GRACE_MS` window and the task settles through the
 * normal quiesce path, so `deadline_escalated` is NEVER logged. When the abort
 * is not sent, the agent keeps working, the escalation fires, and that event
 * appears. The absence below is therefore the positive evidence that the
 * deadline path actually asked the agent to stop, rather than merely
 * outliving it.
 *
 * Reading `em.timedOut` over `em.abortRequested` is what keeps the verdict
 * `timed_out` rather than `aborted` on this path — a deadline abort is a
 * timeout that happened to be polite, not an operator abort — and asserting
 * the verdict here pins that precedence at the supervisor, one layer below
 * where `wait` turns it into exit 4.
 */
describe("ISC-116: a deadline aborts the agent, then reports timed_out", () => {
  test(
    "the abort lands, the task settles timed_out, and nothing escalates",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("deadline-abort");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");

      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        // Honours abort: `cancel_active: true`, then emits `agent_end`.
        env: { PIFLEET_PI_COMMAND: piCommand("aborted.json") },
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));
      expect(await waitForIdle(wp, pid)).toBe(true);

      // 1s against a 30s turn: the deadline is guaranteed to be the thing that
      // ends this task, not the scenario running out of steps.
      const envelope = TaskEnvelopeSchema.parse({
        ...makeEnvelope(runId, "eng-1", "T-DEADLINE-1"),
        deadline_s: 1,
      });
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope,
        attempt_id: "deadline-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      // Budget generously past ABORT_GRACE_MS (5s): a run that needed the
      // escalation must have TIME to escalate, or the absence asserted below
      // would just mean "we did not wait long enough".
      const settled = await waitFor(
        async () => (await readTaskRecord(taskRecordPath(wp, "T-DEADLINE-1"))) !== null,
        20_000,
      );
      expect(settled).toBe(true);

      const record = await readTaskRecord(taskRecordPath(wp, "T-DEADLINE-1"));
      // Reported `timed_out` — not `aborted`, though an abort is how it ended.
      expect(record?.verdict).toBe("timed_out");

      const events = await readEvents(wp.eventsJsonl);
      // The deadline is what fired, and it fired for THIS task.
      expect(
        events.some(
          (e) => e["type"] === "deadline_exceeded" && e["task_id"] === "T-DEADLINE-1",
        ),
      ).toBe(true);
      // THE assertion of this test: the agent stopped because it was asked to.
      // Remove `client.send("abort")` from the deadline branch and the deaf
      // path runs instead — `deadline_escalated` appears here and this fails.
      expect(events.some((e) => e["type"] === "deadline_escalated")).toBe(false);
      // Same fact from the settle side: the escalation's reason is a distinct
      // string, so this cannot pass on an escalated settle either.
      expect(record?.reason).not.toBe("deadline_exceeded_no_terminal_event");

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    45_000,
  );
});
