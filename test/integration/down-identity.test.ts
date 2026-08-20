/**
 * `down` signals a RECORDED identity, never a bare pid (ISC-191).
 *
 * These two probes are what ISC-191 rests on for the `down` path. ISC-270 is
 * the part they deliberately do NOT cover — a worker with no registry entry,
 * which has no launch-time identity to compare against — and it stays open.
 *
 * `safety/kill.ts` says in its header that the `(pid, started)` pair is
 * "re-read from the OS and compared at EVERY rung", and named `down`'s
 * quiesce as one of its callers. `down` never imported it. It ran an inline
 * ladder over a bare `process.kill`, gated only on
 * `processStartTime(pid) !== null` — liveness, not identity — so a run
 * directory whose supervisor died before `down` ever ran would happily
 * SIGTERM and then SIGKILL whatever inherited the number.
 *
 * That is not a hypothetical. `down-prune.test.ts`'s own fixture carries the
 * scar: its first revision recorded `process.pid`, and `down` sent SIGTERM to
 * the test runner's process group and killed ITSELF five seconds in. The
 * fixture was changed to pick a pid that is not a group leader so the signal
 * would raise ESRCH — the hazard was routed around, not removed.
 *
 * Both tests here assert a NEGATIVE: a process that is alive before `down`
 * is still alive after it. Only a recorded survival can prove a signal was
 * not delivered, which is the same reason `test/unit/kill.test.ts` leans on
 * its empty `signals` array.
 *
 * Every stand-in is a real `sleep` child of this test process, reaped in
 * `afterAll`, so nothing here leaks a process or depends on a pid this suite
 * does not own.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { cliBudget } from "../support/budget.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

/**
 * A start-time string the OS cannot possibly produce for a live process.
 * `processStartTime` returns `ps -o lstart=` verbatim, so any sentinel that
 * is not a real `lstart` rendering is a guaranteed mismatch.
 */
const FOREIGN_START = "not-a-real-lstart-value";

const bases: string[] = [];
const children: Array<{ pid: number; kill: (sig?: number | NodeJS.Signals) => void }> = [];

afterAll(async () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      // Already exited — the desired state.
    }
  }
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

/**
 * A live process that `down` must not touch.
 *
 * `sleep` is spawned WITHOUT being made a group leader, exactly as
 * `down-prune.test.ts` does, so that even a regression cannot escalate
 * beyond this one pid: a stray `kill(-pid, …)` raises ESRCH instead of
 * reaching this test runner's group. The daemon rung signals a BARE pid,
 * which is what makes the negative assertion below load-bearing rather than
 * accidentally satisfied.
 */
function bystander(): { pid: number } {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return { pid: child.pid };
}

async function rig(): Promise<{ root: string; runId: string; run: ReturnType<typeof runPaths> }> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-downid-"));
  bases.push(base);
  const root = join(base, "runs");
  const runId = "2026-08-19T00-00-00Z-idnt";
  const run = runPaths(runId, root);
  await mkdir(run.workersDir, { recursive: true });
  return { root, runId, run };
}

async function down(root: string, runId: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, "down", "--run", runId, "--json"], {
    env: { PATH: process.env["PATH"] ?? "", PIFLEET_RUNS_DIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

const parse = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;

describe("down signals only a process whose recorded identity still matches", () => {
  /**
   * THE regression test for the unguarded daemon rung.
   *
   * `daemon.pid` records `{pid, started}` — both fields, written together by
   * `startRegistryDaemon`. `down` parsed the file, took the pid, threw the
   * identity away and signalled the number. Here the recorded identity does
   * not match the process currently holding that pid, which is precisely the
   * post-reboot stale-run-directory case an operator reaches by running a
   * bare `pifleet down`.
   *
   * Fails if: the daemon rung stops comparing `started` before signalling —
   * the bystander is SIGTERMed and is gone when the assertion reads it back.
   */
  test("a daemon pid whose recorded start time no longer matches is never signalled", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    expect(await processStartTime(victim.pid)).not.toBeNull(); // the fixture is real

    await writeFile(run.daemonPid, JSON.stringify({ pid: victim.pid, started: FOREIGN_START }), "utf8");

    const r = await down(root, runId);
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)).toMatchObject({ clean: true });

    // The whole point: it is still there.
    expect(await processStartTime(victim.pid)).not.toBeNull();
  }, cliBudget(1));

  /**
   * The same discipline on the worker rung, read off the registry — the one
   * place a supervisor's `(pid, started)` is actually recorded at launch
   * (`register_worker`, whose own comment says "identity is (pid, start-time)
   * so pid reuse cannot resurrect us later").
   *
   * The assertion is on the REPORT rather than only on the bystander's
   * survival, because this rung addresses `-pgid` and the bystander is not a
   * group leader: an unguarded signal would raise ESRCH and the process would
   * survive for the wrong reason. What changes observably is the verdict —
   * a guarded `down` recognises the recorded supervisor as gone and says so.
   *
   * Fails if: the worker rung stops consulting the registry-recorded
   * identity — `how` becomes "sigkill", `stopped` false, and the command
   * exits WORKER_DIED after climbing a ladder against a stranger.
   */
  test("a worker whose registry-recorded start time no longer matches reads as already gone", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.dir, { recursive: true });
    await writeWorkerState(
      wp,
      initialWorkerState({
        worker: "eng-1",
        runId,
        pid: victim.pid,
        pgid: victim.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    await writeFile(
      run.registryJson,
      JSON.stringify({
        schema: "pifleet.registry/v1",
        run_id: runId,
        daemon: { pid: 0, started: FOREIGN_START },
        workers: {
          "eng-1": {
            worker: "eng-1",
            pid: victim.pid,
            pgid: victim.pid,
            started: FOREIGN_START,
            registered_at: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );

    const r = await down(root, runId);
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)).toMatchObject({
      clean: true,
      workers: [{ id: "eng-1", stopped: true, how: "already_gone" }],
    });
    expect(await processStartTime(victim.pid)).not.toBeNull();
  }, cliBudget(1));
});
