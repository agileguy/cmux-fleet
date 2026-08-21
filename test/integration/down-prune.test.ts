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
import { groupRefusal, isAnchorRefusal, isGroupRefusal } from "../../src/cli/commands/down.ts";
import { processGroupId } from "../../src/safety/kill.ts";
import { ensureControlAuth } from "../../src/security/control-auth.ts";
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
       * A supervisor that is genuinely alive and that `down` will genuinely
       * not stop. Since ISC-272 the REASON has changed, and the change is
       * worth stating because this fixture's own comments are where the
       * hazard was first written down.
       *
       * `pid` is a real sleeping child, so `processStartTime` answers non-null
       * and the identity comparison is real. `pgid` is that same pid — which
       * is NOT this child's process group, because a non-detached `sleep`
       * lives in the TEST RUNNER's group. That used to matter only by
       * accident: `kill(-pgid, …)` raised ESRCH, the error was swallowed, and
       * the child "survived the ladder". The hazard was routed around, not
       * removed, and this comment said so.
       *
       * It is now removed. `down` reads the live group of the
       * identity-validated pid and compares it with the record, so the
       * disagreement is CAUGHT — `group_mismatch`, refused before any signal
       * is sent. Same end state, and for a reason instead of for a swallowed
       * errno: alive, `stopped: false`, therefore not prunable.
       *
       * It must NOT be `process.pid`. The first version of this fixture used
       * it, and `down` — a child sharing the test runner's process group —
       * sent SIGTERM to `-testRunnerPid` and killed ITSELF five seconds in,
       * so the prune block never ran and the failure looked like a prune bug.
       * That is exactly the `group_not_led` case the group check now refuses,
       * and `down-identity.test.ts` exercises it on an ISOLATED group so the
       * mutation fails a test rather than the process running it.
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

/**
 * `--json` unless a caller asks for the TEXT output.
 *
 * Every test here reads the machine-readable envelope, which is the right
 * surface for an assertion about a field. It is the wrong surface for an
 * assertion about a SENTENCE: `down`'s stdout verdict (`stopped` / `REFUSED` /
 * `STILL RUNNING`) exists only on the non-`--json` path, and the whole class of
 * defect the ISC-272 block below is about is a true field printed under a false
 * sentence.
 */
async function down(
  rig: Rig,
  args: string[] = [],
  opts: { json?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const envelope = opts.json === false ? [] : ["--json"];
  const p = Bun.spawn([process.execPath, CLI, "down", "--run", rig.runId, ...envelope, ...args], {
    /**
     * `TMPDIR` travels with the child, and it is load-bearing rather than
     * tidy.
     *
     * `socketPath` puts every control socket under `os.tmpdir()`. On macOS
     * that reads `$TMPDIR` — a per-user path like `/var/folders/…/T/` — and
     * falls back to `/tmp` when the variable is absent. This env was built
     * from scratch, so the CLI subprocess resolved `/tmp` while the test
     * resolved `/var/folders`, and the two computed DIFFERENT paths for the
     * same worker's socket. Nothing failed loudly: `down` treats an
     * unreachable control socket as "socket dead, process alive" and falls
     * through to the ladder, which is the same thing it does when there
     * genuinely is no supervisor listening. So a test that plants a listener
     * and asserts on what `down` did after dialing it was measuring a dial
     * that never happened. Measured: the ISC-272 fixture below saw zero
     * connections and its perl process was SIGTERMed instead.
     */
    env: {
      PATH: process.env["PATH"] ?? "",
      PIFLEET_RUNS_DIR: rig.root,
      ...(process.env["TMPDIR"] === undefined ? {} : { TMPDIR: process.env["TMPDIR"] }),
    },
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
    /**
     * The REASON changed with ISC-272 and the claim under test did not.
     *
     * This asserted "kill ladder" — `down`'s wording for a supervisor that was
     * signalled and outlived it. That was never quite what this fixture
     * produced: the recorded group was one the OS disagreed with, every signal
     * raised ESRCH, and nothing was ever delivered. `down` now catches the
     * disagreement instead of discovering it as an errno, so the honest
     * wording is the group refusal.
     *
     * What this test is FOR is untouched: a worker whose supervisor cannot be
     * confirmed dead keeps its checkout, PER WORKER, while its sibling loses
     * one. Both halves are asserted above, on the disk.
     *
     * Recorded because it is a real gap rather than a tidy substitution: with
     * the group confirmed, "survived the kill ladder" is no longer reachable
     * from a fixture at all. A confirmed group that ignores SIGTERM still
     * meets SIGKILL, and SIGKILL to a group one owns always wins, so the only
     * way left to survive the ladder is EPERM — a process this user may not
     * signal. Nothing in this suite can produce that safely, so that branch of
     * `down.ts`'s prune reason is now untested, and is named as a residual
     * rather than left looking covered.
     */
    expect(String(kept!["reason"])).toContain("process group");
    expect(String(kept!["reason"])).toContain("--force-identity");
    expect(String(kept!["reason"])).not.toContain("kill ladder");
    // The refusal never signalled it, so it is still there to be refused again.
    expect(parse(r.stdout)).toMatchObject({
      workers: [{ id: "eng-1" }, { id: "eng-2", stopped: false, how: "group_mismatch" }],
    });
  },
  // ISC-273 audit, REVISED for ISC-272. The 30_000 literal no longer stands,
  // and the reason it stood has gone away rather than been argued away.
  //
  // It was the one test in this file whose cost was NOT process startup: it
  // walked the FULL ladder — graceful 5s, SIGTERM 2s, SIGKILL 2s — against a
  // supervisor that never died, measured at 9908 ms idle on a 14-core box at
  // load 3.55, and 9s x CONTENTION (3) rounded to 30_000. Now the recorded
  // group is refused at the anchor and NO ladder runs at all, so none of that
  // fixed wait is paid; the whole thirteen-test file finishes in ~6 s.
  //
  // Keeping the literal would leave an audit note describing a cost the test
  // no longer has, which is the failure budget.ts names in its own words — a
  // number that no longer describes the test, with no way for the next reader
  // to tell which part of it was ever real. So this test is now spawn-bounded
  // like the other twelve: two spawn-reaching calls, `makeRig` and `down`.
  cliBudget(2));

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

/**
 * A supervisor whose process group stops confirming MID-LADDER (ISC-272).
 *
 * ## The defect this block exists for
 *
 * `signalIfSame` re-confirms the recorded process group before EVERY rung, not
 * once at the top, because each grace period is a window in which the world can
 * change. When that re-confirmation fails it returns `group_unconfirmed` and
 * sends NOTHING. `down`'s `signalGuarded` used to throw that answer away, so
 * `how` stayed `"sigterm"` and then `"sigkill"`, and an operator whose
 * supervisor had never been signalled at all was told:
 *
 *     eng-1: STILL RUNNING (sigkill)
 *     eng-1: KEPT — its supervisor survived the kill ladder; …
 *
 * `down.ts` calls that second sentence "a plain falsehood" — in a comment, four
 * lines above the branch that produced it.
 *
 * ## Why this needs a real process that really changes groups
 *
 * The old text on `signalGuarded` argued the branch was unreachable, on the
 * grounds that "the supervisor would have to `setpgid` itself between two
 * rungs". That is not unreachable, it is a description of a fixture — and it is
 * also the honest one, because the state under test is precisely "the group we
 * confirmed a moment ago is no longer this process's group". Faking it with a
 * stale number in `state.json` would be refused at the ANCHOR (`group_mismatch`,
 * which the block above already covers) and would never reach a rung.
 *
 * So `PGID_SWITCHER` is a real process that leads its own group, and leaves it
 * on demand.
 *
 * ## Why the trigger is a socket connection and not a sleep
 *
 * The switch has to land inside the window between the anchor's `confirmGroup`
 * and the SIGTERM rung. A timer would make that a race against process startup
 * on whatever machine is running — and `ci.yml` deliberately runs this suite
 * under CPU contention, where startup stretches. `down`'s first act against a
 * live worker is `controlCall(… {cmd: "shutdown"})`, so a listener on that
 * socket observes the anchor having already passed, causally rather than
 * probably. It fires `SIGUSR1` and hangs up, and the ladder's own fixed
 * `GRACEFUL_WAIT_MS` supplies five further seconds before the rung that matters.
 *
 * ## Blast radius, stated because this file carries the scar
 *
 * The group the switcher joins is its OWN CHILD's, created by that child with
 * `setpgrp(0,0)`. It is never the test runner's. `down-prune.test.ts` once
 * recorded `process.pid` as a fixture pgid, `down` sent SIGTERM to
 * `-testRunnerPid`, and the suite killed itself. Here, even a fully reverted
 * `down` signals only `-recordedPgid` — a group that by then contains nobody —
 * so the mutation that proves this test is safe to run.
 */
const PGID_SWITCHER = [
  // Line-buffered: the test reads ONE line and must not wait on an exit.
  "$| = 1;",
  // Leave the test runner's process group and lead one of our own. This is the
  // state `state.json` records and the anchor confirms.
  "setpgrp(0, 0);",
  "my $c = fork();",
  'die "fork failed" unless defined $c;',
  // The child leads a THIRD group — the destination. It exists only so the
  // parent has somewhere to go that is not the runner's group.
  "if ($c == 0) { setpgrp(0, 0); while (1) { sleep 5 } }",
  // The switch itself, on demand.
  "$SIG{'USR1'} = sub { setpgrp(0, $c) };",
  'print "$$ $c\n";',
  "while (1) { sleep 5 }",
].join(" ");

describe("a process group that stops confirming mid-ladder (ISC-272)", () => {
  test(
    "is reported as a refusal, not as a supervisor that survived the kill ladder",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "pifleet-prune-midladder-"));
      bases.push(base);
      const root = join(base, "runs");
      const repo = join(base, "repo");
      const runId = "2026-08-18T00-00-00Z-mdlr";
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

      const proc = Bun.spawn(["perl", "-e", PGID_SWITCHER], { stdout: "pipe", stderr: "pipe" });
      livingChildren.push(proc);
      const reader = proc.stdout.getReader();
      const first = await reader.read();
      reader.releaseLock();
      const [pid, childPid] = new TextDecoder()
        .decode(first.value)
        .trim()
        .split(/\s+/)
        .map((n) => Number.parseInt(n, 10));
      if (pid === undefined || childPid === undefined) throw new Error("switcher printed no pids");
      // The forked child is not `proc` and would outlive it; reaped explicitly.
      livingChildren.push({
        kill: () => {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // Already exited — the desired state.
          }
        },
      });
      // The fixture is what it claims to be BEFORE anything is asserted about
      // `down`. Without this, a perl that silently failed `setpgrp` would leave
      // the anchor refusing `group_mismatch` and this test passing for the
      // reason the block above already covers.
      expect(pid).toBe(proc.pid);
      expect(await processGroupId(pid)).toBe(pid);

      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.dir, { recursive: true });
      await writeWorkerState(
        wp,
        initialWorkerState({
          worker: "eng-1",
          runId,
          pid,
          pgid: pid,
          startedAt: new Date().toISOString(),
        }),
      );
      const started = await processStartTime(pid);
      if (started === null) throw new Error(`fixture pid ${pid} was not alive when recorded`);
      await writeFile(
        run.registryJson,
        JSON.stringify({
          schema: "pifleet.registry/v1",
          run_id: runId,
          daemon: { pid: 0, started: "" },
          workers: {
            "eng-1": {
              worker: "eng-1",
              pid,
              pgid: pid,
              started,
              registered_at: new Date().toISOString(),
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        run.runJson,
        JSON.stringify({ schema: "pifleet.run/v1", run_id: runId, repo, worktrees }),
        "utf8",
      );

      // `controlCall` reads the run's control secret before it dials, so
      // without this it throws at `loadControlSecret` and never connects — the
      // trigger below would never fire and the switch would never happen.
      await ensureControlAuth(run);
      await mkdir(join(tmpdir(), "pifleet"), { recursive: true });
      let connections = 0;
      const listener = Bun.listen({
        unix: wp.controlSock,
        socket: {
          open(socket) {
            connections++;
            // The anchor has already confirmed the group; move it now. Hang up
            // rather than replying, so `down` falls through to the ladder
            // immediately instead of paying `controlCall`'s 2s timeout.
            try {
              process.kill(pid, "SIGUSR1");
            } catch {
              // Reported by the group assertion below, which will not hold.
            }
            socket.end();
          },
          data() {},
          close() {},
          error() {},
        },
      });

      let r: { code: number; stdout: string; stderr: string };
      try {
        r = await down({ base, root, runId, repo, worktrees }, ["--prune"], { json: false });
      } finally {
        listener.stop(true);
      }

      // The trigger really fired, and the group really moved. Asserted after
      // the run so a `down` that never dialed the socket fails HERE, naming the
      // cause, rather than three assertions later on a confusing `how`.
      expect(connections).toBeGreaterThan(0);
      expect(await processGroupId(pid)).toBe(childPid);

      /**
       * THE SENTENCE. `REFUSED`, not `STILL RUNNING`, and `how` names the group
       * rather than a signal — because no signal was sent.
       */
      expect(r.stdout).toContain("eng-1: REFUSED (group_unconfirmed)");
      expect(r.stdout).not.toContain("STILL RUNNING");
      expect(r.stdout).not.toContain("(sigkill)");
      expect(r.stdout).not.toContain("(sigterm)");

      /**
       * AND THE PRUNE REASON, which is the operator-facing half that costs
       * data. "Survived the kill ladder" would tell an operator to reach for a
       * bigger hammer; the truth is that nothing was sent and
       * `--force-identity` is the flag that changes it.
       */
      const kept = r.stdout.split("\n").find((l) => l.includes("KEPT"));
      expect(kept).toBeDefined();
      expect(kept!).toContain("process group");
      expect(kept!).toContain("--force-identity");
      expect(kept!).not.toContain("survived the kill ladder");

      // §9.3 unchanged: unstopped supervisor, checkout kept, non-zero exit.
      expect(r.code).not.toBe(EXIT.SUCCESS);
      expect(await pathExists(worktrees[0]!.path)).toBe(true);
      // And it was never signalled, so it is still there to be refused again.
      expect(await processStartTime(pid)).toBe(started);
    },
    /**
     * NOT `cliBudget(n)`, and the reason is the one `budget.ts` gives for
     * having two helpers at all: this test's cost is not process startup.
     *
     * It is the only test in this file that reaches a RUNG, so it pays `down`'s
     * fixed `GRACEFUL_WAIT_MS` — five seconds of polling a supervisor that is
     * alive and will not be signalled — and that wait is the point rather than
     * an overhead to be optimised away. Measured idle on a 14-core machine,
     * three consecutive runs: 5.500 s, 5.684 s and 5.696 s wall for the whole
     * test — five of those seconds are the graceful wait, the remainder one CLI
     * spawn plus perl startup. Worst is 5.696, taken as 5.7.
     *
     * 5.7 s x CONTENTION (3) x SAFETY (2) = 34.2 s, rounded up to 40_000.
     * Derived from the same two constants `cliBudget` uses, applied to a measured
     * cost that is not a spawn — which is exactly what `containerBudget` does for
     * containers. It stays BOUNDED: a switcher that hangs still fails.
     */
    40_000,
  );

  /**
   * The refusal TAXONOMY, graded directly.
   *
   * Two of `groupRefusal`'s branches describe states this suite cannot summon
   * from a live process. `read_failed` needs `ps` itself to fail against a
   * running pid; the fallthrough needs a `confirmGroup` from a future build.
   * Both decide what an operator is TOLD about a supervisor whose checkout is
   * about to be kept or deleted, so leaving them unread is how the wrong
   * sentence ships — the same argument this file makes for driving the real
   * CLI everywhere else, applied where a fixture cannot reach.
   */
  test("every group refusal is classified as a refusal, and none borrows another's words", () => {
    /**
     * `read_failed` — `safety/kill.ts`'s split of "`ps` said no such process"
     * from "the `ps` read failed". The FIRST is `gone`, the anchor's single
     * success answer: it reports `stopped: true`, `docker rm -f`s the
     * container, and makes the checkout prunable. A failed read arriving there
     * would delete a live supervisor's worktree on the strength of a command
     * that did not run.
     */
    const read = groupRefusal("read_failed", 4242, 4242);
    expect(read.how).toBe("group_read_failed");
    expect(isAnchorRefusal(read.how)).toBe(true);
    // Says the group could not be READ — distinct from the group disagreeing.
    expect(read.detail).toContain("could not be READ");
    expect(read.detail).not.toContain("stale");
    expect(read.detail).not.toContain("does not lead it");

    /**
     * An unrecognised verdict. This used to be `not_led`'s branch — the
     * function simply ended on that return — so a verdict from a newer
     * `safety/kill.ts` inherited a sentence asserting a specific, checked fact
     * about who leads a process group, which nothing had established.
     */
    const unknown = groupRefusal("some_future_verdict", 4242, 99);
    expect(isAnchorRefusal(unknown.how)).toBe(true);
    expect(unknown.detail).toContain("some_future_verdict");
    expect(unknown.detail).not.toContain("does not lead it");

    // The three that were always reachable still answer as they did.
    expect(groupRefusal("unrecorded", 1, 0).how).toBe("group_unrecorded");
    expect(groupRefusal("mismatch", 1, 7).how).toBe("group_mismatch");
    expect(groupRefusal("not_led", 1, 7).how).toBe("group_not_led");

    // And the mid-ladder value the test above produces classifies with them.
    expect(isAnchorRefusal("group_unconfirmed")).toBe(true);

    /**
     * `identity_read_failed` — the ladder's own IDENTITY refusal, and the one
     * this block existed to catch in advance. It was added to `down.ts` with
     * its set membership, its operator wording and its docstring, and NOTHING
     * named it: `grep identity_read_failed test/` returned empty, so deleting
     * every branch that produces it left the suite green. That is the
     * guard-surviving-its-own-deletion shape this file's own comment warns
     * about ("a classification nothing checks is how a new refusal silently
     * acquires the wrong operator-facing words").
     *
     * It must be an ANCHOR refusal — no signal was sent — and it must NOT be a
     * GROUP refusal, because that set is what routes an operator to
     * `--force-identity`, which cannot help against a `ps` that will not run:
     * forcing re-anchors using the reading that just failed.
     */
    expect(isAnchorRefusal("identity_read_failed")).toBe(true);
    expect(isGroupRefusal("identity_read_failed")).toBe(false);
    // The three identity refusals that predate it are unmoved.
    expect(isAnchorRefusal("identity_mismatch")).toBe(true);
    expect(isAnchorRefusal("identity_legacy_format")).toBe(true);
    expect(isAnchorRefusal("identity_unrecorded")).toBe(true);
    // While the ladder's own outcomes do not — that distinction is what makes
    // "REFUSED" and "STILL RUNNING" different sentences.
    expect(isAnchorRefusal("sigterm")).toBe(false);
    expect(isAnchorRefusal("sigkill")).toBe(false);
    expect(isAnchorRefusal("graceful")).toBe(false);
  });
});

/**
 * The DAEMON rung's verdict, which is the same distinction one line later.
 *
 * `down`'s worker lines have printed `REFUSED` and `STILL RUNNING` as different
 * sentences since the anchor became fail-closed — "still running" says a ladder
 * was climbed and lost, a refusal says no signal was ever sent, and only one of
 * them has `--force-identity` as an answer. The daemon line was left behind on
 * a hardcoded `REFUSED`, and `daemonReport.stopped` is false in BOTH cases: the
 * anchor refused, or the ladder ran and the daemon outlived it. So a daemon
 * that really was SIGTERMed and really did survive was announced as one that
 * was never signalled.
 *
 * Reached with a daemon that IGNORES SIGTERM, which is the honest shape of
 * "the ladder ran and lost". The daemon rung records no process group
 * (`daemon.pid` holds `{pid, started}` and nothing else), so the signal goes to
 * the validated leader pid alone and there is no group blast radius to reason
 * about — this fixture cannot reach anything but itself.
 */
const SIGTERM_IGNORER = ["$| = 1;", "$SIG{'TERM'} = 'IGNORE';", 'print "$$\n";', "while (1) { sleep 5 }"].join(" ");

describe("the daemon rung says which of the two happened (ISC-272)", () => {
  test(
    "a daemon that outlived SIGTERM reads STILL RUNNING, not REFUSED",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "pifleet-down-daemon-"));
      bases.push(base);
      const root = join(base, "runs");
      const runId = "2026-08-18T00-00-00Z-dmn1";
      const run = runPaths(runId, root);
      await mkdir(run.workersDir, { recursive: true });
      await writeFile(
        run.runJson,
        JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }),
        "utf8",
      );

      const proc = Bun.spawn(["perl", "-e", SIGTERM_IGNORER], { stdout: "pipe", stderr: "pipe" });
      livingChildren.push(proc);
      const reader = proc.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      const started = await processStartTime(proc.pid);
      if (started === null) throw new Error(`fixture pid ${proc.pid} was not alive when recorded`);
      /**
       * BOTH halves of the identity, because the anchor is fail-closed: a
       * `daemon.pid` carrying only a pid — or an empty `started` — refuses at
       * `identity_unrecorded` and never climbs, which would produce the
       * `REFUSED` this test must be able to tell apart from the other answer.
       */
      await writeFile(run.daemonPid, JSON.stringify({ pid: proc.pid, started }), "utf8");

      const r = await down({ base, root, runId, repo: "", worktrees: [] }, [], { json: false });

      // The ladder ran and lost. `sigterm` is the `how`, and the sentence has
      // to match it.
      expect(r.stdout).toContain("daemon: STILL RUNNING (sigterm)");
      expect(r.stdout).not.toContain("daemon: REFUSED");
      // A daemon refusal is non-fatal by design — the daemon holds no checkout,
      // so no `--prune` decision rests on it. Unchanged by this fix.
      expect(r.code).toBe(EXIT.SUCCESS);
      // It really did outlive the signal, which is what makes the sentence true.
      expect(await processStartTime(proc.pid)).toBe(started);
    },
    /**
     * The daemon rung's own fixed cost, not a spawn count: `waitGone` twice at
     * `TERM_WAIT_MS` (2 s each) around one SIGTERM the target ignores.
     * Measured idle on a 14-core machine, three consecutive runs: 4.095 s,
     * 4.149 s and 4.160 s. Worst 4.160, taken as 4.2.
     *
     * 4.2 s x CONTENTION (3) x SAFETY (2) = 25.2 s, rounded up to 30_000 — the
     * same two constants `cliBudget` uses, applied to a measured cost that is
     * not process startup.
     */
    30_000,
  );
});
