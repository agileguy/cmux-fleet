/**
 * `pifleet exec --worker <id> -- <cmd>` (SRD §10), through the real CLI.
 *
 * Two properties carry this command, and both are about not lying.
 *
 * The first is the exit ladder. The inner command's exit code is a DATUM, not
 * this process's exit code: an inner `exit 2` surfacing as the ladder's
 * "usage error" would tell every orchestrator switching on the integer that
 * the operator typed something wrong. Nonzero inner exit is EXIT.PARTIAL —
 * it ran, it did not succeed.
 *
 * The second is where the command actually ran. A worker with no container —
 * the fake-Pi phases, and the headless path the SRD makes normative for the
 * acceptance suite (§11) — runs on the HOST, and an operator who believes
 * they are inside the container's mount table and egress policy while
 * standing on the host is one `rm` away from a very bad afternoon. So the
 * host case must SAY so, in both output modes.
 *
 * A live supervisor is launched rather than faked, because `exec` refuses a
 * dead worker before running anything and that ordering is part of what is
 * under test.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");
const CLI = join(ROOT_URL, "src/cli/index.ts");

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const testRunId = (name: string): string => `exec-${name}-${RUN_TAG}`;

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-exec-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function cli(
  root: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, PIFLEET_RUNS_DIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

/** A real supervisor on the happy scenario, so the worker is genuinely live. */
async function liveWorker(root: string, runId: string): Promise<void> {
  const res = await processLauncher.launchDetached({
    runId,
    runDir: join(root, runId),
    workerId: "eng-1",
    argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
    env: {
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, "happy.json")}`,
    },
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
  // The state file is what `exec`'s liveness preflight reads.
  const start = performance.now();
  const wp = workerPaths(runPaths(runId, root), "eng-1");
  for (;;) {
    if (await Bun.file(wp.stateJson).exists()) return;
    if (performance.now() - start > 15_000) throw new Error("supervisor never wrote state");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("exec — the inner exit code is a datum, not the ladder", () => {
  test("a successful inner command exits 0 and its stdout reaches the caller", async () => {
    const root = await freshRoot();
    const runId = testRunId("ok");
    await liveWorker(root, runId);

    const r = await cli(root, ["exec", "--worker", "eng-1", "--run", runId, "--", "echo", "hello-from-exec"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toContain("hello-from-exec");
  }, 30_000);

  /**
   * The distinction that matters. `exit 2` from the inner command must NOT
   * become the ladder's USAGE — an orchestrator reading 2 would report that
   * the operator mistyped the command rather than that the command failed.
   */
  test("an inner exit 2 is PARTIAL, never the ladder's USAGE", async () => {
    const root = await freshRoot();
    const runId = testRunId("two");
    await liveWorker(root, runId);

    const r = await cli(root, ["exec", "--worker", "eng-1", "--run", runId, "--", "sh", "-c", "exit 2"]);
    expect(r.code).toBe(EXIT.PARTIAL);
    expect(r.code).not.toBe(EXIT.USAGE);
  }, 30_000);

  test("--json reports the inner exit code without it becoming the process's", async () => {
    const root = await freshRoot();
    const runId = testRunId("json");
    await liveWorker(root, runId);

    const r = await cli(root, [
      "exec", "--worker", "eng-1", "--run", runId, "--json", "--", "sh", "-c", "exit 7",
    ]);
    expect(r.code).toBe(EXIT.PARTIAL);
    const parsed = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    // 7 is the datum; PARTIAL is the verdict. Both, and not one wearing the
    // other's clothes.
    expect(parsed["exit_code"]).toBe(7);
    expect(parsed["worker"]).toBe("eng-1");
    expect(parsed["timed_out"]).toBe(false);
  }, 30_000);
});

describe("exec — where the command ran is never implied", () => {
  /**
   * A worker with no container runs on the host. That is legitimate and it is
   * also the most dangerous thing this command does, so it must be stated
   * rather than left to be inferred from the absence of a container name.
   */
  test("a containerless worker says it ran on the host, in both output modes", async () => {
    const root = await freshRoot();
    const runId = testRunId("host");
    await liveWorker(root, runId);

    const human = await cli(root, ["exec", "--worker", "eng-1", "--run", runId, "--", "true"]);
    expect(human.code).toBe(EXIT.SUCCESS);
    expect(`${human.stdout}${human.stderr}`.toLowerCase()).toContain("host");

    const json = await cli(root, ["exec", "--worker", "eng-1", "--run", runId, "--json", "--", "true"]);
    const parsed = JSON.parse(json.stdout.trim()) as Record<string, unknown>;
    expect(parsed["ran_in"]).toBe("host");
    // Null, not an invented name: "which container" has no answer here.
    expect(parsed["container"]).toBeNull();
  }, 30_000);
});

describe("exec — worker discipline (requirement 4)", () => {
  test("no command after -- is USAGE, and nothing is run", async () => {
    const root = await freshRoot();
    const runId = testRunId("nocmd");
    await mkdir(join(root, runId), { recursive: true });

    const r = await cli(root, ["exec", "--worker", "eng-1", "--run", runId]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  test("an unknown worker is USAGE, naming the worker and the run", async () => {
    const root = await freshRoot();
    const runId = testRunId("ghost");
    await mkdir(join(root, runId), { recursive: true });

    const r = await cli(root, ["exec", "--worker", "ghost", "--run", runId, "--", "echo", "hi"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("ghost");
    expect(r.stderr).toContain(runId);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  /**
   * Liveness is checked BEFORE anything runs. A dead worker's container is
   * exactly what `docker exec` would produce a confusing error against, and
   * "6, worker died" is the answer an orchestrator can act on.
   */
  test("a dead worker is WORKER_DIED and the command never runs", async () => {
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

    const marker = join(root, "should-not-exist.txt");
    const r = await cli(root, [
      "exec", "--worker", "eng-1", "--run", runId, "--", "sh", "-c", `touch ${marker}`,
    ]);
    expect(r.code).toBe(EXIT.WORKER_DIED);
    // The refusal is only meaningful if it precedes the side effect.
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
