/**
 * `pifleet report` end to end (SRD §10, §14.2): the actual CLI spawned as a
 * caller would spawn it, against a run directory built by hand and a REAL
 * repository with real worker branches.
 *
 * The CLI is spawned rather than imported because the command wiring — flag
 * parsing, run resolution, the exit-code stance — is the subject; importing
 * `collectRunReport` would leave all of it pinned by nothing.
 *
 * The exit-code stance gets its own tests: a run CONTAINING a failed task is
 * a successful report about failure (exit 0), while failing to produce a
 * report at all is the only nonzero.
 */

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, RunReportSchema } from "../../src/contracts.ts";
import { cliBudget } from "../support/budget.ts";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const RUN_ID = "2026-07-27T00-00-00Z-rint";

let tmp: string;
let repo: string;
let runsDir: string;
let runDir: string;
let baseSha: string;

async function sh(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err}`);
  return out;
}
const git = (dir: string, ...args: string[]): Promise<string> =>
  sh(["git", "-C", dir, ...args], dir);

async function runCli(
  args: string[],
  runsRoot: string = runsDir,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PIFLEET_RUNS_DIR: runsRoot },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

function envelope(taskId: string, worker: string, workdir: string): Record<string, unknown> {
  return {
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: RUN_ID,
    epoch: 1,
    attempt: 1,
    worker,
    dispatched_at: new Date().toISOString(),
    title: taskId,
    brief: "report integration fixture",
    repo,
    host_workdir: workdir,
    container_workdir: "/workspace",
    branch: `fleet/${RUN_ID}/${worker}`,
    base_ref: baseSha,
    outbox: `/outbox/${taskId}`,
    deadline_s: 1500,
  };
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-report-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  runDir = join(runsDir, RUN_ID);

  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "fixture@test");
  await git(repo, "config", "user.name", "fixture");
  await writeFile(join(repo, "f.txt"), "one\ntwo\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

  // w-good: real work, honest claim → success, and a clean merge.
  const wtGood = join(tmp, "wt-good");
  await git(repo, "worktree", "add", "-q", "-b", `fleet/${RUN_ID}/w-good`, wtGood, baseSha);
  await writeFile(join(wtGood, "g.txt"), "new file from w-good\n");
  await git(wtGood, "add", ".");
  await git(wtGood, "commit", "-qm", "w-good adds g.txt");

  // w-liar: no commits, claims success → the failed task in the run.
  const wtLiar = join(tmp, "wt-liar");
  await git(repo, "worktree", "add", "-q", "-b", `fleet/${RUN_ID}/w-liar`, wtLiar, baseSha);

  // w-gone: dispatched, then its branch AND worktree were deleted.
  const wtGone = join(tmp, "wt-gone");
  await git(repo, "worktree", "add", "-q", "-b", `fleet/${RUN_ID}/w-gone`, wtGone, baseSha);
  await sh(["git", "-C", repo, "worktree", "remove", "--force", wtGone], repo);
  await git(repo, "branch", "-D", `fleet/${RUN_ID}/w-gone`);

  await mkdir(join(runDir, "inbox"), { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID }));

  await writeFile(join(runDir, "inbox", "T-good.json"), JSON.stringify(envelope("T-good", "w-good", wtGood)));
  await mkdir(join(runDir, "outbox", "w-good", "T-good"), { recursive: true });
  await writeFile(
    join(runDir, "outbox", "w-good", "T-good", "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-good",
      epoch: 1,
      worker: "w-good",
      status: "success",
      files_changed: [{ path: "g.txt", change: "added" }],
    }),
  );

  await writeFile(join(runDir, "inbox", "T-lie.json"), JSON.stringify(envelope("T-lie", "w-liar", wtLiar)));
  await mkdir(join(runDir, "outbox", "w-liar", "T-lie"), { recursive: true });
  await writeFile(
    join(runDir, "outbox", "w-liar", "T-lie", "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-lie",
      epoch: 1,
      worker: "w-liar",
      status: "success",
    }),
  );

  await writeFile(join(runDir, "inbox", "T-gone.json"), JSON.stringify(envelope("T-gone", "w-gone", wtGone)));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("pifleet report --json", () => {
  /**
   * The whole contract in one pass: valid RunReport JSON on stdout, derived
   * verdicts, a merge row per worker branch — and exit 0 DESPITE the run
   * containing a failed task, because a report about failure is a report
   * that succeeded.
   */
  test("emits a schema-valid RunReport and exits 0 over a run with failures", async () => {
    const r = await runCli(["report", "--run", RUN_ID, "--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    const report = RunReportSchema.parse(doc); // zod strips collection_notes

    expect(report.run_id).toBe(RUN_ID);
    expect(report.schedule.find((s) => s.task_id === "T-good")?.verdict).toBe("success");
    expect(report.schedule.find((s) => s.task_id === "T-lie")?.verdict).toBe("failed");
    expect(report.totals).toEqual({ tasks: 3, done: 0, blocked: 0, failed: 1 });

    const byWorker = new Map(report.merge.map((m) => [m.worker, m]));
    expect(byWorker.get("w-good")?.clean).toBe(true);
    // The deleted branch is a row that could not be checked — present,
    // unclean, unconflicted — not a crash and not a lie.
    expect(byWorker.get("w-gone")?.clean).toBe(false);
    expect(byWorker.get("w-gone")?.conflicting_paths).toEqual([]);
    expect(byWorker.get("w-gone")?.detail).toContain("does not resolve");
  }, cliBudget(1));

  // Would fail if `report` began mutating what it inspects: the repository
  // and the surviving worktrees must be byte-identical after a full run.
  test("reporting leaves the repository and worktrees untouched", async () => {
    const dirs = [repo, join(tmp, "wt-good"), join(tmp, "wt-liar")];
    const before = await Promise.all(
      dirs.map(async (d) => ({
        status: await git(d, "status", "--porcelain"),
        head: (await git(d, "rev-parse", "HEAD")).trim(),
      })),
    );
    await runCli(["report", "--run", RUN_ID, "--json"]);
    const after = await Promise.all(
      dirs.map(async (d) => ({
        status: await git(d, "status", "--porcelain"),
        head: (await git(d, "rev-parse", "HEAD")).trim(),
      })),
    );
    expect(after).toEqual(before);
  }, cliBudget(5));

  test("defaults to the latest run when --run is omitted", async () => {
    const r = await runCli(["report", "--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect((JSON.parse(r.stdout) as { run_id: string }).run_id).toBe(RUN_ID);
  }, cliBudget(1));
});

describe("pifleet report — human output", () => {
  // Would fail if the clean pre-check wording regressed to a bare "clean":
  // the reader must see a prediction scoped to check time, not an event.
  test("prints the schedule and the NOT-merged qualified pre-check", async () => {
    const r = await runCli(["report", "--run", RUN_ID]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(r.stdout).toContain(`# pifleet run ${RUN_ID}`);
    expect(r.stdout).toContain("as of this check");
    expect(r.stdout).toContain("NOT merged");
    expect(r.stdout).toContain("verdict=failed");
  }, cliBudget(1));
});

describe("pifleet report — genuine failure to produce a report", () => {
  // The ONE nonzero: there is nothing to report on. Would fail if this
  // started exiting 0 with an empty report for a nonexistent runs root —
  // "no runs" and "empty run" are different answers.
  test("no runs at all is a usage error", async () => {
    const emptyRoot = join(tmp, "no-runs-here");
    await mkdir(emptyRoot, { recursive: true });
    const r = await runCli(["report", "--json"], emptyRoot);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("no runs found");
  }, cliBudget(1));
});
