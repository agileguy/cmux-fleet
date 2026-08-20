/**
 * The budget against a REAL fleet: `dispatch --auto`, real detached
 * supervisors, the fake Pi (ISC-109, ISC-114, ISC-115, ISC-193).
 *
 * Two properties only this level can prove, because each is a claim about a
 * RUN rather than about `BudgetManager` — which is the distinction four audits
 * kept recording as the reason these criteria stayed open. `budget.ts` was
 * fully unit-tested and imported by nothing, so every green test in the repo
 * was a statement about a module no invocation of this CLI could reach.
 *
 *  - A ceiling crossed mid-run HALTS DISPATCH and the process EXITS 5, while
 *    the tasks that were already in flight still settle and everything they
 *    produced is still harvestable afterwards. The exit code alone would not
 *    prove it: a halt that killed the run would also exit 5.
 *  - `max_concurrent` bounds in-flight generations across six live workers.
 *
 * The rig launches supervisors directly (the `supervisor.test.ts` /
 * `dispatch-auto.test.ts` pattern) and writes `run.json` by hand rather than
 * going through `up`. Two reasons: `up` with a config resolves an LLM probe
 * and a docker network that neither this test nor CI has, and the run record
 * is precisely what is under test here — `readRunBudgetPolicy` reads the
 * budget off the RUN, so writing it directly is the shortest statement of
 * what the policy is.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BudgetStateSchema, EXIT, ScheduledTaskSchema } from "../../src/contracts.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { readTaskRecord, readWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { taskRecordPath } from "../../src/run/paths.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { DEFAULT_POLL_MS } from "../../src/orchestrate/scheduler.ts";
import { cliBudget } from "../support/budget.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT_URL, "src/cli/index.ts");
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");
const TASKLISTS = join(ROOT_URL, "test/fixtures/tasklists");

const ScheduleJson = z.array(ScheduledTaskSchema);

/** Tokens the fake agent stamps on each assistant message (A4 `usage`). */
const TOKENS_PER_MESSAGE = 400;

/**
 * Ceiling low enough that the FIRST task to settle crosses it.
 *
 * Deliberately below one message's worth rather than between one and two: the
 * order two workers settle in is a race, and a ceiling that needs both would
 * make which tasks end up `ready` depend on who finished first. At 300 the
 * halt lands on whichever settles first, and the assertions below hold for
 * either.
 */
const TOKENS_CEILING = 300;

const cleanups: Array<() => Promise<void>> = [];
/**
 * EIGHT supervisors to shut down (two rigs), each a control-socket round trip
 * plus a process-group kill — so this hook must not inherit bun's 5000 ms
 * default any more than a test may. Derived from the work it does rather than
 * picked: `cliBudget` charges the eight processes it reaps at the same
 * per-spawn rate a test pays for spawning them.
 *
 * NOT justified by a measurement. A 5162 ms timeout was observed here once
 * during mutation testing, but the machine's 1-minute load average was in the
 * hundreds at the time (another agent was running the load harness), so that
 * number is a fact about the box and not about this hook — re-measured at
 * ~250 ms idle. It is recorded because the reasoning matters more than the
 * budget: a red test taken during a load spike is not evidence, and hardening
 * on the strength of one would be fitting a constant to noise, which is the
 * defect ISC-266 exists to prevent.
 */
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
}, cliBudget(8));

// Control sockets hash (run_id, worker) into the SHARED os tmpdir, so a
// hardcoded run id would let two concurrent test processes reach each other's
// supervisors — same defence as supervisor.test.ts and dispatch-auto.test.ts.
const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

interface Rig {
  root: string;
  run: RunPaths;
  env: Record<string, string>;
}

/**
 * A run directory with `run.json` written by hand, plus `n` live supervisors.
 *
 * `tokensPerMessage` is opt-in on the fake (default 0 writes no `usage` key at
 * all), so no existing scenario's transcript changes shape because this file
 * needs one that reports spend.
 */
async function makeRig(opts: {
  workers: string[];
  maxConcurrent: number;
  tokensCeiling: number | null;
  tokensPerMessage?: number;
}): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-budget-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "runs");
  const runId = `budget-${RUN_TAG}-${opts.workers.length}`;
  const run = runPaths(runId, root);

  await writeJsonAtomic(run.runJson, {
    schema: "pifleet.run/v1",
    run_id: runId,
    created_at: new Date().toISOString(),
    backend: "headless",
    workers: opts.workers,
    max_concurrent: opts.maxConcurrent,
    budget: opts.tokensCeiling === null ? null : { tokens_ceiling: opts.tokensCeiling },
    worktrees: [],
  });

  const piCommand =
    `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, "happy.json")}` +
    (opts.tokensPerMessage === undefined
      ? ""
      : ` --tokens-per-message ${opts.tokensPerMessage}`);

  for (const workerId of opts.workers) {
    const { pid, pgid } = await processLauncher.launchDetached({
      runId,
      runDir: run.root,
      workerId,
      argv: supervisorArgv({ runsRoot: root, runId, workerId }),
      env: { PIFLEET_PI_COMMAND: piCommand },
      logPath: join(run.root, "workers", workerId, "supervisor.log"),
    });
    cleanups.push(async () => {
      await controlCall(run, workerId, { cmd: "shutdown" }).catch(() => {});
      if ((await processStartTime(pid)) !== null) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
  }

  for (const workerId of opts.workers) {
    const idle = await waitFor(
      async () =>
        (await readWorkerState(workerPaths(run, workerId)).catch(() => null))?.phase === "idle",
      30_000,
    );
    expect(idle).toBe(true);
  }

  return { root, run, env: { PIFLEET_RUNS_DIR: root, PIFLEET_PI_COMMAND: piCommand } };
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

/**
 * Poll `cond` until it holds or the budget elapses.
 *
 * The `Bun.sleep` is not politeness. A poll loop with no yield saturates the
 * libuv thread pool that the filesystem writes it is waiting FOR have to
 * contend for — the sampler starves its own subject, and the failure shows up
 * only under load, which is where these tests are judged. Same convention as
 * `control-auth.test.ts` and `steer.test.ts`.
 */
async function waitFor(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    let ok = false;
    try {
      ok = await cond();
    } catch {
      // A state file mid-rename reads as an error, not as a false condition.
      // Yield before retrying for the same reason the success path does.
      await Bun.sleep(25);
      continue;
    }
    if (ok) return true;
    if (performance.now() - start > budgetMs) return false;
    await Bun.sleep(25);
  }
}

describe("a ceiling crossed mid-run halts dispatch and exits 5, artifacts intact", () => {
  test(
    "in-flight tasks still settle, undispatched ones stay ready, and the harvest still works",
    async () => {
      const rig = await makeRig({
        workers: ["w1", "w2"],
        maxConcurrent: 2,
        tokensCeiling: TOKENS_CEILING,
        tokensPerMessage: TOKENS_PER_MESSAGE,
      });

      const auto = await cli(rig, [
        "dispatch",
        "--auto",
        "--tasks",
        join(TASKLISTS, "fan.json"),
        "--run",
        rig.run.runId,
        "--json",
      ]);

      // ISC-114 / ISC-193: the run's integer is 5. No VERDICT in this
      // schedule can produce it — every task that ran, succeeded — so this
      // number can only have come from folding the budget into the ladder.
      expect(auto.code).toBe(EXIT.BUDGET);
      expect(auto.stderr).toContain("budget ceiling crossed");
      expect(auto.stderr).toContain("tokens_ceiling");

      const schedule = ScheduleJson.parse(JSON.parse(auto.stdout.trim()));
      const byId = Object.fromEntries(schedule.map((t) => [t.id, t]));

      // Exactly the two the cap allowed out were dispatched, and BOTH reached
      // a real verdict: the halt stopped dispatch, it did not abandon work
      // already running. This is the clause that separates "halted" from
      // "destroyed the run".
      const ran = schedule.filter((t) => t.state === "done");
      expect(ran).toHaveLength(2);
      for (const t of ran) expect(t.verdict).toBe("success");

      // The other four are still READY — not failed, not blocked, not
      // silently dropped. A refused task has had nothing decided about it.
      const held = schedule.filter((t) => t.state === "ready");
      expect(held).toHaveLength(4);
      for (const t of held) {
        expect(t.worker).toBeNull();
        expect(t.verdict).toBeNull();
      }

      // Absence, not inference: the held tasks have no §7.1 envelope record.
      const inbox = (await readdir(rig.run.inboxDir)).sort();
      expect(inbox).toHaveLength(2);
      for (const t of held) expect(inbox).not.toContain(`${t.id}.json`);

      // ISC-115: the halt happened on the TOKEN axis while reported cost
      // stayed 0 for the whole run — the inversion local models force, since
      // a dollar-watching ceiling has no price table to trip on.
      const budget = BudgetStateSchema.parse(JSON.parse(await Bun.file(rig.run.budgetJson).text()));
      expect(budget.halted_at).not.toBeNull();
      expect(budget.halted_reason).toContain("tokens_ceiling");
      expect(budget.usd_spent).toBe(0);
      expect(budget.tokens_ceiling).toBe(TOKENS_CEILING);
      expect(budget.tokens_spent).toBeGreaterThan(TOKENS_CEILING);
      // Both settled tasks were accounted, not just the one that tripped it.
      expect(budget.tokens_spent).toBe(2 * TOKENS_PER_MESSAGE);
      // Every hold was released as its task settled; nothing leaked.
      expect(budget.reserved).toEqual({});

      // ISC-114's last clause, and the one a halt is most likely to break:
      // the artifacts are STILL HARVESTABLE afterwards. The transcript is
      // what carries the spend, so a halt that cost us the transcript would
      // destroy the evidence of what the tokens bought.
      const harvested = await cli(rig, [
        "harvest",
        "--reconstruct",
        "--worker",
        ran[0]!.worker as string,
        "--run",
        rig.run.runId,
        "--json",
      ]);
      expect(harvested.code).toBe(EXIT.SUCCESS);
      const reconstruction = JSON.parse(harvested.stdout.trim()) as {
        tokens_total: number;
        harvest_status: string;
      };
      expect(reconstruction.tokens_total).toBe(TOKENS_PER_MESSAGE);
      expect(reconstruction.harvest_status).not.toBe("unavailable");

      // And the whole-run harvest still emits valid JSON for every task that
      // ran (ISC-238's contract, exercised across a budget halt).
      const artifacts = await cli(rig, [
        "artifacts",
        "--all",
        "--run",
        rig.run.runId,
        "--json",
      ]);
      expect(artifacts.code).toBe(EXIT.SUCCESS);
      const emitted = JSON.parse(artifacts.stdout.trim()) as {
        run_id: string;
        tasks: Array<{ task_id: string; harvest_status: string }>;
      };
      expect(emitted.run_id).toBe(rig.run.runId);
      const emittedIds = emitted.tasks.map((a) => a.task_id);
      for (const t of ran) expect(emittedIds).toContain(t.id);

      // ISC-193's second producer: `wait` is file-driven and never saw the
      // scheduler, yet a dispatch-then-wait pipeline reports the same 5. The
      // two spellings of "what did this run cost" must not disagree.
      const waited = await cli(rig, ["wait", "--all", "--run", rig.run.runId, "--json"]);
      expect(waited.code).toBe(EXIT.BUDGET);
      const waitPayload = JSON.parse(waited.stdout.trim()) as {
        budget: { halted_at: string | null } | null;
      };
      expect(waitPayload.budget?.halted_at).not.toBeNull();
    },
    /**
     * FIVE subprocess spawns, counted from the body rather than estimated:
     * two supervisors (`launchDetached`) plus `dispatch --auto`, `harvest`,
     * `artifacts --all` and `wait` — six. `artifacts --all` and `wait` are
     * both whole-run graders, which is exactly the expensive class
     * `PER_SPAWN_IDLE_MS` is measured on, so no spawn here is being charged
     * the cheap rate by accident.
     */
    cliBudget(6),
  );
});

describe("ISC-109: six live workers, max_concurrent 2", () => {
  test(
    "no more than 2 tasks are in flight at any sampled moment",
    async () => {
      const workers = ["w1", "w2", "w3", "w4", "w5", "w6"];
      const rig = await makeRig({ workers, maxConcurrent: 2, tokensCeiling: null });

      const auto = await cli(rig, [
        "dispatch",
        "--auto",
        "--tasks",
        join(TASKLISTS, "fan.json"),
        "--run",
        rig.run.runId,
        "--json",
      ]);
      expect(auto.stderr).toBe("");
      expect(auto.code).toBe(EXIT.SUCCESS);
      const schedule = ScheduleJson.parse(JSON.parse(auto.stdout.trim()));
      expect(schedule).toHaveLength(6);
      for (const t of schedule) expect(t.state).toBe("done");

      /**
       * In-flight count sampled over time, RECONSTRUCTED from the run's own
       * durable records rather than by polling the run while it happens.
       *
       * Each task occupies `[dispatched_at, settled_at)` — the ledger row the
       * CLI wrote when the supervisor accepted the envelope, and the task
       * record the supervisor wrote when it finished. Overlapping intervals
       * are concurrent generations. Reconstruction beats live polling here
       * for the reason the sampler convention exists at all: a poll loop
       * racing the writes it measures contends for the same thread pool and
       * perturbs the thing under test, and these timestamps are already the
       * authoritative record of when each generation ran.
       */
      const { records, errors } = await mergeLedger(rig.run);
      expect(errors).toEqual([]);
      const dispatched = records.filter((r) => r.event === "dispatched");
      expect(dispatched).toHaveLength(6);

      const intervals: Array<{ start: number; end: number }> = [];
      for (const row of dispatched) {
        const t = schedule.find((s) => s.id === row.task_id);
        const record = await readTaskRecord(
          taskRecordPath(workerPaths(rig.run, t!.worker as string), row.task_id as string),
        );
        expect(record).not.toBeNull();
        intervals.push({
          start: Date.parse(row.ts),
          end: Date.parse(record!.settled_at),
        });
      }

      // Sweep every interval boundary and count how many were open there.
      let peak = 0;
      for (const boundary of intervals.map((i) => i.start)) {
        const open = intervals.filter((i) => i.start <= boundary && boundary < i.end).length;
        peak = Math.max(peak, open);
      }

      // THE criterion: at most 2 in-flight generations at any sampled moment,
      // with six workers idle and willing.
      expect(peak).toBeLessThanOrEqual(2);

      /**
       * Non-vacuity, stated as a property that cannot collapse under load.
       *
       * Asserting `peak === 2` would be the obvious guard and is a latent
       * flake: on a slow runner the first task can settle before the second
       * is dispatched, peak drops to 1, and a correct cap fails the test.
       * The span between the first and last dispatch cannot collapse that
       * way — with six tasks and a cap of 2, the 3rd and 5th dispatches each
       * have to wait for a settle observed on a poll tick, so the span is at
       * least two ticks. An UNCAPPED scheduler sends all six in ONE pass,
       * microseconds apart, which is two orders of magnitude below this
       * threshold. Load only widens the gap, never narrows it — the same
       * reasoning, and the same constant, `dispatch-auto.test.ts` uses for
       * dependency gating.
       */
      const span = Math.max(...intervals.map((i) => i.start)) - Math.min(...intervals.map((i) => i.start));
      expect(span).toBeGreaterThanOrEqual(DEFAULT_POLL_MS * 2);
    },
    /**
     * SEVEN spawns, counted: six supervisors (`launchDetached`) plus one
     * `dispatch --auto`. The supervisors are cheap relative to
     * `PER_SPAWN_IDLE_MS` and `dispatch --auto` here drives six real tasks
     * serialised two at a time, which is the slowest single command in this
     * file — charging all seven at the expensive rate is the conservative
     * direction the helper is built for.
     */
    cliBudget(7),
  );
});
