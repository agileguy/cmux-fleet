/**
 * `dispatch --auto` end-to-end: the real CLI, real detached supervisors, the
 * fake Pi (SRD §9.3, §14.2).
 *
 * Three properties only this level can prove, because each needs the real
 * dispatch path and real settle records rather than the unit suite's fakes:
 *
 * - Dependency gating holds across processes: B's envelope reaches a worker
 *   only after A's task record exists on disk, evidenced by dispatch order in
 *   the CLI's ledger shard and by which worker B landed on.
 * - A failed dependency propagates through a chain with the ROOT cause named:
 *   A times out on a deaf-abort agent, and C — two hops away — is blocked_by
 *   A, not by its blocked neighbour B.
 * - Refusals precede side effects: a cyclic list exits 2 with the cycle
 *   printed and the inbox EMPTY. The absence is the assertion; the exit code
 *   alone would also pass if the cycle were detected after dispatching.
 *
 * The failure rig launches supervisors directly (supervisor.test.ts pattern)
 * instead of through `up`, because `PIFLEET_PI_COMMAND` is one value per
 * process and this test needs a deaf agent and a healthy one in the SAME run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EXIT, ScheduledTaskSchema } from "../../src/contracts.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { readWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT_URL, "src/cli/index.ts");
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");
const TASKLISTS = join(ROOT_URL, "test/fixtures/tasklists");

const ScheduleJson = z.array(ScheduledTaskSchema);

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

interface Rig {
  root: string;
  env: Record<string, string>;
}

async function makeRig(scenario: string): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-auto-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "runs");
  return {
    root,
    env: {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, scenario)}`,
    },
  };
}

async function cli(
  rig: Rig,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...rig.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

async function waitFor(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    if (await cond()) return true;
    if (performance.now() - start > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Same collision defence as supervisor.test.ts: control sockets hash
// (run_id, worker) into the SHARED os tmpdir, so a hardcoded run id would let
// two concurrent test processes reach each other's supervisors.
const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describe("dispatch --auto against a real fleet (happy chain)", () => {
  test(
    "B waits for A, lands after it, and the schedule reaches disk and stdout as the same seam",
    async () => {
      const rig = await makeRig("happy.json");
      const up = await cli(rig, ["up", "--workers", "w1,w2", "--backend", "headless", "--json"]);
      expect(up.code).toBe(EXIT.SUCCESS);
      const runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
      cleanups.push(async () => {
        await cli(rig, ["down", "--run", runId, "--json"]);
      });
      const run = runPaths(runId, rig.root);

      const auto = await cli(rig, [
        "dispatch",
        "--auto",
        "--tasks",
        join(TASKLISTS, "chain.json"),
        "--run",
        runId,
        "--json",
      ]);
      expect(auto.stderr).toBe("");
      expect(auto.code).toBe(EXIT.SUCCESS);

      // Requirement 7: --json emits ScheduledTask[] — the seam schema
      // verbatim, not a lookalike.
      const schedule = ScheduleJson.parse(JSON.parse(auto.stdout.trim()));
      const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));
      expect(schedule.map((t) => t.id)).toEqual(["a", "b"]);
      expect(byId["a"]).toMatchObject({ state: "done", verdict: "success", task_id: "a" });
      expect(byId["b"]).toMatchObject({ state: "done", verdict: "success" });

      // 'a' goes to the first idle worker in sorted order — deterministic:
      // `scheduler.ts` sorts `listWorkers()` and takes `available[0]`.
      expect(byId["a"]!.worker).toBe("w1");

      // And ledger order: both dispatched rows sit in the ONE CLI shard, so
      // their seq numbers are totally ordered; 'b' strictly after 'a'.
      const { records, errors } = await mergeLedger(run);
      expect(errors).toEqual([]);
      const dispatched = records.filter((r) => r.event === "dispatched");
      expect(dispatched.map((r) => r.task_id)).toEqual(["a", "b"]);
      expect(dispatched[0]!.actor).toBe(dispatched[1]!.actor);
      expect(dispatched[0]!.seq).toBeLessThan(dispatched[1]!.seq);

      /**
       * Dependency gating, asserted on the ELAPSED GAP rather than on which
       * worker 'b' landed on.
       *
       * This replaces `expect(byId["b"]!.worker).toBe("w1")`, which was
       * load-sensitive and failed intermittently in CI (observed: `Expected:
       * "w1" / Received: "w2"`). That assertion's stated reasoning — "with w2
       * idle the whole time, only readiness explains 'b' on w1" — does not
       * hold. Once 'a' settles, BOTH workers are idle and 'b' is ready, so
       * which one takes it depends on whether w1's `workerHealth` probe has
       * observed it return to idle yet. Under load it has not, `available`
       * becomes `["w2"]`, and 'b' lands on w2 having been perfectly correctly
       * gated. The old assertion conflated "was 'b' gated on 'a'" with "did w1
       * recover first", and only the first is a claim about the scheduler.
       *
       * The gap is the direct evidence, and it is strictly stronger. An
       * UNGATED scheduler dispatches both in the same pass, microseconds
       * apart; a gated one cannot dispatch 'b' until 'a' has settled, which
       * costs 'a's whole execution. Measured over 6 local runs: 237, 241, 241,
       * 244, 246, 262 ms — versus ~0-5ms for a same-pass dispatch. 100ms sits
       * clear of both, and the margin only WIDENS under load, because load
       * makes 'a' take longer rather than shorter. That is the right direction
       * for a CI assertion to be wrong in.
       *
       * Note this also catches a case the old assertion missed entirely: an
       * ungated scheduler that happened to put 'b' on w1 anyway.
       */
      const gapMs = Date.parse(dispatched[1]!.ts) - Date.parse(dispatched[0]!.ts);
      expect(gapMs).toBeGreaterThan(100);

      // The durable schedule record (run/paths.ts scheduleJson): what
      // `report` reads must be byte-for-byte the seam stdout carried.
      const onDisk = ScheduleJson.parse(JSON.parse(await Bun.file(run.scheduleJson).text()));
      expect(onDisk).toEqual(schedule);

      // Both envelopes reached the inbox — the durable §7.1 record.
      expect((await readdir(run.inboxDir)).sort()).toEqual(["a.json", "b.json"]);
    },
    120_000,
  );
});

describe("dispatch --auto failure propagation names the root cause", () => {
  test(
    "A times out -> B blocked by A -> C blocked by A (never by B); the sibling still succeeds",
    async () => {
      const rig = await makeRig("happy.json");
      const runId = `auto-blocked-${RUN_TAG}`;
      const run = runPaths(runId, rig.root);

      // Two supervisors, two scenarios, one run: w-bad's agent ignores abort
      // so A's 1s deadline escalates to a timed_out settle; w-ok is healthy.
      const workers: Array<{ id: string; scenario: string }> = [
        { id: "w-bad", scenario: "deaf-abort.json" },
        { id: "w-ok", scenario: "happy.json" },
      ];
      for (const w of workers) {
        const { pid, pgid } = await processLauncher.launchDetached({
          runId,
          runDir: run.root,
          workerId: w.id,
          argv: supervisorArgv({ runsRoot: rig.root, runId, workerId: w.id }),
          env: {
            PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, w.scenario)}`,
          },
          logPath: join(run.root, "workers", w.id, "supervisor.log"),
        });
        cleanups.push(async () => {
          await controlCall(run, w.id, { cmd: "shutdown" }).catch(() => {});
          if ((await processStartTime(pid)) !== null) {
            try {
              process.kill(-pgid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        });
      }
      for (const w of workers) {
        const idle = await waitFor(
          async () =>
            (await readWorkerState(workerPaths(run, w.id)).catch(() => null))?.phase === "idle",
          20_000,
        );
        expect(idle).toBe(true);
      }

      const auto = await cli(rig, [
        "dispatch",
        "--auto",
        "--tasks",
        join(TASKLISTS, "blocked-chain.json"),
        "--run",
        runId,
        "--json",
      ]);
      // timed_out maps to TIMEOUT, which outranks the blocked tasks' PARTIAL
      // on the §10 ladder.
      expect(auto.code).toBe(EXIT.TIMEOUT);

      const schedule = ScheduleJson.parse(JSON.parse(auto.stdout.trim()));
      const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));

      expect(byId["A"]).toMatchObject({ state: "done", verdict: "timed_out", worker: "w-bad" });
      expect(byId["B"]).toMatchObject({ state: "blocked", blocked_by: "A", worker: null });
      // THE assertion of this file: two hops from the failure, the cause is
      // still the task that actually failed. 'B' here would be the cascade
      // of identical blocked lines the seam comment forbids — B never ran.
      expect(byId["C"]).toMatchObject({ state: "blocked", blocked_by: "A" });
      expect(byId["D"]).toMatchObject({ state: "done", verdict: "success", worker: "w-ok" });

      // Blocked tasks were never dispatched: no envelope, no inbox record.
      expect((await readdir(run.inboxDir)).sort()).toEqual(["A.json", "D.json"]);

      // The durable record agrees with stdout after a partial failure too —
      // this is the copy `report` will describe the wreckage from.
      const onDisk = ScheduleJson.parse(JSON.parse(await Bun.file(run.scheduleJson).text()));
      expect(onDisk).toEqual(schedule);
    },
    120_000,
  );
});

describe("a cyclic list is refused before anything runs", () => {
  test(
    "exit 2 names the cycle; the inbox stays empty and no schedule record is written",
    async () => {
      const rig = await makeRig("happy.json");
      const up = await cli(rig, ["up", "--workers", "w1", "--backend", "headless", "--json"]);
      expect(up.code).toBe(EXIT.SUCCESS);
      const runId = (JSON.parse(up.stdout.trim()) as { run_id: string }).run_id;
      cleanups.push(async () => {
        await cli(rig, ["down", "--run", runId, "--json"]);
      });
      const run = runPaths(runId, rig.root);

      const auto = await cli(rig, [
        "dispatch",
        "--auto",
        "--tasks",
        join(TASKLISTS, "cycle.json"),
        "--run",
        runId,
        "--json",
      ]);
      expect(auto.code).toBe(EXIT.USAGE);
      // The PATH, not just the word: r1 -> r3 -> r2 -> r1 (or a rotation).
      expect(auto.stderr).toContain("dependency cycle:");
      for (const id of ["r1", "r2", "r3"]) expect(auto.stderr).toContain(id);

      // Nothing was dispatched — absence, not inference from the exit code.
      // The inbox dir may not even exist yet; both spellings of "empty" pass.
      const inbox = await readdir(run.inboxDir).catch(() => [] as string[]);
      expect(inbox).toEqual([]);
      // And no schedule record: a refusal that never scheduled anything must
      // not leave a file for `report` to mistake for a run.
      expect(existsSync(run.scheduleJson)).toBe(false);
      // The workers were never disturbed: still idle, still alive.
      expect((await readWorkerState(workerPaths(run, "w1")))?.phase).toBe("idle");
    },
    60_000,
  );
});
