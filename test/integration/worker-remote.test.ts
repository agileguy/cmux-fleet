/**
 * ISC-531 — a worker's clone is reachable from the repository that launched
 * the run, at the branch that run actually holds (SRD §13 task 3.4, §6.2).
 *
 * ## Why this is asserted as EQUALITY and not as reachability
 *
 * §12 phrases the probe as "`git -C <repo> ls-remote worker-<id>` resolves the
 * branch". A resolution check cannot fail in the one state that matters, and
 * that state is not hypothetical — it is the state this repository was in when
 * this file was written, measured on 2026-09-05:
 *
 *     worker-eng-1 -> ~/.pifleet/runs/2026-09-04T03-04-12Z-ce9f/worktrees/eng-1
 *     worker-eng-2 -> ~/.pifleet/runs/2026-09-04T03-04-12Z-5a52/worktrees/eng-2
 *     worker-tst-1 -> ~/.pifleet/runs/2026-09-04T03-51-39Z-2583/worktrees/tst-1
 *
 * while the live development console was launched from `~/repos/rally-cli` and
 * its runs were `2026-09-05T01-15-3*`. `registerWorkerRemote`
 * (`src/run/worktree.ts`) is not at fault: it registers against the LAUNCH
 * repository, which is correct, and nothing removes a remote when a console
 * moves to a different project. Every one of those three stale remotes still
 * resolves a branch. **So the criterion as §12 words it passes the broken
 * state**, which is the degenerate-narrowing shape this repository has shipped
 * before: both operands well-formed, only their relationship wrong.
 *
 * What follows is the same check written on equality with the run record —
 * every worktree the run reports must be reachable from that run's own repo at
 * exactly the branch the record names.
 *
 * ## Shape of the fixtures
 *
 * `pifleet worktrees --json` is the record side. Its fields are used here
 * verbatim (`repo`, `worker_id`, `branch`, `remote_name`), so a rename in that
 * payload breaks this file rather than silently un-checking the criterion.
 * The git side is real: real repositories, real clones, real `ls-remote`.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opsBudget } from "../support/budget.ts";

/** The subset of `pifleet worktrees --json` this criterion reads. */
interface WorktreeRecord {
  readonly worker_id: string;
  readonly branch: string;
  readonly remote_name: string;
}
interface RunWorktrees {
  readonly repo: string;
  readonly worktrees: readonly WorktreeRecord[];
}

/*
 * TIME BUDGETS (ISC-274). Every spawn below is `git` and nothing else — this
 * file never invokes the pifleet CLI — so the derivation is `opsBudget({git:
 * n})` rather than `cliBudget(n)`. `cliBudget` is calibrated to the ~1900 ms it
 * costs to transpile and run the CLI entrypoint, and charging a bare `git init`
 * at that rate would be, in `budget.ts`'s own words, a derivation in appearance
 * only.
 *
 * The counts are of the body, not estimates: `makeRepo` spawns 3 (`init`,
 * `add`, `commit`), `makeWorkerClone` spawns 4 (`clone`, `checkout`, `remote
 * remove`, `remote add`), and `unreachableWorkers` spawns one `ls-remote` per
 * worktree it is given.
 *
 * Every count here lands under `budget.ts`'s 5000 ms floor, which is correct
 * rather than a shortfall: measured warm, the whole file runs in 1.96 s across
 * four tests (~400 ms each at 13 spawns), so the floor is already ~12x the work
 * and the guard exists to stop a budget being INHERITED, not to make it large.
 * `git clone` is the one op here heavier than the `add`/`commit`/`rev-parse`
 * mix PER_GIT_OP_MS was measured over; it is a local one-commit repository, so
 * it hardlinks rather than packs, and the measured per-test time above is the
 * evidence that it does not change the shape.
 */

let tmp: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Hermetic, on `git-config-forms.test.ts`'s precedent: the developer's own
    // ~/.gitconfig and hooks must not decide this file's verdict.
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@test",
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
  return out;
}

/**
 * THE CHECK. For every worktree the run reports, the run's OWN repository must
 * carry that remote and `ls-remote` must resolve exactly the recorded branch.
 *
 * Returns the mismatches, so a failure names which worker and what it found
 * rather than only that something was wrong. `ls-remote <remote> <branch>`
 * prints nothing when the branch is absent and exits 0, so emptiness is the
 * signal — not a non-zero exit.
 */
async function unreachableWorkers(run: RunWorktrees): Promise<string[]> {
  const bad: string[] = [];
  for (const w of run.worktrees) {
    let listed: string;
    try {
      listed = await git(run.repo, "ls-remote", "--heads", w.remote_name, w.branch);
    } catch (err) {
      bad.push(`${w.worker_id}: remote ${w.remote_name} is not reachable from ${run.repo} (${String(err)})`);
      continue;
    }
    const refs = listed
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.split("\t")[1] ?? "");
    if (!refs.includes(`refs/heads/${w.branch}`)) {
      bad.push(
        `${w.worker_id}: ${w.remote_name} does not hold ${w.branch} — it holds [${refs.join(", ")}]`,
      );
    }
  }
  return bad;
}

/** A repository with one commit, standing in for a console's launch directory. */
async function makeRepo(name: string): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), `${name}\n`);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/**
 * A worker's clone on its run branch, registered on the launch repo the way
 * `registerWorkerRemote` does it.
 */
async function makeWorkerClone(
  launchRepo: string,
  runId: string,
  workerId: string,
): Promise<WorktreeRecord> {
  const dir = join(tmp, `clone-${runId}-${workerId}`);
  await git(tmp, "clone", "-q", launchRepo, dir);
  const branch = `fleet/${runId}/${workerId}`;
  await git(dir, "checkout", "-q", "-b", branch);
  // `worktree.ts:730-731` strips origin from a worker's clone (ISC-554); the
  // fixture does the same so it cannot accidentally resolve through one.
  await git(dir, "remote", "remove", "origin");
  const remote = `worker-${workerId}`;
  await git(launchRepo, "remote", "add", remote, dir);
  return { worker_id: workerId, branch, remote_name: remote };
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-worker-remote-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ISC-531: every worker's clone is reachable at the branch the run records", () => {
    // 1 makeRepo (3) + 2 makeWorkerClone (8) + 2 ls-remote = 13.
  test("a correctly wired run passes", async () => {
    const repo = await makeRepo("launch-ok");
    const runId = "2026-09-05T10-00-00Z-aaaa";
    const worktrees = [
      await makeWorkerClone(repo, runId, "eng-1"),
      await makeWorkerClone(repo, runId, "eng-2"),
    ];
    // Anti-vacuity: an empty roster passes any per-worker check.
    expect(worktrees.length).toBeGreaterThan(1);
    expect(await unreachableWorkers({ repo, worktrees })).toEqual([]);
  }, opsBudget({ git: 13 }));

  /**
   * THE CASE THE CRITERION EXISTS FOR, and the reason it is written on
   * equality. Both operands are individually valid: the remote resolves, the
   * branch exists, `ls-remote` returns a ref. Only the RELATIONSHIP is wrong —
   * the remote points at a previous run's clone, which is exactly what three
   * remotes in this repository were doing when this was written.
   */
    // 1 makeRepo (3) + 1 makeWorkerClone (4) + 1 direct ls-remote + 1 ls-remote = 9.
  test("a remote left pointing at a PREVIOUS run's clone is caught, though it resolves", async () => {
    const repo = await makeRepo("launch-stale");
    const oldRun = "2026-09-04T03-04-12Z-ce9f";
    const newRun = "2026-09-05T01-15-33Z-9253";

    // The old console's clone, registered as worker-eng-1 — the leftover.
    await makeWorkerClone(repo, oldRun, "eng-1");

    // The live run reports the NEW branch under the same remote name.
    const live: RunWorktrees = {
      repo,
      worktrees: [
        { worker_id: "eng-1", branch: `fleet/${newRun}/eng-1`, remote_name: "worker-eng-1" },
      ],
    };

    // A mere reachability check cannot fail here: the remote resolves fine.
    const anyRef = await git(repo, "ls-remote", "--heads", "worker-eng-1");
    expect(anyRef.trim().length).toBeGreaterThan(0);

    // Equality does fail, and names what it found.
    const bad = await unreachableWorkers(live);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("eng-1");
    expect(bad[0]).toContain(`fleet/${newRun}/eng-1`);
  }, opsBudget({ git: 9 }));

  /**
   * The other half of the same wiring failure: the console moved to a
   * different project, so the remotes were registered on THAT repository and
   * the one being asked has none. Measured shape — the live development
   * console was launched from `~/repos/rally-cli` while `~/repos/cmux-fleet`
   * still carried the remotes.
   */
    // 2 makeRepo (6) + 1 makeWorkerClone (4) + 2 ls-remote = 12.
  test("a run whose remotes were registered on a DIFFERENT repository is caught", async () => {
    const wrongRepo = await makeRepo("launch-other");
    const rightRepo = await makeRepo("launch-real");
    const runId = "2026-09-05T02-00-00Z-bbbb";
    const w = await makeWorkerClone(rightRepo, runId, "tst-1");

    // Asking the repository the console did NOT launch from.
    const bad = await unreachableWorkers({ repo: wrongRepo, worktrees: [w] });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("not reachable");

    // ...and the same record against its own repo is clean, so the failure
    // above is about the repository and not about the record.
    expect(await unreachableWorkers({ repo: rightRepo, worktrees: [w] })).toEqual([]);
  }, opsBudget({ git: 12 }));

    // 1 makeRepo (3) + 1 makeWorkerClone (4) + 1 ls-remote = 8.
  test("the check is not vacuous — a missing branch on a present remote fails", async () => {
    const repo = await makeRepo("launch-nobranch");
    const w = await makeWorkerClone(repo, "2026-09-05T03-00-00Z-cccc", "eng-3");
    const bad = await unreachableWorkers({
      repo,
      worktrees: [{ ...w, branch: "fleet/never/eng-3" }],
    });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("does not hold");
  }, opsBudget({ git: 8 }));
});
