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
import { processStartTime } from "../../src/run/registry.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { createWorkerWorktrees, type WorkerWorktree } from "../../src/run/worktree.ts";
import { git, gitOk, pathExists, seedGitRepo } from "../fixtures/synthetic-repo.ts";
import { cliBudget } from "../support/budget.ts";

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
 * `livePid` plants a state file AND a matching registry entry naming a process
 * that IS running, which is how the "supervisor not confirmed dead" refusal is
 * exercised without leaving a real supervisor behind. Both files, because
 * `down`'s gate is IDENTITY and not liveness: a state file alone leaves it
 * with nothing recorded to compare against, and it refuses at the anchor
 * instead of climbing the ladder these tests are about.
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

  /**
   * Registry entries for the live-supervisor workers, exactly as
   * `register_worker` persists them.
   *
   * This fixture used to plant a `state.json` and no registry at all, so
   * `down` had no launch-time identity to compare and — once the anchor
   * became fail-closed — REFUSED the worker instead of laddering it. The
   * refusal keeps the checkout too, so the §9.3 assertion below still held,
   * but by a different mechanism than the test's name claims. A real `up`
   * always registers its supervisor, so the fixture was modelling a state
   * production does not produce.
   *
   * `started` is captured here with the same `processStartTime` the CLI uses.
   * That it compares EQUAL inside the `down` subprocess is itself load-bearing:
   * it only does so because the rendering is pinned to `TZ=UTC LC_ALL=C` at
   * the source. A test-runner and a CLI subprocess in different locales would
   * otherwise disagree about a process they can both see.
   */
  const registryWorkers: Record<string, unknown> = {};

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
      const started = await processStartTime(child.pid);
      if (started === null) throw new Error(`fixture pid ${child.pid} was not alive when recorded`);
      registryWorkers[w] = {
        worker: w,
        pid: child.pid,
        pgid: child.pid,
        started,
        registered_at: new Date().toISOString(),
      };
    }
  }
  if (Object.keys(registryWorkers).length > 0) {
    await writeFile(
      run.registryJson,
      JSON.stringify({
        schema: "pifleet.registry/v1",
        run_id: runId,
        daemon: { pid: 0, started: "" },
        workers: registryWorkers,
      }),
      "utf8",
    );
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
  }, cliBudget(4));

  test("without --prune, nothing is deleted — the flag is the whole opt-in", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    const r = await down(rig);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)["pruned"]).toBeUndefined();
    expect(await pathExists(wt.path)).toBe(true);
    expect(await gitOk(rig.repo, "remote", "get-url", wt.remoteName)).toBe(wt.path);
  }, cliBudget(3));

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
  }, cliBudget(3));

  test("--force takes it anyway", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    await writeFile(join(wt.path, "unsaved.txt"), "gone on purpose\n");

    const r = await down(rig, ["--prune", "--force"]);
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    expect(await pathExists(wt.path)).toBe(false);
  }, cliBudget(2));

  test("--force without --prune is a usage error, not a silent no-op", async () => {
    const rig = await makeRig();
    const r = await down(rig, ["--force"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("--force has no meaning without --prune");
  }, cliBudget(2));

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
  // ISC-273 audit: the 30_000 stands, and this is the one test in the file
  // whose cost is NOT process startup. It walks the FULL ladder — graceful 5s,
  // then SIGTERM 2s, then SIGKILL 2s — against a supervisor that never dies,
  // so ~9 s of the wall clock is deliberate waiting rather than spawning. It
  // performs two spawn-reaching calls (`makeRig`, `down`), and `cliBudget(2)` =
  // 22_800 ms would nominally cover them, but the derivation that governs here
  // is the ladder: measured at 9908 ms idle on a 14-core box at load 3.55,
  // which leaves cliBudget(2) only 2.3x headroom against a fixed cost that the
  // contention factor does not shrink. 9s x CONTENTION (3) = 27_000, rounded
  // to 30_000. The other twelve tests in this file ARE spawn-bounded and carry
  // cliBudget(n) accordingly.
  //
  // The failure mode this protects against is worth naming: a ladder timeout
  // presents as an assertion failure on the first `expect` after `down` rather
  // than as a timeout, which is a long way to travel to find a missing third
  // argument.
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
  }, cliBudget(1));

  /**
   * THE regression test for the never-launched gate fix. `up` creates the
   * clone and records it BEFORE launching any supervisor (`createWorker
   * Worktrees` runs ahead of `launchDetached` in `up.ts`), so a crash in
   * that window — or, here, a run dir assembled without ever reaching
   * launch — leaves a real, recorded checkout with NO `workers/<id>`
   * directory at all. §9.3's corruption hazard is about a container still
   * WRITING; nothing was ever writing here, and treating "never launched"
   * the same as "launched and survived the kill ladder" made `down
   * --prune`'s own suggested recovery (this exact command) unable to reap
   * exactly the mess it exists to clean up.
   */
  test("a checkout with NO supervisor state at all (crashed mid-`up`) is prunable, not refused", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-prune-neverlaunched-"));
    bases.push(base);
    const root = join(base, "runs");
    const repo = join(base, "repo");
    const runId = "2026-08-18T00-00-00Z-nvlc";
    await seedGitRepo(repo);
    const yaml = [
      "version: 2",
      "name: prune-test",
      'docker: {pi_version: "0.79.6", network: prune-net}',
      `run: {repo: ${repo}, budget: {tokens_ceiling: 1000000}}`,
      "llm: {model: prune-model}",
      "roles: {engineer: {}}",
      "workers:",
      "  - {id: eng-1, role: engineer}",
      "",
    ].join("\n");
    const loaded = await parseConfig(yaml, join(base, "fleet.yaml"));
    const run = runPaths(runId, root);
    // `workersDir` itself exists (`up` creates it early), but NOTHING under
    // it for eng-1 — deliberately, unlike `makeRig` above, which always
    // creates `workers/<id>` regardless of `livePid`.
    await mkdir(run.workersDir, { recursive: true });
    const worktrees = await createWorkerWorktrees({ loaded, run, repo, workerIds: ["eng-1"] });
    await writeFile(
      run.runJson,
      JSON.stringify({ schema: "pifleet.run/v1", run_id: runId, repo, worktrees }),
      "utf8",
    );

    const r = await down({ base, root, runId, repo, worktrees }, ["--prune"]);
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)).toMatchObject({ pruned: [{ workerId: "eng-1", pruned: true }] });
    expect(await pathExists(worktrees[0]!.path)).toBe(false);
  }, cliBudget(3));

  test("a never-launched checkout that holds work still needs --force, exactly like any other", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-prune-neverlaunched-dirty-"));
    bases.push(base);
    const root = join(base, "runs");
    const repo = join(base, "repo");
    const runId = "2026-08-18T00-00-00Z-nvld";
    await seedGitRepo(repo);
    const yaml = [
      "version: 2",
      "name: prune-test",
      'docker: {pi_version: "0.79.6", network: prune-net}',
      `run: {repo: ${repo}, budget: {tokens_ceiling: 1000000}}`,
      "llm: {model: prune-model}",
      "roles: {engineer: {}}",
      "workers:",
      "  - {id: eng-1, role: engineer}",
      "",
    ].join("\n");
    const loaded = await parseConfig(yaml, join(base, "fleet.yaml"));
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    const worktrees = await createWorkerWorktrees({ loaded, run, repo, workerIds: ["eng-1"] });
    await writeFile(join(worktrees[0]!.path, "unsaved.txt"), "a worker's only copy\n");
    await writeFile(
      run.runJson,
      JSON.stringify({ schema: "pifleet.run/v1", run_id: runId, repo, worktrees }),
      "utf8",
    );

    const refused = await down({ base, root, runId, repo, worktrees }, ["--prune"]);
    expect(refused.code).toBe(EXIT.PARTIAL);
    expect(await pathExists(join(worktrees[0]!.path, "unsaved.txt"))).toBe(true);

    const forced = await down({ base, root, runId, repo, worktrees }, ["--prune", "--force"]);
    expect(forced.code, `stderr: ${forced.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    expect(await pathExists(worktrees[0]!.path)).toBe(false);
  }, cliBudget(4));

  /**
   * THE regression test for the silent-success-on-unreadable-record fix. A
   * `run.json` whose `worktrees` field is present but the wrong SHAPE (not
   * an array) used to make `down --prune` iterate an empty map and exit 0
   * with `pruned: []` — indistinguishable from "this run truly left nothing
   * behind" to a script reaping runs in a loop, while real clones and
   * remotes may still be sitting on disk with nothing left naming them.
   */
  test("an unreadable worktrees record refuses --prune instead of silently reporting success", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-prune-badrecord-"));
    bases.push(base);
    const root = join(base, "runs");
    const repo = join(base, "repo");
    const runId = "2026-08-18T00-00-00Z-bad1";
    await seedGitRepo(repo);
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await writeFile(
      run.runJson,
      JSON.stringify({ schema: "pifleet.run/v1", run_id: runId, repo, worktrees: "not-an-array" }),
      "utf8",
    );

    // `down()` always passes `--json`, which is precisely why this bug was
    // easy to miss: the human-readable "cannot prune: ..." line only prints
    // when `--json` is ABSENT, so a script driving `down --prune --json` in
    // a loop had no stderr trail either — only the exit code told the truth,
    // which is why THAT is what this test pins.
    const r = await down({ base, root, runId, repo, worktrees: [] }, ["--prune"]);
    expect(r.code).toBe(EXIT.PARTIAL);
    expect(parse(r.stdout)).toMatchObject({ pruned: [] });
  }, cliBudget(2));

  test("one worker's malformed record does not blind pruning for the others", async () => {
    const rig = await makeRig({ workers: ["eng-1", "eng-2"] });
    const raw = JSON.parse(await Bun.file(runPaths(rig.runId, rig.root).runJson).text()) as {
      worktrees: Array<Record<string, unknown>>;
    };
    // Corrupt eng-2's entry only — drop its required `baseSha`.
    for (const w of raw.worktrees) if (w["workerId"] === "eng-2") delete w["baseSha"];
    await writeFile(runPaths(rig.runId, rig.root).runJson, JSON.stringify(raw), "utf8");

    const r = await down(rig, ["--prune"]);
    // eng-1's perfectly good record still gets reaped normally...
    expect(r.code).toBe(EXIT.PARTIAL); // ...but eng-2's is a refusal, not silence.
    const pruned = parse(r.stdout)["pruned"] as Array<Record<string, unknown>>;
    expect(pruned.find((p) => p["workerId"] === "eng-1")).toMatchObject({ pruned: true });
    const eng2 = pruned.find((p) => p["workerId"] === "eng-2");
    expect(eng2).toMatchObject({ pruned: false });
    expect(String(eng2!["reason"])).toContain("could not be read");
  }, cliBudget(2));
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
  }, cliBudget(3));

  /**
   * THE regression test for the OTHER half of the `branch_prefix` fix.
   * `wt?.branch ?? workerBranch(DEFAULT_BRANCH_PREFIX, ...)` — the fallback
   * for a worker with no checkout of its own to read a branch off
   * (`shared-ro`, `none`) — used to re-derive the SCHEMA's global default
   * rather than reading what this run was actually launched with, so an
   * operator who set `branch_prefix: experiment` still got `fleet/<run>/
   * <worker>` for every such worker. `up` now persists `branch_prefix` into
   * `run.json` itself; this asserts `dispatch` reads THAT, not the default.
   */
  test("a worker with no checkout of its own still gets the run's real branch_prefix", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-dispatch-noprefix-"));
    bases.push(base);
    const root = join(base, "runs");
    const repo = join(base, "repo");
    const runId = "2026-08-18T00-00-00Z-shrd";
    await seedGitRepo(repo);

    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await mkdir(run.inboxDir, { recursive: true });
    // The shape `up` writes for an ALL-`shared-ro` fleet: `branch_prefix`
    // recorded, `worktrees: []` (no checkout for anyone), never `null`.
    await writeFile(
      run.runJson,
      JSON.stringify({
        schema: "pifleet.run/v1",
        run_id: runId,
        repo,
        branch_prefix: "experiment",
        worktrees: [],
      }),
      "utf8",
    );

    // A minimal stand-in supervisor: accepts one line of JSON, replies with
    // one line of JSON. `sendTaskEnvelope` only writes the durable inbox
    // record on `accepted: true`, so proving the FALLBACK branch actually
    // reaches the envelope needs a dispatch that succeeds — not merely one
    // that fails after building the envelope, which is the shape every
    // other test in this file uses precisely because it does NOT need this.
    const { ensureControlAuth } = await import("../../src/security/control-auth.ts");
    await ensureControlAuth(run);
    const { socketPath } = await import("../../src/run/paths.ts");
    const sockPath = socketPath(runId, "rev-1");
    // Any well-formed request gets accepted — this fixture stands in for a
    // supervisor's control socket, not for the auth check itself.
    const server = Bun.listen({
      unix: sockPath,
      socket: {
        data(socket) {
          socket.write(`${JSON.stringify({ accepted: true, epoch: 1 })}\n`);
          socket.end();
        },
        open() {},
        close() {},
        error() {},
      },
    });

    try {
      const { sendTaskEnvelope } = await import("../../src/cli/commands/dispatch.ts");
      const { LedgerWriter } = await import("../../src/run/ledger.ts");
      const outcome = await sendTaskEnvelope({
        run,
        worker: "rev-1",
        taskId: "T-1",
        partial: { title: "t", brief: "b" },
        attemptId: "a-1",
        requestedEpoch: null,
        ledger: new LedgerWriter(run, "test"),
      });
      expect(outcome.accepted).toBe(true);
    } finally {
      server.stop(true);
    }

    const written = JSON.parse(await Bun.file(join(run.inboxDir, "T-1.json")).text()) as {
      branch: string;
    };
    expect(written.branch).toBe(`experiment/${runId}/rev-1`);
    expect(written.branch).not.toContain("fleet/");
  }, cliBudget(1));
});
