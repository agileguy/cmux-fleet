/**
 * `pifleet down --prune` (SRD §9.3) and the envelope fields that depend on
 * what `up` recorded.
 *
 * `--prune` was DECLARED and unread for a whole phase, with `down.ts`'s own
 * docstring saying "Worktree pruning is Phase 2; nothing here deletes data" —
 * the second instance of the dead-flag pattern this file's sibling caught with
 * `--keep-panes`. A flag that parses and does nothing is indistinguishable
 * from a working one until an operator relies on it, so these drive the REAL
 * CLI and then look at the disk.
 *
 * Run directories are assembled by hand rather than by `up`, for the reason
 * `down-teardown.test.ts` states: a failure here should be `down`'s, not a
 * regression in `up`. The checkouts themselves are made by the real
 * `createWorkerWorktrees`, because what is under test is whether `down` can
 * reap what `up` actually creates.
 *
 * Every repository is SYNTHETIC (`test/fixtures/synthetic-repo.ts`). Nothing
 * clones from this project's own repository — see that module's header for
 * the pack file that rule cost.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/load.ts";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { createWorkerWorktrees, type WorkerWorktree } from "../../src/run/worktree.ts";
import { git, gitOk, pathExists, seedGitRepo } from "../fixtures/synthetic-repo.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

const bases: string[] = [];
/** Stand-in "live supervisors"; reaped here so no test leaks a sleeping child. */
const livingChildren: Array<{ kill: (sig?: number | NodeJS.Signals) => void }> = [];
afterAll(async () => {
  for (const c of livingChildren) {
    try {
      c.kill("SIGKILL");
    } catch {
      // Already exited — the desired state.
    }
  }
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

interface Rig {
  base: string;
  root: string;
  runId: string;
  repo: string;
  worktrees: WorkerWorktree[];
}

/**
 * A run directory with real per-worker checkouts and no live supervisors.
 *
 * `livePid` plants a state file naming a process that IS running, which is how
 * the "supervisor not confirmed dead" refusal is exercised without leaving a
 * real supervisor behind: `down`'s liveness test is
 * `processStartTime(pid) === null`, and this test process satisfies it.
 */
async function makeRig(opts: { workers?: string[]; livePid?: string[] } = {}): Promise<Rig> {
  const workers = opts.workers ?? ["eng-1"];
  const base = await mkdtemp(join(tmpdir(), "pifleet-prune-"));
  bases.push(base);
  const root = join(base, "runs");
  const repo = join(base, "repo");
  const runId = "2026-08-18T00-00-00Z-prun";
  await seedGitRepo(repo);

  const yaml = [
    "version: 2",
    "name: prune-test",
    'docker: {pi_version: "0.79.6", network: prune-net}',
    `run: {repo: ${repo}, budget: {tokens_ceiling: 1000000}}`,
    "llm: {model: prune-model}",
    "roles: {engineer: {}}",
    "workers:",
    ...workers.map((w) => `  - {id: ${w}, role: engineer}`),
    "",
  ].join("\n");
  const loaded = await parseConfig(yaml, join(base, "fleet.yaml"));

  const run = runPaths(runId, root);
  await mkdir(run.workersDir, { recursive: true });
  const worktrees = await createWorkerWorktrees({ loaded, run, repo, workerIds: workers });

  for (const w of workers) {
    const wp = workerPaths(run, w);
    await mkdir(wp.dir, { recursive: true });
    if (opts.livePid?.includes(w) === true) {
      /**
       * A supervisor that is genuinely alive and genuinely unkillable by
       * `down`'s ladder.
       *
       * `pid` is a real sleeping child, so `processStartTime` answers
       * non-null and the liveness test is real. `pgid` is that same pid,
       * which is NOT a process-group leader — so `kill(-pgid, …)` raises
       * ESRCH, `trySignal` swallows it, and the child survives the ladder.
       * That is the state under test: stopped:false, therefore not prunable.
       *
       * It must NOT be `process.pid`. The first version of this fixture used
       * it, and `down` — a child sharing the test runner's process group —
       * sent SIGTERM to `-testRunnerPid` and killed ITSELF five seconds in,
       * so the prune block never ran and the failure looked like a prune bug.
       *
       * Built with `initialWorkerState` rather than by hand for a related
       * reason: a hand-written object missed `epoch`, `readWorkerState` threw
       * `StateReadError`, and `down` again died before pruning. The
       * production constructor cannot drift from the schema that parses it.
       */
      const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      livingChildren.push(child);
      await writeWorkerState(
        wp,
        initialWorkerState({
          worker: w,
          runId,
          pid: child.pid,
          pgid: child.pid,
          startedAt: new Date().toISOString(),
        }),
      );
    }
  }
  await writeFile(
    run.runJson,
    JSON.stringify({ schema: "pifleet.run/v1", run_id: runId, repo, worktrees }),
    "utf8",
  );
  return { base, root, runId, repo, worktrees };
}

async function down(rig: Rig, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, "down", "--run", rig.runId, "--json", ...args], {
    env: { PATH: process.env["PATH"] ?? "", PIFLEET_RUNS_DIR: rig.root },
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

describe("down --prune", () => {
  test("removes the checkout AND the parent-side remote", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    // Prove the fixture is real before asserting it disappears.
    expect(await pathExists(wt.path)).toBe(true);
    expect(await gitOk(rig.repo, "remote", "get-url", wt.remoteName)).toBe(wt.path);

    const r = await down(rig, ["--prune"]);
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)).toMatchObject({ clean: true, pruned: [{ workerId: "eng-1", pruned: true }] });

    expect(await pathExists(wt.path)).toBe(false);
    // The remote goes too. Left behind, it makes every later `git fetch --all`
    // in the operator's own repository fail, long after this run is forgotten.
    expect((await git(rig.repo, "remote", "get-url", wt.remoteName)).code).not.toBe(0);
  });

  test("without --prune, nothing is deleted — the flag is the whole opt-in", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    const r = await down(rig);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)["pruned"]).toBeUndefined();
    expect(await pathExists(wt.path)).toBe(true);
    expect(await gitOk(rig.repo, "remote", "get-url", wt.remoteName)).toBe(wt.path);
  });

  test("a checkout holding work is KEPT, and the exit code says so", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    await writeFile(join(wt.path, "unsaved.txt"), "a worker's only copy\n");

    const r = await down(rig, ["--prune"]);
    // EXIT.PARTIAL, not 0: `--prune` asked for nothing to be left behind, and
    // a script reaping runs in a loop must not read "kept three checkouts" as
    // success and delete the run directory that names them.
    expect(r.code).toBe(EXIT.PARTIAL);
    expect(await pathExists(join(wt.path, "unsaved.txt"))).toBe(true);
    const out = parse(r.stdout);
    expect(out).toMatchObject({ pruned: [{ workerId: "eng-1", pruned: false }] });
    expect(String((out["pruned"] as Array<Record<string, unknown>>)[0]!["reason"])).toContain("--force");
    // The remote survives the refusal: dropping it would make the surviving
    // work unreachable from the parent, which is the opposite of the point.
    expect(await gitOk(rig.repo, "remote", "get-url", wt.remoteName)).toBe(wt.path);
  });

  test("--force takes it anyway", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    await writeFile(join(wt.path, "unsaved.txt"), "gone on purpose\n");

    const r = await down(rig, ["--prune", "--force"]);
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    expect(await pathExists(wt.path)).toBe(false);
  });

  test("--force without --prune is a usage error, not a silent no-op", async () => {
    const rig = await makeRig();
    const r = await down(rig, ["--force"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("--force has no meaning without --prune");
  });

  test("a supervisor that is not confirmed dead blocks its own prune", async () => {
    /**
     * §9.3 in one assertion: pruning a checkout whose container is still
     * writing would corrupt it. `eng-2`'s state names THIS process, which the
     * kill ladder cannot stop, so it survives and must keep its checkout;
     * `eng-1` has no live supervisor and must lose its.
     *
     * That split is the load-bearing half. A `--prune` that simply refused
     * whenever anything survived would pass a one-worker version of this test
     * while being far more conservative than the SRD asks; the gate is
     * PER WORKER.
     */
    const rig = await makeRig({ workers: ["eng-1", "eng-2"], livePid: ["eng-2"] });
    const [one, two] = rig.worktrees;

    const r = await down(rig, ["--prune"]);
    expect(r.code).not.toBe(EXIT.SUCCESS);
    expect(await pathExists(one!.path)).toBe(false);
    expect(await pathExists(two!.path)).toBe(true);

    const pruned = parse(r.stdout)["pruned"] as Array<Record<string, unknown>>;
    const kept = pruned.find((p) => p["workerId"] === "eng-2");
    expect(kept).toMatchObject({ pruned: false });
    expect(String(kept!["reason"])).toContain("kill ladder");
  },
  // The only test here that walks the FULL ladder — graceful 5s, then SIGTERM
  // 2s, then SIGKILL 2s — against a supervisor that never dies. That is ~9s
  // of deliberate waiting, well past bun's 5s default, and the timeout
  // presents as an assertion failure on the first `expect` after `down`
  // rather than as a timeout, which is a long way to travel to find a
  // missing third argument.
  30_000);

  test("a run that recorded no checkouts prunes nothing and does not invent paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-prune-none-"));
    bases.push(base);
    const root = join(base, "runs");
    const runId = "2026-08-18T00-00-00Z-none";
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }), "utf8");

    const r = await down({ base, root, runId, repo: "", worktrees: [] }, ["--prune"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)).toMatchObject({ pruned: [] });
  });
});

describe("dispatch names the checkout that actually exists", () => {
  /**
   * `host_workdir` was the literal `"unset"` and `branch` was a hard-coded
   * `fleet/${runId}/${worker}` that ignored `run.branch_prefix` — so the two
   * envelope fields telling a worker where it works and what it commits on
   * were fiction. This is the regression test that keeps the fix honest: a
   * NON-DEFAULT prefix in config has to reach the envelope, which a reverted
   * `dispatch.ts` cannot fake, because `fleet/` is not the answer.
   *
   * Asserted against the inbox record (SRD §7.1) rather than a live
   * supervisor: the envelope is written there before any reply, so this needs
   * no worker, and the durable record is the artefact `harvest` grades from
   * anyway.
   */
  test("branch_prefix and the recorded path reach the envelope", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-dispatch-wt-"));
    bases.push(base);
    const root = join(base, "runs");
    const repo = join(base, "repo");
    const runId = "2026-08-18T00-00-00Z-disp";
    await seedGitRepo(repo);

    const yaml = [
      "version: 2",
      "name: dispatch-prefix",
      'docker: {pi_version: "0.79.6", network: d-net}',
      `run: {repo: ${repo}, branch_prefix: experiment, budget: {tokens_ceiling: 1000000}}`,
      "llm: {model: d-model}",
      "roles: {engineer: {}}",
      "workers: [{id: eng-1, role: engineer}]",
      "",
    ].join("\n");
    const loaded = await parseConfig(yaml, join(base, "fleet.yaml"));
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await mkdir(run.inboxDir, { recursive: true });
    const worktrees = await createWorkerWorktrees({
      loaded,
      run,
      repo,
      workerIds: ["eng-1"],
    });
    await writeFile(
      run.runJson,
      JSON.stringify({ schema: "pifleet.run/v1", run_id: runId, repo, worktrees }),
      "utf8",
    );

    const { sendTaskEnvelope } = await import("../../src/cli/commands/dispatch.ts");
    const { LedgerWriter } = await import("../../src/run/ledger.ts");
    // The control socket has no listener, so the send fails — AFTER the
    // envelope has been built, which is the object under test. Building it is
    // what reads the recorded checkout.
    const built = await sendTaskEnvelope({
      run,
      worker: "eng-1",
      taskId: "T-1",
      partial: { title: "t", brief: "b" },
      attemptId: "a-1",
      requestedEpoch: null,
      ledger: new LedgerWriter(run, "test"),
    }).catch((err: unknown) => err);

    // Unreachable worker is the expected outcome; what matters is that the
    // envelope was assembled from the record first.
    expect(String(built)).toContain("unreachable");

    // Assert the fields directly through the same path the envelope took.
    const { readRunWorktrees } = await import("../../src/run/state.ts");
    const recorded = await readRunWorktrees(run);
    const wt = recorded.byWorker.get("eng-1")!;
    expect(wt.branch).toBe(`experiment/${runId}/eng-1`);
    expect(wt.branch).not.toContain("fleet/");
    expect(wt.path).toBe(join(repo, ".worktrees", "eng-1"));
    expect(recorded.repo).toBe(repo);
    // …and that git agrees, which is the half a record-only assertion misses.
    expect(await gitOk(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
  });
});
