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

import { spawnCli } from "../support/spawn-cli.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { TaskEnvelopeSchema, type TaskEnvelope } from "../../src/contracts.ts";
import { runGit } from "../../src/harvest/git.ts";
import { RpcClient } from "../../src/rpc/client.ts";
import {
  isInsideRunTree,
  runPaths,
  taskRecordPath,
  workerPaths,
  type WorkerPaths,
} from "../../src/run/paths.ts";
import {
  initialWorkerState,
  readFence,
  readTaskRecord,
  readWorkerState,
  writeFence,
  writeWorkerState,
} from "../../src/run/state.ts";
import type { FenceSnapshot } from "../../src/rpc/epoch.ts";
import { LedgerWriter, mergeLedger } from "../../src/run/ledger.ts";
import { abortWedged, eventSilenceMs } from "../../src/run/stall-io.ts";
import { identityAlive, processStartTime } from "../../src/run/registry.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";
import { EXPORT_MARKER } from "../fixtures/export-marker.ts";
import { cliBudget, gateBudget } from "../support/budget.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");
const LAUNCH_TS = join(ROOT_URL, "src/supervisor/launch.ts");
const CLI = join(ROOT_URL, "src/cli/index.ts");

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

function makeEnvelope(
  runId: string,
  worker: string,
  taskId: string,
  /**
   * The host-side worktree, defaulting to the envelope's "no worktree"
   * spelling. Only the ISC-154 block below passes a real one: the supervisor
   * samples the tree at settle, and every other test here dispatches against
   * `"unset"` precisely so no git subprocess enters the path it is measuring.
   */
  hostWorkdir: string = "unset",
): TaskEnvelope {
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
    host_workdir: hostWorkdir,
    container_workdir: "/workspace",
    branch: `fleet/${runId}/${worker}`,
    base_ref: "0".repeat(40),
    outbox: `/outbox/${taskId}`,
    deadline_s: 300,
  });
}

/** Drive the real CLI, the layer an operator actually invokes. */
async function cli(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCli(args, { env: { PIFLEET_RUNS_DIR: root } });
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
    cliBudget(5),
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
    cliBudget(7),
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
  }, cliBudget(3));

  test("a dead pid is dead regardless of the recorded start time", async () => {
    // Spawn-and-reap a child so we hold a pid known to be free.
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
    await child.exited;
    expect(await processStartTime(child.pid)).toBeNull();
    expect(await identityAlive({ pid: child.pid, started: "whenever" })).toBe(false);
  }, cliBudget(3));
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
    cliBudget(1),
  );
});

/**
 * The REAL worker's fence, which is a different claim from the block above.
 *
 * The `fake-pi` block asserts that the DOUBLE refuses a stale epoch. That is a
 * fact about `test/fixtures/fake-pi.ts` and about nothing in `src/` — its
 * high-water-mark is an in-memory `let` that dies with the process, and the
 * real Pi, a third-party binary, makes no such promise. ISC-142 is about the
 * other fence: the `last_accepted_epoch` the SUPERVISOR persists in
 * `fence.json`, which is the only one that survives a restart and the only one
 * whose refusal is pifleet's own code.
 *
 * The distinction is the whole criterion. "Not merely bookkept by the
 * allocator" means the refusal has to come from the side that OWNS the
 * resource, so these tests never go through `sendTaskEnvelope` — they speak
 * the control socket directly, which is exactly the shape of the hazard the
 * design note describes: "a detached supervisor plus a CLI relaunch is two
 * allocators". A second allocator that never heard of epoch 3 sends a dispatch
 * at epoch 3, and the worker has to be the thing that says no.
 *
 * Nothing about the seeded fence is known to the running process. It is
 * written to disk BEFORE the supervisor is launched, so a supervisor that did
 * not read `fence.json` would answer every one of these differently.
 */
describe("the worker's persisted fence refuses stale dispatch (ISC-142)", () => {
  /**
   * `attemptKey` from rpc/epoch.ts, which is private to that module.
   *
   * Spelled with `String.fromCharCode` rather than an escape for the reason
   * the ISC-143 block gives: a literal NUL in the source makes `grep` treat
   * the whole test suite as binary.
   */
  const attemptKeyOf = (taskId: string, attemptId: string): string =>
    `${taskId}${String.fromCharCode(0)}${attemptId}`;

  /**
   * A fence a previous incarnation left behind: three epochs handed out, of
   * which epoch 1 settled and epochs 2 and 3 did not (burned by a restart, as
   * the ISC-143 block shows happens). Nothing is live.
   *
   * Two DIFFERENT refusals live in this shape and the criterion covers both:
   * epoch 1 is `<=` the high-water-mark AND in `completed`, so it comes back
   * `already_completed` with its verdict; epoch 2 is `<=` the high-water-mark
   * and in nothing, so it comes back `stale_epoch`. A test that pinned only
   * one branch would leave the other free to start accepting.
   */
  const seededFence = (): FenceSnapshot => ({
    last_accepted_epoch: 3,
    ack_seq: null,
    last_seq: 12,
    live: null,
    completed: [
      {
        task_id: "T-STALE-DONE",
        attempt_id: "a-done",
        epoch: 1,
        verdict: "success",
        settled_at: "2026-08-19T00:00:00.000Z",
      },
    ],
    attempts: { [attemptKeyOf("T-STALE-DONE", "a-done")]: 1 },
  });

  test(
    "a dispatch at or below the persisted high-water-mark is refused, and the fence does not move",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("stale-fence");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.tasksDir, { recursive: true });
      await mkdir(run.sessionsDir, { recursive: true });

      // On disk BEFORE the process exists. This is the "persisted" in the
      // criterion — the supervisor learns about epoch 3 by reading it.
      await writeFence(wp, "eng-1", seededFence());

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

      // (1) epoch EQUAL to the high-water-mark. The `<=` boundary itself.
      const equal = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-STALE-EQ"),
        attempt_id: "a-eq",
        requested_epoch: 3,
      });
      expect(equal["accepted"]).toBe(false);
      expect(equal["reason"]).toBe("stale_epoch");
      // The refusal names both numbers, so an operator reading it can tell
      // "you are behind" from "you skipped ahead" without a second lookup.
      expect(equal["requested"]).toBe(3);
      expect(equal["next"]).toBe(4);

      // (2) strictly BELOW it, naming an epoch that never settled.
      const below = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-STALE-LT"),
        attempt_id: "a-lt",
        requested_epoch: 2,
      });
      expect(below["accepted"]).toBe(false);
      expect(below["reason"]).toBe("stale_epoch");

      // (3) strictly below it, naming an epoch that DID settle. Still refused,
      // and refused with the recorded verdict rather than a bare no.
      const settled = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-STALE-SETTLED"),
        attempt_id: "a-settled",
        requested_epoch: 1,
      });
      expect(settled["accepted"]).toBe(false);
      expect(settled["reason"]).toBe("already_completed");
      expect(settled["verdict"]).toBe("success");

      /**
       * THE assertion, and the one that separates refusal from bookkeeping.
       *
       * A worker that merely NOTED the stale request and allocated a fresh
       * epoch anyway would answer `accepted: true` above and would have
       * advanced `last_accepted_epoch` to 4 by the time it replied — the
       * dispatch path awaits `persistFence()` before it sends the prompt, so
       * an accepted dispatch is durable before its reply is written. The fence
       * standing exactly where it was seeded is therefore proof that three
       * dispatches were refused rather than absorbed.
       */
      const afterRefusals = await readFence(wp);
      expect(afterRefusals.last_accepted_epoch).toBe(3);
      expect(afterRefusals.live).toBeNull();

      // And none of the three ever became a task: refused, not run.
      for (const id of ["T-STALE-EQ", "T-STALE-LT", "T-STALE-SETTLED"]) {
        expect(await readTaskRecord(taskRecordPath(wp, id))).toBeNull();
      }

      // The WORKER recorded the refusals — the rows are its own, written
      // before it answered, so this is the worker's account and not the
      // caller's interpretation of a reply.
      const { records, errors } = await mergeLedger(run);
      expect(errors).toEqual([]);
      const refused = records
        .filter((r) => r.event === "dispatch_rejected")
        .map((r) => r.task_id);
      expect(refused).toEqual(["T-STALE-EQ", "T-STALE-LT", "T-STALE-SETTLED"]);

      /**
       * The positive control, without which every assertion above is also
       * satisfied by a worker that refuses everything.
       *
       * `next` — one above the persisted high-water-mark — is accepted, and
       * the fence then moves. The fence is a high-water-mark, not a lock.
       */
      const fresh = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-STALE-NEXT"),
        attempt_id: "a-next",
        requested_epoch: 4,
      });
      expect(fresh["accepted"]).toBe(true);
      expect(fresh["epoch"]).toBe(4);
      expect((await readFence(wp)).last_accepted_epoch).toBe(4);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    /**
     * DERIVED from a counted spawn count, not fitted to a run that passed.
     *
     * Two processes, counted in the body rather than estimated: one
     * `processLauncher.launchDetached`, and the single `fake-pi` child that
     * supervisor starts from `PIFLEET_PI_COMMAND`. No CLI is invoked at all —
     * the four dispatches and the shutdown go down the control socket from
     * this process. So `cliBudget(2)` = 2 * 1900 * 3 * 2 = 22_800 ms, and the
     * CONTENTION and SAFETY factors in that product are what cover a loaded
     * machine. The number would be the same had every run come in at 10 s.
     *
     * The observation below is a sanity check on the derivation, NOT its
     * source, and it is reported with the conditions it was taken under
     * because this box is shared and was never quiet while this was written.
     * 2.26/2.26/2.28 s at 1-minute load averages of 60.40/56.04/56.04 on 14
     * cores, and 2.35 s on a re-take at load 188.27 — 13x oversubscribed,
     * with another engineer's CPU-load harness running. NO IDLE NUMBER IS
     * CLAIMED HERE because none was taken. The 13x figure is the useful one:
     * it is four times the 2.09-2.98x inflation ISC-266 measured, and the
     * test still finishes in a tenth of its budget.
     *
     * Roughly 2 s of that is SHUTDOWN_GRACE_MS and is deliberate: the
     * positive control leaves epoch 4 live, so `shutdown` has a running task
     * to wind down.
     */
    cliBudget(2),
  );
});

/**
 * ISC-145 at the worker, which is the layer the criterion's contrast lives on.
 *
 * `test/unit/epoch.test.ts` proves the DECISION — `allocate` looks the attempt
 * up before it looks at `completed`, so a settled task's own attempt replays
 * instead of coming back `already_completed`. What it cannot prove is that the
 * worker HONOURS that decision, and the two failure modes are different
 * things: the decision going wrong returns the bare `already_completed` the
 * criterion names, while the worker ignoring `replayed` re-sends the prompt
 * and runs the task a second time. Both are ISC-145 failures and only one of
 * them is visible in `epoch.ts`.
 *
 * The retry here is the real one. `dispatch --auto` derives `auto:<task id>`
 * deterministically per (run, task), and a hand-written task file may carry
 * its own `attempt_id`, so an identical `(task_id, attempt_id)` reaching a
 * worker twice is the ordinary consequence of a lost ack — not a contrived
 * input.
 */
describe("a retried (task_id, attempt_id) replays the stored answer (ISC-145)", () => {
  test(
    "the same attempt after settlement gets the original epoch back, not already_completed",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("replay");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.tasksDir, { recursive: true });
      await mkdir(run.sessionsDir, { recursive: true });

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

      const dispatch = (attemptId: string): Promise<Record<string, unknown>> =>
        controlCall(run, "eng-1", {
          cmd: "dispatch",
          envelope: makeEnvelope(runId, "eng-1", "T-REPLAY"),
          attempt_id: attemptId,
          requested_epoch: null,
        });

      const first = await dispatch("a-replay");
      expect(first["accepted"]).toBe(true);
      expect(first["replayed"]).toBe(false);
      const epoch = first["epoch"] as number;

      // Let it finish. The interesting retry is the one that arrives AFTER
      // settlement, because that is when `completed` holds an answer and the
      // bare `already_completed` becomes available to return.
      const done = await waitFor(
        async () => (await readTaskRecord(taskRecordPath(wp, "T-REPLAY"))) !== null,
        10_000,
      );
      expect(done).toBe(true);
      expect((await readTaskRecord(taskRecordPath(wp, "T-REPLAY")))?.verdict).toBe("success");

      /**
       * THE assertion, in the criterion's own terms.
       *
       * Same task, same attempt, task long since settled. The answer is the
       * STORED one — accepted, the same epoch, flagged as a replay — and it is
       * NOT a refusal. The caller lost the ack, not the dispatch, and a bare
       * `already_completed` would leave it unable to tell "I did this and lost
       * the reply" from "somebody else did this", which is the distinction the
       * whole attempt-id mechanism exists to preserve.
       */
      const retry = await dispatch("a-replay");
      expect(retry["accepted"]).toBe(true);
      expect(retry["replayed"]).toBe(true);
      expect(retry["epoch"]).toBe(epoch);
      expect(retry["reason"]).toBeUndefined();

      // And the replay cost nothing: no epoch burned, nothing re-run, the
      // recorded outcome untouched.
      expect((await readFence(wp)).last_accepted_epoch).toBe(epoch);
      const record = await readTaskRecord(taskRecordPath(wp, "T-REPLAY"));
      expect(record?.verdict).toBe("success");
      expect(record?.epoch).toBe(epoch);
      const events = await readEvents(wp.eventsJsonl);
      expect(events.filter((e) => e["type"] === "epoch_started")).toHaveLength(1);

      /**
       * The negative control, and the other half of the sentence.
       *
       * A DIFFERENT attempt against the same settled task is a different
       * claim — nobody is re-asking a question they already got an answer to,
       * they are asking a new one about work that is done — and it correctly
       * gets the bare `already_completed`. Without this the test above is
       * satisfied by a worker that replays everything, which would resurrect
       * ISC-85.
       */
      const other = await dispatch("a-different");
      expect(other["accepted"]).toBe(false);
      expect(other["reason"]).toBe("already_completed");
      expect(other["verdict"]).toBe("success");

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    /**
     * DERIVED from a counted spawn count, on the same basis as the ISC-142
     * test above: one `launchDetached` plus the one `fake-pi` child it starts,
     * counted in the body, no CLI invocation — three dispatches and a shutdown
     * over the control socket. `cliBudget(2)` = 22_800 ms.
     *
     * Sanity check, with conditions, not the source of the number:
     * 530/540/534 ms at a 1-minute load average of 44.40 on 14 cores, and
     * 531 ms on a re-take at load 188.27 — 13x oversubscribed, another
     * engineer's load harness running. No idle number is claimed; none was
     * taken. It is faster than the ISC-142 test because its task has already
     * settled before `shutdown`, so it pays no SHUTDOWN_GRACE_MS.
     */
    cliBudget(2),
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
    cliBudget(4),
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
    cliBudget(3),
  );
});

/**
 * ISC-108 — the F39 RUNTIME detector (SRD §5.9 detector 2).
 *
 * §5.9 specifies two detectors for the prose-instead-of-tool-calls failure and
 * only the first was ever built. The startup probe is real and enforced
 * (`security/model-probe.ts`, ISC-53), and it can be PASSED AND THEN DRIFTED
 * FROM: a model's willingness to emit native `tool_calls` is a property of its
 * chat template interacting with the context it is given, so an answer at token
 * 200 says nothing about token 80,000. §5.9 records the measurement —
 * `Qwen3-8B-4bit` emitting reasoning prose through this same oMLX server — and
 * a sharper one was taken on 2026-08-23 against
 * `Qwen3-Coder-30B-A3B-Instruct-4bit`, a model that PASSES the probe: in 1 of 3
 * identical probes it leaked its tool call as raw `<function=read>…</tool_call>`
 * TEXT with `finish_reason=stop`. Intermittent, which is the shape a one-shot
 * probe cannot see, and the turn genuinely has zero tool calls when it happens.
 *
 * **Why this test is here and not in `test/unit/`.** The criterion is about a
 * WORKER being classified, and the grade note for ISC-108 was precise about
 * what the tree already had: the supervisor DID count tool calls
 * (`state.tool_calls++`) and "NO VERDICT PATH READS THAT COUNTER". A unit test
 * over `ProseTurnDetector` would have reproduced exactly that arrangement one
 * file further along — a correct module beside a settle path that never asks
 * it. So the detector is graded here, through a real detached supervisor, a
 * real RPC stream, and the task record `wait` reads.
 *
 * **The two tests are one experiment.** The same scenario and the same
 * supervisor differ only in `run.json`, so the first test cannot pass by the
 * fixture merely being unusual and the second cannot pass by the detector being
 * inert. Together they show the verdict is a FUNCTION of the configured
 * threshold, which is the claim `prose_turns_before_fail` makes.
 */
describe("ISC-108: three turns with zero tool calls are failed, not settled successfully", () => {
  test(
    "the task settles failed:no_tool_calls, and the detector says so at the third turn",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("prose-fail");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");

      /**
       * No `run.json` written: this run takes the SCHEMA DEFAULT of 3 through
       * `readRunProseTurnsBeforeFail`, which is the number both ISC-108 ("3
       * turns") and §5.9 ("default 3") name. Asserting the criterion against a
       * hand-written threshold would grade a number this test chose.
       */
      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        // Three turns, zero tool calls, then a clean `agent_end` — a worker
        // that streams, ends turns, settles, and accomplishes nothing.
        env: { PIFLEET_PI_COMMAND: piCommand("no-tool-calls.json") },
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));
      expect(await waitForIdle(wp, pid)).toBe(true);

      // `deadline_s` is the default 300 s against a scenario that emits in one
      // burst: the deadline is guaranteed NOT to be what ends this task, so a
      // `timed_out` verdict could not be mistaken for the detector working.
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-PROSE-1"),
        attempt_id: "prose-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      const settled = await waitFor(
        async () => (await readTaskRecord(taskRecordPath(wp, "T-PROSE-1"))) !== null,
        20_000,
      );
      expect(settled).toBe(true);

      const record = await readTaskRecord(taskRecordPath(wp, "T-PROSE-1"));
      // THE CRITERION. Before the detector was wired this read `success`,
      // "quiesced" — a worker that did nothing, certified as having done it.
      expect(record?.verdict).toBe("failed");
      expect(record?.reason).toBe("no_tool_calls");

      const events = await readEvents(wp.eventsJsonl);
      /**
       * The verdict alone would be satisfied by any bug that failed this task
       * for any reason, so the trip record is asserted too — and asserted with
       * its NUMBERS, which is what makes it evidence about the detector rather
       * than about a name. `prose_turns: 3` at `threshold: 3` says the
       * supervisor counted three turns and compared them to the bound it read
       * from the run, at the moment it crossed.
       */
      const trip = events.find((e) => e["type"] === "no_tool_calls_detected");
      expect(trip).toBeDefined();
      expect(trip?.["task_id"]).toBe("T-PROSE-1");
      expect(trip?.["prose_turns"]).toBe(3);
      expect(trip?.["threshold"]).toBe(3);

      // Nothing else ended this task. Both absences matter: a deadline would
      // have produced `timed_out`, and the escalation would mean the agent
      // never honoured the abort — a different path with the same verdict.
      expect(events.some((e) => e["type"] === "deadline_exceeded")).toBe(false);
      expect(events.some((e) => e["type"] === "no_tool_calls_escalated")).toBe(false);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    // Three gates: the idle wait (20 s), the settle wait (20 s), the shutdown
    // wait (5 s). No CLI is spawned and no container is started, so neither
    // `cliBudget` nor `containerBudget` describes this test's cost (ISC-273).
    gateBudget([20_000, 20_000, 5_000]),
  );

  test(
    "prose_turns_before_fail: 0 turns the detector off and the same worker settles success",
    async () => {
      /**
       * The control, and the half that makes the test above discriminating.
       *
       * Identical scenario, identical supervisor, ONE number different in
       * `run.json`. If this settled `failed` too, the first test would be
       * evidence that something in this fixture fails tasks, not that the
       * detector reads its threshold. If the first test settled `success` with
       * this one unchanged, the detector would be inert.
       *
       * It is also the only executable statement of §5.9's
       * "`require_native_tool_calls: false` disables both" on the runtime side:
       * `up` folds that gate into this very key
       * (`effectiveProseTurnsBeforeFail`), so `0` here is the exact state an
       * operator who turned the gate off produces.
       */
      const root = await freshRoot();
      const runId = testRunId("prose-off");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");

      // Written BEFORE launch: the supervisor reads this once at startup,
      // deliberately, rather than per event.
      await mkdir(run.root, { recursive: true });
      await writeFile(
        run.runJson,
        JSON.stringify({
          schema: "pifleet.run/v1",
          run_id: runId,
          prose_turns_before_fail: 0,
        }),
      );

      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        env: { PIFLEET_PI_COMMAND: piCommand("no-tool-calls.json") },
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));
      expect(await waitForIdle(wp, pid)).toBe(true);

      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-PROSE-OFF"),
        attempt_id: "prose-off-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      const settled = await waitFor(
        async () => (await readTaskRecord(taskRecordPath(wp, "T-PROSE-OFF"))) !== null,
        20_000,
      );
      expect(settled).toBe(true);

      const record = await readTaskRecord(taskRecordPath(wp, "T-PROSE-OFF"));
      expect(record?.verdict).toBe("success");
      expect(record?.reason).toBe("quiesced");

      // Off means off all the way down: no trip record, so the detector did not
      // fire and get overruled somewhere later.
      const events = await readEvents(wp.eventsJsonl);
      expect(events.some((e) => e["type"] === "no_tool_calls_detected")).toBe(false);
      // And the fixture really did complete three turns while it was watching —
      // otherwise "off" would be indistinguishable from "never had the chance".
      expect(events.filter((e) => {
        const ev = e["event"] as { type?: string } | undefined;
        return e["type"] === "event" && ev?.type === "turn_end";
      }).length).toBe(3);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    gateBudget([20_000, 20_000, 5_000]),
  );
});

/**
 * ISC-234: the control socket answers `export_html`, so a LIVE worker's
 * `transcript --html` goes through Pi rather than the CLI's local renderer.
 *
 * The two paths are near-indistinguishable by construction — same exit code,
 * same reported path, a real HTML document either way — which is exactly why
 * this criterion could sit unimplemented behind a green suite. `transcript.ts`
 * catches every RPC failure and falls back silently, and an unknown verb IS a
 * failure, so before the supervisor learned this verb the live path was
 * unreachable and nothing anywhere noticed.
 *
 * Both directions are asserted, in one test, against the SAME run:
 *   - supervisor alive -> `source: "rpc"`   and the marker IS present
 *   - supervisor gone  -> `source: "local"` and the marker is NOT present
 *
 * The second half is what makes the first half mean something. Alone, a marker
 * assertion proves only that some file contains a string; paired, the marker is
 * shown to DISCRIMINATE between the two renderers on identical input. It also
 * re-pins the ISC-101 fallback that ISC-234 must not break — the dead worker is
 * the one harvest exists for.
 */
/**
 * A detached supervisor over `scenario`, idle, with a completed turn behind it.
 *
 * A transcript has to EXIST before `--html` exports anything: `classifySession`
 * gates on the recorded session file, and fake-pi creates it lazily on the
 * first assistant message exactly as real Pi does (SRD §4.2). Every export test
 * below needs that same preamble, and three copies of it is three places for
 * the gate to be silently dropped from one.
 */
/**
 * The two polling gates this preamble waits on, named so a test's ceiling can
 * be DERIVED from them via `gateBudget` rather than hand-picked beside them.
 *
 * They were bare literals here, which was fine while every caller hand-picked
 * a literal too. The ISC-276 probe below drives the control socket and spawns
 * no CLI at all, so `cliBudget` cannot express it (a spawn count it does not
 * perform would be a lie encoded as arithmetic, exactly what `budget.ts`
 * forbids) — and what that test actually spends is these two gates. Naming
 * them is what turns "80_000, seems fine" into a derivation someone can read.
 */
const IDLE_GATE_MS = 20_000;
const TRANSCRIPT_GATE_MS = 20_000;

async function workerWithTranscript(
  scenario: string,
  tag: string,
): Promise<{
  root: string;
  runId: string;
  run: ReturnType<typeof runPaths>;
  wp: WorkerPaths;
  pid: number;
}> {
  const root = await freshRoot();
  const runId = testRunId(tag);
  const { pid, pgid } = await processLauncher.launchDetached({
    runId,
    runDir: join(root, runId),
    workerId: "eng-1",
    argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
    env: { PIFLEET_PI_COMMAND: piCommand(scenario) },
    logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
  });
  cleanups.push(() => killSupervisor(pid, pgid));

  const run = runPaths(runId, root);
  const wp = workerPaths(run, "eng-1");
  expect(await waitForIdle(wp, pid, IDLE_GATE_MS)).toBe(true);

  const reply = await controlCall(run, "eng-1", {
    cmd: "dispatch",
    envelope: makeEnvelope(runId, "eng-1", `T-${tag.toUpperCase()}`),
    attempt_id: `int-attempt-${tag}`,
    requested_epoch: null,
  });
  expect(reply["accepted"]).toBe(true);

  const present = await waitFor(async () => {
    const s = await readWorkerState(wp);
    return s?.session_path != null && (await Bun.file(s.session_path).exists());
  }, TRANSCRIPT_GATE_MS);
  expect(present).toBe(true);

  return { root, runId, run, wp, pid };
}

describe("export_html over the control socket (ISC-234)", () => {
  test(
    "a live worker exports through Pi; the same run falls back to the local render once it is gone",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("exporthtml");
      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        env: { PIFLEET_PI_COMMAND: piCommand("happy.json") },
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));

      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      expect(await waitForIdle(wp, pid)).toBe(true);

      // A transcript has to EXIST before `--html` exports anything:
      // `classifySession` gates on the recorded session file, and fake-pi
      // creates it lazily on the first assistant message exactly as real Pi
      // does (SRD §4.2). So the export needs a completed turn behind it.
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-EXPORT-1"),
        attempt_id: "int-attempt-export",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      const present = await waitFor(async () => {
        const s = await readWorkerState(wp);
        return s?.session_path != null && (await Bun.file(s.session_path).exists());
      }, 20_000);
      expect(present).toBe(true);

      // --- live: Pi renders its own session --------------------------------
      const liveOut = join(root, "live.html");
      // ISC-276 must not close the criterion by breaking the feature. `root`
      // is the RUNS root and the run directory is `<root>/<runId>`, so this
      // destination is a sibling of the run tree rather than a member of it —
      // i.e. the ordinary `--html ~/Desktop/foo.html` case, asserted as one
      // rather than left to be inferred from two `join` calls.
      expect(isInsideRunTree(run.root, liveOut)).toBe(false);
      const live = await cli(root, [
        "transcript", "--worker", "eng-1", "--run", runId, "--html", liveOut, "--json",
      ]);
      expect(live.stderr).toBe("");
      expect(live.code).toBe(0);
      // THE assertion. Fails if the supervisor stops answering `export_html`:
      // the CLI's catch-and-fall-back turns an unknown verb into `"local"`,
      // silently, which is the exact state ISC-234 was filed over.
      expect(JSON.parse(live.stdout.trim())).toMatchObject({ html: liveOut, source: "rpc" });
      const liveHtml = await Bun.file(liveOut).text();
      // Not merely "a file was written" — the bytes are the AGENT's, not a
      // second opinion reconstructed from A4 by the CLI.
      expect(liveHtml).toContain(EXPORT_MARKER);

      // --- dead: the ISC-101 fallback, unbroken ----------------------------
      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      expect(await waitFor(async () => (await processStartTime(pid)) === null, 10_000)).toBe(true);

      const deadOut = join(root, "dead.html");
      const dead = await cli(root, [
        "transcript", "--worker", "eng-1", "--run", runId, "--html", deadOut, "--json",
      ]);
      expect(dead.stderr).toBe("");
      expect(dead.code).toBe(0);
      expect(JSON.parse(dead.stdout.trim())).toMatchObject({ html: deadOut, source: "local" });
      const deadHtml = await Bun.file(deadOut).text();
      // The marker DISCRIMINATES: the local renderer must never emit it, or
      // the assertion above would pass for a reason unrelated to ISC-234.
      expect(deadHtml).not.toContain(EXPORT_MARKER);
      // Still a real, openable document — ISC-101 is not collateral damage.
      expect(deadHtml.startsWith("<!doctype html>")).toBe(true);
      expect(deadHtml).toContain("</html>");
    },
    // ISC-266 audit: NOT a spawn-cost test, so the hand-picked number stands
    // BARE rather than behind a `Math.max` whose derived term can never win.
    // Two CLI spawns derive cliBudget(2) = 22_800 ms, which 60_000 dominates
    // unconditionally — the `max` was dead, and a dead term reads as derived
    // while being hand-picked. What sets this ceiling is the supervisor
    // launch, a full turn and a shutdown, none of which the spawn model
    // prices. Inflating the spawn count until the derivation cleared 60_000
    // would be estimating, which `budget.ts` explicitly forbids.
    // Measured 0.54 s idle at load average 3.1-3.6 on a 14-core box.
    60_000,
  );

  /**
   * The late-write race, from the operator's side.
   *
   * Pi writes the export file ITSELF, at whatever path it is given, and there
   * is no verb that cancels a render already in flight. So the supervisor's
   * deadline stops the supervisor WAITING; it does not stop Pi WRITING. With
   * the requested path forwarded verbatim that produced:
   *
   *   t=8s   supervisor gives up, answers `ok:false`
   *   t=8s   CLI writes its own render, prints `source:"local"`, exits 0
   *   t=13s  Pi finishes and overwrites the operator's file
   *
   * — the file on disk is the agent's while the operator has been told it is
   * the CLI's second opinion. Inverted provenance, which is the one question
   * ISC-234 exists to answer, and a torn document if the writes interleave.
   *
   * The fix aims Pi at a staging sibling and renames only on confirmed success,
   * so the loser of the race cannot reach the contested name at all.
   *
   * ANTI-VACUITY. The wait is on the marker appearing SOMEWHERE, not on one
   * named staging path. A test that waited for a specific filename would
   * assert the mechanism and pass trivially against a Pi that never rendered
   * at all; waiting for the marker proves the late render really happened
   * under BOTH the fixed and the unfixed code, and leaves the next line —
   * where it landed — as the only thing in dispute.
   *
   * ISC-276 MOVED WHERE IT LANDS. The abandoned render used to appear beside
   * the operator's file, because staging was a sibling of the path the caller
   * asked for; it now appears in the worker's `exportsDir` inside the run
   * tree. So the poll sweeps BOTH directories and the assertion afterwards is
   * stronger than it was: not only did the late render fail to reach
   * `outPath`, it never entered the operator's directory at all. Sweeping both
   * rather than only the new one is deliberate — a search that looked solely
   * where the fix puts the file could not notice a regression that put a
   * second copy back beside the operator.
   */
  test(
    "a render that finishes after the supervisor gave up cannot overwrite the operator's file",
    async () => {
      // 13s render vs the supervisor's 8s budget and the CLI's 10s ceiling:
      // Pi loses to both, so the fallback is certain regardless of which side
      // times out first. Nothing here depends on that ordering — the ordering
      // is the next test's subject.
      const ctx = await workerWithTranscript("late-export.json", "exportrace");
      const outDir = join(ctx.root, "export-race");
      const outPath = join(outDir, "out.html");

      const r = await cli(ctx.root, [
        "transcript", "--worker", "eng-1", "--run", ctx.runId, "--html", outPath, "--json",
      ]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ html: outPath, source: "local" });

      // What the operator was handed, byte for byte, at the moment they were
      // told it was the local render.
      const asPromised = await Bun.file(outPath).text();
      expect(asPromised).not.toContain(EXPORT_MARKER);
      expect(asPromised.startsWith("<!doctype html>")).toBe(true);

      // Pi's render lands ~5s after the CLI already returned. Poll for it
      // rather than sleeping a guessed interval: on a loaded box the write is
      // later, never earlier, so a fixed sleep would be the flaky half.
      const markerIn = async (dir: string): Promise<boolean> => {
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          const text = await Bun.file(join(dir, name))
            .text()
            .catch(() => "");
          if (text.includes(EXPORT_MARKER)) return true;
        }
        return false;
      };
      const landed = await waitFor(
        async () => (await markerIn(ctx.wp.exportsDir)) || (await markerIn(outDir)),
        30_000,
      );
      expect(landed).toBe(true); // the abandoned render DID happen — not a no-op

      // ISC-276: and it happened INSIDE the run tree. This is the half the
      // sibling-staging design could not assert at all — there, the abandoned
      // render was in the operator's directory by construction.
      expect(await markerIn(ctx.wp.exportsDir)).toBe(true);
      expect(await markerIn(outDir)).toBe(false);

      // THE assertion. Before the fix this file was the agent's document and
      // this line read `expect(received).not.toContain("pi-export-html-marker")`
      // against a page whose body is exactly that marker.
      const afterwards = await Bun.file(outPath).text();
      expect(afterwards).not.toContain(EXPORT_MARKER);
      // And not merely "not the marker" — untouched. A partial overwrite would
      // also drop the marker while destroying the document.
      expect(afterwards).toBe(asPromised);
    },
    // ISC-266 audit: NOT a spawn-cost test. One CLI spawn derives
    // cliBudget(1) = 11_400 ms against a body whose cost is ~13 s of scripted
    // render delay plus a 30 s poll ceiling — the spawn model prices none of
    // it and the derived term could never win, so it is not carried. The 13 s
    // is a fixed sleep and does not inflate under load; only the launch, turn
    // and single spawn do. Measured 13.5 s at load average 3.1-3.6 on a
    // 14-core box, so 90_000 is ~6.7x headroom and still bounds a real hang.
    90_000,
  );

  /**
   * Why the race above has no residual window, asserted structurally.
   *
   * The timing test proves the CLOBBER is gone for a render that loses by five
   * seconds. It cannot prove the general case, because the dangerous ordering
   * is not reproducible on demand: had the supervisor kept the rename, a Pi
   * confirming at 7.9s and a reply delayed past the CLI's 10s ceiling would put
   * the agent's bytes at the operator's path AFTER the CLI wrote and reported
   * `"local"` — the same inversion through a window too narrow to schedule.
   *
   * So the property is pinned where it actually lives, in the construction: a
   * CONFIRMED, SUCCESSFUL export leaves the requested path untouched, because
   * the supervisor is not a writer of it at all. No timing, no delay, no race
   * to lose — if this passes, there is no ordering that can produce the
   * inversion, because there is only one writer.
   */
  test(
    "a successful export leaves the requested path untouched until the CLI claims it",
    async () => {
      const ctx = await workerWithTranscript("happy.json", "exportstage");
      const outDir = join(ctx.root, "export-stage");
      const outPath = join(outDir, "out.html");

      // No `path` is sent (ISC-276) — the verb no longer takes one, and the
      // destination `outPath` above is now purely this test's own business,
      // exactly as `--html` is the CLI's.
      const reply = await controlCall(ctx.run, "eng-1", { cmd: "export_html" }, { timeoutMs: 15_000 });
      // A real success — not a refusal that would satisfy the assertions below
      // vacuously by never rendering anything.
      expect(reply["ok"]).toBe(true);

      // The reply names a file, and it is inside the RUN TREE rather than
      // anywhere the caller could have influenced (ISC-276).
      const staged = reply["staged"];
      expect(typeof staged).toBe("string");
      expect(staged).not.toBe(outPath);
      expect(isInsideRunTree(ctx.run.root, staged as string)).toBe(true);

      // THE assertion. Pi has finished, the supervisor has confirmed it, and
      // the operator's path still does not exist. MUTATION: move the rename
      // back into the supervisor and this reads `expect(true).toBe(false)`.
      expect(await Bun.file(outPath).exists()).toBe(false);

      // And the render is genuinely there, under the staged name — otherwise
      // "untouched" would be proving only that nothing happened.
      expect(await Bun.file(staged as string).text()).toContain(EXPORT_MARKER);
    },
    // ISC-266 audit: ZERO CLI spawns — this drives the control socket
    // directly, so `cliBudget` cannot express it at all (it throws below 1)
    // and carrying cliBudget(1) was doubly dead: wrong count, losing term.
    // The cost is one supervisor launch and one turn, with no deliberate
    // delay anywhere. Measured 0.44 s at load average 3.1-3.6 on a 14-core
    // box; 30_000 is ~68x headroom, deliberately TIGHTER than the 60_000 its
    // neighbours need because this test sleeps for nothing and a hang here
    // should surface fast.
    30_000,
  );

  /**
   * The 8s-under-10s ordering, asserted through its consequence.
   *
   * `EXPORT_HTML_TIMEOUT_MS` is under `CLI_EXPORT_HTML_TIMEOUT_MS` so that the
   * side which gives up first is the side holding the diagnosis. Pi renders in
   * 9s here — inside the CLI's window, outside the supervisor's — which is the
   * only interval where the two possible orderings produce different observable
   * outcomes:
   *
   *   8s budget (correct):  supervisor gives up at 8s and says why; `"local"`
   *   60s budget (mutated): supervisor is still waiting, Pi succeeds at 9s, the
   *                         supervisor renames and answers `ok:true` at 9s, and
   *                         the CLI — still listening until 10s — reports
   *                         `"rpc"` with nothing on stderr
   *
   * `test/unit/export-html-race.test.ts` guards the same invariant with no
   * clock at all; this one is why the ordering is worth having.
   */
  test(
    "a render inside the CLI's window but outside the supervisor's: the supervisor is the side that reports",
    async () => {
      const ctx = await workerWithTranscript("slow-export.json", "exportorder");
      const outPath = join(ctx.root, "export-order", "out.html");

      const r = await cli(ctx.root, [
        "transcript", "--worker", "eng-1", "--run", ctx.runId, "--html", outPath, "--json",
      ]);
      expect(r.code).toBe(0);
      // MUTATION (EXPORT_HTML_TIMEOUT_MS = 60_000): `"rpc"`, because the
      // supervisor no longer loses the race it was written to lose.
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ html: outPath, source: "local" });

      // The supervisor ANSWERED, inside the CLI's window, and its answer names
      // what Pi did. This is also the ISC-234 blindfold coming off: before it,
      // `transcript.ts` caught every RPC outcome into one silent fallback, so a
      // live worker refusing was byte-identical to no worker at all.
      expect(r.stderr).toContain("refused export_html");
      // And specifically NOT the other diagnosis. `control call failed` is what
      // the CLI prints when IT is the side that timed out — the exact state the
      // ordering exists to prevent, and what the mutation would produce if Pi
      // were slower than both budgets instead of just one.
      expect(r.stderr).not.toContain("control call failed");
    },
    // ISC-266 audit: NOT a spawn-cost test. One CLI spawn derives
    // cliBudget(1) = 11_400 ms, dominated unconditionally by the floor, so the
    // derived term is dropped rather than left dead. The cost is the 8 s
    // supervisor budget this test exists to observe, plus launch and a turn.
    // Measured 8.5 s at load average 3.1-3.6 on a 14-core box.
    60_000,
  );
});

/**
 * ISC-276: a path accepted over the control socket cannot direct a worker's
 * write outside a defined permitted set.
 *
 * THE PERMITTED SET IS `wp.exportsDir`, and the way the criterion is met is
 * that the caller's string stops being a destination at all — the supervisor
 * derives Pi's target from the run directory and a UUID, and REFUSES a request
 * that carries `path`. So this block probes a verb that no longer has the
 * parameter the criterion is about, which is the point: containment is a
 * property of the construction rather than of a validator.
 *
 * WHY FOUR CASES AND NOT ONE. They fail for different reasons, and a single
 * case cannot tell a real containment from an accident:
 *
 *   - an ABSOLUTE path outside the run tree — the plain shape, and the one a
 *     root check catches;
 *   - a bare RELATIVE traversal (`../../escape.html`) — resolved against the
 *     agent's cwd rather than anything the supervisor computed, so a check
 *     written against absolute paths never sees it;
 *   - an ANCHORED traversal that starts inside the run tree and climbs out —
 *     the shape a naive `startsWith(runRoot)` test ACCEPTS, because the string
 *     genuinely does start with the run root;
 *   - a path INSIDE the run tree — which every containment check above
 *     accepts, and which this design refuses anyway, for the better reason
 *     that the verb does not take a destination. That case is the one that
 *     distinguishes "the string was validated" from "the string was never
 *     consulted", and it is the assertion that would survive someone
 *     replacing this design with an allowlist and believing it equivalent.
 *
 * BOTH HALVES ARE ASSERTED FOR EVERY CASE, and the filesystem half comes
 * FIRST because it is the one that closes the criterion. A refusal that still
 * wrote the file closes nothing, so the reply assertions are deliberately not
 * allowed to be the first thing that goes red.
 *
 * ANTI-VACUITY, at the end: a well-formed export in the same test, against the
 * same live worker, still succeeds and still produces the agent's bytes. Four
 * refusals prove nothing on their own — an `export_html` that was simply
 * broken would satisfy every assertion above it.
 */
describe("export_html path containment (ISC-276)", () => {
  /** Entries of `dir` beginning with `prefix`; `[]` for a directory that does not exist. */
  async function entriesStartingWith(dir: string, prefix: string): Promise<string[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    return names.filter((n) => n.startsWith(prefix)).sort();
  }

  test(
    "a path sent over the control socket cannot direct the worker's write anywhere the path names",
    async () => {
      const ctx = await workerWithTranscript("happy.json", "exportpwn");

      // A directory nothing else in this process writes to, so "empty
      // afterwards" is an EXACT statement rather than a filter over whatever
      // else happens to be in a shared /tmp. This is the `/tmp/pwned-<uuid>`
      // of the criterion's prose with its parent made enumerable.
      const hostileDir = await mkdtemp(join(tmpdir(), "pifleet-isc276-"));
      cleanups.push(() => rm(hostileDir, { recursive: true, force: true }));

      // 1. Absolute, outside the run tree.
      const absolute = join(hostileDir, "abs-pwned.html");

      // 2. The criterion's literal relative traversal. Resolved against the
      //    AGENT's cwd, which is neither the run directory nor anything the
      //    supervisor computes — the reason a check over absolute paths alone
      //    would never see this shape.
      const bareTraversal = "../../escape.html";
      // Where it lands if the agent inherits this process's cwd, which is the
      // realistic case: the supervisor is launched from here and Pi from it.
      const bareTraversalDir = resolve(process.cwd(), "..", "..");

      // 3. Anchored traversal: starts INSIDE the run tree and climbs out.
      //    Built with `relative` and joined by hand so the `..` segments reach
      //    the supervisor UN-NORMALIZED — a `join` here would resolve them in
      //    the test and probe a different string than the one being claimed.
      const anchoredTarget = join(hostileDir, "traversal-pwned.html");
      const anchored = `${ctx.wp.exportsDir}/${relative(ctx.wp.exportsDir, anchoredTarget)}`;

      // 4. INSIDE the run tree. Every containment check accepts this one.
      const inside = join(ctx.run.root, "inside-pwned.html");
      expect(isInsideRunTree(ctx.run.root, inside)).toBe(true);

      const replies: Array<Record<string, unknown>> = [];
      for (const path of [absolute, bareTraversal, anchored, inside]) {
        replies.push(
          await controlCall(ctx.run, "eng-1", { cmd: "export_html", path }, { timeoutMs: 15_000 }),
        );
      }

      // --- THE assertion: nothing was written anywhere any of them named ---
      //
      // MUTATION (restore the caller's path as the staging destination — i.e.
      // `const staging = `${path}.pi-export-${randomUUID()}.tmp`` and the
      // non-empty-string check that used to precede it): every line in this
      // block goes red, because Pi renders a SIBLING of each attacker-chosen
      // path, which is an attacker-chosen path. The first reads
      //   expect(["abs-pwned.html.pi-export-<uuid>.tmp",
      //           "traversal-pwned.html.pi-export-<uuid>.tmp"]).toEqual([])
      expect((await readdir(hostileDir)).sort()).toEqual([]);
      expect(await entriesStartingWith(bareTraversalDir, "escape.html")).toEqual([]);
      expect(await entriesStartingWith(ctx.run.root, "inside-pwned.html")).toEqual([]);
      for (const path of [absolute, anchoredTarget, inside, resolve(bareTraversalDir, "escape.html")]) {
        expect(await Bun.file(path).exists()).toBe(false);
      }

      // --- and the reply said so, rather than failing silently -------------
      for (const reply of replies) {
        expect(reply["ok"]).toBe(false);
        // Named by criterion, so a future refusal for an UNRELATED reason —
        // a wedged agent, a missing transcript — cannot be mistaken for this
        // control still being in place.
        expect(String(reply["error"])).toContain("ISC-276");
        // The refusal carries no staging path: there is nothing to claim,
        // which is what stops a client from renaming a file into existence.
        expect(reply["staged"]).toBeUndefined();
      }

      // --- ANTI-VACUITY: the verb still works, on this same live worker ----
      const good = await controlCall(ctx.run, "eng-1", { cmd: "export_html" }, { timeoutMs: 15_000 });
      expect(good["ok"]).toBe(true);
      const staged = good["staged"];
      expect(typeof staged).toBe("string");
      // Inside the permitted set, and specifically in the directory `paths.ts`
      // names — not merely somewhere under the run root.
      expect(dirname(staged as string)).toBe(ctx.wp.exportsDir);
      expect(isInsideRunTree(ctx.run.root, staged as string)).toBe(true);
      // The AGENT's bytes. Without this the four refusals above would pass
      // just as well against an `export_html` that never rendered anything.
      expect(await Bun.file(staged as string).text()).toContain(EXPORT_MARKER);
    },
    // ISC-266/ISC-273: derived, and `cliBudget` cannot express this test —
    // it performs ZERO CLI spawns, driving the control socket directly, so any
    // spawn count would be a fiction. What it spends is the two polling gates
    // in `workerWithTranscript`; the five control calls are RPCs that return
    // as fast as the supervisor answers and are not waited on in a loop.
    gateBudget([IDLE_GATE_MS, TRANSCRIPT_GATE_MS]),
  );
});

/**
 * ISC-154, producer half: the supervisor samples the worktree at QUIESCE.
 *
 * This is the half that cannot be faked in `harvest.test.ts`, which writes
 * the task record by hand. The criterion's premise is that the two hashes are
 * taken at different moments by different code — if the harvester took both,
 * they would be two reads microseconds apart against one tree, always equal,
 * and the check could never fire. So one of them has to be taken HERE, in the
 * supervisor, in a different process, at the instant the epoch is declared
 * over. These tests are the evidence that it is.
 */
describe("the supervisor records a quiesce tree hash at settle (ISC-154)", () => {
  /** A real repository for the worker to have "worked" in. */
  async function scratchWorktree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-sup-tree-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await runGit(dir, ["init", "-q", "-b", "main"]);
    await runGit(dir, ["config", "user.email", "fixture@test"]);
    await runGit(dir, ["config", "user.name", "fixture"]);
    await writeFile(join(dir, "work.txt"), "original\n");
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-qm", "base"]);
    return dir;
  }

  test(
    "the settled task record carries a quiesce hash of the real worktree",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("treehash");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.tasksDir, { recursive: true });
      await mkdir(run.sessionsDir, { recursive: true });
      const workdir = await scratchWorktree();

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

      const dispatch = async (taskId: string): Promise<string | null> => {
        const reply = await controlCall(run, "eng-1", {
          cmd: "dispatch",
          envelope: makeEnvelope(runId, "eng-1", taskId, workdir),
          attempt_id: `att-${taskId}`,
          requested_epoch: null,
        });
        expect(reply["accepted"]).toBe(true);
        const settled = await waitFor(
          async () => (await readTaskRecord(taskRecordPath(wp, taskId))) !== null,
          10_000,
        );
        expect(settled).toBe(true);
        return (await readTaskRecord(taskRecordPath(wp, taskId)))!.tree_hash;
      };

      // THE assertion: a real git tree id, written by the supervisor, into
      // the durable record harvest reads. Before this wiring the field did
      // not exist and `tree_hash_quiesce` was null on every run in the fleet,
      // which is what made the live ISC-154 rule unreachable.
      const first = await dispatch("T-TREE-1");
      expect(first).toMatch(/^[0-9a-f]{40}$/);

      /**
       * And it is a MEASUREMENT, not a constant.
       *
       * A supervisor that wrote any fixed string — the empty tree, HEAD, a
       * placeholder — would satisfy the assertion above and still leave the
       * criterion inert, because two equal constants never differ. So the
       * tree is changed with an UNTRACKED file (the criterion's actual
       * scenario, and the one an index-only hash cannot see) and a second
       * task is dispatched through the same supervisor. The hash must move.
       */
      await writeFile(join(workdir, "background-output.log"), "written between settles\n");
      const second = await dispatch("T-TREE-2");
      expect(second).toMatch(/^[0-9a-f]{40}$/);
      expect(second).not.toBe(first);
    },
    // scratchWorktree = 5 git spawns, + 1 supervisor launch, + 2 settles each
    // costing `worktreeContentHash` 2 git spawns (`add -A`, `write-tree`).
    cliBudget(10),
  );

  /**
   * The absence direction, at the producer.
   *
   * A task dispatched with no worktree (`host_workdir: "unset"`) has no tree
   * to sample, and the supervisor must record that as null rather than
   * running git somewhere arbitrary or inventing a value. Null is what makes
   * the adjudicator stay silent; a sentinel string here would compare unequal
   * to a real harvest hash and void a task nobody could defend.
   */
  test(
    "a task with no worktree settles with a null hash, not a guess",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("treenull");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.tasksDir, { recursive: true });
      await mkdir(run.sessionsDir, { recursive: true });

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

      await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-TREE-NONE"),
        attempt_id: "att-none",
        requested_epoch: null,
      });
      const settled = await waitFor(
        async () => (await readTaskRecord(taskRecordPath(wp, "T-TREE-NONE"))) !== null,
        10_000,
      );
      expect(settled).toBe(true);
      const record = await readTaskRecord(taskRecordPath(wp, "T-TREE-NONE"));
      expect(record?.verdict).toBe("success");
      expect(record?.tree_hash).toBeNull();

      /**
       * And the null SAYS WHY — which the null alone never did.
       *
       * A null `tree_hash` has three origins: the sampler ran and could not
       * answer (`quiesce_sample_failed`), the epoch owned no workdir so
       * nothing was sampled (this case), or the sampler was never reached.
       * ISC-154 gave the first one a reason and left the other two sharing
       * one silence — so a reader who found no failure event could not tell
       * "correctly skipped" from "silently broken".
       *
       * That was not hypothetical: on 2026-08-27 a `container-live` run
       * failed on a null quiesce hash and the cause could not be recovered,
       * because the only diagnostic that existed had nothing to show and no
       * way to say whether that meant anything.
       *
       * Polled rather than read once: `logEvent` queues appends on a chain
       * shared with the worker's stderr, so the record can be enqueued before
       * the task record and land after it.
       */
      const skipped = await waitFor(async () => {
        const raw = await readFile(wp.eventsJsonl, "utf8").catch(() => "");
        return raw.includes('"quiesce_sample_skipped"');
      }, 5_000);
      const events = await readFile(wp.eventsJsonl, "utf8").catch(() => "");
      expect(
        skipped,
        `no quiesce_sample_skipped event in ${wp.eventsJsonl}:\n${events.slice(-2000)}`,
      ).toBe(true);
      const reasons = events
        .split("\n")
        .filter((l) => l.includes('"quiesce_sample_skipped"'))
        .map((l) => (JSON.parse(l) as { reason?: string }).reason ?? "");
      expect(reasons).toHaveLength(1);
      // The REASON, not merely the event: an event type with an empty reason
      // is the same silence wearing a name.
      expect(reasons[0]).toContain("no host workdir");
    },
    // 1 supervisor launch + 1 dispatch. No worktree by construction, so
    // `worktreeContentHash` is never reached and costs no git spawns.
    cliBudget(2),
  );
});

/**
 * ISC-299 — an epoch whose every write was refused is not `success`.
 *
 * **The measurement this exists for.** `container-live`'s first execution of
 * the whole chain on a Linux runner (2026-08-25) produced a worker that made
 * **17 native tool calls, 11 of which the filesystem refused** with
 * `EACCES: permission denied, open '/workspace/add.js'`, wrote nothing, and
 * settled `success`. `dispatch --auto` reported `verdict: success` and an
 * operator reading pifleet's own output would have been told the task worked.
 *
 * **Why the existing detector does not catch it.** ISC-108's reader asks
 * whether tools were CALLED — see the block above — and seventeen were. That
 * reader was itself built for F39's "worker looks healthy, streams, settles,
 * and does nothing"; this is the same shape one step over, and it needs a
 * different question: not *did it act* but *did anything change*.
 *
 * **Why the tree and not the error ratio.** Six of those seventeen calls
 * SUCCEEDED — the reads worked fine; only the writes were refused. A predicate
 * of "every call errored" is therefore satisfied by neither the real run nor
 * the fixture below, and would close nothing. The tree is the
 * model-independent evidence: whatever the agent believed it did, the disk
 * disagrees.
 *
 * **The three tests are one experiment, and each isolates one term of the
 * conjunction.** The first two share a single scenario and differ only in
 * whether the test writes into the worktree during the window it leaves open,
 * so neither can pass by the fixture merely being unusual. The third swaps the
 * scenario for one with no errors, so the reader cannot be passing by ignoring
 * the error count and condemning every unchanged tree — which would fail every
 * legitimately read-only task.
 */
/**
 * ISC-281 — the session-presence flag is latched at WRITE time, not on a timer.
 *
 * `recordSessionPath` sets `session_present` from `existsSync` at the instant
 * `get_state` first reports a path, which is BEFORE the transcript is created
 * lazily on the first assistant message — so it starts `false` and something
 * has to correct it. That correction used to be an inline check in the 250 ms
 * heartbeat, which made the heartbeat's PERIOD the flag's detection latency:
 * measured, a worker that had run a task to completion and whose transcript
 * held 400 tokens still read `session_present: false` at the instant
 * `dispatch --auto` exited, flipping ~400 ms later.
 *
 * The check now lives in `flushState`'s write chain and there is exactly one
 * of it. That single call site is what makes this test able to fail: with the
 * check in one place, deleting it disables the latch entirely rather than
 * merely slowing it down, so a behavioural probe catches what a structural one
 * would have to guess at. The structural half — that the call sits in the
 * write chain rather than back on the timer — is pinned separately in
 * `test/unit/supervisor-session-latch.test.ts`, because a heartbeat-based
 * implementation would pass everything below.
 */
describe("ISC-281: session_present is latched, and exactly once", () => {
  test(
    "a worker that produced a transcript reports it, with one transition event",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("sesslatch");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.tasksDir, { recursive: true });
      await mkdir(run.sessionsDir, { recursive: true });

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

      // At idle the path is recorded and the file does NOT yet exist — the
      // lazy creation this criterion is about. Asserting it here is what makes
      // the flip below a transition rather than a value that was always true.
      const atIdle = await readWorkerState(wp);
      expect(atIdle?.session_path).not.toBeNull();
      expect(existsSync(atIdle!.session_path!)).toBe(false);
      expect(atIdle?.session_present).toBe(false);

      const taskId = "T-SESSLATCH";
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", taskId, root),
        attempt_id: "att-sesslatch",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      expect(
        await waitFor(async () => (await readTaskRecord(taskRecordPath(wp, taskId))) !== null, 20_000),
      ).toBe(true);

      // THE CRITERION, read from the same on-disk file every consumer reads.
      const after = await waitFor(async () => (await readWorkerState(wp))?.session_present === true, 5_000);
      expect(after, "session_present never flipped — the latch never ran").toBe(true);

      const finalState = await readWorkerState(wp);
      expect(existsSync(finalState!.session_path!)).toBe(true);

      // Exactly ONE transition event, sampled the moment the flag flips.
      //
      // Read what this does and does NOT catch, because the difference was
      // measured rather than assumed. Dropping the latch's `!session_present`
      // guard makes it re-log on every flush — and this assertion STAYS GREEN
      // under that mutation, because the sample is taken within a tick or two
      // of the first fire and the duplicates have not accumulated yet. The
      // guard is pinned structurally instead
      // (`test/unit/supervisor-session-latch.test.ts`). Kept here anyway: it
      // is the assertion that would catch a latch firing on every state write
      // from the very first one, which is a different defect and a louder one.
      const events = await readEvents(wp.eventsJsonl);
      const transitions = events.filter((e) => e["type"] === "session_file_present");
      expect(transitions.length).toBe(1);
      expect(transitions[0]?.["path"]).toBe(finalState!.session_path);
    },
    cliBudget(8),
  );
});

// ---------------------------------------------------------------------------

describe("ISC-299: tool errors plus an unchanged tree is not success", () => {
  /** A real repository for the worker to have "worked" in. */
  async function scratchWorktree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-sup-nowork-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await runGit(dir, ["init", "-q", "-b", "main"]);
    await runGit(dir, ["config", "user.email", "fixture@test"]);
    await runGit(dir, ["config", "user.name", "fixture"]);
    await writeFile(join(dir, "add.js"), "function add(a, b) { return a + b; }\n");
    await runGit(dir, ["add", "-A"]);
    await runGit(dir, ["commit", "-qm", "base"]);
    return dir;
  }

  /**
   * Stand up a supervisor against `scenario`, dispatch one task at a real
   * worktree, optionally mutate that worktree while the epoch is open, and
   * return the settled record with the worker's events.
   *
   * `duringEpoch` is called after `controlCall` resolves, and that ordering is
   * load-bearing rather than incidental: the supervisor sets `liveWorkdir`,
   * samples the epoch baseline, and only then returns `accepted: true`
   * (`supervisor/index.ts` — the sample sits well above the return). So a write
   * made here is guaranteed to land AFTER the baseline, which is what makes
   * the changed-tree case deterministic instead of a race with the prompt.
   */
  async function runEpoch(
    label: string,
    scenario: string,
    duringEpoch?: (workdir: string) => Promise<void>,
  ): Promise<{
    record: Awaited<ReturnType<typeof readTaskRecord>>;
    events: Array<Record<string, unknown>>;
    workdir: string;
  }> {
    const root = await freshRoot();
    const runId = testRunId(label);
    const run = runPaths(runId, root);
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.tasksDir, { recursive: true });
    await mkdir(run.sessionsDir, { recursive: true });
    const workdir = await scratchWorktree();

    const { pid, pgid } = await processLauncher.launchDetached({
      runId,
      runDir: join(root, runId),
      workerId: "eng-1",
      argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
      env: { PIFLEET_PI_COMMAND: piCommand(scenario) },
      logPath: wp.supervisorLog,
    });
    cleanups.push(() => killSupervisor(pid, pgid));
    expect(await waitForIdle(wp, pid)).toBe(true);

    const taskId = `T-${label.toUpperCase()}`;
    const reply = await controlCall(run, "eng-1", {
      cmd: "dispatch",
      envelope: makeEnvelope(runId, "eng-1", taskId, workdir),
      attempt_id: `att-${label}`,
      requested_epoch: null,
    });
    expect(reply["accepted"]).toBe(true);

    if (duringEpoch !== undefined) await duringEpoch(workdir);

    const settled = await waitFor(
      async () => (await readTaskRecord(taskRecordPath(wp, taskId))) !== null,
      20_000,
    );
    expect(settled).toBe(true);

    return {
      record: await readTaskRecord(taskRecordPath(wp, taskId)),
      events: await readEvents(wp.eventsJsonl),
      workdir,
    };
  }

  test(
    "a worker whose writes were all refused settles failed:no_work_done",
    async () => {
      const { record, events } = await runEpoch("nowork", "refused-writes.json");

      // THE CRITERION. Before this reader existed both of these read
      // `success` / `quiesced` — a worker that changed nothing, certified as
      // having done it.
      expect(record?.verdict).toBe("failed");
      expect(record?.reason).toBe("no_work_done");

      /**
       * The verdict alone would be satisfied by any bug that failed this
       * task — a crash, a deadline, a refused dispatch. The detector's own
       * event is what shows this specific reader ran and why it fired, and
       * its payload carries the two facts the decision was made on.
       */
      const trip = events.find((e) => e["type"] === "no_work_done_detected");
      expect(trip, "the ISC-299 reader never ran").toBeDefined();
      expect(trip?.["tool_errors"]).toBe(3);

      // And it is NOT the ISC-108 path: five tools were called, so the prose
      // detector must have stayed silent. If this fires, the two readers are
      // entangled and this test would pass for the wrong reason.
      expect(events.some((e) => e["type"] === "no_tool_calls_detected")).toBe(false);
    },
    // scratchWorktree 5 git spawns + 1 supervisor launch + 2 for the epoch
    // baseline hash + 2 for the quiesce hash, and the fixture holds the turn
    // open for 3 s on purpose.
    cliBudget(12),
  );

  test(
    "the SAME fixture settles success once real work lands in the tree",
    async () => {
      const { record, events, workdir } = await runEpoch(
        "didwork",
        "refused-writes.json",
        async (dir) => {
          // Untracked, deliberately: it is the case an index-only hash cannot
          // see, and `worktreeContentHash` stages before hashing precisely so
          // that it can.
          await writeFile(join(dir, "subtract.js"), "function subtract(a, b) { return a - b; }\n");
        },
      );

      // Same scenario, same three tool errors, same supervisor. ONE variable
      // changed — the tree — and the verdict follows it. That is what shows
      // the reader is reading the tree rather than the error count.
      expect(record?.verdict).toBe("success");
      expect(record?.reason).toBe("quiesced");
      expect(events.some((e) => e["type"] === "no_work_done_detected")).toBe(false);
      expect(await Bun.file(join(workdir, "subtract.js")).exists()).toBe(true);
    },
    cliBudget(12),
  );

  test(
    "a clean read-only epoch that changes nothing is still success",
    async () => {
      // `happy.json`: one tool call, no errors. The tree is untouched, exactly
      // as in the first test — so a reader that condemned every unchanged tree
      // would fail this, and with it every legitimate "summarise these files"
      // task in the fleet. The error term is what stops that.
      const { record, events } = await runEpoch("readonly", "happy.json");

      expect(record?.verdict).toBe("success");
      expect(record?.reason).toBe("quiesced");
      expect(events.some((e) => e["type"] === "no_work_done_detected")).toBe(false);
    },
    cliBudget(10),
  );

  test(
    "a clean SECOND epoch is not condemned by the first epoch's errors",
    async () => {
      /**
       * The hazard this pins, and it is the one bug most likely to be
       * reintroduced by someone simplifying the reader.
       *
       * `state.tool_errors` is CUMULATIVE over a worker's entire life —
       * nothing resets it, deliberately, because `harvest` reports it as a
       * lifetime total. A reader that consulted that counter raw would carry
       * epoch one's three refusals into epoch two, and since epoch two also
       * changes nothing it would satisfy every term of the conjunction and
       * settle `failed`. The epoch-start snapshot is what makes the count
       * mean "errors THIS epoch".
       *
       * A single-epoch fixture cannot see this: with one task the delta and
       * the total are the same number, so the mutation is invisible. Two
       * epochs on ONE supervisor is the smallest arrangement that separates
       * them.
       */
      const root = await freshRoot();
      const runId = testRunId("twoepoch");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.tasksDir, { recursive: true });
      await mkdir(run.sessionsDir, { recursive: true });
      const workdir = await scratchWorktree();

      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        env: { PIFLEET_PI_COMMAND: piCommand("refused-then-clean.json") },
        logPath: wp.supervisorLog,
      });
      cleanups.push(() => killSupervisor(pid, pgid));
      expect(await waitForIdle(wp, pid)).toBe(true);

      const dispatch = async (taskId: string): Promise<void> => {
        const reply = await controlCall(run, "eng-1", {
          cmd: "dispatch",
          envelope: makeEnvelope(runId, "eng-1", taskId, workdir),
          attempt_id: `att-${taskId}`,
          requested_epoch: null,
        });
        expect(reply["accepted"]).toBe(true);
        expect(
          await waitFor(
            async () => (await readTaskRecord(taskRecordPath(wp, taskId))) !== null,
            20_000,
          ),
        ).toBe(true);
      };

      await dispatch("T-EPOCH-1");
      await dispatch("T-EPOCH-2");

      // Epoch one is the ISC-299 case and must be caught — without this the
      // test could pass on a reader that never fires at all.
      const first = await readTaskRecord(taskRecordPath(wp, "T-EPOCH-1"));
      expect(first?.verdict).toBe("failed");
      expect(first?.reason).toBe("no_work_done");

      // THE assertion. Epoch two called one tool, it succeeded, and the tree
      // is untouched — a clean read-only turn. Under a cumulative error count
      // this reads `failed` / `no_work_done`.
      const second = await readTaskRecord(taskRecordPath(wp, "T-EPOCH-2"));
      expect(second?.verdict).toBe("success");
      expect(second?.reason).toBe("quiesced");

      // Exactly one trip, belonging to the first epoch.
      const events = await readEvents(wp.eventsJsonl);
      const trips = events.filter((e) => e["type"] === "no_work_done_detected");
      expect(trips).toHaveLength(1);
      expect(trips[0]?.["task_id"]).toBe("T-EPOCH-1");
    },
    // scratchWorktree 5 + 1 launch + 2 epochs x (2 baseline + 2 quiesce).
    cliBudget(14),
  );
});

/**
 * ISC-282: the stall policy's production ACTION, against a live wedged agent.
 *
 * ISC-110 and ISC-117 have sat at `[~]` since the stall-wiring commission for
 * one narrow reason, restated here so this block is judged against it: the
 * scheduler's handling of a `kill` verdict is proved in
 * `test/unit/scheduler-stall.test.ts` against an INJECTED clock and a FAKE
 * `eventSilenceMs`, so what was demonstrated was the policy, not the two
 * production halves that feed and follow it. `test/unit/stall-io.test.ts` now
 * covers the input against real files. This covers the other end — the `abort`
 * RPC `killWedged` sends — because that one cannot be answered without a real
 * supervisor: the question is literally whether a wedged agent replies.
 *
 * **The wedge is real, not asserted.** `aborted.json` emits `agent_start` and
 * `turn_start` and then says nothing for thirty seconds while holding the
 * slot. That is the shape ISC-117 names — a LIVE supervisor wrapped around an
 * agent that has stopped emitting — and it is the case the reaper cannot
 * reach, because the reaper watches heartbeats and this supervisor's heartbeat
 * is healthy throughout.
 *
 * **Why the thirty seconds is the discriminator.** The scenario settles on its
 * own at 30 s. The settle gate below is 15 s — half of it — so a run in which
 * the abort did nothing cannot pass by the scenario simply running out. The
 * envelope's `deadline_s` is the default 300 s for the same reason, one door
 * further along: a `timed_out` verdict is impossible here, so it cannot be
 * mistaken for the RPC working.
 *
 * **The real `abortWedged` is called, not `controlCall` directly.** Driving
 * the RPC by hand would prove the socket answers and leave the criterion
 * exactly where it was — a correct mechanism beside the path nothing
 * exercises, which is the RC-1 shape this ISA has now recorded nine times.
 * `cli/commands/dispatch.ts`'s `killWedged` is a one-line delegation to this
 * function, so what runs here is what runs in production.
 */
describe("ISC-282: the abort rung ends a live wedged agent, and the task settles", () => {
  test(
    "a worker silent while holding the slot is aborted, and settles inside its own deadline",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("stall-abort");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");

      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        env: { PIFLEET_PI_COMMAND: piCommand("aborted.json") },
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));
      expect(await waitForIdle(wp, pid)).toBe(true);

      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-WEDGE-1"),
        attempt_id: "wedge-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      // The wedge begins at `agent_start`: from here the scenario emits
      // nothing for thirty seconds, so the events file stops moving while the
      // worker still holds the slot.
      const started = await waitFor(async () => {
        // Pi's own stream events arrive WRAPPED — the supervisor's record is
        // `type: "event"` with the agent's event nested under `event`.
        return (await readEvents(wp.eventsJsonl)).some((e) => {
          const inner = e["event"] as { type?: string } | undefined;
          return e["type"] === "event" && inner?.type === "turn_start";
        });
      }, 20_000);
      expect(started).toBe(true);

      /**
       * The PRODUCTION input, read off a real supervisor's file (ISC-282's
       * first half, tied here to a real worker rather than a fixture). Two
       * readings across a real gap: a constant, a zero, or a `null` would all
       * satisfy "returns a number" and none of them would be a silence.
       */
      const first = await eventSilenceMs(run, "eng-1");
      expect(first).not.toBeNull();
      await new Promise((r) => setTimeout(r, 600));
      const second = await eventSilenceMs(run, "eng-1");
      expect(second!).toBeGreaterThan(first!);
      expect(second!).toBeGreaterThanOrEqual(500);

      /**
       * THE CRITERION. The real function the scheduler's `killWedged` calls,
       * with the real `LedgerWriter` production hands it.
       */
      const ledger = new LedgerWriter(run, `test-stall-${process.pid}`);
      await abortWedged({ run, worker: "eng-1", taskId: "T-WEDGE-1", ledger });

      // Fifteen seconds — HALF the scenario's own 30 s tail, so a task that
      // settled because the fixture ran out cannot pass this gate.
      const settled = await waitFor(
        async () => (await readTaskRecord(taskRecordPath(wp, "T-WEDGE-1"))) !== null,
        15_000,
      );
      expect(settled).toBe(true);

      const record = await readTaskRecord(taskRecordPath(wp, "T-WEDGE-1"));
      expect(record?.verdict).toBe("aborted");

      // Nothing else ended this task. A deadline would have produced
      // `timed_out` at 300 s, which this run never reaches.
      const events = await readEvents(wp.eventsJsonl);
      expect(events.some((e) => e["type"] === "deadline_exceeded")).toBe(false);

      // The durable evidence that the policy fired, with its numbers.
      const { records } = await mergeLedger(run);
      const kill = records.find((r) => r.event === "worker_stall_kill");
      expect(kill).toBeDefined();
      expect(kill?.detail?.["worker"]).toBe("eng-1");
      expect(kill?.detail?.["task_id"]).toBe("T-WEDGE-1");
      expect(kill?.detail?.["reason"]).toBe("event_stall_kill");

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    // Gates: idle (20 s), agent_start (20 s), the 600 ms silence sample, the
    // settle (15 s), shutdown (5 s). No CLI and no container, so neither
    // `cliBudget` nor `containerBudget` describes this test's cost (ISC-273).
    gateBudget([20_000, 20_000, 600, 15_000, 5_000]),
  );

  /**
   * The control, one condition different: the supervisor is GONE.
   *
   * `abortWedged`'s contract is deliberately asymmetric and this is what pins
   * it. The ledger record is written first and its failure propagates, because
   * it is the only durable evidence the policy fired; the RPC that follows may
   * fail freely, because a wedged agent with no working socket is consistent
   * with the diagnosis rather than evidence against it. Without this test the
   * `.catch(() => {})` on the `controlCall` is a claim nobody checks — and the
   * scheduler calls `killWedged` inside its own `.catch`, so a throw here
   * would be swallowed there and the run would silently stop acting on stalls.
   */
  test(
    "a dead supervisor does not throw, and the kill is recorded anyway",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("stall-dead");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");

      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        env: { PIFLEET_PI_COMMAND: piCommand("aborted.json") },
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));
      expect(await waitForIdle(wp, pid)).toBe(true);

      // The run tree — and the control secret — survive; only the process
      // dies. So `controlCall` gets as far as a real socket connect and fails
      // there, which is the production shape rather than a missing-file error.
      await killSupervisor(pid, pgid);
      expect(await waitFor(async () => (await processStartTime(pid)) === null, 5_000)).toBe(true);
      expect(existsSync(wp.stateJson)).toBe(true);

      const ledger = new LedgerWriter(run, `test-stall-dead-${process.pid}`);
      await abortWedged({ run, worker: "eng-1", taskId: "T-WEDGE-2", ledger, timeoutMs: 2_000 });

      const { records } = await mergeLedger(run);
      const kill = records.find((r) => r.event === "worker_stall_kill");
      expect(kill).toBeDefined();
      expect(kill?.detail?.["task_id"]).toBe("T-WEDGE-2");
    },
    gateBudget([20_000, 5_000, 2_000]),
  );
});

/**
 * ISC-147: the completion property over EVERY hostile scenario, on real
 * supervisor routing.
 *
 * `completion.test.ts`'s table replays the same fixtures in process against
 * `EpochManager` + `CompletionTracker`, and its own entry records why that is
 * not the criterion's quantifier: `delay_ms`, `noise` and `partial` are
 * SKIPPED as markers and the harness never issues an abort. Here they are
 * real — a real supervisor, a real `fake-pi` child, a real control socket.
 * `delay_ms` is waited out, `partial` truncates a JSON line mid-write, the
 * abort is an RPC.
 *
 * **THE PROPERTY.** A task settling `success` must have a LIVE-attributed
 * terminal `agent_end{willRetry:false}` behind it. A success without one is a
 * completion declared while the agent was still going to emit — ISC-147's
 * sentence, made answerable from the events file. Liveness is read by
 * EXCLUSION from the supervisor's own `epoch_attribution` records rather than
 * recomputed: the standing complaint against `simulate()` is that it
 * re-implements the routing, so this must not re-implement the attribution.
 *
 * **EVERY FIXTURE HAS AN ENTRY, INCLUDING THE ONES NOT RUN HERE.** A scenario
 * added later fails the suite until it declares one, and a deferral must name
 * where the coverage actually lives. A quantifier that quietly skips its hard
 * cases is how this criterion came to be graded far above what it held.
 *
 * **WHY THE VERDICTS ARE PINNED AND NOT LOOSENED TO "not success".** Each
 * entry states the verdict the fixture's own `_why`/`_comment` describes. A
 * `not.toBe("success")` would pass for a scenario that failed for entirely the
 * wrong reason — a `timed_out` standing in for the truncation guard, say — and
 * that is the failure mode this block exists to rule out.
 */
describe("ISC-147: the completion property across every hostile scenario", () => {
  /** Seqs the supervisor itself attributed to a settled epoch. */
  function priorSeqs(events: Array<Record<string, unknown>>): Set<number> {
    return new Set(
      events
        .filter((e) => e["type"] === "epoch_attribution" && e["attributed"] === "prior")
        .map((e) => e["seq"] as number),
    );
  }

  /**
   * A terminal `agent_end` the supervisor routed to the LIVE epoch.
   * `willRetry:true` is not terminal — that is ISC-82, and a scenario whose
   * only end carries it must never produce a success.
   */
  function hasLiveTerminalEnd(events: Array<Record<string, unknown>>): boolean {
    const prior = priorSeqs(events);
    return events.some((e) => {
      if (e["type"] !== "event" || prior.has(e["seq"] as number)) return false;
      const inner = e["event"] as { type?: string; willRetry?: unknown } | undefined;
      return inner?.type === "agent_end" && inner.willRetry === false;
    });
  }

  interface RunCoverage {
    kind: "run";
    /** The verdict this fixture's own comment describes. Pinned, never loosened. */
    verdict: string;
    liveTerminalEnd: boolean;
    deadlineS?: number;
    abort?: boolean;
    settleBudgetMs: number;
    why?: string;
  }
  interface ElsewhereCoverage {
    kind: "elsewhere";
    /** Where the real-routing coverage lives, and why it is not duplicated here. */
    why: string;
  }
  type Coverage = RunCoverage | ElsewhereCoverage;

  const COVERAGE: Record<string, Coverage> = {
    "happy.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 20_000 },
    "will-retry.json": {
      kind: "run",
      verdict: "success",
      liveTerminalEnd: true,
      settleBudgetMs: 25_000,
      why: "the intermediate willRetry:true end is really routed, not replayed",
    },
    "quiet-retry.json": {
      kind: "run",
      verdict: "success",
      liveTerminalEnd: true,
      settleBudgetMs: 25_000,
      why: "Pi reports isStreaming:false mid-retry — the only fixture where the tracker's own conditions are load-bearing",
    },
    "slow-turn.json": {
      kind: "run",
      verdict: "success",
      liveTerminalEnd: true,
      settleBudgetMs: 25_000,
      why: "delay_ms waited out rather than skipped",
    },
    "truncated.json": {
      kind: "run",
      verdict: "failed",
      liveTerminalEnd: false,
      settleBudgetMs: 25_000,
      why: "partial: a half-written agent_end must never be completed into a record",
    },
    "aborted.json": {
      kind: "run",
      verdict: "aborted",
      liveTerminalEnd: true,
      abort: true,
      settleBudgetMs: 15_000,
      why: "a real abort the agent ANSWERS with a clean end",
    },
    "deaf-abort.json": {
      kind: "run",
      verdict: "timed_out",
      liveTerminalEnd: false,
      deadlineS: 8,
      abort: true,
      settleBudgetMs: 40_000,
      why: "a real abort the agent IGNORES; the deadline ladder must end it",
    },
    "bad-correlation.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "duplicate-end.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "late-export.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "slow-export.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "late-failure.json": { kind: "run", verdict: "failed", liveTerminalEnd: false, settleBudgetMs: 25_000 },
    "late-response.json": {
      kind: "run",
      verdict: "timed_out",
      liveTerminalEnd: false,
      deadlineS: 6,
      settleBudgetMs: 30_000,
      why: "no prompt step at all: the epoch is acked and never spoken to again",
    },
    "no-tool-calls.json": { kind: "run", verdict: "failed", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    /**
     * THE ONE THAT MUST NOT SETTLE. A `queue_update` with non-empty steering
     * lands BETWEEN the two probe reads, so one quiet gauge sample must not
     * beat evidence of pending output. The scenario re-injects it on every
     * probe, so the completion path never confirms and the DEADLINE is what
     * ends the epoch — `timed_out` here is the property holding, not failing.
     * The deadline is compressed to 6 s so the default 300 s is not what makes
     * this test slow.
     */
    "queue-race.json": {
      kind: "run",
      verdict: "timed_out",
      liveTerminalEnd: true,
      deadlineS: 6,
      settleBudgetMs: 30_000,
      why: "a mid-probe steering queue_update must prevent completion entirely",
    },
    "refused-then-clean.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "refused-writes.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "stale-epoch.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "ui-dialogs.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "ui-editor.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "ui-fire-and-forget.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "ui-mixed.json": { kind: "run", verdict: "success", liveTerminalEnd: true, settleBudgetMs: 25_000 },
    "noisy-fleet.json": {
      kind: "elsewhere",
      why: "a three-script FLEET fixture — eng-1 floods stderr, eng-2 floods stdout, the rest run 50ms turns. Driven through real supervisors by ISC-158's starvation test, whose assertion (quiet workers settle WHILE the flood is in flight) is strictly stronger than this property. Replaying it against one worker here would duplicate that rig to assert less.",
    },
    "interleave.json": {
      kind: "elsewhere",
      why: "ISC-84's fixture, driven through a real worker by lifecycle.test.ts, which lands an abort inside a scripted window and asserts the epoch-attribution outcome. ISC-283 records what that timing cost to get right; a second copy here would reintroduce the race it fixed.",
    },
  };

  async function runScenario(
    file: string,
    cov: RunCoverage,
  ): Promise<{ verdict: string; events: Array<Record<string, unknown>> }> {
    const name = file.replace(/[^a-z0-9]/gi, "").slice(0, 14);
    const root = await freshRoot();
    const runId = testRunId(name);
    const run = runPaths(runId, root);
    const wp = workerPaths(run, "eng-1");
    const taskId = `T-${name.toUpperCase()}`;

    const { pid, pgid } = await processLauncher.launchDetached({
      runId,
      runDir: join(root, runId),
      workerId: "eng-1",
      env: { PIFLEET_PI_COMMAND: piCommand(file) },
      argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
      logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
    });
    cleanups.push(() => killSupervisor(pid, pgid));
    expect(await waitForIdle(wp, pid)).toBe(true);

    const envelope = {
      ...makeEnvelope(runId, "eng-1", taskId),
      ...(cov.deadlineS === undefined ? {} : { deadline_s: cov.deadlineS }),
    } as TaskEnvelope;
    const reply = await controlCall(run, "eng-1", {
      cmd: "dispatch",
      envelope,
      attempt_id: `${name}-attempt-1`,
      requested_epoch: null,
    });
    expect(reply["accepted"]).toBe(true);

    if (cov.abort === true) {
      // Anchored on an OBSERVED event, never a fixed sleep (ISC-283): the
      // window starts where the turn does, not where the test launched.
      const open = await waitFor(async () => {
        return (await readEvents(wp.eventsJsonl)).some((e) => {
          const inner = e["event"] as { type?: string } | undefined;
          return e["type"] === "event" && inner?.type === "turn_start";
        });
      }, 20_000);
      expect(open).toBe(true);
      await controlCall(run, "eng-1", { cmd: "abort" }, { timeoutMs: 10_000 }).catch(() => {});
    }

    const settled = await waitFor(
      async () => (await readTaskRecord(taskRecordPath(wp, taskId))) !== null,
      cov.settleBudgetMs,
    );
    expect(settled).toBe(true);
    const record = await readTaskRecord(taskRecordPath(wp, taskId));

    await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
    await waitFor(async () => (await processStartTime(pid)) === null, 5_000);

    return { verdict: record?.verdict ?? "MISSING", events: await readEvents(wp.eventsJsonl) };
  }

  const scenariosDir = join(ROOT_URL, "test/fixtures/scenarios");

  test("every scenario on disk is covered or explicitly deferred", async () => {
    const files = (await readdir(scenariosDir)).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      expect(
        COVERAGE[f],
        `${f} has no COVERAGE entry — a new scenario must declare one, or name where it is covered`,
      ).toBeDefined();
    }
    for (const name of Object.keys(COVERAGE)) {
      expect(files, `${name} is covered but missing from scenarios/`).toContain(name);
    }
    // A deferral without a destination is a silent omission wearing a label.
    for (const [name, cov] of Object.entries(COVERAGE)) {
      if (cov.kind === "elsewhere") {
        expect(cov.why.length, `${name}'s deferral must say where the coverage lives`).toBeGreaterThan(40);
      }
    }
  });

  for (const [file, cov] of Object.entries(COVERAGE)) {
    if (cov.kind !== "run") continue;
    test(
      `${file}: settles ${cov.verdict}${cov.why === undefined ? "" : ` — ${cov.why}`}`,
      async () => {
        const r = await runScenario(file, cov);
        expect(r.verdict).toBe(cov.verdict);
        expect(hasLiveTerminalEnd(r.events)).toBe(cov.liveTerminalEnd);
      },
      gateBudget([20_000, 20_000, cov.settleBudgetMs, 5_000]),
    );
  }
});

/**
 * ISC-141 — the epoch fence, at the only site where it decides anything.
 *
 * ## What this closes, and the correction it rests on
 *
 * The criterion asks that "epoch attribution uses the RPC stream offset". The
 * previous grade recorded that the supervisor could be made to IGNORE the
 * offset entirely — `em.attribute(seq)` rewritten to
 * `em.attribute(Number.MAX_SAFE_INTEGER)` — and every suite stayed green, and
 * concluded that a supervisor-level test was missing.
 *
 * It is not missing; it is IMPOSSIBLE at that site, and reading three files
 * says why. `RpcClient` dispatches records synchronously and in stream order
 * (`client.ts`: `pending.onAck?.(seq)` and `onEvent(msg, seq)` in one loop).
 * `EpochManager.attribute` answers `live` only when `ack_seq !== null && seq >
 * ack_seq`. `windowOpen` only becomes true through `bindStart`, which itself
 * requires `attribute(seq) === "live"`. So the window opens at some
 * `seq_start > ack_seq`, and every record after it has a still higher seq —
 * the COMPARISON `seq > ack_seq` is therefore never evaluated with a seq that
 * could fail it. It is dead for an in-order stream.
 *
 * What is NOT dead, and what this test drives, is the other conjunct:
 * `ack_seq !== null`. Before the live epoch's prompt is acknowledged there is
 * no fence post, and everything in that region must be `prior` — including an
 * `agent_start`, which would otherwise BIND the window and hand a settled
 * epoch's straggler the power to complete the new one.
 *
 * That region was unreachable from a scenario until now: `emit` and
 * `emit_after_respond` both run after the ack. `emit_before_ack` (new, in
 * `fake-pi.ts`) is what puts a record below `ack_seq`, and it is the shape a
 * real worker produces whenever a previous turn is still draining as the next
 * prompt arrives — the drain and the ack share one pipe and the drain got
 * there first.
 */
describe("ISC-141: a stale agent_start before the ack cannot open the epoch's window", () => {
  test(
    "the pre-ack start is attributed prior, and the post-ack start is what binds",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("fence");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");

      const { pid, pgid } = await processLauncher.launchDetached({
        runId,
        runDir: join(root, runId),
        workerId: "eng-1",
        env: { PIFLEET_PI_COMMAND: piCommand("stale-start.json") },
        argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
        logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
      });
      cleanups.push(() => killSupervisor(pid, pgid));
      expect(await waitForIdle(wp, pid)).toBe(true);

      // Epoch 1: starts and ends immediately, so it is SETTLED before the
      // second dispatch. Without that the second prompt would be refused by
      // the double's own worker-side high-water-mark and nothing below would
      // be about the supervisor at all.
      const first = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-FENCE-1"),
        attempt_id: "fence-attempt-1",
        requested_epoch: null,
      });
      expect(first["accepted"]).toBe(true);
      expect(
        await waitFor(
          async () => (await readTaskRecord(taskRecordPath(wp, "T-FENCE-1"))) !== null,
          20_000,
        ),
      ).toBe(true);

      // Epoch 2. The double emits one `agent_start` BEFORE acking this prompt.
      const second = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "eng-1", "T-FENCE-2"),
        attempt_id: "fence-attempt-2",
        requested_epoch: null,
      });
      expect(second["accepted"]).toBe(true);
      expect(
        await waitFor(
          async () => (await readTaskRecord(taskRecordPath(wp, "T-FENCE-2"))) !== null,
          20_000,
        ),
      ).toBe(true);

      const events = await readEvents(wp.eventsJsonl);

      /**
       * THE CRITERION. The pre-ack `agent_start` is recorded as prior, with
       * the stream's true seq on the record — not merely dropped, and not
       * merely counted.
       */
      const refused = events.filter(
        (e) => e["type"] === "epoch_attribution" && e["event_type"] === "agent_start",
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]?.["attributed"]).toBe("prior");
      const refusedSeq = refused[0]?.["seq"];
      expect(typeof refusedSeq).toBe("number");

      /**
       * THE POSITIVE CONTROL, and the half that stops this passing on a fence
       * that refuses everything: epoch 2's window DID open, exactly once, on
       * the `agent_start` that came after the ack — at a strictly higher seq
       * than the one refused above. Both numbers come from the supervisor's
       * own records, so this is the stream's true offsets being compared, not
       * a pair this test chose.
       */
      const started2 = events.filter(
        (e) => e["type"] === "epoch_started" && e["epoch"] === 2,
      );
      expect(started2).toHaveLength(1);
      expect(started2[0]?.["seq"] as number).toBeGreaterThan(refusedSeq as number);

      /**
       * And the run still works. A fence that refused the post-ack start too
       * would leave T-FENCE-2 unsettled or settled by the wrong path, so the
       * verdict is asserted rather than assumed — it is what separates "the
       * stale start was refused" from "nothing was accepted".
       */
      const record = await readTaskRecord(taskRecordPath(wp, "T-FENCE-2"));
      expect(record?.verdict).toBe("success");

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    // Four gates: idle (20 s), two settle waits (20 s each), shutdown (5 s).
    // No CLI and no container, so neither cliBudget nor containerBudget
    // describes this test's cost (ISC-273).
    gateBudget([20_000, 20_000, 20_000, 5_000]),
  );
});
