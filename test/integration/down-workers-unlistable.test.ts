/**
 * `down` when `workers/` EXISTS AND CANNOT BE READ (ISC-192 carry-in).
 *
 * ## The defect this file pins
 *
 * The worker listing used to be guarded by a bare `catch` that answered every
 * failure with `workerIds = []`. That is correct for exactly one errno and
 * catastrophic for the rest, because `readRunWorktrees` reads `run.json` and
 * is entirely independent of `workersDir` — so the record of what to DELETE
 * stays fully populated while the record of what is RUNNING goes empty.
 *
 * The three consequences compound into data loss:
 *
 *   1. Nothing is signalled. The kill ladder iterates `workerIds`.
 *   2. `report` is `[]`, and `report.every(r => r.stopped)` over an empty
 *      array is VACUOUSLY TRUE — `clean: true`, exit 0.
 *   3. Under `--prune`, `workerOutcome` is empty, so the per-worker gate sees
 *      `row === undefined` for every recorded checkout and reads that as
 *      "no supervisor was ever writing here". Every live worker's checkout is
 *      handed to `pruneWorkerWorktree`.
 *
 * §9.3 names deleting a checkout a container is still writing to as
 * corruption. This is that corruption reached through a broken measuring
 * instrument rather than a stale record — the same shape as
 * `group_read_failed`, which `down` already refuses one channel over for
 * exactly this reason: a failed `ps` and an affirmative "no such process" are
 * opposite statements about the world.
 *
 * ## Why the assertions are about the DISK and the EXIT CODE
 *
 * A test that asserts only on the refusal SENTENCE passes against a build
 * that prints the sentence and still deletes. So the load-bearing assertion
 * here is `pathExists(checkout) === true` after a `down --prune` that was
 * asked to remove it, and the second is a non-zero exit — `clean` must never
 * be true when the enumeration it summarises failed.
 *
 * ## Why this is a separate file from `down-prune.test.ts`
 *
 * `spawn-timeout-guard.test.ts` pins that file's census at 16 sites / 15
 * spawning. Adding here rather than there leaves that census untouched and
 * keeps this hazard — a listing that fails, not a prune that refuses — under
 * its own heading.
 *
 * Every repository is SYNTHETIC (`test/fixtures/synthetic-repo.ts`). Nothing
 * clones from this project's own repository.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/load.ts";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { createWorkerWorktrees, type WorkerWorktree } from "../../src/run/worktree.ts";
import { pathExists, seedGitRepo } from "../fixtures/synthetic-repo.ts";
import { cliBudget } from "../support/budget.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

const bases: string[] = [];
const livingChildren: Array<{ kill: (sig?: number | NodeJS.Signals) => void }> = [];
/** Directories chmod'ed unreadable, restored before `rm` so cleanup can descend. */
const lockedDirs: string[] = [];

afterAll(async () => {
  for (const d of lockedDirs) await chmod(d, 0o755).catch(() => {});
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
  run: ReturnType<typeof runPaths>;
  worktrees: WorkerWorktree[];
}

/**
 * A run directory with one REAL checkout recorded in `run.json` and one LIVE
 * supervisor recorded in `workers/`.
 *
 * Live on purpose: the whole hazard is that a running worker's checkout gets
 * deleted, so a fixture whose supervisors are all dead could not tell the fix
 * from the defect — with the listing broken, `down` cannot read the state
 * files either way, and only the checkout on disk distinguishes them.
 */
async function makeRig(): Promise<Rig> {
  const worker = "eng-1";
  const base = await mkdtemp(join(tmpdir(), "pifleet-unlistable-"));
  bases.push(base);
  const root = join(base, "runs");
  const repo = join(base, "repo");
  const runId = "2026-08-20T00-00-00Z-unls";
  await seedGitRepo(repo);

  const yaml = [
    "version: 2",
    "name: unlistable-test",
    'docker: {pi_version: "0.79.6", network: unlistable-net}',
    `run: {repo: ${repo}, budget: {tokens_ceiling: 1000000}}`,
    "llm: {model: unlistable-model}",
    "roles: {engineer: {}}",
    "workers:",
    `  - {id: ${worker}, role: engineer}`,
    "",
  ].join("\n");
  const loaded = await parseConfig(yaml, join(base, "fleet.yaml"));

  const run = runPaths(runId, root);
  await mkdir(run.workersDir, { recursive: true });
  const worktrees = await createWorkerWorktrees({ loaded, run, repo, workerIds: [worker] });

  // A supervisor that is genuinely alive, recorded in both places `down`
  // consults, exactly as `register_worker` persists it.
  const wp = workerPaths(run, worker);
  await mkdir(wp.dir, { recursive: true });
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  livingChildren.push(child);
  await writeWorkerState(
    wp,
    initialWorkerState({
      worker,
      runId,
      pid: child.pid,
      pgid: child.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  const started = await processStartTime(child.pid);
  if (started === null) throw new Error(`fixture pid ${child.pid} was not alive when recorded`);
  await writeFile(
    run.registryJson,
    JSON.stringify({
      schema: "pifleet.registry/v1",
      run_id: runId,
      daemon: { pid: 0, started: "" },
      workers: {
        [worker]: {
          worker,
          pid: child.pid,
          pgid: child.pid,
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
  return { base, root, runId, repo, run, worktrees };
}

/**
 * `--json` unless a caller asks for the TEXT output.
 *
 * The envelope is the right surface for an assertion about a FIELD and the
 * wrong one for an assertion about a SENTENCE — `down` suppresses its
 * human-readable refusal lines under `--json`, exactly as it does for every
 * other prune refusal. `down-prune.test.ts` states the same split.
 */
async function down(
  rig: Rig,
  args: string[] = [],
  opts: { json?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const envelope = opts.json === false ? [] : ["--json"];
  const p = Bun.spawn([process.execPath, CLI, "down", "--run", rig.runId, ...envelope, ...args], {
    // `TMPDIR` travels with the child so the CLI and this process agree on
    // where control sockets live — see `down-prune.test.ts` for the measured
    // failure that rule comes from.
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

/**
 * Make `readdir` fail with something that is NOT `ENOENT`, and prove it did.
 *
 * `chmod 000` yields `EACCES` for a non-root reader. The precondition is
 * CHECKED rather than assumed, and a failure to reproduce it throws loudly
 * instead of skipping: a guard that quietly does nothing when run as root is
 * precisely the vacuous guard this suite exists to avoid. If this ever fires
 * in CI, the fix is to run the suite unprivileged — not to soften the check.
 */
async function makeUnlistable(dir: string): Promise<void> {
  await chmod(dir, 0o000);
  lockedDirs.push(dir);
  let listed: string[] | null = null;
  try {
    listed = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`fixture error: ${dir} does not exist, so this test would exercise the ENOENT path`);
    }
    return; // Reproduced: the directory exists and cannot be read.
  }
  throw new Error(
    `cannot exercise this guard: ${dir} is still listable after chmod 000 (got ${JSON.stringify(listed)}) — ` +
      `this suite must run unprivileged, because root ignores the permission bits it depends on`,
  );
}

describe("down when workers/ exists but cannot be listed", () => {
  /**
   * BUDGET DERIVATION, shared by all three tests in this file (`budget.ts`).
   *
   * WHAT EACH TEST SPAWNS. Exactly ONE CLI entrypoint — the `down` under
   * test — which is the only thing `PER_SPAWN_IDLE_MS` is calibrated to.
   * Everything else in `makeRig` is an order of magnitude cheaper: one
   * `sleep`, one `ps` (measured directly, via a counting shim on `PATH`: 3
   * invocations across the 3 tests, i.e. exactly one per test), and the git
   * work inside `seedGitRepo` and `createWorkerWorktrees`. That git count was
   * NOT separately measured — the shim did not intercept it — so it is not
   * asserted here as a number.
   *
   * WHY `cliBudget(3)` AND NOT `cliBudget(1)`. One is the true CLI-spawn
   * count, and one would be the honest number if the rig were free. It is
   * not, and `down-prune.test.ts` folds its own rig into the count the same
   * way (`cliBudget(4)` for `makeRig()` + one `down`). Three charges the rig
   * two extra spawns at the EXPENSIVE CLI rate, which is deliberately
   * conservative: the rig's real cost is a fraction of that.
   *
   * THE ARITHMETIC. `cliBudget(3)` = 3 x 1900 x CONTENTION(3) x SAFETY(2) =
   * 34_200 ms. Measured idle across two runs: 525/473/584 ms and
   * 532/475/623 ms — worst 623 ms, so the budget carries ~55x headroom. It
   * stays BOUNDED, which is the point: a genuinely hung `down` still fails.
   */
  test("--prune keeps every checkout and exits non-zero — the listing failed, so nothing is known", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    // Prove the fixture is real before asserting it SURVIVES.
    expect(await pathExists(wt.path)).toBe(true);

    await makeUnlistable(rig.run.workersDir);

    const r = await down(rig, ["--prune"]);

    /**
     * THE LOAD-BEARING ASSERTION. A build that prints the refusal and still
     * deletes passes every message assertion below and fails this one.
     */
    expect(await pathExists(wt.path)).toBe(true);

    // `clean` is an assertion about the fleet, and it cannot be derived from
    // an enumeration that failed. Vacuously true is still true to a caller.
    const envelope = parse(r.stdout);
    expect(envelope["clean"]).toBe(false);
    expect(r.code, `stdout: ${r.stdout.slice(0, 400)}`).not.toBe(EXIT.SUCCESS);
    // A machine failure, not a fact about the run: the thing to fix is a
    // permission or a mount, not a stuck supervisor.
    expect(r.code).toBe(EXIT.BACKEND_UNAVAILABLE);

    // WHY, in the machine envelope. `workers: []` beside `clean: false` says
    // nothing about the cause, and a caller reaping runs in a loop needs to
    // tell "this run had none" from "this run could not be read".
    const why = String(envelope["workers_unlistable"] ?? "");
    expect(why).toContain(rig.run.workersDir);
    expect(why).toContain("EACCES");
    expect(envelope["workers"]).toEqual([]);
    // Absent on the healthy path, so a run that genuinely had no workers is
    // unchanged — asserted in the ENOENT case below.
  }, cliBudget(3));

  /** Budget: same census and the same 34_200 ms as above — one CLI spawn plus the rig. */
  test("the operator-facing text refuses out loud, and claims no false fact", async () => {
    const rig = await makeRig();
    await makeUnlistable(rig.run.workersDir);

    const r = await down(rig, ["--prune"], { json: false });

    // The prune phase must say it was BLOCKED, not that it found nothing to
    // do. `pruned: []` and "there was nothing to prune" are the same bytes.
    expect(r.stderr).toContain("cannot prune");
    // REFUSED is printed BEFORE the (empty) worker list, because underneath
    // it an empty list reads as "this run had no workers".
    expect(r.stdout).toContain("REFUSED:");
    expect(r.stdout).toContain(rig.run.workersDir);
    expect(r.stdout).toContain("EACCES");
    // No ladder ran, so nothing may claim one did — the same reason
    // `identity_legacy_format` is not reported as `identity_mismatch`.
    expect(r.stdout).not.toContain("survived the kill ladder");
    expect(r.stdout).not.toContain("STILL RUNNING");
  }, cliBudget(3));

  /** Budget: same census and the same 34_200 ms as above — one CLI spawn plus the rig. */
  test("ENOENT still means 'no workers' — the fix must not refuse the case the catch was FOR", async () => {
    // The documented prunable case: `run.json` recorded checkouts, and no
    // supervisor ever launched, so `workers/` was never created. Widening the
    // refusal to cover this would break the one thing the bare catch got
    // right, which is why it is asserted rather than assumed.
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    await rm(rig.run.workersDir, { recursive: true, force: true });

    const r = await down(rig, ["--prune"]);
    const envelope = parse(r.stdout);

    expect(envelope["clean"]).toBe(true);
    expect(envelope).not.toHaveProperty("workers_unlistable");
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    // Absent workers means nothing was ever writing here, so the checkout is
    // exactly as prunable as one whose supervisor exited cleanly.
    expect(await pathExists(wt.path)).toBe(false);
  }, cliBudget(3));
});
